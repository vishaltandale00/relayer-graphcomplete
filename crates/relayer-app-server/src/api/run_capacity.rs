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
            // A run that carries a valid Stop settles without provider work, so it takes no
            // slot, as it could not wait for one either.
            // A Stop that failed earlier is not honoured, so its run executes and counts.
            let current = product.get_interaction(run).await?;
            if current.stop_requested && current.stop_error.is_none() {
                return Ok(CapacityAdmission::Uncounted);
            }
            // A wait an earlier, ambiguous admission already made durable is claimed back, so
            // the run starts from its claimed state.
            if current.completion_status == "queued"
                && current.waiting_for_capacity
                && !product.claim_capacity_run(run).await?
            {
                return Ok(CapacityAdmission::Uncounted);
            }
            slots.executing.insert(run, 1);
            return Ok(CapacityAdmission::Start);
        }
        if !product.queue_run_for_capacity(run).await? {
            // An earlier admission whose commit was reported failed may have made the wait
            // durable after all. That wait is adopted, so the run keeps its place.
            let current = product.get_interaction(run).await?;
            if !(current.completion_status == "queued" && current.waiting_for_capacity) {
                return Ok(CapacityAdmission::Uncounted);
            }
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
            // A grant an earlier release committed, though its commit was reported failed,
            // left the run `submitted` without a Stop: it is this waiter's slot after all.
            let current = product.get_interaction(next).await?;
            if current.completion_status == "submitted"
                && !(current.stop_requested && current.stop_error.is_none())
            {
                let (_, granted) = slots.waiting.pop_front().expect("a waiting run");
                if granted.send(()).is_err() {
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

    /// A storage failure while passing a slot on keeps the settled run's slot and the oldest
    /// waiter's place: the limit holds and no later run overtakes it. Once storage recovers,
    /// the retried release starts exactly that waiter.
    #[tokio::test]
    async fn a_release_that_fails_keeps_the_slot_and_the_oldest_waiter() {
        let (_directory, store, product, runs) = fixture(3).await;
        let capacity = RunCapacity::new(1);
        assert!(matches!(
            capacity.admit(&product, runs[0]).await.unwrap(),
            CapacityAdmission::Start
        ));
        let mut grants = Vec::new();
        for run in &runs[1..] {
            match capacity.admit(&product, *run).await.unwrap() {
                CapacityAdmission::Waiting(grant) => grants.push(grant),
                other => panic!("run {run} was admitted as {other:?}"),
            }
        }
        // The wait's table is unreachable, so claiming the oldest waiter fails.
        store.set_capacity_waits_offline_for_test(true).await;
        assert!(capacity.release(&product, runs[0]).await.is_err());
        assert_eq!(capacity.executing_for_test().await, [runs[0]]);
        assert_eq!(capacity.waiting().await, runs[1..]);
        assert_eq!(store.completion_status_for_test(runs[1]).await, "queued");
        // A new run still waits behind them.
        let (_, late) = store.seed_node_runs_for_test(&[9]).await;
        assert!(store.claim_interaction_preparing(late[0]).await.unwrap());
        store.set_capacity_waits_offline_for_test(false).await;
        assert!(matches!(
            capacity.admit(&product, late[0]).await.unwrap(),
            CapacityAdmission::Waiting(_)
        ));
        // Storage is back: the retried release starts the oldest waiter, and only it.
        assert_eq!(
            capacity.release(&product, runs[0]).await.unwrap(),
            Some(runs[1])
        );
        grants.remove(0).await.unwrap();
        assert_eq!(capacity.executing_for_test().await, [runs[1]]);
        assert_eq!(capacity.waiting().await, [runs[2], late[0]]);
    }

    /// An admission or a grant whose commit was reported failed may still have landed. A
    /// retried admission adopts a durable wait, and a retried release recognizes a durable
    /// grant, so the run neither loses its place nor is left without an owner.
    #[tokio::test]
    async fn ambiguous_commits_are_adopted_on_retry() {
        let (_directory, store, product, runs) = fixture(3).await;
        let capacity = RunCapacity::new(1);
        assert!(matches!(
            capacity.admit(&product, runs[0]).await.unwrap(),
            CapacityAdmission::Start
        ));
        // The wait landed, though its admission failed: the retry adopts it.
        assert!(store.queue_run_for_capacity(runs[1]).await.unwrap());
        let mut grant = match capacity.admit(&product, runs[1]).await.unwrap() {
            CapacityAdmission::Waiting(grant) => grant,
            other => panic!("the durable wait was not adopted: {other:?}"),
        };
        assert_eq!(capacity.waiting().await, [runs[1]]);
        // The grant landed, though its release failed: the retry hands the slot over.
        assert!(store.claim_capacity_run(runs[1]).await.unwrap());
        assert_eq!(
            capacity.release(&product, runs[0]).await.unwrap(),
            Some(runs[1])
        );
        (&mut grant).await.unwrap();
        assert_eq!(capacity.executing_for_test().await, [runs[1]]);
        // A durable wait found with a slot free is claimed back and starts.
        assert_eq!(capacity.release(&product, runs[1]).await.unwrap(), None);
        assert!(store.queue_run_for_capacity(runs[2]).await.unwrap());
        assert!(matches!(
            capacity.admit(&product, runs[2]).await.unwrap(),
            CapacityAdmission::Start
        ));
        assert_eq!(store.completion_status_for_test(runs[2]).await, "submitted");

        // A lost grant is recognized even when the run carries a Stop that failed earlier.
        let (_, more) = store.seed_node_runs_for_test(&[5]).await;
        assert!(store.claim_interaction_preparing(more[0]).await.unwrap());
        let thread = product.get_interaction(more[0]).await.unwrap().thread_id;
        product
            .request_interaction_stop(thread, more[0])
            .await
            .unwrap();
        store
            .record_stop_error(more[0], "The provider refused the Stop.")
            .await
            .unwrap();
        let mut lost = match capacity.admit(&product, more[0]).await.unwrap() {
            CapacityAdmission::Waiting(grant) => grant,
            other => panic!("a run with a failed Stop did not wait: {other:?}"),
        };
        assert!(store.claim_capacity_run(more[0]).await.unwrap());
        assert_eq!(
            capacity.release(&product, runs[2]).await.unwrap(),
            Some(more[0])
        );
        (&mut lost).await.unwrap();
    }

    /// A run that carries a valid Stop never waits for capacity; it settles without a slot.
    #[tokio::test]
    async fn a_run_with_a_stop_settles_without_a_slot() {
        let (_directory, store, product, runs) = fixture(2).await;
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
        // With a slot free, it still takes none.
        assert_eq!(capacity.release(&product, runs[0]).await.unwrap(), None);
        assert!(matches!(
            capacity.admit(&product, runs[1]).await.unwrap(),
            CapacityAdmission::Uncounted
        ));
        assert!(capacity.executing_for_test().await.is_empty());

        // A Stop that failed is not honoured, so its run executes and takes a slot, and with
        // every slot taken it waits like any other run.
        store
            .record_stop_error(runs[1], "The provider refused the Stop.")
            .await
            .unwrap();
        assert!(matches!(
            capacity.admit(&product, runs[1]).await.unwrap(),
            CapacityAdmission::Start
        ));
        let (_, more) = store.seed_node_runs_for_test(&[9]).await;
        assert!(store.claim_interaction_preparing(more[0]).await.unwrap());
        let thread = product.get_interaction(more[0]).await.unwrap().thread_id;
        product
            .request_interaction_stop(thread, more[0])
            .await
            .unwrap();
        store
            .record_stop_error(more[0], "The provider refused the Stop.")
            .await
            .unwrap();
        assert!(matches!(
            capacity.admit(&product, more[0]).await.unwrap(),
            CapacityAdmission::Waiting(_)
        ));
    }
}
