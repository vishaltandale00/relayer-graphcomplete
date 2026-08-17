pub mod model;
pub mod store;

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
};
use model::{
    CreateInteraction, CreateProject, CreateThread, InteractionNode, ProductCapabilities,
    ProductState, ThreadView,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use store::{ProductStore, StoreError};
use tower_http::services::ServeDir;

pub const CONTROL_COOKIE: &str = "relayer_control";

#[derive(Clone)]
pub struct AppState {
    store: Arc<Mutex<ProductStore>>,
    control_token: Arc<str>,
}

impl AppState {
    pub fn new(store: ProductStore, control_token: impl Into<String>) -> Self {
        Self {
            store: Arc::new(Mutex::new(store)),
            control_token: Arc::from(control_token.into()),
        }
    }
}

pub fn router(state: AppState, web_directory: PathBuf) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/api/capabilities", get(capabilities))
        .route("/api/state", get(product_state))
        .route("/api/projects", get(list_projects).post(create_project))
        .route("/api/threads", get(list_threads).post(create_thread))
        .route("/api/threads/{id}", get(get_thread))
        .route(
            "/api/threads/{id}/interactions",
            get(list_interactions).post(create_interaction),
        )
        .fallback_service(ServeDir::new(web_directory).append_index_html_on_directories(true))
        .with_state(state)
}

async fn health() -> Json<Value> {
    Json(json!({
        "ok": true,
        "service": "relayer-app-server",
        "capabilities": ProductCapabilities::default(),
    }))
}

async fn capabilities(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<ProductCapabilities>, ApiError> {
    authorize(&state, &headers)?;
    Ok(Json(ProductCapabilities::default()))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StateQuery {
    thread_id: Option<String>,
}

async fn product_state(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<StateQuery>,
) -> Result<Json<ProductState>, ApiError> {
    authorize(&state, &headers)?;
    let store = lock(&state)?;
    let projects = store.list_projects()?;
    let threads = store.list_threads()?;
    let selected_id = query
        .thread_id
        .filter(|id| threads.iter().any(|thread| thread.id == *id))
        .or_else(|| threads.first().map(|thread| thread.id.clone()));
    let interactions = match selected_id.as_deref() {
        Some(thread_id) => store.list_interactions(thread_id)?,
        None => Vec::new(),
    };
    let title = selected_id
        .as_deref()
        .and_then(|id| threads.iter().find(|thread| thread.id == id))
        .map(|thread| thread.title.clone())
        .unwrap_or_default();
    let thread_views = threads
        .into_iter()
        .map(|thread| ThreadView {
            root_node_id: thread.root_interaction_id.clone(),
            active: selected_id.as_deref() == Some(thread.id.as_str()),
            thread,
        })
        .collect();
    let nodes = interactions
        .into_iter()
        .map(|interaction| InteractionNode {
            id: interaction.id,
            kind: "user-interaction",
            title: title.clone(),
            summary: interaction.text,
        })
        .collect();
    Ok(Json(ProductState {
        projects,
        threads: thread_views,
        nodes,
        edges: Vec::new(),
        status: "idle",
        capabilities: ProductCapabilities::default(),
    }))
}

async fn list_projects(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers)?;
    Ok(Json(json!({ "projects": lock(&state)?.list_projects()? })))
}

async fn create_project(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<CreateProject>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    authorize(&state, &headers)?;
    let mut store = lock(&state)?;
    let outcome = match store.create_project(input) {
        Ok(outcome) => outcome,
        Err(StoreError::ProjectExists(id)) => {
            let project = store.get_project(&id)?;
            return Err(ApiError(
                StatusCode::CONFLICT,
                json!({
                    "code": "project_exists",
                    "error": "This folder is already a Relayer project. Confirm before reusing it.",
                    "existingProject": project,
                }),
            ));
        }
        Err(error) => return Err(error.into()),
    };
    let status = if outcome.created {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    Ok((status, Json(json!(outcome.project))))
}

async fn list_threads(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers)?;
    Ok(Json(json!({ "threads": lock(&state)?.list_threads()? })))
}

async fn create_thread(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<CreateThread>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    authorize(&state, &headers)?;
    let thread = lock(&state)?.create_thread(input)?;
    Ok((
        StatusCode::CREATED,
        Json(json!(ThreadView {
            root_node_id: thread.root_interaction_id.clone(),
            active: true,
            thread,
        })),
    ))
}

async fn get_thread(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers)?;
    let store = lock(&state)?;
    let thread = store.get_thread(&id)?;
    let interactions = store.list_interactions(&id)?;
    Ok(Json(
        json!({ "thread": thread, "interactions": interactions }),
    ))
}

async fn list_interactions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers)?;
    Ok(Json(
        json!({ "interactions": lock(&state)?.list_interactions(&id)? }),
    ))
}

async fn create_interaction(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<CreateInteraction>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    authorize(&state, &headers)?;
    let interaction = lock(&state)?.create_interaction(&id, &input.text)?;
    Ok((StatusCode::CREATED, Json(json!(interaction))))
}

fn authorize(state: &AppState, headers: &HeaderMap) -> Result<(), ApiError> {
    let supplied = headers
        .get("cookie")
        .and_then(|value| value.to_str().ok())
        .and_then(|cookies| {
            cookies.split(';').find_map(|cookie| {
                let (name, value) = cookie.trim().split_once('=')?;
                (name == CONTROL_COOKIE).then_some(value)
            })
        });
    if supplied == Some(state.control_token.as_ref()) {
        Ok(())
    } else {
        Err(ApiError::unauthorized())
    }
}

fn lock(state: &AppState) -> Result<std::sync::MutexGuard<'_, ProductStore>, ApiError> {
    state
        .store
        .lock()
        .map_err(|_| ApiError::internal("product store lock poisoned"))
}

pub struct ApiError(StatusCode, Value);

impl ApiError {
    fn unauthorized() -> Self {
        Self(
            StatusCode::UNAUTHORIZED,
            json!({ "error": "A valid Relayer desktop session is required." }),
        )
    }

    fn internal(message: &str) -> Self {
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": message }),
        )
    }
}

impl From<StoreError> for ApiError {
    fn from(error: StoreError) -> Self {
        match error {
            StoreError::NotFound(message) => Self(
                StatusCode::NOT_FOUND,
                json!({ "error": format!("Not found: {message}") }),
            ),
            StoreError::Invalid(message) => Self(
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({ "code": "invalid_input", "error": message }),
            ),
            StoreError::ProjectExists(project_id) => Self(
                StatusCode::CONFLICT,
                json!({
                    "code": "project_exists",
                    "error": "This folder is already a Relayer project.",
                    "projectId": project_id,
                }),
            ),
            StoreError::FolderUnavailable { path, reason } => Self(
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({
                    "code": "folder_unavailable",
                    "error": "Relayer cannot access that folder. Choose it again or restore permission.",
                    "path": path,
                    "reason": reason,
                }),
            ),
            other => Self::internal(&other.to_string()),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(self.1)).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{Body, to_bytes},
        http::Request,
    };
    use std::fs;
    use tower::ServiceExt;
    use uuid::Uuid;

    #[tokio::test]
    async fn persists_project_thread_and_interaction_across_restart() {
        let root = std::env::temp_dir().join(format!("relayer-app-server-{}", Uuid::new_v4()));
        let project_folder = root.join("project");
        fs::create_dir_all(&project_folder).unwrap();
        let database = root.join("product.sqlite3");

        {
            let app = router(
                AppState::new(ProductStore::open(&database).unwrap(), "control"),
                root.clone(),
            );
            let denied = app
                .clone()
                .oneshot(api_request("GET", "/api/state", None, false))
                .await
                .unwrap();
            assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);

            let project = app
                .clone()
                .oneshot(api_request(
                    "POST",
                    "/api/projects",
                    Some(json!({ "path": project_folder })),
                    true,
                ))
                .await
                .unwrap();
            assert_eq!(project.status(), StatusCode::CREATED);
            let project: Value =
                serde_json::from_slice(&to_bytes(project.into_body(), usize::MAX).await.unwrap())
                    .unwrap();

            let duplicate = app
                .clone()
                .oneshot(api_request(
                    "POST",
                    "/api/projects",
                    Some(json!({ "path": project_folder })),
                    true,
                ))
                .await
                .unwrap();
            assert_eq!(duplicate.status(), StatusCode::CONFLICT);
            let duplicate: Value =
                serde_json::from_slice(&to_bytes(duplicate.into_body(), usize::MAX).await.unwrap())
                    .unwrap();
            assert_eq!(duplicate["code"], "project_exists");
            assert_eq!(duplicate["existingProject"]["id"], project["id"]);

            let reused = app
                .clone()
                .oneshot(api_request(
                    "POST",
                    "/api/projects",
                    Some(json!({ "path": project_folder, "reuseExisting": true })),
                    true,
                ))
                .await
                .unwrap();
            assert_eq!(reused.status(), StatusCode::OK);

            let unavailable = app
                .clone()
                .oneshot(api_request(
                    "POST",
                    "/api/projects",
                    Some(json!({ "path": root.join("missing") })),
                    true,
                ))
                .await
                .unwrap();
            assert_eq!(unavailable.status(), StatusCode::UNPROCESSABLE_ENTITY);
            let unavailable: Value = serde_json::from_slice(
                &to_bytes(unavailable.into_body(), usize::MAX).await.unwrap(),
            )
            .unwrap();
            assert_eq!(unavailable["code"], "folder_unavailable");

            let thread = app
                .clone()
                .oneshot(api_request(
                    "POST",
                    "/api/threads",
                    Some(json!({
                        "title": "Persist me",
                        "projectId": project["id"],
                        "initialMessage": "Map the project"
                    })),
                    true,
                ))
                .await
                .unwrap();
            assert_eq!(thread.status(), StatusCode::CREATED);

            let standalone = app
                .clone()
                .oneshot(api_request(
                    "POST",
                    "/api/threads",
                    Some(json!({
                        "title": "Standalone thread",
                        "initialMessage": "Keep this local"
                    })),
                    true,
                ))
                .await
                .unwrap();
            assert_eq!(standalone.status(), StatusCode::CREATED);
        }

        let app = router(
            AppState::new(ProductStore::open(&database).unwrap(), "control"),
            root.clone(),
        );
        let state = app
            .clone()
            .oneshot(api_request("GET", "/api/state", None, true))
            .await
            .unwrap();
        let state: Value =
            serde_json::from_slice(&to_bytes(state.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(state["projects"].as_array().unwrap().len(), 1);
        assert_eq!(state["threads"].as_array().unwrap().len(), 2);
        assert!(state["threads"].as_array().unwrap().iter().any(|thread| {
            thread["title"] == "Standalone thread" && thread["projectId"].is_null()
        }));
        for (title, expected_message) in [
            ("Persist me", "Map the project"),
            ("Standalone thread", "Keep this local"),
        ] {
            let thread_id = state["threads"]
                .as_array()
                .unwrap()
                .iter()
                .find(|thread| thread["title"] == title)
                .unwrap()["id"]
                .as_str()
                .unwrap();
            let interactions = app
                .clone()
                .oneshot(api_request(
                    "GET",
                    &format!("/api/threads/{thread_id}/interactions"),
                    None,
                    true,
                ))
                .await
                .unwrap();
            let interactions: Value = serde_json::from_slice(
                &to_bytes(interactions.into_body(), usize::MAX)
                    .await
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(interactions["interactions"][0]["text"], expected_message);
        }
        assert_eq!(state["capabilities"]["graph"], false);
        assert_eq!(state["capabilities"]["harness"], false);

        fs::remove_dir_all(root).unwrap();
    }

    fn api_request(
        method: &str,
        uri: &str,
        body: Option<Value>,
        authenticated: bool,
    ) -> Request<Body> {
        let mut builder = Request::builder().method(method).uri(uri);
        if authenticated {
            builder = builder.header("cookie", format!("{CONTROL_COOKIE}=control"));
        }
        if body.is_some() {
            builder = builder.header("content-type", "application/json");
        }
        builder
            .body(Body::from(
                body.map(|value| value.to_string()).unwrap_or_default(),
            ))
            .unwrap()
    }
}
