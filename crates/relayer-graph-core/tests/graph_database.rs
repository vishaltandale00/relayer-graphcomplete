use relayer_graph_core::*;

fn project(value: i64) -> ProjectId {
    ProjectId::new(value).unwrap()
}

fn thread(value: i64) -> ThreadId {
    ThreadId::new(value).unwrap()
}

async fn setup(project_id: Option<ProjectId>, thread_id: ThreadId) -> (GraphDatabase, GraphNode) {
    let database = GraphDatabase::in_memory().await.unwrap();
    let interaction = database
        .create_interaction(project_id, thread_id, "Explain the queue")
        .await
        .unwrap();
    (database, interaction)
}

async fn node(writer: &GraphWriter, key: &str) -> GraphNode {
    writer
        .submit_node(&NodeDraft {
            client_key: key.into(),
            kind: "concept".into(),
            icon: "box".into(),
            title: key.into(),
            detail: format!("detail {key}"),
        })
        .await
        .unwrap()
}

async fn accept_single_node(writer: &GraphWriter, interaction: GraphNode, node: GraphNode) {
    let layer = writer
        .submit_layer(&LayerDraft {
            client_key: "root".into(),
            nodes: vec![node.id],
            edges: vec![],
        })
        .await
        .unwrap();
    writer
        .add_action(&ActionDraft {
            client_key: "response".into(),
            source_node_id: interaction.id,
            kind: ActionKind::Navigate,
            label: "Response".into(),
            target_layer_id: Some(layer.id),
            interaction_text: None,
            response: true,
        })
        .await
        .unwrap();
    writer.complete(interaction.id).await.unwrap();
}

#[tokio::test]
async fn product_identifiers_are_external_inputs() {
    let (database, interaction) = setup(Some(project(41)), thread(73)).await;
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    assert_eq!(writer.node_id(), interaction.id);
}

#[tokio::test]
async fn accepts_connected_layer_and_returns_exact_view() {
    let (database, interaction) = setup(Some(project(1)), thread(1)).await;
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let a = node(&writer, "a").await;
    let b = node(&writer, "b").await;
    let edge = writer
        .create_edge(&EdgeDraft {
            client_key: "ab".into(),
            endpoints: [a.id, b.id],
        })
        .await
        .unwrap();
    let layer = writer
        .submit_layer(&LayerDraft {
            client_key: "root".into(),
            nodes: vec![a.id, b.id],
            edges: vec![edge.id],
        })
        .await
        .unwrap();
    writer
        .add_action(&ActionDraft {
            client_key: "response".into(),
            source_node_id: interaction.id,
            kind: ActionKind::Navigate,
            label: "Response".into(),
            target_layer_id: Some(layer.id),
            interaction_text: None,
            response: true,
        })
        .await
        .unwrap();
    let output = writer.complete(interaction.id).await.unwrap();
    assert_eq!(output.node_id, interaction.id);
    assert_eq!(output.root_layer.nodes.len(), 2);
    assert_eq!(output.root_layer.edges[0].endpoints, [a.id, b.id]);
    assert_eq!(output.root_layer.layer.state, RecordState::Accepted);
    let error = writer
        .submit_node(&NodeDraft {
            client_key: "late-write".into(),
            kind: "concept".into(),
            icon: "lock".into(),
            title: "Late write".into(),
            detail: "This must not be added after acceptance.".into(),
        })
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("already has an accepted completion")
    );
}

#[tokio::test]
async fn rejects_disconnected_layer_with_repair_message() {
    let (database, interaction) = setup(Some(project(1)), thread(1)).await;
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let a = node(&writer, "a").await;
    let b = node(&writer, "b").await;
    let error = writer
        .submit_layer(&LayerDraft {
            client_key: "root".into(),
            nodes: vec![a.id, b.id],
            edges: vec![],
        })
        .await
        .unwrap_err();
    assert!(error.to_string().contains("Add edges"));
}

#[tokio::test]
async fn resubmitting_draft_node_updates_same_object_but_accepted_is_immutable() {
    let (database, interaction) = setup(Some(project(1)), thread(1)).await;
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let first = node(&writer, "a").await;
    let changed = writer
        .submit_node(&NodeDraft {
            client_key: "a".into(),
            kind: "concept".into(),
            icon: "new".into(),
            title: "changed".into(),
            detail: "changed detail".into(),
        })
        .await
        .unwrap();
    assert_eq!(first.id, changed.id);
    accept_single_node(&writer, interaction, changed).await;
    assert!(matches!(
        writer
            .submit_node(&NodeDraft {
                client_key: "a".into(),
                kind: "concept".into(),
                icon: "x".into(),
                title: "x".into(),
                detail: "x".into(),
            })
            .await,
        Err(GraphError::Validation {
            code: "immutable_node",
            ..
        })
    ));
}

#[tokio::test]
async fn accepts_recursive_navigate_subgraph() {
    let (database, interaction) = setup(Some(project(1)), thread(1)).await;
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let parent = node(&writer, "parent").await;
    let child = node(&writer, "child").await;
    let nested = writer
        .submit_layer(&LayerDraft {
            client_key: "nested".into(),
            nodes: vec![child.id],
            edges: vec![],
        })
        .await
        .unwrap();
    writer
        .add_action(&ActionDraft {
            client_key: "deeper".into(),
            source_node_id: parent.id,
            kind: ActionKind::Navigate,
            label: "Details".into(),
            target_layer_id: Some(nested.id),
            interaction_text: None,
            response: false,
        })
        .await
        .unwrap();
    let root = writer
        .submit_layer(&LayerDraft {
            client_key: "root".into(),
            nodes: vec![parent.id],
            edges: vec![],
        })
        .await
        .unwrap();
    writer
        .add_action(&ActionDraft {
            client_key: "response".into(),
            source_node_id: interaction.id,
            kind: ActionKind::Navigate,
            label: "Response".into(),
            target_layer_id: Some(root.id),
            interaction_text: None,
            response: true,
        })
        .await
        .unwrap();
    writer.complete(interaction.id).await.unwrap();
    assert_eq!(
        writer.get_layer(nested.id).await.unwrap().layer.state,
        RecordState::Accepted
    );
}

#[tokio::test]
async fn project_threads_share_accepted_nodes() {
    let project_id = project(1);
    let (database, interaction) = setup(Some(project_id), thread(1)).await;
    let shared = {
        let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
        let shared = node(&writer, "shared").await;
        accept_single_node(&writer, interaction, shared.clone()).await;
        shared
    };
    let next = database
        .create_interaction(Some(project_id), thread(2), "continue")
        .await
        .unwrap();
    let writer = database.writer_for_subgraph(next.id).await.unwrap();
    assert_eq!(writer.get_node(shared.id).await.unwrap().title, "shared");
}

#[tokio::test]
async fn standalone_threads_do_not_share_accepted_nodes() {
    let (database, interaction) = setup(None, thread(1)).await;
    let private = {
        let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
        let private = node(&writer, "private").await;
        accept_single_node(&writer, interaction, private.clone()).await;
        private
    };
    let other = database
        .create_interaction(None, thread(2), "other standalone thread")
        .await
        .unwrap();
    let writer = database.writer_for_subgraph(other.id).await.unwrap();
    assert!(matches!(
        writer.get_node(private.id).await,
        Err(GraphError::Forbidden(_))
    ));
}

#[tokio::test]
async fn draft_records_are_private_to_the_active_subgraph() {
    let project_id = project(1);
    let (database, interaction) = setup(Some(project_id), thread(1)).await;
    let draft = {
        let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
        node(&writer, "private").await
    };
    let other = database
        .create_interaction(Some(project_id), thread(2), "other turn")
        .await
        .unwrap();
    let writer = database.writer_for_subgraph(other.id).await.unwrap();
    assert!(matches!(
        writer.get_node(draft.id).await,
        Err(GraphError::Forbidden(_))
    ));
}

#[tokio::test]
async fn creating_the_same_edge_object_twice_is_idempotent() {
    let (database, interaction) = setup(Some(project(1)), thread(1)).await;
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let a = node(&writer, "a").await;
    let b = node(&writer, "b").await;
    let draft = EdgeDraft {
        client_key: "ab".into(),
        endpoints: [a.id, b.id],
    };
    let first = writer.create_edge(&draft).await.unwrap();
    let second = writer.create_edge(&draft).await.unwrap();
    assert_eq!(first, second);
}

#[tokio::test]
async fn action_keys_are_scoped_to_their_source_nodes() {
    let (database, interaction) = setup(Some(project(1)), thread(1)).await;
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let first = node(&writer, "first-source").await;
    let second = node(&writer, "second-source").await;
    let first_action = writer
        .add_action(&ActionDraft {
            client_key: "follow-up".into(),
            source_node_id: first.id,
            kind: ActionKind::Invoke,
            label: "Ask".into(),
            target_layer_id: None,
            interaction_text: Some("Ask about the first node".into()),
            response: false,
        })
        .await
        .unwrap();
    let second_action = writer
        .add_action(&ActionDraft {
            client_key: "follow-up".into(),
            source_node_id: second.id,
            kind: ActionKind::Invoke,
            label: "Ask".into(),
            target_layer_id: None,
            interaction_text: Some("Ask about the second node".into()),
            response: false,
        })
        .await
        .unwrap();

    assert_ne!(first_action.id, second_action.id);
    assert_eq!(first_action.source_node_id, first.id);
    assert_eq!(second_action.source_node_id, second.id);
}

#[tokio::test]
async fn invoke_actions_reject_whitespace_only_interaction_text() {
    let (database, interaction) = setup(Some(project(1)), thread(1)).await;
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let source = node(&writer, "source").await;
    let error = writer
        .add_action(&ActionDraft {
            client_key: "empty-follow-up".into(),
            source_node_id: source.id,
            kind: ActionKind::Invoke,
            label: "Ask".into(),
            target_layer_id: None,
            interaction_text: Some("  \n\t".into()),
            response: false,
        })
        .await
        .unwrap_err();

    assert!(matches!(
        error,
        GraphError::Validation {
            code: "missing_interaction_text",
            ..
        }
    ));
}

#[tokio::test]
async fn authored_user_interaction_nodes_cannot_open_new_write_scopes() {
    let (database, interaction) = setup(Some(project(1)), thread(1)).await;
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let authored = writer
        .submit_node(&NodeDraft {
            client_key: "authored-interaction".into(),
            kind: "user-interaction".into(),
            icon: "user".into(),
            title: "Not a canonical turn".into(),
            detail: "This node was authored inside another interaction.".into(),
        })
        .await
        .unwrap();
    accept_single_node(&writer, interaction, authored.clone()).await;

    assert!(matches!(
        database.writer_for_subgraph(authored.id).await,
        Err(GraphError::Forbidden(_))
    ));
}

#[tokio::test]
async fn completion_rejects_an_edge_accepted_by_a_concurrent_interaction() {
    let project_id = project(1);
    let (database, seed_a) = setup(Some(project_id), thread(1)).await;
    let first_node = {
        let writer = database.writer_for_subgraph(seed_a.id).await.unwrap();
        let value = node(&writer, "shared-a").await;
        accept_single_node(&writer, seed_a, value.clone()).await;
        value
    };
    let seed_b = database
        .create_interaction(Some(project_id), thread(2), "Create the second shared node")
        .await
        .unwrap();
    let second_node = {
        let writer = database.writer_for_subgraph(seed_b.id).await.unwrap();
        let value = node(&writer, "shared-b").await;
        accept_single_node(&writer, seed_b, value.clone()).await;
        value
    };
    let first_interaction = database
        .create_interaction(Some(project_id), thread(3), "Connect the shared nodes")
        .await
        .unwrap();
    let second_interaction = database
        .create_interaction(Some(project_id), thread(4), "Also connect the shared nodes")
        .await
        .unwrap();
    let first_writer = database
        .writer_for_subgraph(first_interaction.id)
        .await
        .unwrap();
    let second_writer = database
        .writer_for_subgraph(second_interaction.id)
        .await
        .unwrap();

    for (writer, interaction, key) in [
        (&first_writer, &first_interaction, "first-edge"),
        (&second_writer, &second_interaction, "second-edge"),
    ] {
        let edge = writer
            .create_edge(&EdgeDraft {
                client_key: key.into(),
                endpoints: [first_node.id, second_node.id],
            })
            .await
            .unwrap();
        let layer = writer
            .submit_layer(&LayerDraft {
                client_key: "root".into(),
                nodes: vec![first_node.id, second_node.id],
                edges: vec![edge.id],
            })
            .await
            .unwrap();
        writer
            .add_action(&ActionDraft {
                client_key: "response".into(),
                source_node_id: interaction.id,
                kind: ActionKind::Navigate,
                label: "Response".into(),
                target_layer_id: Some(layer.id),
                interaction_text: None,
                response: true,
            })
            .await
            .unwrap();
    }

    first_writer.complete(first_interaction.id).await.unwrap();
    assert!(matches!(
        second_writer.complete(second_interaction.id).await,
        Err(GraphError::Validation {
            code: "duplicate_edge",
            ..
        })
    ));
}

#[tokio::test]
async fn accepted_layers_keep_their_original_action_snapshot() {
    let project_id = project(1);
    let (database, referenced_interaction) = setup(Some(project_id), thread(1)).await;
    let viewer_interaction = database
        .create_interaction(Some(project_id), thread(2), "Show the other interaction")
        .await
        .unwrap();
    let viewer = database
        .writer_for_subgraph(viewer_interaction.id)
        .await
        .unwrap();
    let viewer_layer = viewer
        .submit_layer(&LayerDraft {
            client_key: "root".into(),
            nodes: vec![referenced_interaction.id],
            edges: vec![],
        })
        .await
        .unwrap();
    viewer
        .add_action(&ActionDraft {
            client_key: "response".into(),
            source_node_id: viewer_interaction.id,
            kind: ActionKind::Navigate,
            label: "Response".into(),
            target_layer_id: Some(viewer_layer.id),
            interaction_text: None,
            response: true,
        })
        .await
        .unwrap();
    let before = viewer.complete(viewer_interaction.id).await.unwrap();
    assert!(before.root_layer.actions.is_empty());

    let referenced = database
        .writer_for_subgraph(referenced_interaction.id)
        .await
        .unwrap();
    let answer = node(&referenced, "later-answer").await;
    accept_single_node(&referenced, referenced_interaction, answer).await;

    let after = viewer.completion_output().await.unwrap().unwrap();
    assert!(after.root_layer.actions.is_empty());
}

#[tokio::test]
async fn accepted_completion_survives_database_reopen() {
    let file = tempfile::NamedTempFile::new().unwrap();
    let database = GraphDatabase::open(file.path()).await.unwrap();
    let interaction = database
        .create_interaction(Some(project(1)), thread(1), "Persist this answer")
        .await
        .unwrap();
    let writer = database.writer_for_subgraph(interaction.id).await.unwrap();
    let answer = node(&writer, "persisted").await;
    accept_single_node(&writer, interaction.clone(), answer).await;
    drop(writer);
    database.close().await;

    let reopened = GraphDatabase::open(file.path()).await.unwrap();
    let writer = reopened.writer_for_subgraph(interaction.id).await.unwrap();
    let output = writer.completion_output().await.unwrap().unwrap();
    assert_eq!(output.node_id, interaction.id);
    assert_eq!(output.root_layer.nodes[0].title, "persisted");
}

#[tokio::test]
async fn different_threads_can_write_through_the_same_pool() {
    let file = tempfile::NamedTempFile::new().unwrap();
    let database = GraphDatabase::open(file.path()).await.unwrap();
    let first = database
        .create_interaction(Some(project(1)), thread(1), "First thread")
        .await
        .unwrap();
    let second = database
        .create_interaction(Some(project(1)), thread(2), "Second thread")
        .await
        .unwrap();
    let first_writer = database.writer_for_subgraph(first.id).await.unwrap();
    let second_writer = database.writer_for_subgraph(second.id).await.unwrap();

    let first_draft = NodeDraft {
        client_key: "first".into(),
        kind: "concept".into(),
        icon: "one".into(),
        title: "First".into(),
        detail: "First thread write".into(),
    };
    let second_draft = NodeDraft {
        client_key: "second".into(),
        kind: "concept".into(),
        icon: "two".into(),
        title: "Second".into(),
        detail: "Second thread write".into(),
    };
    let (first_result, second_result) = tokio::join!(
        first_writer.submit_node(&first_draft),
        second_writer.submit_node(&second_draft)
    );

    assert_eq!(first_result.unwrap().title, "First");
    assert_eq!(second_result.unwrap().title, "Second");
}
