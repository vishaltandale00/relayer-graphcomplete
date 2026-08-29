use crate::product::{InteractionId, ThreadId};
use relayer_graph_core::{CompletionLifecycle, CurrentProjectionEvent};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::sync::watch;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct CompletionBrokerGrant {
    pub(crate) thread_id: ThreadId,
    pub(crate) source_interaction_id: InteractionId,
    pub(crate) source_completion_id: i64,
}

#[derive(Clone, Default)]
pub(crate) struct CompletionBrokerRegistry {
    grants: Arc<Mutex<HashMap<String, CompletionBrokerGrant>>>,
    origin: Option<Arc<str>>,
}

impl CompletionBrokerRegistry {
    pub(crate) fn new(origin: Option<String>) -> Self {
        Self {
            grants: Arc::new(Mutex::new(HashMap::new())),
            origin: origin.map(Arc::from),
        }
    }

    pub(crate) fn url(&self) -> Option<String> {
        self.origin
            .as_deref()
            .map(|origin| format!("{}/api/completions", origin.trim_end_matches('/')))
    }

    pub(crate) fn issue(&self, grant: CompletionBrokerGrant) -> CompletionBrokerLease {
        let token = Uuid::new_v4().to_string();
        self.grants
            .lock()
            .expect("completion broker registry poisoned")
            .insert(token.clone(), grant);
        CompletionBrokerLease {
            token: Some(token),
            registry: self.clone(),
        }
    }

    pub(crate) fn resolve(&self, token: &str) -> Option<CompletionBrokerGrant> {
        self.grants
            .lock()
            .expect("completion broker registry poisoned")
            .get(token)
            .copied()
    }

    fn revoke(&self, token: &str) {
        self.grants
            .lock()
            .expect("completion broker registry poisoned")
            .remove(token);
    }
}

/// How long one awaited observation stays open before it answers with the unchanged current.
pub(crate) const COMPLETION_OBSERVATION_HOLD: std::time::Duration =
    std::time::Duration::from_secs(25);

/// One published current-pointer revision, as the projection outbox ordered it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ObservedRevision {
    pub(crate) revision: u64,
    pub(crate) lifecycle: CompletionLifecycle,
}

impl From<&CurrentProjectionEvent> for ObservedRevision {
    fn from(event: &CurrentProjectionEvent) -> Self {
        Self {
            revision: event.revision,
            lifecycle: event.lifecycle,
        }
    }
}

/// Delivers current-pointer revisions to execution-scoped awaiters without repeated polling.
///
/// One supervised completion owns one channel, registered before its observer starts so an
/// awaiter that arrives first still has something to wait on. The channel carries `None`
/// until the observer reads the completion's first projection-outbox record.
#[derive(Clone, Default)]
pub(crate) struct CompletionObservations {
    channels: Arc<Mutex<HashMap<i64, watch::Sender<Option<ObservedRevision>>>>>,
}

impl CompletionObservations {
    pub(crate) fn publish(&self, completion_id: i64, observed: ObservedRevision) {
        let mut channels = self
            .channels
            .lock()
            .expect("completion observation registry poisoned");
        match channels.get(&completion_id) {
            Some(sender) => {
                sender.send_replace(Some(observed));
            }
            None => {
                channels.insert(completion_id, watch::channel(Some(observed)).0);
            }
        }
    }

    fn subscribe(&self, completion_id: i64) -> Option<watch::Receiver<Option<ObservedRevision>>> {
        self.channels
            .lock()
            .expect("completion observation registry poisoned")
            .get(&completion_id)
            .map(watch::Sender::subscribe)
    }

    /// Registers one completion's channel and holds it open while its observer supervises it.
    ///
    /// Registration is synchronous and precedes the observer, because the awaiting execution
    /// can ask for news before the first projection read returns.
    pub(crate) fn supervise(&self, completion_id: i64) -> CompletionObservationGuard {
        self.channels
            .lock()
            .expect("completion observation registry poisoned")
            .entry(completion_id)
            .or_insert_with(|| watch::channel(None).0);
        CompletionObservationGuard {
            observations: self.clone(),
            completion_id,
        }
    }

    /// Waits until the awaited completion publishes a revision past the caller's, and reports
    /// whether one arrived.
    ///
    /// Delivery is sourced from the projection-outbox records the supervising observer reads,
    /// so an awaiting execution never polls. The hold always lasts its full interval: a
    /// completion nothing supervises here has no news to deliver, and answering it at once
    /// would invite the request loop this mechanism exists to remove.
    pub(crate) async fn hold(&self, completion_id: i64, after_revision: u64) -> bool {
        let deadline = tokio::time::Instant::now() + COMPLETION_OBSERVATION_HOLD;
        let Some(mut observation) = self.subscribe(completion_id) else {
            tokio::time::sleep_until(deadline).await;
            return false;
        };
        loop {
            let observed = *observation.borrow_and_update();
            if observed.is_some_and(|observed| {
                observed.revision > after_revision
                    || observed.lifecycle != CompletionLifecycle::Active
            }) {
                return true;
            }
            if !matches!(
                tokio::time::timeout_at(deadline, observation.changed()).await,
                Ok(Ok(()))
            ) {
                return false;
            }
        }
    }

    fn forget(&self, completion_id: i64) {
        self.channels
            .lock()
            .expect("completion observation registry poisoned")
            .remove(&completion_id);
    }
}

pub(crate) struct CompletionObservationGuard {
    observations: CompletionObservations,
    completion_id: i64,
}

impl Drop for CompletionObservationGuard {
    fn drop(&mut self) {
        self.observations.forget(self.completion_id);
    }
}

pub(crate) struct CompletionBrokerLease {
    token: Option<String>,
    registry: CompletionBrokerRegistry,
}

impl CompletionBrokerLease {
    pub(crate) fn token(&self) -> &str {
        self.token
            .as_deref()
            .expect("active completion broker lease")
    }
}

impl Drop for CompletionBrokerLease {
    fn drop(&mut self) {
        if let Some(token) = self.token.take() {
            self.registry.revoke(&token);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lease_revokes_only_its_exact_execution_scope() {
        let registry = CompletionBrokerRegistry::default();
        let grant = CompletionBrokerGrant {
            thread_id: ThreadId::from_database(2),
            source_interaction_id: InteractionId::from_database(3),
            source_completion_id: 4,
        };
        let lease = registry.issue(grant);
        let token = lease.token().to_owned();
        assert_eq!(registry.resolve(&token), Some(grant));
        drop(lease);
        assert_eq!(registry.resolve(&token), None);
    }
}
