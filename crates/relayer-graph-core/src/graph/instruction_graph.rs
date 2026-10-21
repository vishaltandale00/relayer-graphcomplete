//! Trusted, immutable instruction publications. Their scope is separate from task graphs.
use crate::query::QueryReadPermit;
use crate::{
    ActionDraft, EdgeDraft, GraphDatabase, GraphError, GraphNode, LayerDraft, LayerId, LayerLayout,
    NodeDraft, NodeId, NodePlacement, ResolvedLayer, SearchTarget, ThreadId,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

pub const INSTRUCTION_GRAPH_THREAD_MIN: i64 = 8_000_000_000_000_000;
pub const INSTRUCTION_GRAPH_THREAD_MAX: i64 = 8_999_999_999_999_999;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstructionModuleDefinition {
    pub key: String,
    pub title: String,
    pub detail: String,
    #[serde(default)]
    pub prerequisites: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstructionGraphDefinition {
    #[serde(
        default = "legacy_retrieval_contract",
        skip_serializing_if = "is_legacy_retrieval_contract"
    )]
    pub retrieval_contract_version: u32,
    pub digest: String,
    pub modules: Vec<InstructionModuleDefinition>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstructionModulePointer {
    pub key: String,
    pub title: String,
    pub node_id: NodeId,
    pub prerequisites: Vec<NodeId>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstructionGraphManifest {
    #[serde(
        default = "legacy_retrieval_contract",
        skip_serializing_if = "is_legacy_retrieval_contract"
    )]
    pub retrieval_contract_version: u32,
    pub version_key: String,
    pub digest: String,
    pub thread_id: ThreadId,
    pub interaction_node_id: NodeId,
    pub root_layer_id: LayerId,
    pub modules: Vec<InstructionModulePointer>,
}

fn legacy_retrieval_contract() -> u32 {
    1
}
fn is_legacy_retrieval_contract(value: &u32) -> bool {
    *value == 1
}

fn invalid(message: &str) -> GraphError {
    GraphError::validation("invalid_instruction_graph", "instructionGraph", message)
}

impl GraphDatabase {
    /// Materialize through ordinary authoring and acceptance, never a parallel store.
    /// Reservation survives interrupted materialization; stable keys make retry repair it.
    pub async fn ensure_instruction_graph(
        &self,
        version_key: &str,
        definition: InstructionGraphDefinition,
    ) -> Result<InstructionGraphManifest, GraphError> {
        if version_key.trim().is_empty()
            || version_key.len() > 160
            || definition.digest.len() != 64
            || !definition.digest.bytes().all(|c| c.is_ascii_hexdigit())
            || !(1..=64).contains(&definition.modules.len())
        {
            return Err(invalid(
                "A version key, hexadecimal SHA-256 digest, and 1 to 64 modules are required.",
            ));
        }
        if !matches!(definition.retrieval_contract_version, 1 | 2) {
            return Err(invalid(
                "The instruction retrieval contract must be 1 or 2.",
            ));
        }
        if definition.retrieval_contract_version == 2
            && definition
                .modules
                .iter()
                .any(|module| module.detail.len() > 2400)
        {
            return Err(invalid(
                "Instruction retrieval contract 2 requires modules of at most 2400 UTF-8 bytes.",
            ));
        }
        let modules_bytes = serde_json::to_vec(&definition.modules)
            .map_err(|e| GraphError::Internal(e.to_string()))?;
        if format!("{:x}", Sha256::digest(modules_bytes)) != definition.digest {
            return Err(invalid(
                "The supplied digest does not match the instruction modules.",
            ));
        }
        let keys: HashSet<_> = definition.modules.iter().map(|m| m.key.as_str()).collect();
        if keys.len() != definition.modules.len()
            || definition.modules.iter().any(|m| {
                m.key.trim().is_empty()
                    || m.title.trim().is_empty()
                    || m.detail.trim().is_empty()
                    || m.prerequisites
                        .iter()
                        .any(|key| !keys.contains(key.as_str()) || key == &m.key)
            })
        {
            return Err(invalid(
                "Module keys must be unique and nonempty; every prerequisite must name another module.",
            ));
        }
        let definition_json =
            serde_json::to_string(&definition).map_err(|e| GraphError::Internal(e.to_string()))?;
        let _guard = self
            .order_writes_to(SearchTarget::Thread(
                ThreadId::new(INSTRUCTION_GRAPH_THREAD_MAX).expect("positive reserved thread"),
            ))
            .await;
        let mut tx = self.storage.begin_write().await?;
        let existing=sqlx::query_as::<_,(String,i64,Option<String>)>("SELECT definition_json,thread_id,manifest_json FROM instruction_graph_versions WHERE version_key=?1").bind(version_key).fetch_optional(&mut *tx).await?;
        let thread_id = if let Some((stored, thread, manifest)) = existing {
            if stored != definition_json {
                return Err(GraphError::validation(
                    "instruction_graph_version_immutable",
                    "versionKey",
                    "An instruction version key cannot be republished with different content.",
                ));
            }
            if let Some(manifest) = manifest {
                return serde_json::from_str(&manifest)
                    .map_err(|e| GraphError::Internal(e.to_string()));
            }
            ThreadId::new(thread).ok_or_else(|| invalid("Invalid reserved thread."))?
        } else {
            let next:i64=sqlx::query_scalar("SELECT COALESCE(MAX(thread_id)+1,8000000000000000) FROM (SELECT thread_id FROM instruction_graph_versions UNION ALL SELECT thread_id FROM nodes WHERE thread_id BETWEEN 8000000000000000 AND 8999999999999999)").fetch_one(&mut *tx).await?;
            if next >= INSTRUCTION_GRAPH_THREAD_MAX {
                return Err(invalid("Instruction graph thread range exhausted."));
            }
            sqlx::query("INSERT INTO instruction_graph_versions(version_key,digest,definition_json,thread_id) VALUES (?1,?2,?3,?4)").bind(version_key).bind(&definition.digest).bind(&definition_json).bind(next).execute(&mut *tx).await?;
            ThreadId::new(next).expect("reserved positive thread")
        };
        tx.commit().await?;
        let interaction_text = format!("Instruction graph {version_key}");
        let input_digest = crate::interaction_input_digest(&interaction_text, &[])
            .map_err(|e| GraphError::Internal(e.to_string()))?;
        let (interaction, _) = self
            .create_identified_interaction_with_context_inner(
                None,
                thread_id,
                &interaction_text,
                &format!("relayer.instruction-graph:{version_key}"),
                &input_digest,
                &[],
            )
            .await?;
        let writer = self.writer_for_subgraph(interaction.id).await?;
        if let Some(closure) = self.accepted_graph_closure(interaction.id).await? {
            let accepted: HashMap<_, _> = closure
                .layers
                .iter()
                .flat_map(|l| &l.nodes)
                .filter_map(|n| n.client_key.as_deref().map(|key| (key, n.id)))
                .collect();
            let manifest = InstructionGraphManifest {
                retrieval_contract_version: definition.retrieval_contract_version,
                version_key: version_key.into(),
                digest: definition.digest,
                thread_id,
                interaction_node_id: interaction.id,
                root_layer_id: closure.root_layer_id,
                modules: definition
                    .modules
                    .iter()
                    .map(|m| {
                        Ok(InstructionModulePointer {
                            key: m.key.clone(),
                            title: m.title.clone(),
                            node_id: *accepted.get(m.key.as_str()).ok_or_else(|| {
                                invalid("Accepted instruction module is missing.")
                            })?,
                            prerequisites: m
                                .prerequisites
                                .iter()
                                .map(|key| {
                                    accepted
                                        .get(key.as_str())
                                        .copied()
                                        .ok_or_else(|| invalid("Accepted prerequisite is missing."))
                                })
                                .collect::<Result<Vec<_>, _>>()?,
                        })
                    })
                    .collect::<Result<Vec<_>, GraphError>>()?,
            };
            self.store_instruction_manifest(&manifest).await?;
            return Ok(manifest);
        }
        let mut nodes = Vec::new();
        for module in &definition.modules {
            nodes.push(
                writer
                    .submit_node(&NodeDraft {
                        client_key: module.key.clone(),
                        kind: "harness-instruction".into(),
                        icon: "book-open".into(),
                        title: module.title.clone(),
                        detail: module.detail.clone(),
                    })
                    .await?,
            );
        }
        let by_key: HashMap<_, _> = definition
            .modules
            .iter()
            .zip(&nodes)
            .map(|(m, n)| (m.key.as_str(), n.id))
            .collect();
        let mut layers = Vec::new();
        for (index, chunk) in nodes.chunks(5).enumerate() {
            let mut edges = Vec::new();
            let mut pairs = std::collections::BTreeSet::new();
            for pair in chunk.windows(2) {
                pairs.insert((pair[0].id, pair[1].id));
            }
            for module in &definition.modules {
                let node = by_key[module.key.as_str()];
                if !chunk.iter().any(|n| n.id == node) {
                    continue;
                }
                for key in &module.prerequisites {
                    let dep = by_key[key.as_str()];
                    if chunk.iter().any(|n| n.id == dep) {
                        pairs.insert(if node < dep { (node, dep) } else { (dep, node) });
                    }
                }
            }
            for (a, b) in pairs {
                edges.push(
                    writer
                        .create_edge(&EdgeDraft {
                            client_key: format!("edge-{}-{}", a.value(), b.value()),
                            endpoints: [a, b],
                        })
                        .await?
                        .id,
                );
            }
            let placements = chunk
                .iter()
                .enumerate()
                .map(|(i, n)| NodePlacement {
                    node_id: n.id,
                    x: 0.5,
                    y: (i + 1) as f64 / (chunk.len() + 1) as f64,
                })
                .collect();
            layers.push(
                writer
                    .submit_layer(&LayerDraft {
                        default_node_id: None,
                        client_key: format!("modules-{index}"),
                        nodes: chunk.iter().map(|n| n.id).collect(),
                        edges,
                        layout: Some(LayerLayout::v1(placements, "default")),
                        size_justification: None,
                    })
                    .await?,
            );
        }
        // A dependency spanning directory layers gets its own ordinary two-node
        // layer. This preserves a real searchable edge without widening a layer
        // or inventing directional graph-edge semantics.
        for (module_index, module) in definition.modules.iter().enumerate() {
            for (prerequisite_index, key) in module.prerequisites.iter().enumerate() {
                let dependency_index = definition
                    .modules
                    .iter()
                    .position(|m| &m.key == key)
                    .expect("validated prerequisite");
                if module_index / 5 == dependency_index / 5 {
                    continue;
                }
                let a = nodes[module_index].id;
                let b = nodes[dependency_index].id;
                let edge = writer
                    .create_edge(&EdgeDraft {
                        client_key: format!(
                            "prerequisite-edge-{module_index}-{prerequisite_index}"
                        ),
                        endpoints: [a, b],
                    })
                    .await?;
                let layer = writer
                    .submit_layer(&LayerDraft {
                        default_node_id: None,
                        client_key: format!(
                            "prerequisite-layer-{module_index}-{prerequisite_index}"
                        ),
                        nodes: vec![a, b],
                        edges: vec![edge.id],
                        layout: Some(LayerLayout::v1(
                            vec![
                                NodePlacement {
                                    node_id: a,
                                    x: 0.25,
                                    y: 0.5,
                                },
                                NodePlacement {
                                    node_id: b,
                                    x: 0.75,
                                    y: 0.5,
                                },
                            ],
                            "default",
                        )),
                        size_justification: None,
                    })
                    .await?;
                writer.add_action(&serde_json::from_value::<ActionDraft>(serde_json::json!({"clientKey":format!("prerequisite-{module_index}-{prerequisite_index}"),"sourceNodeId":a,"sourceLayerId":layers[module_index/5].id,"kind":"navigate","relation":"expand","label":format!("Prerequisite: {}",definition.modules[dependency_index].title),"targetLayerId":layer.id})).map_err(|e|GraphError::Internal(e.to_string()))?).await?;
            }
        }
        for index in 1..layers.len() {
            writer.add_action(&serde_json::from_value::<ActionDraft>(serde_json::json!({"clientKey":format!("next-{index}"),"sourceNodeId":nodes[(index-1)*5].id,"sourceLayerId":layers[index-1].id,"kind":"navigate","relation":"expand","label":"More instruction modules","targetLayerId":layers[index].id})).map_err(|e| GraphError::Internal(e.to_string()))?).await?;
        }
        writer.add_action(&serde_json::from_value::<ActionDraft>(serde_json::json!({"clientKey":"response","sourceNodeId":interaction.id,"kind":"navigate","relation":"expand","label":"Instruction modules","targetLayerId":layers[0].id})).map_err(|e| GraphError::Internal(e.to_string()))?).await?;
        writer.complete(interaction.id).await?;
        let manifest = InstructionGraphManifest {
            retrieval_contract_version: definition.retrieval_contract_version,
            version_key: version_key.into(),
            digest: definition.digest,
            thread_id,
            interaction_node_id: interaction.id,
            root_layer_id: layers[0].id,
            modules: definition
                .modules
                .iter()
                .zip(&nodes)
                .map(|(m, n)| InstructionModulePointer {
                    key: m.key.clone(),
                    title: m.title.clone(),
                    node_id: n.id,
                    prerequisites: m
                        .prerequisites
                        .iter()
                        .map(|key| by_key[key.as_str()])
                        .collect(),
                })
                .collect(),
        };
        self.store_instruction_manifest(&manifest).await?;
        Ok(manifest)
    }
    async fn store_instruction_manifest(
        &self,
        manifest: &InstructionGraphManifest,
    ) -> Result<(), GraphError> {
        let mut connection = self.storage.acquire().await?;
        sqlx::query("UPDATE instruction_graph_versions SET interaction_node_id=?2,manifest_json=?3 WHERE version_key=?1").bind(&manifest.version_key).bind(manifest.interaction_node_id.value()).bind(serde_json::to_string(manifest).map_err(|e| GraphError::Internal(e.to_string()))?).execute(&mut *connection).await?;
        Ok(())
    }

    pub async fn attach_instruction_graph(
        &self,
        interaction: NodeId,
        version_key: &str,
        digest: &str,
    ) -> Result<InstructionGraphManifest, GraphError> {
        let mut tx = self.storage.begin_write().await?;
        let manifest_json:Option<String>=sqlx::query_scalar("SELECT manifest_json FROM instruction_graph_versions WHERE version_key=?1 AND digest=?2 AND manifest_json IS NOT NULL").bind(version_key).bind(digest).fetch_optional(&mut *tx).await?;
        let manifest: InstructionGraphManifest =
            serde_json::from_str(&manifest_json.ok_or_else(|| {
                invalid("The requested exact instruction version is not published.")
            })?)
            .map_err(|e| GraphError::Internal(e.to_string()))?;
        let existing: Option<String> = sqlx::query_scalar(
            "SELECT version_key FROM instruction_graph_attachments WHERE interaction_node_id=?1",
        )
        .bind(interaction.value())
        .fetch_optional(&mut *tx)
        .await?;
        if let Some(existing) = existing {
            if existing != version_key {
                return Err(GraphError::validation(
                    "instruction_graph_already_attached",
                    "versionKey",
                    "The instruction graph attachment is immutable.",
                ));
            }
        } else {
            let active:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM nodes n JOIN completion_states s ON s.interaction_node_id=n.id WHERE n.id=?1 AND n.kind='user-interaction' AND n.thread_id<8000000000000000 AND s.lifecycle='active')").bind(interaction.value()).fetch_one(&mut *tx).await?;
            if !active {
                return Err(invalid(
                    "Only an active task completion can acquire an instruction graph.",
                ));
            }
            sqlx::query("INSERT INTO instruction_graph_attachments(interaction_node_id,version_key) VALUES (?1,?2)").bind(interaction.value()).bind(version_key).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        Ok(manifest)
    }

    pub async fn instruction_graph(
        &self,
        interaction: NodeId,
        epoch: u64,
    ) -> Result<InstructionGraphManifest, GraphError> {
        self.writer_for_completion_authority(interaction, epoch)
            .await?
            .require_active_authority()
            .await?;
        let mut conn = self.storage.acquire().await?;
        let json:Option<String>=sqlx::query_scalar("SELECT v.manifest_json FROM instruction_graph_attachments a JOIN instruction_graph_versions v ON v.version_key=a.version_key WHERE a.interaction_node_id=?1").bind(interaction.value()).fetch_optional(&mut *conn).await?;
        serde_json::from_str(
            &json.ok_or_else(|| GraphError::NotFound("instruction graph attachment".into()))?,
        )
        .map_err(|e| GraphError::Internal(e.to_string()))
    }
    pub async fn instruction_node(
        &self,
        interaction: NodeId,
        epoch: u64,
        node: NodeId,
    ) -> Result<GraphNode, GraphError> {
        let manifest = self.instruction_graph(interaction, epoch).await?;
        if manifest.retrieval_contract_version == 2 {
            return Err(GraphError::validation(
                "instruction_reason_required",
                "reason",
                "Use the reasoned instruction retrieve endpoint for retrieval contract 2.",
            ));
        }
        self.read_instruction_node(&manifest, node).await
    }
    async fn read_instruction_node(
        &self,
        manifest: &InstructionGraphManifest,
        node: NodeId,
    ) -> Result<GraphNode, GraphError> {
        if !manifest.modules.iter().any(|m| m.node_id == node) {
            return Err(GraphError::Forbidden(
                "Node is outside the pinned instruction graph.".into(),
            ));
        }
        self.writer_for_subgraph(manifest.interaction_node_id)
            .await?
            .get_node(node)
            .await
    }
    /// Trusted server retrieval adapter; each requested node is checked against the
    /// exact immutable pin before any body is returned to the adapter.
    pub async fn instruction_retrieval_nodes(
        &self,
        interaction: NodeId,
        epoch: u64,
        nodes: &[NodeId],
    ) -> Result<(InstructionGraphManifest, Vec<GraphNode>), GraphError> {
        let manifest = self.instruction_graph(interaction, epoch).await?;
        if manifest.retrieval_contract_version != 2 {
            return Err(invalid(
                "Reasoned retrieval requires instruction retrieval contract 2.",
            ));
        }
        let mut result = Vec::with_capacity(nodes.len());
        for node in nodes {
            result.push(self.read_instruction_node(&manifest, *node).await?);
        }
        self.writer_for_completion_authority(interaction, epoch)
            .await?
            .require_active_authority()
            .await?;
        Ok((manifest, result))
    }
    pub async fn instruction_layer(
        &self,
        interaction: NodeId,
        epoch: u64,
        layer: LayerId,
    ) -> Result<ResolvedLayer, GraphError> {
        let manifest = self.instruction_graph(interaction, epoch).await?;
        if manifest.retrieval_contract_version == 2 {
            return Err(GraphError::validation(
                "instruction_reason_required",
                "reason",
                "Bulk instruction layer bodies are unavailable under retrieval contract 2; retrieve relevant nodes with a reason.",
            ));
        }
        self.writer_for_subgraph(manifest.interaction_node_id)
            .await?
            .get_layer(layer)
            .await
    }
    pub async fn instruction_query_read_permit(
        &self,
        interaction: NodeId,
        epoch: u64,
    ) -> Result<QueryReadPermit, GraphError> {
        let manifest = self.instruction_graph(interaction, epoch).await?;
        Ok(QueryReadPermit::canonical_scope(
            manifest.thread_id,
            None,
            Vec::new(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        RecordState,
        query::{RequestTarget, TargetScope},
    };
    fn definition(count: usize) -> InstructionGraphDefinition {
        let modules = (0..count)
            .map(|i| InstructionModuleDefinition {
                key: format!("module-{i}"),
                title: format!("Capability {i}"),
                detail: format!("Exact trusted guidance {i}"),
                prerequisites: if i == 0 {
                    vec![]
                } else {
                    vec!["module-0".into()]
                },
            })
            .collect::<Vec<_>>();
        let digest = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&modules).unwrap())
        );
        InstructionGraphDefinition {
            retrieval_contract_version: 1,
            digest,
            modules,
        }
    }
    #[tokio::test]
    async fn retrieval_contract_two_is_immutable_and_bounded_without_changing_legacy_json() {
        let legacy = definition(1);
        let json = serde_json::to_value(&legacy).unwrap();
        assert!(json.get("retrievalContractVersion").is_none());
        assert_eq!(
            serde_json::from_value::<InstructionGraphDefinition>(json)
                .unwrap()
                .retrieval_contract_version,
            1
        );
        let graph = GraphDatabase::in_memory().await.unwrap();
        let mut v2 = definition(1);
        v2.retrieval_contract_version = 2;
        let published = graph
            .ensure_instruction_graph("v2", v2.clone())
            .await
            .unwrap();
        assert_eq!(published.retrieval_contract_version, 2);
        assert_eq!(
            serde_json::to_value(&published).unwrap()["retrievalContractVersion"],
            2
        );
        assert!(graph.ensure_instruction_graph("v2", legacy).await.is_err());
        v2.modules[0].detail = "x".repeat(2401);
        v2.digest = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&v2.modules).unwrap())
        );
        assert!(
            graph
                .ensure_instruction_graph("too-large", v2)
                .await
                .is_err()
        );
        let mut unicode = definition(1);
        unicode.retrieval_contract_version = 2;
        unicode.modules[0].detail = "é".repeat(1200);
        unicode.digest = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&unicode.modules).unwrap())
        );
        graph
            .ensure_instruction_graph("unicode-at-limit", unicode.clone())
            .await
            .unwrap();
        unicode.modules[0].detail.push('é');
        unicode.digest = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&unicode.modules).unwrap())
        );
        assert!(
            graph
                .ensure_instruction_graph("unicode-over-limit", unicode)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn instruction_graph_publication_pin_and_exact_read_scope_survive_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("graph.db");
        let graph = GraphDatabase::open(&path).await.unwrap();
        let definition = definition(9);
        let corpus = graph
            .ensure_instruction_graph("codex-instruction-graph-v1", definition.clone())
            .await
            .unwrap();
        assert_eq!(corpus.modules.len(), 9);
        assert_eq!(
            corpus,
            graph
                .ensure_instruction_graph("codex-instruction-graph-v1", definition.clone())
                .await
                .unwrap()
        );
        let task = graph
            .create_interaction(None, ThreadId::new(12).unwrap(), "Task")
            .await
            .unwrap();
        graph
            .attach_instruction_graph(task.id, &corpus.version_key, &corpus.digest)
            .await
            .unwrap();
        let epoch = graph.activate_completion_authority(task.id).await.unwrap();
        let node = graph
            .instruction_node(task.id, epoch, corpus.modules[8].node_id)
            .await
            .unwrap();
        assert_eq!(node.detail, "Exact trusted guidance 8");
        assert_eq!(node.state, RecordState::Accepted);
        assert!(
            graph
                .writer_for_completion_authority(task.id, epoch)
                .await
                .unwrap()
                .get_node(node.id)
                .await
                .is_err()
        );
        assert!(
            graph
                .instruction_node(task.id, epoch, task.id)
                .await
                .is_err()
        );
        assert!(
            graph
                .create_interaction(None, corpus.thread_id, "untrusted instruction")
                .await
                .is_err()
        );
        let permit = graph
            .instruction_query_read_permit(task.id, epoch)
            .await
            .unwrap();
        assert_eq!(
            permit
                .authorize(RequestTarget {
                    scope: TargetScope::Thread,
                    id: corpus.thread_id.value()
                })
                .unwrap(),
            SearchTarget::Thread(corpus.thread_id)
        );
        assert!(
            permit
                .authorize(RequestTarget {
                    scope: TargetScope::Thread,
                    id: 12
                })
                .is_err()
        );
        assert!(
            graph
                .query_read_permit(task.id, epoch)
                .await
                .unwrap()
                .authorize(RequestTarget {
                    scope: TargetScope::Thread,
                    id: corpus.thread_id.value()
                })
                .is_err()
        );
        let closure = graph
            .accepted_graph_closure(corpus.interaction_node_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(closure.layers.len(), 6);
        assert!(
            closure
                .layers
                .iter()
                .flat_map(|l| &l.edges)
                .any(|edge| edge.endpoints.contains(&corpus.modules[8].node_id)
                    && edge.endpoints.contains(&corpus.modules[0].node_id))
        );
        drop(graph);
        let reopened = GraphDatabase::open(&path).await.unwrap();
        assert_eq!(
            reopened.instruction_graph(task.id, epoch).await.unwrap(),
            corpus
        );
        reopened
            .cutover_completion_authority(task.id)
            .await
            .unwrap();
        assert!(
            reopened
                .instruction_node(task.id, epoch, node.id)
                .await
                .is_err()
        );
    }
    #[tokio::test]
    async fn instruction_graph_publication_recovers_after_acceptance_before_manifest() {
        let graph = GraphDatabase::in_memory().await.unwrap();
        let definition = definition(2);
        let original = graph
            .ensure_instruction_graph("v1", definition.clone())
            .await
            .unwrap();
        // Reproduce a durable acceptance followed by lost publication metadata.
        let mut connection = graph.storage.acquire().await.unwrap();
        sqlx::query("UPDATE instruction_graph_versions SET manifest_json=NULL,interaction_node_id=NULL WHERE version_key='v1'").execute(&mut *connection).await.unwrap();
        drop(connection);
        assert_eq!(
            graph
                .ensure_instruction_graph("v1", definition)
                .await
                .unwrap(),
            original
        );
    }
    #[tokio::test]
    async fn instruction_graph_children_inherit_exact_pin_and_retry_reuses_it() {
        let graph = GraphDatabase::in_memory().await.unwrap();
        let corpus = graph
            .ensure_instruction_graph("v1", definition(1))
            .await
            .unwrap();
        let task = graph
            .create_interaction(None, ThreadId::new(1).unwrap(), "Task")
            .await
            .unwrap();
        graph
            .attach_instruction_graph(task.id, "v1", &corpus.digest)
            .await
            .unwrap();
        let writer = graph.writer_for_subgraph(task.id).await.unwrap();
        let node = writer
            .submit_node(&NodeDraft {
                client_key: "work".into(),
                kind: "concept".into(),
                icon: "book-open".into(),
                title: "Work".into(),
                detail: "Work".into(),
            })
            .await
            .unwrap();
        let layer = writer
            .submit_layer(&LayerDraft {
                default_node_id: None,
                client_key: "work-layer".into(),
                nodes: vec![node.id],
                edges: vec![],
                layout: Some(LayerLayout::v1(
                    vec![NodePlacement {
                        node_id: node.id,
                        x: 0.5,
                        y: 0.5,
                    }],
                    "default",
                )),
                size_justification: None,
            })
            .await
            .unwrap();
        let action=writer.add_action(&serde_json::from_value::<ActionDraft>(serde_json::json!({"clientKey":"delegate","sourceNodeId":node.id,"sourceLayerId":layer.id,"kind":"invoke","label":"Delegate","interactionText":"Child work"})).unwrap()).await.unwrap();
        let (child, _) = writer
            .prepare_recursive_invocation(action.id, "child-1")
            .await
            .unwrap();
        let child_epoch = graph.activate_completion_authority(child.id).await.unwrap();
        assert_eq!(
            graph
                .instruction_graph(child.id, child_epoch)
                .await
                .unwrap(),
            corpus
        );
        let (retry, _) = writer
            .prepare_recursive_invocation(action.id, "child-1")
            .await
            .unwrap();
        assert_eq!(retry.id, child.id);
        assert_eq!(
            graph
                .instruction_graph(retry.id, child_epoch)
                .await
                .unwrap(),
            corpus
        );
        graph
            .ensure_instruction_graph("v2", definition(2))
            .await
            .unwrap();
        assert_eq!(
            graph
                .instruction_graph(child.id, child_epoch)
                .await
                .unwrap()
                .version_key,
            "v1"
        );
    }

    #[tokio::test]
    async fn instruction_graph_versions_and_pins_are_immutable_and_validate_content() {
        let graph = GraphDatabase::in_memory().await.unwrap();
        let first = definition(1);
        let second = definition(2);
        let v1 = graph
            .ensure_instruction_graph("v1", first.clone())
            .await
            .unwrap();
        assert!(
            graph
                .ensure_instruction_graph("v1", second.clone())
                .await
                .is_err()
        );
        let mut mismatch = first;
        mismatch.modules[0].detail = "corrupted".into();
        assert!(
            graph
                .ensure_instruction_graph("corrupt", mismatch)
                .await
                .is_err()
        );
        let v2 = graph.ensure_instruction_graph("v2", second).await.unwrap();
        let task = graph
            .create_interaction(None, ThreadId::new(1).unwrap(), "Task")
            .await
            .unwrap();
        graph
            .attach_instruction_graph(task.id, "v1", &v1.digest)
            .await
            .unwrap();
        assert!(
            graph
                .attach_instruction_graph(task.id, "v1", &v2.digest)
                .await
                .is_err()
        );
        assert!(
            graph
                .attach_instruction_graph(task.id, "v2", &v2.digest)
                .await
                .is_err()
        );
        let epoch = graph.activate_completion_authority(task.id).await.unwrap();
        assert!(
            graph
                .instruction_node(task.id, epoch, v2.modules[0].node_id)
                .await
                .is_err()
        );
        assert!(
            graph
                .instruction_layer(task.id, epoch, v2.root_layer_id)
                .await
                .is_err()
        );
    }
}
