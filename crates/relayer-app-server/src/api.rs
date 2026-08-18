mod auth;
mod error;
mod projects;
mod state;
mod threads;
mod types;

use crate::product::ProductService;
use auth::DesktopSessionAuthenticator;
use axum::{Router, routing::get};
use std::path::PathBuf;
use tower_http::services::ServeDir;

pub const CONTROL_COOKIE: &str = "relayer_control";

#[derive(Clone)]
pub(crate) struct ApiState {
    pub(crate) product: ProductService,
    pub(crate) authenticator: DesktopSessionAuthenticator,
}

pub(crate) fn router(
    product: ProductService,
    control_token: impl Into<String>,
    web_directory: PathBuf,
) -> Router {
    let state = ApiState {
        product,
        authenticator: DesktopSessionAuthenticator::new(control_token),
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
        .fallback_service(ServeDir::new(web_directory).append_index_html_on_directories(true))
        .with_state(state)
}
