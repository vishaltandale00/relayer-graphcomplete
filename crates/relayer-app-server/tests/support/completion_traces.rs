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
//! step. Start-failure cleanup is the real background task. The fake harness
//! holds its first call (cancel) until the replay reaches `CleanCancel`, so the
//! task cannot run ahead of the trace; its later loops cannot be paused, so the
//! replay compares state once the task has run.

use super::*;
use crate::{
    api::auth::DesktopSessionAuthenticator,
    completion_broker::{CompletionBrokerRegistry, CompletionObservations},
    conversation_export::ExportProducer,
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
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

/// How long the replay lets the start-failure cleanup task run before it
/// compares state. A cleanup that settles takes a few milliseconds; one that
/// retries forever is still retrying when this elapses.
const CLEANUP_QUIESCENCE: Duration = Duration::from_millis(1500);

/// What the fake harness does, set by the replay.
struct HarnessControl {
    /// "fail" refuses a start; "lost" runs it but acknowledges another identity.
    start: Mutex<&'static str>,
    /// Once armed, a cancellation waits for the replay to release it.
    cancel_gated: AtomicBool,
    cancel_gate: tokio::sync::Semaphore,
}

struct World {
    state: ApiState,
    product: ProductService,
    runtime: RuntimeClient,
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
    root: PathBuf,
    tasks: Vec<tokio::task::JoinHandle<Result<(), std::io::Error>>>,
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
    /// and the recursive child prepared and bound for it, before any launch.
    async fn new(label: &str) -> Self {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "relayer-completion-trace-{label}-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        let database = root.join("product.sqlite3");
        let catalog = root.join("catalog.json");
        fs::write(
            &catalog,
            serde_json::json!({"schemaVersion":1,"configurations":[{"configuration":{
                "schemaVersion":1,"name":"test","implementation":"test",
                "implementationVersion":1,"permissionBindings":{"auto":{}},
                "complete":{"agentAuthored":true},"settings":{}
            },"digest":"sha256:test"}]})
            .to_string(),
        )
        .unwrap();
        let product = ProductService::new(SqliteProductStore::open(&database).await.unwrap(), true);
        let thread = product
            .create_thread(CreateThreadCommand {
                title: None,
                project_id: None,
                initial_message: "Root".into(),
                harness_configuration_name: "test".into(),
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
        let graph = GraphDatabase::in_memory().await.unwrap();
        graph.set_temporal_features(features).await.unwrap();
        let parent = graph
            .create_interaction(None, ThreadId::new(thread.id.value()).unwrap(), "Root")
            .await
            .unwrap();
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
                client_key: "current".into(),
                nodes: vec![source.id],
                edges: vec![],
                layout: Some(LayerLayout::v1(vec![NodePlacement {
                    node_id: source.id,
                    x: 0.5,
                    y: 0.5,
                }])),
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
                input: None,
            })
            .await
            .unwrap();
        writer
            .transition_current(
                0,
                "publish-child",
                CurrentTransition::Advance { layer_id: layer.id },
            )
            .await
            .unwrap();
        let graph_reader = graph.clone();
        let graph_app = relayer_graph_server::router(
            relayer_graph_server::ServerState::new(graph, "graph-control")
                .with_temporal_features(features),
        );

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
        pool.close().await;

        let harness_control = Arc::new(HarnessControl {
            start: Mutex::new("fail"),
            cancel_gated: AtomicBool::new(false),
            cancel_gate: tokio::sync::Semaphore::new(0),
        });
        let start_control = harness_control.clone();
        let cancel_control = harness_control.clone();
        let harness = Router::new()
            .route(
                "/sessions/{id}/invoked-completions",
                routing::post(move || {
                    let control = start_control.clone();
                    async move {
                        if *control.start.lock().unwrap() == "lost" {
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
                        axum::Json(serde_json::json!({"cancelled":true}))
                    }
                }),
            );
        let (graph_url, graph_task) = serve(graph_app).await;
        let (harness_url, harness_task) = serve(harness).await;
        let runtime = RuntimeClient::open(
            &graph_url,
            &harness_url,
            "graph-control".into(),
            "harness-control".into(),
            &catalog,
        )
        .await
        .unwrap();
        let permission_catalog = crate::permissions::PermissionCatalog::load(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("../../permissions/desktop.json"),
        )
        .await
        .unwrap();

        let invocation = PreparedInvocation {
            source_interaction_node_id: parent.id.value(),
            source_action_id: invoke.id.value(),
        };
        let child = product
            .invoke_action_recursively(thread.root_interaction_id, invoke.id.value(), "Child work")
            .await
            .unwrap()
            .interaction;
        assert!(product.claim_interaction_preparing(child.id).await.unwrap());
        let working_directory = root.to_string_lossy().into_owned();
        let seeded = runtime
            .prepare(&CompleteInteraction {
                project_id: None,
                product_interaction_id: child.id.value(),
                thread_id: thread.id.value(),
                interaction_id: child.id.value(),
                text: &child.text,
                working_directory: &working_directory,
                harness_configuration_name: "test",
                permission_profile: permission_catalog.profile("auto").unwrap(),
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
            })
            .await
            .unwrap();
        assert!(
            product
                .bind_prepared_interaction(PreparedInteractionBinding {
                    interaction_id: child.id,
                    graph_node_id: seeded.graph_node_id,
                    harness_configuration_name: &seeded.harness_configuration_name,
                    harness_configuration_digest: &seeded.harness_configuration_digest,
                    effective_execution_digest: &seeded.effective_execution_digest,
                    effective_permission_receipt: &seeded.effective_permission_receipt,
                    input_children: &seeded.input_children,
                })
                .await
                .unwrap()
        );
        let origin_digest =
            completion_permission_origin_digest(&seeded.effective_permission_receipt, invocation)
                .unwrap_or_else(|error| panic!("origin digest: {}", error.message()));
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
            default_harness_configuration: "test".into(),
            allow_harness_override: true,
            allow_conversation_import: false,
            standalone_workspaces_directory: root.join("workspaces"),
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
        Self {
            state,
            product,
            runtime,
            thread,
            completion_id: seeded.graph_node_id,
            child,
            seeded,
            activated: None,
            invocation,
            origin_digest,
            stop_report: "none",
            graph: graph_reader,
            harness: harness_control,
            root,
            tasks: vec![graph_task, harness_task],
        }
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
            "LaunchActivate" => {
                assert_eq!(
                    argument(2),
                    "ok",
                    "the adapter drives successful activation only"
                );
                let activated = claim_and_activate_prepared_interaction(
                    &self.state,
                    &self.thread,
                    &self.child,
                    self.seeded.clone(),
                    true,
                    false,
                )
                .await
                .unwrap_or_else(|error| panic!("activation: {}", error.message()))
                .expect("activation ownership");
                self.activated = Some(activated);
            }
            "LaunchStart" => {
                let mode = match argument(2) {
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
                    )
                    .await;
                assert!(started.is_err(), "a {mode} start must fail");
                // Hold the cleanup at its first call until the trace releases it.
                self.harness.cancel_gated.store(true, Ordering::SeqCst);
                spawn_failed_recursive_start_cleanup(
                    self.state.clone(),
                    self.thread.clone(),
                    self.child.clone(),
                    activated,
                    self.origin_digest.clone(),
                );
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
                        client_key: "answer".into(),
                        nodes: vec![answer.id],
                        edges: vec![],
                        layout: Some(LayerLayout::v1(vec![NodePlacement {
                            node_id: answer.id,
                            x: 0.5,
                            y: 0.5,
                        }])),
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
            "CleanCancel" | "CleanFail" | "CleanFinalize" | "CleanDiscard" => {
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

    async fn await_cleanup(&self) {
        let deadline = Instant::now() + CLEANUP_QUIESCENCE;
        while Instant::now() < deadline {
            let settled = self
                .product
                .completion_execution(self.child.id)
                .await
                .unwrap()
                .is_some_and(|execution| execution.phase == CompletionExecutionPhase::Settled);
            if settled {
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
        serde_json::json!({
            "life": serde_json::to_value(current.lifecycle).unwrap(),
            "head": current.head_revision,
            "why": current.safe_reason.unwrap_or_else(|| "none".into()),
            "phase": phase,
            "status": status,
            "stopReport": self.stop_report,
            "execWhy": execution_reason,
        })
    }

    fn finish(self) {
        for task in self.tasks {
            task.abort();
        }
        fs::remove_dir_all(self.root).unwrap();
    }
}

fn project_model_state(state: &Value) -> Value {
    serde_json::json!({
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
    let mut world = World::new(scenario).await;
    let steps = trace["steps"].as_array().unwrap();
    let is_cleanup = |step: Option<&Value>| {
        step.and_then(|step| step["action"][0].as_str())
            .is_some_and(|name| name.starts_with("Clean"))
    };
    for (index, step) in steps.iter().enumerate() {
        let action = step["action"].as_array();
        let next_is_cleanup = is_cleanup(steps.get(index + 1));
        if let Some(action) = action {
            world.apply(action, next_is_cleanup).await;
        }
        // The cleanup task's internal steps are compared once it has run.
        if is_cleanup(Some(step)) && next_is_cleanup {
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
    world.finish();
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
