use crate::{
    ActionDraft, CompletionOutput, EdgeDraft, GraphAction, GraphDatabase, GraphEdge, GraphError,
    GraphLayer, GraphNode, LayerDraft, LayerId, NodeDraft, NodeId, RecordState, ResolvedLayer,
    graph::{InteractionScope, completion, model::LayerCandidate},
    storage::{
        GraphConnection,
        sqlite::{
            actions::ActionTable, completions::CompletionTable, edges::EdgeTable, layers,
            layers::LayerTable, nodes::NodeTable,
        },
    },
};

pub struct GraphWriter {
    database: GraphDatabase,
    scope: InteractionScope,
}

impl GraphWriter {
    pub(crate) fn new(database: GraphDatabase, scope: InteractionScope) -> Self {
        Self { database, scope }
    }

    pub fn node_id(&self) -> NodeId {
        self.scope.root_node_id
    }

    pub async fn submit_node(&self, draft: &NodeDraft) -> Result<GraphNode, GraphError> {
        draft.validate()?;
        let mut transaction = self.database.storage.begin_write().await?;
        let existing = NodeTable::new(&mut transaction)
            .by_owner_and_key(self.scope.root_node_id, &draft.client_key)
            .await?;
        if existing
            .as_ref()
            .is_some_and(|record| record.node.state != RecordState::Draft)
        {
            return Err(GraphError::validation(
                "immutable_node",
                "node",
                "This node was already accepted. Create a new node and connect it to the old node instead of editing history.",
            ));
        }
        self.ensure_writable(&mut transaction).await?;
        let mut nodes = NodeTable::new(&mut transaction);
        let node = match existing {
            Some(record) if record.node.state == RecordState::Draft => {
                nodes.update_draft(record.node.id, draft).await?
            }
            Some(_) => unreachable!("accepted nodes returned above"),
            None => nodes.insert_draft(&self.scope, draft).await?,
        };
        transaction.commit().await?;
        Ok(node)
    }

    pub async fn create_edge(&self, draft: &EdgeDraft) -> Result<GraphEdge, GraphError> {
        let endpoints = draft.validate()?;
        let mut transaction = self.database.storage.begin_write().await?;
        self.ensure_writable(&mut transaction).await?;
        for (index, node_id) in endpoints.iter().enumerate() {
            NodeTable::new(&mut transaction)
                .visible(&self.scope, *node_id)
                .await
                .map_err(|_| {
                    GraphError::validation(
                        "unknown_endpoint",
                        format!("endpoints[{index}]"),
                        format!(
                            "Node {node_id} is not available in this graph. Use a node returned by submitNode or getNode."
                        ),
                    )
                })?;
        }
        let mut edges = EdgeTable::new(&mut transaction);
        let edge = if let Some(record) = edges
            .by_owner_and_key(self.scope.root_node_id, &draft.client_key)
            .await?
        {
            if record.edge.endpoints == endpoints {
                record.edge
            } else {
                return Err(GraphError::validation(
                    "edge_key_reused",
                    "clientKey",
                    "This edge key already identifies another edge. Reuse the returned edge or choose a new local key.",
                ));
            }
        } else if let Some(id) = edges.duplicate(&self.scope, endpoints).await? {
            return Err(GraphError::validation(
                "duplicate_edge",
                "endpoints",
                format!(
                    "Nodes {} and {} are already connected by edge {id}. Reuse that edge instead.",
                    endpoints[0], endpoints[1]
                ),
            ));
        } else {
            edges.insert_draft(&self.scope, draft, endpoints).await?
        };
        transaction.commit().await?;
        Ok(edge)
    }

    pub async fn submit_layer(&self, draft: &LayerDraft) -> Result<GraphLayer, GraphError> {
        let mut transaction = self.database.storage.begin_write().await?;
        self.ensure_writable(&mut transaction).await?;
        let mut nodes = Vec::with_capacity(draft.nodes.len());
        for id in &draft.nodes {
            nodes.push(
                NodeTable::new(&mut transaction)
                    .visible(&self.scope, *id)
                    .await?,
            );
        }
        let mut edges = Vec::with_capacity(draft.edges.len());
        for id in &draft.edges {
            edges.push(
                EdgeTable::new(&mut transaction)
                    .visible(&self.scope, *id)
                    .await?,
            );
        }
        LayerCandidate {
            draft,
            nodes,
            edges,
        }
        .validate()?;
        let layer = LayerTable::new(&mut transaction)
            .upsert_draft(&self.scope, draft)
            .await?;
        transaction.commit().await?;
        Ok(layer)
    }

    pub async fn add_action(&self, draft: &ActionDraft) -> Result<GraphAction, GraphError> {
        draft.validate_shape()?;
        let mut transaction = self.database.storage.begin_write().await?;
        self.ensure_writable(&mut transaction).await?;
        let source = NodeTable::new(&mut transaction)
            .record(draft.source_node_id)
            .await?
            .ok_or_else(|| GraphError::NotFound(format!("source node {}", draft.source_node_id)))?;
        if draft.source_node_id != self.scope.root_node_id
            && !(source.node.state == RecordState::Draft
                && source.owner == Some(self.scope.root_node_id))
        {
            return Err(GraphError::validation(
                "immutable_action_source",
                "sourceNodeId",
                "Actions can only be added to the current interaction node or a draft node created for this interaction.",
            ));
        }
        if let Some(layer_id) = draft.target_layer_id {
            LayerTable::new(&mut transaction)
                .visible(&self.scope, layer_id)
                .await?;
        }
        let mut actions = ActionTable::new(&mut transaction);
        let action = match actions
            .by_owner_and_key(
                self.scope.root_node_id,
                draft.source_node_id,
                &draft.client_key,
            )
            .await?
        {
            Some(record) if record.action.state == RecordState::Draft => {
                actions.update_draft(record.action.id, draft).await?
            }
            Some(_) => {
                return Err(GraphError::validation(
                    "immutable_action",
                    "action",
                    "This action was already accepted. Create a new node and action instead of editing history.",
                ));
            }
            None => actions.insert_draft(&self.scope, draft).await?,
        };
        transaction.commit().await?;
        Ok(action)
    }

    pub async fn get_node(&self, id: NodeId) -> Result<GraphNode, GraphError> {
        let mut connection = self.database.storage.acquire().await?;
        NodeTable::new(&mut connection)
            .visible(&self.scope, id)
            .await
    }

    pub async fn neighbors(&self, id: NodeId) -> Result<Vec<GraphNode>, GraphError> {
        let mut connection = self.database.storage.acquire().await?;
        let mut nodes = NodeTable::new(&mut connection);
        nodes.visible(&self.scope, id).await?;
        nodes.neighbors(&self.scope, id).await
    }

    pub async fn get_layer(&self, id: LayerId) -> Result<ResolvedLayer, GraphError> {
        let mut connection = self.database.storage.acquire().await?;
        layers::resolve(&mut connection, &self.scope, id, false).await
    }

    pub async fn completion_output(&self) -> Result<Option<CompletionOutput>, GraphError> {
        completion::read_output(&self.database, &self.scope).await
    }

    pub async fn complete(&self, interaction: NodeId) -> Result<CompletionOutput, GraphError> {
        self.scope.require_root(interaction)?;
        completion::complete(&self.database, &self.scope).await
    }

    async fn ensure_writable(&self, connection: &mut GraphConnection) -> Result<(), GraphError> {
        if CompletionTable::new(connection)
            .root_action(self.scope.root_node_id)
            .await?
            .is_some()
        {
            return Err(GraphError::Forbidden(
                "this interaction already has an accepted completion".into(),
            ));
        }
        Ok(())
    }
}
