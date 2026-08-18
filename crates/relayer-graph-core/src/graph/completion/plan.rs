use std::collections::{HashMap, HashSet, VecDeque};

use crate::{
    ActionId, ActionKind, EdgeId, GraphAction, GraphError, LayerId, NodeId, RecordState,
    graph::{InteractionScope, model::validate_connected},
    storage::{
        GraphConnection,
        sqlite::{
            actions::ActionTable, edges::EdgeTable, layers, layers::LayerTable, nodes::NodeTable,
        },
    },
};

pub(crate) struct CompletionPlan {
    pub root_action: GraphAction,
    pub nodes: HashSet<NodeId>,
    pub edges: HashSet<EdgeId>,
    pub layers: HashSet<LayerId>,
    pub actions: HashSet<ActionId>,
    pub layer_actions: HashMap<LayerId, Vec<ActionId>>,
}

impl CompletionPlan {
    pub async fn build(
        connection: &mut GraphConnection,
        scope: &InteractionScope,
    ) -> Result<Self, GraphError> {
        let response_actions = ActionTable::new(&mut *connection)
            .for_source(scope, scope.root_node_id, Some(scope.root_node_id), false)
            .await?
            .into_iter()
            .map(|record| record.action)
            .filter(|action| action.response && action.kind == ActionKind::Navigate)
            .collect::<Vec<_>>();
        if response_actions.len() != 1 {
            return Err(GraphError::validation(
                "response_action_count",
                "interactionNode",
                format!(
                    "The interaction node needs exactly one new response navigate action; found {}. Add one navigate action with response=true.",
                    response_actions.len()
                ),
            ));
        }
        let root_action = response_actions[0].clone();
        let root_layer = root_action
            .target_layer_id
            .ok_or_else(|| GraphError::Internal("response navigate action has no layer".into()))?;
        let mut plan = Self {
            root_action,
            nodes: HashSet::new(),
            edges: HashSet::new(),
            layers: HashSet::new(),
            actions: HashSet::new(),
            layer_actions: HashMap::new(),
        };
        plan.actions.insert(plan.root_action.id);
        plan.walk_layers(connection, scope, root_layer).await?;
        plan.validate_edge_uniqueness(connection, scope).await?;
        Ok(plan)
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
    ) -> Result<(), GraphError> {
        let mut pending = VecDeque::from([root]);
        while let Some(layer_id) = pending.pop_front() {
            if !self.layers.insert(layer_id) {
                continue;
            }
            let record = LayerTable::new(&mut *connection)
                .record(scope, layer_id)
                .await?
                .ok_or_else(|| {
                    GraphError::validation(
                        "missing_layer",
                        "targetLayerId",
                        format!(
                            "Navigate action points to missing layer {layer_id}. Submit that layer first."
                        ),
                    )
                })?;
            if record.layer.state != RecordState::Accepted && record.owner != scope.root_node_id {
                return Err(GraphError::Forbidden(format!(
                    "layer {layer_id} belongs to another interaction"
                )));
            }
            let snapshots_actions = record.layer.state == RecordState::Draft;
            let resolved = layers::resolve(&mut *connection, scope, layer_id, false).await?;
            validate_connected(&record.layer.nodes, &resolved.edges)?;
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
            if snapshots_actions {
                self.layer_actions.insert(
                    layer_id,
                    resolved.actions.iter().map(|action| action.id).collect(),
                );
            }
            for action in resolved.actions {
                if action.state == RecordState::Draft {
                    let owner = ActionTable::new(&mut *connection)
                        .record(scope, action.id)
                        .await?
                        .map(|record| record.owner);
                    if owner != Some(scope.root_node_id) {
                        return Err(GraphError::Forbidden(format!(
                            "action {} belongs to another interaction",
                            action.id
                        )));
                    }
                }
                self.actions.insert(action.id);
                if action.kind == ActionKind::Navigate {
                    pending.push_back(action.target_layer_id.ok_or_else(|| {
                        GraphError::Internal("navigate action has no target".into())
                    })?);
                }
            }
        }
        Ok(())
    }
}
