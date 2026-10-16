use super::{ApiState, auth::authorize_read, error::ApiError};
use crate::product::{ProductService, ProjectId, ThreadId};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::HeaderMap,
};
use serde::Deserialize;
use std::path::PathBuf;

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct EnvironmentQuery {
    thread_id: Option<i64>,
}

async fn inspection_target(
    product: &ProductService,
    project_id: ProjectId,
    thread_id: Option<ThreadId>,
) -> Result<(PathBuf, String), ApiError> {
    let project = product.project(project_id).await?;
    let path = if let Some(thread_id) = thread_id {
        let thread = product.get_thread(thread_id).await?.thread;
        // Grouping changes presentation only. A canonical project cannot claim
        // a legacy thread's location through its grouping alias.
        if thread.project_id != Some(project_id) {
            return Err(ApiError::not_found(
                "thread does not belong to this project",
            ));
        }
        thread
            .working_directory
            .ok_or_else(|| ApiError::invalid("thread has no saved working directory"))?
    } else {
        project.path
    };
    Ok((path.into(), project.name))
}

pub(super) async fn get(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(query): Query<EnvironmentQuery>,
) -> Result<Json<crate::environment::EnvironmentSnapshot>, ApiError> {
    authorize_read(&state, &headers)?;
    let project_id = ProjectId::try_from(id)?;
    let (path, name) = inspection_target(
        &state.product,
        project_id,
        query.thread_id.map(ThreadId::try_from).transpose()?,
    )
    .await?;
    Ok(Json(state.environment_inspector.inspect(path, name).await))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::product::{CreateProjectCommand, CreateThreadCommand};
    use crate::storage::SqliteProductStore;
    use std::process::Command;

    fn git(path: &std::path::Path, arguments: &[&str]) {
        let output = Command::new("git")
            .arg("-C")
            .arg(path)
            .args(arguments)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[tokio::test]
    async fn thread_environment_inspects_saved_checkout_and_rejects_foreign_project() {
        let fixture = tempfile::tempdir().unwrap();
        let directory = fixture.path().canonicalize().unwrap();
        let root = directory.join("repository");
        std::fs::create_dir(&root).unwrap();
        git(&root, &["init", "-q", "--initial-branch=main"]);
        git(
            &root,
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "fixture",
            ],
        );
        let linked = directory.join("linked");
        git(
            &root,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "selected-checkout",
                linked.to_str().unwrap(),
            ],
        );
        let product = ProductService::new(
            SqliteProductStore::open(&directory.join("product.sqlite3"))
                .await
                .unwrap(),
            false,
        );
        let project = product
            .create_project(CreateProjectCommand {
                path: root.to_str().unwrap().into(),
                name: None,
                reuse_existing: true,
            })
            .await
            .unwrap()
            .project;
        let thread = product
            .create_thread_in_directory(
                CreateThreadCommand {
                    required_provider_adapter_id: None,
                    icon_selection_eligible: true,
                    title: None,
                    project_id: Some(project.id),
                    initial_message: "Fixture".into(),
                    harness_configuration_name: "codex-basic".into(),
                    personal_presentation_version_key: None,
                    permission_profile_id: "full".into(),
                    model_selection: None,
                    allow_unselected_model: true,
                },
                Some(linked.to_str().unwrap()),
            )
            .await
            .unwrap();
        let (project_path, _) = inspection_target(&product, project.id, None)
            .await
            .unwrap_or_else(|error| panic!("{}", error.message()));
        let (thread_path, _) = inspection_target(&product, project.id, Some(thread.id))
            .await
            .unwrap_or_else(|error| panic!("{}", error.message()));
        assert_eq!(project_path, root);
        assert_eq!(thread_path, linked);
        let snapshot = crate::environment::EnvironmentInspector::new()
            .inspect(thread_path, "Repository".into())
            .await;
        assert_eq!(
            serde_json::to_value(snapshot).unwrap()["branch"],
            "selected-checkout"
        );
        let foreign = directory.join("unrelated");
        std::fs::create_dir(&foreign).unwrap();
        let foreign_project = product
            .create_project(CreateProjectCommand {
                path: foreign.to_str().unwrap().into(),
                name: None,
                reuse_existing: true,
            })
            .await
            .unwrap()
            .project;
        let rejection = inspection_target(&product, foreign_project.id, Some(thread.id)).await;
        assert!(
            matches!(rejection, Err(error) if error.message() == "thread does not belong to this project")
        );
        std::fs::remove_dir_all(&linked).unwrap();
        let (missing_path, _) = inspection_target(&product, project.id, Some(thread.id))
            .await
            .unwrap_or_else(|error| panic!("{}", error.message()));
        assert_eq!(missing_path, linked);
        let missing = crate::environment::EnvironmentInspector::new()
            .inspect(missing_path, "Repository".into())
            .await;
        assert_eq!(
            serde_json::to_value(missing).unwrap()["kind"],
            "unavailable"
        );
    }
}
