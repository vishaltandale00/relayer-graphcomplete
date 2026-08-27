mod annotations;
mod auth;
mod context_drafts;
mod conversation_imports;
mod environment;
mod error;
mod model_settings;
mod projects;
mod state;
pub(crate) mod threads;
mod types;

use crate::{approval::ApprovalDecision, runtime::RuntimeClient};
use crate::{
    permissions::PermissionCatalog,
    product::{InteractionExecutionService, NodeContextDraftConfirmationService, ProductService},
};
use auth::DesktopSessionAuthenticator;
use axum::{Router, routing::get};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tower_http::services::ServeDir;

pub const CONTROL_COOKIE: &str = "relayer_control";

#[derive(Clone)]
pub(crate) struct AnnotationSession {
    pub(crate) thread_ids: HashSet<i64>,
    pub(crate) author_id: String,
    pub(crate) author_display_name: String,
}

#[derive(Clone)]
pub(crate) struct ApiState {
    pub(crate) product: ProductService,
    pub(crate) authenticator: DesktopSessionAuthenticator,
    pub(crate) runtime: Option<RuntimeClient>,
    pub(crate) interaction_execution: Option<InteractionExecutionService>,
    pub(crate) context_draft_confirmation: Option<NodeContextDraftConfirmationService>,
    pub(crate) permission_catalog: PermissionCatalog,
    pub(crate) default_harness_configuration: String,
    pub(crate) allow_harness_override: bool,
    pub(crate) allow_conversation_import: bool,
    pub(crate) standalone_workspaces_directory: PathBuf,
    pub(crate) export_producer: crate::conversation_export::ExportProducer,
    pub(crate) approval_decisions: Arc<Mutex<HashMap<String, ApprovalDecision>>>,
    pub(crate) annotation_sessions: Arc<Mutex<HashMap<String, AnnotationSession>>>,
    pub(crate) annotations_enabled: bool,
    pub(crate) environment_inspector: crate::environment::EnvironmentInspector,
}

pub(crate) struct ApiRuntime {
    pub(crate) runtime: Option<RuntimeClient>,
    pub(crate) permission_catalog: PermissionCatalog,
    pub(crate) default_harness_configuration: String,
    pub(crate) allow_harness_override: bool,
    pub(crate) allow_conversation_import: bool,
    pub(crate) standalone_workspaces_directory: PathBuf,
    pub(crate) export_producer: crate::conversation_export::ExportProducer,
    pub(crate) execution_lease_reconciler: Option<crate::app_server::ExecutionLeaseReconciler>,
}

pub(crate) fn router(
    product: ProductService,
    control_tokens: (String, Option<String>),
    web_directory: PathBuf,
    runtime: ApiRuntime,
) -> Router {
    let (control_token, read_only_control_token) = control_tokens;
    let annotations_enabled = read_only_control_token.is_some();
    let approval_decisions = Arc::new(Mutex::new(HashMap::new()));
    let interaction_execution = runtime.runtime.as_ref().map(|runtime_client| {
        InteractionExecutionService::new(
            product.clone(),
            runtime_client.clone(),
            runtime.permission_catalog.clone(),
            runtime.standalone_workspaces_directory.clone(),
            approval_decisions.clone(),
            runtime.execution_lease_reconciler.clone(),
        )
    });
    let context_draft_confirmation = runtime.runtime.as_ref().map(|runtime_client| {
        NodeContextDraftConfirmationService::new(product.clone(), runtime_client.clone())
    });
    let state = ApiState {
        product,
        authenticator: DesktopSessionAuthenticator::new(control_token, read_only_control_token),
        runtime: runtime.runtime,
        interaction_execution,
        context_draft_confirmation,
        permission_catalog: runtime.permission_catalog,
        default_harness_configuration: runtime.default_harness_configuration,
        allow_harness_override: runtime.allow_harness_override,
        allow_conversation_import: runtime.allow_conversation_import,
        standalone_workspaces_directory: runtime.standalone_workspaces_directory,
        export_producer: runtime.export_producer,
        approval_decisions,
        annotation_sessions: Arc::new(Mutex::new(HashMap::new())),
        annotations_enabled,
        environment_inspector: crate::environment::EnvironmentInspector::new(),
    };
    if state.runtime.is_some() {
        let recovery_state = state.clone();
        tokio::spawn(async move {
            threads::resume_recovered_identified_interactions(recovery_state).await;
        });
    }
    Router::new()
        .route("/health", get(state::health))
        .route("/api/capabilities", get(state::capabilities))
        .route("/api/permission-profiles", get(state::permission_profiles))
        .route("/api/model-settings", get(model_settings::get))
        .route(
            "/api/provider-onboarding/projection",
            get(model_settings::provider_onboarding_projection),
        )
        .route(
            "/api/provider-onboarding/complete",
            axum::routing::post(model_settings::complete_provider_onboarding),
        )
        .route(
            "/api/provider-onboarding/status",
            get(model_settings::provider_onboarding_status),
        )
        .route(
            "/api/model-settings/defaults",
            axum::routing::put(model_settings::update_defaults),
        )
        .route(
            "/api/model-families",
            axum::routing::post(model_settings::create_family),
        )
        .route(
            "/api/model-families/order",
            axum::routing::put(model_settings::reorder_families),
        )
        .route(
            "/api/model-families/{id}",
            axum::routing::put(model_settings::update_family).delete(model_settings::delete_family),
        )
        .route(
            "/api/model-selection/validate",
            axum::routing::post(model_settings::validate_selection),
        )
        .route(
            "/api/model-selection/default",
            get(model_settings::default_selection),
        )
        .route(
            "/api/harness-configurations/{id}/model-rules",
            axum::routing::put(model_settings::update_harness_model_rules),
        )
        .route(
            "/api/internal/provider-catalog",
            axum::routing::put(model_settings::publish_provider_catalog),
        )
        .route(
            "/api/internal/provider-definitions",
            get(model_settings::provider_definitions)
                .put(model_settings::sync_provider_definitions),
        )
        .route(
            "/api/internal/provider-definitions/staged",
            axum::routing::post(model_settings::create_provider_with_catalog),
        )
        .route(
            "/api/internal/conversation-imports",
            get(conversation_imports::list)
                .post(conversation_imports::import)
                .put(conversation_imports::publish)
                .delete(conversation_imports::remove)
                .layer(axum::extract::DefaultBodyLimit::max(
                    crate::conversation_export::MAX_EXPORT_BYTES,
                )),
        )
        .route("/api/state", get(state::product_state))
        .route("/api/projects", get(projects::list).post(projects::create))
        .route(
            "/api/projects/{id}/environment",
            get(environment::get),
        )
        .route("/api/threads", get(threads::list).post(threads::create))
        .route("/api/threads/{id}", get(threads::get))
        .route("/api/threads/{id}/export", get(threads::export))
        .route(
            "/api/threads/{thread_id}/context-drafts",
            get(context_drafts::list),
        )
        .route(
            "/api/threads/{thread_id}/context-drafts/{draft_id}",
            axum::routing::put(context_drafts::save).delete(context_drafts::discard),
        )
        .route(
            "/api/threads/{thread_id}/context-drafts/{draft_id}/confirm",
            axum::routing::post(context_drafts::confirm),
        )
        .route(
            "/api/internal/annotation-sessions",
            axum::routing::post(annotations::register_session)
                .delete(annotations::revoke_session),
        )
        .route(
            "/api/annotations/snapshot",
            axum::routing::post(annotations::snapshot_many),
        )
        .route(
            "/api/threads/{id}/annotations",
            get(annotations::list).post(annotations::create),
        )
        .route(
            "/api/threads/{id}/annotations/snapshot",
            get(annotations::snapshot),
        )
        .route(
            "/api/threads/{thread_id}/annotations/{annotation_id}/revisions",
            axum::routing::post(annotations::revise),
        )
        .route(
            "/api/threads/{thread_id}/annotations/{annotation_id}/retract",
            axum::routing::post(annotations::retract),
        )
        .route(
            "/api/threads/{id}/interactions",
            get(threads::list_interactions).post(threads::create_interaction),
        )
        .route(
            "/api/threads/{thread_id}/interactions/{interaction_id}/retry",
            axum::routing::post(threads::retry_interaction),
        )
        .route(
            "/api/threads/{thread_id}/interactions/{interaction_id}/layers/{layer_id}",
            get(threads::get_layer),
        )
        .route(
            "/api/threads/{thread_id}/interactions/{interaction_id}/actions/{action_id}/invoke",
            axum::routing::post(threads::invoke_action),
        )
        .route(
            "/api/threads/{thread_id}/interactions/{interaction_id}/approvals/{request_id}/decision",
            axum::routing::post(threads::decide_approval),
        )
        .route(
            "/api/threads/{thread_id}/interactions/{interaction_id}/actions/{action_id}/destination",
            get(threads::get_action_destination),
        )
        .fallback_service(ServeDir::new(web_directory).append_index_html_on_directories(true))
        .with_state(state)
}
