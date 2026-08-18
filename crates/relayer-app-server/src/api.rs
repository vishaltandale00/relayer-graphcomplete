mod auth;
mod error;
mod projects;
mod state;
mod threads;
mod types;

use crate::product::ProductService;
use crate::runtime::RuntimeClient;
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
    pub(crate) default_harness_configuration: String,
    pub(crate) allow_harness_override: bool,
    pub(crate) standalone_workspaces_directory: PathBuf,
}

pub(crate) fn router(
    product: ProductService,
    control_tokens: (String, Option<String>),
    web_directory: PathBuf,
    runtime: Option<RuntimeClient>,
    default_harness_configuration: String,
    allow_harness_override: bool,
    standalone_workspaces_directory: PathBuf,
) -> Router {
    let (control_token, read_only_control_token) = control_tokens;
    let state = ApiState {
        product,
        authenticator: DesktopSessionAuthenticator::new(control_token, read_only_control_token),
        runtime,
        default_harness_configuration,
        allow_harness_override,
        standalone_workspaces_directory,
    };
    Router::new()
        .route("/health", get(state::health))
        .route("/api/capabilities", get(state::capabilities))
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
        .fallback_service(ServeDir::new(web_directory).append_index_html_on_directories(true))
        .with_state(state)
}
