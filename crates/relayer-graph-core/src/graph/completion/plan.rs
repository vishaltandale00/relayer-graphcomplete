use std::collections::{HashMap, HashSet, VecDeque};

use crate::{
    ActionId, ActionKind, EdgeId, GraphAction, GraphError, LayerId, NavigateRelation, NodeId,
    RecordState,
    graph::{
        InteractionScope, model::validate_connected, validate_authored_layout,
        validate_edge_route_ends,
    },
    storage::{
        GraphConnection,
        sqlite::{
            actions::ActionTable,
            edges::EdgeTable,
            layers,
            layers::LayerTable,
            nodes::{InteractionLease, NodeTable},
        },
    },
};

pub(crate) struct CompletionPlan {
    pub root_action: Option<GraphAction>,
    pub root_layer: LayerId,
    pub lease: Option<InteractionLease>,
    pub nodes: HashSet<NodeId>,
    pub edges: HashSet<EdgeId>,
    pub layers: HashSet<LayerId>,
    pub actions: HashSet<ActionId>,
    pub layer_actions: HashMap<LayerId, Vec<ActionId>>,
    arrivals: HashMap<LayerId, NavigateRelation>,
}

impl CompletionPlan {
    pub async fn build(
        connection: &mut GraphConnection,
        scope: &InteractionScope,
    ) -> Result<Self, GraphError> {
        let root_actions = ActionTable::new(&mut *connection)
            .for_source(scope, scope.root_node_id, Some(scope.root_node_id), false)
            .await?
            .into_iter()
            .map(|record| record.action)
            .collect::<Vec<_>>();
        if root_actions.len() != 1 {
            return Err(GraphError::validation(
                "root_action_count",
                "interactionNode",
                format!(
                    "The interaction needs exactly one new root action; found {}. Create one navigate action with relation=expand from the interaction.",
                    root_actions.len()
                ),
            ));
        }
        let root_action = root_actions[0].clone();
        if root_action.kind != ActionKind::Navigate
            || root_action.relation != Some(NavigateRelation::Expand)
            || root_action.source_layer_id.is_some()
        {
            return Err(GraphError::validation(
                "invalid_root_action",
                "interactionNode",
                "The single root action must be navigate with relation=expand and no sourceLayerId.",
            ));
        }
        let root_layer = root_action.target_layer_id.ok_or_else(|| {
            GraphError::validation(
                "missing_target_layer",
                "rootAction.targetLayerId",
                "The root expand action needs a submitted current-interaction draft layer.",
            )
        })?;
        let mut plan = Self {
            root_action: Some(root_action),
            root_layer,
            lease: None,
            nodes: HashSet::new(),
            edges: HashSet::new(),
            layers: HashSet::new(),
            actions: HashSet::new(),
            layer_actions: HashMap::new(),
            arrivals: HashMap::new(),
        };
        plan.actions
            .insert(plan.root_action.as_ref().expect("root action").id);
        plan.walk_layers(connection, scope, root_layer, NavigateRelation::Expand)
            .await?;
        plan.collect_attached(connection, scope).await?;
        plan.validate_expand_acyclic(connection, scope).await?;
        plan.validate_no_orphan_layers(connection, scope).await?;
        plan.validate_edge_uniqueness(connection, scope).await?;
        plan.lease = NodeTable::new(&mut *connection)
            .interaction_lease(scope.root_node_id)
            .await?;
        if let Some(lease) = plan.lease {
            ActionTable::new(&mut *connection)
                .validate_unresolved_lease(scope, lease.source_interaction_id, lease.action_id)
                .await?;
        }
        Ok(plan)
    }

    pub(crate) fn root_layer_id(&self) -> Result<LayerId, GraphError> {
        Ok(self.root_layer)
    }

    pub(crate) fn root_action(&self) -> Result<&GraphAction, GraphError> {
        self.root_action.as_ref().ok_or_else(|| {
            GraphError::Internal("terminal completion plan has no root action".into())
        })
    }

    pub(crate) async fn build_current(
        connection: &mut GraphConnection,
        scope: &InteractionScope,
        root_layer: LayerId,
    ) -> Result<Self, GraphError> {
        let mut plan = Self {
            root_action: None,
            root_layer,
            lease: None,
            nodes: HashSet::new(),
            edges: HashSet::new(),
            layers: HashSet::new(),
            actions: HashSet::new(),
            layer_actions: HashMap::new(),
            arrivals: HashMap::new(),
        };
        plan.walk_layers(connection, scope, root_layer, NavigateRelation::Expand)
            .await?;
        plan.validate_expand_acyclic(connection, scope).await?;
        plan.validate_edge_uniqueness(connection, scope).await?;
        Ok(plan)
    }

    pub(crate) async fn build_return(
        connection: &mut GraphConnection,
        scope: &InteractionScope,
        returned_layer: LayerId,
        persisted_current: Option<LayerId>,
    ) -> Result<Self, GraphError> {
        let record = LayerTable::new(&mut *connection)
            .record(scope, returned_layer)
            .await?
            .ok_or_else(|| GraphError::NotFound(format!("layer {returned_layer}")))?;
        if record.layer.state != RecordState::Accepted {
            let plan = Self::build(connection, scope).await?;
            if plan.root_layer != returned_layer {
                return Err(GraphError::validation(
                    "return_layer_mismatch",
                    "layerId",
                    "The returned layer must match the interaction root action target.",
                ));
            }
            return Ok(plan);
        }
        if record.owner != scope.root_node_id || persisted_current != Some(returned_layer) {
            return Err(GraphError::validation(
                "foreign_current",
                "layerId",
                "A completion may return only its own draft layer or its exact persisted current layer.",
            ));
        }
        let root_actions = ActionTable::new(&mut *connection)
            .for_source(scope, scope.root_node_id, Some(scope.root_node_id), false)
            .await?
            .into_iter()
            .map(|record| record.action)
            .collect::<Vec<_>>();
        if root_actions.len() != 1 {
            return Err(GraphError::validation(
                "root_action_count",
                "interactionNode",
                format!(
                    "The interaction needs exactly one root action; found {}.",
                    root_actions.len()
                ),
            ));
        }
        let root_action = root_actions[0].clone();
        if root_action.kind != ActionKind::Navigate
            || root_action.relation != Some(NavigateRelation::Expand)
            || root_action.source_layer_id.is_some()
            || root_action.target_layer_id != Some(returned_layer)
        {
            return Err(GraphError::validation(
                "invalid_root_action",
                "interactionNode",
                "The root action must expand to the exact returned current layer.",
            ));
        }
        let lease = NodeTable::new(&mut *connection)
            .interaction_lease(scope.root_node_id)
            .await?;
        if let Some(lease) = lease {
            ActionTable::new(&mut *connection)
                .validate_unresolved_lease(scope, lease.source_interaction_id, lease.action_id)
                .await?;
        }
        let mut actions = HashSet::new();
        actions.insert(root_action.id);
        let mut plan = Self {
            root_action: Some(root_action),
            root_layer: returned_layer,
            lease,
            nodes: HashSet::new(),
            edges: HashSet::new(),
            layers: HashSet::new(),
            actions,
            layer_actions: HashMap::new(),
            arrivals: HashMap::from([(returned_layer, NavigateRelation::Expand)]),
        };
        plan.collect_attached(connection, scope).await?;
        plan.validate_expand_acyclic(connection, scope).await?;
        plan.validate_edge_uniqueness(connection, scope).await?;
        plan.validate_no_orphan_layers(connection, scope).await?;
        Ok(plan)
    }

    async fn collect_attached(
        &mut self,
        connection: &mut GraphConnection,
        scope: &InteractionScope,
    ) -> Result<(), GraphError> {
        let mut missing = crate::storage::sqlite::permissions::read(connection, scope.root_node_id)
            .await?
            .map(|snapshot| snapshot.required_response_sources())
            .unwrap_or_default();
        let ids =
            crate::storage::sqlite::attached_navigation::draft_actions(connection, scope).await?;
        for id in ids {
            let id = ActionId::new(id)
                .ok_or_else(|| GraphError::Internal("Invalid attached action.".into()))?;
            let action = ActionTable::new(&mut *connection)
                .record(scope, id)
                .await?
                .ok_or_else(|| GraphError::Internal("Missing attached action.".into()))?
                .action;
            crate::storage::sqlite::permissions::authorize(
                connection,
                scope,
                &crate::InteractionPermission::NavigateAdd {
                    node_id: action.source_node_id,
                },
            )
            .await?;
            let target = action
                .target_layer_id
                .ok_or_else(|| GraphError::Internal("Missing attached target.".into()))?;
            if target == self.root_layer {
                missing.retain(|node| *node != action.source_node_id);
            }
            let layer = LayerTable::new(&mut *connection)
                .visible(scope, target)
                .await?;
            let relation = action
                .relation
                .ok_or_else(|| GraphError::Internal("Missing attached relation.".into()))?;
            // The response root already has its independent expansion-authoring role.
            // An attached backlink exposes that response without reclassifying it as a
            // reference-authored layer. Ordinary non-root arrivals still share checks.
            if target == self.root_layer && relation == NavigateRelation::Reference {
                self.actions.insert(id);
                continue;
            }
            register_arrival(&mut self.arrivals, target, relation)?;
            if layer.state != RecordState::Accepted {
                self.walk_layers(connection, scope, target, relation)
                    .await?;
            }
            self.actions.insert(id);
        }
        if !missing.is_empty() {
            return Err(GraphError::validation(
                "attached_response_navigation_required",
                "interaction.context",
                format!(
                    "Add a new navigate action from each attached node [{}] to this interaction's response layer {}. Expose each addition through a usable control; preserve and rebind existing rich controls in a full presentation replacement. Repair the drafts and retry terminal submission.",
                    missing
                        .iter()
                        .map(ToString::to_string)
                        .collect::<Vec<_>>()
                        .join(", "),
                    self.root_layer
                ),
            ));
        }
        super::super::attached_navigation::validate(connection, scope).await?;
        Ok(())
    }

    async fn validate_edge_uniqueness(
        &self,
        connection: &mut GraphConnection,
        scope: &InteractionScope,
    ) -> Result<(), GraphError> {
        for edge_id in &self.edges {
            let edge = EdgeTable::new(&mut *connection)
                .visible(scope, *edge_id)
                .await?;
            if let Some(existing) = EdgeTable::new(&mut *connection)
                .accepted_duplicate(scope, edge.id, edge.endpoints)
                .await?
            {
                return Err(GraphError::validation(
                    "duplicate_edge",
                    "edges",
                    format!(
                        "Nodes {} and {} are already connected by accepted edge {existing}. Reuse that edge instead of accepting edge {}.",
                        edge.endpoints[0], edge.endpoints[1], edge.id
                    ),
                ));
            }
        }
        Ok(())
    }

    async fn walk_layers(
        &mut self,
        connection: &mut GraphConnection,
        scope: &InteractionScope,
        root: LayerId,
        relation: NavigateRelation,
    ) -> Result<(), GraphError> {
        let mut pending = VecDeque::from([(root, relation)]);
        while let Some((layer_id, arrival)) = pending.pop_front() {
            register_arrival(&mut self.arrivals, layer_id, arrival)?;
            let record = LayerTable::new(&mut *connection)
                .record(scope, layer_id)
                .await?
                .ok_or_else(|| {
                    GraphError::validation(
                        "missing_layer",
                        "targetLayerId",
                        format!(
                            "A navigate action points to missing layer {layer_id}. Submit that layer first."
                        ),
                    )
                })?;
            if record.layer.state == RecordState::Accepted {
                if arrival != NavigateRelation::Reference {
                    return Err(GraphError::validation(
                        "expand_target_must_be_current_draft",
                        "targetLayerId",
                        format!(
                            "Expand points to accepted layer {layer_id}. Use relation=reference for accepted context, or create a current draft expansion layer."
                        ),
                    ));
                }
                continue;
            }
            if record.layer.state == RecordState::Stopped {
                return Err(GraphError::validation(
                    "discarded_layer_target",
                    "targetLayerId",
                    format!(
                        "A navigate action points to discarded layer {layer_id}. Retarget that action to a current draft or visible accepted layer."
                    ),
                ));
            }
            if record.owner != scope.root_node_id {
                return Err(GraphError::Forbidden(format!(
                    "draft layer {layer_id} belongs to another interaction"
                )));
            }
            // The answer opens on a graph; an artifact is opened from a node in it (PRD 6.6.1).
            if layer_id == self.root_layer && record.layer.renderer.is_some() {
                return Err(GraphError::validation(
                    "artifact_layer_as_response",
                    "rootAction.targetLayerId",
                    "The answer's root layer must be a graph. Put an ordinary node in it and open the artifact layer from that node with a navigate action.",
                ));
            }
            validate_authored_layout(
                record.layer.layout.as_ref(),
                &record.layer.nodes,
                &record.layer.edges,
            )?;
            if !self.layers.insert(layer_id) {
                continue;
            }

            let resolved = layers::resolve(&mut *connection, scope, layer_id, false).await?;
            // A node may be resubmitted after its layer: re-check the renderer rule.
            crate::artifact::validate_layer_renderer(
                record.layer.renderer.as_deref(),
                &resolved.nodes,
                resolved.edges.len(),
            )?;
            validate_connected(&record.layer.nodes, &resolved.edges)?;
            if let Some(layout) = &record.layer.layout {
                validate_edge_route_ends(layout, &resolved.edges)?;
            }
            let node_ids = resolved
                .nodes
                .iter()
                .map(|node| node.id)
                .collect::<HashSet<_>>();
            for edge in &resolved.edges {
                if !node_ids.contains(&edge.endpoints[0]) || !node_ids.contains(&edge.endpoints[1])
                {
                    return Err(GraphError::validation(
                        "edge_outside_layer",
                        format!("layer[{layer_id}].edges"),
                        format!("Edge {} does not stay within this layer.", edge.id),
                    ));
                }
                self.edges.insert(edge.id);
            }
            for node in resolved.nodes {
                if node.state == RecordState::Draft {
                    let owner = NodeTable::new(&mut *connection)
                        .record(node.id)
                        .await?
                        .and_then(|record| record.owner);
                    if owner != Some(scope.root_node_id) {
                        return Err(GraphError::Forbidden(format!(
                            "node {} belongs to another interaction",
                            node.id
                        )));
                    }
                }
                self.nodes.insert(node.id);
            }

            self.layer_actions.insert(
                layer_id,
                resolved.actions.iter().map(|action| action.id).collect(),
            );
            let current_actions = ActionTable::new(&mut *connection)
                .for_source_layer(scope, layer_id)
                .await?;
            for record in current_actions {
                let action = record.action;
                if !node_ids.contains(&action.source_node_id) {
                    return Err(GraphError::validation(
                        "source_node_outside_layer",
                        format!("action[{}].sourceNodeId", action.id),
                        format!(
                            "Action {} claims source layer {layer_id}, but source node {} is not in that layer. Choose a containing source layer.",
                            action.id, action.source_node_id
                        ),
                    ));
                }
                if arrival == NavigateRelation::Reference
                    && (action.kind != ActionKind::Navigate
                        || action.relation != Some(NavigateRelation::Reference))
                {
                    return Err(GraphError::validation(
                        "reference_layer_authoring_restricted",
                        format!("action[{}].relation", action.id),
                        "A reference layer may author only reference navigation. Change this action to reference, or author it from an expansion layer.",
                    ));
                }
                self.actions.insert(action.id);
                if action.kind != ActionKind::Navigate {
                    continue;
                }
                let relation = action.relation.ok_or_else(|| {
                    GraphError::validation(
                        "missing_navigate_relation",
                        format!("action[{}].relation", action.id),
                        "Choose relation=expand for deeper explanation or relation=reference for supporting evidence or context.",
                    )
                })?;
                let target = action.target_layer_id.ok_or_else(|| {
                    GraphError::validation(
                        "missing_target_layer",
                        format!("action[{}].targetLayerId", action.id),
                        "Submit or select the navigate target layer and retry.",
                    )
                })?;
                register_arrival(&mut self.arrivals, target, relation)?;
                pending.push_back((target, relation));
            }
        }
        Ok(())
    }

    async fn validate_expand_acyclic(
        &self,
        connection: &mut GraphConnection,
        scope: &InteractionScope,
    ) -> Result<(), GraphError> {
        let mut adjacency = HashMap::<LayerId, Vec<LayerId>>::new();
        for layer_id in &self.layers {
            for record in ActionTable::new(&mut *connection)
                .for_source_layer(scope, *layer_id)
                .await?
            {
                let action = record.action;
                if action.kind == ActionKind::Navigate
                    && action.relation == Some(NavigateRelation::Expand)
                {
                    let target = action.target_layer_id.ok_or_else(|| {
                        GraphError::Internal("validated expand action has no target".into())
                    })?;
                    adjacency.entry(*layer_id).or_default().push(target);
                }
            }
        }
        if let Some(cycle) = find_cycle(&adjacency) {
            return Err(GraphError::validation(
                "expand_cycle",
                "actions",
                format!(
                    "Expand navigation must be acyclic. This expand path repeats a layer: {}. Change one link to reference or remove it.",
                    cycle
                        .iter()
                        .map(ToString::to_string)
                        .collect::<Vec<_>>()
                        .join(" -> ")
                ),
            ));
        }
        Ok(())
    }

    async fn validate_no_orphan_layers(
        &self,
        connection: &mut GraphConnection,
        scope: &InteractionScope,
    ) -> Result<(), GraphError> {
        let orphaned = LayerTable::new(connection)
            .draft_ids_by_owner(scope.root_node_id)
            .await?
            .into_iter()
            .filter(|layer_id| !self.layers.contains(layer_id))
            .collect::<Vec<_>>();
        if orphaned.is_empty() {
            return Ok(());
        }
        Err(GraphError::validation(
            "orphan_draft_layers",
            "layers",
            format!(
                "Current draft layers are not reachable from the root action: {}. Connect each intended layer with a current expand or reference action, or explicitly discard each intentionally abandoned layer with the client API (discardLayer in TypeScript; discard_layer in Python).",
                orphaned
                    .iter()
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        ))
    }
}

fn register_arrival(
    arrivals: &mut HashMap<LayerId, NavigateRelation>,
    layer_id: LayerId,
    relation: NavigateRelation,
) -> Result<(), GraphError> {
    if let Some(existing) = arrivals.insert(layer_id, relation)
        && existing != relation
    {
        return Err(GraphError::validation(
            "mixed_target_relations",
            "targetLayerId",
            format!(
                "Layer {layer_id} is targeted as both expand and reference in this interaction. Use one relation for that target layer."
            ),
        ));
    }
    Ok(())
}

fn find_cycle(adjacency: &HashMap<LayerId, Vec<LayerId>>) -> Option<Vec<LayerId>> {
    fn visit(
        layer: LayerId,
        adjacency: &HashMap<LayerId, Vec<LayerId>>,
        visiting: &mut HashSet<LayerId>,
        visited: &mut HashSet<LayerId>,
        path: &mut Vec<LayerId>,
    ) -> Option<Vec<LayerId>> {
        if visiting.contains(&layer) {
            let start = path.iter().position(|candidate| *candidate == layer)?;
            return Some(path[start..].iter().copied().chain([layer]).collect());
        }
        if !visited.insert(layer) {
            return None;
        }
        visiting.insert(layer);
        path.push(layer);
        for target in adjacency.get(&layer).into_iter().flatten() {
            if let Some(cycle) = visit(*target, adjacency, visiting, visited, path) {
                return Some(cycle);
            }
        }
        path.pop();
        visiting.remove(&layer);
        None
    }

    let mut visiting = HashSet::new();
    let mut visited = HashSet::new();
    let mut path = Vec::new();
    for layer in adjacency.keys().copied() {
        if let Some(cycle) = visit(layer, adjacency, &mut visiting, &mut visited, &mut path) {
            return Some(cycle);
        }
    }
    None
}
