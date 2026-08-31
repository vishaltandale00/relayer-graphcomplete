use relayer_graph_core::{
    ActionDraft, ActionKind, CompletionOutput, EdgeDraft, GraphDatabase, GraphWriter, LayerDraft,
    LayerLayout, NavigateRelation, NodeDraft, NodeId, NodePlacement, ProjectId, ThreadId,
};
use serde::Serialize;
use sha2::{Digest, Sha256};

pub const CORPUS_VERSION: u32 = 1;
pub const DEFAULT_SEED: u64 = 0x5245_4c41_5945_5231;
pub const DEFAULT_SAMPLES: usize = 200;
pub const DEFAULT_WARMUPS: usize = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CorpusShape {
    Ordinary,
    Recursive,
    LegalStress,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CorpusCase {
    pub id: String,
    pub ordinal: usize,
    pub shape: CorpusShape,
    pub project_id: Option<i64>,
    pub thread_id: i64,
    pub layer_widths: Vec<usize>,
    pub detail_bytes: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CorpusCounts {
    pub nodes: usize,
    pub edges: usize,
    pub layers: usize,
    pub actions: usize,
}

pub struct PreparedCase {
    pub writer: GraphWriter,
    pub interaction_id: NodeId,
    pub counts: CorpusCounts,
}

pub fn cases(seed: u64, count: usize) -> Vec<CorpusCase> {
    (0..count).map(|ordinal| case(seed, ordinal)).collect()
}

pub fn manifest_sha256(seed: u64, count: usize) -> String {
    let bytes = serde_json::to_vec(&(CORPUS_VERSION, seed, cases(seed, count))).unwrap();
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn case(seed: u64, ordinal: usize) -> CorpusCase {
    let mixed = splitmix64(seed.wrapping_add(ordinal as u64));
    let bucket = mixed % 10;
    let (shape, layer_widths, detail_bytes) = match bucket {
        0 => (CorpusShape::LegalStress, vec![8, 8, 8, 8, 8], 2_048),
        1 | 2 => (CorpusShape::Recursive, vec![5, 4, 3], 512),
        _ => (CorpusShape::Ordinary, vec![3 + (mixed as usize % 3)], 128),
    };
    let project_id = (!ordinal.is_multiple_of(5)).then_some(7);
    let thread_id = if project_id.is_some() {
        41 + (ordinal % 8) as i64
    } else {
        10_000 + ordinal as i64
    };
    CorpusCase {
        id: format!("v{CORPUS_VERSION}-{seed:016x}-{ordinal:04}"),
        ordinal,
        shape,
        project_id,
        thread_id,
        layer_widths,
        detail_bytes,
    }
}

fn splitmix64(mut value: u64) -> u64 {
    value = value.wrapping_add(0x9e37_79b9_7f4a_7c15);
    value = (value ^ (value >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value = (value ^ (value >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^ (value >> 31)
}

pub async fn author_and_complete(
    database: &GraphDatabase,
    case: &CorpusCase,
) -> Result<(CompletionOutput, CorpusCounts), relayer_graph_core::GraphError> {
    let prepared = prepare_case(database, case).await?;
    let output = prepared.writer.complete(prepared.interaction_id).await?;
    Ok((output, prepared.counts))
}

pub async fn prepare_case(
    database: &GraphDatabase,
    case: &CorpusCase,
) -> Result<PreparedCase, relayer_graph_core::GraphError> {
    let project_id = case.project_id.and_then(ProjectId::new);
    let thread_id = ThreadId::new(case.thread_id).expect("corpus thread ids are positive");
    let interaction = database
        .create_interaction(
            project_id,
            thread_id,
            &format!("Corpus interaction {}", case.id),
        )
        .await?;
    let writer = database.writer_for_subgraph(interaction.id).await?;
    let mut layers = Vec::with_capacity(case.layer_widths.len());
    let mut layer_nodes = Vec::with_capacity(case.layer_widths.len());
    let mut edge_count = 0;

    for (layer_index, width) in case.layer_widths.iter().copied().enumerate() {
        let mut nodes = Vec::with_capacity(width);
        for node_index in 0..width {
            let detail_prefix = format!("{} layer {layer_index} node {node_index}: ", case.id);
            let padding = "x".repeat(case.detail_bytes.saturating_sub(detail_prefix.len()));
            nodes.push(
                writer
                    .submit_node(&NodeDraft {
                        client_key: format!("{}-l{layer_index}-n{node_index}", case.id),
                        kind: "concept".into(),
                        icon: "box".into(),
                        title: format!("Corpus {layer_index}.{node_index}"),
                        detail: format!("{detail_prefix}{padding}"),
                    })
                    .await?,
            );
        }
        let mut edges = Vec::with_capacity(width.saturating_sub(1));
        for node_index in 1..width {
            edges.push(
                writer
                    .create_edge(&EdgeDraft {
                        client_key: format!("{}-l{layer_index}-e{node_index}", case.id),
                        endpoints: [nodes[node_index - 1].id, nodes[node_index].id],
                    })
                    .await?,
            );
            edge_count += 1;
        }
        let placements = nodes
            .iter()
            .enumerate()
            .map(|(index, node)| NodePlacement {
                node_id: node.id,
                x: (index + 1) as f64 / (width + 1) as f64,
                y: 0.5,
            })
            .collect();
        let layer = writer
            .submit_layer(&LayerDraft {
                client_key: format!("{}-layer-{layer_index}", case.id),
                nodes: nodes.iter().map(|node| node.id).collect(),
                edges: edges.iter().map(|edge| edge.id).collect(),
                layout: Some(LayerLayout::v1(placements)),
                size_justification: (width >= 6).then(|| {
                    "The boundary corpus deliberately exercises the legal maximum width.".into()
                }),
            })
            .await?;
        layer_nodes.push(nodes);
        layers.push(layer);
    }

    for layer_index in 0..layers.len().saturating_sub(1) {
        writer
            .add_action(&ActionDraft {
                client_key: format!("{}-expand-{layer_index}", case.id),
                source_node_id: layer_nodes[layer_index][0].id,
                source_layer_id: Some(layers[layer_index].id),
                kind: ActionKind::Navigate,
                relation: Some(NavigateRelation::Expand),
                label: "Details".into(),
                variant: Default::default(),
                icon: None,
                description: None,
                target_layer_id: Some(layers[layer_index + 1].id),
                interaction_text: None,
            })
            .await?;
    }
    writer
        .add_action(&ActionDraft {
            client_key: format!("{}-response", case.id),
            source_node_id: interaction.id,
            source_layer_id: None,
            kind: ActionKind::Navigate,
            relation: Some(NavigateRelation::Expand),
            label: "Response".into(),
            variant: Default::default(),
            icon: None,
            description: None,
            target_layer_id: Some(layers[0].id),
            interaction_text: None,
        })
        .await?;

    Ok(PreparedCase {
        writer,
        interaction_id: interaction.id,
        counts: CorpusCounts {
            nodes: case.layer_widths.iter().sum::<usize>() + 1,
            edges: edge_count,
            layers: layers.len(),
            actions: layers.len(),
        },
    })
}
