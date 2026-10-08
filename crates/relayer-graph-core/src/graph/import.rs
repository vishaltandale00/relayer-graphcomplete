use std::collections::{HashMap, HashSet};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    ActionId, ActionKind, EDGE_SHAPES, EdgeEnd, EdgeId, EdgeRoute, GraphError, InputAction,
    LayerId, LayerLayout, LayoutPoint, MAX_EDGE_ROUTE_WAYPOINTS, NODE_SIDES, NodeId,
    PERSONAL_PRESENTATION_PROFILE_THREAD_ID, PresentingInputOccurrence, ProjectId,
    SubmittedInputValue, ThreadId, graph::InteractionScope, graph::completion,
    storage::sqlite::actions::ActionTable,
    storage::sqlite::authored_detail_assets::AuthoredDetailAssetTable,
    storage::sqlite::imports::ImportTable, storage::sqlite::input_children::validate_value,
};

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
    /// Original portable call evidence only. These IDs never confer graph authority.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub inert_invocations: Vec<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub standalone_inputs: Vec<ImportedAction>,
}

/// One digest-addressed blob staged once, independently of turn/node references.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportedVisualAssetContent {
    pub digest_sha256: String,
    pub media_type: String,
    pub byte_length: usize,
    pub content_base64: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportedDetailAsset {
    pub asset_id: String,
    pub digest_sha256: String,
    pub media_type: String,
    pub byte_length: usize,
    pub provenance_source: String,
    pub provenance_file_name: String,
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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub submitted_inputs: Vec<ImportedSubmittedInput>,
    pub accepted_view: Option<ImportedAcceptedView>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedSubmittedInput {
    pub id: String,
    pub root_turn_id: String,
    pub source: ImportedInputSource,
    pub action: InputAction,
    pub value: SubmittedInputValue,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedInputSource {
    pub interaction_node_id: String,
    pub layer_id: String,
    pub action_id: String,
    pub node_id: String,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_node_id: Option<String>,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_key: Option<String>,
    pub nodes: Vec<String>,
    pub edges: Vec<String>,
    #[serde(default)]
    pub layout: Option<ImportedLayerLayout>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub renderer: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedLayerLayout {
    pub version: u32,
    pub placements: Vec<ImportedNodePlacement>,
    /// Absent in exports written before edge shapes; it then reads as "default".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edge_shape: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub edge_routes: Vec<ImportedEdgeRoute>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedEdgeRoute {
    pub edge_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shape: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ends: Vec<ImportedEdgeEnd>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub waypoints: Vec<LayoutPoint>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedEdgeEnd {
    pub node_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub side: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedNodePlacement {
    pub node_id: String,
    pub x: f64,
    pub y: f64,
}

/// Markdown appended to an imported node whose export omitted its authored detail.
pub const IMPORTED_AUTHORED_DETAIL_OMITTED_NOTE: &str = "_Visual detail omitted from the exported conversation because it contained a private project path._";

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportedNode {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_key: Option<String>,
    pub kind: String,
    #[serde(with = "crate::graph::model::image_icon::wire")]
    pub icon: String,
    pub title: String,
    pub detail: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authored_detail: Option<serde_json::Value>,
    /// The export left out an authored detail package this node once carried.
    /// Import keeps the Markdown fallback and notes the omission inside it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub authored_detail_omitted: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub authored_detail_assets: Vec<ImportedDetailAsset>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedEdge {
    pub id: String,
    pub endpoints: [String; 2],
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedAction {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reusable: Option<bool>,
    /// Inert portable history; never a native invoke-resolution permission.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub converted_from_invoke: bool,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_key: Option<String>,
    pub source_node_id: String,
    pub source_layer_id: Option<String>,
    pub kind: String,
    pub relation: Option<String>,
    pub label: String,
    pub variant: String,
    #[serde(default, with = "crate::graph::model::image_icon::optional_wire")]
    pub icon: Option<String>,
    pub description: Option<String>,
    pub target_layer_id: Option<String>,
    pub interaction_text: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub input_action_ids: Vec<String>,
    pub input: Option<InputAction>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon_asset: Option<ImportedDetailAsset>,
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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skipped_submitted_inputs: Vec<SkippedSubmittedInput>,
}

/// One submitted input dropped during import because its claimed provenance could
/// not be proven against the materialized graph. The rest of the conversation is
/// still imported, so this record is how the drop stays visible.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedSubmittedInput {
    pub source_turn_id: String,
    pub submitted_input_id: String,
    pub code: String,
    pub path: String,
    pub message: String,
}

impl crate::GraphDatabase {
    /// Read-only evidence from an inert import. Portable IDs are not capabilities.
    pub async fn imported_invocation_evidence(
        &self,
        thread_id: ThreadId,
    ) -> Result<Vec<serde_json::Value>, GraphError> {
        let mut connection = self.storage.acquire().await?;
        let json: Option<String> = sqlx::query_scalar(
            "SELECT inert_invocations_json FROM graph_imports WHERE thread_id=?1",
        )
        .bind(thread_id.value())
        .fetch_optional(&mut *connection)
        .await?;
        json.map(|json| {
            serde_json::from_str(&json).map_err(|error| GraphError::Internal(error.to_string()))
        })
        .unwrap_or_else(|| Ok(Vec::new()))
    }

    /// Exact local presentation identities for portable call history. This does
    /// not construct a durable invocation or an execution capability.
    pub async fn imported_invocation_presentations(
        &self,
        thread_id: ThreadId,
    ) -> Result<Vec<serde_json::Value>, GraphError> {
        let records = self.imported_invocation_evidence(thread_id).await?;
        let mut connection = self.storage.acquire().await?;
        let mut presentations = Vec::with_capacity(records.len());
        for record in records {
            let source = record["source"]["interactionNodeId"].as_str().unwrap_or("");
            let parent = record["source"]["parentNodeId"].as_str().unwrap_or("");
            let source_id: Option<i64> = sqlx::query_scalar(
                "SELECT n.id FROM nodes n JOIN completion_authorities authority ON authority.interaction_node_id=n.id
                 WHERE n.thread_id=?1 AND n.client_key=?2 AND authority.read_entitlement='imported-read-only'",
            ).bind(thread_id.value()).bind(source).fetch_optional(&mut *connection).await?;
            let parent_id: Option<i64> = if let Some(source_id) = source_id {
                sqlx::query_scalar(
                    "SELECT n.id FROM nodes n WHERE n.thread_id=?1 AND n.client_key=?2
                     AND (n.id=?3 OR EXISTS(
                         SELECT 1 FROM imported_node_client_keys keys JOIN graph_imports imported ON imported.import_id=keys.import_id
                         WHERE keys.node_id=n.id AND imported.thread_id=?1))",
                )
                .bind(thread_id.value())
                .bind(parent)
                .bind(source_id)
                .fetch_optional(&mut *connection)
                .await?
            } else {
                None
            };
            presentations.push(serde_json::json!({
                "invocationId": record["id"],
                "sourceInteractionNodeId": source_id,
                "sourceNodeId": parent_id,
            }));
        }
        Ok(presentations)
    }

    pub async fn begin_imported_conversation(
        &self,
        input: &ImportedConversationStage,
    ) -> Result<(), GraphError> {
        if input.thread_id.value() == PERSONAL_PRESENTATION_PROFILE_THREAD_ID {
            return Err(GraphError::validation(
                "reserved_personal_presentation_thread",
                "threadId",
                "The personal-presentation profile thread cannot be used for conversation import.",
            ));
        }
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
        sqlx::query("INSERT INTO graph_imports(import_id,source_sha256,project_id,thread_id,created_at,inert_invocations_json,standalone_inputs_json) VALUES (?1,?2,?3,?4,?5,?6,?7)")
            .bind(&input.import_id).bind(&input.source_sha256).bind(input.project_id.map(ProjectId::value))
            .bind(input.thread_id.value()).bind(&input.created_at)
            .bind(serde_json::to_string(&input.inert_invocations).map_err(|error| GraphError::Internal(error.to_string()))?)
            .bind(serde_json::to_string(&input.standalone_inputs).map_err(|error| GraphError::Internal(error.to_string()))?)
            .execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn stage_imported_visual_asset_content(
        &self,
        import_id: &str,
        input: &ImportedVisualAssetContent,
    ) -> Result<(), GraphError> {
        let content = base64::engine::general_purpose::STANDARD
            .decode(&input.content_base64)
            .map_err(|_| {
                GraphError::validation(
                    "import_asset_content_invalid",
                    "contentBase64",
                    "Imported content must be canonical base64.",
                )
            })?;
        if content.is_empty()
            || content.len() > 8 * 1024 * 1024
            || content.len() != input.byte_length
            || base64::engine::general_purpose::STANDARD.encode(&content) != input.content_base64
            || format!("{:x}", Sha256::digest(&content)) != input.digest_sha256
            || !matches!(
                input.media_type.as_str(),
                "image/png" | "image/jpeg" | "image/svg+xml"
            )
        {
            return Err(GraphError::validation(
                "import_asset_content_invalid",
                "content",
                "Imported content must match its bounded supported-media digest and length.",
            ));
        }
        let mut tx = self.storage.begin_write().await?;
        // The foreign key confines staged content to this import and removes it
        // on abort. It is never visible through accepted-node asset reads.
        sqlx::query("INSERT INTO graph_import_asset_contents(import_id,digest_sha256,media_type,byte_length,content) VALUES (?1,?2,?3,?4,?5)")
            .bind(import_id).bind(&input.digest_sha256).bind(&input.media_type)
            .bind(input.byte_length as i64).bind(content).execute(&mut *tx).await?;
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
        // Taken before the write transaction, like every other accept path, so
        // submissions to this target index in the order they commit.
        let target = {
            let mut connection = self.storage.acquire().await?;
            ImportTable::new(&mut connection).target(import_id).await?
        };
        let _order = self.order_writes_to(target).await;
        let _publication = self.enter_search_publication().await;
        let mut tx = self.storage.begin_write().await?;
        let metadata = load_metadata(&mut tx, import_id).await?;
        let turn_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM graph_import_turns WHERE import_id=?1")
                .bind(import_id)
                .fetch_one(&mut *tx)
                .await?;
        let mut node_ids = HashMap::<String, i64>::new();
        let mut node_owners = HashMap::<String, i64>::new();
        let mut interaction_turn_positions = HashMap::<String, i64>::new();
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
                interaction_turn_positions.insert(view.interaction_node_id.clone(), position);
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
        let mut icon_pins = HashMap::<String, Vec<super::model::image_icon::ImageIcon>>::new();
        for position in 0..turn_count {
            let turn = load_turn(&mut tx, import_id, position).await?;
            if let Some(view) = turn.accepted_view {
                if let Some(icon) = view
                    .root_action
                    .icon
                    .as_deref()
                    .and_then(super::model::image_icon::image_icon)
                {
                    let asset = view.root_action.icon_asset.as_ref().ok_or_else(|| {
                        GraphError::validation(
                            "import_icon_pin_missing",
                            "rootAction.icon",
                            "Imported response image icon requires its pinned content.",
                        )
                    })?;
                    if asset.asset_id != icon.asset_id
                        || icon.digest_sha256.as_deref() != Some(&asset.digest_sha256)
                        || icon.media_type.as_deref() != Some(&asset.media_type)
                    {
                        return Err(GraphError::validation(
                            "import_icon_pin_mismatch",
                            "rootAction.icon",
                            "Response icon content does not match its pin.",
                        ));
                    }
                    super::model::image_icon::canonical_icon(
                        view.root_action.icon.as_ref().unwrap(),
                    )?;
                    let (media_type, byte_length) = AuthoredDetailAssetTable::new(&mut tx)
                        .materialize_import_content(import_id, &asset.digest_sha256)
                        .await?;
                    if media_type != asset.media_type || byte_length != asset.byte_length {
                        return Err(GraphError::validation(
                            "import_asset_content_mismatch",
                            "rootAction.iconAsset",
                            "Response icon does not match staged bytes.",
                        ));
                    }
                    AuthoredDetailAssetTable::new(&mut tx)
                        .insert_import_icon_reference(
                            NodeId::new(node_ids[&view.interaction_node_id]).unwrap(),
                            asset,
                        )
                        .await?;
                } else if view.root_action.icon_asset.is_some() {
                    return Err(GraphError::validation(
                        "import_icon_asset_unexpected",
                        "rootAction.iconAsset",
                        "Icon content requires an image icon.",
                    ));
                }
                for resolved in view.layers {
                    for action in &resolved.actions {
                        if let Some(pin) = action
                            .icon
                            .as_deref()
                            .and_then(super::model::image_icon::image_icon)
                        {
                            icon_pins
                                .entry(action.source_node_id.clone())
                                .or_default()
                                .push(pin);
                        }
                    }
                    for node in resolved.nodes {
                        register_imported_node(&mut node_definitions, node)?;
                    }
                }
            }
            for context in turn.contexts {
                register_imported_node(&mut node_definitions, context.target)?;
            }
        }
        // Only metadata is retained: each staged digest is fetched, hashed and
        // materialized once across the whole import transaction.
        let mut materialized_contents = HashMap::<String, (String, usize)>::new();
        for (portable_id, node) in node_definitions {
            if node_ids.contains_key(&portable_id) {
                return Err(GraphError::Internal(
                    "imported node ID collides with an interaction node ID".into(),
                ));
            }
            let owner = node_owners[&portable_id];
            if let Some(authored_detail) = node.authored_detail.as_ref() {
                crate::graph::model::validate_authored_detail(authored_detail)?;
            }
            if let Some(pin) = super::model::image_icon::image_icon(&node.icon) {
                icon_pins.entry(portable_id.clone()).or_default().push(pin);
            }
            let pins = icon_pins
                .get(&portable_id)
                .map(Vec::as_slice)
                .unwrap_or_default();
            let detail_pins = node
                .authored_detail
                .as_ref()
                .and_then(|package| package["assets"].as_array())
                .map(Vec::as_slice)
                .unwrap_or_default();
            for detail_pin in detail_pins {
                let id = detail_pin["id"]
                    .as_str()
                    .expect("validated detail pin identity");
                let digest = detail_pin["digestSha256"]
                    .as_str()
                    .expect("validated detail digest");
                let media_type = detail_pin["mediaType"]
                    .as_str()
                    .expect("validated detail media type");
                if pins.iter().any(|pin| {
                    pin.asset_id == id
                        && (pin.digest_sha256.as_deref() != Some(digest)
                            || pin.media_type.as_deref() != Some(media_type))
                }) {
                    return Err(GraphError::validation(
                        "import_asset_pin_conflict",
                        "authoredDetailAssets",
                        "A node's Detail and image icons must pin the same bytes for a shared asset identity.",
                    ));
                }
                // Historical metadata-only Detail imports have neither a content
                // inventory nor typed image icons. Preserve their viewing fallback;
                // image-bearing imports and supplied inventories require exact pins.
                if (!pins.is_empty() || !node.authored_detail_assets.is_empty())
                    && !node.authored_detail_assets.iter().any(|asset| {
                        asset.asset_id == id
                            && asset.digest_sha256 == digest
                            && asset.media_type == media_type
                    })
                {
                    return Err(GraphError::validation(
                        "import_detail_pin_missing",
                        "authoredDetailAssets",
                        "Every imported Detail image requires its exact pinned content association.",
                    ));
                }
            }
            for pin in pins {
                super::model::image_icon::canonical_icon(
                    &serde_json::to_string(pin).map_err(|e| GraphError::Internal(e.to_string()))?,
                )?;
                if !node.authored_detail_assets.iter().any(|a| {
                    a.asset_id == pin.asset_id
                        && Some(&a.digest_sha256) == pin.digest_sha256.as_ref()
                        && Some(&a.media_type) == pin.media_type.as_ref()
                }) {
                    return Err(GraphError::validation(
                        "import_icon_pin_missing",
                        "icon",
                        "Imported image icon requires its pinned visual content.",
                    ));
                }
            }
            for asset in &node.authored_detail_assets {
                if !materialized_contents.contains_key(&asset.digest_sha256) {
                    let metadata = AuthoredDetailAssetTable::new(&mut tx)
                        .materialize_import_content(import_id, &asset.digest_sha256)
                        .await?;
                    materialized_contents.insert(asset.digest_sha256.clone(), metadata);
                }
                let (media_type, byte_length) = &materialized_contents[&asset.digest_sha256];
                if media_type != &asset.media_type || *byte_length != asset.byte_length {
                    return Err(GraphError::validation(
                        "import_asset_content_mismatch",
                        "authoredDetailAssets",
                        "Imported visual asset reference does not match staged content.",
                    ));
                }
                let pin = node
                    .authored_detail
                    .as_ref()
                    .and_then(|package| package["assets"].as_array())
                    .and_then(|pins| {
                        pins.iter()
                            .find(|pin| pin["id"].as_str() == Some(asset.asset_id.as_str()))
                    });
                let detail_matches = pin.is_some_and(|pin| {
                    pin["digestSha256"].as_str() == Some(asset.digest_sha256.as_str())
                        && pin["mediaType"].as_str() == Some(asset.media_type.as_str())
                });
                let icon_matches = pins.iter().any(|pin| {
                    pin.asset_id == asset.asset_id
                        && pin.digest_sha256.as_deref() == Some(&asset.digest_sha256)
                        && pin.media_type.as_deref() == Some(&asset.media_type)
                });
                if !detail_matches && !icon_matches {
                    return Err(GraphError::validation(
                        "import_asset_pin_mismatch",
                        "authoredDetailAssets",
                        "Imported visual asset reference does not match its canonical package.",
                    ));
                }
            }
            let authored_detail = node
                .authored_detail
                .as_ref()
                .map(serde_json::to_string)
                .transpose()
                .map_err(|error| GraphError::Internal(error.to_string()))?;
            let detail = if node.authored_detail_omitted && node.authored_detail.is_none() {
                format!("{}\n\n{IMPORTED_AUTHORED_DETAIL_OMITTED_NOTE}", node.detail)
            } else {
                node.detail
            };
            if let Some(artifact) = &node.artifact {
                crate::artifact::validate_artifact(artifact, true)?;
            }
            let artifact = node
                .artifact
                .as_ref()
                .map(serde_json::to_string)
                .transpose()
                .map_err(|error| GraphError::Internal(error.to_string()))?;
            let result = sqlx::query("INSERT INTO nodes(project_id,thread_id,kind,icon,title,detail,authored_detail,state,owner_interaction_id,client_key,artifact) VALUES (?1,?2,?3,?4,?5,?6,?7,'accepted',?8,?9,?10)")
                .bind(metadata.project_id.map(ProjectId::value)).bind(metadata.thread_id.value()).bind(node.kind).bind(node.icon)
                .bind(node.title).bind(detail).bind(authored_detail).bind(owner)
                .bind(&portable_id).bind(artifact).execute(&mut *tx).await?;
            let node_id =
                NodeId::new(result.last_insert_rowid()).expect("inserted node ID is positive");
            sqlx::query("INSERT INTO imported_node_client_keys(node_id,import_id,client_key) VALUES (?1,?2,?3)")
                .bind(node_id.value()).bind(import_id).bind(node.client_key.as_deref().unwrap_or(&portable_id))
                .execute(&mut *tx).await?;
            for asset in &node.authored_detail_assets {
                if pins.iter().any(|pin| pin.asset_id == asset.asset_id) {
                    AuthoredDetailAssetTable::new(&mut tx)
                        .insert_import_icon_reference(node_id, asset)
                        .await?;
                }
                if node
                    .authored_detail
                    .as_ref()
                    .and_then(|p| p["assets"].as_array())
                    .is_some_and(|assets| {
                        assets
                            .iter()
                            .any(|p| p["id"].as_str() == Some(&asset.asset_id))
                    })
                {
                    AuthoredDetailAssetTable::new(&mut tx)
                        .insert_import_reference(node_id, asset)
                        .await?;
                }
            }
            node_ids.insert(portable_id, node_id.value());
        }

        let mut edge_ids = HashMap::<String, i64>::new();
        let mut layer_ids = HashMap::<String, i64>::new();
        // Two artifact views are two nodes: an artifact node appears in one imported layer.
        let mut artifact_layer_of = HashMap::<String, String>::new();
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
                validate_imported_layout(&resolved.layer, &resolved.edges)?;
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
                // An imported graph obeys the same artifact-layer rules as a live one.
                let members = resolved
                    .nodes
                    .iter()
                    .map(|node| (node.id.clone(), node.artifact.is_some()))
                    .collect::<Vec<_>>();
                crate::artifact::validate_renderer_members(
                    resolved.layer.renderer.as_deref(),
                    &members,
                    resolved.edges.len(),
                )?;
                // The answer opens on a graph, never on an artifact (PRD 6.6.1).
                if resolved.layer.id == view.root_layer_id && resolved.layer.renderer.is_some() {
                    return Err(GraphError::validation(
                        "artifact_layer_as_response",
                        "rootLayerId",
                        format!(
                            "Imported layer {} is an answer's root layer, which must be a graph.",
                            resolved.layer.id
                        ),
                    ));
                }
                for (node, _) in members.iter().filter(|(_, artifact)| *artifact) {
                    if let Some(other) =
                        artifact_layer_of.insert(node.clone(), resolved.layer.id.clone())
                        && other != resolved.layer.id
                    {
                        return Err(GraphError::validation(
                            "artifact_node_in_another_layer",
                            "layers",
                            format!(
                                "Imported artifact node {node} appears in layers {other} and {}.",
                                resolved.layer.id
                            ),
                        ));
                    }
                }
                let result = sqlx::query("INSERT INTO layers(project_id,thread_id,layout_schema_version,state,owner_interaction_id,client_key,default_node_id,layout_edge_shape,layout_edge_routes,renderer) VALUES (?1,?2,?3,'accepted',?4,?5,?6,?7,?8,?9)")
                    .bind(metadata.project_id.map(ProjectId::value)).bind(metadata.thread_id.value())
                    .bind(resolved.layer.layout.as_ref().map(|layout| i64::from(layout.version)))
                    .bind(owner).bind(&resolved.layer.id)
                    .bind(resolved.layer.default_node_id.as_ref().map(|id| node_ids[id]))
                    .bind(resolved.layer.layout.as_ref().and_then(|layout| layout.edge_shape.as_deref()))
                    .bind(imported_routes(resolved.layer.layout.as_ref(), &node_ids, &edge_ids)?)
                    .bind(resolved.layer.renderer.as_deref())
                    .execute(&mut *tx).await?;
                let layer_id = result.last_insert_rowid();
                sqlx::query("INSERT INTO imported_layer_client_keys(layer_id,import_id,client_key) VALUES (?1,?2,?3)")
                    .bind(layer_id).bind(import_id).bind(resolved.layer.client_key.as_deref().unwrap_or(&resolved.layer.id))
                    .execute(&mut *tx).await?;
                layer_ids.insert(resolved.layer.id, layer_id);
            }
        }

        let response_layer_ids = layer_ids.keys().cloned().collect::<HashSet<_>>();
        // Source-layer provenance can name an occurrence outside the exported
        // response closure. Preserve its identity as an empty inert layer, never
        // as visible response topology or execution authority. A compiled package
        // supplies the authored key when a control binds that provenance.
        let mut external_layers = HashMap::<String, (i64, Option<String>)>::new();
        for position in 0..turn_count {
            let turn = load_turn(&mut tx, import_id, position).await?;
            let Some(view) = turn.accepted_view else {
                continue;
            };
            let owner = node_ids[&view.interaction_node_id];
            for resolved in &view.layers {
                for action in &resolved.actions {
                    let Some(source_layer) = &action.source_layer_id else {
                        continue;
                    };
                    if layer_ids.contains_key(source_layer) {
                        continue;
                    }
                    let key = resolved
                        .nodes
                        .iter()
                        .find(|node| node.id == action.source_node_id)
                        .map(|node| imported_source_layer_key(node, action))
                        .transpose()?
                        .flatten();
                    let (_, existing_key) = external_layers
                        .entry(source_layer.clone())
                        .or_insert((owner, None));
                    if let (Some(existing), Some(incoming)) = (existing_key.as_ref(), key.as_ref())
                        && existing != incoming
                    {
                        return Err(GraphError::validation(
                            "imported_source_layer_key_conflict",
                            "sourceLayerId",
                            "One imported source layer cannot have conflicting authored binding keys.",
                        ));
                    }
                    if existing_key.is_none() {
                        *existing_key = key;
                    }
                }
            }
        }
        for (portable_id, (owner, key)) in external_layers {
            let result = sqlx::query("INSERT INTO layers(project_id,thread_id,state,owner_interaction_id,client_key) VALUES (?1,?2,'accepted',?3,?4)")
                .bind(metadata.project_id.map(ProjectId::value)).bind(metadata.thread_id.value())
                .bind(owner).bind(&portable_id).execute(&mut *tx).await?;
            let layer_id = result.last_insert_rowid();
            sqlx::query("INSERT INTO imported_layer_client_keys(layer_id,import_id,client_key) VALUES (?1,?2,?3)")
                .bind(layer_id).bind(import_id).bind(key.as_deref().unwrap_or(&portable_id))
                .execute(&mut *tx).await?;
            sqlx::query(
                "INSERT INTO imported_provenance_layers(layer_id,import_id) VALUES (?1,?2)",
            )
            .bind(layer_id)
            .bind(import_id)
            .execute(&mut *tx)
            .await?;
            layer_ids.insert(portable_id, layer_id);
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

        // Old exports omitted authored input payloads and repeated them only on
        // submitted children. Keep this compatibility fallback scoped to IDs of
        // payload-less input actions. Prefer an exact-occurrence child whose value
        // is valid under its snapshot, so an invalid earlier child cannot poison a
        // later valid answer. If no such child exists, retain the old first-child
        // fallback so a rejected legacy answer does not erase the authored action.
        // Deferred children never supply payloads to non-input action construction.
        let mut legacy_input_action_ids = HashSet::<String>::new();
        let mut legacy_input_occurrences = HashSet::<(String, String, String, String)>::new();
        for position in 0..turn_count {
            let turn = load_turn(&mut tx, import_id, position).await?;
            let Some(view) = turn.accepted_view else {
                continue;
            };
            for resolved in view.layers {
                for action in resolved.actions {
                    if action.kind == "input" && action.input.is_none() {
                        legacy_input_action_ids.insert(action.id.clone());
                        legacy_input_occurrences.insert((
                            view.interaction_node_id.clone(),
                            resolved.layer.id.clone(),
                            action.id,
                            action.source_node_id,
                        ));
                    }
                }
            }
        }
        let mut input_action_snapshots = HashMap::<String, InputAction>::new();
        let mut legacy_fallback_snapshots = HashMap::<String, InputAction>::new();
        for position in 0..turn_count {
            let turn = load_turn(&mut tx, import_id, position).await?;
            for submitted in turn.submitted_inputs {
                let chronology_is_valid = interaction_turn_positions
                    .get(&submitted.source.interaction_node_id)
                    .is_some_and(|&presenting_position| presenting_position < position);
                let occurrence = (
                    submitted.source.interaction_node_id,
                    submitted.source.layer_id,
                    submitted.source.action_id.clone(),
                    submitted.source.node_id,
                );
                if submitted.root_turn_id == turn.source_turn_id
                    && legacy_input_action_ids.contains(&submitted.source.action_id)
                {
                    legacy_fallback_snapshots
                        .entry(submitted.source.action_id.clone())
                        .or_insert_with(|| submitted.action.clone());
                    if chronology_is_valid
                        && legacy_input_occurrences.contains(&occurrence)
                        && validate_value(0, &submitted.action, &submitted.value).is_ok()
                    {
                        input_action_snapshots
                            .entry(submitted.source.action_id)
                            .or_insert(submitted.action);
                    }
                }
            }
        }
        for (action_id, snapshot) in legacy_fallback_snapshots {
            input_action_snapshots.entry(action_id).or_insert(snapshot);
        }
        let mut action_definitions = HashMap::<String, ImportedAction>::new();
        let mut action_ids = HashMap::<String, i64>::new();
        let context = InsertContext {
            metadata: &metadata,
            nodes: &node_ids,
            layers: &layer_ids,
            response_layers: &response_layer_ids,
            input_actions: &input_action_snapshots,
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
                    if !resolved.layer.nodes.contains(&action.source_node_id)
                        || (action.source_layer_id.is_none() && action.kind != "navigate")
                    {
                        return Err(GraphError::validation(
                            "imported_action_occurrence_invalid",
                            "actions",
                            "Imported node action must belong to its containing occurrence; only navigation can omit source-layer provenance.",
                        ));
                    }
                    if let Some(existing) = action_definitions.get(&action.id) {
                        if existing != &action {
                            return Err(GraphError::validation(
                                "imported_action_snapshot_mismatch",
                                "actions",
                                "Repeated imported action identities must retain one exact snapshot.",
                            ));
                        }
                    } else {
                        action_definitions.insert(action.id.clone(), action.clone());
                    }
                    if !action_ids.contains_key(&action.id) {
                        insert_action(&mut tx, &context, owner, &action, false, &mut action_ids)
                            .await?;
                    }
                }
            }
        }

        // Standalone bound definitions preserve controls without inventing display membership.
        for action in &metadata.standalone_inputs {
            if action.kind != "input"
                || action.input.is_none()
                || !action.input_action_ids.is_empty()
            {
                return Err(GraphError::validation(
                    "imported_bound_input_invalid",
                    "standaloneInputs",
                    "Standalone bound definitions must be input controls.",
                ));
            }
            if let Some(existing) = action_definitions.get(&action.id) {
                if existing != action {
                    return Err(GraphError::validation(
                        "imported_bound_input_mismatch",
                        "standaloneInputs",
                        "Repeated input definitions must preserve their exact snapshot.",
                    ));
                }
                continue;
            }
            // An unpublished source may exist only in frozen call evidence.
            // Preserve its definition in inert metadata, without fabricating a Node.
            let Some(&owner) = node_owners.get(&action.source_node_id) else {
                continue;
            };
            let mut canonical = action.clone();
            if canonical
                .source_layer_id
                .as_ref()
                .is_some_and(|id| !context.layers.contains_key(id))
            {
                canonical.source_layer_id = None;
            }
            if let Some(icon) = canonical
                .icon
                .as_deref()
                .and_then(super::model::image_icon::image_icon)
            {
                let asset = canonical.icon_asset.as_ref().ok_or_else(|| {
                    GraphError::validation(
                        "import_icon_pin_missing",
                        "standaloneInputs.icon",
                        "Imported bound input image icon requires pinned content.",
                    )
                })?;
                super::model::image_icon::canonical_icon(canonical.icon.as_ref().unwrap())?;
                if asset.asset_id != icon.asset_id
                    || icon.digest_sha256.as_deref() != Some(&asset.digest_sha256)
                    || icon.media_type.as_deref() != Some(&asset.media_type)
                {
                    return Err(GraphError::validation(
                        "import_icon_pin_mismatch",
                        "standaloneInputs.icon",
                        "Bound input icon does not match its frozen pin.",
                    ));
                }
                let (media_type, byte_length) = AuthoredDetailAssetTable::new(&mut tx)
                    .materialize_import_content(import_id, &asset.digest_sha256)
                    .await?;
                if media_type != asset.media_type || byte_length != asset.byte_length {
                    return Err(GraphError::validation(
                        "import_asset_content_mismatch",
                        "standaloneInputs.iconAsset",
                        "Bound input icon does not match staged bytes.",
                    ));
                }
                let source_node = NodeId::new(context.nodes[&canonical.source_node_id]).unwrap();
                AuthoredDetailAssetTable::new(&mut tx)
                    .insert_import_icon_reference(source_node, asset)
                    .await?;
                let conflict: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM (SELECT * FROM authored_detail_assets UNION ALL SELECT * FROM graph_icon_assets) WHERE node_id=?1 AND asset_id=?2 AND (digest_sha256<>?3 OR media_type<>?4 OR byte_length<>?5))")
                    .bind(source_node.value()).bind(&asset.asset_id).bind(&asset.digest_sha256).bind(&asset.media_type).bind(asset.byte_length as i64).fetch_one(&mut *tx).await?;
                if conflict {
                    return Err(GraphError::validation(
                        "import_asset_pin_conflict",
                        "standaloneInputs.iconAsset",
                        "An existing Node icon association must preserve exact bytes.",
                    ));
                }
            } else if canonical.icon_asset.is_some() {
                return Err(GraphError::validation(
                    "import_icon_asset_unexpected",
                    "standaloneInputs.iconAsset",
                    "Bound input icon content requires an image icon pin.",
                ));
            }
            insert_action(&mut tx, &context, owner, &canonical, false, &mut action_ids).await?;
            action_definitions.insert(action.id.clone(), action.clone());
        }

        // Bindings describe inert controls only. Imported scopes remain read_only,
        // author_eligible=0; require_native_provenance rejects these actions before
        // any Invocation preparation. No durable_invocations or capability is created.
        // Resolve after all fresh action IDs exist, including forward references.
        for action in action_definitions.values() {
            if !action.input_action_ids.is_empty() && action.kind != "invoke" {
                return Err(GraphError::validation(
                    "imported_invoke_binding_invalid",
                    "inputActionIds",
                    "Only an Invoke may bind input actions.",
                ));
            }
            let mut seen = HashSet::new();
            for (position, input_id) in action.input_action_ids.iter().enumerate() {
                let input = action_definitions.get(input_id).ok_or_else(|| {
                    GraphError::validation(
                        "imported_invoke_binding_missing",
                        "inputActionIds",
                        "Bound input must be included in the imported graph.",
                    )
                })?;
                if !seen.insert(input_id)
                    || input.kind != "input"
                    || input.source_node_id != action.source_node_id
                {
                    return Err(GraphError::validation(
                        "imported_invoke_binding_invalid",
                        "inputActionIds",
                        "Bind distinct input actions on the same Node.",
                    ));
                }
                sqlx::query("INSERT INTO imported_invoke_input_bindings(invoke_action_id,input_action_id,position) VALUES (?1,?2,?3)")
                    .bind(action_ids[&action.id]).bind(action_ids[input_id]).bind(position as i64)
                    .execute(&mut *tx).await?;
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
            let root_layer = layer_ids[&view.root_layer_id];
            sqlx::query(
                "INSERT INTO completion_states(interaction_node_id,lifecycle,head_revision,current_layer_id,final_layer_id) VALUES (?1,'succeeded',1,?2,?2)",
            )
            .bind(root)
            .bind(root_layer)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                "INSERT INTO current_revisions(interaction_node_id,revision,transition,base_revision,current_layer_id,lifecycle) VALUES (?1,0,'initial',NULL,NULL,'active')",
            )
            .bind(root)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                "INSERT INTO current_revisions(interaction_node_id,revision,transition,base_revision,current_layer_id,lifecycle,operation_key,request_digest,snapshot_digest) VALUES (?1,1,'return',0,?2,'succeeded','imported-flat-return','imported-flat-return','imported-accepted-closure')",
            )
            .bind(root)
            .bind(root_layer)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                "INSERT INTO completion_authorities(interaction_node_id,author_eligible,read_entitlement,read_entitlement_digest,authority_epoch) VALUES (?1,0,'imported-read-only','imported',0)",
            )
            .bind(root)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                "INSERT INTO graph_projection_outbox(interaction_node_id,revision,event_kind) VALUES (?1,0,'initialized'),(?1,1,'returned')",
            )
            .bind(root)
            .execute(&mut *tx)
            .await?;
            let receipt = &mut receipts[usize::try_from(position).unwrap()];
            receipt.root_layer_id = Some(layer_ids[&view.root_layer_id]);
            receipt.root_action_id = Some(action_ids[&view.root_action.id]);
        }

        // Submitted-input provenance has to resolve as one exact accepted occurrence,
        // which needs layer membership and completions to already exist -- hence this
        // runs after both. Checking the interaction, layer, action, and node IDs
        // independently would accept individually valid IDs spliced into provenance
        // that never happened. An occurrence that will not resolve drops that one
        // answer and leaves the rest of the conversation importable.
        let mut skipped_submitted_inputs = Vec::new();
        for position in 0..turn_count {
            let turn = load_turn(&mut tx, import_id, position).await?;
            if turn.submitted_inputs.is_empty() {
                continue;
            }
            let portable_parent = turn.interaction_node_id.as_ref().ok_or_else(|| {
                GraphError::Internal(
                    "imported submitted input turn is missing its interaction root".into(),
                )
            })?;
            let parent = *node_ids.get(portable_parent).ok_or_else(|| {
                GraphError::Internal("imported submitted input root was not materialized".into())
            })?;
            let scope = InteractionScope {
                project_id: metadata.project_id,
                thread_id: metadata.thread_id,
                root_node_id: imported_node_id(parent)?,
                read_only: false,
                authority_epoch: None,
            };
            let mut child_position = 0i64;
            let mut accepted_occurrences = HashSet::new();
            for (index, submitted) in turn.submitted_inputs.iter().enumerate() {
                let resolved = resolve_imported_input_occurrence(
                    &mut tx,
                    &scope,
                    &turn.source_turn_id,
                    index,
                    submitted,
                    &MaterializedImportIds {
                        nodes: &node_ids,
                        layers: &layer_ids,
                        actions: &action_ids,
                    },
                )
                .await?;
                let resolution = match resolved {
                    ImportedInputResolution::Resolved(resolution) => resolution,
                    ImportedInputResolution::Rejected(rejection) => {
                        skipped_submitted_inputs.push(SkippedSubmittedInput {
                            source_turn_id: turn.source_turn_id.clone(),
                            submitted_input_id: submitted.id.clone(),
                            code: rejection.code.to_owned(),
                            path: rejection.path,
                            message: rejection.message,
                        });
                        continue;
                    }
                };
                let Some(&presenting_position) =
                    interaction_turn_positions.get(&submitted.source.interaction_node_id)
                else {
                    skipped_submitted_inputs.push(SkippedSubmittedInput {
                        source_turn_id: turn.source_turn_id.clone(),
                        submitted_input_id: submitted.id.clone(),
                        code: "input_occurrence_not_visible".to_owned(),
                        path: format!("submittedInputs[{index}].source.interactionNodeId"),
                        message: "The presenting input occurrence does not belong to an accepted imported turn.".into(),
                    });
                    continue;
                };
                if presenting_position >= position {
                    skipped_submitted_inputs.push(SkippedSubmittedInput {
                        source_turn_id: turn.source_turn_id.clone(),
                        submitted_input_id: submitted.id.clone(),
                        code: "input_occurrence_not_visible".to_owned(),
                        path: format!("submittedInputs[{index}].source.interactionNodeId"),
                        message: "The presenting input occurrence must belong to an earlier imported turn.".into(),
                    });
                    continue;
                }
                let occurrence = (
                    resolution.presenting_interaction_node_id,
                    resolution.presenting_layer_id,
                    resolution.action_id,
                );
                if !accepted_occurrences.insert(occurrence) {
                    skipped_submitted_inputs.push(SkippedSubmittedInput {
                        source_turn_id: turn.source_turn_id.clone(),
                        submitted_input_id: submitted.id.clone(),
                        code: "input_attachment_duplicate".to_owned(),
                        path: format!("submittedInputs[{index}].source"),
                        message: "A consuming turn may answer an exact presenting input occurrence only once.".into(),
                    });
                    continue;
                }
                sqlx::query(
                    "INSERT INTO interaction_input_children(parent_interaction_node_id,position,presenting_interaction_node_id,presenting_layer_id,action_id,source_node_id,action_snapshot_json,value_snapshot_json,attempt_key,authority_digest,semantic_digest) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'authority-stripped','semantic-read-only')",
                )
                .bind(parent)
                .bind(child_position)
                .bind(resolution.presenting_interaction_node_id)
                .bind(resolution.presenting_layer_id)
                .bind(resolution.action_id)
                .bind(resolution.source_node_id)
                .bind(serde_json::to_string(&submitted.action).map_err(|error| GraphError::Internal(error.to_string()))?)
                .bind(serde_json::to_string(&resolution.value).map_err(|error| GraphError::Internal(error.to_string()))?)
                .bind(format!("imported-inert:{position}"))
                .execute(&mut *tx)
                .await?;
                child_position += 1;
            }
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
            let source_action = source_turn.accepted_view.as_ref().and_then(|source_view| {
                source_view
                    .layers
                    .iter()
                    .flat_map(|layer| &layer.actions)
                    .find(|action| action.id == origin.source_action_id)
            });
            if !source_action
                .is_some_and(|action| action.kind == "invoke" || action.converted_from_invoke)
            {
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
            if let Some(action) = source_action.filter(|action| action.converted_from_invoke) {
                if action.target_layer_id.as_ref() != Some(&view.root_layer_id) {
                    return Err(GraphError::validation(
                        "imported_conversion_target_mismatch",
                        "invokeOrigin",
                        "Converted invoke navigation must retain the exact invoked result root.",
                    ));
                }
                continue;
            }
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
        // Accepted associations now own the verified content. Reclaim only this
        // import's staging copy in the same transaction, so failures retain all
        // staged bytes for retry while graph_imports keeps its ownership record.
        // Header-only Current snapshots have no executable node asset owner.
        // Preserve their exact pinned bytes in inert history before reclaiming staging.
        sqlx::query("INSERT INTO inert_import_asset_contents(import_id,digest_sha256,media_type,byte_length,content) SELECT import_id,digest_sha256,media_type,byte_length,content FROM graph_import_asset_contents WHERE import_id=?1 AND digest_sha256 IN (SELECT pins.value FROM graph_imports imported,json_tree(imported.inert_invocations_json) pins WHERE imported.import_id=?1 AND pins.key='digestSha256' AND pins.type='text' UNION SELECT pins.value FROM graph_imports imported,json_tree(imported.standalone_inputs_json) pins WHERE imported.import_id=?1 AND pins.key='digestSha256' AND pins.type='text')")
            .bind(import_id).execute(&mut *tx).await?;
        sqlx::query("DELETE FROM graph_import_asset_contents WHERE import_id=?1")
            .bind(import_id)
            .execute(&mut *tx)
            .await?;
        // An import is an accept path like any other, so its closures reach the
        // search store before SQLite commits. The whole conversation goes in as
        // one search transaction carrying one revision: the turns were authored
        // together and there is no point at which a partial import is meaningful.
        let mut closures = Vec::new();
        for receipt in &receipts {
            let Some(node_id) = receipt.graph_node_id else {
                continue;
            };
            let node_id = crate::NodeId::new(node_id)
                .ok_or_else(|| GraphError::Internal("invalid imported root node ID".into()))?;
            let scope = InteractionScope {
                project_id: metadata.project_id,
                thread_id: metadata.thread_id,
                root_node_id: node_id,
                read_only: false,
                authority_epoch: None,
            };
            if let Some(closure) =
                completion::read_accepted_closure_on(&mut tx, &scope, node_id).await?
            {
                closures.push(closure.into());
            }
        }
        let indexed = !closures.is_empty();
        if indexed
            && let Err(error) = completion::index_and_record(
                self,
                &mut tx,
                target,
                closures
                    .into_iter()
                    .map(|closure| {
                        (
                            closure,
                            crate::publication_targets(metadata.project_id, metadata.thread_id),
                        )
                    })
                    .collect(),
                self.import_expiry(),
            )
            .await
        {
            tx.rollback().await?;
            return Err(error);
        }
        if indexed {
            self.commit_indexed_write(tx, target).await?;
        } else {
            tx.commit().await?;
        }
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
            skipped_submitted_inputs,
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
            inert_invocations: Vec::new(),
            standalone_inputs: Vec::new(),
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
        let target_and_thread = {
            let mut connection = self.storage.acquire().await?;
            ImportTable::new(&mut connection)
                .removal_target(import_id)
                .await?
        };
        let Some((target, thread_id)) = target_and_thread else {
            return Ok(());
        };
        let _order = self.order_writes_to(target).await;
        let _publication = self.enter_search_publication().await;
        let mut tx = self.storage.begin_write().await?;
        let mut indexed = false;
        let current_ids = ImportTable::new(&mut tx)
            .prepare_removal(import_id, thread_id)
            .await?;
        if let Some(current_ids) = current_ids {
            let mut publications = Vec::with_capacity(current_ids.len());
            for node_id in current_ids {
                let scope = crate::storage::sqlite::nodes::NodeTable::new(&mut tx)
                    .interaction_scope(node_id)
                    .await?;
                let output = completion::read_output_on(&mut tx, &scope)
                    .await?
                    .ok_or_else(|| {
                        GraphError::Internal("imported completion output is missing".into())
                    })?;
                publications.push(
                    completion::read_accepted_publication_on(
                        &mut tx,
                        &scope,
                        output.root_layer.layer.id,
                        Some(output.root_action),
                    )
                    .await?,
                );
            }
            ImportTable::new(&mut tx)
                .delete_canonical(import_id, thread_id)
                .await?;
            // Exercise every canonical foreign-key boundary before the first
            // derived deletion. These SQLite writes remain uncommitted while
            // Ladybug removes the same publications; a derived failure rolls
            // this transaction back, while a canonical dependency can never
            // leave Ladybug ahead of a deletion SQLite refused.
            if !publications.is_empty() {
                completion::remove_from_index_and_record(
                    self,
                    &mut tx,
                    target,
                    publications,
                    self.import_expiry(),
                )
                .await?;
                indexed = true;
            }
        }
        if indexed {
            self.commit_indexed_write(tx, target).await?;
        } else {
            tx.commit().await?;
        }
        Ok(())
    }
}

/// Stores imported routes against the imported records' new IDs, as the layer read expects.
fn imported_routes(
    layout: Option<&ImportedLayerLayout>,
    node_ids: &HashMap<String, i64>,
    edge_ids: &HashMap<String, i64>,
) -> Result<Option<String>, GraphError> {
    let Some(layout) = layout.filter(|layout| !layout.edge_routes.is_empty()) else {
        return Ok(None);
    };
    let node = |id: &str| {
        NodeId::new(node_ids[id])
            .ok_or_else(|| GraphError::Internal("invalid imported node".into()))
    };
    let routes = layout
        .edge_routes
        .iter()
        .map(|route| {
            Ok(EdgeRoute {
                edge_id: EdgeId::new(edge_ids[&route.edge_id])
                    .ok_or_else(|| GraphError::Internal("invalid imported edge".into()))?,
                shape: route.shape.clone(),
                ends: route
                    .ends
                    .iter()
                    .map(|end| {
                        Ok(EdgeEnd {
                            node_id: node(&end.node_id)?,
                            side: end.side.clone(),
                        })
                    })
                    .collect::<Result<_, GraphError>>()?,
                waypoints: route.waypoints.clone(),
            })
        })
        .collect::<Result<Vec<_>, GraphError>>()?;
    crate::storage::sqlite::layers::stored_routes(
        &LayerLayout::v1(Vec::new(), "default").with_edge_routes(routes),
    )
}

fn validate_imported_routes(
    layer: &ImportedLayer,
    layout: &ImportedLayerLayout,
    edges: &[ImportedEdge],
) -> Result<(), GraphError> {
    let invalid = |reason: &str| {
        Err(GraphError::Internal(format!(
            "imported layer {} has an invalid edge route: {reason}",
            layer.id
        )))
    };
    let mut routed = HashSet::new();
    for route in &layout.edge_routes {
        let Some(edge) = edges
            .iter()
            .find(|edge| edge.id == route.edge_id && layer.edges.contains(&edge.id))
        else {
            return invalid("edge outside the layer");
        };
        if !routed.insert(route.edge_id.as_str()) {
            return invalid("duplicate route");
        }
        if route
            .shape
            .as_ref()
            .is_some_and(|shape| !EDGE_SHAPES.contains(&shape.as_str()))
        {
            return invalid("unsupported shape");
        }
        if !route.ends.is_empty() {
            let mut ends = route
                .ends
                .iter()
                .map(|end| end.node_id.as_str())
                .collect::<Vec<_>>();
            let mut endpoints = edge
                .endpoints
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>();
            ends.sort_unstable();
            endpoints.sort_unstable();
            if ends != endpoints {
                return invalid("ends are not the edge's two nodes");
            }
        }
        if route.ends.iter().any(|end| {
            end.side
                .as_ref()
                .is_some_and(|side| !NODE_SIDES.contains(&side.as_str()))
        }) {
            return invalid("unsupported side");
        }
        if (!route.waypoints.is_empty() && route.ends.is_empty())
            || route.waypoints.len() > MAX_EDGE_ROUTE_WAYPOINTS
            || route.waypoints.iter().any(|point| {
                ![point.x, point.y]
                    .iter()
                    .all(|value| value.is_finite() && (0.0..=1.0).contains(value))
            })
        {
            return invalid("invalid waypoints");
        }
    }
    Ok(())
}

fn validate_imported_layout(
    layer: &ImportedLayer,
    edges: &[ImportedEdge],
) -> Result<(), GraphError> {
    if layer
        .default_node_id
        .as_ref()
        .is_some_and(|id| !layer.nodes.contains(id))
    {
        return Err(GraphError::validation(
            "default_node_outside_layer",
            "defaultNodeId",
            "Imported default node must belong to its layer.",
        ));
    }
    let Some(layout) = &layer.layout else {
        return Ok(());
    };
    if layout.version != 1 {
        return Err(GraphError::Internal(format!(
            "imported layer {} has unsupported layout version {}",
            layer.id, layout.version
        )));
    }
    if let Some(shape) = &layout.edge_shape
        && !EDGE_SHAPES.contains(&shape.as_str())
    {
        return Err(GraphError::Internal(format!(
            "imported layer {} has unsupported edge shape {shape:?}",
            layer.id
        )));
    }
    validate_imported_routes(layer, layout, edges)?;
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
    let row = sqlx::query("SELECT source_sha256,project_id,thread_id,created_at,inert_invocations_json,standalone_inputs_json FROM graph_imports WHERE import_id=?1").bind(import_id).fetch_one(&mut **tx).await?;
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
        inert_invocations: serde_json::from_str(&sqlx::Row::try_get::<String, _>(&row, 4)?)
            .map_err(|error| GraphError::Internal(error.to_string()))?,
        standalone_inputs: serde_json::from_str(&sqlx::Row::try_get::<String, _>(&row, 5)?)
            .map_err(|error| GraphError::Internal(error.to_string()))?,
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
    mut node: ImportedNode,
) -> Result<(), GraphError> {
    if let Some(existing) = definitions.get_mut(&node.id) {
        let incoming_client_key = node.client_key.take();
        let existing_client_key = existing.client_key.take();
        let incoming_authored_detail = node.authored_detail.take();
        let existing_authored_detail = existing.authored_detail.take();
        // Context snapshots omit artifact details too; the accepted view's copy carries them.
        let incoming_artifact = node.artifact.take();
        let existing_artifact = existing.artifact.take();
        let incoming_assets = std::mem::take(&mut node.authored_detail_assets);
        let existing_assets = std::mem::take(&mut existing.authored_detail_assets);
        // Context snapshots omit authored keys, packages and omission markers.
        // Preserve the accepted-view metadata without weakening semantic identity.
        let incoming_omitted = std::mem::take(&mut node.authored_detail_omitted);
        let existing_omitted = std::mem::take(&mut existing.authored_detail_omitted);
        if existing != &node
            || matches!((&existing_client_key, &incoming_client_key), (Some(left), Some(right)) if left != right)
            || incoming_assets.iter().any(|incoming| {
                existing_assets
                    .iter()
                    .any(|existing| existing.asset_id == incoming.asset_id && existing != incoming)
            })
            || matches!(
                (&existing_authored_detail, &incoming_authored_detail),
                (Some(left), Some(right)) if left != right
            )
            || matches!(
                (&existing_artifact, &incoming_artifact),
                (Some(left), Some(right)) if left != right
            )
        {
            existing.client_key = existing_client_key;
            existing.authored_detail = existing_authored_detail;
            existing.artifact = existing_artifact;
            existing.authored_detail_omitted = existing_omitted;
            existing.authored_detail_assets = existing_assets;
            return Err(GraphError::Internal(
                "imported node snapshot changed for one portable ID".into(),
            ));
        }
        existing.client_key = existing_client_key.or(incoming_client_key);
        existing.authored_detail = existing_authored_detail.or(incoming_authored_detail);
        existing.artifact = existing_artifact.or(incoming_artifact);
        existing.authored_detail_assets = existing_assets;
        for incoming in incoming_assets {
            if !existing
                .authored_detail_assets
                .iter()
                .any(|asset| asset.asset_id == incoming.asset_id)
            {
                existing.authored_detail_assets.push(incoming);
            }
        }
        existing.authored_detail_omitted =
            (existing_omitted || incoming_omitted) && existing.authored_detail.is_none();
        return Ok(());
    }
    definitions.insert(node.id.clone(), node);
    Ok(())
}

fn imported_source_layer_key(
    node: &ImportedNode,
    action: &ImportedAction,
) -> Result<Option<String>, GraphError> {
    let Some(mounts) = node
        .authored_detail
        .as_ref()
        .and_then(|package| package["mounts"].as_array())
    else {
        return Ok(None);
    };
    let mut key: Option<String> = None;
    for mount in mounts {
        let binding = &mount["capability"]["action"];
        if binding["clientKey"].as_str() != Some(action.client_key.as_deref().unwrap_or(&action.id))
            || binding["sourceNode"]["clientKey"].as_str()
                != Some(node.client_key.as_deref().unwrap_or(&node.id))
        {
            continue;
        }
        let Some(incoming) = binding["sourceLayer"]["clientKey"].as_str() else {
            continue;
        };
        if key.as_ref().is_some_and(|existing| existing != incoming) {
            return Err(GraphError::validation(
                "imported_source_layer_key_conflict",
                "authoredDetail",
                "One imported action cannot bind conflicting source layer keys.",
            ));
        }
        key = Some(incoming.to_owned());
    }
    Ok(key)
}

struct InsertContext<'a> {
    metadata: &'a ImportedConversationStage,
    nodes: &'a HashMap<String, i64>,
    layers: &'a HashMap<String, i64>,
    response_layers: &'a HashSet<String>,
    input_actions: &'a HashMap<String, InputAction>,
}

async fn insert_action(
    tx: &mut sqlx::Transaction<'static, sqlx::Sqlite>,
    context: &InsertContext<'_>,
    owner: i64,
    action: &ImportedAction,
    response: bool,
    ids: &mut HashMap<String, i64>,
) -> Result<(), GraphError> {
    if response && !action.input_action_ids.is_empty() {
        return Err(GraphError::validation(
            "imported_invoke_binding_invalid",
            "inputActionIds",
            "Response navigation cannot bind inputs.",
        ));
    }
    if action.converted_from_invoke
        && (response
            || action.kind != "navigate"
            || action.relation.as_deref() != Some("expand")
            || action.target_layer_id.is_none()
            || action.interaction_text.is_some()
            || action.input.is_some())
    {
        return Err(GraphError::validation(
            "imported_conversion_invalid",
            "convertedFromInvoke",
            "Converted invoke history requires an accepted node-owned expand navigation action.",
        ));
    }
    let source_node = context.nodes.get(&action.source_node_id).ok_or_else(|| {
        GraphError::validation(
            "imported_action_source_missing",
            "sourceNodeId",
            "Imported action source node is not materialized.",
        )
    })?;
    let source_layer = action
        .source_layer_id
        .as_ref()
        .map(|id| {
            context.layers.get(id).copied().ok_or_else(|| {
                GraphError::validation(
                    "imported_action_source_missing",
                    "sourceLayerId",
                    "Imported action source layer is not materialized.",
                )
            })
        })
        .transpose()?;
    if action
        .target_layer_id
        .as_ref()
        .is_some_and(|id| !context.response_layers.contains(id))
    {
        return Err(GraphError::validation(
            "imported_action_target_missing",
            "targetLayerId",
            "Imported navigation cannot target provenance-only or missing layers.",
        ));
    }
    let target_layer = action
        .target_layer_id
        .as_ref()
        .map(|id| {
            context.layers.get(id).copied().ok_or_else(|| {
                GraphError::validation(
                    "imported_action_target_missing",
                    "targetLayerId",
                    "Imported action target must name a materialized response layer.",
                )
            })
        })
        .transpose()?;
    let consumed_snapshot = context.input_actions.get(&action.id);
    // Older draft exports carried the action snapshot only on a consuming child.
    // Keep that additive shape readable when an answer exists, while current
    // exports carry the authored payload on the action so unanswered questions
    // round-trip too.
    let input = action.input.as_ref().or(consumed_snapshot);
    if (action.kind == "input") != input.is_some() {
        return Err(GraphError::Internal(
            "imported input action is missing or conflicts with its frozen child snapshot".into(),
        ));
    }
    let input_options_json = input
        .map(|input| serde_json::to_string(&input.options))
        .transpose()
        .map_err(|error| GraphError::Internal(error.to_string()))?;
    let result = sqlx::query("INSERT INTO actions(project_id,thread_id,source_node_id,source_layer_id,kind,relation,label,variant,icon,description,target_layer_id,interaction_text,response,state,owner_interaction_id,client_key,reusable) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,'accepted',?14,?15,?16)")
        .bind(context.metadata.project_id.map(ProjectId::value)).bind(context.metadata.thread_id.value())
        .bind(source_node).bind(source_layer)
        .bind(&action.kind).bind(&action.relation).bind(&action.label).bind(&action.variant).bind(&action.icon).bind(&action.description)
        .bind(target_layer).bind(&action.interaction_text)
        .bind(response).bind(owner).bind(action.client_key.as_deref().unwrap_or(&action.id))
        .bind(action.reusable)
        .execute(&mut **tx).await?;
    let action_id = result.last_insert_rowid();
    if action.converted_from_invoke {
        sqlx::query("INSERT INTO imported_action_conversions(action_id,import_id,target_layer_id) SELECT ?1,import_id,?2 FROM graph_imports WHERE thread_id=?3")
            .bind(action_id).bind(target_layer)
            .bind(context.metadata.thread_id.value()).execute(&mut **tx).await?;
    }
    if let Some(input) = input {
        sqlx::query("INSERT INTO input_action_payloads(action_id,control,prompt,options_json,minimum_selections) VALUES (?1,?2,?3,?4,?5)")
            .bind(action_id)
            .bind(input.control.as_str())
            .bind(&input.prompt)
            .bind(input_options_json.expect("input options serialized"))
            .bind(input.minimum_selections.map(|minimum| minimum as i64))
            .execute(&mut **tx)
            .await?;
    }
    ids.insert(action.id.clone(), action_id);
    Ok(())
}

/// Materialized identifiers for one imported submitted input, with the asking node
/// taken from the accepted action rather than from the imported file.
struct ResolvedImportedInput {
    presenting_interaction_node_id: i64,
    presenting_layer_id: i64,
    action_id: i64,
    source_node_id: i64,
    value: SubmittedInputValue,
}

/// The identifier maps built while materializing one imported conversation.
struct MaterializedImportIds<'a> {
    nodes: &'a HashMap<String, i64>,
    layers: &'a HashMap<String, i64>,
    actions: &'a HashMap<String, i64>,
}

enum ImportedInputResolution {
    Resolved(ResolvedImportedInput),
    Rejected(ImportedInputRejection),
}

struct ImportedInputRejection {
    code: &'static str,
    path: String,
    message: String,
}

impl ImportedInputRejection {
    fn new(code: &'static str, path: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code,
            path: path.into(),
            message: message.into(),
        }
    }
}

/// Proves one imported submitted input against the materialized graph.
///
/// `canonical_input_occurrence` is the same authority the live send path uses, so
/// import cannot drift from it: the presenting layer must be reachable from that
/// interaction's accepted root, the action must belong to that layer, and the source
/// node is derived from the action, and the value must satisfy that accepted action under
/// the same `validate_value` the live path applies, so an honest occurrence cannot carry an
/// answer the question never offered. A rejection names the reason and never fails the
/// surrounding import.
async fn resolve_imported_input_occurrence(
    connection: &mut sqlx::SqliteConnection,
    scope: &InteractionScope,
    source_turn_id: &str,
    index: usize,
    submitted: &ImportedSubmittedInput,
    ids: &MaterializedImportIds<'_>,
) -> Result<ImportedInputResolution, GraphError> {
    let source_path = format!("submittedInputs[{index}].source");
    if submitted.root_turn_id != source_turn_id {
        return Ok(ImportedInputResolution::Rejected(
            ImportedInputRejection::new(
                "input_occurrence_not_visible",
                format!("submittedInputs[{index}].rootTurnId"),
                "The submitted input names a different root turn.",
            ),
        ));
    }
    let (
        Some(&presenting_interaction_node_id),
        Some(&presenting_layer_id),
        Some(&action_id),
        Some(&claimed_source_node_id),
    ) = (
        ids.nodes.get(&submitted.source.interaction_node_id),
        ids.layers.get(&submitted.source.layer_id),
        ids.actions.get(&submitted.source.action_id),
        ids.nodes.get(&submitted.source.node_id),
    )
    else {
        return Ok(ImportedInputResolution::Rejected(
            ImportedInputRejection::new(
                "input_occurrence_not_visible",
                source_path.clone(),
                "The submitted input provenance names a record that was not materialized.",
            ),
        ));
    };
    let occurrence = PresentingInputOccurrence {
        presenting_interaction_node_id: imported_node_id(presenting_interaction_node_id)?,
        presenting_layer_id: imported_layer_id(presenting_layer_id)?,
        action_id: imported_action_id(action_id)?,
    };
    let accepted = match ActionTable::new(connection)
        .canonical_input_occurrence(scope, &occurrence, true)
        .await
    {
        Ok(accepted) => accepted,
        Err(GraphError::Validation {
            code,
            path,
            message,
        }) => {
            return Ok(ImportedInputResolution::Rejected(
                ImportedInputRejection::new(code, imported_occurrence_path(index, &path), message),
            ));
        }
        Err(error) => return Err(error),
    };
    if accepted.kind != ActionKind::Input || accepted.input.as_ref() != Some(&submitted.action) {
        return Ok(ImportedInputResolution::Rejected(
            ImportedInputRejection::new(
                "input_action_snapshot_mismatch",
                format!("submittedInputs[{index}].action"),
                "The submitted input action snapshot does not match the accepted action.",
            ),
        ));
    }
    if accepted.source_node_id.value() != claimed_source_node_id {
        return Ok(ImportedInputResolution::Rejected(
            ImportedInputRejection::new(
                "input_action_not_in_occurrence",
                format!("submittedInputs[{index}].source.nodeId"),
                "The submitted input names a source node that did not author the action.",
            ),
        ));
    }
    let Some(accepted_action) = accepted.input.as_ref() else {
        return Ok(ImportedInputResolution::Rejected(
            ImportedInputRejection::new(
                "input_action_not_in_occurrence",
                source_path,
                "The submitted input provenance is not one accepted input occurrence.",
            ),
        ));
    };
    let value = match validate_value(index, accepted_action, &submitted.value) {
        Ok(value) => value,
        Err(GraphError::Validation {
            code,
            path,
            message,
        }) => {
            let path = path.replacen(
                &format!("attachments[{index}]"),
                &format!("submittedInputs[{index}]"),
                1,
            );
            return Ok(ImportedInputResolution::Rejected(
                ImportedInputRejection::new(code, path, message),
            ));
        }
        Err(error) => return Err(error),
    };
    Ok(ImportedInputResolution::Resolved(ResolvedImportedInput {
        presenting_interaction_node_id,
        presenting_layer_id,
        action_id,
        source_node_id: accepted.source_node_id.value(),
        value,
    }))
}

fn imported_occurrence_path(index: usize, canonical_path: &str) -> String {
    let source = format!("submittedInputs[{index}].source");
    match canonical_path {
        "occurrence.actionId" => format!("{source}.actionId"),
        "occurrence.presentingInteractionNodeId" => format!("{source}.interactionNodeId"),
        "occurrence.presentingLayerId" => format!("{source}.layerId"),
        "occurrence" => source,
        _ => source,
    }
}

fn imported_node_id(value: i64) -> Result<NodeId, GraphError> {
    NodeId::new(value)
        .ok_or_else(|| GraphError::Internal("imported node identifier is invalid".into()))
}

fn imported_layer_id(value: i64) -> Result<LayerId, GraphError> {
    LayerId::new(value)
        .ok_or_else(|| GraphError::Internal("imported layer identifier is invalid".into()))
}

fn imported_action_id(value: i64) -> Result<ActionId, GraphError> {
    ActionId::new(value)
        .ok_or_else(|| GraphError::Internal("imported action identifier is invalid".into()))
}
