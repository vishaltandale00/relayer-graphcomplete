//! Advisory draft previews (PRD §11.10).
//!
//! A successful `submitLayer`, or `submitNode` for a node with authored detail,
//! renders the caller's own draft through the render bridge the host
//! registered. The image never affects validation or acceptance: every failure
//! here becomes `status: "failed"` on an already-committed write.

use base64::Engine;
use relayer_graph_core::{GraphEdge, GraphLayer, GraphNode, GraphWriter, LayerId, NodeId};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::HashMap, sync::Mutex, time::Duration};

pub(crate) const DEFAULT_RENDER_LIMIT: u32 = 100;
/// Bounds the whole preview, including the wait for earlier renders, well
/// inside the 30 s client timeouts: a slow render must not look like a failed write.
const PREVIEW_DEADLINE: Duration = Duration::from_secs(20);
/// Keeps a write response, image included, inside the 4 MiB graph proxy limit.
const MAX_PNG_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum GraphPreviewCapability {
    #[default]
    Disabled,
    Enabled,
}

impl GraphPreviewCapability {
    pub(crate) fn is_disabled(&self) -> bool {
        *self == Self::Disabled
    }
}

#[derive(Debug, Clone)]
pub(crate) struct RenderBridge {
    pub(crate) url: String,
    pub(crate) token: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum PreviewTarget {
    #[serde(rename_all = "camelCase")]
    Layer { layer_id: LayerId },
    #[serde(rename_all = "camelCase")]
    Node { node_id: NodeId },
}

/// Everything the renderer needs, read with the caller's own authority. A node
/// target carries only that node; the renderer shows it as a one-node layer.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DraftSnapshot {
    version: u32,
    target: PreviewTarget,
    layer: Option<GraphLayer>,
    nodes: Vec<GraphNode>,
    edges: Vec<GraphEdge>,
    assets: Vec<SnapshotAsset>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotAsset {
    node_id: NodeId,
    id: String,
    digest_sha256: String,
    media_type: String,
    content_base64: String,
}

#[derive(Clone)]
struct RenderedImage {
    fingerprint: String,
    png_base64: String,
    width: u32,
    height: u32,
}

#[derive(Default)]
struct InteractionPreviews {
    renders: u32,
    latest: HashMap<PreviewTarget, RenderedImage>,
}

pub(crate) struct DraftPreviews {
    bridge: Mutex<Option<RenderBridge>>,
    /// Renders run one at a time; a burst of writes queues here.
    render_lock: tokio::sync::Mutex<()>,
    interactions: Mutex<HashMap<NodeId, InteractionPreviews>>,
    limit: u32,
    http_client: reqwest::Client,
}

impl DraftPreviews {
    pub(crate) fn new(limit: u32) -> Self {
        Self {
            bridge: Mutex::new(None),
            render_lock: tokio::sync::Mutex::new(()),
            interactions: Mutex::new(HashMap::new()),
            limit,
            http_client: reqwest::Client::builder()
                .timeout(PREVIEW_DEADLINE)
                .build()
                .expect("draft-preview HTTP client configuration is valid"),
        }
    }

    pub(crate) fn register(&self, bridge: RenderBridge) {
        *self
            .bridge
            .lock()
            .expect("draft-preview bridge mutex poisoned") = Some(bridge);
    }

    fn bridge(&self) -> Option<RenderBridge> {
        self.bridge
            .lock()
            .expect("draft-preview bridge mutex poisoned")
            .clone()
    }

    /// Drops an interaction's render count and cached images when its
    /// capability ends.
    pub(crate) fn forget(&self, interaction: NodeId) {
        self.interactions
            .lock()
            .expect("draft-preview state mutex poisoned")
            .remove(&interaction);
    }

    /// Returns the `preview` response field, or `None` when this run has no
    /// preview support, the host registered no renderer, or a node has no
    /// authored detail.
    pub(crate) async fn preview(
        &self,
        capability: GraphPreviewCapability,
        writer: &GraphWriter,
        target: PreviewTarget,
    ) -> Option<Value> {
        if capability != GraphPreviewCapability::Enabled {
            return None;
        }
        let bridge = self.bridge()?;
        tokio::time::timeout(
            PREVIEW_DEADLINE,
            self.preview_within_deadline(&bridge, writer, target),
        )
        .await
        .unwrap_or_else(|_| Some(json!({"status": "failed"})))
    }

    async fn preview_within_deadline(
        &self,
        bridge: &RenderBridge,
        writer: &GraphWriter,
        target: PreviewTarget,
    ) -> Option<Value> {
        let interaction = writer.node_id();
        let snapshot = match draft_snapshot(writer, target).await {
            Ok(Some(snapshot)) => snapshot,
            Ok(None) => return None,
            Err(()) => return Some(json!({"status": "failed"})),
        };
        let fingerprint = fingerprint(&snapshot);
        {
            let mut interactions = self
                .interactions
                .lock()
                .expect("draft-preview state mutex poisoned");
            let previews = interactions.entry(interaction).or_default();
            if let Some(image) = previews
                .latest
                .get(&target)
                .filter(|image| image.fingerprint == fingerprint)
            {
                return Some(image_response("cached", image));
            }
            if previews.renders >= self.limit {
                return Some(json!({"status": "limit_reached"}));
            }
            previews.renders += 1;
        }
        let rendered = {
            // Renders run one at a time; cached and plain writes never wait here.
            let _serialized = self.render_lock.lock().await;
            self.render(bridge, interaction, &snapshot, fingerprint)
                .await
        };
        let Some(image) = rendered else {
            return Some(json!({"status": "failed"}));
        };
        let response = image_response("rendered", &image);
        // A capability revoked during the render has been forgotten; keep it so.
        if let Some(previews) = self
            .interactions
            .lock()
            .expect("draft-preview state mutex poisoned")
            .get_mut(&interaction)
        {
            previews.latest.insert(target, image);
        }
        Some(response)
    }

    async fn render(
        &self,
        bridge: &RenderBridge,
        interaction: NodeId,
        snapshot: &DraftSnapshot,
        fingerprint: String,
    ) -> Option<RenderedImage> {
        let response = self
            .http_client
            .post(format!("{}/draft-previews/render", bridge.url))
            .bearer_auth(&bridge.token)
            .json(&json!({
                "version": 1,
                "interactionNodeId": interaction,
                "fingerprint": fingerprint,
                "snapshot": snapshot,
            }))
            .send()
            .await
            .ok()?;
        if !response.status().is_success() {
            return None;
        }
        let body = response.json::<Value>().await.ok()?;
        let result = body.get("result")?;
        let png_base64 = result.get("pngBase64")?.as_str()?.to_owned();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&png_base64)
            .ok()?;
        if bytes.len() > MAX_PNG_BYTES || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            return None;
        }
        Some(RenderedImage {
            fingerprint,
            png_base64,
            width: u32::try_from(result.get("width")?.as_u64()?).ok()?,
            height: u32::try_from(result.get("height")?.as_u64()?).ok()?,
        })
    }
}

fn image_response(status: &str, image: &RenderedImage) -> Value {
    json!({
        "status": status,
        "fingerprint": image.fingerprint,
        "width": image.width,
        "height": image.height,
        "pngBase64": image.png_base64,
    })
}

fn fingerprint(snapshot: &DraftSnapshot) -> String {
    use sha2::{Digest, Sha256};
    let canonical = serde_json::to_vec(snapshot).expect("draft snapshot serializes");
    format!("sha256:{:x}", Sha256::digest(canonical))
}

/// `Ok(None)` means the target has nothing to preview: a node without authored
/// detail. Read failures are `Err`, reported as a failed render.
async fn draft_snapshot(
    writer: &GraphWriter,
    target: PreviewTarget,
) -> Result<Option<DraftSnapshot>, ()> {
    let (layer, nodes, edges) = match target {
        PreviewTarget::Layer { layer_id } => {
            let resolved = writer.get_layer(layer_id).await.map_err(|_| ())?;
            (Some(resolved.layer), resolved.nodes, resolved.edges)
        }
        PreviewTarget::Node { node_id } => {
            let node = writer.get_node(node_id).await.map_err(|_| ())?;
            if node.authored_detail.is_none() {
                return Ok(None);
            }
            (None, vec![node], Vec::new())
        }
    };
    let mut assets = Vec::new();
    for node in &nodes {
        let declared = node
            .authored_detail
            .as_ref()
            .and_then(|detail| detail.get("assets"))
            .and_then(Value::as_array);
        let mut pins = std::collections::BTreeMap::new();
        for asset in declared.into_iter().flatten() {
            let (Some(id), Some(digest), Some(media_type)) = (
                asset.get("id").and_then(Value::as_str),
                asset.get("digestSha256").and_then(Value::as_str),
                asset.get("mediaType").and_then(Value::as_str),
            ) else {
                return Err(());
            };
            if pins
                .insert(id.to_owned(), (digest.to_owned(), media_type.to_owned()))
                .is_some_and(|prior| prior != (digest.to_owned(), media_type.to_owned()))
            {
                return Err(());
            }
        }
        if let Some(icon) = relayer_graph_core::image_icon(&node.icon) {
            let (Some(digest), Some(media_type)) = (icon.digest_sha256, icon.media_type) else {
                return Err(());
            };
            let pin = (digest, media_type);
            if pins
                .insert(icon.asset_id, pin.clone())
                .is_some_and(|prior| prior != pin)
            {
                return Err(());
            }
        }
        for (asset_id, (digest, media_type)) in pins {
            let stored = writer
                .visible_detail_asset(node.id, &asset_id)
                .await
                .map_err(|_| ())?;
            if stored.digest_sha256 != digest || stored.media_type != media_type {
                return Err(());
            }
            assets.push(SnapshotAsset {
                node_id: node.id,
                id: stored.asset_id,
                digest_sha256: stored.digest_sha256,
                media_type: stored.media_type,
                content_base64: base64::engine::general_purpose::STANDARD.encode(stored.content),
            });
        }
    }
    Ok(Some(DraftSnapshot {
        version: 1,
        target,
        layer,
        nodes,
        edges,
        assets,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        GraphCapabilityProfile, GraphSearchCapability, ServerState, mint_capability_with_profile,
        router,
    };
    use axum::{
        Router,
        body::{Body, to_bytes},
        http::{Request, StatusCode},
        routing::post,
    };
    use relayer_graph_core::{GraphDatabase, ProjectId, ThreadId};
    use std::sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    };
    use tower::ServiceExt;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nfixture";
    const PACKAGE_INTEGRITY: &str =
        "6c34582a24f665dfcf9efa843fdb254a646de79c505d76c80863f81ed8dfe659";

    #[derive(Clone, Default)]
    struct FakeRenderer {
        calls: Arc<AtomicUsize>,
        fail: Arc<AtomicBool>,
        snapshots: Arc<Mutex<Vec<Value>>>,
    }

    impl FakeRenderer {
        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }

        fn last_snapshot(&self) -> Value {
            self.snapshots.lock().unwrap().last().cloned().unwrap()
        }

        async fn serve(&self) -> String {
            let renderer = self.clone();
            let app = Router::new().route(
                "/draft-previews/render",
                post(
                    move |headers: axum::http::HeaderMap, body: axum::Json<Value>| {
                        let renderer = renderer.clone();
                        async move {
                            assert_eq!(
                                headers["authorization"],
                                format!("Bearer {}", "t".repeat(32))
                            );
                            renderer.calls.fetch_add(1, Ordering::SeqCst);
                            renderer
                                .snapshots
                                .lock()
                                .unwrap()
                                .push(body["snapshot"].clone());
                            if renderer.fail.load(Ordering::SeqCst) {
                                return (StatusCode::INTERNAL_SERVER_ERROR, axum::Json(json!({})));
                            }
                            let png = base64::engine::general_purpose::STANDARD.encode(PNG);
                            (
                                StatusCode::OK,
                                axum::Json(
                                    json!({"result":{"pngBase64":png,"width":1176,"height":812}}),
                                ),
                            )
                        }
                    },
                ),
            );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            format!("http://{address}")
        }
    }

    struct Fixture {
        app: Router,
        token: String,
        graph: GraphDatabase,
        interaction: relayer_graph_core::NodeId,
    }

    impl Fixture {
        async fn new(
            preview: GraphPreviewCapability,
            bridge: Option<&FakeRenderer>,
            limit: u32,
        ) -> Self {
            let graph = GraphDatabase::in_memory().await.unwrap();
            let interaction = graph
                .create_interaction(ProjectId::new(41), ThreadId::new(73).unwrap(), "Question")
                .await
                .unwrap();
            let state = ServerState::new(graph.clone(), "control").with_draft_preview_limit(limit);
            let token = mint_capability_with_profile(
                &state,
                interaction.id,
                None,
                GraphCapabilityProfile {
                    search: GraphSearchCapability::Disabled,
                    preview,
                    planning: None,
                },
            )
            .await
            .ok()
            .unwrap();
            let app = router(state);
            if let Some(renderer) = bridge {
                let url = renderer.serve().await;
                let registered = Self::send(
                    &app,
                    "PUT",
                    "/api/control/draft-previews/bridge",
                    "control",
                    json!({"url": url, "token": "t".repeat(32)}),
                )
                .await;
                assert_eq!(registered.0, StatusCode::OK);
            }
            Self {
                app,
                token,
                graph,
                interaction: interaction.id,
            }
        }

        async fn send(
            app: &Router,
            method: &str,
            uri: &str,
            token: &str,
            body: Value,
        ) -> (StatusCode, Value) {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri(uri)
                        .header("content-type", "application/json")
                        .header("authorization", format!("Bearer {token}"))
                        .body(Body::from(body.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            let status = response.status();
            let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            (
                status,
                serde_json::from_slice(&bytes).unwrap_or(Value::Null),
            )
        }

        async fn post(&self, uri: &str, body: Value) -> Value {
            let (status, body) = Self::send(&self.app, "POST", uri, &self.token, body).await;
            assert_eq!(status, StatusCode::OK, "{body}");
            body
        }

        async fn node(&self, key: &str, title: &str, authored: bool) -> Value {
            let mut node = json!({"clientKey":key,"kind":"concept","icon":"box","title":title,"detail":"Fallback"});
            if authored {
                node["authoredDetail"] = json!({
                    "version": 1,
                    "components": [{"id":"overview","order":0,"html":"<p>Accepted</p>","css":"p{color:#fff}"}],
                    "mounts": [],
                    "assets": [],
                    "integritySha256": PACKAGE_INTEGRITY
                });
            }
            self.post("/api/graph/nodes", node).await
        }

        async fn layer(&self, nodes: [i64; 2], edge: i64, x: f64) -> Value {
            self.post(
                "/api/graph/layers",
                json!({
                    "clientKey": "root",
                    "nodes": nodes,
                    "edges": [edge],
                    "layout": {"version":1,"edgeShape":"default","placements":[
                        {"nodeId":nodes[0],"x":x,"y":0.5},
                        {"nodeId":nodes[1],"x":0.8,"y":0.5}
                    ]}
                }),
            )
            .await
        }

        /// Two connected nodes, the second with authored detail.
        async fn pair(&self) -> ([i64; 2], i64) {
            let plain = self.node("plain", "Plain", false).await["node"]["id"]
                .as_i64()
                .unwrap();
            let authored = self.node("authored", "Authored", true).await["node"]["id"]
                .as_i64()
                .unwrap();
            let edge = self
                .post(
                    "/api/graph/edges",
                    json!({"clientKey":"link","endpoints":[plain, authored]}),
                )
                .await["edge"]["id"]
                .as_i64()
                .unwrap();
            ([plain, authored], edge)
        }
    }

    #[tokio::test]
    async fn writes_return_fresh_and_cached_previews_of_the_callers_draft() {
        let renderer = FakeRenderer::default();
        let fixture = Fixture::new(GraphPreviewCapability::Enabled, Some(&renderer), 100).await;
        let plain = fixture.node("plain", "Plain", false).await;
        assert!(
            plain.get("preview").is_none(),
            "plain Markdown nodes get no image"
        );
        let authored = fixture.node("authored", "Authored", true).await;
        assert_eq!(authored["preview"]["status"], "rendered");
        assert_eq!(authored["preview"]["width"], 1176);
        assert_eq!(
            authored["preview"]["pngBase64"],
            base64::engine::general_purpose::STANDARD.encode(PNG)
        );
        assert_eq!(
            fixture.node("authored", "Authored", true).await["preview"]["status"],
            "cached"
        );
        let retitled = fixture.node("authored", "Retitled", true).await["preview"].clone();
        assert_eq!(retitled["status"], "rendered");
        assert_ne!(retitled["fingerprint"], authored["preview"]["fingerprint"]);
        assert_eq!(renderer.calls(), 2);

        let (nodes, edge) = fixture.pair().await;
        let first = fixture.layer(nodes, edge, 0.2).await["preview"].clone();
        assert_eq!(first["status"], "rendered");
        let snapshot = renderer.last_snapshot();
        assert_eq!(
            snapshot["target"],
            json!({"kind":"layer","layerId":snapshot["layer"]["id"]})
        );
        let rendered_nodes: Vec<i64> = snapshot["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|node| node["id"].as_i64().unwrap())
            .collect();
        assert_eq!(rendered_nodes, nodes);
        assert_eq!(snapshot["edges"][0]["id"], edge);

        let calls = renderer.calls();
        assert_eq!(
            fixture.layer(nodes, edge, 0.2).await["preview"]["status"],
            "cached"
        );
        assert_eq!(
            renderer.calls(),
            calls,
            "identical content reuses the image"
        );
        let moved = fixture.layer(nodes, edge, 0.3).await["preview"].clone();
        assert_eq!(moved["status"], "rendered");
        assert_ne!(moved["fingerprint"], first["fingerprint"]);

        // A member node's new content is part of what the layer shows.
        fixture.node("plain", "Renamed", false).await;
        let renamed = fixture.layer(nodes, edge, 0.3).await["preview"].clone();
        assert_eq!(renamed["status"], "rendered");
        assert_ne!(renamed["fingerprint"], moved["fingerprint"]);
    }

    #[tokio::test]
    async fn draft_image_icons_and_detail_assets_reach_the_render_without_duplicates() {
        let renderer = FakeRenderer::default();
        let fixture = Fixture::new(GraphPreviewCapability::Enabled, Some(&renderer), 100).await;
        let package = json!({
            "version": 1,
            "components": [{"id":"overview","order":0,"html":"<section><img data-gc-asset=\"m_asset\"></section>","css":"section{display:grid}"}],
            "mounts": [{"id":"m_asset","componentId":"overview","kind":"asset","host":"img","assetId":"architecture-diagram"}],
            "assets": [{"id":"architecture-diagram","digestSha256":"a9ce00f55032b62526a3abfc5aa6019874beff5d18c90607d663840d14ed11f9","mediaType":"image/png","representation":"image"}],
            "integritySha256": "adf1296990ca1e4be5e4d90eb9f4a4fab14716a885efc524cc04018294fc17d1"
        });
        let drawn = fixture
            .graph
            .writer_for_subgraph(fixture.interaction)
            .await
            .unwrap()
            .submit_node_with_prepared_visual_assets(
                &relayer_graph_core::NodeDraft {
                    client_key: "drawn".into(),
                    kind: "concept".into(),
                    icon: json!({"kind":"image","assetId":"architecture-diagram","digestSha256":"a9ce00f55032b62526a3abfc5aa6019874beff5d18c90607d663840d14ed11f9","mediaType":"image/png"}).to_string(),
                    title: "Architecture".into(),
                    detail: "Fallback".into(),
                },
                relayer_graph_core::AuthoredDetailUpdate::Replace(&package),
                Some(&[relayer_graph_core::PreparedDetailAsset {
                    asset_id: "architecture-diagram".into(),
                    digest_sha256:
                        "a9ce00f55032b62526a3abfc5aa6019874beff5d18c90607d663840d14ed11f9".into(),
                    media_type: "image/png".into(),
                    byte_length: 13,
                    provenance_source: "user".into(),
                    provenance_file_name: "architecture.png".into(),
                    content: b"trusted asset".to_vec(),
                }]),
                Some(&relayer_graph_core::PreparedDetailAsset {
                    asset_id: "architecture-diagram".into(),
                    digest_sha256:
                        "a9ce00f55032b62526a3abfc5aa6019874beff5d18c90607d663840d14ed11f9".into(),
                    media_type: "image/png".into(),
                    byte_length: 13,
                    provenance_source: "user".into(),
                    provenance_file_name: "architecture.png".into(),
                    content: b"trusted asset".to_vec(),
                }),
            )
            .await
            .unwrap();
        let plain = fixture
            .graph
            .writer_for_subgraph(fixture.interaction)
            .await
            .unwrap()
            .submit_node_with_prepared_visual_assets(
                &relayer_graph_core::NodeDraft {
                    client_key: "plain".into(),
                    kind: "concept".into(),
                    icon: json!({"kind":"image","assetId":"icon-only","digestSha256":"a9ce00f55032b62526a3abfc5aa6019874beff5d18c90607d663840d14ed11f9","mediaType":"image/png"}).to_string(),
                    title: "Image only".into(),
                    detail: "No authored Detail".into(),
                },
                relayer_graph_core::AuthoredDetailUpdate::Retain,
                None,
                Some(&relayer_graph_core::PreparedDetailAsset {
                    asset_id: "icon-only".into(),
                    digest_sha256:
                        "a9ce00f55032b62526a3abfc5aa6019874beff5d18c90607d663840d14ed11f9".into(),
                    media_type: "image/png".into(),
                    byte_length: 13,
                    provenance_source: "user".into(),
                    provenance_file_name: "architecture.png".into(),
                    content: b"trusted asset".to_vec(),
                }),
            )
            .await
            .unwrap()
            .id
            .value();
        let edge = fixture
            .post(
                "/api/graph/edges",
                json!({"clientKey":"link","endpoints":[plain, drawn.id]}),
            )
            .await["edge"]["id"]
            .as_i64()
            .unwrap();

        let layer = fixture.layer([plain, drawn.id.value()], edge, 0.2).await;

        assert_eq!(layer["preview"]["status"], "rendered");
        let writer = fixture
            .graph
            .writer_for_subgraph(fixture.interaction)
            .await
            .unwrap();
        let node_snapshot = draft_snapshot(&writer, PreviewTarget::Node { node_id: drawn.id })
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            node_snapshot.assets.len(),
            1,
            "A shared Detail/icon pin is sent only once"
        );
        assert!(
            draft_snapshot(
                &writer,
                PreviewTarget::Node {
                    node_id: NodeId::new(plain).unwrap()
                }
            )
            .await
            .unwrap()
            .is_none(),
            "An image icon alone does not change authored-Detail-only node preview eligibility"
        );
        assert_eq!(
            renderer.last_snapshot()["assets"],
            json!([{
                "nodeId": plain,
                "id": "icon-only",
                "digestSha256": "a9ce00f55032b62526a3abfc5aa6019874beff5d18c90607d663840d14ed11f9",
                "mediaType": "image/png",
                "contentBase64": base64::engine::general_purpose::STANDARD.encode(b"trusted asset"),
            }, {
                "nodeId": drawn.id,
                "id": "architecture-diagram",
                "digestSha256": "a9ce00f55032b62526a3abfc5aa6019874beff5d18c90607d663840d14ed11f9",
                "mediaType": "image/png",
                "contentBase64": base64::engine::general_purpose::STANDARD.encode(b"trusted asset"),
            }])
        );
    }

    #[tokio::test]
    async fn a_failed_render_never_fails_the_write() {
        let renderer = FakeRenderer::default();
        renderer.fail.store(true, Ordering::SeqCst);
        let fixture = Fixture::new(GraphPreviewCapability::Enabled, Some(&renderer), 100).await;
        let written = fixture.node("authored", "Authored", true).await;
        assert_eq!(written["preview"], json!({"status":"failed"}));
        let id = written["node"]["id"].as_i64().unwrap();
        let (status, stored) = Fixture::send(
            &fixture.app,
            "GET",
            &format!("/api/graph/nodes/{id}"),
            &fixture.token,
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(stored["node"]["title"], "Authored");
    }

    #[tokio::test]
    async fn unsupported_runs_and_hosts_without_a_renderer_get_no_preview_field() {
        let renderer = FakeRenderer::default();
        let unsupported =
            Fixture::new(GraphPreviewCapability::Disabled, Some(&renderer), 100).await;
        let (nodes, edge) = unsupported.pair().await;
        assert!(
            unsupported
                .layer(nodes, edge, 0.2)
                .await
                .get("preview")
                .is_none()
        );
        assert_eq!(renderer.calls(), 0);

        let unregistered = Fixture::new(GraphPreviewCapability::Enabled, None, 100).await;
        let (nodes, edge) = unregistered.pair().await;
        assert!(
            unregistered
                .layer(nodes, edge, 0.2)
                .await
                .get("preview")
                .is_none()
        );
    }

    #[tokio::test]
    async fn the_render_ceiling_stops_new_renders_but_keeps_cached_images() {
        let renderer = FakeRenderer::default();
        let fixture = Fixture::new(GraphPreviewCapability::Enabled, Some(&renderer), 1).await;
        let plain = fixture.node("plain", "Plain", false).await["node"]["id"]
            .as_i64()
            .unwrap();
        let other = fixture.node("other", "Other", false).await["node"]["id"]
            .as_i64()
            .unwrap();
        let edge = fixture
            .post(
                "/api/graph/edges",
                json!({"clientKey":"link","endpoints":[plain, other]}),
            )
            .await["edge"]["id"]
            .as_i64()
            .unwrap();
        assert_eq!(
            fixture.layer([plain, other], edge, 0.2).await["preview"]["status"],
            "rendered"
        );
        assert_eq!(
            fixture.layer([plain, other], edge, 0.3).await["preview"],
            json!({"status":"limit_reached"})
        );
        assert_eq!(
            fixture.layer([plain, other], edge, 0.2).await["preview"]["status"],
            "cached"
        );
        assert_eq!(renderer.calls(), 1);
    }
}
