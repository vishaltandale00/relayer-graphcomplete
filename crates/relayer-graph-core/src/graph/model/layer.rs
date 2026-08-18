use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::{EdgeId, GraphAction, GraphEdge, GraphError, GraphNode, LayerId, NodeId, RecordState};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphLayer {
    pub id: LayerId,
    pub nodes: Vec<NodeId>,
    pub edges: Vec<EdgeId>,
    pub state: RecordState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedLayer {
    pub layer: GraphLayer,
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub actions: Vec<GraphAction>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerDraft {
    pub client_key: String,
    pub nodes: Vec<NodeId>,
    pub edges: Vec<EdgeId>,
}

pub(crate) struct LayerCandidate<'draft> {
    pub draft: &'draft LayerDraft,
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

impl LayerCandidate<'_> {
    pub(crate) fn validate(&self) -> Result<(), GraphError> {
        self.draft.validate_shape()?;
        let node_ids: HashSet<_> = self.nodes.iter().map(|node| node.id).collect();
        for edge in &self.edges {
            if !node_ids.contains(&edge.endpoints[0]) || !node_ids.contains(&edge.endpoints[1]) {
                return Err(GraphError::validation(
                    "edge_outside_layer",
                    "edges",
                    format!(
                        "Edge {} connects a node outside this layer. Include both endpoints or remove the edge.",
                        edge.id
                    ),
                ));
            }
        }
        validate_connected(&self.draft.nodes, &self.edges)
    }
}

impl LayerDraft {
    fn validate_shape(&self) -> Result<(), GraphError> {
        super::require_nonempty(&self.client_key, "clientKey")?;
        if !(1..=8).contains(&self.nodes.len()) {
            return Err(GraphError::validation(
                "layer_node_count",
                "nodes",
                format!(
                    "A visible layer needs 1 to 8 nodes; received {}.",
                    self.nodes.len()
                ),
            ));
        }
        if self.nodes.iter().collect::<HashSet<_>>().len() != self.nodes.len() {
            return Err(GraphError::validation(
                "duplicate_layer_node",
                "nodes",
                "A node may appear only once in a layer.",
            ));
        }
        if self.edges.iter().collect::<HashSet<_>>().len() != self.edges.len() {
            return Err(GraphError::validation(
                "duplicate_layer_edge",
                "edges",
                "An edge may appear only once in a layer.",
            ));
        }
        Ok(())
    }
}

pub(crate) fn validate_connected(nodes: &[NodeId], edges: &[GraphEdge]) -> Result<(), GraphError> {
    if nodes.len() <= 1 {
        return Ok(());
    }
    let mut adjacency: HashMap<NodeId, Vec<NodeId>> =
        nodes.iter().map(|id| (*id, Vec::new())).collect();
    for edge in edges {
        if let Some(items) = adjacency.get_mut(&edge.endpoints[0]) {
            items.push(edge.endpoints[1]);
        }
        if let Some(items) = adjacency.get_mut(&edge.endpoints[1]) {
            items.push(edge.endpoints[0]);
        }
    }
    let mut visited = HashSet::new();
    let mut pending = vec![nodes[0]];
    while let Some(id) = pending.pop() {
        if visited.insert(id) {
            pending.extend(adjacency.get(&id).into_iter().flatten().copied());
        }
    }
    if visited.len() == nodes.len() {
        return Ok(());
    }
    Err(GraphError::validation(
        "disconnected_layer",
        "edges",
        format!(
            "The layer is disconnected: {}/{} nodes are reachable. Add edges that connect every visible node.",
            visited.len(),
            nodes.len()
        ),
    ))
}
