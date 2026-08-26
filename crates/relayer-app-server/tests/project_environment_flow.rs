use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, Response, StatusCode},
};
use relayer_app_server::{CONTROL_COOKIE, RelayerAppServer, RelayerAppServerConfig};
use serde_json::{Value, json};
use std::{fs, path::Path, process::Command};
use tower::ServiceExt;

#[tokio::test]
async fn project_environment_is_scoped_to_the_stored_path_and_reports_git_facts() {
    let root = tempfile::tempdir().unwrap();
    let repository = root.path().join("checked-out-project");
    fs::create_dir(&repository).unwrap();
    git(&repository, &["init"]);
    isolate_repository_config(&repository);
    git(&repository, &["config", "user.name", "Relayer Test"]);
    git(
        &repository,
        &["config", "user.email", "relayer@example.invalid"],
    );
    git(&repository, &["branch", "-M", "main"]);
    fs::write(repository.join("tracked.txt"), "first\n").unwrap();
    fs::write(repository.join("binary.bin"), [0, 1, 0, 2]).unwrap();
    fs::write(repository.join("mode-only.sh"), "#!/bin/sh\nexit 0\n").unwrap();
    #[cfg(unix)]
    set_mode(&repository.join("mode-only.sh"), 0o644);
    git(&repository, &["config", "core.filemode", "true"]);
    git(&repository, &["add", "."]);
    git(&repository, &["commit", "-m", "initial"]);

    let app = open_app(&root.path().join("product.sqlite3"), root.path()).await;
    let project = response_json(
        app.clone()
            .oneshot(cookie_request(
                "POST",
                "/api/projects",
                Some(json!({ "path": repository })),
            ))
            .await
            .unwrap(),
    )
    .await;
    let project_id = project["id"].as_i64().unwrap();

    let clean = get_environment(&app, project_id).await;
    assert_eq!(clean["kind"], "git");
    assert_eq!(clean["changes"]["trackedFiles"], 0);
    assert_eq!(clean["changes"]["additions"], 0);
    assert_eq!(clean["changes"]["deletions"], 0);
    assert_eq!(clean["changes"]["untrackedFiles"], 0);

    fs::write(repository.join("tracked.txt"), "first\nsecond\nthird\n").unwrap();
    git(&repository, &["add", "tracked.txt"]);
    expire_environment_cache().await;
    let staged = get_environment(&app, project_id).await;
    assert_eq!(staged["changes"]["trackedFiles"], 1);
    assert_eq!(staged["changes"]["additions"], 2);

    fs::write(
        repository.join("tracked.txt"),
        "first\nsecond\nthird\nfourth\n",
    )
    .unwrap();
    fs::write(
        repository.join("untracked.txt"),
        "not part of line totals\n",
    )
    .unwrap();
    expire_environment_cache().await;
    let response = app
        .clone()
        .oneshot(cookie_request(
            "GET",
            &format!("/api/projects/{project_id}/environment?path=/tmp/not-the-stored-project"),
            None,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let environment = response_json(response).await;
    assert_eq!(environment["kind"], "git");
    assert_eq!(environment["worktreeLabel"], "checked-out-project");
    assert_eq!(environment["branch"], "main");
    assert_eq!(environment["detached"], false);
    assert_eq!(environment["changes"]["trackedFiles"], 1);
    assert_eq!(environment["changes"]["additions"], 3);
    assert_eq!(environment["changes"]["deletions"], 0);
    assert_eq!(environment["changes"]["untrackedFiles"], 1);
    assert!(environment["observedAt"].as_str().unwrap().contains('T'));

    fs::write(repository.join("binary.bin"), [0, 1, 0, 3]).unwrap();
    #[cfg(unix)]
    set_mode(&repository.join("mode-only.sh"), 0o755);
    expire_environment_cache().await;
    let binary_and_mode = get_environment(&app, project_id).await;
    #[cfg(unix)]
    assert_eq!(binary_and_mode["changes"]["trackedFiles"], 3);
    #[cfg(not(unix))]
    assert_eq!(binary_and_mode["changes"]["trackedFiles"], 2);
    assert_eq!(binary_and_mode["changes"]["additions"], 3);

    git(&repository, &["checkout", "--detach"]);
    expire_environment_cache().await;
    let detached = response_json(
        app.oneshot(cookie_request(
            "GET",
            &format!("/api/projects/{project_id}/environment"),
            None,
        ))
        .await
        .unwrap(),
    )
    .await;
    assert_eq!(detached["kind"], "git");
    assert_eq!(detached["branch"], Value::Null);
    assert_eq!(detached["detached"], true);
}

#[tokio::test]
async fn project_environment_returns_safe_folder_unavailable_and_not_found_states() {
    let root = tempfile::tempdir().unwrap();
    let folder = root.path().join("plain-folder");
    let removable = root.path().join("removed-folder");
    let retargeted = root.path().join("retargeted-folder");
    let replacement = root.path().join("replacement-folder");
    fs::create_dir(&folder).unwrap();
    fs::create_dir(&removable).unwrap();
    fs::create_dir(&retargeted).unwrap();
    fs::create_dir(&replacement).unwrap();
    let app = open_app(&root.path().join("product.sqlite3"), root.path()).await;
    let folder_id = create_project(&app, &folder).await;
    let removable_id = create_project(&app, &removable).await;
    let retargeted_id = create_project(&app, &retargeted).await;

    let unauthorized = app
        .clone()
        .oneshot(session_request(
            "GET",
            &format!("/api/projects/{folder_id}/environment"),
            None,
            None,
        ))
        .await
        .unwrap();
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

    let folder_environment = response_json(
        app.clone()
            .oneshot(session_request(
                "GET",
                &format!("/api/projects/{folder_id}/environment"),
                None,
                Some("review"),
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(folder_environment["kind"], "folder");
    assert_eq!(folder_environment["worktreeLabel"], "plain-folder");
    assert_eq!(folder_environment["branch"], Value::Null);
    assert_eq!(folder_environment["changes"]["trackedFiles"], 0);
    assert_eq!(folder_environment["changes"]["additions"], 0);
    assert_eq!(folder_environment["changes"]["deletions"], 0);
    assert_eq!(folder_environment["changes"]["untrackedFiles"], 0);

    fs::remove_dir(&removable).unwrap();
    let unavailable = response_json(
        app.clone()
            .oneshot(cookie_request(
                "GET",
                &format!("/api/projects/{removable_id}/environment"),
                None,
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(unavailable["kind"], "unavailable");
    assert_eq!(unavailable["worktreeLabel"], "removed-folder");
    assert_eq!(unavailable["unavailableReason"]["code"], "path_unavailable");

    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;

        fs::rename(&retargeted, root.path().join("moved-retargeted-folder")).unwrap();
        symlink(&replacement, &retargeted).unwrap();
        let retargeted_environment = get_environment(&app, retargeted_id).await;
        assert_eq!(retargeted_environment["kind"], "unavailable");
        assert_eq!(
            retargeted_environment["unavailableReason"]["code"],
            "path_retargeted"
        );
        assert_eq!(retargeted_environment["worktreeLabel"], "retargeted-folder");
    }

    let not_found = app
        .clone()
        .oneshot(cookie_request(
            "GET",
            "/api/projects/999999/environment",
            None,
        ))
        .await
        .unwrap();
    assert_eq!(not_found.status(), StatusCode::NOT_FOUND);

    let invalid_id = app
        .oneshot(cookie_request("GET", "/api/projects/0/environment", None))
        .await
        .unwrap();
    assert_eq!(invalid_id.status(), StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
#[cfg(all(unix, not(target_os = "macos")))]
async fn project_creation_rejects_a_canonical_path_that_is_not_utf8() {
    use std::{os::unix::ffi::OsStringExt, os::unix::fs::symlink};

    let root = tempfile::tempdir().unwrap();
    let non_utf8 = root
        .path()
        .join(std::ffi::OsString::from_vec(b"project-\xff".to_vec()));
    let selectable_alias = root.path().join("selectable-alias");
    fs::create_dir(&non_utf8).unwrap();
    symlink(&non_utf8, &selectable_alias).unwrap();
    let app = open_app(&root.path().join("product.sqlite3"), root.path()).await;

    let response = app
        .oneshot(cookie_request(
            "POST",
            "/api/projects",
            Some(json!({ "path": selectable_alias })),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let body = response_json(response).await;
    assert_eq!(body["code"], "invalid_input");
    assert_eq!(
        body["error"],
        "project path cannot be represented safely as UTF-8"
    );
}

async fn create_project(app: &Router, path: &Path) -> i64 {
    response_json(
        app.clone()
            .oneshot(cookie_request(
                "POST",
                "/api/projects",
                Some(json!({ "path": path })),
            ))
            .await
            .unwrap(),
    )
    .await["id"]
        .as_i64()
        .unwrap()
}

async fn get_environment(app: &Router, project_id: i64) -> Value {
    response_json(
        app.clone()
            .oneshot(cookie_request(
                "GET",
                &format!("/api/projects/{project_id}/environment"),
                None,
            ))
            .await
            .unwrap(),
    )
    .await
}

async fn expire_environment_cache() {
    tokio::time::sleep(std::time::Duration::from_millis(220)).await;
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;

    let mut permissions = fs::metadata(path).unwrap().permissions();
    permissions.set_mode(mode);
    fs::set_permissions(path, permissions).unwrap();
}

fn git(repository: &Path, arguments: &[&str]) {
    let hooks = repository.join(".git/relayer-test-hooks-disabled");
    let global_config = repository.join(".relayer-test-global-config-disabled");
    let home = repository.join(".relayer-test-home");
    let output = Command::new("git")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", &global_config)
        .env("HOME", &home)
        .env("XDG_CONFIG_HOME", &home)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .env("LC_ALL", "C")
        .arg("-c")
        .arg("commit.gpgSign=false")
        .arg("-c")
        .arg("tag.gpgSign=false")
        .arg("-c")
        .arg(format!("core.hooksPath={}", hooks.display()))
        .arg("-c")
        .arg("core.fsmonitor=false")
        .arg("-C")
        .arg(repository)
        .args(arguments)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {arguments:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn isolate_repository_config(repository: &Path) {
    let excludes = repository.join(".git/relayer-test-global-excludes-disabled");
    let attributes = repository.join(".git/relayer-test-global-attributes-disabled");
    fs::write(&excludes, "").unwrap();
    fs::write(&attributes, "").unwrap();
    git(
        repository,
        &["config", "core.excludesFile", excludes.to_str().unwrap()],
    );
    git(
        repository,
        &[
            "config",
            "core.attributesFile",
            attributes.to_str().unwrap(),
        ],
    );
    git(repository, &["config", "core.autocrlf", "false"]);
    git(repository, &["config", "core.safecrlf", "false"]);
    git(repository, &["config", "core.fsmonitor", "false"]);
    git(repository, &["config", "core.untrackedCache", "false"]);
}

async fn open_app(database: &Path, web_directory: &Path) -> Router {
    RelayerAppServer::open(RelayerAppServerConfig {
        database_path: database.to_owned(),
        web_directory: web_directory.to_owned(),
        permission_catalog: Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../permissions/desktop.json"),
        control_token: "control".to_owned(),
        read_only_control_token: Some("review".to_owned()),
        runtime: None,
        allow_conversation_import: false,
        export_producer: relayer_app_server::conversation_export::ExportProducer {
            desktop_version: "test".into(),
            build_commit: "test".into(),
            platform: "test".into(),
            architecture: "test".into(),
        },
    })
    .await
    .unwrap()
    .router()
}

async fn response_json(response: Response<Body>) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap()
}

fn cookie_request(method: &str, uri: &str, body: Option<Value>) -> Request<Body> {
    session_request(method, uri, body, Some("control"))
}

fn session_request(
    method: &str,
    uri: &str,
    body: Option<Value>,
    token: Option<&str>,
) -> Request<Body> {
    let body = body
        .map(|value| Body::from(serde_json::to_vec(&value).unwrap()))
        .unwrap_or_else(Body::empty);
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json");
    if let Some(token) = token {
        request = request.header("cookie", format!("{CONTROL_COOKIE}={token}"));
    }
    request.body(body).unwrap()
}
