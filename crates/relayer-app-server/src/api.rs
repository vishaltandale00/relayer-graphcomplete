mod auth;
mod error;
mod model_settings;
mod projects;
mod state;
mod threads;
mod types;

use crate::runtime::RuntimeClient;
use crate::{permissions::PermissionCatalog, product::ProductService};
use auth::DesktopSessionAuthenticator;
use axum::{Router, routing::get};
use std::path::PathBuf;
use tower_http::services::ServeDir;

pub const CONTROL_COOKIE: &str = "relayer_control";

#[derive(Clone)]
pub(crate) struct ApiState {
    pub(crate) product: ProductService,
    pub(crate) authenticator: DesktopSessionAuthenticator,
    pub(crate) runtime: Option<RuntimeClient>,
    pub(crate) permission_catalog: PermissionCatalog,
    pub(crate) default_harness_configuration: String,
    pub(crate) allow_harness_override: bool,
    pub(crate) standalone_workspaces_directory: PathBuf,
}

pub(crate) struct ApiRuntime {
    pub(crate) runtime: Option<RuntimeClient>,
    pub(crate) permission_catalog: PermissionCatalog,
    pub(crate) default_harness_configuration: String,
    pub(crate) allow_harness_override: bool,
    pub(crate) standalone_workspaces_directory: PathBuf,
}

pub(crate) fn router(
    product: ProductService,
    control_tokens: (String, Option<String>),
    web_directory: PathBuf,
    runtime: ApiRuntime,
) -> Router {
    let (control_token, read_only_control_token) = control_tokens;
    let state = ApiState {
        product,
        authenticator: DesktopSessionAuthenticator::new(control_token, read_only_control_token),
        runtime: runtime.runtime,
        permission_catalog: runtime.permission_catalog,
        default_harness_configuration: runtime.default_harness_configuration,
        allow_harness_override: runtime.allow_harness_override,
        standalone_workspaces_directory: runtime.standalone_workspaces_directory,
    };
    Router::new()
        .route("/health", get(state::health))
        .route("/api/capabilities", get(state::capabilities))
        .route("/api/permission-profiles", get(state::permission_profiles))
        .route("/api/model-settings", get(model_settings::get))
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
            "/api/internal/provider-catalog",
            axum::routing::put(model_settings::publish_provider_catalog),
        )
        .route("/api/state", get(state::product_state))
        .route("/api/projects", get(projects::list).post(projects::create))
        .route("/api/threads", get(threads::list).post(threads::create))
        .route("/api/threads/{id}", get(threads::get))
        .route(
            "/api/threads/{id}/interactions",
            get(threads::list_interactions).post(threads::create_interaction),
        )
        .route(
            "/api/threads/{thread_id}/interactions/{interaction_id}/layers/{layer_id}",
            get(threads::get_layer),
        )
        .route(
            "/api/threads/{thread_id}/interactions/{interaction_id}/actions/{action_id}/invoke",
            axum::routing::post(threads::invoke_action),
        )
        .fallback_service(ServeDir::new(web_directory).append_index_html_on_directories(true))
        .with_state(state)
}
