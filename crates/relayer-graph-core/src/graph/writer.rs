use crate::{
    ActionDraft, ActionId, CompletionOutput, CompletionState, CurrentTransition,
    CurrentTransitionReceipt, EdgeDraft, GraphAction, GraphDatabase, GraphEdge, GraphError,
    GraphLayer, GraphNode, InteractionInput, InteractionInputChild, InteractionInvocation,
    LayerDraft, LayerId, NavigateRelation, NodeDraft, NodeId, RecordState, ResolvedLayer,
    graph::{
        InteractionScope, completion,
        database::initialize_completion,
        model::{AuthoredDetailUpdate, LayerCandidate, validate_authored_detail},
    },
    storage::{
        GraphConnection,
        sqlite::{
            actions::ActionTable, contexts::ContextTable, currents::CurrentTable, edges::EdgeTable,
            input_children::InputChildTable, layers, layers::LayerTable, nodes::NodeTable,
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

    pub async fn prepare_recursive_completion(
        &self,
        action_id: ActionId,
    ) -> Result<GraphNode, GraphError> {
        let mut transaction = self.database.storage.begin_write().await?;
        self.scope
            .require_active_authority(&mut transaction)
            .await?;
        let child = NodeTable::new(&mut transaction)
            .insert_interaction(
                self.scope.project_id,
                self.scope.thread_id,
                "",
                Some(InteractionInvocation {
                    source_interaction_node_id: self.scope.root_node_id,
                    source_action_id: action_id,
                }),
            )
            .await?;
        initialize_completion(
            &mut transaction,
            &child,
            self.scope.project_id,
            self.scope.thread_id,
        )
        .await?;
        transaction.commit().await?;
        Ok(child)
    }

    /// Reads one accepted action this completion authored.
    ///
    /// A published invoke occurrence is accepted at the revision that published it, long
    /// before its completion returns, so this deliberately does not read a final output.
    pub async fn accepted_authored_action(
        &self,
        action_id: ActionId,
    ) -> Result<Option<GraphAction>, GraphError> {
        let mut transaction = self.database.storage.begin_read().await?;
        let record = ActionTable::new(&mut transaction)
            .authored_accepted(&self.scope, action_id)
            .await?;
        transaction.commit().await?;
        Ok(record.map(|record| record.action))
    }

    pub async fn interaction_input(&self) -> Result<InteractionInput, GraphError> {
        let mut transaction = self.database.storage.begin_read().await?;
        self.scope
            .require_active_authority(&mut transaction)
            .await?;
        let input = ContextTable::new(&mut transaction)
            .interaction_input(&self.scope)
            .await?;
        transaction.commit().await?;
        Ok(input)
    }

    pub async fn interaction_input_children(
        &self,
    ) -> Result<Vec<InteractionInputChild>, GraphError> {
        let mut connection = self.database.storage.acquire().await?;
        InputChildTable::new(&mut connection)
            .children(self.scope.root_node_id)
            .await
    }

    /// Submit a draft without mentioning its authored detail: an existing
    /// checkpointed package is retained.
    pub async fn submit_node(&self, draft: &NodeDraft) -> Result<GraphNode, GraphError> {
        self.submit_node_with_authored_detail_update(draft, AuthoredDetailUpdate::Retain)
            .await
    }

    /// Submit a draft with an optional replacement package. `None` retains the
    /// existing package; use [`Self::submit_node_with_authored_detail_update`]
    /// with [`AuthoredDetailUpdate::Clear`] to remove one.
    pub async fn submit_node_with_authored_detail(
        &self,
        draft: &NodeDraft,
        authored_detail: Option<&serde_json::Value>,
    ) -> Result<GraphNode, GraphError> {
        let update =
            authored_detail.map_or(AuthoredDetailUpdate::Retain, AuthoredDetailUpdate::Replace);
        self.submit_node_with_authored_detail_update(draft, update)
            .await
    }

    pub async fn submit_node_with_authored_detail_update(
        &self,
        draft: &NodeDraft,
        authored_detail: AuthoredDetailUpdate<'_>,
    ) -> Result<GraphNode, GraphError> {
        if let AuthoredDetailUpdate::Replace(package) = authored_detail {
            validate_authored_detail(package)?;
        }
        let canonical_icon = draft.validate()?;
        let normalized_draft = NodeDraft {
            icon: canonical_icon.into(),
            ..draft.clone()
        };
        let draft = &normalized_draft;
        let mut transaction = self.database.storage.begin_write().await?;
        if self.scope.authority_epoch.is_some() {
            self.ensure_writable(&mut transaction).await?;
        }
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
        if self.scope.authority_epoch.is_none() {
            self.ensure_writable(&mut transaction).await?;
        }
        let mut nodes = NodeTable::new(&mut transaction);
        let node = match existing {
            Some(record) if record.node.state == RecordState::Draft => {
                nodes
                    .update_draft(record.node.id, draft, authored_detail)
                    .await?
            }
            Some(_) => unreachable!("accepted nodes returned above"),
            None => {
                nodes
                    .insert_draft(&self.scope, draft, authored_detail.replacement())
                    .await?
            }
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

    pub async fn discard_layer(&self, id: LayerId) -> Result<GraphLayer, GraphError> {
        let mut transaction = self.database.storage.begin_write().await?;
        if self.scope.authority_epoch.is_some() {
            self.ensure_writable(&mut transaction).await?;
        }
        let record = LayerTable::new(&mut transaction)
            .record(&self.scope, id)
            .await?
            .ok_or_else(|| GraphError::NotFound(format!("layer {id}")))?;
        if record.owner != self.scope.root_node_id {
            return Err(GraphError::Forbidden(format!(
                "layer {id} belongs to another interaction"
            )));
        }
        match record.layer.state {
            RecordState::Stopped => return Ok(record.layer),
            RecordState::Accepted => {
                return Err(GraphError::validation(
                    "immutable_layer",
                    "layer",
                    "This layer was already accepted and cannot be discarded.",
                ));
            }
            RecordState::Draft => {}
        }
        if self.scope.authority_epoch.is_none() {
            self.ensure_writable(&mut transaction).await?;
        }
        if LayerTable::new(&mut transaction)
            .is_reachable_from_root(self.scope.root_node_id, id)
            .await?
        {
            return Err(GraphError::validation(
                "reachable_layer",
                "layer",
                format!(
                    "Layer {id} is reachable from the current root action. Retarget the incoming action before discarding this layer."
                ),
            ));
        }
        LayerTable::new(&mut transaction)
            .stop_owned_draft(id, self.scope.root_node_id)
            .await?;
        transaction.commit().await?;
        Ok(GraphLayer {
            state: RecordState::Stopped,
            ..record.layer
        })
    }

    pub async fn add_action(&self, draft: &ActionDraft) -> Result<GraphAction, GraphError> {
        let canonical_icon = draft.validate_shape()?;
        let normalized_draft = ActionDraft {
            icon: canonical_icon.map(str::to_owned),
            ..draft.clone()
        };
        let draft = &normalized_draft;
        let mut transaction = self.database.storage.begin_write().await?;
        self.ensure_writable(&mut transaction).await?;
        let source = NodeTable::new(&mut transaction)
            .record(draft.source_node_id)
            .await?
            .ok_or_else(|| GraphError::NotFound(format!("source node {}", draft.source_node_id)))?;
        if draft.source_node_id == self.scope.root_node_id {
            if draft.source_layer_id.is_some() {
                return Err(GraphError::validation(
                    "unexpected_root_source_layer",
                    "sourceLayerId",
                    "The interaction root is not authored from a layer. Remove sourceLayerId and retry.",
                ));
            }
            if draft.kind != crate::ActionKind::Navigate
                || draft.relation != Some(NavigateRelation::Expand)
            {
                return Err(GraphError::validation(
                    "invalid_root_action",
                    "relation",
                    "The interaction root action must be navigate with relation=expand.",
                ));
            }
            if let Some(existing) = ActionTable::new(&mut transaction)
                .active_root_identity(self.scope.root_node_id)
                .await?
                && existing.client_key != draft.client_key
            {
                return Err(GraphError::validation(
                    "root_action_already_exists",
                    "clientKey",
                    format!(
                        "This interaction already has active root action {} with clientKey {:?}. Reuse that clientKey to update the existing draft root action, or call graph.submit(interactionNode) if it is already correct.",
                        existing.id, existing.client_key
                    ),
                ));
            }
        } else {
            if !(source.node.state == RecordState::Draft
                && source.owner == Some(self.scope.root_node_id))
            {
                return Err(GraphError::validation(
                    "immutable_action_source",
                    "sourceNodeId",
                    "New actions can only be authored on a draft node created for this interaction. Reused accepted nodes keep their existing actions.",
                ));
            }
            let source_layer_id = draft.source_layer_id.ok_or_else(|| {
                GraphError::validation(
                    "missing_source_layer",
                    "sourceLayerId",
                    "Identify the layer you are authoring from with sourceLayerId and retry.",
                )
            })?;
            let source_layer = LayerTable::new(&mut transaction)
                .record(&self.scope, source_layer_id)
                .await?
                .ok_or_else(|| {
                    GraphError::validation(
                        "unknown_source_layer",
                        "sourceLayerId",
                        format!("Source layer {source_layer_id} does not exist. Submit that layer first."),
                    )
                })?;
            if source_layer.owner != self.scope.root_node_id
                || source_layer.layer.state != RecordState::Draft
            {
                return Err(GraphError::validation(
                    "invalid_source_layer",
                    "sourceLayerId",
                    "New actions must be authored from a current-interaction draft layer.",
                ));
            }
            if !source_layer.layer.nodes.contains(&draft.source_node_id) {
                return Err(GraphError::validation(
                    "source_node_outside_layer",
                    "sourceNodeId",
                    format!(
                        "Node {} is not in source layer {source_layer_id}. Choose a source layer that contains the node.",
                        draft.source_node_id
                    ),
                ));
            }
            let incoming = ActionTable::new(&mut transaction)
                .relations_for_owned_target(self.scope.root_node_id, source_layer_id)
                .await?;
            if incoming.contains(&NavigateRelation::Reference)
                && (draft.kind != crate::ActionKind::Navigate
                    || draft.relation != Some(NavigateRelation::Reference))
            {
                return Err(GraphError::validation(
                    "reference_layer_authoring_restricted",
                    "relation",
                    "This action starts from a reference layer. Reference layers may author only reference navigation. Change the relation to reference, or author the action from an expansion layer.",
                ));
            }
        }
        if let Some(layer_id) = draft.target_layer_id {
            let target = LayerTable::new(&mut transaction)
                .record(&self.scope, layer_id)
                .await?
                .ok_or_else(|| {
                    GraphError::validation(
                        "unknown_target_layer",
                        "targetLayerId",
                        format!("Target layer {layer_id} does not exist. Submit that layer first."),
                    )
                })?;
            let root_reuses_current = if draft.source_node_id == self.scope.root_node_id
                && draft.relation == Some(NavigateRelation::Expand)
                && target.owner == self.scope.root_node_id
                && target.layer.state == RecordState::Accepted
            {
                let current = CurrentTable::new(&mut transaction)
                    .state(self.scope.root_node_id)
                    .await?;
                current.lifecycle == crate::CompletionLifecycle::Active
                    && current.current_layer_id == Some(layer_id)
            } else {
                false
            };
            match draft.relation {
                Some(NavigateRelation::Expand)
                    if target.owner != self.scope.root_node_id
                        || (target.layer.state != RecordState::Draft && !root_reuses_current) =>
                {
                    return Err(GraphError::validation(
                        "expand_target_must_be_current_draft",
                        "targetLayerId",
                        "Expand actions must target a draft layer created for the current interaction. Create a current draft layer, or use relation=reference for visible accepted context.",
                    ));
                }
                Some(NavigateRelation::Reference)
                    if target.layer.state != RecordState::Accepted
                        && (target.owner != self.scope.root_node_id
                            || target.layer.state != RecordState::Draft) =>
                {
                    return Err(GraphError::validation(
                        "reference_target_not_visible",
                        "targetLayerId",
                        "Reference actions may target a current draft layer or a visible accepted layer.",
                    ));
                }
                _ => {}
            }
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
        let mut transaction = self.database.storage.begin_read().await?;
        self.scope
            .require_active_authority(&mut transaction)
            .await?;
        let node = NodeTable::new(&mut transaction)
            .visible(&self.scope, id)
            .await?;
        transaction.commit().await?;
        Ok(node)
    }

    pub async fn neighbors(&self, id: NodeId) -> Result<Vec<GraphNode>, GraphError> {
        let mut transaction = self.database.storage.begin_read().await?;
        self.scope
            .require_active_authority(&mut transaction)
            .await?;
        let mut nodes = NodeTable::new(&mut transaction);
        nodes.visible(&self.scope, id).await?;
        let neighbors = nodes.neighbors(&self.scope, id).await?;
        transaction.commit().await?;
        Ok(neighbors)
    }

    pub async fn get_layer(&self, id: LayerId) -> Result<ResolvedLayer, GraphError> {
        let mut transaction = self.database.storage.begin_read().await?;
        self.scope
            .require_active_authority(&mut transaction)
            .await?;
        let layer = layers::resolve(&mut transaction, &self.scope, id, false).await?;
        transaction.commit().await?;
        Ok(layer)
    }

    pub async fn get_layer_owner(&self, id: LayerId) -> Result<NodeId, GraphError> {
        let mut transaction = self.database.storage.begin_read().await?;
        self.scope
            .require_active_authority(&mut transaction)
            .await?;
        let record = LayerTable::new(&mut transaction)
            .record(&self.scope, id)
            .await?
            .ok_or_else(|| GraphError::NotFound(format!("layer {id}")))?;
        if record.layer.state != RecordState::Accepted && record.owner != self.scope.root_node_id {
            return Err(GraphError::Forbidden(format!(
                "layer {id} is not readable by this interaction"
            )));
        }
        transaction.commit().await?;
        Ok(record.owner)
    }

    pub async fn completion_output(&self) -> Result<Option<CompletionOutput>, GraphError> {
        let mut transaction = self.database.storage.begin_read().await?;
        let state = CurrentTable::new(&mut transaction)
            .state(self.scope.root_node_id)
            .await?;
        if state.lifecycle != crate::CompletionLifecycle::Active {
            self.scope
                .require_generation_authority(&mut transaction)
                .await?;
        } else {
            self.scope
                .require_active_authority(&mut transaction)
                .await?;
        }
        let output = completion::read_output_on(&mut transaction, &self.scope).await?;
        transaction.commit().await?;
        Ok(output)
    }

    pub async fn current_completion(&self) -> Result<CompletionState, GraphError> {
        let mut transaction = self.database.storage.begin_read().await?;
        self.scope
            .require_active_authority(&mut transaction)
            .await?;
        let current = CurrentTable::new(&mut transaction)
            .state(self.scope.root_node_id)
            .await?;
        transaction.commit().await?;
        Ok(current)
    }

    pub async fn transition_current(
        &self,
        expected_revision: u64,
        operation_key: &str,
        intent: CurrentTransition,
    ) -> Result<CurrentTransitionReceipt, GraphError> {
        if self.scope.read_only {
            return Err(GraphError::Forbidden(
                "imported conversation graphs are immutable".into(),
            ));
        }
        completion::transition_current(
            &self.database,
            &self.scope,
            expected_revision,
            operation_key,
            &intent,
        )
        .await
    }

    pub async fn complete(&self, interaction: NodeId) -> Result<CompletionOutput, GraphError> {
        self.scope.require_root(interaction)?;
        if self.scope.read_only {
            return Err(GraphError::Forbidden(
                "imported conversation graphs are immutable".into(),
            ));
        }
        completion::complete(&self.database, &self.scope).await
    }

    async fn ensure_writable(&self, connection: &mut GraphConnection) -> Result<(), GraphError> {
        if self.scope.read_only {
            return Err(GraphError::Forbidden(
                "imported conversation graphs are immutable".into(),
            ));
        }
        self.scope.require_active_authority(connection).await?;
        let current = CurrentTable::new(connection)
            .state(self.scope.root_node_id)
            .await?;
        if current.lifecycle != crate::CompletionLifecycle::Active {
            return Err(GraphError::Forbidden(
                "this interaction already has an accepted completion or terminal completion state"
                    .into(),
            ));
        }
        Ok(())
    }
}
