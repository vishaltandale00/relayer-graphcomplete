use std::path::Path;

use crate::{
    AcceptedGraphClosure, GraphError, GraphNode, GraphWriter, InteractionInvocation, NodeId,
    ProjectId, ThreadId,
    graph::model::require_nonempty,
    storage::{SqliteGraphStore, sqlite::nodes::NodeTable},
};

#[derive(Clone)]
pub struct GraphDatabase {
    pub(crate) storage: SqliteGraphStore,
}

impl GraphDatabase {
    pub async fn open(path: impl AsRef<Path>) -> Result<Self, GraphError> {
        Ok(Self {
            storage: SqliteGraphStore::open(path).await?,
        })
    }

    pub async fn in_memory() -> Result<Self, GraphError> {
        Ok(Self {
            storage: SqliteGraphStore::in_memory().await?,
        })
    }

    pub async fn create_interaction(
        &self,
        project_id: Option<ProjectId>,
        thread_id: ThreadId,
        text: &str,
    ) -> Result<GraphNode, GraphError> {
        self.create_interaction_with_invocation(project_id, thread_id, text, None)
            .await
    }

    pub async fn create_interaction_with_invocation(
        &self,
        project_id: Option<ProjectId>,
        thread_id: ThreadId,
        text: &str,
        invocation: Option<InteractionInvocation>,
    ) -> Result<GraphNode, GraphError> {
        require_nonempty(text, "text")?;
        let mut transaction = self.storage.begin_write().await?;
        let node = NodeTable::new(&mut transaction)
            .insert_interaction(project_id, thread_id, text, invocation)
            .await?;
        transaction.commit().await?;
        Ok(node)
    }

    pub async fn writer_for_subgraph(&self, node_id: NodeId) -> Result<GraphWriter, GraphError> {
        let scope = {
            let mut connection = self.storage.acquire().await?;
            NodeTable::new(&mut connection)
                .interaction_scope(node_id)
                .await?
        };
        Ok(GraphWriter::new(self.clone(), scope))
    }

    pub async fn accepted_graph_closure(
        &self,
        node_id: NodeId,
    ) -> Result<Option<AcceptedGraphClosure>, GraphError> {
        crate::graph::completion::read_accepted_closure(self, node_id).await
    }

    pub async fn interaction_invocation(
        &self,
        node_id: NodeId,
    ) -> Result<Option<InteractionInvocation>, GraphError> {
        let mut connection = self.storage.acquire().await?;
        Ok(NodeTable::new(&mut connection)
            .interaction_lease(node_id)
            .await?
            .map(|lease| InteractionInvocation {
                source_interaction_node_id: lease.source_interaction_id,
                source_action_id: lease.action_id,
            }))
    }

    pub async fn close(&self) {
        self.storage.close().await;
    }
}
