use super::{LadybugSearchIndex, schema};
use relayer_graph_core::*;
use std::sync::Arc;

async fn layer(writer: &GraphWriter, key: &str, node: &GraphNode) -> GraphLayer {
    writer
        .submit_layer(&LayerDraft {
            default_node_id: None,
            client_key: key.into(),
            nodes: vec![node.id],
            edges: vec![],
            size_justification: None,
            layout: Some(LayerLayout::v1(
                vec![NodePlacement {
                    node_id: node.id,
                    x: 0.5,
                    y: 0.5,
                }],
                "default",
            )),
        })
        .await
        .unwrap()
}
async fn content(writer: &GraphWriter, key: &str) -> GraphNode {
    writer
        .submit_node(&NodeDraft {
            client_key: key.into(),
            kind: "concept".into(),
            icon: "box".into(),
            title: key.into(),
            detail: key.into(),
        })
        .await
        .unwrap()
}
async fn root(writer: &GraphWriter, interaction: &GraphNode, layer: &GraphLayer) {
    writer
        .add_action(&ActionDraft {
            reusable: None,
            client_key: "response".into(),
            source_node_id: interaction.id,
            source_layer_id: None,
            kind: ActionKind::Navigate,
            relation: Some(NavigateRelation::Expand),
            label: "Response".into(),
            variant: Default::default(),
            icon: None,
            description: None,
            target_layer_id: Some(layer.id),
            interaction_text: None,
            input_action_ids: Vec::new(),
            input: None,
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn typed_invoke_index_matches_rebuild_without_widening_result_thread() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("graph.db");
    let database = GraphDatabase::open(&path).await.unwrap();
    let index = Arc::new(
        LadybugSearchIndex::open_reconciled(&path, &database)
            .await
            .unwrap(),
    );
    let database = database.with_search_index(index.clone());
    database
        .set_interaction_permissions_enabled(false)
        .await
        .unwrap();
    let project = Some(ProjectId::new(1).unwrap());
    let source = database
        .create_interaction(project, ThreadId::new(1).unwrap(), "Source request")
        .await
        .unwrap();
    let writer = database.writer_for_subgraph(source.id).await.unwrap();
    let node = content(&writer, "source-only").await;
    let source_layer = layer(&writer, "source", &node).await;
    let legacy_second = layer(&writer, "legacy-second", &node).await;
    let menu = content(&writer, "source-menu").await;
    let source_root = layer(&writer, "source-root", &menu).await;
    for target in [&source_layer, &legacy_second] {
        writer
            .add_action(&ActionDraft {
                reusable: None,
                client_key: format!("open-{}", target.id),
                source_node_id: menu.id,
                source_layer_id: Some(source_root.id),
                kind: ActionKind::Navigate,
                relation: Some(NavigateRelation::Expand),
                label: "Open".into(),
                variant: Default::default(),
                icon: None,
                description: None,
                target_layer_id: Some(target.id),
                interaction_text: None,
                input_action_ids: Vec::new(),
                input: None,
            })
            .await
            .unwrap();
    }
    let invoke = writer
        .add_action(&ActionDraft {
            reusable: None,
            client_key: "invoke".into(),
            source_node_id: node.id,
            source_layer_id: Some(source_layer.id),
            kind: ActionKind::Invoke,
            relation: None,
            label: "Continue".into(),
            variant: Default::default(),
            icon: None,
            description: None,
            target_layer_id: None,
            interaction_text: Some("Continue".into()),
            input_action_ids: Vec::new(),
            input: None,
        })
        .await
        .unwrap();
    root(&writer, &source, &source_root).await;
    writer.complete(source.id).await.unwrap();
    assert!(
        writer
            .get_layer(legacy_second.id)
            .await
            .unwrap()
            .actions
            .is_empty()
    );
    database
        .set_interaction_permissions_enabled(true)
        .await
        .unwrap();
    let reuse = database
        .create_interaction(project, ThreadId::new(3).unwrap(), "Reuse request")
        .await
        .unwrap();
    let reused = database.writer_for_subgraph(reuse.id).await.unwrap();
    let reused_layer = layer(&reused, "reused", &node).await;
    root(&reused, &reuse, &reused_layer).await;
    reused.complete(reuse.id).await.unwrap();
    let result = database
        .create_interaction_with_invocation(
            project,
            ThreadId::new(2).unwrap(),
            "ignored",
            Some(InteractionInvocation {
                source_interaction_node_id: source.id,
                source_action_id: invoke.id,
            }),
        )
        .await
        .unwrap();
    let result_writer = database.writer_for_subgraph(result.id).await.unwrap();
    let answer = content(&result_writer, "result-only").await;
    let result_layer = layer(&result_writer, "answer", &answer).await;
    root(&result_writer, &result, &result_layer).await;
    result_writer.complete(result.id).await.unwrap();
    let legacy_actions = writer.get_layer(legacy_second.id).await.unwrap().actions;
    assert_eq!(legacy_actions.len(), 1);
    assert_eq!(legacy_actions[0].id, invoke.id);
    assert_eq!(legacy_actions[0].kind, ActionKind::Navigate);
    let expected =
        schema::canonical_inventory(&database.search_index_rebuild_snapshot().await.unwrap());
    let actual = index.inventory().await.unwrap();
    assert_eq!(actual, expected);
    let result_projection = actual
        .projection(SearchTarget::Thread(ThreadId::new(2).unwrap()))
        .unwrap();
    assert!(
        !result_projection
            .iter()
            .any(|entry| entry.contains("source-only"))
    );
    for thread in [1, 3] {
        let projection = actual
            .projection(SearchTarget::Thread(ThreadId::new(thread).unwrap()))
            .unwrap();
        assert!(projection.iter().any(|entry| entry.contains("result-only")));
    }
    drop(result_writer);
    drop(writer);
    drop(reused);
    database.close().await;
    drop(database);
    drop(index);
    let reopened = GraphDatabase::open(&path).await.unwrap();
    let reopened_index = LadybugSearchIndex::open_reconciled(&path, &reopened)
        .await
        .unwrap();
    assert_eq!(reopened_index.inventory().await.unwrap(), expected);
}
