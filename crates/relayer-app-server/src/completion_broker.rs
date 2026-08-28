use crate::product::{InteractionId, ThreadId};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
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
