use crate::{NodeId, ProjectId, ThreadId};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct InteractionScope {
    pub project_id: Option<ProjectId>,
    pub thread_id: ThreadId,
    pub root_node_id: NodeId,
    pub read_only: bool,
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
}
