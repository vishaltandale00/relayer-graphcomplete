use crate::{NodeId, ProjectId, ThreadId};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct InteractionScope {
    pub project_id: Option<ProjectId>,
    pub thread_id: ThreadId,
    pub root_node_id: NodeId,
    pub read_only: bool,
    pub authority_epoch: Option<u64>,
}

impl InteractionScope {
    pub(crate) fn require_root(&self, node_id: NodeId) -> Result<(), crate::GraphError> {
        if node_id == self.root_node_id {
            Ok(())
        } else {
            Err(crate::GraphError::Forbidden(
                "complete must receive the graph writer's root node".into(),
            ))
        }
    }

    pub(crate) async fn require_active_authority(
        &self,
        connection: &mut crate::storage::GraphConnection,
    ) -> Result<(), crate::GraphError> {
        let Some(epoch) = self.authority_epoch else {
            return Ok(());
        };
        let (entitlement, digest) = self.read_entitlement();
        crate::storage::sqlite::currents::CurrentTable::new(connection)
            .validate_authority(self.root_node_id, epoch, &entitlement, &digest)
            .await
    }

    pub(crate) async fn require_generation_authority(
        &self,
        connection: &mut crate::storage::GraphConnection,
    ) -> Result<(), crate::GraphError> {
        let Some(epoch) = self.authority_epoch else {
            return Ok(());
        };
        let (entitlement, digest) = self.read_entitlement();
        crate::storage::sqlite::currents::CurrentTable::new(connection)
            .validate_generation(self.root_node_id, epoch, &entitlement, &digest)
            .await
    }

    pub(crate) fn read_entitlement(&self) -> (String, String) {
        let entitlement = self
            .project_id
            .map(|id| format!("project:{}", id.value()))
            .unwrap_or_else(|| format!("thread:{}", self.thread_id.value()));
        let digest = format!("sha256:{:x}", Sha256::digest(entitlement.as_bytes()));
        (entitlement, digest)
    }
}
