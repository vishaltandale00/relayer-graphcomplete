use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::{GraphError, ProjectId, ThreadId};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedConversation {
    pub import_id: String,
    pub source_sha256: String,
    pub project_id: Option<ProjectId>,
    pub thread_id: ThreadId,
    pub created_at: String,
    pub turns: Vec<ImportedTurn>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedConversationStage {
    pub import_id: String,
    pub source_sha256: String,
    pub project_id: Option<ProjectId>,
    pub thread_id: ThreadId,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedTurn {
    pub source_turn_id: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interaction_node_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub invoke_origin: Option<ImportedInvokeOrigin>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub contexts: Vec<ImportedInteractionContext>,
    pub accepted_view: Option<ImportedAcceptedView>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedInteractionContext {
    pub id: String,
    pub target: ImportedNode,
    pub source_interaction_node_id: String,
    pub source_layer_id: String,
    #[serde(default)]
    pub annotations: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedInvokeOrigin {
    pub source_turn_id: String,
    pub source_action_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedAcceptedView {
    pub interaction_node_id: String,
    pub root_action: ImportedAction,
    pub root_layer_id: String,
    pub layers: Vec<ImportedResolvedLayer>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedResolvedLayer {
    pub layer: ImportedLayer,
    pub nodes: Vec<ImportedNode>,
    pub edges: Vec<ImportedEdge>,
    pub actions: Vec<ImportedAction>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedLayer {
    pub id: String,
    pub nodes: Vec<String>,
    pub edges: Vec<String>,
    #[serde(default)]
    pub layout: Option<ImportedLayerLayout>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedLayerLayout {
    pub version: u32,
    pub placements: Vec<ImportedNodePlacement>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedNodePlacement {
    pub node_id: String,
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportedNode {
    pub id: String,
    pub kind: String,
    pub icon: String,
    pub title: String,
    pub detail: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedEdge {
    pub id: String,
    pub endpoints: [String; 2],
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedAction {
    pub id: String,
    pub source_node_id: String,
    pub source_layer_id: Option<String>,
    pub kind: String,
    pub relation: Option<String>,
    pub label: String,
    pub variant: String,
    pub icon: Option<String>,
    pub description: Option<String>,
    pub target_layer_id: Option<String>,
    pub interaction_text: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedTurnReceipt {
    pub source_turn_id: String,
    pub graph_node_id: Option<i64>,
    pub root_layer_id: Option<i64>,
    pub root_action_id: Option<i64>,
    pub output: Option<crate::CompletionOutput>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedConversationReceipt {
    pub import_id: String,
    pub turns: Vec<ImportedTurnReceipt>,
}

impl crate::GraphDatabase {
    pub async fn begin_imported_conversation(
        &self,
        input: &ImportedConversationStage,
    ) -> Result<(), GraphError> {
        if input.import_id.trim().is_empty() || input.source_sha256.trim().is_empty() {
            return Err(GraphError::Internal(
                "graph import identity is empty".into(),
            ));
        }
        let mut tx = self.storage.begin_write().await?;
        let duplicate: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM graph_imports WHERE import_id=?1 OR thread_id=?2)",
        )
        .bind(&input.import_id)
        .bind(input.thread_id.value())
        .fetch_one(&mut *tx)
        .await?;
        if duplicate {
            return Err(GraphError::Forbidden(
                "graph import identity already exists".into(),
            ));
        }
        sqlx::query("INSERT INTO graph_imports(import_id,source_sha256,project_id,thread_id,created_at) VALUES (?1,?2,?3,?4,?5)")
            .bind(&input.import_id).bind(&input.source_sha256).bind(input.project_id.map(ProjectId::value))
            .bind(input.thread_id.value()).bind(&input.created_at).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn stage_imported_turn(
        &self,
        import_id: &str,
        turn: &ImportedTurn,
    ) -> Result<(), GraphError> {
        let mut tx = self.storage.begin_write().await?;
        let position: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM graph_import_turns WHERE import_id=?1")
                .bind(import_id)
                .fetch_one(&mut *tx)
                .await?;
        let result = sqlx::query("INSERT INTO graph_import_turns(import_id,position,source_turn_id,turn_json) SELECT ?1,?2,?3,?4 WHERE EXISTS(SELECT 1 FROM graph_imports WHERE import_id=?1)")
            .bind(import_id).bind(position).bind(&turn.source_turn_id)
            .bind(serde_json::to_string(turn).map_err(|error| GraphError::Internal(error.to_string()))?)
            .execute(&mut *tx).await?;
        if result.rows_affected() != 1 {
            return Err(GraphError::Internal(
                "graph import stage does not exist".into(),
            ));
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn finalize_imported_conversation(
        &self,
        import_id: &str,
    ) -> Result<ImportedConversationReceipt, GraphError> {
        let mut tx = self.storage.begin_write().await?;
        let metadata = load_metadata(&mut tx, import_id).await?;
        let turn_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM graph_import_turns WHERE import_id=?1")
                .bind(import_id)
                .fetch_one(&mut *tx)
                .await?;
        let mut node_ids = HashMap::<String, i64>::new();
        let mut node_owners = HashMap::<String, i64>::new();
        let mut receipts = Vec::with_capacity(usize::try_from(turn_count).unwrap_or(0));

        for position in 0..turn_count {
            let turn = load_turn(&mut tx, import_id, position).await?;
            let portable_interaction_id = turn.interaction_node_id.as_ref().or_else(|| {
                turn.accepted_view
                    .as_ref()
                    .map(|view| &view.interaction_node_id)
            });
            let Some(portable_interaction_id) = portable_interaction_id else {
                if !turn.contexts.is_empty() {
                    return Err(GraphError::Internal(
                        "imported context turn is missing its interaction node identity".into(),
                    ));
                }
                receipts.push(ImportedTurnReceipt {
                    source_turn_id: turn.source_turn_id,
                    graph_node_id: None,
                    root_layer_id: None,
                    root_action_id: None,
                    output: None,
                });
                continue;
            };
            let result = sqlx::query("INSERT INTO nodes(project_id,thread_id,kind,icon,title,detail,state,owner_interaction_id,client_key) VALUES (?1,?2,'user-interaction','user',?3,?3,'accepted',NULL,?4)")
                .bind(metadata.project_id.map(ProjectId::value)).bind(metadata.thread_id.value()).bind(&turn.text)
                .bind(portable_interaction_id).execute(&mut *tx).await?;
            let root = result.last_insert_rowid();
            if node_ids
                .insert(portable_interaction_id.clone(), root)
                .is_some()
            {
                return Err(GraphError::Internal(
                    "duplicate imported interaction node".into(),
                ));
            }
            if let Some(view) = &turn.accepted_view {
                for resolved in &view.layers {
                    for node in &resolved.nodes {
                        node_owners.entry(node.id.clone()).or_insert(root);
                    }
                }
            }
            for context in &turn.contexts {
                node_owners.entry(context.target.id.clone()).or_insert(root);
            }
            receipts.push(ImportedTurnReceipt {
                source_turn_id: turn.source_turn_id,
                graph_node_id: Some(root),
                root_layer_id: None,
                root_action_id: None,
                output: None,
            });
        }

        let mut node_definitions = HashMap::<String, ImportedNode>::new();
        for position in 0..turn_count {
            let turn = load_turn(&mut tx, import_id, position).await?;
            if let Some(view) = turn.accepted_view {
                for resolved in view.layers {
                    for node in resolved.nodes {
                        register_imported_node(&mut node_definitions, node)?;
                    }
                }
            }
            for context in turn.contexts {
                register_imported_node(&mut node_definitions, context.target)?;
            }
        }
        for (portable_id, node) in node_definitions {
            if node_ids.contains_key(&portable_id) {
                return Err(GraphError::Internal(
                    "imported node ID collides with an interaction node ID".into(),
                ));
            }
            let owner = node_owners[&portable_id];
            let result = sqlx::query("INSERT INTO nodes(project_id,thread_id,kind,icon,title,detail,state,owner_interaction_id,client_key) VALUES (?1,?2,?3,?4,?5,?6,'accepted',?7,?8)")
                .bind(metadata.project_id.map(ProjectId::value)).bind(metadata.thread_id.value()).bind(node.kind).bind(node.icon)
                .bind(node.title).bind(node.detail).bind(owner).bind(&portable_id).execute(&mut *tx).await?;
            node_ids.insert(portable_id, result.last_insert_rowid());
        }

        let mut edge_ids = HashMap::<String, i64>::new();
        let mut layer_ids = HashMap::<String, i64>::new();
        let mut seen_layers = HashSet::new();
        for position in 0..turn_count {
            let turn = load_turn(&mut tx, import_id, position).await?;
            let Some(view) = turn.accepted_view else {
                continue;
            };
            let owner = node_ids[&view.interaction_node_id];
            for resolved in view.layers {
                if !seen_layers.insert(resolved.layer.id.clone()) {
                    continue;
                }
                validate_imported_layout(&resolved.layer)?;
                for edge in &resolved.edges {
                    if edge_ids.contains_key(&edge.id) {
                        continue;
                    }
                    let mut endpoints =
                        [node_ids[&edge.endpoints[0]], node_ids[&edge.endpoints[1]]];
                    endpoints.sort_unstable();
                    let result = sqlx::query("INSERT INTO edges(project_id,thread_id,left_id,right_id,state,owner_interaction_id,client_key) VALUES (?1,?2,?3,?4,'accepted',?5,?6)")
                        .bind(metadata.project_id.map(ProjectId::value)).bind(metadata.thread_id.value()).bind(endpoints[0]).bind(endpoints[1])
                        .bind(owner).bind(&edge.id).execute(&mut *tx).await?;
                    edge_ids.insert(edge.id.clone(), result.last_insert_rowid());
                }
                let result = sqlx::query("INSERT INTO layers(project_id,thread_id,layout_schema_version,state,owner_interaction_id,client_key) VALUES (?1,?2,?3,'accepted',?4,?5)")
                    .bind(metadata.project_id.map(ProjectId::value)).bind(metadata.thread_id.value())
                    .bind(resolved.layer.layout.as_ref().map(|layout| i64::from(layout.version)))
                    .bind(owner).bind(&resolved.layer.id)
                    .execute(&mut *tx).await?;
                layer_ids.insert(resolved.layer.id, result.last_insert_rowid());
            }
        }

        seen_layers.clear();
        for position in 0..turn_count {
            let turn = load_turn(&mut tx, import_id, position).await?;
            let Some(view) = turn.accepted_view else {
                continue;
            };
            for resolved in view.layers {
                if !seen_layers.insert(resolved.layer.id.clone()) {
                    continue;
                }
                let layer = layer_ids[&resolved.layer.id];
                for (index, node) in resolved.layer.nodes.iter().enumerate() {
                    sqlx::query(
                        "INSERT INTO layer_nodes(layer_id,node_id,position) VALUES (?1,?2,?3)",
                    )
                    .bind(layer)
                    .bind(node_ids[node])
                    .bind(index as i64)
                    .execute(&mut *tx)
                    .await?;
                }
                for (index, edge) in resolved.layer.edges.iter().enumerate() {
                    sqlx::query(
                        "INSERT INTO layer_edges(layer_id,edge_id,position) VALUES (?1,?2,?3)",
                    )
                    .bind(layer)
                    .bind(edge_ids[edge])
                    .bind(index as i64)
                    .execute(&mut *tx)
                    .await?;
                }
                if let Some(layout) = &resolved.layer.layout {
                    for (index, placement) in layout.placements.iter().enumerate() {
                        sqlx::query(
                            "INSERT INTO layer_placements(layer_id,node_id,position,x,y) VALUES (?1,?2,?3,?4,?5)",
                        )
                        .bind(layer)
                        .bind(node_ids[&placement.node_id])
                        .bind(index as i64)
                        .bind(placement.x)
                        .bind(placement.y)
                        .execute(&mut *tx)
                        .await?;
                    }
                }
            }
        }

        // Imported context snapshots are deliberately materialized outside the
        // authored output closure. Each distinct portable target receives one
        // inert accepted occurrence layer so shared targets deduplicate without
        // granting authority to foreign source IDs or paths.
        let mut context_occurrence_layers = HashMap::<String, i64>::new();
        for position in 0..turn_count {
            let turn = load_turn(&mut tx, import_id, position).await?;
            for imported_context in turn.contexts {
                if context_occurrence_layers.contains_key(&imported_context.target.id) {
                    continue;
                }
                let owner = node_owners[&imported_context.target.id];
                let result = sqlx::query("INSERT INTO layers(project_id,thread_id,layout_schema_version,state,owner_interaction_id,client_key) VALUES (?1,?2,NULL,'accepted',?3,?4)")
                    .bind(metadata.project_id.map(ProjectId::value))
                    .bind(metadata.thread_id.value())
                    .bind(owner)
                    .bind(format!("\0import.context.occurrence:{}", imported_context.target.id))
                    .execute(&mut *tx)
                    .await?;
                let layer_id = result.last_insert_rowid();
                sqlx::query("INSERT INTO layer_nodes(layer_id,node_id,position) VALUES (?1,?2,0)")
                    .bind(layer_id)
                    .bind(node_ids[&imported_context.target.id])
                    .execute(&mut *tx)
                    .await?;
                context_occurrence_layers.insert(imported_context.target.id, layer_id);
            }
        }

        let mut action_ids = HashMap::<String, i64>::new();
        let context = InsertContext {
            metadata: &metadata,
            nodes: &node_ids,
            layers: &layer_ids,
        };
        for position in 0..turn_count {
            let turn = load_turn(&mut tx, import_id, position).await?;
            let Some(view) = turn.accepted_view else {
                continue;
            };
            let owner = node_ids[&view.interaction_node_id];
            insert_action(
                &mut tx,
                &context,
                owner,
                &view.root_action,
                true,
                &mut action_ids,
            )
            .await?;
            for resolved in view.layers {
                for action in resolved.actions {
                    if !action_ids.contains_key(&action.id) {
                        insert_action(&mut tx, &context, owner, &action, false, &mut action_ids)
                            .await?;
                    }
                }
            }
        }

        for position in 0..turn_count {
            let turn = load_turn(&mut tx, import_id, position).await?;
            let portable_interaction_id = turn.interaction_node_id.as_ref().or_else(|| {
                turn.accepted_view
                    .as_ref()
                    .map(|view| &view.interaction_node_id)
            });
            let Some(portable_interaction_id) = portable_interaction_id else {
                if !turn.contexts.is_empty() {
                    return Err(GraphError::Internal(
                        "imported context turn is missing its interaction node identity".into(),
                    ));
                }
                continue;
            };
            let interaction_node_id = node_ids[portable_interaction_id];
            let mut seen_targets = HashSet::new();
            for (context_position, imported_context) in turn.contexts.iter().enumerate() {
                if !seen_targets.insert(&imported_context.target.id) {
                    return Err(GraphError::Internal(
                        "imported turn attaches one context target more than once".into(),
                    ));
                }
                if action_ids.contains_key(&imported_context.id) {
                    return Err(GraphError::Internal(
                        "imported context action ID collides with another action".into(),
                    ));
                }
                let target_node_id = node_ids[&imported_context.target.id];
                let source_layer_id = context_occurrence_layers[&imported_context.target.id];
                let source_interaction_node_id = node_owners[&imported_context.target.id];
                let result = sqlx::query("INSERT INTO actions(project_id,thread_id,source_node_id,source_layer_id,kind,relation,label,variant,icon,description,target_layer_id,interaction_text,response,state,owner_interaction_id,client_key,type_id) VALUES (?1,?2,?3,NULL,'invoke',NULL,'','pill',NULL,NULL,NULL,NULL,0,'accepted',?3,?4,'interaction.context')")
                    .bind(metadata.project_id.map(ProjectId::value))
                    .bind(metadata.thread_id.value())
                    .bind(interaction_node_id)
                    .bind(format!("\0import.interaction.context:{context_position}"))
                    .execute(&mut *tx)
                    .await?;
                let action_id = result.last_insert_rowid();
                sqlx::query("INSERT INTO interaction_context_actions(action_id,interaction_node_id,target_node_id,source_interaction_node_id,source_layer_id,position) VALUES (?1,?2,?3,?4,?5,?6)")
                    .bind(action_id)
                    .bind(interaction_node_id)
                    .bind(target_node_id)
                    .bind(source_interaction_node_id)
                    .bind(source_layer_id)
                    .bind(i64::try_from(context_position).map_err(|_| GraphError::Internal("imported context position exceeds SQLite range".into()))?)
                    .execute(&mut *tx)
                    .await?;
                for (annotation_position, annotation) in
                    imported_context.annotations.iter().enumerate()
                {
                    if annotation.trim().is_empty() {
                        return Err(GraphError::Internal(
                            "imported context annotation is empty".into(),
                        ));
                    }
                    sqlx::query("INSERT INTO interaction_context_annotations(action_id,position,text) VALUES (?1,?2,?3)")
                        .bind(action_id)
                        .bind(i64::try_from(annotation_position).map_err(|_| GraphError::Internal("imported annotation position exceeds SQLite range".into()))?)
                        .bind(annotation)
                        .execute(&mut *tx)
                        .await?;
                }
                action_ids.insert(imported_context.id.clone(), action_id);
            }
        }

        seen_layers.clear();
        for position in 0..turn_count {
            let turn = load_turn(&mut tx, import_id, position).await?;
            let Some(view) = turn.accepted_view else {
                continue;
            };
            for resolved in view.layers {
                if !seen_layers.insert(resolved.layer.id.clone()) {
                    continue;
                }
                for (index, action) in resolved.actions.iter().enumerate() {
                    sqlx::query(
                        "INSERT INTO layer_actions(layer_id,action_id,position) VALUES (?1,?2,?3)",
                    )
                    .bind(layer_ids[&resolved.layer.id])
                    .bind(action_ids[&action.id])
                    .bind(index as i64)
                    .execute(&mut *tx)
                    .await?;
                }
            }
        }

        for position in 0..turn_count {
            let turn = load_turn(&mut tx, import_id, position).await?;
            let Some(view) = turn.accepted_view else {
                continue;
            };
            let root = node_ids[&view.interaction_node_id];
            sqlx::query(
                "INSERT INTO completions(interaction_node_id,root_action_id) VALUES (?1,?2)",
            )
            .bind(root)
            .bind(action_ids[&view.root_action.id])
            .execute(&mut *tx)
            .await?;
            let receipt = &mut receipts[usize::try_from(position).unwrap()];
            receipt.root_layer_id = Some(layer_ids[&view.root_layer_id]);
            receipt.root_action_id = Some(action_ids[&view.root_action.id]);
        }

        // V1 exports retain the authored invoke shape (`targetLayerId: null`). The
        // already-validated origin on a later accepted turn is the portable record
        // that the invoke resolved, so reconstruct that projection inside the same
        // immutable import transaction.
        let mut resolved_invokes = HashSet::new();
        for position in 0..turn_count {
            let turn = load_turn(&mut tx, import_id, position).await?;
            let (Some(origin), Some(view)) = (turn.invoke_origin, turn.accepted_view) else {
                continue;
            };
            let source_turn_position =
                source_turn_position(&mut tx, import_id, &origin.source_turn_id)
                    .await?
                    .ok_or_else(|| {
                        GraphError::Internal(
                            "imported invoke origin names an unknown source turn".into(),
                        )
                    })?;
            if source_turn_position >= position {
                return Err(GraphError::Internal(
                    "imported invoke origin must name an earlier turn".into(),
                ));
            }
            let source_turn = load_turn(&mut tx, import_id, source_turn_position).await?;
            let source_has_invoke = source_turn
                .accepted_view
                .as_ref()
                .is_some_and(|source_view| {
                    source_view.layers.iter().any(|layer| {
                        layer.actions.iter().any(|action| {
                            action.id == origin.source_action_id && action.kind == "invoke"
                        })
                    })
                });
            if !source_has_invoke {
                return Err(GraphError::Internal(
                    "imported invoke origin does not name an invoke in its source turn".into(),
                ));
            }
            if !resolved_invokes.insert(origin.source_action_id.clone()) {
                return Err(GraphError::Internal(
                    "imported invoke action resolves more than once".into(),
                ));
            }
            let action_id = action_ids.get(&origin.source_action_id).ok_or_else(|| {
                GraphError::Internal("imported invoke origin action was not materialized".into())
            })?;
            let target_layer_id = layer_ids.get(&view.root_layer_id).ok_or_else(|| {
                GraphError::Internal("imported invoke destination root was not materialized".into())
            })?;
            let updated = sqlx::query(
                "UPDATE actions SET target_layer_id=?1 WHERE id=?2 AND kind='invoke' AND target_layer_id IS NULL",
            )
            .bind(target_layer_id)
            .bind(action_id)
            .execute(&mut *tx)
            .await?;
            if updated.rows_affected() != 1 {
                return Err(GraphError::Internal(
                    "imported invoke resolution could not be reconstructed exactly once".into(),
                ));
            }
        }
        tx.commit().await?;
        for receipt in &mut receipts {
            if let Some(node_id) = receipt.graph_node_id {
                receipt.output = self
                    .writer_for_subgraph(crate::NodeId::new(node_id).ok_or_else(|| {
                        GraphError::Internal("invalid imported root node ID".into())
                    })?)
                    .await?
                    .completion_output()
                    .await?;
            }
        }
        Ok(ImportedConversationReceipt {
            import_id: import_id.to_owned(),
            turns: receipts,
        })
    }

    pub async fn import_accepted_conversation(
        &self,
        input: &ImportedConversation,
    ) -> Result<ImportedConversationReceipt, GraphError> {
        let stage = ImportedConversationStage {
            import_id: input.import_id.clone(),
            source_sha256: input.source_sha256.clone(),
            project_id: input.project_id,
            thread_id: input.thread_id,
            created_at: input.created_at.clone(),
        };
        self.begin_imported_conversation(&stage).await?;
        for turn in &input.turns {
            if let Err(error) = self.stage_imported_turn(&input.import_id, turn).await {
                self.remove_imported_conversation(&input.import_id).await?;
                return Err(error);
            }
        }
        match self.finalize_imported_conversation(&input.import_id).await {
            Ok(receipt) => Ok(receipt),
            Err(error) => {
                self.remove_imported_conversation(&input.import_id).await?;
                Err(error)
            }
        }
    }

    pub async fn remove_imported_conversation(&self, import_id: &str) -> Result<(), GraphError> {
        let mut tx = self.storage.begin_write().await?;
        let thread_id: Option<i64> =
            sqlx::query_scalar("SELECT thread_id FROM graph_imports WHERE import_id=?1")
                .bind(import_id)
                .fetch_optional(&mut *tx)
                .await?;
        if let Some(thread_id) = thread_id {
            for statement in [
                "DELETE FROM completions WHERE interaction_node_id IN (SELECT id FROM nodes WHERE thread_id=?1)",
                "DELETE FROM layer_actions WHERE layer_id IN (SELECT id FROM layers WHERE thread_id=?1)",
                "DELETE FROM actions WHERE thread_id=?1",
                "DELETE FROM layer_edges WHERE layer_id IN (SELECT id FROM layers WHERE thread_id=?1)",
                "DELETE FROM layer_nodes WHERE layer_id IN (SELECT id FROM layers WHERE thread_id=?1)",
                "DELETE FROM layers WHERE thread_id=?1",
                "DELETE FROM edges WHERE thread_id=?1",
                "DELETE FROM nodes WHERE thread_id=?1",
            ] {
                sqlx::query(statement)
                    .bind(thread_id)
                    .execute(&mut *tx)
                    .await?;
            }
            sqlx::query("DELETE FROM graph_imports WHERE import_id=?1")
                .bind(import_id)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(())
    }
}

fn validate_imported_layout(layer: &ImportedLayer) -> Result<(), GraphError> {
    let Some(layout) = &layer.layout else {
        return Ok(());
    };
    if layout.version != 1 {
        return Err(GraphError::Internal(format!(
            "imported layer {} has unsupported layout version {}",
            layer.id, layout.version
        )));
    }
    if layout.placements.len() != layer.nodes.len() {
        return Err(GraphError::Internal(format!(
            "imported layer {} layout does not place every node exactly once",
            layer.id
        )));
    }
    let members = layer
        .nodes
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    let mut placed = HashSet::new();
    for placement in &layout.placements {
        if !members.contains(placement.node_id.as_str())
            || !placed.insert(placement.node_id.as_str())
            || !placement.x.is_finite()
            || !(0.0..=1.0).contains(&placement.x)
            || !placement.y.is_finite()
            || !(0.0..=1.0).contains(&placement.y)
        {
            return Err(GraphError::Internal(format!(
                "imported layer {} has an invalid authored layout",
                layer.id
            )));
        }
    }
    Ok(())
}

async fn source_turn_position(
    tx: &mut sqlx::Transaction<'static, sqlx::Sqlite>,
    import_id: &str,
    source_turn_id: &str,
) -> Result<Option<i64>, GraphError> {
    Ok(sqlx::query_scalar(
        "SELECT position FROM graph_import_turns WHERE import_id=?1 AND source_turn_id=?2",
    )
    .bind(import_id)
    .bind(source_turn_id)
    .fetch_optional(&mut **tx)
    .await?)
}

async fn load_metadata(
    tx: &mut sqlx::Transaction<'static, sqlx::Sqlite>,
    import_id: &str,
) -> Result<ImportedConversationStage, GraphError> {
    let row = sqlx::query("SELECT source_sha256,project_id,thread_id,created_at FROM graph_imports WHERE import_id=?1").bind(import_id).fetch_one(&mut **tx).await?;
    let project: Option<i64> = sqlx::Row::try_get(&row, 1)?;
    Ok(ImportedConversationStage {
        import_id: import_id.to_owned(),
        source_sha256: sqlx::Row::try_get(&row, 0)?,
        project_id: project
            .map(|value| {
                ProjectId::new(value)
                    .ok_or_else(|| GraphError::Internal("invalid imported project ID".into()))
            })
            .transpose()?,
        thread_id: ThreadId::new(sqlx::Row::try_get(&row, 2)?)
            .ok_or_else(|| GraphError::Internal("invalid imported thread ID".into()))?,
        created_at: sqlx::Row::try_get(&row, 3)?,
    })
}

async fn load_turn(
    tx: &mut sqlx::Transaction<'static, sqlx::Sqlite>,
    import_id: &str,
    position: i64,
) -> Result<ImportedTurn, GraphError> {
    let json: String = sqlx::query_scalar(
        "SELECT turn_json FROM graph_import_turns WHERE import_id=?1 AND position=?2",
    )
    .bind(import_id)
    .bind(position)
    .fetch_one(&mut **tx)
    .await?;
    serde_json::from_str(&json).map_err(|error| GraphError::Internal(error.to_string()))
}

fn register_imported_node(
    definitions: &mut HashMap<String, ImportedNode>,
    node: ImportedNode,
) -> Result<(), GraphError> {
    if let Some(existing) = definitions.get(&node.id) {
        if existing != &node {
            return Err(GraphError::Internal(
                "imported node snapshot changed for one portable ID".into(),
            ));
        }
        return Ok(());
    }
    definitions.insert(node.id.clone(), node);
    Ok(())
}

struct InsertContext<'a> {
    metadata: &'a ImportedConversationStage,
    nodes: &'a HashMap<String, i64>,
    layers: &'a HashMap<String, i64>,
}

async fn insert_action(
    tx: &mut sqlx::Transaction<'static, sqlx::Sqlite>,
    context: &InsertContext<'_>,
    owner: i64,
    action: &ImportedAction,
    response: bool,
    ids: &mut HashMap<String, i64>,
) -> Result<(), GraphError> {
    let result = sqlx::query("INSERT INTO actions(project_id,thread_id,source_node_id,source_layer_id,kind,relation,label,variant,icon,description,target_layer_id,interaction_text,response,state,owner_interaction_id,client_key) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,'accepted',?14,?15)")
        .bind(context.metadata.project_id.map(ProjectId::value)).bind(context.metadata.thread_id.value())
        .bind(context.nodes[&action.source_node_id]).bind(action.source_layer_id.as_ref().map(|id| context.layers[id]))
        .bind(&action.kind).bind(&action.relation).bind(&action.label).bind(&action.variant).bind(&action.icon).bind(&action.description)
        .bind(action.target_layer_id.as_ref().map(|id| context.layers[id])).bind(&action.interaction_text).bind(response).bind(owner).bind(&action.id)
        .execute(&mut **tx).await?;
    ids.insert(action.id.clone(), result.last_insert_rowid());
    Ok(())
}
