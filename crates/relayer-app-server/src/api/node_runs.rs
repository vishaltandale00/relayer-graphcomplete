//! The per-node run queue (#718, PRD 12.2). Runs a user starts on different nodes run at once.
//! On one node they run in order: while a run holds its node, the next one waits as `queued`.
//! A queued run starts when the run ahead of it settles, whatever its outcome.
//!
//! This orders user intent; it is not an integrity rule, and it is not a recursion scheduler.
//! Which run holds a node is live state: only a run this process executes can hold one, so a
//! restart never leaves a node held. The queue itself is durable (`node_runs`).

use crate::product::{InteractionId, NodeRunKey, ProductError, ProductService};
use std::{collections::HashMap, sync::Arc};
use tokio::sync::Mutex;

#[derive(Clone, Default)]
pub(crate) struct NodeRunQueue {
    holders: Arc<Mutex<HashMap<NodeRunKey, Holder>>>,
}

/// The run holding a node, and how many admissions of it are still starting or running. A
/// duplicate delivery of the same run joins it, and the node passes on only when the last of
/// them releases it, so a duplicate that loses the start never frees a node its run still holds.
struct Holder {
    run: InteractionId,
    admissions: usize,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum NodeAdmission {
    /// The run holds its node; the caller starts it and releases the node when it settles.
    Start,
    /// Another run holds the node, so this one waits in the node's queue.
    Waiting,
    /// Another run holds the node, and this one could not be queued: it already ended, or it
    /// carries a Stop. It starts no native work; the caller reports or settles it.
    NotQueued,
}

impl NodeRunQueue {
    /// Admits a run to its node. Admission and queueing are one step under the queue's lock,
    /// so two runs racing to one node never both start.
    pub(crate) async fn admit(
        &self,
        product: &ProductService,
        key: NodeRunKey,
        run: InteractionId,
    ) -> Result<NodeAdmission, ProductError> {
        let mut holders = self.holders.lock().await;
        match holders.get_mut(&key) {
            None => {
                holders.insert(key, Holder { run, admissions: 1 });
                Ok(NodeAdmission::Start)
            }
            // A duplicate delivery of the run that holds the node joins it.
            Some(holder) if holder.run == run => {
                holder.admissions += 1;
                Ok(NodeAdmission::Start)
            }
            Some(_) => {
                if product.queue_node_run(run).await? {
                    Ok(NodeAdmission::Waiting)
                } else {
                    Ok(NodeAdmission::NotQueued)
                }
            }
        }
    }

    /// Ends one admission of the run holding a node. When it was the last, the node passes to
    /// the oldest queued run, which the caller then starts. A queued run that a Stop claimed
    /// first is skipped.
    pub(crate) async fn release(
        &self,
        product: &ProductService,
        key: NodeRunKey,
        run: InteractionId,
    ) -> Result<Option<InteractionId>, ProductError> {
        let mut holders = self.holders.lock().await;
        match holders.get_mut(&key) {
            Some(holder) if holder.run == run && holder.admissions > 1 => {
                holder.admissions -= 1;
                return Ok(None);
            }
            Some(holder) if holder.run == run => {}
            _ => return Ok(None),
        }
        // On a storage failure the settled run keeps the node, so a new run still queues in
        // order, and the caller retries this release until it hands the node on.
        let queued = product.queued_node_runs(key).await?;
        // A row that cannot be claimed is skipped, so one bad row never holds the node; the
        // error is returned only when no queued run could be claimed.
        let mut failure = None;
        for next in queued {
            match product.claim_queued_node_run(next).await {
                Ok(true) => {
                    holders.insert(
                        key,
                        Holder {
                            run: next,
                            admissions: 1,
                        },
                    );
                    return Ok(Some(next));
                }
                Ok(false) => {}
                Err(error) => {
                    eprintln!("queued run {next} could not be claimed to start: {error}");
                    failure = Some(error);
                }
            }
        }
        if let Some(error) = failure {
            return Err(error);
        }
        holders.remove(&key);
        Ok(None)
    }

    #[cfg(test)]
    pub(crate) async fn holder(&self, key: NodeRunKey) -> Option<InteractionId> {
        self.holders.lock().await.get(&key).map(|holder| holder.run)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::SqliteProductStore;

    async fn fixture(
        nodes: &[i64],
    ) -> (
        tempfile::TempDir,
        SqliteProductStore,
        ProductService,
        Vec<InteractionId>,
    ) {
        let directory = tempfile::tempdir().unwrap();
        let store = SqliteProductStore::open(&directory.path().join("product.sqlite3"))
            .await
            .unwrap();
        let (_, runs) = store.seed_node_runs_for_test(nodes).await;
        let product = ProductService::new(store.clone(), true);
        (directory, store, product, runs)
    }

    /// PAR-007: two sends racing to one node. However the race resolves, exactly one run
    /// holds the node and the other waits as queued; a run on another node starts at once.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn runs_racing_to_one_node_start_one_at_a_time() {
        for _ in 0..20 {
            let (_directory, store, product, runs) = fixture(&[7, 7, 8]).await;
            let queue = NodeRunQueue::default();
            let node = product.node_run_key(runs[0]).await.unwrap().unwrap();
            let other_node = product.node_run_key(runs[2]).await.unwrap().unwrap();
            // Each send admits on its own worker, so the two really race.
            let racing = |run: InteractionId| {
                let (queue, product) = (queue.clone(), product.clone());
                tokio::spawn(async move { queue.admit(&product, node, run).await })
            };
            let (first, second) = (racing(runs[0]), racing(runs[1]));
            let admissions = [
                first.await.unwrap().unwrap(),
                second.await.unwrap().unwrap(),
            ];
            assert_eq!(
                admissions
                    .iter()
                    .filter(|admission| **admission == NodeAdmission::Start)
                    .count(),
                1,
                "two runs on one node started at once"
            );
            let (started, waiting) = if admissions[0] == NodeAdmission::Start {
                (runs[0], runs[1])
            } else {
                (runs[1], runs[0])
            };
            assert_eq!(queue.holder(node).await, Some(started));
            assert_eq!(store.completion_status_for_test(waiting).await, "queued");
            assert_eq!(
                queue.admit(&product, other_node, runs[2]).await.unwrap(),
                NodeAdmission::Start
            );
            // A duplicate delivery of the holder joins it rather than queueing it. When the
            // duplicate loses the start and releases, the run it joined still holds the node.
            assert_eq!(
                queue.admit(&product, node, started).await.unwrap(),
                NodeAdmission::Start
            );
            assert_eq!(queue.release(&product, node, started).await.unwrap(), None);
            assert_eq!(queue.holder(node).await, Some(started));
            assert_eq!(store.completion_status_for_test(waiting).await, "queued");
            assert_eq!(
                queue.release(&product, node, started).await.unwrap(),
                Some(waiting)
            );
        }
    }

    /// PAR-008: a settled run hands its node to the oldest queued run, whatever its outcome.
    /// A queued run that was stopped never starts, and only the holder can release a node.
    #[tokio::test]
    async fn a_settled_run_hands_its_node_to_the_oldest_queued_run() {
        let (_directory, store, product, mut runs) = fixture(&[7, 7, 7, 7, 7]).await;
        let queue = NodeRunQueue::default();
        let node = product.node_run_key(runs[0]).await.unwrap().unwrap();
        assert_eq!(
            queue.admit(&product, node, runs[0]).await.unwrap(),
            NodeAdmission::Start
        );
        // A run that already carries a Stop is not queued behind the holder; it only settles.
        let stopping = runs.pop().unwrap();
        let thread = product.get_interaction(stopping).await.unwrap().thread_id;
        assert!(store.claim_interaction_preparing(stopping).await.unwrap());
        product
            .request_interaction_stop(thread, stopping)
            .await
            .unwrap();
        assert_eq!(
            queue.admit(&product, node, stopping).await.unwrap(),
            NodeAdmission::NotQueued
        );
        assert_eq!(
            store.completion_status_for_test(stopping).await,
            "submitted"
        );
        for run in &runs[1..] {
            assert_eq!(
                queue.admit(&product, node, *run).await.unwrap(),
                NodeAdmission::Waiting
            );
        }
        product
            .request_interaction_stop(thread, runs[2])
            .await
            .unwrap();
        assert_eq!(store.completion_status_for_test(runs[2]).await, "stopped");

        // A queued run never starts while another run holds its node.
        assert_eq!(queue.release(&product, node, runs[1]).await.unwrap(), None);
        assert_eq!(store.completion_status_for_test(runs[1]).await, "queued");

        // The holder failed; the next run starts anyway, claimed to start, in order.
        store
            .fail_interaction_completion(runs[0], "codex-basic", "Provider failed")
            .await
            .unwrap();
        assert_eq!(
            queue.release(&product, node, runs[0]).await.unwrap(),
            Some(runs[1])
        );
        assert_eq!(store.completion_status_for_test(runs[1]).await, "submitted");
        assert_eq!(queue.holder(node).await, Some(runs[1]));
        // The stopped run is skipped.
        assert_eq!(
            queue.release(&product, node, runs[1]).await.unwrap(),
            Some(runs[3])
        );
        assert_eq!(store.completion_status_for_test(runs[2]).await, "stopped");
        assert_eq!(queue.release(&product, node, runs[3]).await.unwrap(), None);
        assert_eq!(queue.holder(node).await, None);
    }
}
