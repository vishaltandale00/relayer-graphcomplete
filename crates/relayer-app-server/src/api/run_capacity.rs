//! The app's internal limit on human-started runs (#720, PRD 12.2). At most `limit` runs that a
//! person started execute at once, across every thread. Above it a run waits as `queued` with
//! the reason `capacity`, and waiting runs start first in, first out as slots free.
//!
//! Only human-started runs ask for a slot: message turns, retries, and a user's invokes. A
//! child an agent invokes never does, because recursion is provider-owned; this is a safety
//! limit, not a recursion scheduler. A run on a node asks for a slot once its node is free, so
//! it holds its node while it waits, and the node queue's order is kept (#718).
//!
//! Which runs hold slots, and the order of the wait, are live state: only a run this process
//! executes can hold a slot, so a restart never leaves one taken. The reason a run waits is
//! durable (`run_capacity_waits`).

use crate::product::{InteractionId, ProductError, ProductService};
use std::{
    collections::{HashMap, VecDeque},
    sync::Arc,
};
use tokio::sync::{Mutex, oneshot};

/// How many human-started runs execute at once. It is internal, not a user setting.
pub(crate) const HUMAN_RUN_CAPACITY: usize = 16;

#[derive(Clone)]
pub(crate) struct RunCapacity {
    limit: usize,
    slots: Arc<Mutex<Slots>>,
}

#[derive(Default)]
struct Slots {
    /// Runs holding a slot, with how many admissions of each are still starting or running. A
    /// duplicate delivery of a run joins its slot, and the slot frees only when the last of
    /// them releases it.
    executing: HashMap<InteractionId, usize>,
    /// Runs waiting for a slot, oldest first. Each is told when it holds one.
    waiting: VecDeque<(InteractionId, oneshot::Sender<()>)>,
}

#[derive(Debug)]
pub(crate) enum CapacityAdmission {
    /// The run holds a slot. The caller starts it and releases the slot once it settles.
    Start,
    /// Every slot is taken, so the run waits as `queued`. When the receiver resolves, the run
    /// holds a slot and is `submitted` again; when it is dropped, the run left the wait.
    Waiting(oneshot::Receiver<()>),
    /// A duplicate delivery of a run that already waits. The first delivery starts it.
    AlreadyWaiting,
    /// The run could not wait: it carries a Stop, or it is no longer a claimed start. It holds
    /// no slot and starts no provider work, so the caller settles or reports it uncounted.
    Uncounted,
}

impl Default for RunCapacity {
    fn default() -> Self {
        Self::new(HUMAN_RUN_CAPACITY)
    }
}

impl RunCapacity {
    pub(crate) fn new(limit: usize) -> Self {
        assert!(limit > 0, "the run capacity needs at least one slot");
        Self {
            limit,
            slots: Arc::default(),
        }
    }

    /// Admits a human-started run whose start was claimed. Checking for a free slot and
    /// taking it, or queueing the run, are one step under the lock, so racing admissions never
    /// exceed the limit. A new run never takes a slot ahead of a run that already waits.
    pub(crate) async fn admit(
        &self,
        product: &ProductService,
        run: InteractionId,
    ) -> Result<CapacityAdmission, ProductError> {
        let mut slots = self.slots.lock().await;
        if let Some(admissions) = slots.executing.get_mut(&run) {
            *admissions += 1;
            return Ok(CapacityAdmission::Start);
        }
        if slots.waiting.iter().any(|(waiting, _)| *waiting == run) {
            return Ok(CapacityAdmission::AlreadyWaiting);
        }
        if slots.executing.len() < self.limit && slots.waiting.is_empty() {
            slots.executing.insert(run, 1);
            return Ok(CapacityAdmission::Start);
        }
        if !product.queue_run_for_capacity(run).await? {
            return Ok(CapacityAdmission::Uncounted);
        }
        let (granted, grant) = oneshot::channel();
        slots.waiting.push_back((run, granted));
        Ok(CapacityAdmission::Waiting(grant))
    }

    /// Ends one admission of a run holding a slot. When it was the last, the slot passes to
    /// the oldest waiting run that can still start, and that run's waiter starts it. A run a
    /// Stop removed is skipped.
    pub(crate) async fn release(
        &self,
        product: &ProductService,
        run: InteractionId,
    ) -> Result<Option<InteractionId>, ProductError> {
        let mut slots = self.slots.lock().await;
        match slots.executing.get_mut(&run) {
            Some(admissions) if *admissions > 1 => {
                *admissions -= 1;
                return Ok(None);
            }
            Some(_) => {}
            None => return Ok(None),
        }
        // The oldest waiting run always gets the slot first. On a storage failure it keeps its
        // place and the settled run keeps the slot, so order and the limit both hold, and the
        // caller retries. A failure that never cleared would stall every later start; the
        // claim is one conditional update, so only a global storage outage fails it.
        while let Some((next, granted)) = slots.waiting.front() {
            let next = *next;
            // Nothing waits to start this run any more (its task ended with the process), so it
            // is not claimed; startup recovers it.
            if granted.is_closed() {
                eprintln!("run {next} left the wait for capacity before it could start");
                slots.waiting.pop_front();
                continue;
            }
            if product.claim_capacity_run(next).await? {
                let (_, granted) = slots.waiting.pop_front().expect("a waiting run");
                if granted.send(()).is_err() {
                    // Its task ended while it was claimed, so nothing will run or release it.
                    // The slot moves on; startup recovers the run.
                    eprintln!("run {next} left the wait for capacity as it was given a slot");
                    continue;
                }
                slots.executing.remove(&run);
                slots.executing.insert(next, 1);
                return Ok(Some(next));
            }
            // Stopped, or it already left the wait: dropping its waiter ends the wait.
            slots.waiting.pop_front();
        }
        slots.executing.remove(&run);
        Ok(None)
    }

    /// A Stop removed a waiting run from the wait. Its waiter learns at once, so a run on a
    /// node frees its node without waiting for a slot it no longer needs.
    pub(crate) async fn forget(&self, run: InteractionId) {
        self.slots
            .lock()
            .await
            .waiting
            .retain(|(waiting, _)| *waiting != run);
    }

    #[cfg(test)]
    pub(crate) async fn executing_for_test(&self) -> Vec<InteractionId> {
        let mut runs: Vec<_> = self.slots.lock().await.executing.keys().copied().collect();
        runs.sort_by_key(|run| run.value());
        runs
    }

    #[cfg(test)]
    async fn waiting(&self) -> Vec<InteractionId> {
        self.slots
            .lock()
            .await
            .waiting
            .iter()
            .map(|(run, _)| *run)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::SqliteProductStore;

    async fn fixture(
        runs: usize,
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
        let nodes: Vec<i64> = (1..=runs as i64).collect();
        let (_, runs) = store.seed_node_runs_for_test(&nodes).await;
        // Each start is claimed before it asks for a slot.
        for run in &runs {
            assert!(store.claim_interaction_preparing(*run).await.unwrap());
        }
        let product = ProductService::new(store.clone(), true);
        (directory, store, product, runs)
    }

    /// PAR-011: runs racing for the last slots. However the race resolves, no more runs hold
    /// slots than the limit, every other run waits as queued for capacity, and the waiting
    /// runs start first in, first out as slots free.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn racing_runs_never_exceed_the_limit_and_start_in_order() {
        for _ in 0..10 {
            let (_directory, store, product, runs) = fixture(6).await;
            let capacity = RunCapacity::new(2);
            // Each run admits on its own worker, so they really race.
            let admissions: Vec<_> = runs
                .iter()
                .map(|run| {
                    let (capacity, product, run) = (capacity.clone(), product.clone(), *run);
                    tokio::spawn(async move { (run, capacity.admit(&product, run).await) })
                })
                .collect();
            let mut started = Vec::new();
            let mut grants = HashMap::new();
            for admission in admissions {
                let (run, admission) = admission.await.unwrap();
                match admission.unwrap() {
                    CapacityAdmission::Start => started.push(run),
                    CapacityAdmission::Waiting(grant) => {
                        grants.insert(run, grant);
                    }
                    other => panic!("run {run} was admitted as {other:?}"),
                }
            }
            assert_eq!(started.len(), 2, "more runs started than the limit allows");
            let waiting = capacity.waiting().await;
            assert_eq!(waiting.len(), 4);
            for run in &waiting {
                let interaction = store.get_interaction(*run).await.unwrap().unwrap();
                assert_eq!(interaction.completion_status, "queued");
                assert!(interaction.waiting_for_capacity);
            }

            // A duplicate delivery of a running run joins its slot; of a waiting run, its wait.
            assert!(matches!(
                capacity.admit(&product, started[0]).await.unwrap(),
                CapacityAdmission::Start
            ));
            assert_eq!(capacity.release(&product, started[0]).await.unwrap(), None);
            assert!(matches!(
                capacity.admit(&product, waiting[0]).await.unwrap(),
                CapacityAdmission::AlreadyWaiting
            ));

            // A Stop removes the second waiting run; it never starts, and its waiter learns.
            let thread = product.get_interaction(waiting[1]).await.unwrap().thread_id;
            product
                .request_interaction_stop(thread, waiting[1])
                .await
                .unwrap();
            capacity.forget(waiting[1]).await;
            assert!(grants.remove(&waiting[1]).unwrap().await.is_err());

            // Slots pass in the order the runs began to wait, skipping the removed run.
            let mut holding = started.clone();
            for expected in [waiting[0], waiting[2], waiting[3]] {
                let settled = holding.remove(0);
                assert_eq!(
                    capacity.release(&product, settled).await.unwrap(),
                    Some(expected)
                );
                grants.remove(&expected).unwrap().await.unwrap();
                assert_eq!(
                    store.completion_status_for_test(expected).await,
                    "submitted"
                );
                holding.push(expected);
                assert!(capacity.executing_for_test().await.len() <= 2);
            }
            for settled in holding {
                assert_eq!(capacity.release(&product, settled).await.unwrap(), None);
            }
            assert!(capacity.executing_for_test().await.is_empty());
            assert_eq!(
                store.completion_status_for_test(waiting[1]).await,
                "stopped"
            );
            // With slots free again, a new run starts at once.
            let (_, more) = store.seed_node_runs_for_test(&[1]).await;
            assert!(store.claim_interaction_preparing(more[0]).await.unwrap());
            assert!(matches!(
                capacity.admit(&product, more[0]).await.unwrap(),
                CapacityAdmission::Start
            ));
        }
    }

    /// A run that carries a Stop never waits for capacity; it settles without a slot.
    #[tokio::test]
    async fn a_run_with_a_stop_settles_without_a_slot() {
        let (_directory, _store, product, runs) = fixture(2).await;
        let capacity = RunCapacity::new(1);
        assert!(matches!(
            capacity.admit(&product, runs[0]).await.unwrap(),
            CapacityAdmission::Start
        ));
        let thread = product.get_interaction(runs[1]).await.unwrap().thread_id;
        product
            .request_interaction_stop(thread, runs[1])
            .await
            .unwrap();
        assert!(matches!(
            capacity.admit(&product, runs[1]).await.unwrap(),
            CapacityAdmission::Uncounted
        ));
        assert_eq!(capacity.executing_for_test().await, [runs[0]]);
    }
}
