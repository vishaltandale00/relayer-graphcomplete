//! The per-node run queue (#718, PRD 12.2). Runs a user starts on different nodes run at once.
//! On one node they run in the order they were created: while a run holds its node, later ones
//! wait, and the next one starts when the run ahead of it settles, whatever its outcome.
//!
//! A run joins its node's queue as soon as it is created, before its graph call is prepared,
//! so a slower preparation never lets a later run overtake it. A run waiting behind another
//! shows as `queued` once it is ready to start.
//!
//! This orders user intent; it is not an integrity rule, and it is not a recursion scheduler.
//! Which run holds a node is live state: only a run this process executes can hold one, so a
//! restart never leaves a node held. The node of each run is durable (`node_runs`).

use crate::product::{InteractionId, NodeRunKey, ProductError, ProductService};
use std::{
    collections::{BTreeMap, HashMap},
    sync::Arc,
    time::Duration,
};
use tokio::sync::Mutex;

#[derive(Clone, Default)]
pub(crate) struct NodeRunQueue {
    nodes: Arc<Mutex<HashMap<NodeRunKey, NodeState>>>,
}

#[derive(Default)]
struct NodeState {
    holder: Option<Holder>,
    /// The runs behind the holder, in creation order (sequence, then id). A run is ready once
    /// its graph call is prepared and it waits durably as `queued`.
    waiting: BTreeMap<(i64, i64), Waiter>,
}

/// The run holding a node, and how many request paths of it are still starting or running. A
/// duplicate delivery of the same run joins it, and the node passes on only when the last of
/// them releases it, so a duplicate that loses the start never frees a node its run still holds.
struct Holder {
    run: InteractionId,
    admissions: usize,
    /// One admission belongs to the request that arrived waiting and was promoted while it
    /// prepared. Otherwise the holder's first admission belongs to whoever took the node: the
    /// request that arrived to a free node, or the queue's dispatch of a ready run.
    promoted: bool,
}

struct Waiter {
    run: InteractionId,
    ready: bool,
}

/// What joining its node's queue did for a run's request, so the request can undo exactly that
/// if it ends before its run is admitted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Arrival {
    /// The run holds the node; this request owns one of its admissions.
    Held,
    /// The run waits behind the holder. It may be promoted to holder while it prepares.
    Waiting,
    /// Another request of the same run already holds or waits for it.
    Joined,
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

impl NodeState {
    fn position(run: InteractionId, sequence: i64) -> (i64, i64) {
        (sequence, run.value())
    }

    fn waits(&self, run: InteractionId) -> bool {
        self.waiting.values().any(|waiter| waiter.run == run)
    }

    fn remove_waiter(&mut self, run: InteractionId) {
        self.waiting.retain(|_, waiter| waiter.run != run);
    }
}

impl NodeRunQueue {
    /// Joins a newly created run to its node's queue, before its graph call is prepared. It
    /// takes the node only when nothing holds it.
    pub(crate) async fn arrive(
        &self,
        key: NodeRunKey,
        run: InteractionId,
        sequence: i64,
    ) -> Arrival {
        let mut nodes = self.nodes.lock().await;
        let node = nodes.entry(key).or_default();
        let waits = node.waits(run);
        match &mut node.holder {
            Some(holder) if holder.run == run => {
                holder.admissions += 1;
                Arrival::Held
            }
            Some(_) if waits => Arrival::Joined,
            Some(_) => {
                node.waiting.insert(
                    NodeState::position(run, sequence),
                    Waiter { run, ready: false },
                );
                Arrival::Waiting
            }
            None => {
                node.holder = Some(Holder {
                    run,
                    admissions: 1,
                    promoted: false,
                });
                Arrival::Held
            }
        }
    }

    /// Admits a run that is ready to start. A run that already holds its node starts. Otherwise
    /// it waits in creation order, durably as `queued`. Admission and queueing are one step
    /// under the queue's lock, so two runs racing to one node never both start. `arrival` is
    /// what this request's `arrive` did, if it arrived first.
    pub(crate) async fn admit(
        &self,
        product: &ProductService,
        key: NodeRunKey,
        run: InteractionId,
        sequence: i64,
        arrival: Option<Arrival>,
    ) -> Result<NodeAdmission, ProductError> {
        let mut nodes = self.nodes.lock().await;
        let node = nodes.entry(key).or_default();
        match &mut node.holder {
            Some(holder) if holder.run == run => {
                // A request that took the node, or was promoted to it, already owns an
                // admission; any other one joins with its own.
                match arrival {
                    Some(Arrival::Held) => {}
                    Some(Arrival::Waiting) if holder.promoted => holder.promoted = false,
                    _ => holder.admissions += 1,
                }
                return Ok(NodeAdmission::Start);
            }
            None => {
                node.remove_waiter(run);
                node.holder = Some(Holder {
                    run,
                    admissions: 1,
                    promoted: false,
                });
                return Ok(NodeAdmission::Start);
            }
            Some(_) => {}
        }
        let inserted = !node.waits(run);
        if inserted {
            node.waiting.insert(
                NodeState::position(run, sequence),
                Waiter { run, ready: false },
            );
        }
        // A duplicate request of this run may have queued it already.
        let queued = async {
            Ok::<_, ProductError>(
                product.queue_node_run(run).await?
                    || product.get_interaction(run).await?.completion_status == "queued",
            )
        }
        .await;
        let queued = match queued {
            Ok(queued) => queued,
            Err(error) => {
                // A waiter this admission added is taken out again, so no release ever
                // promotes a run whose request has already given up.
                if inserted {
                    node.remove_waiter(run);
                }
                return Err(error);
            }
        };
        if queued {
            for waiter in node.waiting.values_mut() {
                if waiter.run == run {
                    waiter.ready = true;
                }
            }
            Ok(NodeAdmission::Waiting)
        } else {
            // It ended or carries a Stop. A ready waiter is never dropped: its row waits.
            node.waiting
                .retain(|_, waiter| waiter.run != run || waiter.ready);
            Ok(NodeAdmission::NotQueued)
        }
    }

    /// Undoes the arrival of a run whose request ended before its run was admitted, for
    /// example because its graph preparation failed. Returns a queued run to start if the node
    /// passed on.
    pub(crate) async fn depart(
        &self,
        product: &ProductService,
        key: NodeRunKey,
        run: InteractionId,
        arrival: Arrival,
    ) -> Result<Option<InteractionId>, ProductError> {
        let mut used_promotion = false;
        {
            let mut nodes = self.nodes.lock().await;
            let Some(node) = nodes.get_mut(&key) else {
                return Ok(None);
            };
            let holder = node.holder.as_mut().filter(|holder| holder.run == run);
            match (arrival, holder) {
                (Arrival::Joined, _) => return Ok(None),
                (Arrival::Waiting, None) => {
                    node.waiting
                        .retain(|_, waiter| waiter.run != run || waiter.ready);
                    return Ok(None);
                }
                // A waiter promoted while it prepared holds the node for this request.
                (Arrival::Waiting, Some(holder)) if holder.promoted => {
                    holder.promoted = false;
                    used_promotion = true;
                }
                // The queue's dispatch owns this hold, not this request.
                (Arrival::Waiting, Some(_)) => return Ok(None),
                (Arrival::Held, _) => {}
            }
        }
        let released = self.release(product, key, run).await;
        if released.is_err() && used_promotion {
            // The run still holds its node for this request, so a retried departure releases
            // it again.
            let mut nodes = self.nodes.lock().await;
            if let Some(holder) = nodes
                .get_mut(&key)
                .and_then(|node| node.holder.as_mut())
                .filter(|holder| holder.run == run)
            {
                holder.promoted = true;
            }
        }
        released
    }

    /// Ends one admission of the run holding a node. When it was the last, the node passes to
    /// the oldest run behind it. A ready run is claimed and returned for the caller to start; a
    /// run still preparing becomes the holder and starts when its request admits it. A queued
    /// run that a Stop claimed first is skipped.
    pub(crate) async fn release(
        &self,
        product: &ProductService,
        key: NodeRunKey,
        run: InteractionId,
    ) -> Result<Option<InteractionId>, ProductError> {
        let mut nodes = self.nodes.lock().await;
        let Some(node) = nodes.get_mut(&key) else {
            return Ok(None);
        };
        match &mut node.holder {
            Some(holder) if holder.run == run && holder.admissions > 1 => {
                holder.admissions -= 1;
                return Ok(None);
            }
            Some(holder) if holder.run == run => {}
            _ => return Ok(None),
        }
        // On a storage failure the settled run keeps the node, so later runs still wait in
        // order, and the caller retries this release until it hands the node on.
        let positions: Vec<(i64, i64)> = node.waiting.keys().copied().collect();
        for position in positions {
            let waiter = &node.waiting[&position];
            let next = waiter.run;
            if !waiter.ready {
                node.waiting.remove(&position);
                node.holder = Some(Holder {
                    run: next,
                    admissions: 1,
                    promoted: true,
                });
                return Ok(None);
            }
            match product.claim_queued_node_run(next).await {
                Ok(true) => {
                    node.waiting.remove(&position);
                    node.holder = Some(Holder {
                        run: next,
                        admissions: 1,
                        promoted: false,
                    });
                    return Ok(Some(next));
                }
                Ok(false) => {
                    node.waiting.remove(&position);
                }
                // The settled run keeps the node and the caller retries, so no later run
                // overtakes this one.
                Err(error) => return Err(error),
            }
        }
        nodes.remove(&key);
        Ok(None)
    }

    /// Releases the node of a run whose execution ended, once its settlement is durable. Until
    /// its row leaves the active statuses, for example while its outcome is still being
    /// persisted, the node stays held, so the next run never starts beside it or reads the
    /// thread before its result.
    pub(crate) async fn release_settled(
        &self,
        product: &ProductService,
        key: NodeRunKey,
        run: InteractionId,
        mut poll: Duration,
    ) -> Result<Option<InteractionId>, ProductError> {
        loop {
            match product.get_interaction(run).await {
                Ok(current)
                    if !matches!(
                        current.completion_status.as_str(),
                        "submitted" | "running" | "waiting_for_approval" | "queued"
                    ) =>
                {
                    return self.release(product, key, run).await;
                }
                Ok(current) => eprintln!(
                    "run {run} ended its execution while still {}; its node stays held",
                    current.completion_status
                ),
                Err(error) => eprintln!("could not read whether run {run} settled: {error}"),
            }
            tokio::time::sleep(poll).await;
            poll = (poll * 2).min(Duration::from_secs(30));
        }
    }

    #[cfg(test)]
    pub(crate) async fn holder(&self, key: NodeRunKey) -> Option<InteractionId> {
        self.nodes
            .lock()
            .await
            .get(&key)
            .and_then(|node| node.holder.as_ref())
            .map(|holder| holder.run)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::SqliteProductStore;

    /// The seeded runs are created in id order, so a run's id stands for its creation order.
    fn sequence(run: InteractionId) -> i64 {
        run.value()
    }

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
                tokio::spawn(
                    async move { queue.admit(&product, node, run, run.value(), None).await },
                )
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
                queue
                    .admit(&product, other_node, runs[2], sequence(runs[2]), None)
                    .await
                    .unwrap(),
                NodeAdmission::Start
            );
            // A duplicate delivery of the holder joins it rather than queueing it. When the
            // duplicate loses the start and releases, the run it joined still holds the node.
            assert_eq!(
                queue
                    .admit(&product, node, started, sequence(started), None)
                    .await
                    .unwrap(),
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
            queue
                .admit(&product, node, runs[0], sequence(runs[0]), None)
                .await
                .unwrap(),
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
            queue
                .admit(&product, node, stopping, sequence(stopping), None)
                .await
                .unwrap(),
            NodeAdmission::NotQueued
        );
        assert_eq!(
            store.completion_status_for_test(stopping).await,
            "submitted"
        );
        for run in &runs[1..] {
            assert_eq!(
                queue
                    .admit(&product, node, *run, sequence(*run), None)
                    .await
                    .unwrap(),
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

    /// PAR-007 (#718 review): runs start in the order they were created. A run created first
    /// takes its place when it is created, so a later run whose preparation is faster waits
    /// behind it instead of overtaking it. If the first run's request then fails, the later
    /// run starts.
    #[tokio::test]
    async fn a_run_created_first_starts_first_even_when_it_prepares_slower() {
        let (_directory, store, product, runs) = fixture(&[7, 7, 7, 7]).await;
        let queue = NodeRunQueue::default();
        let node = product.node_run_key(runs[0]).await.unwrap().unwrap();
        let (first, second) = (runs[0], runs[1]);
        assert_eq!(
            queue.arrive(node, first, sequence(first)).await,
            Arrival::Held
        );
        assert_eq!(
            queue.arrive(node, second, sequence(second)).await,
            Arrival::Waiting
        );
        // The second run's faster preparation reaches admission first: it waits.
        assert_eq!(
            queue
                .admit(
                    &product,
                    node,
                    second,
                    sequence(second),
                    Some(Arrival::Waiting)
                )
                .await
                .unwrap(),
            NodeAdmission::Waiting
        );
        assert_eq!(store.completion_status_for_test(second).await, "queued");
        assert_eq!(
            queue
                .admit(&product, node, first, sequence(first), Some(Arrival::Held))
                .await
                .unwrap(),
            NodeAdmission::Start
        );
        assert_eq!(queue.holder(node).await, Some(first));
        assert_eq!(
            queue.release(&product, node, first).await.unwrap(),
            Some(second)
        );

        // A run still preparing when the run ahead settles takes the node and starts when it
        // is admitted; a later ready run keeps waiting behind it.
        let (third, fourth) = (runs[2], runs[3]);
        assert_eq!(
            queue.arrive(node, third, sequence(third)).await,
            Arrival::Waiting
        );
        assert_eq!(
            queue.arrive(node, fourth, sequence(fourth)).await,
            Arrival::Waiting
        );
        assert_eq!(
            queue
                .admit(
                    &product,
                    node,
                    fourth,
                    sequence(fourth),
                    Some(Arrival::Waiting)
                )
                .await
                .unwrap(),
            NodeAdmission::Waiting
        );
        assert_eq!(queue.release(&product, node, second).await.unwrap(), None);
        assert_eq!(queue.holder(node).await, Some(third));
        assert_eq!(store.completion_status_for_test(fourth).await, "queued");
        // The third run's request fails before admission; the node passes to the fourth.
        assert_eq!(
            queue
                .depart(&product, node, third, Arrival::Waiting)
                .await
                .unwrap(),
            Some(fourth)
        );
        assert_eq!(store.completion_status_for_test(fourth).await, "submitted");
    }

    /// The node of a run whose execution ended passes on only once the run's settlement is
    /// durable (#718 review). While its row still reads running, the queued run behind it does
    /// not start.
    #[tokio::test]
    async fn a_node_passes_on_only_after_the_run_ahead_durably_settles() {
        let (_directory, store, product, runs) = fixture(&[7, 7]).await;
        let queue = NodeRunQueue::default();
        let node = product.node_run_key(runs[0]).await.unwrap().unwrap();
        assert_eq!(
            queue
                .admit(&product, node, runs[0], sequence(runs[0]), None)
                .await
                .unwrap(),
            NodeAdmission::Start
        );
        assert_eq!(
            queue
                .admit(&product, node, runs[1], sequence(runs[1]), None)
                .await
                .unwrap(),
            NodeAdmission::Waiting
        );
        store
            .set_completion_status_for_test(runs[0], "running")
            .await;
        let ahead = runs[0];
        let releasing = {
            let (queue, product) = (queue.clone(), product.clone());
            tokio::spawn(async move {
                queue
                    .release_settled(&product, node, ahead, Duration::from_millis(10))
                    .await
            })
        };
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(
            !releasing.is_finished(),
            "the node passed on while its run still ran"
        );
        assert_eq!(queue.holder(node).await, Some(runs[0]));
        assert_eq!(store.completion_status_for_test(runs[1]).await, "queued");
        store
            .set_completion_status_for_test(runs[0], "failed")
            .await;
        assert_eq!(releasing.await.unwrap().unwrap(), Some(runs[1]));
    }

    /// Two requests for one waiting run (#718 review): the duplicate queues it first, then the
    /// run ahead settles and the queue starts it. The original request's late admission joins
    /// that start with its own admission, so the node passes on only when both have released:
    /// the run never shares its node. A waiter that is already queued is never dropped.
    #[tokio::test]
    async fn a_duplicate_request_never_frees_or_drops_a_waiting_run() {
        let (_directory, store, product, runs) = fixture(&[7, 7, 7]).await;
        let queue = NodeRunQueue::default();
        let node = product.node_run_key(runs[0]).await.unwrap().unwrap();
        let (ahead, run, later) = (runs[0], runs[1], runs[2]);
        assert_eq!(
            queue.arrive(node, ahead, sequence(ahead)).await,
            Arrival::Held
        );
        assert_eq!(
            queue.arrive(node, run, sequence(run)).await,
            Arrival::Waiting
        );
        assert_eq!(
            queue.arrive(node, run, sequence(run)).await,
            Arrival::Joined
        );
        // The duplicate admits first and queues the run.
        assert_eq!(
            queue
                .admit(&product, node, run, sequence(run), Some(Arrival::Joined))
                .await
                .unwrap(),
            NodeAdmission::Waiting
        );
        // The original sees it already queued: it stays in line.
        assert_eq!(
            queue
                .admit(&product, node, run, sequence(run), Some(Arrival::Waiting))
                .await
                .unwrap(),
            NodeAdmission::Waiting
        );
        assert_eq!(
            queue.release(&product, node, ahead).await.unwrap(),
            Some(run)
        );
        assert_eq!(
            queue.arrive(node, later, sequence(later)).await,
            Arrival::Waiting
        );
        // A late admission of the original joins the dispatched start with its own admission.
        assert_eq!(
            queue
                .admit(&product, node, run, sequence(run), Some(Arrival::Waiting))
                .await
                .unwrap(),
            NodeAdmission::Start
        );
        assert_eq!(queue.release(&product, node, run).await.unwrap(), None);
        assert_eq!(queue.holder(node).await, Some(run));
        // A departing original owns nothing of the dispatched hold.
        assert_eq!(
            queue
                .depart(&product, node, run, Arrival::Waiting)
                .await
                .unwrap(),
            None
        );
        assert_eq!(queue.holder(node).await, Some(run));
        assert_eq!(store.completion_status_for_test(run).await, "submitted");
        // Only the dispatched start's own release hands the node on.
        assert_eq!(queue.release(&product, node, run).await.unwrap(), None);
        assert_eq!(queue.holder(node).await, Some(later));
    }

    /// A storage failure while a node passes on (#718 review) leaves it with its run, and the
    /// failed step is undone: a retried departure of a promoted run releases it again, and a
    /// run whose admission failed never stays in line to be promoted later.
    #[tokio::test]
    async fn a_failed_hand_off_or_admission_never_strands_a_node() {
        let (_directory, store, product, runs) = fixture(&[7, 7, 7, 7]).await;
        let queue = NodeRunQueue::default();
        let node = product.node_run_key(runs[0]).await.unwrap().unwrap();
        let (ahead, promoted, ready, stray) = (runs[0], runs[1], runs[2], runs[3]);
        assert_eq!(
            queue.arrive(node, ahead, sequence(ahead)).await,
            Arrival::Held
        );
        assert_eq!(
            queue.arrive(node, promoted, sequence(promoted)).await,
            Arrival::Waiting
        );
        assert_eq!(
            queue.arrive(node, ready, sequence(ready)).await,
            Arrival::Waiting
        );
        assert_eq!(
            queue
                .admit(
                    &product,
                    node,
                    ready,
                    sequence(ready),
                    Some(Arrival::Waiting)
                )
                .await
                .unwrap(),
            NodeAdmission::Waiting
        );
        // The admission of a run that arrived on no queue place fails: it does not stay in line.
        store
            .fault_status_change_for_test(stray, "queued", true)
            .await;
        assert!(
            queue
                .admit(&product, node, stray, sequence(stray), None)
                .await
                .is_err()
        );
        store
            .fault_status_change_for_test(stray, "queued", false)
            .await;
        // The run ahead settles; the still-preparing run is promoted to hold the node.
        assert_eq!(queue.release(&product, node, ahead).await.unwrap(), None);
        assert_eq!(queue.holder(node).await, Some(promoted));
        // Its request fails, and handing the node on fails once: the departure is retried.
        store
            .fault_status_change_for_test(ready, "submitted", true)
            .await;
        assert!(
            queue
                .depart(&product, node, promoted, Arrival::Waiting)
                .await
                .is_err()
        );
        assert_eq!(queue.holder(node).await, Some(promoted));
        store
            .fault_status_change_for_test(ready, "submitted", false)
            .await;
        assert_eq!(
            queue
                .depart(&product, node, promoted, Arrival::Waiting)
                .await
                .unwrap(),
            Some(ready)
        );
        // The stray run was never promoted: once the ready run ends, the node is free.
        assert_eq!(queue.release(&product, node, ready).await.unwrap(), None);
        assert_eq!(queue.holder(node).await, None);
    }
}
