//! Replays `models/tla/CompletionCurrent.tla` scenario traces against the real
//! recursive-child launch and cleanup code.
//!
//! The graph is a real in-memory graph server with a real recursive child, the
//! product store is the real SQLite store, and only the harness is a fake. Its
//! start is refused, or runs while acknowledging another identity (a lost
//! acknowledgement). Each spec action maps to the function
//! `complete_prepared_child` or `stop_completion` calls for it, in the same
//! order. `observe` reads the graph current and the product rows back as the
//! spec's variables, and the replay compares them with the trace after every
//! step. Start-failure cleanup is the real background task: it fails and
//! settles the child, then cancels. The fake harness holds that cancel until the
//! replay reaches `CleanCancel`; the task's other loops cannot be paused, so the
//! replay compares state once the task has run. The semantic and exit observers,
//! set off by a child's Return and its provider's exit, are compared the same way.

use super::*;
use crate::{
    api::auth::DesktopSessionAuthenticator,
    completion_broker::{
        CompletionBrokerGrant, CompletionBrokerLease, CompletionBrokerRegistry,
        CompletionObservations,
    },
    conversation_export::{ConversationExportRecord, ExportAttemptOutcome, ExportProducer},
    product::{CreateThreadCommand, NodeContextDraftConfirmationService, ProductService},
    runtime::RuntimeClient,
    storage::SqliteProductStore,
};
use axum::{Router, routing};
use relayer_graph_core::{
    ActionDraft, ActionKind, ActionVariant, CurrentTransition, GraphDatabase, LayerDraft,
    LayerLayout, NavigateRelation, NodeDraft, NodeId, NodePlacement, TemporalFeatureConfig,
    ThreadId,
};
use std::{
    collections::HashMap,
    fs,
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

/// How long the replay lets the start-failure cleanup task run before it
/// compares state. A cleanup that settles takes a few milliseconds; one that
/// retries forever is still retrying when this elapses.
const CLEANUP_QUIESCENCE: Duration = Duration::from_millis(1500);

/// The thread's harness: the product's seeded codex-basic row, backed here by the
/// runtime's test implementation.
const HARNESS: &str = "codex-basic";

/// Admits a requested family plan the way the harness host does: every route at
/// adapter version 1, signed with the policy and plan digests the app server checks.
fn sign_admission(body: &Value) -> Value {
    let plan: crate::product::ExecutionModelPlan =
        serde_json::from_value(body["modelPlan"].clone()).unwrap();
    let admit =
        |route: &crate::product::ExecutionModelRoute| crate::product::AdmittedExecutionModelRoute {
            provider_id: route.provider_id.clone(),
            adapter_id: route.adapter_id.clone(),
            access_contract: route.access_contract.clone(),
            model_id: route.model_id.clone(),
            adapter_implementation_version: "1".into(),
        };
    let mut admitted = crate::product::AdmittedExecutionModelPlan {
        family_id: plan.family_id,
        family_revision: plan.family_revision,
        orchestrator: admit(&plan.orchestrator),
        roster: plan.roster.iter().map(admit).collect(),
        harness_policy_digest: crate::runtime::harness_policy_value_digest(&body["harnessPolicy"])
            .unwrap(),
        digest: String::new(),
    };
    admitted.digest = crate::runtime::admitted_model_plan_digest(&admitted).unwrap();
    serde_json::json!({
        "executionLeaseId": uuid::Uuid::new_v4().to_string(),
        "adapterImplementationVersion": "1",
        "admittedPlan": admitted,
    })
}

/// What the fake harness does, set by the replay.
struct HarnessControl {
    /// "fail" refuses a start; "lost" runs it but acknowledges another identity.
    start: Mutex<&'static str>,
    /// "ok" admits a family plan by signing it as the host does; "fail" refuses it;
    /// "unrecorded" admits it while the family is disabled, so no attempt can record it.
    admission: Mutex<&'static str>,
    /// The execution leases granted and not yet released.
    granted: Mutex<std::collections::HashSet<String>>,
    /// The harness-policy revision the last admission carried.
    admitted_policy_revision: Mutex<Option<u64>>,
    /// The child's provider run: none | running | cancelled | exited_ok | exited_err.
    prov: Mutex<&'static str>,
    /// The graph completion a successful start acknowledges.
    completion_id: Mutex<i64>,
    /// Once armed, a cancellation waits for the replay to release it.
    cancel_gated: AtomicBool,
    cancel_gate: tokio::sync::Semaphore,
}

/// Faults the graph server injects, set by a test.
#[derive(Default)]
struct GraphFaults {
    detail_asset_reads: std::sync::atomic::AtomicUsize,
    fail_input_occurrence_reads: AtomicBool,
    /// The next capability activation answers 503, as a busy graph would.
    fail_activation: AtomicBool,
    /// While set, every control preparation answers 200 with a body the client cannot
    /// decode, so the product cannot tell whether the graph committed it.
    garble_preparation: AtomicBool,
    /// This many control reads of a completion's current answer 503 first.
    fail_current_reads: std::sync::atomic::AtomicUsize,
    /// While set, invalidating a node's capabilities is refused with a 409, a deterministic
    /// failure startup cannot retry.
    refuse_invalidation: AtomicBool,
}

struct World {
    state: ApiState,
    product: ProductService,
    runtime: RuntimeClient,
    graph_url: String,
    thread: Thread,
    child: Interaction,
    seeded: PreparedInteraction,
    activated: Option<PreparedInteraction>,
    invocation: PreparedInvocation,
    origin_digest: String,
    completion_id: i64,
    stop_report: &'static str,
    graph: GraphDatabase,
    harness: Arc<HarnessControl>,
    faults: Arc<GraphFaults>,
    selected: bool,
    admission: Option<RecursiveChildAdmission>,
    attachment: Option<Value>,
    /// Whether the semantic and exit observers are running.
    observed: bool,
    /// A start-failure cleanup the handler has spawned but whose task has not run yet;
    /// it starts at the trace's first cleanup step.
    pending_cleanup: Option<(PreparedInteraction, LaunchFailure, Option<i64>)>,
    pool: sqlx::SqlitePool,
    tasks: ServerTasks,
    /// Owns the world's database, catalog, and workspaces; removed on drop, even when a
    /// trace panics. Declared last so every field holding the database drops first.
    root: tempfile::TempDir,
}

/// The fake graph and harness servers, aborted on drop so a panicking trace does not leave
/// them holding the database after the world's directory is removed.
struct ServerTasks(Vec<tokio::task::JoinHandle<Result<(), std::io::Error>>>);

impl Drop for ServerTasks {
    fn drop(&mut self) {
        for task in &self.0 {
            task.abort();
        }
    }
}

async fn serve(app: Router) -> (String, tokio::task::JoinHandle<Result<(), std::io::Error>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    (
        url,
        tokio::spawn(async move { axum::serve(listener, app).await }),
    )
}

impl World {
    /// A root interaction whose accepted current publishes one invoke action,
    /// and the recursive child prepared and bound for it, before any launch. A
    /// selected world gives the root a model selection the child inherits.
    async fn new(label: &str, selected: bool) -> Self {
        Self::build(label, selected, true).await
    }

    /// The parent has prepared the child's graph interaction (its `prepareComplete`), and the
    /// product has recorded the invocation, but the broker has not yet prepared or bound it.
    async fn unprepared(label: &str) -> Self {
        Self::build(label, false, false).await
    }

    async fn build(label: &str, selected: bool, bound: bool) -> Self {
        Self::build_mode(label, selected, bound, None).await
    }

    async fn build_mode(
        label: &str,
        selected: bool,
        bound: bool,
        durable_agent: Option<bool>,
    ) -> Self {
        Self::build_call_mode(label, selected, bound, durable_agent, false).await
    }

    async fn build_call_mode(
        label: &str,
        selected: bool,
        bound: bool,
        durable_agent: Option<bool>,
        reusable: bool,
    ) -> Self {
        let root = tempfile::Builder::new()
            .prefix(&format!("relayer-completion-trace-{label}-"))
            .tempdir()
            .unwrap();
        let database = root.path().join("product.sqlite3");
        let catalog = root.path().join("catalog.json");
        fs::write(
            &catalog,
            serde_json::json!({"schemaVersion":1,"configurations":[{"configuration":{
                "schemaVersion":1,"name":HARNESS,"implementation":"test",
                "implementationVersion":1,"permissionBindings":{"auto":{}},
                "complete":{"agentAuthored":true},"settings":{}
            },"digest":"sha256:test"}]})
            .to_string(),
        )
        .unwrap();
        let product = ProductService::new(SqliteProductStore::open(&database).await.unwrap(), true);
        let thread = product
            .create_thread(CreateThreadCommand {
                icon_selection_eligible: true,
                title: None,
                project_id: None,
                initial_message: "Root".into(),
                harness_configuration_name: HARNESS.into(),
                personal_presentation_version_key: None,
                permission_profile_id: "auto".into(),
                model_selection: None,
                allow_unselected_model: true,
            })
            .await
            .unwrap();

        let features = TemporalFeatureConfig {
            schema_read: true,
            root_current_write: true,
            projection_ui: true,
            invoke_resolution: true,
            provider_recursion: true,
            ..TemporalFeatureConfig::default()
        };
        // This fixture protects the historical one-shot conversion protocol,
        // not new reusable Invocation behavior. Reconstruct pre-contract source.
        let graph_path = root.path().join("legacy-graph.sqlite3");
        let graph = GraphDatabase::open(&graph_path).await.unwrap();
        graph.set_temporal_features(features).await.unwrap();
        let parent = graph
            .create_interaction(None, ThreadId::new(thread.id.value()).unwrap(), "Root")
            .await
            .unwrap();
        if durable_agent.is_none() {
            let legacy_pool =
                sqlx::SqlitePool::connect(&format!("sqlite://{}", graph_path.display()))
                    .await
                    .unwrap();
            for statement in [
                "DROP TRIGGER completion_contract_marker_guard",
                "DROP TRIGGER completion_contract_delete_guard",
            ] {
                sqlx::query(statement).execute(&legacy_pool).await.unwrap();
            }
            sqlx::query("UPDATE completion_states SET completion_contract_digest=NULL WHERE interaction_node_id=?1").bind(parent.id.value()).execute(&legacy_pool).await.unwrap();
            sqlx::query("DELETE FROM completion_contracts WHERE interaction_node_id=?1")
                .bind(parent.id.value())
                .execute(&legacy_pool)
                .await
                .unwrap();
            legacy_pool.close().await;
        }
        let writer = graph.writer_for_subgraph(parent.id).await.unwrap();
        let source = writer
            .submit_node(&NodeDraft {
                client_key: "source".into(),
                kind: "concept".into(),
                icon: "box".into(),
                title: "Source".into(),
                detail: "Source".into(),
            })
            .await
            .unwrap();
        let layer = writer
            .submit_layer(&LayerDraft {
                default_node_id: None,
                client_key: "current".into(),
                nodes: vec![source.id],
                edges: vec![],
                layout: Some(LayerLayout::v1(
                    vec![NodePlacement {
                        node_id: source.id,
                        x: 0.5,
                        y: 0.5,
                    }],
                    "default",
                )),
                size_justification: None,
            })
            .await
            .unwrap();
        let invoke = writer
            .add_action(&ActionDraft {
                client_key: "child".into(),
                source_node_id: source.id,
                source_layer_id: Some(layer.id),
                kind: ActionKind::Invoke,
                relation: None,
                label: "Investigate".into(),
                variant: ActionVariant::Pill,
                icon: None,
                description: None,
                target_layer_id: None,
                interaction_text: Some("Child work".into()),
                reusable: Some(reusable),
                input_action_ids: Vec::new(),
                input: None,
            })
            .await
            .unwrap();
        if durable_agent.is_some() {
            writer
                .add_action(&ActionDraft {
                    client_key: "root".into(),
                    source_node_id: parent.id,
                    source_layer_id: None,
                    kind: ActionKind::Navigate,
                    relation: Some(relayer_graph_core::NavigateRelation::Expand),
                    label: "Response".into(),
                    variant: ActionVariant::Pill,
                    icon: None,
                    description: None,
                    target_layer_id: Some(layer.id),
                    interaction_text: None,
                    reusable: None,
                    input_action_ids: Vec::new(),
                    input: None,
                })
                .await
                .unwrap();
        }
        writer
            .transition_current(
                0,
                "publish-child",
                CurrentTransition::Advance { layer_id: layer.id },
            )
            .await
            .unwrap();
        let graph_reader = graph.clone();
        let faults = Arc::new(GraphFaults::default());
        let injected = faults.clone();
        let graph_app = relayer_graph_server::router(
            relayer_graph_server::ServerState::new(graph, "graph-control")
                .with_temporal_features(features),
        )
        .layer(axum::middleware::from_fn(
            move |request: axum::extract::Request, next: axum::middleware::Next| {
                let faults = injected.clone();
                async move {
                    use axum::response::IntoResponse;
                    if request.method() == axum::http::Method::GET
                        && request.uri().path().contains("/detail-assets/")
                    {
                        faults.detail_asset_reads.fetch_add(1, Ordering::SeqCst);
                    }
                    if request.method() == axum::http::Method::GET
                        && request.uri().path().ends_with("/current")
                        && faults
                            .fail_current_reads
                            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |left| {
                                left.checked_sub(1)
                            })
                            .is_ok()
                    {
                        return (
                            StatusCode::SERVICE_UNAVAILABLE,
                            axum::Json(serde_json::json!({
                                "error":{"code":"unavailable","message":"graph busy"}
                            })),
                        )
                            .into_response();
                    }
                    if request.method() == axum::http::Method::DELETE
                        && request.uri().path() == "/api/control/capabilities"
                        && faults.refuse_invalidation.load(Ordering::SeqCst)
                    {
                        return (
                            StatusCode::CONFLICT,
                            axum::Json(serde_json::json!({
                                "error":{"code":"conflict","message":"refused"}
                            })),
                        )
                            .into_response();
                    }
                    if request.method() == axum::http::Method::POST {
                        let path = request.uri().path();
                        if path == "/api/control/input-action-occurrences/canonical"
                            && faults.fail_input_occurrence_reads.load(Ordering::SeqCst)
                        {
                            return (StatusCode::SERVICE_UNAVAILABLE, axum::Json(
                                serde_json::json!({"error":{"code":"unavailable","message":"graph busy"}})
                            )).into_response();
                        }
                        if path == "/api/control/capabilities"
                            && faults.fail_activation.swap(false, Ordering::SeqCst)
                        {
                            return (
                                StatusCode::SERVICE_UNAVAILABLE,
                                axum::Json(serde_json::json!({
                                    "error":{"code":"unavailable","message":"graph busy"}
                                })),
                            )
                                .into_response();
                        }
                        if path == "/api/control/interactions"
                            && faults.garble_preparation.load(Ordering::SeqCst)
                        {
                            return (StatusCode::OK, "{not json").into_response();
                        }
                    }
                    next.run(request).await
                }
            },
        ));

        let pool = sqlx::SqlitePool::connect(&format!("sqlite://{}", database.display()))
            .await
            .unwrap();
        sqlx::query(
            "UPDATE interactions SET graph_node_id=?1,completion_status='accepted',completion_output_json=?2 WHERE id=?3",
        )
        .bind(parent.id.value())
        .bind(
            serde_json::json!({
                "nodeId":parent.id.value(),
                "rootLayer":{"layer":{"id":layer.id.value()},"nodes":[],"edges":[],"actions":[{
                    "id":invoke.id.value(),"kind":"invoke","interactionText":"Child work",
                    "state":"accepted","targetLayerId":null
                }]}
            })
            .to_string(),
        )
        .bind(thread.root_interaction_id.value())
        .execute(&pool)
        .await
        .unwrap();
        if selected {
            // The seeded catalog the product's own storage tests use: one connected
            // provider model in one family, routable by the thread's harness.
            for statement in [
                "UPDATE model_providers SET connected=1,unavailable_reason_code=NULL,unavailable_reason_message=NULL,refreshed_at='1' WHERE id='codex'",
                "INSERT INTO provider_models(provider_id,model_id,label,provider_order,visible,available,provider_default,metadata_json) VALUES ('codex','test-model','Test model',0,1,1,1,'{}')",
                "UPDATE product_harnesses SET available=1,unavailable_reason_code=NULL,unavailable_reason_message=NULL WHERE configuration_name='codex-basic'",
                "INSERT INTO model_families(id,name,kind,system_key,enabled,position) VALUES (1,'Codex','system','codex',1,0)",
                "INSERT INTO model_family_members(family_id,position,provider_id,model_id) VALUES (1,0,'codex','test-model')",
            ] {
                sqlx::query(statement).execute(&pool).await.unwrap();
            }
            sqlx::query("UPDATE interactions SET model_provider_id='codex',provider_model_id='test-model',model_family_id=1 WHERE id=?1")
                .bind(thread.root_interaction_id.value())
                .execute(&pool)
                .await
                .unwrap();
        }

        let harness_control = Arc::new(HarnessControl {
            start: Mutex::new("fail"),
            admission: Mutex::new("ok"),
            granted: Mutex::new(std::collections::HashSet::new()),
            admitted_policy_revision: Mutex::new(None),
            prov: Mutex::new("none"),
            completion_id: Mutex::new(0),
            cancel_gated: AtomicBool::new(false),
            cancel_gate: tokio::sync::Semaphore::new(0),
        });
        let start_control = harness_control.clone();
        let cancel_control = harness_control.clone();
        let admission_control = harness_control.clone();
        let release_control = harness_control.clone();
        let admission_pool = pool.clone();
        let observe_control = harness_control.clone();
        let harness = Router::new()
            // Like the host: a run it never registered is an error, a live run is
            // answered only when it ends, and an ended run answers at once.
            .route(
                "/sessions/{id}/invoked-completions/{completion}",
                routing::get(
                    move |axum::extract::Path((_, completion)): axum::extract::Path<(
                        String,
                        i64,
                    )>,
                          axum::extract::Query(query): axum::extract::Query<
                        HashMap<String, String>,
                    >| {
                        let control = observe_control.clone();
                        // Like the host, a bounded observation answers `running` once its wait
                        // passes while the child still runs.
                        let deadline = query
                            .get("waitMs")
                            .and_then(|wait| wait.parse::<u64>().ok())
                            .map(|wait| Instant::now() + Duration::from_millis(wait));
                        async move {
                            loop {
                                let prov = *control.prov.lock().unwrap();
                                if prov == "running"
                                    && deadline.is_some_and(|deadline| Instant::now() >= deadline)
                                {
                                    return (
                                        StatusCode::OK,
                                        axum::Json(serde_json::json!({
                                            "completionId": completion,
                                            "running": true
                                        })),
                                    );
                                }
                                match prov {
                                    "none" => {
                                        return (
                                            StatusCode::INTERNAL_SERVER_ERROR,
                                            axum::Json(serde_json::json!({
                                                "error":"Invoked completion is not registered"
                                            })),
                                        );
                                    }
                                    "running" => {
                                        tokio::time::sleep(Duration::from_millis(20)).await
                                    }
                                    _ => {
                                        return (
                                            StatusCode::OK,
                                            axum::Json(
                                                serde_json::json!({"completionId":completion}),
                                            ),
                                        );
                                    }
                                }
                            }
                        }
                    },
                ),
            )
            .route(
                "/sessions",
                // The thread's live session is held by the running root turn, which
                // awaits its child, so a child must never ask the host to set it up.
                routing::post(|| async {
                    (
                        StatusCode::CONFLICT,
                        axum::Json(
                            serde_json::json!({"error":"session is held by the running root turn"}),
                        ),
                    )
                }),
            )
            .route(
                "/sessions/{id}/execution-leases",
                routing::post(move |axum::Json(body): axum::Json<Value>| {
                    let control = admission_control.clone();
                    let pool = admission_pool.clone();
                    async move {
                        let mode = *control.admission.lock().unwrap();
                        if mode == "unrecorded" {
                            sqlx::query("UPDATE model_families SET enabled=0 WHERE id=1")
                                .execute(&pool)
                                .await
                                .unwrap();
                        } else if mode != "ok" {
                            return (
                                StatusCode::CONFLICT,
                                axum::Json(serde_json::json!({
                                    "error": "the plan's model is not admitted",
                                    "failureCategory": "model_unavailable",
                                    "effectBoundary": "none",
                                })),
                            );
                        }
                        *control.admitted_policy_revision.lock().unwrap() =
                            body["harnessPolicy"]["configurationRevision"].as_u64();
                        let admission = sign_admission(&body);
                        control
                            .granted
                            .lock()
                            .unwrap()
                            .insert(admission["executionLeaseId"].as_str().unwrap().to_owned());
                        (StatusCode::CREATED, axum::Json(admission))
                    }
                }),
            )
            .route(
                "/sessions/{id}/execution-leases/{lease}",
                routing::delete(
                    move |axum::extract::Path((_, lease)): axum::extract::Path<(
                        String,
                        String,
                    )>| {
                        let control = release_control.clone();
                        async move {
                            let released = control.granted.lock().unwrap().remove(&lease);
                            axum::Json(serde_json::json!({"released":released}))
                        }
                    },
                ),
            )
            .route(
                "/sessions/{id}/invoked-completions",
                routing::post(move || {
                    let control = start_control.clone();
                    async move {
                        let mode = *control.start.lock().unwrap();
                        if mode == "ok" {
                            *control.prov.lock().unwrap() = "running";
                            let completion_id = *control.completion_id.lock().unwrap();
                            return (
                                StatusCode::CREATED,
                                axum::Json(serde_json::json!({
                                    "completionId":completion_id,
                                    "attachment":{"schemaVersion":1,"provider":"test"}
                                })),
                            );
                        }
                        if mode == "lost" {
                            *control.prov.lock().unwrap() = "running";
                            (
                                StatusCode::CREATED,
                                axum::Json(serde_json::json!({
                                    "completionId":0,
                                    "attachment":{"schemaVersion":1,"provider":"test"}
                                })),
                            )
                        } else {
                            (
                                StatusCode::CONFLICT,
                                axum::Json(serde_json::json!({
                                    "error":{"code":"start_failed","message":"refused"}
                                })),
                            )
                        }
                    }
                }),
            )
            .route(
                "/sessions/{id}/cancel",
                routing::post(move || {
                    let control = cancel_control.clone();
                    async move {
                        if control.cancel_gated.load(Ordering::SeqCst) {
                            control.cancel_gate.acquire().await.unwrap().forget();
                        }
                        let mut prov = control.prov.lock().unwrap();
                        if *prov == "running" {
                            *prov = "cancelled";
                        }
                        axum::Json(serde_json::json!({"cancelled":true}))
                    }
                }),
            );
        let (graph_url, graph_task) = serve(graph_app).await;
        let (harness_url, harness_task) = serve(harness).await;
        let mut runtime = RuntimeClient::open(
            &graph_url,
            &harness_url,
            "graph-control".into(),
            "harness-control".into(),
            &catalog,
        )
        .await
        .unwrap();
        // Observations of a live run time out and are polled again; keep that fast.
        runtime.set_observation_poll(Duration::from_millis(100));
        let permission_catalog = crate::permissions::PermissionCatalog::load(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("../../permissions/desktop.json"),
        )
        .await
        .unwrap();

        let invocation = PreparedInvocation {
            source_interaction_node_id: parent.id.value(),
            source_action_id: invoke.id.value(),
        };
        let durable_node = if durable_agent.is_some() {
            Some(
                writer
                    .prepare_recursive_invocation(invoke.id, "startup-call")
                    .await
                    .unwrap()
                    .0
                    .id
                    .value(),
            )
        } else {
            None
        };
        let child = if let Some(node) = durable_node {
            product
                .invoke_durable_action(
                    thread.root_interaction_id,
                    invoke.id.value(),
                    "Child work",
                    node,
                    durable_agent.unwrap(),
                    "startup-call",
                )
                .await
                .unwrap()
                .interaction
        } else {
            product
                .invoke_action_recursively(
                    thread.root_interaction_id,
                    invoke.id.value(),
                    "Child work",
                )
                .await
                .unwrap()
                .interaction
        };
        assert_eq!(child.model_selection.is_some(), selected);
        let state = ApiState {
            product: product.clone(),
            authenticator: DesktopSessionAuthenticator::new("control", None),
            runtime: Some(runtime.clone()),
            interaction_execution: None,
            context_draft_confirmation: NodeContextDraftConfirmationService::new(
                product.clone(),
                Some(runtime.clone()),
            ),
            permission_catalog,
            default_harness_configuration: HARNESS.into(),
            allow_harness_override: true,
            eval_mode: false,
            allow_conversation_import: false,
            standalone_workspaces_directory: root.path().join("workspaces"),
            export_producer: ExportProducer {
                desktop_version: "test".into(),
                build_commit: "test".into(),
                platform: "test".into(),
                architecture: "test".into(),
            },
            approval_decisions: Arc::new(Mutex::new(HashMap::new())),
            annotation_sessions: Arc::new(Mutex::new(HashMap::new())),
            input_operator_sessions: Arc::new(Mutex::new(HashMap::new())),
            annotations_enabled: false,
            environment_inspector: crate::environment::EnvironmentInspector::new(),
            completion_brokers: CompletionBrokerRegistry::new(Some("http://broker".into())),
            completion_observations: CompletionObservations::default(),
        };
        let seeded = if bound {
            // Prepared and bound exactly as complete_prepared_child prepares it.
            prepare_and_claim_interaction(&state, &thread, &child, false, true)
                .await
                .unwrap_or_else(|error| panic!("prepare: {}", error.message()))
                .expect("prepared child")
        } else {
            // Only the graph interaction exists, as the parent's prepareComplete leaves it:
            // the same leased node the product's own preparation recovers for this occurrence.
            let working_directory = root.path().to_string_lossy().into_owned();
            let prepared = runtime
                .prepare_bound(
                    &CompleteInteraction {
                        thread_icon_selection_eligible: false,
                        require_native_continuity: false,
                        native_history_anchor: None,
                        project_id: None,
                        product_interaction_id: child.id.value(),
                        thread_id: thread.id.value(),
                        interaction_id: child.id.value(),
                        text: &child.text,
                        working_directory: &working_directory,
                        harness_configuration_name: HARNESS,
                        permission_profile: state.permission_catalog.profile("auto").unwrap(),
                        model_selection: None,
                        model_plan: None,
                        attempt_admission_id: None,
                        execution_lease_id: None,
                        harness_policy: None,
                        invocation: Some(invocation),
                        input_identity: None,
                        input_digest: None,
                        personal_presentation: None,
                        contexts: &[],
                        submitted_inputs: &[],
                    },
                    durable_node,
                )
                .await
                .unwrap();
            runtime.discard_prepared(prepared.clone()).await.unwrap();
            prepared
        };
        let origin_digest =
            completion_permission_origin_digest(&seeded.effective_permission_receipt, invocation)
                .unwrap_or_else(|error| panic!("origin digest: {}", error.message()));
        Self {
            graph_url,
            state,
            product,
            runtime,
            thread,
            completion_id: {
                *harness_control.completion_id.lock().unwrap() = seeded.graph_node_id;
                seeded.graph_node_id
            },
            child,
            seeded,
            activated: None,
            invocation,
            origin_digest,
            stop_report: "none",
            graph: graph_reader,
            harness: harness_control,
            faults,
            selected,
            admission: None,
            observed: false,
            pending_cleanup: None,
            attachment: None,
            pool,
            tasks: ServerTasks(vec![graph_task, harness_task]),
            root,
        }
    }

    /// The parent execution's broker authority, as the root turn holds it while it runs.
    fn broker(&self) -> (HeaderMap, CompletionBrokerLease) {
        let parent = self
            .graph_source()
            .expect("the child records its invoke occurrence");
        let lease = self.state.completion_brokers.issue(CompletionBrokerGrant {
            thread_id: self.thread.id,
            source_interaction_id: self.thread.root_interaction_id,
            source_completion_id: parent,
        });
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            format!("Bearer {}", lease.token()).parse().unwrap(),
        );
        (headers, lease)
    }

    fn graph_source(&self) -> Option<i64> {
        Some(self.invocation.source_interaction_node_id)
    }

    /// The parent agent's broker launch of its prepared child.
    async fn launch(
        &self,
        headers: &HeaderMap,
    ) -> Result<(StatusCode, Json<CompletePreparedChildResponse>), ApiError> {
        complete_prepared_child(
            State(self.state.clone()),
            headers.clone(),
            Json(CompletePreparedChildRequest {
                interaction_node: self.completion_id,
            }),
        )
        .await
    }

    /// What the parent's `result` observation of the child answers.
    async fn observed_result(&self, headers: &HeaderMap) -> (StatusCode, Value) {
        let (status, Json(body)) = completion_result(
            State(self.state.clone()),
            headers.clone(),
            Path(self.completion_id),
            Query(CompletionResultQuery {
                after_revision: None,
            }),
        )
        .await
        .unwrap_or_else(|error| panic!("result observation: {}", error.message()));
        (status, body)
    }

    /// Restarts the product server over the same database: the startup reconciliation
    /// `RelayerAppServer::open` runs, against the graph and harness that outlived it.
    async fn restart(&self) {
        let restarted = SqliteProductStore::open(&self.root.path().join("product.sqlite3"))
            .await
            .unwrap();
        crate::app_server::reconcile_interrupted_work(
            &restarted,
            Some(&self.runtime),
            &self.state.permission_catalog,
        )
        .await
        .unwrap();
    }

    /// Sets the parent's product status, as its own run or a restart left it.
    async fn set_parent_status(&self, status: &str) {
        sqlx::query("UPDATE interactions SET completion_status=?1 WHERE id=?2")
            .bind(status)
            .bind(self.thread.root_interaction_id.value())
            .execute(&self.pool)
            .await
            .unwrap();
    }

    /// Waits for background work to reach a state, then returns the state it last saw.
    async fn await_state(&self, reached: impl Fn(&Value) -> bool) -> Value {
        let deadline = Instant::now() + CLEANUP_QUIESCENCE;
        loop {
            let state = self.observe().await;
            if reached(&state) || Instant::now() >= deadline {
                return state;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    async fn graph_failure_pending(&self) -> bool {
        sqlx::query_scalar(
            "SELECT graph_failure_pending FROM action_invocations WHERE result_interaction_id=?1",
        )
        .bind(self.child.id.value())
        .fetch_one(&self.pool)
        .await
        .unwrap()
    }

    async fn child_row(&self) -> Interaction {
        self.product.get_interaction(self.child.id).await.unwrap()
    }

    fn binding(&self) -> CompletionExecutionBinding<'_> {
        CompletionExecutionBinding {
            interaction_id: self.child.id,
            graph_completion_id: self.completion_id,
            harness_configuration_name: &self.seeded.harness_configuration_name,
            harness_configuration_digest: &self.seeded.harness_configuration_digest,
            model_execution_digest: &self.seeded.effective_execution_digest,
            permission_origin_digest: &self.origin_digest,
        }
    }

    /// Performs one spec action through the code that implements it.
    async fn apply(&mut self, action: &[Value], next_is_cleanup: bool) {
        let name = action[0].as_str().unwrap();
        let argument = |index: usize| action.get(index).and_then(Value::as_str).unwrap_or("");
        match name {
            // The execution row does not exist yet, so the handler proceeds (THR:1322).
            "LaunchCheck" => assert!(
                self.product
                    .completion_execution(self.child.id)
                    .await
                    .unwrap()
                    .is_none()
            ),
            "LaunchReserve" => {
                self.product
                    .reserve_completion_execution(self.binding(), &completion_timestamp())
                    .await
                    .unwrap();
            }
            "LaunchClaim" => assert!(
                self.product
                    .claim_completion_execution_launching(
                        self.child.id,
                        &self.origin_digest,
                        &completion_timestamp(),
                    )
                    .await
                    .unwrap()
            ),
            // Claimed and activated as complete_prepared_child does it (THR launch owner).
            "LaunchActivate" => {
                let ok = argument(2) == "ok";
                self.faults.fail_activation.store(!ok, Ordering::SeqCst);
                let activated = claim_and_activate_prepared_interaction(
                    &self.state,
                    &self.thread,
                    &self.child,
                    self.seeded.clone(),
                    false,
                    false,
                )
                .await;
                if ok {
                    let activated = activated
                        .unwrap_or_else(|error| panic!("activation: {}", error.message()))
                        .expect("activation ownership");
                    self.activated = Some(activated);
                    return;
                }
                assert!(activated.is_err(), "a failed activation is an error");
                // Nothing was admitted or started, so its cleanup never cancels.
                self.pending_cleanup =
                    Some((self.seeded.clone(), LaunchFailure::ActivationFailed, None));
            }
            "LaunchAdmit" => {
                let ok = argument(2) == "ok";
                *self.harness.admission.lock().unwrap() = if ok { "ok" } else { "fail" };
                let activated = self.activated.clone().expect("activated before admission");
                match admit_recursive_child(
                    &self.state,
                    &self.runtime,
                    &self.thread,
                    &self.child,
                    &activated,
                )
                .await
                {
                    Ok(admission) => {
                        assert!(ok, "the fake harness refused this admission");
                        self.admission = admission;
                    }
                    Err(refusal) => {
                        assert!(!ok, "the admission was expected to succeed");
                        // A refused admission started nothing, so its cleanup must not
                        // cancel. Arming the gate makes a cancel hang and the replay diverge.
                        self.harness.cancel_gated.store(true, Ordering::SeqCst);
                        self.pending_cleanup = Some((
                            activated,
                            LaunchFailure::AdmissionRefused(refusal.reason),
                            None,
                        ));
                    }
                }
            }
            "LaunchStart" => {
                let mode = match argument(2) {
                    "ok" => "ok",
                    "fail" => "fail",
                    "lost" => "lost",
                    other => panic!("the adapter cannot start with outcome {other}"),
                };
                *self.harness.start.lock().unwrap() = mode;
                let activated = self.activated.clone().expect("activated before start");
                let started = self
                    .runtime
                    .start_invoked_completion(
                        self.thread.id.value(),
                        self.child.id.value(),
                        &activated,
                        self.invocation,
                        None,
                        self.admission.as_ref().map(|admission| {
                            crate::runtime::InvokedCompletionAdmission {
                                model_plan: &admission.model_plan,
                                execution_lease_id: &admission.execution_lease_id,
                                attempt_admission_id: &admission.attempt_admission_id,
                            }
                        }),
                    )
                    .await;
                if mode == "ok" {
                    let started = started.unwrap_or_else(|error| panic!("start: {error}"));
                    self.attachment = started.attachment.map(Value::Object);
                    return;
                }
                assert!(started.is_err(), "a {mode} start must fail");
                // The cleanup's cancel waits for the trace's CleanCancel step.
                self.harness.cancel_gated.store(true, Ordering::SeqCst);
                self.pending_cleanup = Some((
                    activated,
                    LaunchFailure::StartFailed,
                    self.admission
                        .as_ref()
                        .map(|admission| admission.attempt_id),
                ));
            }
            // Attach, then spawn both observers, as complete_prepared_child does (THR:1508).
            "LaunchAttach" => {
                assert_eq!(
                    argument(2),
                    "ok",
                    "the adapter drives successful attachment only"
                );
                let attachment = self.attachment.clone().expect("started before attach");
                self.product
                    .attach_completion_execution(
                        self.child.id,
                        &self.origin_digest,
                        &attachment,
                        &completion_timestamp(),
                    )
                    .await
                    .unwrap();
                spawn_recursive_completion_observers(
                    self.state.clone(),
                    self.thread.clone(),
                    self.child.clone(),
                    self.activated.clone().expect("activated before attach"),
                    self.origin_digest.clone(),
                    None,
                    self.admission
                        .as_ref()
                        .map(|admission| admission.attempt_id),
                );
                self.observed = true;
            }
            // The semantic observer projects the terminal current on its own.
            "SemFinalize" => self.await_settled().await,
            "ProviderExit" => {
                *self.harness.prov.lock().unwrap() = match argument(1) {
                    "exited_ok" => "exited_ok",
                    _ => "exited_err",
                };
            }
            // stop_completion's GET and POSTs are one terminate call here (THR:1732).
            "StopRead" => {}
            "StopPost" => {
                let key = format!("completion-stop:{}:{}", self.child.id, self.completion_id);
                self.stop_report = match self
                    .runtime
                    .stop_graph_completion(self.completion_id, &key)
                    .await
                {
                    Ok(_) => "stopped",
                    Err(_) => match self.lifecycle().await.as_str() {
                        "active" => "error",
                        "succeeded" => "succeeded",
                        "stopped" => "stopped",
                        _ => "failed",
                    },
                };
            }
            "StopCancel" => {
                if self.stop_report != "error" {
                    let _ = self
                        .runtime
                        .cancel_invoked_completion(self.thread.id.value(), self.completion_id)
                        .await;
                }
            }
            // The child's model returns through its own graph writer.
            "ChildReturn" => {
                let head = self
                    .runtime
                    .completion_current(self.completion_id)
                    .await
                    .unwrap()
                    .head_revision;
                let writer = self
                    .graph
                    .writer_for_subgraph(NodeId::new(self.completion_id).unwrap())
                    .await
                    .unwrap();
                let answer = writer
                    .submit_node(&NodeDraft {
                        client_key: "answer".into(),
                        kind: "concept".into(),
                        icon: "box".into(),
                        title: "Answer".into(),
                        detail: "Answer".into(),
                    })
                    .await
                    .unwrap();
                let layer = writer
                    .submit_layer(&LayerDraft {
                        default_node_id: None,
                        client_key: "answer".into(),
                        nodes: vec![answer.id],
                        edges: vec![],
                        layout: Some(LayerLayout::v1(
                            vec![NodePlacement {
                                node_id: answer.id,
                                x: 0.5,
                                y: 0.5,
                            }],
                            "default",
                        )),
                        size_justification: None,
                    })
                    .await
                    .unwrap();
                writer
                    .add_action(&ActionDraft {
                        client_key: "response".into(),
                        source_node_id: NodeId::new(self.completion_id).unwrap(),
                        source_layer_id: None,
                        kind: ActionKind::Navigate,
                        relation: Some(NavigateRelation::Expand),
                        label: "Response".into(),
                        variant: ActionVariant::default(),
                        icon: None,
                        description: None,
                        target_layer_id: Some(layer.id),
                        interaction_text: None,
                        reusable: None,
                        input_action_ids: Vec::new(),
                        input: None,
                    })
                    .await
                    .unwrap();
                writer
                    .transition_current(
                        head,
                        "child-return",
                        CurrentTransition::Return { layer_id: layer.id },
                    )
                    .await
                    .unwrap();
            }
            // Settlement reconciles the terminal attempt's lease inline, inside cleanup.
            "CleanCancel" | "CleanFail" | "CleanFinalize" | "CleanDiscard" | "ExitObserve"
            | "ExitCheckAndFail" | "ExitDiscard" | "AttemptEnd" | "LeaseReconcile" => {
                // The handler spawned the cleanup at the failed start; its task first runs
                // here, which the trace may reach after a child's Return or a stop.
                if name.starts_with("Clean")
                    && let Some((prepared, failure, attempt_id)) = self.pending_cleanup.take()
                {
                    spawn_failed_recursive_start_cleanup(
                        self.state.clone(),
                        self.thread.clone(),
                        self.child.clone(),
                        prepared,
                        self.origin_digest.clone(),
                        failure,
                        attempt_id,
                    );
                }
                if name == "CleanCancel" {
                    self.harness.cancel_gate.add_permits(1);
                }
                if !next_is_cleanup {
                    self.await_cleanup().await;
                }
            }
            other => panic!("the completion trace adapter does not implement {other}"),
        }
    }

    async fn await_settled(&self) {
        let deadline = Instant::now() + CLEANUP_QUIESCENCE;
        while Instant::now() < deadline && self.observe().await["phase"] != "settled" {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    async fn await_cleanup(&self) {
        let deadline = Instant::now() + CLEANUP_QUIESCENCE;
        while Instant::now() < deadline {
            // Cleanup is done once the child settled, its attempt ended, and its lease
            // (if it was admitted) was released.
            let state = self.observe().await;
            if state["phase"] == "settled"
                && state["attempt"] != "running"
                && state["lease"] != "held"
            {
                // Let the discard loop finish after settlement.
                tokio::time::sleep(Duration::from_millis(50)).await;
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    async fn lifecycle(&self) -> String {
        let current = self
            .runtime
            .completion_current(self.completion_id)
            .await
            .unwrap();
        serde_json::to_value(current.lifecycle)
            .unwrap()
            .as_str()
            .unwrap()
            .to_owned()
    }

    /// The refinement mapping: real graph and product state as spec variables.
    async fn observe(&self) -> Value {
        let current = self
            .runtime
            .completion_current(self.completion_id)
            .await
            .unwrap();
        let (phase, execution_reason) = match self
            .product
            .completion_execution(self.child.id)
            .await
            .unwrap()
        {
            None => ("none", "none".to_owned()),
            Some(execution) => (
                match execution.phase {
                    CompletionExecutionPhase::Reserved => "reserved",
                    CompletionExecutionPhase::Launching => "launching",
                    CompletionExecutionPhase::Attached => "attached",
                    CompletionExecutionPhase::Settled => "settled",
                },
                execution.safe_reason.unwrap_or_else(|| "none".into()),
            ),
        };
        let status = self
            .product
            .get_interaction(self.child.id)
            .await
            .unwrap()
            .completion_status;
        let attempt_row: Option<(String, Option<String>, Option<String>)> = sqlx::query_as(
            "SELECT outcome,execution_lease_id,execution_lease_reconciled_at FROM interaction_attempts WHERE interaction_id=?1 ORDER BY id DESC LIMIT 1",
        )
        .bind(self.child.id.value())
        .fetch_optional(&self.pool)
        .await
        .unwrap();
        let (attempt, lease) = match attempt_row {
            None => ("none", "none"),
            Some((outcome, lease_id, reconciled)) => (
                if outcome == "running" {
                    "running"
                } else {
                    "terminal"
                },
                match (lease_id, reconciled) {
                    (None, _) => "none",
                    (Some(_), None) => "held",
                    (Some(_), Some(_)) => "released",
                },
            ),
        };
        serde_json::json!({
            "selected": self.selected,
            "attempt": attempt,
            "lease": lease,
            "prov": *self.harness.prov.lock().unwrap(),
            "life": serde_json::to_value(current.lifecycle).unwrap(),
            "head": current.head_revision,
            "why": current.safe_reason.unwrap_or_else(|| "none".into()),
            "phase": phase,
            "status": status,
            "stopReport": self.stop_report,
            "execWhy": execution_reason,
        })
    }

    /// Stops the servers and waits until they have released the database, so the
    /// world's directory can be removed even where open files cannot be deleted.
    async fn finish(mut self) {
        for task in std::mem::take(&mut self.tasks.0) {
            task.abort();
            let _ = task.await;
        }
        self.pool.close().await;
    }
}

fn project_model_state(state: &Value) -> Value {
    serde_json::json!({
        "selected": state["selected"],
        "attempt": state["attempt"],
        "lease": state["lease"],
        "prov": state["prov"],
        "life": state["life"],
        "head": state["head"],
        "why": state["why"],
        "phase": state["phase"],
        "status": state["status"],
        "stopReport": state["stopReport"],
        "execWhy": state["execWhy"],
    })
}

fn promise_holds(name: &str, state: &Value) -> bool {
    let life = state["life"].as_str().unwrap();
    let phase = state["phase"].as_str().unwrap();
    let status = state["status"].as_str().unwrap();
    match name {
        "SettledExecutionAgreesWithGraph" => {
            (phase != "settled" || life != "active")
                && (status != "accepted" || life == "succeeded")
                && (!(status == "failed" && phase == "settled")
                    || matches!(life, "stopped" | "failed"))
        }
        "LeaseReleasedOnlyAfterSettlement" => {
            state["lease"] != "released" || state["attempt"] == "terminal"
        }
        "ProviderRunsUnderLease" => {
            !(state["selected"] == true && state["prov"] == "running") || state["lease"] == "held"
        }
        "AttemptEndsOnlyAfterProvider" => {
            state["attempt"] != "terminal" || (phase == "settled" && state["prov"] != "running")
        }
        "LeaseReleased" => state["lease"] != "held",
        "ChildSettles" => {
            life != "active" && phase == "settled" && matches!(status, "accepted" | "failed")
        }
        other => panic!("unknown promise {other}"),
    }
}

fn traces() -> Vec<Value> {
    let directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../models/tla/traces");
    let mut traces = fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .map(|path| serde_json::from_str::<Value>(&fs::read_to_string(path).unwrap()).unwrap())
        .filter(|trace| trace["module"] == "CompletionCurrent")
        .collect::<Vec<_>>();
    traces.sort_by(|left, right| left["scenario"].as_str().cmp(&right["scenario"].as_str()));
    traces
}

async fn replay(trace: &Value) {
    let scenario = trace["scenario"].as_str().unwrap();
    let selected = trace["steps"][0]["state"]["selected"] == true;
    let mut world = World::new(scenario, selected).await;
    let steps = trace["steps"].as_array().unwrap();
    let is_cleanup = |step: Option<&Value>| {
        step.and_then(|step| step["action"][0].as_str())
            .is_some_and(|name| {
                name.starts_with("Clean")
                    || name.starts_with("Exit")
                    || name == "SemFinalize"
                    || name == "AttemptEnd"
                    || name == "LeaseReconcile"
            })
    };
    for (index, step) in steps.iter().enumerate() {
        let action = step["action"].as_array();
        let next_is_cleanup = is_cleanup(steps.get(index + 1));
        if let Some(action) = action {
            world.apply(action, next_is_cleanup).await;
        }
        // Background work is compared once it has run: start-failure cleanup, the semantic
        // observer settling the child, the exit observer, and the attempt end. A child's
        // Return and its provider's exit set off observers that nothing holds, once they
        // run, so each is then compared with the background work that follows it.
        let sets_off_background = is_cleanup(Some(step))
            || (world.observed
                && matches!(
                    step["action"][0].as_str(),
                    Some("ChildReturn" | "ProviderExit")
                ));
        if sets_off_background && next_is_cleanup {
            continue;
        }
        let real = world.observe().await;
        let expected = project_model_state(&step["state"]);
        assert_eq!(
            real, expected,
            "{scenario} step {index} ({action:?}): real state diverges from the model"
        );
        for promise in trace["promises"].as_array().unwrap() {
            let promise = promise.as_str().unwrap();
            assert!(
                promise_holds(promise, &real),
                "{scenario} step {index} ({action:?}): {promise} is broken in {real}"
            );
        }
    }
    let last = world.observe().await;
    for promise in trace["finalPromises"].as_array().into_iter().flatten() {
        let promise = promise.as_str().unwrap();
        assert!(
            promise_holds(promise, &last),
            "{scenario}: {promise} is broken at the end, in {last}"
        );
    }
    world.finish().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn completion_current_traces_replay_against_launch_and_cleanup() {
    let traces = traces();
    assert!(!traces.is_empty(), "no CompletionCurrent traces to replay");
    // Every trace replays, so one broken scenario does not hide another.
    let replays = traces
        .into_iter()
        .map(|trace| {
            let scenario = trace["scenario"].as_str().unwrap().to_owned();
            (scenario, tokio::spawn(async move { replay(&trace).await }))
        })
        .collect::<Vec<_>>();
    let mut failures = Vec::new();
    for (scenario, replay) in replays {
        if let Err(error) = replay.await {
            let message = error
                .try_into_panic()
                .ok()
                .and_then(|panic| {
                    panic
                        .downcast_ref::<String>()
                        .cloned()
                        .or_else(|| panic.downcast_ref::<&str>().map(|text| (*text).to_owned()))
                })
                .unwrap_or_else(|| "replay was cancelled".into());
            failures.push(format!("{scenario}: {message}"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}

/// A provider run outlives several observation polls: each timeout is asked again, never
/// read as the provider exiting, while a real answer or error ends the wait at once.
#[tokio::test]
async fn provider_end_waits_through_observation_timeouts() {
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed_calls = calls.clone();
    let pending_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed_pending_calls = pending_calls.clone();
    let malformed_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed_malformed_calls = malformed_calls.clone();
    let harness = Router::new()
        .route(
            "/sessions/{id}/invoked-completions/7",
            routing::get(move || {
                let calls = observed_calls.clone();
                async move {
                    if calls.fetch_add(1, Ordering::SeqCst) < 3 {
                        tokio::time::sleep(Duration::from_millis(400)).await;
                    }
                    axum::Json(serde_json::json!({"completionId":7}))
                }
            }),
        )
        // A 200 that cannot be read, or that names another run, is not the run's end.
        .route(
            "/sessions/{id}/invoked-completions/12",
            routing::get(move || {
                let calls = observed_malformed_calls.clone();
                async move {
                    let call = calls.fetch_add(1, Ordering::SeqCst);
                    let body = match call {
                        0 | 1 => "{\"completionId\":".to_owned(),
                        2 => serde_json::json!({"completionId": 99}).to_string(),
                        _ => serde_json::json!({"completionId": 12}).to_string(),
                    };
                    (StatusCode::OK, [("content-type", "application/json")], body)
                }
            }),
        )
        // A host that answers a bounded observation with `running` while the run goes on.
        .route(
            "/sessions/{id}/invoked-completions/10",
            routing::get(move || {
                let calls = observed_pending_calls.clone();
                async move {
                    if calls.fetch_add(1, Ordering::SeqCst) < 3 {
                        axum::Json(serde_json::json!({"completionId":10,"running":true}))
                    } else {
                        axum::Json(serde_json::json!({"completionId":10}))
                    }
                }
            }),
        )
        .route(
            "/sessions/{id}/invoked-completions/8",
            routing::get(|| async {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    axum::Json(serde_json::json!({"error":"Invoked completion is not registered"})),
                )
            }),
        );
    let graph = Router::new().route(
        "/api/control/temporal-features",
        routing::get(|| async {
            axum::Json(serde_json::json!({
                "configVersion":1,"schemaRead":true,"rootCurrentWrite":true,
                "projectionUi":true,"invokeResolution":true,"providerRecursion":true
            }))
        }),
    );
    let (graph_url, graph_task) = serve(graph).await;
    let (harness_url, harness_task) = serve(harness).await;
    let temporary = tempfile::Builder::new()
        .prefix("relayer-provider-end-")
        .tempdir()
        .unwrap();
    let root = temporary.path().to_path_buf();
    let catalog = root.join("catalog.json");
    fs::write(
        &catalog,
        serde_json::json!({"schemaVersion":1,"configurations":[]}).to_string(),
    )
    .unwrap();
    let mut runtime = RuntimeClient::open(
        &graph_url,
        &harness_url,
        "graph-control".into(),
        "harness-control".into(),
        &catalog,
    )
    .await
    .unwrap();
    runtime.set_observation_poll(Duration::from_millis(100));

    let ended = await_provider_end(&runtime, 1, 7, Duration::from_millis(1)).await;
    assert_eq!(ended.unwrap()["completionId"], 7);
    assert_eq!(
        calls.load(Ordering::SeqCst),
        4,
        "each timed-out poll was asked again"
    );
    assert!(
        await_provider_end(&runtime, 1, 8, Duration::from_millis(1))
            .await
            .is_err()
    );
    let ended = await_provider_end(&runtime, 1, 10, Duration::from_millis(1))
        .await
        .unwrap();
    assert_eq!(ended, serde_json::json!({"completionId":10}));
    assert_eq!(
        pending_calls.load(Ordering::SeqCst),
        4,
        "each `running` answer was asked again"
    );
    let ended = await_provider_end(&runtime, 1, 12, Duration::from_millis(1))
        .await
        .unwrap();
    assert_eq!(ended, serde_json::json!({"completionId":12}));
    assert_eq!(
        malformed_calls.load(Ordering::SeqCst),
        4,
        "unreadable and mismatched answers are asked again, not read as the run's end"
    );

    graph_task.abort();
    harness_task.abort();
}

/// A harness that closes each connection unanswered while `drops` lasts, then answers every
/// request with the ended run. With `cancel_answer`, it answers every cancel at once with
/// that `cancelled` value. It records each request line it read.
async fn unreachable_harness(
    drops: usize,
    cancel_answer: Option<bool>,
) -> (String, Arc<Mutex<Vec<String>>>, tokio::task::JoinHandle<()>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let seen = requests.clone();
    let task = tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut head = Vec::new();
            let mut buffer = [0_u8; 1024];
            while !head.windows(4).any(|window| window == b"\r\n\r\n") {
                match socket.read(&mut buffer).await {
                    Ok(0) | Err(_) => break,
                    Ok(read) => head.extend_from_slice(&buffer[..read]),
                }
            }
            let line = String::from_utf8_lossy(&head)
                .lines()
                .next()
                .unwrap_or_default()
                .to_owned();
            let cancel = line.starts_with("POST") && cancel_answer.is_some();
            let answered = {
                let mut seen = seen.lock().unwrap();
                seen.push(line);
                cancel || seen.len() > drops
            };
            if answered {
                let body = if cancel {
                    format!(r#"{{"cancelled":{}}}"#, cancel_answer.unwrap())
                } else {
                    r#"{"completionId":9,"cancelled":true}"#.to_owned()
                };
                let _ = socket
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                            body.len()
                        )
                        .as_bytes(),
                    )
                    .await;
            }
        }
    });
    (url, requests, task)
}

/// A request that never reached the harness says nothing about the child's provider, so the
/// wait retries it rather than reading it as the run ending. A harness that stays unreachable
/// is asked to cancel the child again and again, and the wait ends only when it answers.
#[tokio::test]
async fn provider_end_waits_through_an_unreachable_harness() {
    let graph = Router::new().route(
        "/api/control/temporal-features",
        routing::get(|| async {
            axum::Json(serde_json::json!({
                "configVersion":1,"schemaRead":true,"rootCurrentWrite":true,
                "projectionUi":true,"invokeResolution":true,"providerRecursion":true
            }))
        }),
    );
    let (graph_url, graph_task) = serve(graph).await;
    let temporary = tempfile::Builder::new()
        .prefix("relayer-provider-unreachable-")
        .tempdir()
        .unwrap();
    let root = temporary.path().to_path_buf();
    let catalog = root.join("catalog.json");
    fs::write(
        &catalog,
        serde_json::json!({"schemaVersion":1,"configurations":[]}).to_string(),
    )
    .unwrap();
    let step = Duration::from_millis(1);

    let (harness_url, requests, harness_task) = unreachable_harness(3, None).await;
    let runtime = RuntimeClient::open(
        &graph_url,
        &harness_url,
        "graph-control".into(),
        "harness-control".into(),
        &catalog,
    )
    .await
    .unwrap();
    let ended = await_provider_end(&runtime, 1, 9, step).await;
    assert_eq!(ended.unwrap()["completionId"], 9);
    assert!(
        requests
            .lock()
            .unwrap()
            .iter()
            .all(|line| line.starts_with("GET /sessions/1/invoked-completions/9")),
        "a brief outage is waited out without cancelling the child: {:?}",
        requests.lock().unwrap()
    );
    harness_task.abort();

    let (harness_url, requests, harness_task) = unreachable_harness(usize::MAX, None).await;
    let runtime = RuntimeClient::open(
        &graph_url,
        &harness_url,
        "graph-control".into(),
        "harness-control".into(),
        &catalog,
    )
    .await
    .unwrap();
    // A host that stays unreachable never confirms the end, so the wait never gives up:
    // it keeps observing, and cancels again after each run of unreachable observations.
    assert!(
        tokio::time::timeout(
            Duration::from_secs(1),
            await_provider_end(&runtime, 1, 9, step)
        )
        .await
        .is_err(),
        "an unconfirmed provider end must keep the child's leases held"
    );
    let requests = requests.lock().unwrap().clone();
    let cancels = requests
        .iter()
        .enumerate()
        .filter(|(_, line)| line.starts_with("POST /sessions/1/cancel?completionId=9"))
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    assert!(
        cancels.len() >= 2,
        "an unreachable child is cancelled again while the wait goes on: {requests:?}"
    );
    assert!(
        cancels[0] >= PROVIDER_END_UNREACHABLE_LIMIT as usize,
        "the child is cancelled only after repeated unreachable observations: {requests:?}"
    );
    harness_task.abort();

    // A cancel answered false proves nothing: the host also says false for a run it already
    // aborted that is still unwinding. Only an observation answer ends the wait.
    let (harness_url, requests, harness_task) = unreachable_harness(usize::MAX, Some(false)).await;
    let runtime = RuntimeClient::open(
        &graph_url,
        &harness_url,
        "graph-control".into(),
        "harness-control".into(),
        &catalog,
    )
    .await
    .unwrap();
    assert!(
        tokio::time::timeout(
            Duration::from_secs(1),
            await_provider_end(&runtime, 1, 9, step)
        )
        .await
        .is_err(),
        "a cancel answered false must not release the child's leases"
    );
    assert!(
        requests
            .lock()
            .unwrap()
            .iter()
            .filter(|line| line.starts_with("POST"))
            .count()
            >= 2,
        "the wait keeps cancelling while the host cannot be observed"
    );
    harness_task.abort();

    graph_task.abort();
}

/// The host granted a child's leases, but the product could not record the attempt that
/// owns them: the family was disabled meanwhile. No attempt records the leases, so they are
/// released at once, and the child fails without an attempt.
#[tokio::test]
async fn a_child_whose_attempt_cannot_be_recorded_releases_its_leases() {
    let mut world = World::new("attempt-unrecorded", true).await;
    for step in [
        serde_json::json!(["LaunchCheck", 1]),
        serde_json::json!(["LaunchReserve", 1]),
        serde_json::json!(["LaunchClaim", 1]),
        serde_json::json!(["LaunchActivate", 1, "ok"]),
    ] {
        world.apply(step.as_array().unwrap(), false).await;
    }
    *world.harness.admission.lock().unwrap() = "unrecorded";
    let activated = world.activated.clone().unwrap();
    let Err(refusal) = admit_recursive_child(
        &world.state,
        &world.runtime,
        &world.thread,
        &world.child,
        &activated,
    )
    .await
    else {
        panic!("a disabled family cannot record the child's attempt");
    };
    assert_eq!(refusal.reason, "execution");
    assert!(
        world.harness.granted.lock().unwrap().is_empty(),
        "leases no attempt records are released"
    );
    assert_eq!(world.observe().await["attempt"], "none");
    world.finish().await;
}

/// A harness-policy revision that lands after the child was prepared would split its
/// provenance: the attempt on the new revision, its receipts on the one it was prepared
/// under. The child is refused as a configuration change instead, before the host leases
/// anything, and holds no attempt.
#[tokio::test]
async fn a_child_whose_harness_policy_changed_since_prepare_is_refused() {
    let mut world = World::new("policy-revised", true).await;
    for step in [
        serde_json::json!(["LaunchCheck", 1]),
        serde_json::json!(["LaunchReserve", 1]),
        serde_json::json!(["LaunchClaim", 1]),
        serde_json::json!(["LaunchActivate", 1, "ok"]),
    ] {
        world.apply(step.as_array().unwrap(), false).await;
    }
    sqlx::query(
        "UPDATE product_harnesses SET configuration_revision=configuration_revision+1 WHERE configuration_name=?1",
    )
    .bind(HARNESS)
    .execute(&world.pool)
    .await
    .unwrap();
    let activated = world.activated.clone().unwrap();
    let Err(refusal) = admit_recursive_child(
        &world.state,
        &world.runtime,
        &world.thread,
        &world.child,
        &activated,
    )
    .await
    else {
        panic!("a child prepared under another policy revision must not be admitted");
    };
    assert_eq!(refusal.reason, "configuration");
    assert_eq!(
        *world.harness.admitted_policy_revision.lock().unwrap(),
        None,
        "the host leases nothing for a refused child"
    );
    assert!(world.harness.granted.lock().unwrap().is_empty());
    assert_eq!(world.observe().await["attempt"], "none");
    world.finish().await;
}

/// A child that returned while its provider still runs is accepted, and its attempt stays
/// running only as the reference that keeps its leases held. Its outcome was decided when it
/// settled, so the conversation exports it as accepted. A product-server restart in that
/// window leaves the attempt held, since the harness may have outlived the server, and
/// startup resumes the wait: the attempt ends, with its decided outcome, only when the
/// harness confirms the run ended.
#[tokio::test]
async fn a_child_returned_while_its_provider_runs_exports_and_restarts_as_accepted() {
    let mut world = World::new("unwinding-provider", true).await;
    for step in [
        serde_json::json!(["LaunchCheck", 1]),
        serde_json::json!(["LaunchReserve", 1]),
        serde_json::json!(["LaunchClaim", 1]),
        serde_json::json!(["LaunchActivate", 1, "ok"]),
        serde_json::json!(["LaunchAdmit", 1, "ok"]),
        serde_json::json!(["LaunchStart", 1, "ok"]),
        serde_json::json!(["LaunchAttach", 1, "ok"]),
        serde_json::json!(["ChildReturn"]),
        serde_json::json!(["SemFinalize"]),
    ] {
        world.apply(step.as_array().unwrap(), false).await;
    }
    let unwinding = world.observe().await;
    assert_eq!(
        (unwinding["status"].as_str(), unwinding["attempt"].as_str()),
        (Some("accepted"), Some("running")),
        "the provider still runs, so the accepted child's attempt stays open"
    );

    // The export reports the outcome settlement decided, which its validation requires
    // of an accepted child, rather than the in-flight attempt.
    let child = world.product.get_interaction(world.child.id).await.unwrap();
    assert_eq!(
        crate::conversation_export_service::settled_attempt_outcome(&world.product, &child)
            .await
            .unwrap(),
        Some("accepted")
    );
    // The replay keeps the parent graph current active so it can exercise recursive-child
    // lifecycle independently. Complete that already-product-accepted parent before asking the
    // production local builder for every accepted closure.
    let root = world
        .product
        .get_interaction(world.thread.root_interaction_id)
        .await
        .unwrap();
    let root_node_id = NodeId::new(root.graph_node_id.unwrap()).unwrap();
    let root_current = world.graph.current_completion(root_node_id).await.unwrap();
    let root_writer = world.graph.writer_for_subgraph(root_node_id).await.unwrap();
    root_writer
        .add_action(&ActionDraft {
            client_key: "response".into(),
            source_node_id: root_node_id,
            source_layer_id: None,
            kind: ActionKind::Navigate,
            relation: Some(NavigateRelation::Expand),
            label: "Response".into(),
            variant: ActionVariant::default(),
            icon: None,
            description: None,
            target_layer_id: root_current.current_layer_id,
            interaction_text: None,
            reusable: None,
            input_action_ids: Vec::new(),
            input: None,
        })
        .await
        .unwrap();
    root_writer
        .transition_current(
            root_current.head_revision,
            "share-root-return",
            CurrentTransition::Return {
                layer_id: root_current.current_layer_id.unwrap(),
            },
        )
        .await
        .unwrap();
    let export = crate::conversation_export_service::build_conversation_export(
        &world.product,
        &world.runtime,
        world.thread.id,
        world.state.export_producer.clone(),
        "2026-01-01T00:00:00Z".into(),
    )
    .await
    .unwrap();
    let exported_child = export
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .map(|line| serde_json::from_slice::<ConversationExportRecord>(line).unwrap())
        .find_map(|record| match record {
            ConversationExportRecord::Turn(turn) if turn.text == "Child work" => Some(turn),
            _ => None,
        })
        .expect("the accepted recursive child must be present in the local snapshot");
    assert_eq!(
        exported_child.completion.attempt_outcome,
        Some(ExportAttemptOutcome::Accepted),
        "the production local builder must project the settled outcome while the provider unwinds"
    );
    assert!(exported_child.completion.attempt_admission_id.is_some());
    assert!(exported_child.completion.admitted_model_plan.is_some());
    let share = crate::conversation_export_service::build_share_conversation_export(
        &world.product,
        &world.runtime,
        world.thread.id,
        world.state.export_producer.clone(),
        "2026-01-01T00:00:00Z".into(),
        "Accepted recursive work",
    )
    .await;
    assert!(matches!(share, Err(crate::conversation_export_service::ConversationExportBuildError::ReusableInvocationPortabilityUnavailable)), "Hosted V4 remains unqualified while local settled outcome stays exportable");

    // A running-but-unsettled snapshot never takes a decided outcome, even if the
    // execution settles between the two reads.
    let stale = Interaction {
        completion_status: "running".into(),
        ..child.clone()
    };
    assert_eq!(
        crate::conversation_export_service::settled_attempt_outcome(&world.product, &stale)
            .await
            .unwrap(),
        None
    );

    let restarted = SqliteProductStore::open(&world.root.path().join("product.sqlite3"))
        .await
        .unwrap();
    restarted
        .recover_interrupted_interactions("restart", false)
        .await
        .unwrap();
    assert_eq!(
        world.observe().await["attempt"],
        "running",
        "restart recovery leaves an unwinding child's attempt, and its leases, held"
    );

    // The harness outlived the server and still runs the child: resuming keeps waiting.
    let resumed = tokio::spawn(resume_unwinding_recursive_children(
        world.product.clone(),
        world.runtime.clone(),
        None,
    ));
    resumed.await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(world.observe().await["attempt"], "running");

    // A harness that restarted with the server knows no such run, so it answers the one
    // startup observation with a refusal (after a moment). The replay's own exit observer is
    // still blocked on the live fake, so this proves resuming ended the attempt and released
    // its lease, and did so before it returned: startup orders it before serving Desktop.
    let restarted_harness = Router::new()
        .route(
            "/sessions/{id}/invoked-completions/{completion}",
            routing::get(|| async {
                tokio::time::sleep(Duration::from_millis(200)).await;
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    axum::Json(serde_json::json!({"error":"Invoked completion is not registered"})),
                )
            }),
        )
        .route(
            "/sessions/{id}/execution-leases/{lease}",
            routing::delete(|| async { axum::Json(serde_json::json!({"released": false})) }),
        );
    let graph = Router::new().route(
        "/api/control/temporal-features",
        routing::get(|| async {
            axum::Json(serde_json::json!({
                "configVersion":1,"schemaRead":true,"rootCurrentWrite":true,
                "projectionUi":true,"invokeResolution":true,"providerRecursion":true
            }))
        }),
    );
    let (graph_url, graph_task) = serve(graph).await;
    let (harness_url, harness_task) = serve(restarted_harness).await;
    let catalog = world.root.path().join("restarted-catalog.json");
    fs::write(
        &catalog,
        serde_json::json!({"schemaVersion":1,"configurations":[]}).to_string(),
    )
    .unwrap();
    let restarted_runtime = RuntimeClient::open(
        &graph_url,
        &harness_url,
        "graph-control".into(),
        "harness-control".into(),
        &catalog,
    )
    .await
    .unwrap();
    resume_unwinding_recursive_children(world.product.clone(), restarted_runtime, None).await;
    let (outcome, boundary, reconciled): (String, String, Option<String>) = sqlx::query_as(
        "SELECT outcome,effect_boundary,execution_lease_reconciled_at FROM interaction_attempts WHERE interaction_id=?1",
    )
    .bind(world.child.id.value())
    .fetch_one(&world.pool)
    .await
    .unwrap();
    assert_eq!(
        (outcome.as_str(), boundary.as_str()),
        ("accepted", "graph_write")
    );
    assert!(
        reconciled.is_some(),
        "the lease is released once the run is confirmed ended, before resuming returns"
    );
    assert_eq!(world.observe().await["status"], "accepted");
    graph_task.abort();
    harness_task.abort();
    world.finish().await;
}

/// A child whose graph is already stopped has no work left, but the one cancel sent for it
/// may have been lost. While the harness still runs it, every poll cancels it again, so its
/// provider cannot keep working, and holding its leases, indefinitely.
#[tokio::test]
async fn a_stopped_child_that_keeps_running_is_cancelled_again() {
    let cancels = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counted = cancels.clone();
    let harness = Router::new()
        .route(
            "/sessions/{id}/invoked-completions/11",
            routing::get(|| async {
                axum::Json(serde_json::json!({"completionId":11,"running":true}))
            }),
        )
        .route(
            "/sessions/{id}/cancel",
            routing::post(move || {
                let counted = counted.clone();
                async move {
                    counted.fetch_add(1, Ordering::SeqCst);
                    axum::Json(serde_json::json!({"cancelled": true}))
                }
            }),
        );
    let temporal = serde_json::json!({
        "configVersion":1,"schemaRead":true,"rootCurrentWrite":true,
        "projectionUi":true,"invokeResolution":true,"providerRecursion":true
    });
    let features = temporal.clone();
    let graph = Router::new()
        .route(
            "/api/control/temporal-features",
            routing::get(move || {
                let features = features.clone();
                async move { axum::Json(features) }
            }),
        )
        .route(
            "/api/control/interactions/11/current",
            routing::get(move || {
                let temporal = temporal.clone();
                async move {
                    axum::Json(serde_json::json!({
                        "completionId":11,"lifecycle":"stopped","headRevision":2,
                        "currentLayerId":4,"finalLayerId":null,"safeReason":"cancelled_by_user",
                        "temporalFeatures":temporal
                    }))
                }
            }),
        );
    let (graph_url, graph_task) = serve(graph).await;
    let (harness_url, harness_task) = serve(harness).await;
    let temporary = tempfile::Builder::new()
        .prefix("relayer-stopped-child-")
        .tempdir()
        .unwrap();
    let root = temporary.path().to_path_buf();
    let catalog = root.join("catalog.json");
    fs::write(
        &catalog,
        serde_json::json!({"schemaVersion":1,"configurations":[]}).to_string(),
    )
    .unwrap();
    let runtime = RuntimeClient::open(
        &graph_url,
        &harness_url,
        "graph-control".into(),
        "harness-control".into(),
        &catalog,
    )
    .await
    .unwrap();

    assert!(
        tokio::time::timeout(
            Duration::from_millis(500),
            await_provider_end(&runtime, 1, 11, Duration::from_millis(1))
        )
        .await
        .is_err(),
        "the run has not ended, so the wait goes on"
    );
    assert!(
        cancels.load(Ordering::SeqCst) >= 2,
        "a stopped child is cancelled again while it still runs"
    );
    graph_task.abort();
    harness_task.abort();
}

/// Cancelling a child's approval stops its interaction before its graph is failed. The
/// execution still settles, keeping the user's stop, and once the provider ends the attempt
/// ends as cancelled and releases its leases instead of retrying settlement forever.
#[tokio::test]
async fn a_child_stopped_by_a_cancelled_approval_settles_and_ends_its_attempt() {
    let mut world = World::new("approval-cancelled", true).await;
    for step in [
        serde_json::json!(["LaunchCheck", 1]),
        serde_json::json!(["LaunchReserve", 1]),
        serde_json::json!(["LaunchClaim", 1]),
        serde_json::json!(["LaunchActivate", 1, "ok"]),
        serde_json::json!(["LaunchAdmit", 1, "ok"]),
        serde_json::json!(["LaunchStart", 1, "ok"]),
        serde_json::json!(["LaunchAttach", 1, "ok"]),
    ] {
        world.apply(step.as_array().unwrap(), false).await;
    }
    // What record_approval_resolution writes for a cancelled approval.
    sqlx::query(
        "UPDATE interactions SET completion_status='stopped',completion_error='Approval request was cancelled.' WHERE id=?1",
    )
    .bind(world.child.id.value())
    .execute(&world.pool)
    .await
    .unwrap();
    world
        .runtime
        .fail_graph_completion(world.completion_id, "approval-cancelled-test", "execution")
        .await
        .unwrap();
    *world.harness.prov.lock().unwrap() = "exited_err";

    let deadline = Instant::now() + CLEANUP_QUIESCENCE;
    let state = loop {
        let state = world.observe().await;
        if (state["phase"] == "settled"
            && state["attempt"] == "terminal"
            && state["lease"] == "released")
            || Instant::now() >= deadline
        {
            break state;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    };
    assert_eq!(
        state["phase"], "settled",
        "the stopped child settles: {state}"
    );
    assert_eq!(
        state["status"], "stopped",
        "the user's stop is kept: {state}"
    );
    assert_eq!(
        state["lease"], "released",
        "its leases are released: {state}"
    );
    let outcome: String =
        sqlx::query_scalar("SELECT outcome FROM interaction_attempts WHERE interaction_id=?1")
            .bind(world.child.id.value())
            .fetch_one(&world.pool)
            .await
            .unwrap();
    assert_eq!(outcome, "cancelled");
    world.finish().await;
}

/// A product-server restart that finds a child still launching fails its graph, since the
/// server cannot resume observing it, but a harness that outlived the server may still run
/// it. The child's attempt, and its leases, stay held for the resumed provider-end wait.
#[tokio::test]
async fn a_restart_keeps_a_launching_childs_leases_held() {
    let mut world = World::new("restart-launching", true).await;
    for step in [
        serde_json::json!(["LaunchCheck", 1]),
        serde_json::json!(["LaunchReserve", 1]),
        serde_json::json!(["LaunchClaim", 1]),
        serde_json::json!(["LaunchActivate", 1, "ok"]),
        serde_json::json!(["LaunchAdmit", 1, "ok"]),
        serde_json::json!(["LaunchStart", 1, "ok"]),
    ] {
        world.apply(step.as_array().unwrap(), false).await;
    }
    let restarted = SqliteProductStore::open(&world.root.path().join("product.sqlite3"))
        .await
        .unwrap();
    crate::app_server::reconcile_interrupted_recursive_completion_executions(
        &restarted,
        &world.runtime,
    )
    .await
    .unwrap();
    let state = world.observe().await;
    assert_eq!(
        state["phase"], "settled",
        "restart settles the launching child: {state}"
    );
    assert_eq!(state["life"], "failed", "its graph is failed: {state}");
    assert_eq!(
        state["attempt"], "running",
        "its attempt stays held: {state}"
    );
    assert_eq!(state["lease"], "held", "and so do its leases: {state}");
    world.finish().await;
}

/// A failed start fails and settles its child before cancelling, so a harness that cannot
/// take the cancel does not hold the child's result open: here the cancel never returns,
/// yet the child is failed and settled.
#[tokio::test]
async fn a_failed_start_settles_while_its_cancel_cannot_reach_the_harness() {
    let mut world = World::new("start-failed-cancel-held", true).await;
    for step in [
        serde_json::json!(["LaunchCheck", 1]),
        serde_json::json!(["LaunchReserve", 1]),
        serde_json::json!(["LaunchClaim", 1]),
        serde_json::json!(["LaunchActivate", 1, "ok"]),
        serde_json::json!(["LaunchAdmit", 1, "ok"]),
        serde_json::json!(["LaunchStart", 1, "fail"]),
        // Starts the cleanup; the harness then holds its cancel for good.
        serde_json::json!(["CleanFail"]),
    ] {
        world.apply(step.as_array().unwrap(), true).await;
    }
    let deadline = Instant::now() + CLEANUP_QUIESCENCE;
    let state = loop {
        let state = world.observe().await;
        if state["phase"] == "settled" || Instant::now() >= deadline {
            break state;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    };
    assert_eq!(
        state["life"], "failed",
        "the child fails without waiting on the cancel: {state}"
    );
    assert_eq!(state["phase"], "settled", "and settles: {state}");
    assert_eq!(
        state["attempt"], "running",
        "its attempt stays held until the run is confirmed ended: {state}"
    );
    world.finish().await;
}

/// A child whose capability activation fails is failed in both stores, so the thread and an
/// awaiting parent see it end. The parent's exact retry of the same launch starts nothing and
/// reports that terminal child rather than an active one nothing runs.
#[tokio::test]
async fn a_failed_activation_fails_the_child_in_both_stores_and_an_exact_retry_reports_it() {
    let world = World::new("activation-fails", false).await;
    let (broker, _lease) = world.broker();
    world.faults.fail_activation.store(true, Ordering::SeqCst);
    let refused = world.launch(&broker).await;
    assert!(
        refused.is_err(),
        "a launch whose activation failed is refused"
    );

    let state = world
        .await_state(|state| state["life"] != "active" && state["status"] == "failed")
        .await;
    assert_eq!(state["life"], "failed", "the graph current ends: {state}");
    assert_eq!(state["why"], "capability_activation_failed", "{state}");
    assert_eq!(state["status"], "failed", "the product child ends: {state}");
    assert_eq!(state["phase"], "settled", "{state}");
    assert_eq!(state["execWhy"], "capability_activation_failed", "{state}");

    let (status, _) = world
        .launch(&broker)
        .await
        .unwrap_or_else(|error| panic!("exact retry: {}", error.message()));
    assert_eq!(status, StatusCode::OK, "an exact retry reports the child");
    let (status, body) = world.observed_result(&broker).await;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "the awaiting parent sees the end"
    );
    assert_eq!(body["lifecycle"], "failed");
    assert_eq!(body["reason"], "capability_activation_failed");
    assert_eq!(world.observe().await["prov"], "none", "nothing was started");
    world.finish().await;
}

/// The broker's own preparation of a claimed child can end ambiguously: the graph answer is
/// lost or garbled. The child is failed in both stores in the background, bound to the graph
/// interaction the parent prepared, so neither the parent nor the thread waits on it forever.
#[tokio::test]
async fn an_ambiguous_preparation_fails_the_claimed_child_in_both_stores() {
    let world = World::unprepared("preparation-ambiguous").await;
    let (broker, _lease) = world.broker();
    world
        .faults
        .garble_preparation
        .store(true, Ordering::SeqCst);
    let refused = world.launch(&broker).await;
    world
        .faults
        .garble_preparation
        .store(false, Ordering::SeqCst);
    assert!(
        refused.is_err(),
        "an ambiguous preparation refuses the launch"
    );

    let state = world
        .await_state(|state| state["life"] != "active" && state["status"] == "failed")
        .await;
    assert_eq!(state["life"], "failed", "the graph current ends: {state}");
    assert_eq!(state["why"], "preparation_failed", "{state}");
    assert_eq!(state["status"], "failed", "the product child ends: {state}");
    let child = world.child_row().await;
    assert_eq!(child.graph_node_id, Some(world.completion_id));
    assert_eq!(
        child.completion_error.as_deref(),
        Some("preparation_failed")
    );
    // Graph termination is observable before background cleanup clears its
    // separate durable recovery marker. Await that existing cleanup boundary.
    let deadline = Instant::now() + Duration::from_secs(2);
    while world.graph_failure_pending().await && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(
        !world.graph_failure_pending().await,
        "a confirmed graph half is not revisited at startup"
    );

    let (status, _) = world
        .launch(&broker)
        .await
        .unwrap_or_else(|error| panic!("exact retry: {}", error.message()));
    assert_eq!(status, StatusCode::OK, "an exact retry reports the child");
    let (status, body) = world.observed_result(&broker).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["reason"], "preparation_failed");
    world.finish().await;
}

/// A restart after the child row is bound but before its execution reaches `launching`
/// fails the child in both stores with `application_restart`: restart never reattaches.
#[tokio::test]
async fn a_restart_before_launch_fails_the_bound_child_in_both_stores() {
    let mut world = World::new("restart-before-launch", false).await;
    for step in [
        serde_json::json!(["LaunchCheck", 1]),
        serde_json::json!(["LaunchReserve", 1]),
    ] {
        world.apply(step.as_array().unwrap(), false).await;
    }
    world.set_parent_status("running").await;
    world.restart().await;

    let state = world.observe().await;
    assert_eq!(state["life"], "failed", "{state}");
    assert_eq!(state["why"], "application_restart", "{state}");
    assert_eq!(state["status"], "failed", "{state}");
    assert_eq!(
        state["phase"], "settled",
        "the reserved row settles: {state}"
    );
    assert_eq!(state["execWhy"], "application_restart", "{state}");
    let child = world.child_row().await;
    assert_eq!(
        child.completion_error.as_deref(),
        Some("application_restart")
    );

    // A second restart finds nothing left to reconcile.
    world.restart().await;
    assert_eq!(world.observe().await, state);
    world.finish().await;
}

/// The provenance check reads the child's invoke occurrence whatever its parent's status.
/// A bound child whose parent already failed is failed with `application_restart`, not
/// quarantined as a provenance mismatch with its current left active.
#[tokio::test]
async fn a_restart_fails_a_bound_child_whose_parent_already_failed() {
    let world = World::new("restart-parent-failed", false).await;
    world.set_parent_status("failed").await;
    world.restart().await;

    let state = world.observe().await;
    assert_eq!(state["life"], "failed", "{state}");
    assert_eq!(state["why"], "application_restart", "{state}");
    assert_eq!(state["status"], "failed", "{state}");
    let child = world.child_row().await;
    assert_eq!(
        child.completion_error.as_deref(),
        Some("application_restart")
    );
    world.finish().await;
}

/// A claimed child the broker never bound, whose parent then failed, is recovered from its
/// graph lease at the next start and failed in both stores.
#[tokio::test]
async fn a_restart_fails_an_unbound_child_whose_parent_already_failed() {
    let world = World::unprepared("restart-unbound").await;
    assert!(
        world
            .product
            .claim_interaction_preparing(world.child.id)
            .await
            .unwrap()
    );
    world.set_parent_status("failed").await;
    world.restart().await;

    let state = world.observe().await;
    assert_eq!(state["life"], "failed", "{state}");
    assert_eq!(state["why"], "application_restart", "{state}");
    assert_eq!(state["status"], "failed", "{state}");
    assert_eq!(
        world.child_row().await.graph_node_id,
        Some(world.completion_id)
    );
    world.finish().await;
}

/// Only human root turns hold a thread. A running child does not refuse the next human
/// turn, and the product's Stop refuses it with a client error: only its parent may stop it.
/// The child keeps its own current and settles on it while the new turn exists.
#[tokio::test]
async fn a_running_child_does_not_hold_the_next_human_turn_and_product_stop_refuses_it() {
    let world = World::new("child-outside-gate", false).await;
    let (broker, _lease) = world.broker();
    *world.harness.start.lock().unwrap() = "ok";
    let (status, _) = world
        .launch(&broker)
        .await
        .unwrap_or_else(|error| panic!("launch: {}", error.message()));
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(world.child_row().await.completion_status, "running");

    let mut control = HeaderMap::new();
    control.insert(
        header::COOKIE,
        format!("{}=control", crate::api::CONTROL_COOKIE)
            .parse()
            .unwrap(),
    );
    let refusal = match stop_interaction(
        State(world.state.clone()),
        control,
        Path((world.thread.id.value(), world.child.id.value())),
    )
    .await
    {
        Ok(_) => panic!("the product cannot stop an agent's child"),
        Err(refused) => axum::response::IntoResponse::into_response(refused).status(),
    };
    assert!(refusal.is_client_error(), "refused with {refusal}");

    let next = world
        .product
        .create_interaction(world.thread.id, "Next question", None, true)
        .await
        .unwrap_or_else(|error| panic!("the next human turn was refused: {error}"));
    assert_eq!(next.completion_status, "not_started");

    // The child still owns its own current and settles on it.
    let mut world = world;
    world
        .apply(&[serde_json::json!("ChildReturn")], false)
        .await;
    let state = world.await_state(|state| state["phase"] == "settled").await;
    assert_eq!(state["status"], "accepted", "{state}");
    assert_eq!(
        world
            .product
            .get_interaction(next.id)
            .await
            .unwrap()
            .completion_status,
        "not_started",
        "the child's settlement leaves the new turn alone"
    );
    world.finish().await;
}

/// An older build left a stuck child without the agent marker. A child whose parent is not
/// accepted cannot be a user's invoke, so startup marks it and fails it in both stores.
#[tokio::test]
async fn a_restart_fails_a_stuck_child_an_older_build_left_unmarked() {
    let world = World::unprepared("restart-unmarked").await;
    assert!(
        world
            .product
            .claim_interaction_preparing(world.child.id)
            .await
            .unwrap()
    );
    sqlx::query("UPDATE action_invocations SET agent_invoked=0")
        .execute(&world.pool)
        .await
        .unwrap();
    world.set_parent_status("failed").await;
    world.restart().await;

    let state = world.observe().await;
    assert_eq!(state["life"], "failed", "{state}");
    assert_eq!(state["why"], "application_restart", "{state}");
    assert_eq!(state["status"], "failed", "{state}");
    world.finish().await;
}

/// A restart that cannot read the child's graph current keeps it for a moment, then fails it
/// in both stores in the background once the graph answers, without another restart.
#[tokio::test]
async fn a_restart_that_cannot_reach_the_graph_fails_the_child_once_it_can() {
    let world = World::new("restart-graph-busy", false).await;
    world.set_parent_status("running").await;
    world.faults.fail_current_reads.store(1, Ordering::SeqCst);
    world.restart().await;
    let kept = world.child_row().await;
    assert_eq!(
        kept.completion_status, "submitted",
        "startup kept the child while the graph was unreachable"
    );
    assert!(
        kept.completion_error
            .as_deref()
            .is_some_and(|error| error.starts_with("Delegated work was interrupted")),
        "a kept child does not ask the user to invoke it again: {:?}",
        kept.completion_error
    );

    let deadline = Instant::now() + Duration::from_secs(5);
    let state = loop {
        let state = world.observe().await;
        if state["status"] == "failed" || Instant::now() >= deadline {
            break state;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    assert_eq!(state["life"], "failed", "{state}");
    assert_eq!(state["why"], "application_restart", "{state}");
    assert_eq!(state["status"], "failed", "{state}");
    world.finish().await;
}

/// A user's invoke of the parent's delegate action does not run an agent's child on the
/// product path, where neither the user nor the parent could stop it.
#[tokio::test]
async fn a_users_invoke_does_not_run_an_agents_child() {
    let world = World::new("user-invoke-child", false).await;
    let (status, Json(response)) = invoke_action_with_authority(
        &world.state,
        world.thread.id.value(),
        world.thread.root_interaction_id.value(),
        world.invocation.source_action_id,
        "legacy-test-request",
        None,
        None,
    )
    .await
    .unwrap_or_else(|error| panic!("invoke: {}", error.message()));
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        serde_json::to_value(&response.interaction).unwrap()["completionStatus"],
        "submitted"
    );
    assert_eq!(world.child_row().await.completion_status, "submitted");
    world.finish().await;
}

/// A deterministic startup failure on a bound child, here a refused capability invalidation,
/// still fails its graph current with `application_restart` and then its product row.
#[tokio::test]
async fn a_deterministic_startup_failure_fails_the_child_in_both_stores() {
    let world = World::new("restart-deterministic", false).await;
    world.set_parent_status("running").await;
    world
        .faults
        .refuse_invalidation
        .store(true, Ordering::SeqCst);
    world.restart().await;

    let state = world.observe().await;
    assert_eq!(state["life"], "failed", "the graph half ends too: {state}");
    assert_eq!(state["why"], "application_restart", "{state}");
    assert_eq!(state["status"], "failed", "{state}");
    let child = world.child_row().await;
    assert_eq!(
        child.completion_error.as_deref(),
        Some("application_restart")
    );
    assert_eq!(child.harness_configuration_name.as_deref(), Some(HARNESS));
    world.finish().await;
}

#[tokio::test]
async fn a_restart_recovers_exact_unbound_durable_agent_call() {
    verify_unbound_durable_restart(true).await;
}

#[tokio::test]
async fn v4_import_reexport_preserves_standalone_bound_input_image_without_layer_membership() {
    let world = World::build_mode("outside-closure-input", false, false, Some(true)).await;
    let (_assets_directory, _assets_host, assets_url, assets_token) =
        crate::api::conversation_imports::tests::real_visual_assets_host();
    reqwest::Client::new()
        .put(format!(
            "{}api/control/visual-assets/bridge",
            world.graph_url
        ))
        .bearer_auth("graph-control")
        .json(&serde_json::json!({"url":assets_url,"token":assets_token,"generation":1}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    let thread = world
        .product
        .create_thread(CreateThreadCommand {
            icon_selection_eligible: true,
            title: None,
            project_id: None,
            initial_message: "Bound input archive".into(),
            harness_configuration_name: HARNESS.into(),
            personal_presentation_version_key: None,
            permission_profile_id: "auto".into(),
            model_selection: None,
            allow_unselected_model: true,
        })
        .await
        .unwrap();
    let parent = world
        .graph
        .create_interaction(
            None,
            ThreadId::new(thread.id.value()).unwrap(),
            "Bound input archive",
        )
        .await
        .unwrap()
        .id;
    let writer = world.graph.writer_for_subgraph(parent).await.unwrap();
    use sha2::{Digest, Sha256};
    let content = b"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 8 8\"><rect width=\"8\" height=\"8\"/></svg>".to_vec();
    let asset = relayer_graph_core::PreparedDetailAsset {
        asset_id: "question-icon".into(),
        digest_sha256: format!("{:x}", Sha256::digest(&content)),
        media_type: "image/svg+xml".into(),
        byte_length: content.len(),
        content: content.clone(),
        provenance_source: "user".into(),
        provenance_file_name: "question.svg".into(),
    };
    let node = writer
        .submit_node(&NodeDraft {
            client_key: "shared-source".into(),
            kind: "concept".into(),
            icon: "box".into(),
            title: "Analysis".into(),
            detail: "Analysis with a callable".into(),
        })
        .await
        .unwrap()
        .id;
    let layer_draft = |key: &str| LayerDraft {
        client_key: key.into(),
        default_node_id: None,
        nodes: vec![node],
        edges: vec![],
        layout: Some(LayerLayout::v1(
            vec![NodePlacement {
                node_id: node,
                x: 0.5,
                y: 0.5,
            }],
            "default",
        )),
        size_justification: None,
    };
    let original_layer = writer
        .submit_layer(&layer_draft("invoke-layer"))
        .await
        .unwrap()
        .id;
    let field = writer
        .add_action_with_prepared_icon(&ActionDraft {
            client_key: "historical-question".into(),
            source_node_id: node,
            source_layer_id: Some(original_layer),
            kind: ActionKind::Input,
            relation: None,
            label: "Destination".into(),
            variant: ActionVariant::Pill,
            icon: Some(serde_json::json!({"kind":"image","assetId":asset.asset_id,"digestSha256":asset.digest_sha256,"mediaType":asset.media_type}).to_string()),
            description: None,
            target_layer_id: None,
            interaction_text: None,
            reusable: None,
            input_action_ids: Vec::new(),
            input: Some(relayer_graph_core::InputAction {
                control: relayer_graph_core::InputControl::Text,
                prompt: "Destination".into(),
                options: Vec::new(),
                minimum_selections: None,
                unsupported_fields: Default::default(),
            }),
        }, Some(&asset))
        .await
        .unwrap();
    let root = |target| ActionDraft {
        client_key: "root".into(),
        source_node_id: parent,
        source_layer_id: None,
        kind: ActionKind::Navigate,
        relation: Some(NavigateRelation::Expand),
        label: "Response".into(),
        variant: ActionVariant::Pill,
        icon: None,
        description: None,
        target_layer_id: Some(target),
        interaction_text: None,
        reusable: None,
        input_action_ids: Vec::new(),
        input: None,
    };
    writer
        .add_action(&ActionDraft {
            client_key: "child".into(),
            source_node_id: node,
            source_layer_id: Some(original_layer),
            kind: ActionKind::Invoke,
            relation: None,
            label: "Investigate".into(),
            variant: ActionVariant::Pill,
            icon: None,
            description: None,
            target_layer_id: None,
            interaction_text: Some("Child work".into()),
            reusable: None,
            input_action_ids: vec![field.id],
            input: None,
        })
        .await
        .unwrap();
    writer.add_action(&root(original_layer)).await.unwrap();
    writer.complete(parent).await.unwrap();
    let pool = sqlx::SqlitePool::connect(&format!(
        "sqlite://{}",
        world.root.path().join("product.sqlite3").display()
    ))
    .await
    .unwrap();
    sqlx::query(
        "UPDATE interactions SET graph_node_id=?1,completion_status='accepted' WHERE id=?2",
    )
    .bind(parent.value())
    .bind(thread.root_interaction_id.value())
    .execute(&pool)
    .await
    .unwrap();
    pool.close().await;

    // Construct a valid V4 archive from real accepted authored definitions, then
    // move the question into the standalone inventory. The imported canonical
    // graph must not fabricate membership in its absent historical Layer.
    let seed = crate::conversation_export_service::build_conversation_export(
        &world.product,
        &world.runtime,
        thread.id,
        world.state.export_producer.clone(),
        "2026-10-04T00:00:00Z".into(),
    )
    .await
    .unwrap();
    let mut archive = crate::conversation_export::decode_export_jsonl(&seed).unwrap();
    let definition = archive
        .iter_mut()
        .find_map(|record| match record {
            ConversationExportRecord::Turn(turn) => turn.accepted_view.as_mut().map(|view| {
                let layer = &mut view.layers[0];
                let position = layer
                    .actions
                    .iter()
                    .position(|action| {
                        action.kind == crate::conversation_export::ExportActionKind::Input
                    })
                    .unwrap();
                let mut input = layer.actions.remove(position);
                input.source_layer_id = Some("layer:historical-input-presentation".into());
                let source = layer
                    .nodes
                    .iter_mut()
                    .find(|node| node.id == input.source_node_id)
                    .unwrap();
                input.icon_asset = source
                    .authored_detail_assets
                    .iter()
                    .find(|pin| pin.digest_sha256 == asset.digest_sha256)
                    .cloned();
                source.authored_detail_assets.clear();
                input
            }),
            _ => None,
        })
        .unwrap();
    let ConversationExportRecord::Header(header) = &mut archive[0] else {
        unreachable!()
    };
    header.export_version = crate::conversation_export::EXPORT_VERSION_V4;
    header.bound_inputs = vec![definition];
    crate::conversation_export::validate_export_records(&archive).unwrap();
    use crate::conversation_import_service::ConversationImportStager;
    let ConversationExportRecord::Header(header) = &archive[0] else {
        unreachable!()
    };
    let mut stager = ConversationImportStager::begin(*header.clone(), &world.product)
        .await
        .unwrap();
    for record in archive.iter().skip(1) {
        match record {
            ConversationExportRecord::Turn(turn) => {
                stager.push_turn(turn, &world.product).await.unwrap()
            }
            ConversationExportRecord::VisualAssetContent(content) => stager
                .push_visual_asset_content(content, &world.product)
                .await
                .unwrap(),
            _ => unreachable!(),
        }
    }
    let receipt = stager
        .finish(
            format!(
                "sha256:{:x}",
                Sha256::digest(serde_json::to_vec(&archive).unwrap())
            ),
            &world.product,
        )
        .await
        .unwrap();
    let imported = crate::conversation_import_service::materialize_and_publish_conversation(
        &receipt.import_id,
        &world.product,
        &world.runtime,
    )
    .await
    .unwrap();
    let thread_id = crate::product::ThreadId::from_database(imported.thread_id);
    {
        let reads_before = world.faults.detail_asset_reads.load(Ordering::SeqCst);
        let bytes = {
            crate::conversation_export_service::build_conversation_export(
                &world.product,
                &world.runtime,
                thread_id,
                world.state.export_producer.clone(),
                "2026-10-04T00:00:00Z".into(),
            )
            .await
            .unwrap()
        };
        assert!(
            world.faults.detail_asset_reads.load(Ordering::SeqCst) > reads_before,
            "Standalone pin collection must read real canonical registered bytes, not only replay original Header content"
        );
        let records = bytes
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice::<ConversationExportRecord>(line).unwrap())
            .collect::<Vec<_>>();
        let ConversationExportRecord::Header(header) = &records[0] else {
            panic!("header")
        };
        assert_eq!(
            header.export_version,
            crate::conversation_export::EXPORT_VERSION_V4
        );
        assert_eq!(header.bound_inputs.len(), 1);
        let definition = &header.bound_inputs[0];
        assert_eq!(
            definition.kind,
            crate::conversation_export::ExportActionKind::Input
        );
        assert_eq!(definition.input.as_ref().unwrap().prompt, "Destination");
        let pin = definition
            .icon_asset
            .as_ref()
            .expect("standalone Input captures its real image pin");
        assert_eq!(pin.digest_sha256, asset.digest_sha256);
        assert!(records.iter().any(|record| matches!(record, ConversationExportRecord::VisualAssetContent(bytes) if bytes.digest_sha256 == asset.digest_sha256)));
        let returned = records
            .iter()
            .find_map(|record| match record {
                ConversationExportRecord::Turn(turn) => turn.accepted_view.as_ref(),
                _ => None,
            })
            .unwrap();
        let invoke = returned
            .layers
            .iter()
            .flat_map(|layer| &layer.actions)
            .find(|action| action.kind == crate::conversation_export::ExportActionKind::Invoke)
            .unwrap();
        assert_eq!(invoke.input_action_ids, vec![definition.id.clone()]);
        assert_eq!(invoke.source_node_id, definition.source_node_id);
        assert_ne!(invoke.source_layer_id, definition.source_layer_id);
        assert!(
            !returned
                .layers
                .iter()
                .flat_map(|layer| &layer.actions)
                .any(|action| action.id == definition.id)
        );
        assert!(
            header.invocations.is_empty(),
            "uncalled Invoke acquires no invented call"
        );
    }
    let share = crate::conversation_export_service::build_share_conversation_export(
        &world.product,
        &world.runtime,
        thread_id,
        world.state.export_producer.clone(),
        "2026-10-04T00:00:00Z".into(),
        "Analysis",
    )
    .await;
    assert!(matches!(share, Err(crate::conversation_export_service::ConversationExportBuildError::ShareImportedConversation)), "Imported conversations retain the existing share authority gate");
    let native_share = crate::conversation_export_service::build_share_conversation_export(
        &world.product,
        &world.runtime,
        thread.id,
        world.state.export_producer.clone(),
        "2026-10-04T00:00:00Z".into(),
        "Analysis",
    )
    .await;
    assert!(matches!(native_share, Err(crate::conversation_export_service::ConversationExportBuildError::ReusableInvocationPortabilityUnavailable)), "Standalone bound definitions require V4 even before a call, so hosted export must fail closed");
    let native_export = crate::conversation_export_service::build_conversation_export(
        &world.product,
        &world.runtime,
        thread.id,
        world.state.export_producer.clone(),
        "2026-10-04T00:00:00Z".into(),
    )
    .await
    .unwrap();
    let native_records = crate::conversation_export::decode_export_jsonl(&native_export).unwrap();
    crate::conversation_export::validate_export_records(&native_records).unwrap();
    assert!(native_records.iter().any(|record| matches!(record, ConversationExportRecord::VisualAssetContent(bytes) if bytes.digest_sha256 == asset.digest_sha256)));
    world.finish().await;
}

#[tokio::test]
async fn native_reusable_invocations_preserve_conversation_and_share_export_for_single_multiple_and_graph_only_calls()
 {
    let world =
        World::build_call_mode("durable-export-block", false, false, Some(true), true).await;
    let source = world
        .graph
        .writer_for_subgraph(NodeId::new(world.invocation.source_interaction_node_id).unwrap())
        .await
        .unwrap();
    source
        .complete(NodeId::new(world.invocation.source_interaction_node_id).unwrap())
        .await
        .unwrap();
    world.set_parent_status("accepted").await;
    let inspect = |bytes: Vec<u8>, expected: usize| {
        let records = crate::conversation_export::decode_export_jsonl(&bytes).unwrap();
        crate::conversation_export::validate_export_records(&records).unwrap();
        let text = String::from_utf8(bytes.clone()).unwrap();
        assert!(
            !text.contains("startup-call") && !text.contains("second-export-call"),
            "private call keys must not escape into portable identity"
        );
        let header: ConversationExportRecord =
            serde_json::from_slice(bytes.split(|byte| *byte == b'\n').next().unwrap()).unwrap();
        let ConversationExportRecord::Header(header) = header else {
            panic!("expected export header")
        };
        assert_eq!(
            header.export_version,
            crate::conversation_export::EXPORT_VERSION_V4
        );
        assert_eq!(header.invocations.len(), expected);
        let ids = header
            .invocations
            .iter()
            .map(|call| &call.id)
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(
            ids.len(),
            expected,
            "each call retains a distinct portable identity"
        );
        assert!(
            header
                .invocations
                .iter()
                .all(|call| call.arguments.is_empty() && call.returned_layer_id.is_none())
        );
        assert!(
            header
                .invocations
                .iter()
                .all(|call| call.source.instruction == "Child work")
        );
    };
    for call_count in [1, 2] {
        if call_count == 2 {
            let child = source
                .prepare_user_invocation(
                    relayer_graph_core::ActionId::new(world.invocation.source_action_id).unwrap(),
                    "second-export-call",
                )
                .await
                .unwrap()
                .0;
            world
                .product
                .invoke_durable_action(
                    world.thread.root_interaction_id,
                    world.invocation.source_action_id,
                    "Child work",
                    child.id.value(),
                    false,
                    "second-export-call",
                )
                .await
                .unwrap();
        }
        assert_eq!(
            world
                .product
                .action_invocations_for_export(world.thread.id)
                .await
                .unwrap()
                .len(),
            call_count
        );
        let conversation = crate::conversation_export_service::build_conversation_export(
            &world.product,
            &world.runtime,
            world.thread.id,
            world.state.export_producer.clone(),
            "2026-10-04T00:00:00Z".into(),
        )
        .await;
        inspect(conversation.unwrap(), call_count);
        let share = crate::conversation_export_service::build_share_conversation_export(
            &world.product,
            &world.runtime,
            world.thread.id,
            world.state.export_producer.clone(),
            "2026-10-04T00:00:00Z".into(),
            "Analysis",
        )
        .await;
        assert!(matches!(share, Err(crate::conversation_export_service::ConversationExportBuildError::ReusableInvocationPortabilityUnavailable)), "Hosted V4 must refuse both one and multiple native calls");
        assert_eq!(
            source
                .action_invocations(
                    relayer_graph_core::ActionId::new(world.invocation.source_action_id).unwrap()
                )
                .await
                .unwrap()
                .len(),
            call_count
        );
    }
    // Graph-owned prepared calls remain portable even without Product call rows.
    sqlx::query("DELETE FROM action_invocations WHERE source_interaction_id=?1")
        .bind(world.thread.root_interaction_id.value())
        .execute(&world.pool)
        .await
        .unwrap();
    assert!(
        world
            .product
            .action_invocations_for_export(world.thread.id)
            .await
            .unwrap()
            .is_empty()
    );
    let conversation = crate::conversation_export_service::build_conversation_export(
        &world.product,
        &world.runtime,
        world.thread.id,
        world.state.export_producer.clone(),
        "2026-10-04T00:00:00Z".into(),
    )
    .await;
    inspect(conversation.unwrap(), 2);
    let share = crate::conversation_export_service::build_share_conversation_export(
        &world.product,
        &world.runtime,
        world.thread.id,
        world.state.export_producer.clone(),
        "2026-10-04T00:00:00Z".into(),
        "Unbound analysis",
    )
    .await;
    assert!(matches!(share, Err(crate::conversation_export_service::ConversationExportBuildError::ReusableInvocationPortabilityUnavailable)), "Graph-only calls still require V4 and cannot bypass hosted capability admission");
    world.finish().await;
}

// The native inventory fixture alone cannot prove portable alias joins. Reuse the
// accepted Node and its authored callable in another real Product thread, then
// export each thread through the production builder with distinct arguments/Current.
#[tokio::test]
async fn portable_builder_isolates_shared_node_calls_and_preserves_selected_layer() {
    use relayer_graph_core::{
        InputAction, InputControl, PresentingInputOccurrence, SubmittedInputDraft,
        SubmittedInputValue,
    };
    let world = World::build_mode("portable-shared-node", false, false, Some(true)).await;
    let project = world
        .product
        .create_project(crate::product::CreateProjectCommand {
            path: world.root.path().to_str().unwrap().into(),
            name: Some("Shared fixture".into()),
            reuse_existing: true,
        })
        .await
        .unwrap()
        .project;
    let graph_project = Some(relayer_graph_core::ProjectId::new(project.id.value()).unwrap());
    let mut roots = Vec::new();
    for message in ["Private source thread", "Reference source thread"] {
        let thread = world
            .product
            .create_thread(CreateThreadCommand {
                icon_selection_eligible: true,
                title: None,
                project_id: Some(project.id),
                initial_message: message.into(),
                harness_configuration_name: HARNESS.into(),
                personal_presentation_version_key: None,
                permission_profile_id: "auto".into(),
                model_selection: None,
                allow_unselected_model: true,
            })
            .await
            .unwrap();
        let parent = world
            .graph
            .create_interaction(
                graph_project,
                ThreadId::new(thread.id.value()).unwrap(),
                message,
            )
            .await
            .unwrap();
        roots.push((thread, parent));
    }
    let a = world
        .graph
        .writer_for_subgraph(roots[0].1.id)
        .await
        .unwrap();
    let node = a
        .submit_node(&NodeDraft {
            client_key: "shared".into(),
            kind: "concept".into(),
            icon: "box".into(),
            title: "Shared destination".into(),
            detail: "Choose a destination".into(),
        })
        .await
        .unwrap();
    let layer = |key: &str, node_id| LayerDraft {
        client_key: key.into(),
        default_node_id: Some(node_id),
        nodes: vec![node_id],
        edges: vec![],
        size_justification: None,
        layout: Some(LayerLayout::v1(
            vec![NodePlacement {
                node_id,
                x: 0.5,
                y: 0.5,
            }],
            "default",
        )),
    };
    let authored = a.submit_layer(&layer("authored", node.id)).await.unwrap();
    let question = InputAction {
        control: InputControl::Text,
        prompt: "Destination".into(),
        options: vec![],
        minimum_selections: None,
        unsupported_fields: Default::default(),
    };
    let mut definition = ActionDraft {
        client_key: "destination".into(),
        source_node_id: node.id,
        source_layer_id: Some(authored.id),
        kind: ActionKind::Input,
        relation: None,
        label: "Destination".into(),
        variant: Default::default(),
        icon: None,
        description: None,
        target_layer_id: None,
        interaction_text: None,
        reusable: None,
        input_action_ids: vec![],
        input: Some(question.clone()),
    };
    let input = a.add_action(&definition).await.unwrap();
    definition.client_key = "research".into();
    definition.kind = ActionKind::Invoke;
    definition.input = None;
    definition.interaction_text = Some("Research the destination".into());
    definition.reusable = Some(true);
    definition.input_action_ids = vec![input.id];
    let invoke = a.add_action(&definition).await.unwrap();
    let navigation = |key: &str, source, source_layer, target, relation| ActionDraft {
        client_key: key.into(),
        source_node_id: source,
        source_layer_id: source_layer,
        kind: ActionKind::Navigate,
        relation: Some(relation),
        label: "Response".into(),
        variant: Default::default(),
        icon: None,
        description: None,
        target_layer_id: Some(target),
        interaction_text: None,
        reusable: None,
        input_action_ids: vec![],
        input: None,
    };
    a.add_action(&navigation(
        "response",
        roots[0].1.id,
        None,
        authored.id,
        NavigateRelation::Expand,
    ))
    .await
    .unwrap();
    a.complete(roots[0].1.id).await.unwrap();
    let b = world
        .graph
        .writer_for_subgraph(roots[1].1.id)
        .await
        .unwrap();
    let presented = b.submit_layer(&layer("reference", node.id)).await.unwrap();
    b.add_action(&navigation(
        "response",
        roots[1].1.id,
        None,
        presented.id,
        NavigateRelation::Expand,
    ))
    .await
    .unwrap();
    b.complete(roots[1].1.id).await.unwrap();
    for (thread, parent) in &roots {
        sqlx::query(
            "UPDATE interactions SET graph_node_id=?1,completion_status='accepted' WHERE id=?2",
        )
        .bind(parent.id.value())
        .bind(thread.root_interaction_id.value())
        .execute(&world.pool)
        .await
        .unwrap();
    }
    // Both calls retain the accepted Input's original saved occurrence. The
    // second Invoke activation independently selects its reference Layer B.
    for (writer, presenting, key, value, title) in [
        (
            &a,
            authored.id,
            "private-call-key",
            "PRIVATE_ARGUMENT",
            "PRIVATE_CURRENT",
        ),
        (
            &b,
            presented.id,
            "reference-call-key",
            "Lisbon",
            "Reference contribution",
        ),
    ] {
        let argument = SubmittedInputDraft {
            occurrence: PresentingInputOccurrence {
                presenting_interaction_node_id: roots[0].1.id,
                presenting_layer_id: authored.id,
                action_id: input.id,
            },
            action: question.clone(),
            value: SubmittedInputValue::Text { text: value.into() },
        };
        let (child, call) = writer
            .prepare_user_invocation_in_layer(invoke.id, key, &[argument], Some(presenting))
            .await
            .unwrap();
        assert_eq!(call.action_snapshot["sourceLayerId"], authored.id.value());
        assert_eq!(
            call.action_snapshot["presentingLayerId"],
            presenting.value()
        );
        let child_writer = world.graph.writer_for_subgraph(child.id).await.unwrap();
        let answer = child_writer
            .submit_node(&NodeDraft {
                client_key: "contribution".into(),
                kind: "concept".into(),
                icon: "box".into(),
                title: title.into(),
                detail: title.into(),
            })
            .await
            .unwrap();
        let current = child_writer
            .submit_layer(&layer("current", answer.id))
            .await
            .unwrap();
        child_writer
            .add_action(&navigation(
                "response",
                child.id,
                None,
                current.id,
                NavigateRelation::Expand,
            ))
            .await
            .unwrap();
        child_writer
            .add_action(&navigation(
                &format!("{key}-result"),
                node.id,
                Some(authored.id),
                current.id,
                NavigateRelation::Reference,
            ))
            .await
            .unwrap();
        child_writer
            .transition_current(
                0,
                "publish",
                CurrentTransition::Advance {
                    layer_id: current.id,
                },
            )
            .await
            .unwrap();
    }
    for (index, expected_value, expected_title, forbidden) in [
        (
            0,
            "PRIVATE_ARGUMENT",
            "PRIVATE_CURRENT",
            "Reference contribution",
        ),
        (1, "Lisbon", "Reference contribution", "PRIVATE_"),
    ] {
        let bytes = crate::conversation_export_service::build_conversation_export(
            &world.product,
            &world.runtime,
            roots[index].0.id,
            world.state.export_producer.clone(),
            "2026-10-08T00:00:00Z".into(),
        )
        .await
        .unwrap();
        let text = String::from_utf8(bytes.clone()).unwrap();
        assert!(
            !text.contains(forbidden),
            "a shared persistent Node must not bring another thread's arguments or Current into this export"
        );
        assert!(!text.contains("private-call-key") && !text.contains("reference-call-key"));
        let records = crate::conversation_export::decode_export_jsonl(&bytes).unwrap();
        crate::conversation_export::validate_export_records(&records).unwrap();
        let ConversationExportRecord::Header(header) = &records[0] else {
            panic!("header")
        };
        assert_eq!(
            header.invocations.len(),
            1,
            "only the source completion's own call is portable"
        );
        let call = &header.invocations[0];
        assert_eq!(
            call.arguments[0].value,
            crate::conversation_export::ExportSubmittedInputValue::Text {
                text: expected_value.into()
            }
        );
        assert_eq!(call.lifecycle, "active");
        assert!(call.result_turn_id.is_none() && call.returned_layer_id.is_none());
        assert!(
            call.current
                .as_ref()
                .unwrap()
                .layers
                .iter()
                .flat_map(|l| &l.nodes)
                .any(|n| n.title == expected_title)
        );
        let source = records
            .iter()
            .find_map(|r| match r {
                ConversationExportRecord::Turn(t) => Some(t),
                _ => None,
            })
            .unwrap();
        assert_eq!(
            source.interaction_node_id.as_ref(),
            Some(&call.source.interaction_node_id)
        );
        let root = source.accepted_view.as_ref().unwrap();
        assert_eq!(
            call.source.presenting_layer_id.as_ref(),
            Some(&root.root_layer_id)
        );
        let canonical = root
            .layers
            .iter()
            .flat_map(|l| &l.actions)
            .find(|a| a.id == call.source.action_id)
            .unwrap();
        assert_eq!(canonical.source_layer_id, call.source.layer_id);
        assert_eq!(canonical.source_node_id, call.source.parent_node_id);
        if index == 1 {
            assert_ne!(call.source.layer_id, call.source.presenting_layer_id);
            assert!(
                !root
                    .layers
                    .iter()
                    .any(|l| Some(&l.layer.id) == call.source.layer_id.as_ref()),
                "authored Layer A stays provenance; it is not invented as B's accepted closure"
            );
            assert_eq!(
                call.arguments[0].source.layer_id,
                call.source.layer_id.clone().unwrap()
            );
            assert_ne!(
                call.arguments[0].source.interaction_node_id,
                call.source.interaction_node_id
            );
        }
    }
    world.finish().await;
}

#[tokio::test]
async fn a_restart_recovers_exact_unbound_durable_user_call() {
    verify_unbound_durable_restart(false).await;
}

#[tokio::test]
async fn native_call_export_preserves_stopped_and_failed_current_without_return_or_staged_parent_link()
 {
    for stopped in [true, false] {
        let world = World::build_mode(
            if stopped {
                "portable-stopped-current"
            } else {
                "portable-failed-current"
            },
            false,
            false,
            Some(true),
        )
        .await;
        let parent_id = NodeId::new(world.invocation.source_interaction_node_id).unwrap();
        let source = world.graph.writer_for_subgraph(parent_id).await.unwrap();
        source.complete(parent_id).await.unwrap();
        world.set_parent_status("accepted").await;
        let child_id = NodeId::new(world.completion_id).unwrap();
        let child = world.graph.writer_for_subgraph(child_id).await.unwrap();
        let node = child
            .submit_node(&NodeDraft {
                client_key: "retained-analysis".into(),
                kind: "concept".into(),
                icon: "box".into(),
                title: "Retained contribution".into(),
                detail: "Useful analysis before the attempt settled.".into(),
            })
            .await
            .unwrap();
        let layer = child
            .submit_layer(&LayerDraft {
                client_key: "retained-layer".into(),
                default_node_id: Some(node.id),
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
        child
            .add_action(&ActionDraft {
                client_key: "retained-root".into(),
                source_node_id: child_id,
                source_layer_id: None,
                kind: ActionKind::Navigate,
                relation: Some(NavigateRelation::Expand),
                label: "Current".into(),
                variant: ActionVariant::Pill,
                icon: None,
                description: None,
                target_layer_id: Some(layer.id),
                interaction_text: None,
                reusable: None,
                input_action_ids: vec![],
                input: None,
            })
            .await
            .unwrap();
        let original = world
            .graph
            .accepted_graph_closure(parent_id)
            .await
            .unwrap()
            .unwrap()
            .layers
            .into_iter()
            .flat_map(|layer| layer.actions)
            .find(|action| action.id.value() == world.invocation.source_action_id)
            .unwrap();
        child
            .add_action(&ActionDraft {
                client_key: "staged-reconciliation".into(),
                source_node_id: original.source_node_id,
                source_layer_id: original.source_layer_id,
                kind: ActionKind::Navigate,
                relation: Some(NavigateRelation::Reference),
                label: "Staged parent integration".into(),
                variant: ActionVariant::Pill,
                icon: None,
                description: None,
                target_layer_id: Some(layer.id),
                interaction_text: None,
                reusable: None,
                input_action_ids: vec![],
                input: None,
            })
            .await
            .unwrap();
        child
            .transition_current(
                0,
                "portable-current",
                CurrentTransition::Advance { layer_id: layer.id },
            )
            .await
            .unwrap();
        let reason = if stopped {
            "cancelled_by_user"
        } else {
            "provider_timeout"
        };
        child
            .transition_current(
                1,
                "portable-outcome",
                if stopped {
                    CurrentTransition::Stop {
                        reason: reason.into(),
                    }
                } else {
                    CurrentTransition::Fail {
                        reason: reason.into(),
                    }
                },
            )
            .await
            .unwrap();
        let ordinary = crate::conversation_export_service::build_conversation_export(
            &world.product,
            &world.runtime,
            world.thread.id,
            world.state.export_producer.clone(),
            "2026-10-04T00:00:00Z".into(),
        )
        .await
        .unwrap();
        let share = crate::conversation_export_service::build_share_conversation_export(
            &world.product,
            &world.runtime,
            world.thread.id,
            world.state.export_producer.clone(),
            "2026-10-04T00:00:00Z".into(),
            "Retained analysis",
        )
        .await;
        assert!(matches!(share, Err(crate::conversation_export_service::ConversationExportBuildError::ReusableInvocationPortabilityUnavailable)), "Stopped and failed Current snapshots remain local V4 while hosted publication is closed");
        {
            let bytes = ordinary;
            let records = crate::conversation_export::decode_export_jsonl(&bytes).unwrap();
            crate::conversation_export::validate_export_records(&records).unwrap();
            let ConversationExportRecord::Header(header) = &records[0] else {
                unreachable!()
            };
            assert_eq!(header.invocations.len(), 1);
            let call = &header.invocations[0];
            assert_eq!(call.lifecycle, if stopped { "stopped" } else { "failed" });
            assert_eq!(call.safe_reason.as_deref(), Some(reason));
            assert_eq!(call.head_revision, 2);
            assert!(call.returned_layer_id.is_none());
            assert_eq!(
                call.current_layer_id.as_ref(),
                call.current.as_ref().map(|current| &current.root_layer_id)
            );
            assert!(
                call.current
                    .as_ref()
                    .unwrap()
                    .layers
                    .iter()
                    .flat_map(|layer| &layer.nodes)
                    .any(|node| node.title == "Retained contribution")
            );
            assert!(
                !String::from_utf8(bytes)
                    .unwrap()
                    .contains("Staged parent integration"),
                "Advance must not export its staged accepted-history effect as accepted content"
            );
        }
        world.finish().await;
    }
}

async fn verify_unbound_durable_restart(agent: bool) {
    // This recovery scenario intentionally owns a second, graph-only sibling call.
    let world = World::build_call_mode("durable-unbound", false, false, Some(agent), true).await;
    assert!(world.child.graph_node_id.is_none());
    let source = world
        .graph
        .writer_for_subgraph(
            relayer_graph_core::NodeId::new(world.invocation.source_interaction_node_id).unwrap(),
        )
        .await
        .unwrap();
    let sibling = source
        .prepare_recursive_invocation(
            relayer_graph_core::ActionId::new(world.invocation.source_action_id).unwrap(),
            "unrecorded-sibling",
        )
        .await
        .unwrap()
        .0;
    world.restart().await;
    let recovered = world.product.get_interaction(world.child.id).await.unwrap();
    assert_eq!(recovered.graph_node_id, Some(world.completion_id));
    // Existing startup semantics fail agent work but preserve an unlaunched
    // user call as submitted. Neither branch may substitute another call.
    assert_eq!(
        recovered.completion_status,
        if agent { "failed" } else { "submitted" }
    );
    assert_eq!(
        world
            .runtime
            .completion_current(world.completion_id)
            .await
            .unwrap()
            .lifecycle,
        if agent {
            relayer_graph_core::CompletionLifecycle::Failed
        } else {
            relayer_graph_core::CompletionLifecycle::Active
        }
    );
    assert_eq!(
        world
            .runtime
            .completion_current(sibling.id.value())
            .await
            .unwrap()
            .lifecycle,
        relayer_graph_core::CompletionLifecycle::Active
    );
    assert_eq!(
        source
            .action_invocations(
                relayer_graph_core::ActionId::new(world.invocation.source_action_id).unwrap()
            )
            .await
            .unwrap()
            .len(),
        2
    );
    assert_eq!(*world.harness.prov.lock().unwrap(), "none");
    world.restart().await;
    assert_eq!(
        world
            .product
            .get_interaction(world.child.id)
            .await
            .unwrap()
            .graph_node_id,
        Some(world.completion_id)
    );
}

/// An unbound child whose saved model no longer validates is still located and failed at
/// startup: failing it needs neither its model nor its harness policy.
#[tokio::test]
async fn a_restart_fails_an_unbound_child_whose_model_no_longer_validates() {
    let world = World::build("restart-invalid-model", true, false).await;
    assert!(
        world
            .product
            .claim_interaction_preparing(world.child.id)
            .await
            .unwrap()
    );
    sqlx::query("UPDATE model_families SET enabled=0 WHERE id=1")
        .execute(&world.pool)
        .await
        .unwrap();
    world.set_parent_status("failed").await;
    world.restart().await;

    let state = world.observe().await;
    assert_eq!(state["life"], "failed", "{state}");
    assert_eq!(state["why"], "application_restart", "{state}");
    assert_eq!(state["status"], "failed", "{state}");
    let child = world.child_row().await;
    assert_eq!(child.graph_node_id, Some(world.completion_id));
    assert_eq!(child.harness_configuration_name.as_deref(), Some(HARNESS));
    world.finish().await;
}

/// The refused-launch cleanup failed the product row, then the application stopped before it
/// failed the graph current. The next start finishes the graph half and stops revisiting it.
#[tokio::test]
async fn a_restart_finishes_the_graph_half_of_a_refused_child() {
    let world = World::unprepared("refused-graph-half").await;
    assert!(
        world
            .product
            .claim_interaction_preparing(world.child.id)
            .await
            .unwrap()
    );
    assert!(
        world
            .product
            .fail_unlaunched_recursive_child(
                world.child.id,
                world.completion_id,
                HARNESS,
                "preparation_failed",
                true,
                "1",
            )
            .await
            .unwrap()
    );
    assert!(world.graph_failure_pending().await);
    assert_eq!(world.observe().await["life"], "active");

    world.restart().await;
    let state = world.observe().await;
    assert_eq!(state["life"], "failed", "{state}");
    assert_eq!(state["why"], "preparation_failed", "{state}");
    assert!(
        !world.graph_failure_pending().await,
        "the child is unmarked"
    );
    world.finish().await;
}

/// A duplicate launch that finds the child already claimed by another launch, and whose own
/// preparation then ends ambiguously, refuses without failing the child: the claiming launch
/// still runs it.
#[tokio::test]
async fn a_duplicate_launchs_refusal_leaves_the_claiming_launch_its_child() {
    let world = World::unprepared("duplicate-refusal").await;
    let (broker, _lease) = world.broker();
    // Another launch holds the preparation claim and is still preparing.
    assert!(
        world
            .product
            .claim_interaction_preparing(world.child.id)
            .await
            .unwrap()
    );
    world
        .faults
        .garble_preparation
        .store(true, Ordering::SeqCst);
    let refused = world.launch(&broker).await;
    world
        .faults
        .garble_preparation
        .store(false, Ordering::SeqCst);
    assert!(
        refused.is_err(),
        "the duplicate's ambiguous preparation is refused"
    );

    tokio::time::sleep(Duration::from_millis(750)).await;
    let state = world.observe().await;
    assert_eq!(state["life"], "active", "the child was not failed: {state}");
    assert_eq!(state["status"], "submitted", "{state}");

    // The claiming launch carries on and starts the child.
    *world.harness.start.lock().unwrap() = "ok";
    let (status, _) = world
        .launch(&broker)
        .await
        .unwrap_or_else(|error| panic!("the claiming launch: {}", error.message()));
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(world.child_row().await.completion_status, "running");
    world.finish().await;
}

/// A start that cannot read a refused child's graph current keeps it marked and retries it in
/// the background, rather than leaving its current active until another restart.
#[tokio::test]
async fn a_refused_child_whose_graph_read_fails_at_startup_is_retried() {
    let world = World::unprepared("refused-graph-retry").await;
    assert!(
        world
            .product
            .claim_interaction_preparing(world.child.id)
            .await
            .unwrap()
    );
    assert!(
        world
            .product
            .fail_unlaunched_recursive_child(
                world.child.id,
                world.completion_id,
                HARNESS,
                "preparation_failed",
                true,
                "1",
            )
            .await
            .unwrap()
    );
    world.faults.fail_current_reads.store(1, Ordering::SeqCst);
    world.restart().await;

    let deadline = Instant::now() + Duration::from_secs(5);
    while world.observe().await["life"] == "active" && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let state = world.observe().await;
    assert_eq!(
        state["life"], "failed",
        "the graph half is retried: {state}"
    );
    assert_eq!(state["why"], "preparation_failed", "{state}");
    let deadline = Instant::now() + Duration::from_secs(2);
    while world.graph_failure_pending().await && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(!world.graph_failure_pending().await, "and then unmarked");
    world.finish().await;
}

/// An unbound child whose thread's harness configuration left the catalog is still located
/// through its graph occurrence and failed in both stores: finding it needs no live harness.
#[tokio::test]
async fn a_restart_fails_an_unbound_child_whose_harness_left_the_catalog() {
    let world = World::unprepared("restart-harness-gone").await;
    assert!(
        world
            .product
            .claim_interaction_preparing(world.child.id)
            .await
            .unwrap()
    );
    sqlx::query("UPDATE threads SET harness_configuration_name='retired-harness' WHERE id=?1")
        .bind(world.thread.id.value())
        .execute(&world.pool)
        .await
        .unwrap();
    world.set_parent_status("failed").await;
    world.restart().await;

    let state = world.observe().await;
    assert_eq!(state["life"], "failed", "{state}");
    assert_eq!(state["why"], "application_restart", "{state}");
    assert_eq!(state["status"], "failed", "{state}");
    assert_eq!(
        world.child_row().await.graph_node_id,
        Some(world.completion_id)
    );
    world.finish().await;
}

/// A deterministic startup failure followed by a transient graph error while failing the
/// child keeps the child for the background retry, which then ends it in both stores. The
/// product row is never made terminal while its graph current is still active.
#[tokio::test]
async fn a_transient_error_while_ending_a_child_keeps_it_for_retry() {
    let world = World::new("restart-deterministic-then-transient", false).await;
    world.set_parent_status("running").await;
    world
        .faults
        .refuse_invalidation
        .store(true, Ordering::SeqCst);
    world.faults.fail_current_reads.store(1, Ordering::SeqCst);
    world.restart().await;
    let kept = world.observe().await;
    assert!(
        !(kept["status"] == "failed" && kept["life"] == "active"),
        "the product row is not terminal while the graph is active: {kept}"
    );

    let deadline = Instant::now() + Duration::from_secs(5);
    let state = loop {
        let state = world.observe().await;
        if state["status"] == "failed" || Instant::now() >= deadline {
            break state;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    assert_eq!(state["life"], "failed", "{state}");
    assert_eq!(state["why"], "application_restart", "{state}");
    assert_eq!(state["status"], "failed", "{state}");
    world.finish().await;
}

/// A user invoked an action from an accepted child whose provider is still unwinding, and the
/// product has claimed that result's preparation. The child's agent then asks the broker for
/// the same action. The result is the user's: the broker refuses it, leaves it unmarked, and
/// launches nothing, so the product's own run keeps it and the user can stop it.
#[tokio::test]
async fn the_broker_refuses_a_users_invoke_of_the_same_action() {
    let world = World::unprepared("broker-refuses-user-invoke").await;
    let (broker, _lease) = world.broker();
    sqlx::query("UPDATE action_invocations SET agent_invoked=0")
        .execute(&world.pool)
        .await
        .unwrap();
    assert!(
        world
            .product
            .claim_interaction_preparing(world.child.id)
            .await
            .unwrap()
    );
    *world.harness.start.lock().unwrap() = "ok";
    let refused = world.launch(&broker).await;
    assert!(refused.is_err(), "the broker refuses a user's result");
    assert!(
        !world
            .product
            .is_agent_invoked_child(world.child.id)
            .await
            .unwrap(),
        "the user's result stays the user's"
    );
    tokio::time::sleep(Duration::from_millis(300)).await;
    let state = world.observe().await;
    assert_eq!(state["phase"], "none", "nothing was reserved: {state}");
    assert_eq!(state["prov"], "none", "nothing was started: {state}");
    assert_eq!(state["status"], "submitted", "{state}");
    world.finish().await;
}

/// A user's own invoke of the action owns its result, even while the agent of the accepted
/// source that published the action still holds its broker grant. The broker's Stop, current
/// and result endpoints all refuse that result, so the agent cannot end the user's run.
#[tokio::test]
async fn the_broker_refuses_every_request_for_a_users_result() {
    let world = World::new("broker-user-result", false).await;
    let (broker, _lease) = world.broker();
    sqlx::query("UPDATE action_invocations SET agent_invoked=0")
        .execute(&world.pool)
        .await
        .unwrap();

    let stopped = stop_completion(
        State(world.state.clone()),
        broker.clone(),
        Path(world.completion_id),
        None,
    )
    .await;
    assert!(stopped.is_err(), "the broker cannot stop a user's run");
    let current = completion_current(
        State(world.state.clone()),
        broker.clone(),
        Path(world.completion_id),
    )
    .await;
    assert!(current.is_err(), "nor read its current");
    let result = completion_result(
        State(world.state.clone()),
        broker.clone(),
        Path(world.completion_id),
        Query(CompletionResultQuery {
            after_revision: None,
        }),
    )
    .await;
    assert!(result.is_err(), "nor its result");
    let state = world.observe().await;
    assert_eq!(
        state["life"], "active",
        "the user's run is untouched: {state}"
    );
    world.finish().await;
}

#[tokio::test]
async fn imported_current_call_history_is_projected_without_execution_authority() {
    use crate::conversation_import_service::ConversationImportStager;
    let world =
        World::build_call_mode("inert-call-presentation", false, false, Some(true), true).await;
    let (_assets_directory, _assets_host, assets_url, assets_token) =
        crate::api::conversation_imports::tests::real_visual_assets_host();
    reqwest::Client::new()
        .put(format!(
            "{}api/control/visual-assets/bridge",
            world.graph_url
        ))
        .bearer_auth("graph-control")
        .json(&serde_json::json!({"url":assets_url,"token":assets_token,"generation":1}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    use sha2::{Digest, Sha256};
    let icon_bytes = b"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 8 8\"><circle cx=\"4\" cy=\"4\" r=\"3\"/></svg>".to_vec();
    let icon = relayer_graph_core::PreparedDetailAsset {
        asset_id: "current-icon".into(),
        digest_sha256: format!("{:x}", Sha256::digest(&icon_bytes)),
        media_type: "image/svg+xml".into(),
        byte_length: icon_bytes.len(),
        content: icon_bytes.clone(),
        provenance_source: "user".into(),
        provenance_file_name: "current.svg".into(),
    };
    let source_id = NodeId::new(world.invocation.source_interaction_node_id).unwrap();
    let source = world.graph.writer_for_subgraph(source_id).await.unwrap();
    source.complete(source_id).await.unwrap();
    world.set_parent_status("accepted").await;
    let child = world
        .graph
        .writer_for_subgraph(NodeId::new(world.completion_id).unwrap())
        .await
        .unwrap();
    let answer = child
        .submit_node_with_prepared_visual_assets(&NodeDraft {
            client_key: "current-answer".into(),
            kind: "concept".into(),
            icon: serde_json::json!({"kind":"image","assetId":icon.asset_id,"digestSha256":icon.digest_sha256,"mediaType":icon.media_type}).to_string(),
            title: "Current contribution".into(),
            detail: "Still working".into(),
        }, relayer_graph_core::AuthoredDetailUpdate::Retain, None, Some(&icon))
        .await
        .unwrap();
    let current = child
        .submit_layer(&LayerDraft {
            client_key: "current-answer".into(),
            default_node_id: Some(answer.id),
            nodes: vec![answer.id],
            edges: vec![],
            layout: Some(LayerLayout::v1(
                vec![NodePlacement {
                    node_id: answer.id,
                    x: 0.5,
                    y: 0.5,
                }],
                "default",
            )),
            size_justification: None,
        })
        .await
        .unwrap();
    child
        .add_action(&ActionDraft {
            client_key: "current-response".into(),
            source_node_id: NodeId::new(world.completion_id).unwrap(),
            source_layer_id: None,
            kind: ActionKind::Navigate,
            relation: Some(NavigateRelation::Expand),
            label: "Response".into(),
            variant: Default::default(),
            icon: None,
            description: None,
            target_layer_id: Some(current.id),
            interaction_text: None,
            reusable: None,
            input_action_ids: vec![],
            input: None,
        })
        .await
        .unwrap();
    let prepared = world
        .graph
        .durable_invocation(NodeId::new(world.completion_id).unwrap())
        .await
        .unwrap()
        .unwrap();
    child
        .add_action(&ActionDraft {
            client_key: "source-current".into(),
            source_node_id: prepared.parent_node_id,
            source_layer_id: prepared.action_snapshot["sourceLayerId"]
                .as_i64()
                .and_then(relayer_graph_core::LayerId::new),
            kind: ActionKind::Navigate,
            relation: Some(NavigateRelation::Reference),
            label: "Current contribution".into(),
            variant: Default::default(),
            icon: None,
            description: None,
            target_layer_id: Some(current.id),
            interaction_text: None,
            reusable: None,
            input_action_ids: vec![],
            input: None,
        })
        .await
        .unwrap();
    child
        .transition_current(
            0,
            "current-only",
            CurrentTransition::Advance {
                layer_id: current.id,
            },
        )
        .await
        .unwrap();
    let bytes = crate::conversation_export_service::build_conversation_export(
        &world.product,
        &world.runtime,
        world.thread.id,
        world.state.export_producer.clone(),
        "2026-10-08T00:00:00Z".into(),
    )
    .await
    .unwrap();
    let records = crate::conversation_export::decode_export_jsonl(&bytes).unwrap();
    let ConversationExportRecord::Header(header) = &records[0] else {
        panic!("header")
    };
    assert_eq!(header.invocations.len(), 1);
    let frozen = header.invocations[0].clone();
    assert!(frozen.current.is_some());
    assert!(frozen.result_turn_id.is_none());
    assert_eq!(
        frozen.activator,
        Some(crate::conversation_export::ExportInvocationActivator::Agent)
    );
    assert_eq!(
        frozen.source.capture_state,
        Some(crate::conversation_export::ExportInvocationCaptureState::Accepted)
    );
    assert_eq!(frozen.source.presenting_layer_id, frozen.source.layer_id);
    assert!(frozen.source.presenting_layer_id.is_some());
    let mut stager = ConversationImportStager::begin(*header.clone(), &world.product)
        .await
        .unwrap();
    for record in records.iter().skip(1) {
        match record {
            ConversationExportRecord::Turn(turn) => {
                stager.push_turn(turn, &world.product).await.unwrap()
            }
            ConversationExportRecord::VisualAssetContent(content) => stager
                .push_visual_asset_content(content, &world.product)
                .await
                .unwrap(),
            _ => unreachable!(),
        }
    }
    let receipt = stager
        .finish("sha256:inert-call-history".into(), &world.product)
        .await
        .unwrap();
    let imported = crate::conversation_import_service::materialize_and_publish_conversation(
        &receipt.import_id,
        &world.product,
        &world.runtime,
    )
    .await
    .unwrap();
    let thread_id = crate::product::ThreadId::from_database(imported.thread_id);
    let mut state = world.state.clone();
    state.product = ProductService::new(
        SqliteProductStore::open(&world.root.path().join("product.sqlite3"))
            .await
            .unwrap(),
        true,
    );
    let history = serde_json::to_value(
        project_imported_invocation_history(&state, thread_id)
            .await
            .unwrap_or_else(|error| panic!("history: {}", error.message())),
    )
    .unwrap();
    assert_eq!(history[0]["inert"], true);
    assert_eq!(history[0]["record"], serde_json::to_value(&frozen).unwrap());
    assert_eq!(
        history[0]["sourceInteractionId"],
        imported.turns[0].interaction_id
    );
    assert!(history[0]["sourceNodeId"].as_i64().is_some());
    assert_eq!(
        history[0]["visualAssetContents"][0]["digestSha256"],
        icon.digest_sha256
    );
    use base64::Engine as _;
    assert_eq!(
        history[0]["visualAssetContents"][0]["contentBase64"],
        base64::engine::general_purpose::STANDARD.encode(&icon_bytes)
    );
    assert!(history[0]["resultInteractionId"].is_null());
    let detail = state.product.get_thread(thread_id).await.unwrap();
    assert!(detail.action_invocations.is_empty());
    let source_graph = NodeId::new(imported.turns[0].graph_node_id.unwrap()).unwrap();
    let writer = world.graph.writer_for_subgraph(source_graph).await.unwrap();
    let layer = writer
        .get_layer(
            relayer_graph_core::LayerId::new(imported.turns[0].root_layer_id.unwrap()).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(history[0]["sourceNodeId"], layer.nodes[0].id.value());
    assert!(
        project_imported_invocation_history(&state, world.thread.id)
            .await
            .unwrap_or_else(|error| panic!("other scope: {}", error.message()))
            .is_empty()
    );
    let invoke = layer
        .actions
        .iter()
        .find(|action| action.kind == ActionKind::Invoke)
        .unwrap();
    assert!(
        writer
            .prepare_user_invocation(invoke.id, "forbidden-import-activation")
            .await
            .is_err()
    );
    let headers =
        HeaderMap::from_iter([(header::COOKIE, "relayer_control=control".parse().unwrap())]);
    let response = get(
        State(state.clone()),
        headers.clone(),
        Path(imported.thread_id),
    )
    .await
    .unwrap_or_else(|error| panic!("thread detail: {}", error.message()));
    let detail_json = serde_json::to_value(response.0).unwrap();
    assert_eq!(detail_json["importedInvocationHistory"], history);
    assert_eq!(detail_json["actionInvocations"], serde_json::json!([]));
    let state_query: crate::api::state::StateQuery =
        serde_json::from_value(serde_json::json!({ "threadId": imported.thread_id })).unwrap();
    let response =
        crate::api::state::product_state(State(state.clone()), headers, Query(state_query))
            .await
            .unwrap_or_else(|error| panic!("state: {}", error.message()));
    let state_json = serde_json::to_value(response.0).unwrap();
    assert_eq!(state_json["importedInvocationHistory"], history);
    assert_eq!(state_json["actionInvocations"], serde_json::json!([]));
    state.runtime = None;
    let unknown = serde_json::to_value(
        project_imported_invocation_history(&state, thread_id)
            .await
            .unwrap_or_else(|error| panic!("offline history: {}", error.message())),
    )
    .unwrap();
    assert_eq!(unknown[0]["record"], serde_json::to_value(&frozen).unwrap());
    assert!(unknown[0]["sourceNodeId"].is_null() && unknown[0]["sourceInteractionId"].is_null());

    world.finish().await;
}

#[tokio::test]
async fn bound_input_edits_stop_only_when_all_native_single_consumers_are_frozen() {
    use relayer_graph_core::{
        InputAction, InputControl, PresentingInputOccurrence, SubmittedInputDraft,
        SubmittedInputValue,
    };
    let world = World::new("input-consumer-exhaustion", false).await;
    let parent = world
        .graph
        .create_interaction(
            None,
            ThreadId::new(world.thread.id.value()).unwrap(),
            "Two consumers",
        )
        .await
        .unwrap();
    let writer = world.graph.writer_for_subgraph(parent.id).await.unwrap();
    let node = writer
        .submit_node(&NodeDraft {
            client_key: "shared-input-source".into(),
            kind: "concept".into(),
            icon: "box".into(),
            title: "Trip".into(),
            detail: "Shared destination".into(),
        })
        .await
        .unwrap();
    let layer = writer
        .submit_layer(&LayerDraft {
            client_key: "shared-input-layer".into(),
            default_node_id: Some(node.id),
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
    let question = InputAction {
        control: InputControl::Text,
        prompt: "Destination".into(),
        options: vec![],
        minimum_selections: None,
        unsupported_fields: Default::default(),
    };
    let base = ActionDraft {
        client_key: "destination".into(),
        source_node_id: node.id,
        source_layer_id: Some(layer.id),
        kind: ActionKind::Input,
        relation: None,
        label: "Destination".into(),
        variant: Default::default(),
        icon: None,
        description: None,
        target_layer_id: None,
        interaction_text: None,
        reusable: None,
        input_action_ids: vec![],
        input: Some(question.clone()),
    };
    let field = writer.add_action(&base).await.unwrap();
    let ordinary = writer
        .add_action(&ActionDraft {
            client_key: "notes".into(),
            label: "Notes".into(),
            ..base.clone()
        })
        .await
        .unwrap();
    let mut invokes = Vec::new();
    for key in ["itinerary", "budget"] {
        invokes.push(
            writer
                .add_action(&ActionDraft {
                    client_key: key.into(),
                    kind: ActionKind::Invoke,
                    label: key.into(),
                    interaction_text: Some(key.into()),
                    reusable: Some(false),
                    input_action_ids: vec![field.id],
                    input: None,
                    ..base.clone()
                })
                .await
                .unwrap(),
        );
    }
    writer
        .add_action(&ActionDraft {
            client_key: "response".into(),
            source_node_id: parent.id,
            source_layer_id: None,
            kind: ActionKind::Navigate,
            relation: Some(NavigateRelation::Expand),
            label: "Response".into(),
            target_layer_id: Some(layer.id),
            input: None,
            ..base
        })
        .await
        .unwrap();
    writer
        .transition_current(
            0,
            "return",
            CurrentTransition::Return { layer_id: layer.id },
        )
        .await
        .unwrap();
    // Reconstruct an older accepted Layer snapshot without the second global
    // Node-owned Invoke. The callable and its immutable binding remain native.
    let graph_pool = sqlx::SqlitePool::connect(&format!(
        "sqlite://{}",
        world.root.path().join("legacy-graph.sqlite3").display()
    ))
    .await
    .unwrap();
    sqlx::query("DELETE FROM layer_actions WHERE layer_id=?1 AND action_id=?2")
        .bind(layer.id.value())
        .bind(invokes[1].id.value())
        .execute(&graph_pool)
        .await
        .unwrap();
    graph_pool.close().await;
    let occurrence = PresentingInputOccurrence {
        presenting_interaction_node_id: parent.id,
        presenting_layer_id: layer.id,
        action_id: field.id,
    };
    let headers =
        HeaderMap::from_iter([(header::COOKIE, "relayer_control=control".parse().unwrap())]);
    let commit = |text: &str, revision: i64| {
        serde_json::from_value::<crate::api::input_drafts::CommitActionInputRequest>(
            serde_json::json!({
                "occurrence": occurrence, "value":{"text":text}, "expectedRevision":revision,
            }),
        )
        .unwrap()
    };
    let first = crate::api::input_drafts::commit(
        State(world.state.clone()),
        headers.clone(),
        Path(world.thread.id.value()),
        Json(commit("Lisbon", 0)),
    )
    .await
    .unwrap_or_else(|error| panic!("initial commit: {}", error.message()));
    assert_eq!(serde_json::to_value(first.0).unwrap()["revision"], 1);
    let argument = SubmittedInputDraft {
        occurrence: occurrence.clone(),
        action: question,
        value: SubmittedInputValue::Text {
            text: "Lisbon".into(),
        },
    };
    writer
        .prepare_user_invocation_with_inputs(
            invokes[0].id,
            "itinerary-call",
            std::slice::from_ref(&argument),
        )
        .await
        .unwrap();
    let flags = world
        .runtime
        .canonical_input_action_consumer_state(None, world.thread.id.value(), &occurrence)
        .await
        .unwrap();
    assert!(
        !flags.composer_eligible && flags.editable,
        "hidden consumer keeps Invoke scope and editing available"
    );
    let mut presentation = world
        .runtime
        .get_layer(parent.id.value(), layer.id.value())
        .await
        .unwrap();
    crate::api::input_drafts::project_layer_input_availability(
        &world.state,
        world.thread.id,
        parent.id.value(),
        &mut presentation,
        crate::api::interaction_graph::projection_deadline(),
    )
    .await
    .unwrap_or_else(|error| panic!("live availability: {}", error.message()));
    assert_eq!(
        presentation["actions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|action| action["id"] == field.id.value())
            .unwrap()["inputCanAcceptAnswer"],
        true
    );
    let second = crate::api::input_drafts::commit(
        State(world.state.clone()),
        headers.clone(),
        Path(world.thread.id.value()),
        Json(commit("Porto", 1)),
    )
    .await
    .unwrap_or_else(|error| panic!("shared commit: {}", error.message()));
    assert_eq!(serde_json::to_value(second.0).unwrap()["revision"], 2);
    writer
        .prepare_user_invocation_with_inputs(
            invokes[1].id,
            "budget-call",
            std::slice::from_ref(&argument),
        )
        .await
        .unwrap();
    crate::api::input_drafts::project_layer_input_availability(
        &world.state,
        world.thread.id,
        parent.id.value(),
        &mut presentation,
        crate::api::interaction_graph::projection_deadline(),
    )
    .await
    .unwrap_or_else(|error| panic!("used availability: {}", error.message()));
    assert_eq!(
        presentation["actions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|action| action["id"] == field.id.value())
            .unwrap()["inputCanAcceptAnswer"],
        false
    );
    let error = match crate::api::input_drafts::commit(
        State(world.state.clone()),
        headers,
        Path(world.thread.id.value()),
        Json(commit("Lost answer", 2)),
    )
    .await
    {
        Err(error) => error,
        Ok(_) => panic!("exhausted bound field accepted a new answer"),
    };
    let refused = axum::response::IntoResponse::into_response(error);
    assert_eq!(refused.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let body = axum::body::to_bytes(refused.into_body(), 8192)
        .await
        .unwrap();
    let refusal: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(refusal["error"]["code"], "input_consumers_exhausted");
    let draft = world
        .product
        .action_input_draft(world.thread.id)
        .await
        .unwrap();
    assert_eq!(draft.revision, 2);
    assert_eq!(
        draft.attachments[0].value,
        crate::product::ActionInputValue::Text {
            text: "Porto".into()
        }
    );
    // Existing frozen arguments can still be read and recovered; unrelated
    // ordinary Inputs remain usable after both consumers have their calls.
    world
        .runtime
        .canonical_input_action_occurrence(None, world.thread.id.value(), &occurrence)
        .await
        .unwrap();
    writer
        .prepare_user_invocation_with_inputs(invokes[1].id, "budget-call", &[argument])
        .await
        .unwrap();
    world
        .runtime
        .canonical_editable_input_action_occurrence(
            None,
            world.thread.id.value(),
            &PresentingInputOccurrence {
                action_id: ordinary.id,
                ..occurrence
            },
        )
        .await
        .unwrap();
    world.finish().await;
}

/// Both stores are real: Product admission happens before the single native call,
/// and a crash-shaped bind failure recovers its frozen key before model admission.
#[tokio::test]
async fn user_reservation_precedes_native_prepare_and_recovers_a_failed_bind() {
    use relayer_graph_core::{InputAction, InputControl, PresentingInputOccurrence};
    async fn assert_reservation_export(
        world: &World,
        rejected_id: InteractionId,
        pending_id: InteractionId,
    ) {
        let bytes = crate::conversation_export_service::build_conversation_export(
            &world.product,
            &world.runtime,
            world.thread.id,
            world.state.export_producer.clone(),
            "2026-10-08T00:00:00Z".into(),
        )
        .await
        .unwrap();
        let records = crate::conversation_export::decode_export_jsonl(&bytes).unwrap();
        crate::conversation_export::validate_export_records(&records).unwrap();
        let ConversationExportRecord::Header(header) = &records[0] else {
            panic!("header")
        };
        assert_eq!(
            header.invocations.len(),
            1,
            "only the real corrected native call is portable"
        );
        assert_eq!(
            header.invocations[0].arguments[0].value,
            crate::conversation_export::ExportSubmittedInputValue::Text {
                text: "Kyoto".into()
            }
        );
        let rejected_sequence = world
            .product
            .get_interaction(rejected_id)
            .await
            .unwrap()
            .sequence;
        let pending_sequence = world
            .product
            .get_interaction(pending_id)
            .await
            .unwrap()
            .sequence;
        let rejected_turn = records
            .iter()
            .find_map(|record| match record {
                ConversationExportRecord::Turn(turn)
                    if turn.sequence == rejected_sequence as u32 =>
                {
                    Some(turn)
                }
                _ => None,
            })
            .unwrap();
        assert_eq!(
            rejected_turn.origin,
            crate::conversation_export::ExportTurnOrigin::User,
            "a refused keyed preparation is chronology, never a fabricated legacy Action call"
        );
        let pending_turn = records
            .iter()
            .find_map(|record| match record {
                ConversationExportRecord::Turn(turn)
                    if turn.sequence == pending_sequence as u32 =>
                {
                    Some(turn)
                }
                _ => None,
            })
            .unwrap();
        assert!(
            header.invocations[0].result_turn_id.is_none(),
            "lost binding or restored unsent Product state preserves a graph-only native call"
        );
        assert_eq!(
            pending_turn.origin,
            crate::conversation_export::ExportTurnOrigin::User
        );
        let share = crate::conversation_export_service::build_share_conversation_export(
            &world.product,
            &world.runtime,
            world.thread.id,
            world.state.export_producer.clone(),
            "2026-10-08T00:00:00Z".into(),
            "Reservation chronology",
        )
        .await;
        assert!(matches!(share, Err(crate::conversation_export_service::ConversationExportBuildError::ReusableInvocationPortabilityUnavailable)));
    }
    let world = World::new("user-reservation-order", true).await;
    let parent = world
        .graph
        .create_interaction(
            None,
            ThreadId::new(world.thread.id.value()).unwrap(),
            "Root",
        )
        .await
        .unwrap();
    let writer = world.graph.writer_for_subgraph(parent.id).await.unwrap();
    let node = writer
        .submit_node(&NodeDraft {
            client_key: "reservation-source".into(),
            kind: "concept".into(),
            icon: "box".into(),
            title: "Destination".into(),
            detail: "Pick a trip".into(),
        })
        .await
        .unwrap();
    let layer = writer
        .submit_layer(&LayerDraft {
            client_key: "reservation-layer".into(),
            default_node_id: Some(node.id),
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
    let question = InputAction {
        control: InputControl::Text,
        prompt: "Destination".into(),
        options: vec![],
        minimum_selections: None,
        unsupported_fields: Default::default(),
    };
    let mut definition = ActionDraft {
        client_key: "destination".into(),
        source_node_id: node.id,
        source_layer_id: Some(layer.id),
        kind: ActionKind::Input,
        relation: None,
        label: "Destination".into(),
        variant: Default::default(),
        icon: None,
        description: None,
        target_layer_id: None,
        interaction_text: None,
        reusable: None,
        input_action_ids: vec![],
        input: Some(question),
    };
    let field = writer.add_action(&definition).await.unwrap();
    definition.client_key = "itinerary".into();
    definition.kind = ActionKind::Invoke;
    definition.input = None;
    definition.interaction_text = Some("Plan the trip".into());
    definition.input_action_ids = vec![field.id];
    definition.reusable = Some(false);
    let invoke = writer.add_action(&definition).await.unwrap();
    definition.client_key = "response".into();
    definition.source_node_id = parent.id;
    definition.source_layer_id = None;
    definition.kind = ActionKind::Navigate;
    definition.relation = Some(NavigateRelation::Expand);
    definition.target_layer_id = Some(layer.id);
    definition.interaction_text = None;
    definition.input_action_ids.clear();
    definition.reusable = None;
    writer.add_action(&definition).await.unwrap();
    writer.complete(parent.id).await.unwrap();
    let field = writer
        .get_layer(layer.id)
        .await
        .unwrap()
        .actions
        .into_iter()
        .find(|action| action.id == field.id)
        .unwrap();
    // Seed the accepted source in Product; the existing fixture child occupies
    // the real thread's active-human-turn admission slot.
    sqlx::query("UPDATE interactions SET graph_node_id=?1 WHERE id=?2")
        .bind(parent.id.value())
        .bind(world.thread.root_interaction_id.value())
        .execute(&world.pool)
        .await
        .unwrap();
    let occurrence = PresentingInputOccurrence {
        presenting_interaction_node_id: parent.id,
        presenting_layer_id: layer.id,
        action_id: field.id,
    };
    // This fixture has no provider continuity receipt for its historical root;
    // seed an ordinary unsent Product draft, which owns no graph or execution.
    let busy = sqlx::query("INSERT INTO interactions(thread_id,sequence,text,created_at,completion_status,permission_profile_id) VALUES (?1,(SELECT COALESCE(MAX(sequence),0)+1 FROM interactions WHERE thread_id=?1),'Busy ordinary turn','1','not_started','auto')")
        .bind(world.thread.id.value()).execute(&world.pool).await.unwrap().last_insert_rowid();
    let draft = world
        .product
        .commit_action_input_attachment(
            world.thread.id,
            &occurrence,
            &field,
            &crate::product::ActionInputValue::Text {
                text: "Kyoto".into(),
            },
            0,
        )
        .await
        .unwrap();
    let refused = invoke_action_with_authority(
        &world.state,
        world.thread.id.value(),
        world.thread.root_interaction_id.value(),
        invoke.id.value(),
        "admission-refused",
        Some(draft.revision),
        Some(layer.id.value()),
    )
    .await;
    let error = match refused {
        Err(error) => error,
        Ok(_) => panic!("active ordinary turn was admitted"),
    };
    assert_eq!(
        error.message(),
        "Wait for the active interaction to finish."
    );
    assert!(
        world
            .graph
            .conversation_graph_snapshot(&[parent.id])
            .await
            .unwrap()
            .invocations
            .is_empty()
    );
    assert!(
        world
            .product
            .user_invocation_reservation(
                world.thread.root_interaction_id,
                invoke.id.value(),
                Some("admission-refused"),
            )
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        world
            .product
            .action_input_draft(world.thread.id)
            .await
            .unwrap(),
        draft
    );
    sqlx::query("UPDATE interactions SET completion_status='stopped' WHERE id=?1")
        .bind(busy)
        .execute(&world.pool)
        .await
        .unwrap();
    // Missing connected arguments reach the real native preparation guard after
    // Product reserves admission, but spend no native call and keep the draft.
    assert!(
        invoke_action_with_authority(
            &world.state,
            world.thread.id.value(),
            world.thread.root_interaction_id.value(),
            invoke.id.value(),
            "missing-arguments",
            None,
            Some(layer.id.value()),
        )
        .await
        .is_err()
    );
    let rejected = world
        .product
        .user_invocation_reservation(
            world.thread.root_interaction_id,
            invoke.id.value(),
            Some("missing-arguments"),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(rejected.interaction.completion_status, "failed");
    assert!(!rejected.invocation.durable);
    assert!(
        !world
            .product
            .user_invocation_preparation_recoverable(rejected.interaction.id)
            .await
            .unwrap()
    );
    assert!(
        world
            .product
            .user_invocation_preparation_rejected(rejected.interaction.id)
            .await
            .unwrap()
    );
    let projected =
        project_action_invocations(&world.state, std::slice::from_ref(&rejected.invocation))
            .await
            .unwrap_or_else(|error| panic!("refusal projection: {}", error.message()));
    assert!(projected[0].preparation_rejected);
    assert!(!projected[0].preparation_recoverable);
    assert!(
        world
            .graph
            .conversation_graph_snapshot(&[parent.id])
            .await
            .unwrap()
            .invocations
            .is_empty()
    );
    assert_eq!(
        world
            .product
            .action_input_draft(world.thread.id)
            .await
            .unwrap(),
        draft
    );
    world.restart().await;
    assert!(
        world
            .product
            .user_invocation_preparation_rejected(rejected.interaction.id)
            .await
            .unwrap()
    );
    let same_key = invoke_action_with_authority(
        &world.state,
        world.thread.id.value(),
        world.thread.root_interaction_id.value(),
        invoke.id.value(),
        "missing-arguments",
        Some(draft.revision),
        Some(layer.id.value()),
    )
    .await;
    assert_eq!(
        same_key.err().unwrap().message(),
        "Rejected invocation preparation requires a fresh key"
    );
    // A corrected fresh key is admitted. The following independent bind-fault
    // boundary proves native preparation succeeded for that new key.
    sqlx::query("CREATE TRIGGER fail_authority_bind BEFORE UPDATE OF prepared_graph_node_id ON action_invocations WHEN NEW.prepared_graph_node_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'test bind failure'); END")
        .execute(&world.pool).await.unwrap();
    assert!(
        invoke_action_with_authority(
            &world.state,
            world.thread.id.value(),
            world.thread.root_interaction_id.value(),
            invoke.id.value(),
            "frozen-call",
            Some(draft.revision),
            Some(layer.id.value()),
        )
        .await
        .is_err()
    );
    let pending = world
        .product
        .user_invocation_reservation(
            world.thread.root_interaction_id,
            invoke.id.value(),
            Some("frozen-call"),
        )
        .await
        .unwrap()
        .unwrap();
    assert!(!pending.invocation.durable);
    assert!(
        !world
            .product
            .user_invocation_preparation_rejected(pending.interaction.id)
            .await
            .unwrap()
    );
    assert!(
        !world
            .runtime
            .native_invocation_key_absent(parent.id.value(), invoke.id.value(), "frozen-call")
            .await
            .unwrap(),
        "a lost Product bind cannot be certified as a native refusal"
    );
    assert!(
        world
            .product
            .user_invocation_preparation_recoverable(pending.interaction.id)
            .await
            .unwrap()
    );
    let inventory = world
        .graph
        .conversation_graph_snapshot(&[parent.id])
        .await
        .unwrap();
    assert_eq!(inventory.invocations.len(), 1);
    let native_child = inventory.invocations[0]
        .invocation
        .child_interaction_node_id;
    assert_eq!(
        inventory.invocations[0].invocation.invocation_key,
        "frozen-call"
    );
    assert_eq!(
        world
            .product
            .action_input_draft(world.thread.id)
            .await
            .unwrap(),
        draft
    );
    // The World seed's legacy link points at the old root graph, which this
    // fixture replaced above. Remove only that obsolete setup link; retain both
    // tested keyed Product receipts and every actual native invocation.
    let removed = sqlx::query("DELETE FROM action_invocations WHERE source_interaction_id=?1 AND action_id=?2 AND result_interaction_id=?3 AND invocation_key='legacy'")
        .bind(world.thread.root_interaction_id.value())
        .bind(world.invocation.source_action_id)
        .bind(world.child.id.value())
        .execute(&world.pool).await.unwrap();
    assert_eq!(removed.rows_affected(), 1);
    assert_reservation_export(&world, rejected.interaction.id, pending.interaction.id).await;
    world.restart().await;
    let restarted = world
        .product
        .user_invocation_reservation(
            world.thread.root_interaction_id,
            invoke.id.value(),
            Some("frozen-call"),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(restarted.interaction.id, pending.interaction.id);
    assert_eq!(restarted.interaction.completion_status, "not_started");
    assert!(!restarted.invocation.durable);
    assert_eq!(
        world
            .graph
            .conversation_graph_snapshot(&[parent.id])
            .await
            .unwrap()
            .invocations
            .len(),
        1
    );
    assert_eq!(
        world
            .product
            .action_input_draft(world.thread.id)
            .await
            .unwrap(),
        draft
    );
    sqlx::query("DROP TRIGGER fail_authority_bind")
        .execute(&world.pool)
        .await
        .unwrap();
    // This commit models an edit admitted before native preparation but persisted
    // afterward. Recovery may consume only its original captured epoch.
    let newer = world
        .product
        .commit_action_input_attachment(
            world.thread.id,
            &occurrence,
            &field,
            &crate::product::ActionInputValue::Text {
                text: "Lisbon".into(),
            },
            draft.revision,
        )
        .await
        .unwrap();
    let mut state = world.state.clone();
    state.interaction_execution = Some(crate::product::InteractionExecutionService::new(
        world.product.clone(),
        world.runtime.clone(),
        state.permission_catalog.clone(),
        state.standalone_workspaces_directory.clone(),
        state.approval_decisions.clone(),
        None,
        state.completion_brokers.clone(),
    ));
    *world.harness.admission.lock().unwrap() = "fail";
    // The existing fake host refuses session preparation before model execution.
    // Use the normal execution service, with no provider inference endpoint.
    let _handoff = invoke_action_with_authority(
        &state,
        world.thread.id.value(),
        world.thread.root_interaction_id.value(),
        invoke.id.value(),
        "new-click-key",
        Some(newer.revision),
        Some(layer.id.value()),
    )
    .await
    .unwrap_or_else(|error| panic!("recovery handoff: {}", error.message()));
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let current = world
            .product
            .get_interaction(pending.interaction.id)
            .await
            .unwrap();
        if current.completion_status == "not_started" && current.latest_attempt.is_some() {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "preexecution refusal did not settle: {current:?}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let rebound = world
        .product
        .user_invocation_reservation(
            world.thread.root_interaction_id,
            invoke.id.value(),
            Some("frozen-call"),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(rebound.interaction.id, pending.interaction.id);
    assert!(rebound.invocation.durable);
    assert_eq!(rebound.interaction.completion_status, "not_started");
    assert!(rebound.interaction.graph_node_id.is_none());
    let attempt = rebound.interaction.latest_attempt.unwrap();
    assert_eq!(attempt.outcome, "model_failed");
    assert_eq!(attempt.effect_boundary, "none");
    assert!(
        world
            .product
            .user_invocation_preparation_recoverable(rebound.interaction.id)
            .await
            .unwrap()
    );
    assert_eq!(
        world
            .product
            .action_input_draft(world.thread.id)
            .await
            .unwrap(),
        newer
    );
    let inventory = world
        .graph
        .conversation_graph_snapshot(&[parent.id])
        .await
        .unwrap();
    assert_eq!(inventory.invocations.len(), 1);
    assert_eq!(
        inventory.invocations[0]
            .invocation
            .child_interaction_node_id,
        native_child
    );
    assert_eq!(
        serde_json::to_value(&inventory.invocations[0].submitted_inputs[0].value).unwrap()["text"],
        "Kyoto"
    );
    assert_reservation_export(&world, rejected.interaction.id, pending.interaction.id).await;
    world.finish().await;
}

/// One accepted Input may be saved in two accepted presentations. Invoke freezes
/// one occurrence; ordinary attachment identity and concurrent newer epochs survive.
#[tokio::test]
async fn invoke_selects_one_saved_occurrence_and_consumes_only_its_frozen_epoch() {
    use relayer_graph_core::{InputAction, InputControl, PresentingInputOccurrence};
    let world = World::new("invoke-multiple-occurrences", true).await;
    let parent = world
        .graph
        .create_interaction(
            None,
            ThreadId::new(world.thread.id.value()).unwrap(),
            "Root",
        )
        .await
        .unwrap();
    let writer = world.graph.writer_for_subgraph(parent.id).await.unwrap();
    let node = writer
        .submit_node(&NodeDraft {
            client_key: "reservation-source".into(),
            kind: "concept".into(),
            icon: "box".into(),
            title: "Destination".into(),
            detail: "Pick a trip".into(),
        })
        .await
        .unwrap();
    let layer = writer
        .submit_layer(&LayerDraft {
            client_key: "reservation-layer".into(),
            default_node_id: Some(node.id),
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
    let question = InputAction {
        control: InputControl::Text,
        prompt: "Destination".into(),
        options: vec![],
        minimum_selections: None,
        unsupported_fields: Default::default(),
    };
    let mut definition = ActionDraft {
        client_key: "destination".into(),
        source_node_id: node.id,
        source_layer_id: Some(layer.id),
        kind: ActionKind::Input,
        relation: None,
        label: "Destination".into(),
        variant: Default::default(),
        icon: None,
        description: None,
        target_layer_id: None,
        interaction_text: None,
        reusable: None,
        input_action_ids: vec![],
        input: Some(question),
    };
    let field = writer.add_action(&definition).await.unwrap();
    definition.client_key = "pace".into();
    definition.input.as_mut().unwrap().prompt = "Pace".into();
    let companion = writer.add_action(&definition).await.unwrap();
    definition.client_key = "itinerary".into();
    definition.kind = ActionKind::Invoke;
    definition.input = None;
    definition.interaction_text = Some("Plan the trip".into());
    definition.input_action_ids = vec![field.id, companion.id];
    definition.reusable = Some(true);
    let invoke = writer.add_action(&definition).await.unwrap();
    definition.client_key = "response".into();
    definition.source_node_id = parent.id;
    definition.source_layer_id = None;
    definition.kind = ActionKind::Navigate;
    definition.relation = Some(NavigateRelation::Expand);
    definition.target_layer_id = Some(layer.id);
    definition.interaction_text = None;
    definition.input_action_ids.clear();
    definition.reusable = None;
    writer.add_action(&definition).await.unwrap();
    writer.complete(parent.id).await.unwrap();
    let field = writer
        .get_layer(layer.id)
        .await
        .unwrap()
        .actions
        .into_iter()
        .find(|action| action.id == field.id)
        .unwrap();

    // A later real interaction reuses the accepted persistent Node. Its new Layer
    // inherits the accepted Input identity without rewriting the authored occurrence.
    let authored_parent = parent;
    let parent = world
        .graph
        .create_interaction(
            None,
            ThreadId::new(world.thread.id.value()).unwrap(),
            "Another accepted presentation",
        )
        .await
        .unwrap();
    let presented_writer = world.graph.writer_for_subgraph(parent.id).await.unwrap();
    let alternate = presented_writer
        .submit_layer(&LayerDraft {
            client_key: "alternate-input-view".into(),
            default_node_id: Some(node.id),
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
    definition.client_key = "new-presentation".into();
    definition.source_node_id = parent.id;
    definition.target_layer_id = Some(alternate.id);
    presented_writer.add_action(&definition).await.unwrap();
    presented_writer.complete(parent.id).await.unwrap();
    sqlx::query("UPDATE interactions SET graph_node_id=?1 WHERE id=?2")
        .bind(parent.id.value())
        .bind(world.thread.root_interaction_id.value())
        .execute(&world.pool)
        .await
        .unwrap();
    let occurrence_a = PresentingInputOccurrence {
        presenting_interaction_node_id: authored_parent.id,
        presenting_layer_id: layer.id,
        action_id: field.id,
    };
    let occurrence_b = PresentingInputOccurrence {
        presenting_interaction_node_id: parent.id,
        presenting_layer_id: alternate.id,
        ..occurrence_a.clone()
    };
    world
        .runtime
        .canonical_input_action_occurrence(None, world.thread.id.value(), &occurrence_b)
        .await
        .unwrap();
    let draft = world
        .product
        .commit_action_input_attachment(
            world.thread.id,
            &occurrence_b,
            &field,
            &crate::product::ActionInputValue::Text {
                text: "Kyoto".into(),
            },
            0,
        )
        .await
        .unwrap();
    let draft = world
        .product
        .commit_action_input_attachment(
            world.thread.id,
            &occurrence_a,
            &field,
            &crate::product::ActionInputValue::Text {
                text: "Lisbon".into(),
            },
            draft.revision,
        )
        .await
        .unwrap();
    let companion_occurrence = PresentingInputOccurrence {
        action_id: companion.id,
        ..occurrence_b.clone()
    };
    let companion = world
        .runtime
        .canonical_input_action_occurrence(None, world.thread.id.value(), &companion_occurrence)
        .await
        .unwrap();
    let draft = world
        .product
        .commit_action_input_attachment(
            world.thread.id,
            &companion_occurrence,
            &companion,
            &crate::product::ActionInputValue::Text {
                text: "Relaxed".into(),
            },
            draft.revision,
        )
        .await
        .unwrap();
    assert_eq!(draft.attachments.len(), 3);
    // An unavailable canonical read cannot silently discard a saved answer or reserve a call.
    world
        .faults
        .fail_input_occurrence_reads
        .store(true, Ordering::SeqCst);
    assert!(
        invoke_action_with_authority(
            &world.state,
            world.thread.id.value(),
            world.thread.root_interaction_id.value(),
            invoke.id.value(),
            "unknown-occurrence",
            Some(draft.revision),
            Some(alternate.id.value())
        )
        .await
        .is_err()
    );
    assert!(
        world
            .product
            .user_invocation_reservation(
                world.thread.root_interaction_id,
                invoke.id.value(),
                Some("unknown-occurrence")
            )
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        world
            .graph
            .conversation_graph_snapshot(&[parent.id])
            .await
            .unwrap()
            .invocations
            .is_empty()
    );
    assert_eq!(
        world
            .product
            .action_input_draft(world.thread.id)
            .await
            .unwrap(),
        draft
    );
    world
        .faults
        .fail_input_occurrence_reads
        .store(false, Ordering::SeqCst);
    let native_action = world
        .runtime
        .get_action(parent.id.value(), invoke.id.value())
        .await
        .unwrap();
    // No saved clicked occurrence: choose the latest valid answer, keeping A's provenance.
    let fallback = select_invocation_input_attachments(
        &world.runtime,
        &world.thread,
        parent.id.value(),
        Some(alternate.id.value()),
        &native_action,
        draft
            .attachments
            .iter()
            .filter(|item| item.occurrence != occurrence_b)
            .cloned()
            .collect(),
    )
    .await
    .unwrap_or_else(|error| panic!("selector: {}", error.message()));
    assert_eq!(fallback.len(), 2);
    assert_eq!(fallback[0].occurrence, occurrence_a);
    // The canonical route rejects an inaccessible occurrence; its newer saved
    // epoch does not hide valid answers. Unknown route failures above fail closed.
    let mut invalid = draft.attachments[0].clone();
    invalid.occurrence.presenting_layer_id = relayer_graph_core::LayerId::new(999999).unwrap();
    invalid.committed_at = u128::MAX.to_string();
    let mut candidates = draft.attachments.clone();
    candidates.push(invalid);
    let latest = select_invocation_input_attachments(
        &world.runtime,
        &world.thread,
        parent.id.value(),
        None,
        &native_action,
        candidates,
    )
    .await
    .unwrap_or_else(|error| panic!("latest selector: {}", error.message()));
    assert_eq!(latest[0].occurrence, occurrence_a);
    let mut tied = draft.attachments.clone();
    for item in &mut tied {
        item.committed_at = "10".into();
    }
    let tie = select_invocation_input_attachments(
        &world.runtime,
        &world.thread,
        parent.id.value(),
        None,
        &native_action,
        tied,
    )
    .await
    .unwrap_or_else(|error| panic!("tie selector: {}", error.message()));
    assert_eq!(
        tie[0].occurrence, occurrence_b,
        "restored ties use numeric exact-occurrence order"
    );

    sqlx::query("CREATE TRIGGER fail_occurrence_bind BEFORE UPDATE OF prepared_graph_node_id ON action_invocations WHEN NEW.prepared_graph_node_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'occurrence bind fault'); END")
        .execute(&world.pool).await.unwrap();
    assert!(
        invoke_action_with_authority(
            &world.state,
            world.thread.id.value(),
            world.thread.root_interaction_id.value(),
            invoke.id.value(),
            "clicked-B",
            Some(draft.revision),
            Some(alternate.id.value())
        )
        .await
        .is_err()
    );
    let frozen = world
        .product
        .invocation_input_submission(
            world.thread.id,
            world.thread.root_interaction_id,
            invoke.id.value(),
            "clicked-B",
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(frozen.1.len(), 2);
    assert_eq!(
        frozen.1[0].occurrence, occurrence_b,
        "clicked B wins even though A was saved later"
    );
    assert_eq!(
        frozen.1[0].value,
        crate::product::ActionInputValue::Text {
            text: "Kyoto".into()
        }
    );
    let inventory = world
        .graph
        .conversation_graph_snapshot(&[parent.id])
        .await
        .unwrap();
    assert_eq!(
        inventory.invocations.len(),
        1,
        "duplicate action IDs never enter native preparation"
    );
    let native_answers = &inventory.invocations[0].submitted_inputs;
    assert_eq!(native_answers.len(), 2);
    let native_destination = native_answers
        .iter()
        .find(|answer| answer.occurrence.action_id == field.id)
        .unwrap();
    assert_eq!(native_destination.occurrence, occurrence_b);
    assert_eq!(native_destination.source_node_id, node.id);
    assert_eq!(native_destination.action, field.input.clone().unwrap());
    assert_eq!(
        native_destination.value,
        relayer_graph_core::SubmittedInputValue::Text {
            text: "Kyoto".into()
        }
    );
    let call = &inventory.invocations[0].invocation;
    assert_eq!(
        call.action_snapshot["presentingLayerId"],
        serde_json::json!(alternate.id)
    );
    let newer = world
        .product
        .commit_action_input_attachment(
            world.thread.id,
            &occurrence_b,
            &field,
            &crate::product::ActionInputValue::Text {
                text: "Oslo".into(),
            },
            draft.revision,
        )
        .await
        .unwrap();
    assert!(
        invoke_action_with_authority(
            &world.state,
            world.thread.id.value(),
            world.thread.root_interaction_id.value(),
            invoke.id.value(),
            "clicked-B",
            None,
            Some(alternate.id.value())
        )
        .await
        .is_err()
    );
    assert_eq!(
        world
            .product
            .invocation_input_submission(
                world.thread.id,
                world.thread.root_interaction_id,
                invoke.id.value(),
                "clicked-B"
            )
            .await
            .unwrap()
            .unwrap(),
        frozen
    );
    assert_eq!(
        world
            .graph
            .conversation_graph_snapshot(&[parent.id])
            .await
            .unwrap()
            .invocations
            .len(),
        1
    );
    sqlx::query("DROP TRIGGER fail_occurrence_bind")
        .execute(&world.pool)
        .await
        .unwrap();
    let node = world
        .runtime
        .prepare_user_invocation(
            parent.id.value(),
            invoke.id.value(),
            "clicked-B",
            Some(alternate.id.value()),
            &ProductService::invocation_arguments(&frozen.1).unwrap(),
        )
        .await
        .unwrap();
    world
        .product
        .invoke_user_durable_action_with_inputs(
            world.thread.root_interaction_id,
            invoke.id.value(),
            "Plan the trip",
            node,
            "clicked-B",
            frozen.0,
            &frozen.1,
        )
        .await
        .unwrap();
    let remaining = world
        .product
        .action_input_draft(world.thread.id)
        .await
        .unwrap();
    assert_eq!(
        remaining.attachments,
        newer
            .attachments
            .into_iter()
            .filter(|item| item.occurrence != companion_occurrence)
            .map(|mut item| {
                item.draft_revision = remaining.revision;
                item
            })
            .collect::<Vec<_>>(),
        "atomic bind consumes only unchanged captured epochs; A and newer B survive"
    );
    assert_eq!(remaining.revision, newer.revision + 1);
    world.finish().await;
}
