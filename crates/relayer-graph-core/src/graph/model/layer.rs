use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::{
    EdgeId, GraphAction, GraphEdge, GraphError, GraphNode, LayerId, NodeId, RecordState,
    ValidationIssue,
};

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
    #[serde(default)]
    pub size_justification: Option<String>,
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
        let mut issues = Vec::new();
        if !(1..=8).contains(&self.nodes.len()) {
            issues.push(ValidationIssue::new(
                "layer_node_count",
                "nodes",
                format!(
                    "A visible layer needs 1 to 8 nodes; received {}. Split this material into smaller useful layers.",
                    self.nodes.len()
                ),
            ));
        }
        if self.nodes.iter().collect::<HashSet<_>>().len() != self.nodes.len() {
            issues.push(ValidationIssue::new(
                "duplicate_layer_node",
                "nodes",
                "A node may appear only once in a layer.",
            ));
        }
        if self.edges.iter().collect::<HashSet<_>>().len() != self.edges.len() {
            issues.push(ValidationIssue::new(
                "duplicate_layer_edge",
                "edges",
                "An edge may appear only once in a layer.",
            ));
        }
        if (6..=8).contains(&self.nodes.len()) {
            let justification = self
                .size_justification
                .as_deref()
                .map(str::trim)
                .unwrap_or("");
            if justification.len() < 20 {
                issues.push(ValidationIssue::new(
                    "large_layer_justification_required",
                    "sizeJustification",
                    format!(
                        "This layer has {} nodes. Layers with 6 to 8 nodes need a private justification of at least 20 characters explaining why one larger layer is clearer. Resubmit with sizeJustification; do not copy it into user-visible content.",
                        self.nodes.len()
                    ),
                ));
            } else if justification.len() > 500 {
                issues.push(ValidationIssue::new(
                    "large_layer_justification_too_long",
                    "sizeJustification",
                    "Keep the private layer-size justification to 500 characters or fewer and resubmit.",
                ));
            }
        }
        if !issues.is_empty() {
            return Err(GraphError::validation_issues(issues));
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
