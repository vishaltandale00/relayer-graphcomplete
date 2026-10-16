use crate::storage::sqlite::plans;
use crate::{GraphDatabase, GraphError, GraphNode, GraphWriter, NodeId, SearchTarget};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanDraft {
    pub client_key: String,
    pub title: String,
    pub detail: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanPublication {
    pub node: GraphNode,
    pub interaction_node_id: NodeId,
    pub revision: u64,
    pub read_plan_node_ids: Vec<NodeId>,
}

impl GraphWriter {
    /// Publishes an immutable internal checkpoint without advancing response Current.
    pub async fn publish_plan(&self, draft: &PlanDraft) -> Result<PlanPublication, GraphError> {
        for (path, value, max) in [
            ("clientKey", draft.client_key.as_str(), 200),
            ("title", draft.title.as_str(), 500),
            ("detail", draft.detail.as_str(), 65536),
        ] {
            if value.trim().is_empty() || value.len() > max {
                return Err(GraphError::validation(
                    "invalid_plan",
                    path,
                    "Plan fields must be nonempty and within their byte limit.",
                ));
            }
        }
        // Query-v1 returns full Content properties with a typed pointer. Reserve
        // half its 16 KiB envelope for pointer metadata and row framing, and
        // measure JSON bytes so escaped/control-heavy text cannot evade the cap.
        let encoded = serde_json::to_vec(draft).map_err(|e| GraphError::Internal(e.to_string()))?;
        if encoded.len() > 8 * 1024 {
            return Err(GraphError::validation(
                "plan_too_large",
                "plan",
                "Keep each high-level plan checkpoint within 8 KiB of encoded JSON so its search pointer remains discoverable.",
            ));
        }
        let digest = format!(
            "sha256:{:x}",
            Sha256::digest(
                serde_json::to_vec(draft).map_err(|e| GraphError::Internal(e.to_string()))?
            )
        );
        let database = &self.database;
        let target = SearchTarget::new(self.scope.project_id, self.scope.thread_id);
        let _order = database.order_writes_to(target).await;
        let expiry = database.expiry();
        super::completion::deadline(expiry, database.search_index.wait_until_available(target))
            .await?;
        let _publication = database.enter_search_publication().await;
        let mut transaction = database.storage.begin_write().await?;
        self.ensure_writable(&mut transaction).await?;
        let (publication, new) =
            plans::insert(&mut transaction, &self.scope, draft, &digest).await?;
        if new {
            super::completion::index_internal_and_record(
                database,
                &mut transaction,
                target,
                publication.node.clone(),
                crate::publication_targets(self.scope.project_id, self.scope.thread_id),
                expiry,
            )
            .await?;
        } else {
            super::completion::canonical_publication_matches(database, &mut transaction, target)
                .await?;
        }
        transaction.commit().await?;
        database.search_index.canonical_commit_confirmed(target);
        Ok(publication)
    }
    /// Capture only canonical typed node pointers returned by a scoped search.
    pub async fn observe_plan_pointers(&self, ids: &[NodeId]) -> Result<(), GraphError> {
        let mut transaction = self.database.storage.begin_write().await?;
        self.scope
            .require_active_authority(&mut transaction)
            .await?;
        for id in ids {
            crate::storage::sqlite::nodes::NodeTable::new(&mut transaction)
                .visible(&self.scope, *id)
                .await?;
            plans::observe(&mut transaction, &self.scope, *id).await?;
        }
        transaction.commit().await?;
        Ok(())
    }

    pub async fn get_plan(&self, id: NodeId) -> Result<PlanPublication, GraphError> {
        let mut transaction = self.database.storage.begin_write().await?;
        self.scope
            .require_active_authority(&mut transaction)
            .await?;
        let publication = plans::publication(&mut transaction, &self.scope, id).await?;
        plans::observe(&mut transaction, &self.scope, id).await?;
        transaction.commit().await?;
        Ok(publication)
    }
}

impl GraphDatabase {
    /// Control-only configuration for preparation of NEW interaction identities.
    pub fn with_plan_preparation(mut self, enabled: bool) -> Self {
        self.prepare_living_plans = enabled;
        self
    }
}
