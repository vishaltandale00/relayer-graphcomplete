use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::{
    EdgeId, GraphAction, GraphEdge, GraphError, GraphNode, LayerId, NodeId, RecordState,
    ValidationIssue,
};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphLayer {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_node_id: Option<NodeId>,
    pub id: LayerId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_key: Option<String>,
    pub nodes: Vec<NodeId>,
    pub edges: Vec<EdgeId>,
    #[serde(default)]
    pub layout: Option<LayerLayout>,
    /// Which renderer reads this layer. Absent means the graph; `artifact` means
    /// the artifact viewer reads its single node (PRD 11.11).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub renderer: Option<String>,
    pub state: RecordState,
}

/// How a layer draws all its edges. `default` leaves the shape to the design.
pub const EDGE_SHAPES: &[&str] = &[
    "default",
    "straight",
    "arc-outward",
    "arc-circle",
    "elbow-horizontal",
    "elbow-vertical",
];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerLayout {
    #[serde(default)]
    pub version: u32,
    /// List order is the layer's reading order.
    #[serde(default)]
    pub placements: Vec<NodePlacement>,
    /// Required on submit. Absent only on layers written before edge shapes; readers treat it as "default".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edge_shape: Option<String>,
    /// Optional per-edge overrides; edges without a route draw in the layer's shape.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub edge_routes: Vec<EdgeRoute>,
}

/// The side of a node where an edge attaches.
pub const NODE_SIDES: &[&str] = &["top", "right", "bottom", "left"];

/// The most waypoints one edge route may pass through.
pub const MAX_EDGE_ROUTE_WAYPOINTS: usize = 4;

/// One edge's own shape, attachment sides and waypoints. Waypoints are listed from
/// `ends[0]` to `ends[1]`; that order is not a direction and nothing draws one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeRoute {
    pub edge_id: EdgeId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shape: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ends: Vec<EdgeEnd>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub waypoints: Vec<LayoutPoint>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeEnd {
    pub node_id: NodeId,
    /// Absent means the renderer chooses where the edge meets the node.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub side: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct LayoutPoint {
    pub x: f64,
    pub y: f64,
}

impl LayerLayout {
    pub fn v1(placements: Vec<NodePlacement>, edge_shape: &str) -> Self {
        Self {
            version: 1,
            placements,
            edge_shape: Some(edge_shape.into()),
            edge_routes: Vec::new(),
        }
    }

    pub fn with_edge_routes(mut self, edge_routes: Vec<EdgeRoute>) -> Self {
        self.edge_routes = edge_routes;
        self
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_node_id: Option<NodeId>,
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
        if let Some(layout) = &self.draft.layout {
            validate_edge_route_ends(layout, &self.edges)?;
        }
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
        if self
            .default_node_id
            .is_some_and(|id| !self.nodes.contains(&id))
        {
            issues.push(ValidationIssue::new(
                "default_node_outside_layer",
                "defaultNodeId",
                "Choose the initial detail node from this layer's member nodes.",
            ));
        }
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
        }) = validate_authored_layout(self.layout.as_ref(), &self.nodes, &self.edges)
        {
            issues.extend(layout_issues);
        }
        if self
            .layout
            .as_ref()
            .is_some_and(|layout| layout.edge_shape.is_none())
        {
            issues.push(ValidationIssue::new(
                "missing_edge_shape",
                "layout.edgeShape",
                format!(
                    "Choose how this layer draws its edges: one of {}. Use \"default\" when no shape fits the structure better.",
                    EDGE_SHAPES.join(", ")
                ),
            ));
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
    edges: &[EdgeId],
) -> Result<(), GraphError> {
    let mut issues = Vec::new();
    match layout {
        None => issues.push(ValidationIssue::new(
            "missing_layer_layout",
            "layout",
            "Provide a versioned layout with exactly one normalized placement for every layer node.",
        )),
        Some(layout) => validate_layout(layout, nodes, edges, &mut issues),
    }
    if issues.is_empty() {
        Ok(())
    } else {
        Err(GraphError::validation_issues(issues))
    }
}

fn validate_layout(
    layout: &LayerLayout,
    nodes: &[NodeId],
    edges: &[EdgeId],
    issues: &mut Vec<ValidationIssue>,
) {
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
        let path = format!("layout.placements[{index}]");
        validate_coordinate(placement.x, &path, "x", issues);
        validate_coordinate(placement.y, &path, "y", issues);
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
    if let Some(shape) = &layout.edge_shape
        && !EDGE_SHAPES.contains(&shape.as_str())
    {
        issues.push(ValidationIssue::new(
            "unsupported_edge_shape",
            "layout.edgeShape",
            format!(
                "Edge shape {shape:?} is not supported. Choose one of: {}.",
                EDGE_SHAPES.join(", ")
            ),
        ));
    }
    validate_edge_routes(layout, nodes, edges, issues);
}

fn validate_edge_routes(
    layout: &LayerLayout,
    nodes: &[NodeId],
    edges: &[EdgeId],
    issues: &mut Vec<ValidationIssue>,
) {
    let mut routed = HashSet::new();
    for (index, route) in layout.edge_routes.iter().enumerate() {
        let path = format!("layout.edgeRoutes[{index}]");
        if !edges.contains(&route.edge_id) {
            issues.push(ValidationIssue::new(
                "edge_route_outside_layer",
                format!("{path}.edgeId"),
                format!(
                    "Edge {} is not in this layer. Route only this layer's edges.",
                    route.edge_id
                ),
            ));
        }
        if !routed.insert(route.edge_id) {
            issues.push(ValidationIssue::new(
                "duplicate_edge_route",
                format!("{path}.edgeId"),
                format!(
                    "Edge {} already has a route. Give each edge at most one route.",
                    route.edge_id
                ),
            ));
        }
        if let Some(shape) = &route.shape
            && !EDGE_SHAPES.contains(&shape.as_str())
        {
            issues.push(ValidationIssue::new(
                "unsupported_edge_shape",
                format!("{path}.shape"),
                format!(
                    "Edge shape {shape:?} is not supported. Choose one of: {}.",
                    EDGE_SHAPES.join(", ")
                ),
            ));
        }
        if !route.ends.is_empty()
            && (route.ends.len() != 2
                || route.ends[0].node_id == route.ends[1].node_id
                || route.ends.iter().any(|end| !nodes.contains(&end.node_id)))
        {
            issues.push(ValidationIssue::new(
                "edge_route_ends_mismatch",
                format!("{path}.ends"),
                "List exactly the edge's two nodes as its ends.",
            ));
        }
        for (end_index, end) in route.ends.iter().enumerate() {
            if let Some(side) = &end.side
                && !NODE_SIDES.contains(&side.as_str())
            {
                issues.push(ValidationIssue::new(
                    "unsupported_node_side",
                    format!("{path}.ends[{end_index}].side"),
                    format!(
                        "Side {side:?} is not supported. Choose one of: {}, or omit it.",
                        NODE_SIDES.join(", ")
                    ),
                ));
            }
        }
        if !route.waypoints.is_empty() && route.ends.is_empty() {
            issues.push(ValidationIssue::new(
                "edge_route_ends_required",
                format!("{path}.ends"),
                "Waypoints are listed from one end to the other. Name the edge's two nodes as ends.",
            ));
        }
        if route.waypoints.len() > MAX_EDGE_ROUTE_WAYPOINTS {
            issues.push(ValidationIssue::new(
                "too_many_waypoints",
                format!("{path}.waypoints"),
                format!(
                    "An edge may pass through at most {MAX_EDGE_ROUTE_WAYPOINTS} waypoints; received {}.",
                    route.waypoints.len()
                ),
            ));
        }
        for (point_index, point) in route.waypoints.iter().enumerate() {
            let point_path = format!("{path}.waypoints[{point_index}]");
            validate_coordinate(point.x, &point_path, "x", issues);
            validate_coordinate(point.y, &point_path, "y", issues);
        }
    }
}

/// A route's ends must be the two nodes its edge joins. Checked wherever the edges'
/// endpoints are at hand: submit, acceptance and import.
pub(crate) fn validate_edge_route_ends(
    layout: &LayerLayout,
    edges: &[GraphEdge],
) -> Result<(), GraphError> {
    let issues = layout
        .edge_routes
        .iter()
        .enumerate()
        .filter(|(_, route)| route.ends.len() == 2)
        .filter_map(|(index, route)| {
            let edge = edges.iter().find(|edge| edge.id == route.edge_id)?;
            let mut ends = [route.ends[0].node_id, route.ends[1].node_id];
            let mut endpoints = edge.endpoints;
            ends.sort_unstable();
            endpoints.sort_unstable();
            (ends != endpoints).then(|| {
                ValidationIssue::new(
                    "edge_route_ends_mismatch",
                    format!("layout.edgeRoutes[{index}].ends"),
                    format!(
                        "Edge {} joins nodes {} and {}. List exactly those two nodes as its ends.",
                        edge.id, edge.endpoints[0], edge.endpoints[1]
                    ),
                )
            })
        })
        .collect::<Vec<_>>();
    if issues.is_empty() {
        Ok(())
    } else {
        Err(GraphError::validation_issues(issues))
    }
}

fn validate_coordinate(
    coordinate: f64,
    path: &str,
    field: &str,
    issues: &mut Vec<ValidationIssue>,
) {
    if !coordinate.is_finite() {
        issues.push(ValidationIssue::new(
            "non_finite_layout_coordinate",
            format!("{path}.{field}"),
            "Use a finite normalized coordinate from 0 through 1.",
        ));
    } else if !(0.0..=1.0).contains(&coordinate) {
        issues.push(ValidationIssue::new(
            "layout_coordinate_out_of_range",
            format!("{path}.{field}"),
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
