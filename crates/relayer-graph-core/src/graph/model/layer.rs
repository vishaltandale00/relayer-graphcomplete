use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::{
    EdgeId, GraphAction, GraphEdge, GraphError, GraphNode, LayerId, NodeId, RecordState,
    ValidationIssue,
};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphLayer {
    pub id: LayerId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_key: Option<String>,
    pub nodes: Vec<NodeId>,
    pub edges: Vec<EdgeId>,
    #[serde(default)]
    pub layout: Option<LayerLayout>,
    pub state: RecordState,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerLayout {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub placements: Vec<NodePlacement>,
}

impl LayerLayout {
    pub fn v1(placements: Vec<NodePlacement>) -> Self {
        Self {
            version: 1,
            placements,
        }
    }

    pub fn placements(&self) -> &[NodePlacement] {
        &self.placements
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodePlacement {
    pub node_id: NodeId,
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
    pub layout: Option<LayerLayout>,
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
        if let Err(GraphError::ValidationIssues {
            issues: layout_issues,
            ..
        }) = validate_authored_layout(self.layout.as_ref(), &self.nodes)
        {
            issues.extend(layout_issues);
        }
        if (6..=8).contains(&self.nodes.len()) {
            let justification = self
                .size_justification
                .as_deref()
                .map(str::trim)
                .unwrap_or("");
            let justification_length = justification.chars().count();
            if justification_length < 20 {
                issues.push(ValidationIssue::new(
                    "large_layer_justification_required",
                    "sizeJustification",
                    format!(
                        "This layer has {} nodes. Layers with 6 to 8 nodes need a private justification of at least 20 characters explaining why one larger layer is clearer. Resubmit with sizeJustification; do not copy it into user-visible content.",
                        self.nodes.len()
                    ),
                ));
            } else if justification_length > 500 {
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

pub(crate) fn validate_authored_layout(
    layout: Option<&LayerLayout>,
    nodes: &[NodeId],
) -> Result<(), GraphError> {
    let mut issues = Vec::new();
    match layout {
        None => issues.push(ValidationIssue::new(
            "missing_layer_layout",
            "layout",
            "Provide a versioned layout with exactly one normalized placement for every layer node.",
        )),
        Some(layout) => validate_layout(layout, nodes, &mut issues),
    }
    if issues.is_empty() {
        Ok(())
    } else {
        Err(GraphError::validation_issues(issues))
    }
}

fn validate_layout(layout: &LayerLayout, nodes: &[NodeId], issues: &mut Vec<ValidationIssue>) {
    if layout.version != 1 {
        issues.push(ValidationIssue::new(
            "unsupported_layout_version",
            "layout.version",
            format!(
                "Layout version {} is not supported. Submit version 1 normalized placements.",
                layout.version
            ),
        ));
    }
    let placements = layout.placements();
    let node_ids: HashSet<_> = nodes.iter().copied().collect();
    let mut placed = HashSet::new();
    for (index, placement) in placements.iter().enumerate() {
        if !node_ids.contains(&placement.node_id) {
            issues.push(ValidationIssue::new(
                "layout_node_outside_layer",
                format!("layout.placements[{index}].nodeId"),
                format!(
                    "Node {} is not in this layer. Remove its placement or include the node in the layer.",
                    placement.node_id
                ),
            ));
        }
        if !placed.insert(placement.node_id) {
            issues.push(ValidationIssue::new(
                "duplicate_layout_placement",
                format!("layout.placements[{index}].nodeId"),
                format!(
                    "Node {} already has a placement. Keep exactly one placement per layer node.",
                    placement.node_id
                ),
            ));
        }
        validate_coordinate(placement.x, index, "x", issues);
        validate_coordinate(placement.y, index, "y", issues);
    }
    for (index, node_id) in nodes.iter().enumerate() {
        if !placed.contains(node_id) {
            issues.push(ValidationIssue::new(
                "missing_layout_placement",
                "layout.placements",
                format!(
                    "Layer node {index} ({node_id}) has no layout placement. Add exactly one normalized placement for it."
                ),
            ));
        }
    }
}

fn validate_coordinate(
    coordinate: f64,
    placement_index: usize,
    field: &str,
    issues: &mut Vec<ValidationIssue>,
) {
    if !coordinate.is_finite() {
        issues.push(ValidationIssue::new(
            "non_finite_layout_coordinate",
            format!("layout.placements[{placement_index}].{field}"),
            "Use a finite normalized coordinate from 0 through 1.",
        ));
    } else if !(0.0..=1.0).contains(&coordinate) {
        issues.push(ValidationIssue::new(
            "layout_coordinate_out_of_range",
            format!("layout.placements[{placement_index}].{field}"),
            "Use a normalized coordinate in the inclusive range 0 through 1.",
        ));
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
