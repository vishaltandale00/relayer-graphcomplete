//! ART-001: artifact layers and artifact nodes (PRD 6.6.1, 11.11).

use relayer_graph_core::*;
use serde_json::{Value, json};

const FINGERPRINT: &str = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn layout(nodes: &[NodeId]) -> Option<LayerLayout> {
    let last = nodes.len().saturating_sub(1).max(1) as f64;
    Some(LayerLayout::v1(
        nodes
            .iter()
            .enumerate()
            .map(|(index, node_id)| NodePlacement {
                node_id: *node_id,
                x: if nodes.len() == 1 {
                    0.5
                } else {
                    index as f64 / last
                },
                y: 0.5,
            })
            .collect(),
        "default",
    ))
}

fn website() -> Value {
    json!({
        "kind": "website",
        "source": {"file": "site/index.html", "root": "site"},
        "part": {"route": "#pricing"},
        "viewport": "phone",
        "fingerprint": FINGERPRINT,
    })
}

fn node_draft(key: &str) -> NodeDraft {
    NodeDraft {
        client_key: key.into(),
        kind: "concept".into(),
        icon: "globe".into(),
        title: key.into(),
        detail: format!("detail {key}"),
    }
}

fn layer_draft(key: &str, nodes: &[NodeId]) -> LayerDraft {
    LayerDraft {
        default_node_id: None,
        client_key: key.into(),
        nodes: nodes.to_vec(),
        edges: vec![],
        layout: layout(nodes),
        size_justification: None,
    }
}

async fn setup() -> (GraphDatabase, GraphNode, GraphWriter) {
    let database = GraphDatabase::in_memory().await.unwrap();
    let interaction = database
        .create_interaction(None, ThreadId::new(1).unwrap(), "Build me a landing page")
        .await
        .unwrap();
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    (database, interaction, writer)
}

async fn plain_node(writer: &GraphWriter, key: &str) -> GraphNode {
    writer.submit_node(&node_draft(key)).await.unwrap()
}

async fn artifact_node(
    writer: &GraphWriter,
    key: &str,
    artifact: &Value,
) -> Result<GraphNode, GraphError> {
    writer
        .submit_node_with_artifact(
            &node_draft(key),
            AuthoredDetailUpdate::Retain,
            None,
            None,
            Some(artifact),
        )
        .await
}

async fn navigate(
    writer: &GraphWriter,
    key: &str,
    source: &GraphNode,
    source_layer: Option<&GraphLayer>,
    target: &GraphLayer,
) {
    writer
        .add_action(&ActionDraft {
            client_key: key.into(),
            source_node_id: source.id,
            source_layer_id: source_layer.map(|layer| layer.id),
            kind: ActionKind::Navigate,
            relation: Some(NavigateRelation::Expand),
            label: key.into(),
            variant: ActionVariant::default(),
            icon: None,
            description: None,
            target_layer_id: Some(target.id),
            interaction_text: None,
            input: None,
        })
        .await
        .unwrap();
}

fn code(error: GraphError) -> String {
    match error {
        GraphError::Validation { code, .. } => code.to_string(),
        GraphError::ValidationIssues { issues, .. } => issues[0].code.to_string(),
        other => panic!("expected a validation error, got {other:?}"),
    }
}

#[tokio::test]
async fn an_accepted_artifact_layer_keeps_its_renderer_and_artifact() {
    let (_database, interaction, writer) = setup().await;
    let overview = plain_node(&writer, "overview").await;
    let root = writer
        .submit_layer(&layer_draft("root", &[overview.id]))
        .await
        .unwrap();
    let site = artifact_node(&writer, "landing-page", &website())
        .await
        .unwrap();
    let viewer = writer
        .submit_layer_with_renderer(
            &layer_draft("landing-page-viewer", &[site.id]),
            Some("artifact"),
        )
        .await
        .unwrap();
    assert_eq!(viewer.renderer.as_deref(), Some("artifact"));
    navigate(&writer, "response", &interaction, None, &root).await;
    navigate(&writer, "open-site", &overview, Some(&root), &viewer).await;
    writer.complete(interaction.id).await.unwrap();

    let resolved = writer.get_layer(viewer.id).await.unwrap();
    assert_eq!(resolved.layer.renderer.as_deref(), Some("artifact"));
    assert_eq!(resolved.layer.state, RecordState::Accepted);
    assert_eq!(resolved.nodes.len(), 1);
    assert_eq!(resolved.nodes[0].artifact.as_ref(), Some(&website()));
    let wire = serde_json::to_value(&resolved).unwrap();
    assert_eq!(wire["layer"]["renderer"], "artifact");
    assert_eq!(wire["nodes"][0]["artifact"]["fingerprint"], FINGERPRINT);
    let graph_layer = serde_json::to_value(writer.get_layer(root.id).await.unwrap()).unwrap();
    assert!(
        graph_layer["layer"].get("renderer").is_none(),
        "graph layers omit renderer on the wire"
    );
}

#[tokio::test]
async fn an_artifact_layer_holds_exactly_one_artifact_node() {
    let (_database, _interaction, writer) = setup().await;
    let site = artifact_node(&writer, "site", &website()).await.unwrap();
    let other = plain_node(&writer, "other").await;
    let two = writer
        .submit_layer_with_renderer(&layer_draft("two", &[site.id, other.id]), Some("artifact"))
        .await
        .unwrap_err();
    assert_eq!(code(two), "artifact_layer_member_count");
    let plain = writer
        .submit_layer_with_renderer(&layer_draft("plain", &[other.id]), Some("artifact"))
        .await
        .unwrap_err();
    assert_eq!(code(plain), "artifact_layer_member_count");
    let outside = writer
        .submit_layer(&layer_draft("graph", &[site.id]))
        .await
        .unwrap_err();
    assert_eq!(code(outside), "artifact_node_outside_artifact_layer");
    let unknown = writer
        .submit_layer_with_renderer(&layer_draft("map", &[other.id]), Some("map"))
        .await
        .unwrap_err();
    assert_eq!(code(unknown), "layer_renderer_unsupported");
}

#[tokio::test]
async fn artifact_details_are_checked_before_any_write() {
    let (_database, _interaction, writer) = setup().await;
    let cases = [
        (
            json!({"kind":"website","source":{"file":"site/index.html","root":"site"}}),
            "artifact_fingerprint_missing",
        ),
        (
            json!({"kind":"pdf","source":{"file":"../secret.pdf"},"fingerprint":FINGERPRINT}),
            "artifact_path_outside_thread",
        ),
        (
            json!({"kind":"url","source":{"url":"http://localhost:@example.com/"}}),
            "artifact_url_scheme",
        ),
        (
            json!({"kind":"url","source":{"url":"http://localhost.example.com/"}}),
            "artifact_url_scheme",
        ),
        (
            json!({"kind":"pdf","source":{"file":"/etc/report.pdf"},"fingerprint":FINGERPRINT}),
            "artifact_path_not_relative",
        ),
        (
            json!({"kind":"video","source":{"file":"media/installer.exe"},"fingerprint":FINGERPRINT}),
            "artifact_type_unsupported",
        ),
        (
            json!({"kind":"website","source":{"file":"site/index.html"},"fingerprint":FINGERPRINT}),
            "artifact_root_required",
        ),
        (
            json!({"kind":"website","source":{"file":"other/index.html","root":"site"},"fingerprint":FINGERPRINT}),
            "artifact_entry_outside_root",
        ),
        (
            json!({"kind":"url","source":{"url":"http://tidewater.example/"}}),
            "artifact_url_scheme",
        ),
        (
            json!({"kind":"url","source":{"url":"https://example.com/"},"fingerprint":FINGERPRINT}),
            "artifact_field_unknown",
        ),
        (
            json!({"kind":"pdf","source":{"file":"brief.pdf"},"part":{"page":0},"fingerprint":FINGERPRINT}),
            "artifact_part_invalid",
        ),
        (
            json!({"kind":"video","source":{"file":"promo.mp4"},"part":{"start":12,"end":10},"fingerprint":FINGERPRINT}),
            "artifact_part_invalid",
        ),
        (
            json!({"kind":"pdf","source":{"file":"brief.pdf"},"viewport":"phone","fingerprint":FINGERPRINT}),
            "artifact_viewport_invalid",
        ),
        (
            json!({"kind":"pptx","source":{"file":"deck.pptx"}}),
            "artifact_kind_unsupported",
        ),
    ];
    for (index, (artifact, expected)) in cases.into_iter().enumerate() {
        let error = artifact_node(&writer, &format!("bad-{index}"), &artifact)
            .await
            .unwrap_err();
        assert_eq!(code(error), expected, "case {index}: {artifact}");
    }
    let url =
        json!({"kind":"url","source":{"url":"https://example.com/"},"part":{"route":"/pricing"}});
    assert!(artifact_node(&writer, "deployed", &url).await.is_ok());
    let loopback = json!({"kind":"url","source":{"url":"http://localhost:5173/"}});
    assert!(artifact_node(&writer, "local", &loopback).await.is_ok());
}

#[tokio::test]
async fn acceptance_rechecks_a_node_resubmitted_after_its_layer() {
    let (_database, interaction, writer) = setup().await;
    let site = artifact_node(&writer, "site", &website()).await.unwrap();
    let viewer = writer
        .submit_layer_with_renderer(&layer_draft("viewer", &[site.id]), Some("artifact"))
        .await
        .unwrap();
    navigate(&writer, "response", &interaction, None, &viewer).await;
    // The same node comes back without artifact details.
    writer.submit_node(&node_draft("site")).await.unwrap();
    let error = writer.complete(interaction.id).await.unwrap_err();
    assert_eq!(code(error), "artifact_layer_member_count");
}

/// ART-004: acceptance, not submission, pins the fingerprint.
#[tokio::test]
async fn acceptance_pins_the_fingerprint_taken_just_before_it() {
    let (_database, interaction, writer) = setup().await;
    let overview = plain_node(&writer, "overview").await;
    let root = writer
        .submit_layer(&layer_draft("root", &[overview.id]))
        .await
        .unwrap();
    let site = artifact_node(&writer, "landing-page", &website())
        .await
        .unwrap();
    let viewer = writer
        .submit_layer_with_renderer(&layer_draft("viewer", &[site.id]), Some("artifact"))
        .await
        .unwrap();
    navigate(&writer, "response", &interaction, None, &root).await;
    navigate(&writer, "open-site", &overview, Some(&root), &viewer).await;

    let drafts = writer.draft_artifacts().await.unwrap();
    assert_eq!(drafts, vec![(site.id, website())]);
    let edited = "sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
    let malformed = writer
        .pin_artifact_fingerprint(site.id, "md5:abc")
        .await
        .unwrap_err();
    assert_eq!(code(malformed), "artifact_fingerprint_missing");
    writer
        .pin_artifact_fingerprint(site.id, edited)
        .await
        .unwrap();
    writer.complete(interaction.id).await.unwrap();

    let accepted = writer.get_layer(viewer.id).await.unwrap().nodes.remove(0);
    assert_eq!(accepted.artifact.as_ref().unwrap()["fingerprint"], edited);
    assert!(
        writer
            .draft_artifacts()
            .await
            .unwrap_or_default()
            .is_empty()
    );
}

/// P2: a web app carries its server invoke and starting state (PRD 6.6.6, 6.6.7).
#[tokio::test]
async fn a_web_app_carries_its_server_invoke_and_starting_state() {
    let (_database, interaction, writer) = setup().await;
    let overview = plain_node(&writer, "overview").await;
    let root = writer
        .submit_layer(&layer_draft("root", &[overview.id]))
        .await
        .unwrap();
    let app = json!({
        "kind": "app",
        "source": {"url": "http://127.0.0.1:5173/"},
        "part": {"route": "/checkout"},
        "server": {"command": "npm run dev", "readyUrl": "http://127.0.0.1:5173/health", "idleTimeoutMinutes": 30},
        "seed": {"localStorage": {"cart": "[\"latte\"]"}, "cookies": [{"name": "session", "value": "test-user"}]},
    });
    let node = artifact_node(&writer, "checkout-app", &app).await.unwrap();
    let viewer = writer
        .submit_layer_with_renderer(
            &layer_draft("checkout-viewer", &[node.id]),
            Some("artifact"),
        )
        .await
        .unwrap();
    navigate(&writer, "response", &interaction, None, &root).await;
    navigate(&writer, "open-app", &overview, Some(&root), &viewer).await;
    writer.complete(interaction.id).await.unwrap();
    let accepted = writer.get_layer(viewer.id).await.unwrap().nodes.remove(0);
    assert_eq!(accepted.artifact.as_ref(), Some(&app));
    assert_eq!(artifact::server_idle_minutes(&app["server"]), 30);
    assert_eq!(
        artifact::server_idle_minutes(&json!({"command": "npm start"})),
        60
    );
}

#[tokio::test]
async fn server_invokes_and_starting_state_are_checked() {
    let (_database, _interaction, writer) = setup().await;
    let app = |extra: Value| {
        let mut value = json!({"kind": "app", "source": {"url": "http://localhost:3000/"}, "server": {"command": "npm run dev"}});
        value
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        value
    };
    let cases = [
        (
            json!({"kind": "app", "source": {"url": "http://localhost:3000/"}}),
            "artifact_server_required",
        ),
        (
            app(json!({"source": {"url": "https://example.com/"}})),
            "artifact_url_scheme",
        ),
        (
            app(json!({"server": {"command": "  "}})),
            "artifact_server_invalid",
        ),
        (
            app(json!({"server": {"command": "npm run dev\nrm -rf ~"}})),
            "artifact_server_invalid",
        ),
        (
            app(json!({"server": {"command": "npm run dev", "idleTimeoutMinutes": 0}})),
            "artifact_server_invalid",
        ),
        (
            app(json!({"server": {"command": "npm run dev", "readyUrl": "https://example.com/"}})),
            "artifact_url_scheme",
        ),
        (
            app(json!({"server": {"command": "npm run dev", "shell": "zsh"}})),
            "artifact_field_unknown",
        ),
        (
            json!({"kind": "url", "source": {"url": "https://example.com/"}, "server": {"command": "x"}}),
            "artifact_field_unknown",
        ),
        (
            json!({"kind": "pdf", "source": {"file": "a.pdf"}, "seed": {"localStorage": {}}, "fingerprint": FINGERPRINT}),
            "artifact_field_unknown",
        ),
        (
            app(json!({"seed": {"localStorage": {"count": 3}}})),
            "artifact_seed_invalid",
        ),
        (
            app(json!({"seed": {"cookies": [{"name": "a;b", "value": "x"}]}})),
            "artifact_seed_invalid",
        ),
        (
            app(json!({"seed": {"cookies": [{"name": "a", "value": "x; Domain=evil"}]}})),
            "artifact_seed_invalid",
        ),
        (
            app(json!({"seed": {"localStorage": {"blob": "x".repeat(17 * 1024)}}})),
            "artifact_seed_invalid",
        ),
        (
            json!({"kind": "website", "source": {"file": "site/index.html", "root": "site"}, "seed": {"cookies": [{"name": "a", "value": "b"}]}, "fingerprint": FINGERPRINT}),
            "artifact_seed_invalid",
        ),
    ];
    for (index, (artifact, expected)) in cases.into_iter().enumerate() {
        let error = artifact_node(&writer, &format!("case-{index}"), &artifact)
            .await
            .unwrap_err();
        assert_eq!(code(error), expected, "case {index}: {artifact}");
    }
}
