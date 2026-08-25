use command_group::{CommandGroup, GroupChild};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    ffi::{OsStr, OsString},
    io::{self, Read},
    path::{Path, PathBuf},
    process::{Command, ExitStatus, Stdio},
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant, SystemTime},
};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard, OwnedSemaphorePermit, Semaphore};

#[cfg(not(unix))]
use std::{fs::File, io::Seek};

const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(2);
const CACHE_TTL: Duration = Duration::from_millis(200);
const CAPACITY_WAIT: Duration = Duration::from_millis(100);
const MAX_CONCURRENT_INSPECTIONS: usize = 4;
#[cfg(not(test))]
const MAX_ACTIVE_COMMANDS: usize = MAX_CONCURRENT_INSPECTIONS;
// Unit tests intentionally exercise several independent command-runner edge cases in
// parallel. Giving the test process its own wider slot pool prevents unrelated fixtures
// from observing production backpressure while leaving the shipped bound unchanged.
#[cfg(test)]
const MAX_ACTIVE_COMMANDS: usize = 32;
const MAX_PENDING_INSPECTIONS: usize = 32;
const MAX_STDOUT_BYTES: usize = 256 * 1024;
const MAX_STDERR_BYTES: usize = 32 * 1024;
const MAX_INDEX_BYTES: u64 = 64 * 1024 * 1024;
// Leave ample room below Windows' 32K command-line limit for the executable and
// fixed arguments. Repository and pathname arguments are charged at twice their
// encoded length below to cover Windows quoting expansion conservatively.
const MAX_CHECK_ATTR_COMMAND_ARGUMENT_BYTES: usize = 28 * 1024;
const CHECK_ATTR_FIXED_ARGUMENT_BYTES: usize = 1024;
const MAX_CHECK_ATTR_PATH_ARGUMENTS: usize = 128;
static ACTIVE_COMMANDS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
static STUCK_CLEANUPS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnvironmentSnapshot {
    kind: EnvironmentKind,
    worktree_label: String,
    branch: Option<String>,
    detached: bool,
    changes: EnvironmentChanges,
    observed_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    unavailable_reason: Option<UnavailableReason>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum EnvironmentKind {
    Git,
    Folder,
    Unavailable,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct EnvironmentChanges {
    tracked_files: u64,
    additions: u64,
    deletions: u64,
    untracked_files: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct UnavailableReason {
    code: &'static str,
    message: String,
}

#[derive(Clone)]
pub(crate) struct EnvironmentInspector {
    inner: Arc<EnvironmentInspectorInner>,
}

struct EnvironmentInspectorInner {
    pending: Arc<Semaphore>,
    capacity: Arc<Semaphore>,
    key_locks: Mutex<HashMap<PathBuf, Weak<AsyncMutex<()>>>>,
    cache: Mutex<HashMap<PathBuf, CachedSnapshot>>,
    inspect: Arc<InspectionFunction>,
    validate: Arc<ValidationFunction>,
    snapshot_timeout: Duration,
}

struct CachedSnapshot {
    observed: Instant,
    snapshot: EnvironmentSnapshot,
}

type InspectionFunction = dyn Fn(PathBuf, String, Instant) -> EnvironmentSnapshot + Send + Sync;
type ValidationFunction = dyn Fn(&Path, &str) -> Result<(), Box<EnvironmentSnapshot>> + Send + Sync;

impl EnvironmentInspector {
    pub(crate) fn new() -> Self {
        Self::with_functions(
            MAX_CONCURRENT_INSPECTIONS,
            MAX_PENDING_INSPECTIONS,
            SNAPSHOT_TIMEOUT,
            validate_stored_path,
            |path, label, deadline| inspect_with(&path, &label, &SystemGitRunner, deadline),
        )
    }

    #[cfg(test)]
    fn with_inspector(
        maximum_concurrency: usize,
        inspect: impl Fn(PathBuf, String, Instant) -> EnvironmentSnapshot + Send + Sync + 'static,
    ) -> Self {
        Self::with_functions(
            maximum_concurrency,
            MAX_PENDING_INSPECTIONS,
            SNAPSHOT_TIMEOUT,
            validate_stored_path,
            inspect,
        )
    }

    fn with_functions(
        maximum_concurrency: usize,
        maximum_pending: usize,
        snapshot_timeout: Duration,
        validate: impl Fn(&Path, &str) -> Result<(), Box<EnvironmentSnapshot>> + Send + Sync + 'static,
        inspect: impl Fn(PathBuf, String, Instant) -> EnvironmentSnapshot + Send + Sync + 'static,
    ) -> Self {
        Self {
            inner: Arc::new(EnvironmentInspectorInner {
                pending: Arc::new(Semaphore::new(maximum_pending)),
                capacity: Arc::new(Semaphore::new(maximum_concurrency)),
                key_locks: Mutex::new(HashMap::new()),
                cache: Mutex::new(HashMap::new()),
                inspect: Arc::new(inspect),
                validate: Arc::new(validate),
                snapshot_timeout,
            }),
        }
    }

    pub(crate) async fn inspect(&self, path: PathBuf, project_name: String) -> EnvironmentSnapshot {
        let deadline = Instant::now() + self.inner.snapshot_timeout;
        let pending_permit =
            match acquire_before(self.inner.pending.clone(), deadline, Some(CAPACITY_WAIT)).await {
                Some(permit) => permit,
                None if Instant::now() >= deadline => {
                    return inspection_timeout(project_name);
                }
                None => return inspection_capacity(project_name),
            };
        let key_lock = {
            let mut locks = self.inner.key_locks.lock().expect("environment key locks");
            locks.retain(|_, lock| lock.strong_count() > 0);
            if let Some(lock) = locks.get(&path).and_then(Weak::upgrade) {
                lock
            } else {
                let lock = Arc::new(AsyncMutex::new(()));
                locks.insert(path.clone(), Arc::downgrade(&lock));
                lock
            }
        };
        let key_guard = match lock_before(key_lock, deadline).await {
            Some(guard) => guard,
            None => return inspection_timeout(project_name),
        };
        let validation_path = path.clone();
        let validation_label = project_name.clone();
        let validate = self.inner.validate.clone();
        let validation = tokio::task::spawn_blocking(move || {
            let result = validate(&validation_path, &validation_label);
            (result, pending_permit, key_guard)
        });
        let (validation_result, pending_permit, key_guard) =
            match join_before(validation, deadline).await {
                Some(Ok(value)) => value,
                Some(Err(_)) => {
                    return EnvironmentSnapshot::unavailable(
                        project_name,
                        "inspection_failed",
                        "Environment inspection could not finish.".into(),
                    );
                }
                None => return inspection_timeout(project_name),
            };
        if let Err(snapshot) = validation_result {
            return *snapshot;
        }
        if let Some(snapshot) = self.cached(&path) {
            return snapshot;
        }
        let permit = match acquire_before(
            self.inner.capacity.clone(),
            deadline,
            Some(CAPACITY_WAIT),
        )
        .await
        {
            Some(permit) => permit,
            None => {
                if Instant::now() >= deadline {
                    return inspection_timeout(project_name);
                }
                return inspection_capacity(project_name);
            }
        };
        let inspect = self.inner.inspect.clone();
        let fallback_label = project_name.clone();
        let inspect_path = path.clone();
        let inspection = tokio::task::spawn_blocking(move || {
            let snapshot = inspect(inspect_path, project_name, deadline);
            (snapshot, pending_permit, permit, key_guard)
        });
        let snapshot = match join_before(inspection, deadline).await {
            Some(Ok((snapshot, _, _, _))) => snapshot,
            Some(Err(_)) => {
                return EnvironmentSnapshot::unavailable(
                    fallback_label,
                    "inspection_failed",
                    "Environment inspection could not finish.".into(),
                );
            }
            None => return inspection_timeout(fallback_label),
        };
        self.inner.cache.lock().expect("environment cache").insert(
            path,
            CachedSnapshot {
                observed: Instant::now(),
                snapshot: snapshot.clone(),
            },
        );
        snapshot
    }

    fn cached(&self, path: &Path) -> Option<EnvironmentSnapshot> {
        let mut cache = self.inner.cache.lock().expect("environment cache");
        cache.retain(|_, entry| entry.observed.elapsed() <= CACHE_TTL);
        cache.get(path).map(|entry| entry.snapshot.clone())
    }
}

async fn acquire_before(
    semaphore: Arc<Semaphore>,
    deadline: Instant,
    maximum_wait: Option<Duration>,
) -> Option<OwnedSemaphorePermit> {
    let remaining = deadline.checked_duration_since(Instant::now())?;
    let wait = maximum_wait.map_or(remaining, |maximum| maximum.min(remaining));
    tokio::time::timeout(wait, semaphore.acquire_owned())
        .await
        .ok()?
        .ok()
}

async fn lock_before(lock: Arc<AsyncMutex<()>>, deadline: Instant) -> Option<OwnedMutexGuard<()>> {
    let remaining = deadline.checked_duration_since(Instant::now())?;
    tokio::time::timeout(remaining, lock.lock_owned())
        .await
        .ok()
}

async fn join_before<T: Send + 'static>(
    task: tokio::task::JoinHandle<T>,
    deadline: Instant,
) -> Option<Result<T, tokio::task::JoinError>> {
    let remaining = deadline.checked_duration_since(Instant::now())?;
    tokio::time::timeout(remaining, task).await.ok()
}

fn inspection_capacity(label: String) -> EnvironmentSnapshot {
    EnvironmentSnapshot::unavailable(
        label,
        "inspection_capacity",
        "Project context inspection is busy. Try again shortly.".into(),
    )
}

fn inspection_timeout(label: String) -> EnvironmentSnapshot {
    EnvironmentSnapshot::unavailable(
        label,
        "git_timeout",
        "Project context inspection exceeded its time limit.".into(),
    )
}

trait GitRunner {
    fn protected_safe_directories(
        &self,
        _path: &Path,
        _deadline: Instant,
    ) -> Result<Vec<OsString>, GitRunError> {
        Ok(Vec::new())
    }

    fn effective_repository_config(
        &self,
        _repository: &Path,
        _safe_directories: &[OsString],
        _deadline: Instant,
    ) -> Result<Vec<(OsString, OsString)>, GitRunError> {
        Ok(Vec::new())
    }

    fn validate_repository_selection(
        &self,
        _selected_path: &Path,
        reported_root: &Path,
        _safety: &GitSafetyOverrides,
        _deadline: Instant,
    ) -> Result<PathBuf, GitRunError> {
        Ok(reported_root.to_owned())
    }

    fn has_applied_transform_filter(
        &self,
        _repository: &Path,
        _safety: &GitSafetyOverrides,
        _deadline: Instant,
    ) -> Result<bool, GitRunError> {
        Ok(false)
    }

    fn has_initialized_gitlink(
        &self,
        _repository: &Path,
        _safety: &GitSafetyOverrides,
        _deadline: Instant,
    ) -> Result<bool, GitRunError> {
        Ok(false)
    }

    fn repository_state_token(
        &self,
        _repository: &Path,
        _safety: &GitSafetyOverrides,
        _deadline: Instant,
    ) -> Result<Vec<u8>, GitRunError> {
        Ok(Vec::new())
    }

    fn diff_outputs(
        &self,
        repository: &Path,
        baseline: &str,
        safety: &GitSafetyOverrides,
        deadline: Instant,
    ) -> Result<(GitOutput, GitOutput), GitRunError>
    where
        Self: Sized,
    {
        let staged = run_git(
            self,
            repository,
            &[
                "diff",
                "--numstat",
                "-z",
                "--no-ext-diff",
                "--no-textconv",
                "--ignore-submodules=none",
                "--cached",
                baseline,
                "--",
            ],
            safety,
            deadline,
        )?;
        let worktree = run_git(
            self,
            repository,
            &[
                "diff",
                "--numstat",
                "-z",
                "--no-ext-diff",
                "--no-textconv",
                "--ignore-submodules=none",
                "--",
            ],
            safety,
            deadline,
        )?;
        Ok((staged, worktree))
    }

    fn run(
        &self,
        path: &Path,
        arguments: &[&str],
        safety: &GitSafetyOverrides,
        timeout: Duration,
    ) -> Result<GitOutput, GitRunError>;
}

#[derive(Clone, Default)]
struct GitSafetyOverrides {
    safe_directories: Vec<OsString>,
    effective_config: Vec<(OsString, OsString)>,
    disabled_filter_drivers: Vec<OsString>,
}

struct SystemGitRunner;

impl GitRunner for SystemGitRunner {
    fn protected_safe_directories(
        &self,
        path: &Path,
        deadline: Instant,
    ) -> Result<Vec<OsString>, GitRunError> {
        read_protected_safe_directories(path, deadline)
    }

    fn effective_repository_config(
        &self,
        repository: &Path,
        safe_directories: &[OsString],
        deadline: Instant,
    ) -> Result<Vec<(OsString, OsString)>, GitRunError> {
        read_effective_repository_config(repository, safe_directories, deadline)
    }

    fn validate_repository_selection(
        &self,
        selected_path: &Path,
        reported_root: &Path,
        safety: &GitSafetyOverrides,
        deadline: Instant,
    ) -> Result<PathBuf, GitRunError> {
        validate_repository_identity(selected_path, reported_root, safety, deadline)
    }

    fn run(
        &self,
        path: &Path,
        arguments: &[&str],
        safety: &GitSafetyOverrides,
        timeout: Duration,
    ) -> Result<GitOutput, GitRunError> {
        run_bounded_command_with_safety(OsStr::new("git"), path, arguments, safety, timeout, |_| {})
    }

    fn has_applied_transform_filter(
        &self,
        repository: &Path,
        safety: &GitSafetyOverrides,
        deadline: Instant,
    ) -> Result<bool, GitRunError> {
        has_applied_transform_filter(repository, safety, deadline)
    }

    fn has_initialized_gitlink(
        &self,
        repository: &Path,
        safety: &GitSafetyOverrides,
        deadline: Instant,
    ) -> Result<bool, GitRunError> {
        has_initialized_gitlink(repository, safety, deadline)
    }

    fn repository_state_token(
        &self,
        repository: &Path,
        safety: &GitSafetyOverrides,
        deadline: Instant,
    ) -> Result<Vec<u8>, GitRunError> {
        repository_state_token(repository, safety, deadline)
    }

    fn diff_outputs(
        &self,
        repository: &Path,
        baseline: &str,
        safety: &GitSafetyOverrides,
        deadline: Instant,
    ) -> Result<(GitOutput, GitOutput), GitRunError> {
        run_shadow_diffs(repository, baseline, safety, deadline)
    }
}

#[derive(Debug)]
struct GitOutput {
    status: GitExit,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

#[derive(Debug)]
struct GitExit {
    success: bool,
    code: Option<i32>,
}

impl From<ExitStatus> for GitExit {
    fn from(status: ExitStatus) -> Self {
        Self {
            success: status.success(),
            code: status.code(),
        }
    }
}

#[derive(Debug, thiserror::Error)]
enum GitRunError {
    #[error("Git is not installed or could not be started: {0}")]
    Start(#[source] io::Error),
    #[error("Git inspection exceeded its {0:?} timeout")]
    Timeout(Duration),
    #[error("Git inspection produced more output than Relayer will accept")]
    OutputTooLarge,
    #[error("Git inspection failed while reading process output: {0}")]
    Output(#[source] io::Error),
    #[error("Git inspection cleanup capacity is busy ({stuck} stuck cleanups)")]
    CleanupBusy { stuck: usize },
    #[error("Exact Git change counts are unavailable because a content filter applies")]
    UnsupportedFilter,
    #[error("Exact Git change counts are unavailable for initialized submodules")]
    UnsupportedSubmodule,
}

fn inspect_with(
    path: &Path,
    project_name: &str,
    git: &impl GitRunner,
    deadline: Instant,
) -> EnvironmentSnapshot {
    if let Err(snapshot) = validate_stored_path(path, project_name) {
        return *snapshot;
    }
    let fallback_label = folder_label(path, project_name);
    let mut safety = match git.protected_safe_directories(path, deadline) {
        Ok(safe_directories) => GitSafetyOverrides {
            safe_directories,
            effective_config: Vec::new(),
            disabled_filter_drivers: Vec::new(),
        },
        Err(error) => return unavailable_from_error(fallback_label, error),
    };
    let repository = match run_git(
        git,
        path,
        &["rev-parse", "--path-format=absolute", "--show-toplevel"],
        &safety,
        deadline,
    ) {
        Ok(output) if output.status.success => match repository_path(&output.stdout) {
            Some(repository) => repository,
            None => {
                return EnvironmentSnapshot::unavailable(
                    fallback_label,
                    "git_output_invalid",
                    "Git returned an invalid repository root.".into(),
                );
            }
        },
        Ok(output) if is_not_repository(&output) => {
            return EnvironmentSnapshot::folder(fallback_label);
        }
        Ok(output) => {
            return EnvironmentSnapshot::unavailable(
                fallback_label,
                "git_failed",
                git_failure_message(&output),
            );
        }
        Err(error) => return unavailable_from_error(fallback_label, error),
    };
    let repository = match git.validate_repository_selection(path, &repository, &safety, deadline) {
        Ok(repository) => repository,
        Err(error) => return unavailable_from_error(fallback_label, error),
    };
    let worktree_label = folder_label(&repository, project_name);
    safety.effective_config =
        match git.effective_repository_config(&repository, &safety.safe_directories, deadline) {
            Ok(config) => config,
            Err(error) => return unavailable_from_error(worktree_label, error),
        };
    match git.has_applied_transform_filter(&repository, &safety, deadline) {
        Ok(true) => {
            return unavailable_from_error(worktree_label, GitRunError::UnsupportedFilter);
        }
        Ok(false) => {}
        Err(error) => return unavailable_from_error(worktree_label, error),
    }
    if !ignores_all_submodules(&safety) {
        match git.has_initialized_gitlink(&repository, &safety, deadline) {
            Ok(true) => {
                return unavailable_from_error(worktree_label, GitRunError::UnsupportedSubmodule);
            }
            Ok(false) => {}
            Err(error) => return unavailable_from_error(worktree_label, error),
        }
    }

    let branch_output = match run_git(
        git,
        &repository,
        &["symbolic-ref", "--quiet", "--short", "HEAD"],
        &safety,
        deadline,
    ) {
        Ok(output) => output,
        Err(error) => return unavailable_from_error(worktree_label, error),
    };
    let (branch, detached) = if branch_output.status.success {
        (Some(trimmed(&branch_output.stdout)), false)
    } else if branch_output.status.code == Some(1) {
        (None, true)
    } else {
        return EnvironmentSnapshot::unavailable(
            worktree_label,
            "git_failed",
            git_failure_message(&branch_output),
        );
    };

    let head_output = match run_git(
        git,
        &repository,
        &["rev-parse", "--verify", "HEAD"],
        &safety,
        deadline,
    ) {
        Ok(output) => output,
        Err(error) => return unavailable_from_error(worktree_label, error),
    };
    let baseline = if head_output.status.success {
        trimmed(&head_output.stdout)
    } else {
        let empty_tree = match run_git(
            git,
            &repository,
            &["hash-object", "-t", "tree", "--stdin"],
            &safety,
            deadline,
        ) {
            Ok(output) if output.status.success => output,
            Ok(output) => {
                return EnvironmentSnapshot::unavailable(
                    worktree_label,
                    "git_failed",
                    git_failure_message(&output),
                );
            }
            Err(error) => return unavailable_from_error(worktree_label, error),
        };
        trimmed(&empty_tree.stdout)
    };

    let state_token = match git.repository_state_token(&repository, &safety, deadline) {
        Ok(token) => token,
        Err(error) => return unavailable_from_error(worktree_label, error),
    };
    let (staged_output, worktree_output) =
        match git.diff_outputs(&repository, &baseline, &safety, deadline) {
            Ok((staged, worktree)) if staged.status.success && worktree.status.success => {
                (staged, worktree)
            }
            Ok((staged, worktree)) => {
                let failed = if !staged.status.success {
                    staged
                } else {
                    worktree
                };
                return EnvironmentSnapshot::unavailable(
                    worktree_label,
                    "git_failed",
                    git_failure_message(&failed),
                );
            }
            Err(error) => return unavailable_from_error(worktree_label, error),
        };
    let post_state_token = match git.repository_state_token(&repository, &safety, deadline) {
        Ok(token) => token,
        Err(error) => return unavailable_from_error(worktree_label, error),
    };
    if post_state_token != state_token {
        return EnvironmentSnapshot::unavailable(
            worktree_label,
            "git_snapshot_changed",
            "Git index changed during environment inspection.".into(),
        );
    }
    let post_config =
        match git.effective_repository_config(&repository, &safety.safe_directories, deadline) {
            Ok(config) => config,
            Err(error) => return unavailable_from_error(worktree_label, error),
        };
    if post_config != safety.effective_config {
        return EnvironmentSnapshot::unavailable(
            worktree_label,
            "git_snapshot_changed",
            "Git configuration changed during environment inspection.".into(),
        );
    }
    match git.has_applied_transform_filter(&repository, &safety, deadline) {
        Ok(true) => {
            return unavailable_from_error(worktree_label, GitRunError::UnsupportedFilter);
        }
        Ok(false) => {}
        Err(error) => return unavailable_from_error(worktree_label, error),
    }
    let changes = match parse_numstat_changes(&[&staged_output.stdout, &worktree_output.stdout]) {
        Some(changes) => changes,
        None => {
            return EnvironmentSnapshot::unavailable(
                worktree_label,
                "git_output_invalid",
                "Git returned an unrecognized change summary.".into(),
            );
        }
    };

    let untracked_output = match run_git(
        git,
        &repository,
        &["ls-files", "--others", "--exclude-standard", "-z"],
        &safety,
        deadline,
    ) {
        Ok(output) if output.status.success => output,
        Ok(output) => {
            return EnvironmentSnapshot::unavailable(
                worktree_label,
                "git_failed",
                git_failure_message(&output),
            );
        }
        Err(error) => return unavailable_from_error(worktree_label, error),
    };
    let untracked_files = untracked_output
        .stdout
        .iter()
        .filter(|byte| **byte == 0)
        .count() as u64;

    EnvironmentSnapshot {
        kind: EnvironmentKind::Git,
        worktree_label,
        branch,
        detached,
        changes: EnvironmentChanges {
            tracked_files: changes.tracked_files,
            additions: changes.additions,
            deletions: changes.deletions,
            untracked_files,
        },
        observed_at: observed_at(),
        unavailable_reason: None,
    }
}

impl EnvironmentSnapshot {
    fn folder(worktree_label: String) -> Self {
        Self {
            kind: EnvironmentKind::Folder,
            worktree_label,
            branch: None,
            detached: false,
            changes: EnvironmentChanges::default(),
            observed_at: observed_at(),
            unavailable_reason: None,
        }
    }

    fn unavailable(worktree_label: String, code: &'static str, message: String) -> Self {
        Self {
            kind: EnvironmentKind::Unavailable,
            worktree_label,
            branch: None,
            detached: false,
            changes: EnvironmentChanges::default(),
            observed_at: observed_at(),
            unavailable_reason: Some(UnavailableReason { code, message }),
        }
    }
}

fn unavailable_from_error(label: String, error: GitRunError) -> EnvironmentSnapshot {
    let code = match error {
        GitRunError::Start(_) => "git_unavailable",
        GitRunError::Timeout(_) => "git_timeout",
        GitRunError::OutputTooLarge => "git_output_too_large",
        GitRunError::Output(_) => "git_output_failed",
        GitRunError::CleanupBusy { .. } => "inspection_capacity",
        GitRunError::UnsupportedFilter => "unsupported_filter",
        GitRunError::UnsupportedSubmodule => "unsupported_submodule",
    };
    EnvironmentSnapshot::unavailable(label, code, error.to_string())
}

fn validate_stored_path(path: &Path, project_name: &str) -> Result<(), Box<EnvironmentSnapshot>> {
    let unavailable = || {
        Box::new(EnvironmentSnapshot::unavailable(
            project_name.to_owned(),
            "path_unavailable",
            "The project folder is missing or is not a directory.".into(),
        ))
    };
    let metadata = std::fs::symlink_metadata(path).map_err(|_| unavailable())?;
    if metadata.file_type().is_symlink() {
        return Err(Box::new(EnvironmentSnapshot::unavailable(
            project_name.to_owned(),
            "path_retargeted",
            "The project folder no longer resolves to its stored location.".into(),
        )));
    }
    if !metadata.is_dir() {
        return Err(unavailable());
    }
    let resolved = std::fs::canonicalize(path).map_err(|_| unavailable())?;
    if resolved != path {
        return Err(Box::new(EnvironmentSnapshot::unavailable(
            project_name.to_owned(),
            "path_retargeted",
            "The project folder no longer resolves to its stored location.".into(),
        )));
    }
    Ok(())
}

fn run_git(
    git: &impl GitRunner,
    path: &Path,
    arguments: &[&str],
    safety: &GitSafetyOverrides,
    deadline: Instant,
) -> Result<GitOutput, GitRunError> {
    let remaining = deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .ok_or(GitRunError::Timeout(SNAPSHOT_TIMEOUT))?;
    git.run(path, arguments, safety, remaining)
}

fn folder_label(path: &Path, fallback: &str) -> String {
    path.file_name()
        .filter(|name| !name.is_empty())
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| fallback.to_owned())
}

fn trimmed(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).trim().to_owned()
}

fn repository_path(bytes: &[u8]) -> Option<PathBuf> {
    let bytes = bytes.strip_suffix(b"\n").unwrap_or(bytes);
    if bytes.is_empty() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStringExt;
        Some(PathBuf::from(OsString::from_vec(bytes.to_vec())))
    }
    #[cfg(not(unix))]
    {
        String::from_utf8(bytes.to_vec()).ok().map(PathBuf::from)
    }
}

fn is_not_repository(output: &GitOutput) -> bool {
    !output.status.success
        && String::from_utf8_lossy(&output.stderr).contains("not a git repository")
}

fn git_failure_message(output: &GitOutput) -> String {
    match output.status.code {
        Some(code) => format!("Git inspection failed with exit status {code}."),
        None => "Git inspection was terminated before it returned a status.".into(),
    }
}

fn parse_numstat_changes(outputs: &[&[u8]]) -> Option<EnvironmentChanges> {
    let mut paths = HashSet::new();
    let mut additions = 0_u64;
    let mut deletions = 0_u64;
    for output in outputs {
        if output.is_empty() {
            continue;
        }
        if !output.ends_with(&[0]) {
            return None;
        }
        let mut records = output[..output.len() - 1].split(|byte| *byte == 0);
        while let Some(record) = records.next() {
            let mut fields = record.splitn(3, |byte| *byte == b'\t');
            let inserted = parse_numstat_count(fields.next()?)?;
            let deleted = parse_numstat_count(fields.next()?)?;
            let inline_path = fields.next()?;
            let path = if inline_path.is_empty() {
                // With -z, rename/copy records put the old and new paths in the next two
                // NUL-delimited fields. The destination is the changed path represented by
                // this record; consuming both also keeps the parser synchronized.
                let old_path = records.next()?;
                let new_path = records.next()?;
                if old_path.is_empty() || new_path.is_empty() {
                    return None;
                }
                new_path
            } else {
                inline_path
            };
            if path.is_empty() {
                return None;
            }
            additions = additions.checked_add(inserted)?;
            deletions = deletions.checked_add(deleted)?;
            paths.insert(path.to_vec());
        }
    }
    Some(EnvironmentChanges {
        tracked_files: paths.len().try_into().ok()?,
        additions,
        deletions,
        untracked_files: 0,
    })
}

fn parse_numstat_count(field: &[u8]) -> Option<u64> {
    if field == b"-" {
        // Git uses '-' for binary changes. They still count as a changed tracked file, but
        // do not have a meaningful line count.
        return Some(0);
    }
    std::str::from_utf8(field).ok()?.parse().ok()
}

fn observed_at() -> String {
    time::OffsetDateTime::from(SystemTime::now())
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".into())
}

#[cfg(test)]
fn run_bounded_command(
    executable: &OsStr,
    path: &Path,
    arguments: &[&str],
    timeout: Duration,
) -> Result<GitOutput, GitRunError> {
    run_bounded_command_with(executable, path, arguments, timeout, |_| {})
}

#[cfg(test)]
fn run_bounded_command_with(
    executable: &OsStr,
    path: &Path,
    arguments: &[&str],
    timeout: Duration,
    configure: impl FnOnce(&mut Command),
) -> Result<GitOutput, GitRunError> {
    run_bounded_command_with_safety(
        executable,
        path,
        arguments,
        &GitSafetyOverrides::default(),
        timeout,
        configure,
    )
}

fn run_bounded_command_with_safety(
    executable: &OsStr,
    path: &Path,
    arguments: &[&str],
    safety: &GitSafetyOverrides,
    timeout: Duration,
    configure: impl FnOnce(&mut Command),
) -> Result<GitOutput, GitRunError> {
    let mut command = Command::new(executable);
    configure(&mut command);
    sanitize_git_environment(&mut command);
    isolate_git_configuration(&mut command);
    command.env("GIT_OPTIONAL_LOCKS", "0").env("LC_ALL", "C");
    for directory in &safety.safe_directories {
        let mut setting = OsString::from("safe.directory=");
        setting.push(directory);
        command.arg("-c").arg(setting);
    }
    for (key, value) in &safety.effective_config {
        let mut setting = key.clone();
        setting.push("=");
        setting.push(value);
        command.arg("-c").arg(setting);
    }
    for driver in &safety.disabled_filter_drivers {
        for (suffix, value) in [(".clean=", ""), (".process=", ""), (".required=", "false")] {
            let mut setting = driver.clone();
            setting.push(suffix);
            setting.push(value);
            command.arg("-c").arg(setting);
        }
    }
    command
        .arg("-c")
        .arg("core.fsmonitor=false")
        .arg("-c")
        .arg("core.untrackedCache=false")
        .arg("-C")
        .arg(path)
        .args(arguments)
        .stdin(Stdio::null());
    run_prepared_command(command, timeout)
}

fn read_protected_safe_directories(
    path: &Path,
    deadline: Instant,
) -> Result<Vec<OsString>, GitRunError> {
    read_protected_safe_directories_with(path, deadline, |_| {})
}

fn read_protected_safe_directories_with(
    path: &Path,
    deadline: Instant,
    mut configure: impl FnMut(&mut Command),
) -> Result<Vec<OsString>, GitRunError> {
    let mut directories = Vec::new();
    for scope in ["--system", "--global"] {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .filter(|remaining| !remaining.is_zero())
            .ok_or(GitRunError::Timeout(SNAPSHOT_TIMEOUT))?;
        let mut command = Command::new("git");
        configure(&mut command);
        sanitize_git_environment(&mut command);
        command
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("LC_ALL", "C")
            .current_dir(path)
            .args([
                "config",
                scope,
                "--includes",
                "--null",
                "--get-all",
                "safe.directory",
            ])
            .stdin(Stdio::null());
        let output = run_prepared_command(command, remaining)?;
        if !output.status.success {
            if output.status.code == Some(1) && output.stdout.is_empty() {
                continue;
            }
            return Err(GitRunError::Output(io::Error::other(
                "Git could not read protected safe.directory configuration",
            )));
        }
        if !output.stdout.is_empty() && !output.stdout.ends_with(&[0]) {
            return Err(GitRunError::Output(io::Error::other(
                "Git returned malformed protected safe.directory configuration",
            )));
        }
        if !output.stdout.is_empty() {
            for value in output.stdout[..output.stdout.len() - 1].split(|byte| *byte == 0) {
                directories.push(os_string_from_bytes(value)?);
            }
        }
        let total_bytes = directories
            .iter()
            .try_fold(0_usize, |total, value| {
                total.checked_add(value.as_os_str().as_encoded_bytes().len())
            })
            .ok_or(GitRunError::OutputTooLarge)?;
        if total_bytes > MAX_STDOUT_BYTES {
            return Err(GitRunError::OutputTooLarge);
        }
    }
    Ok(directories)
}

#[cfg(test)]
fn read_protected_excludes_file_with(
    path: &Path,
    deadline: Instant,
    mut configure: impl FnMut(&mut Command),
) -> Result<Option<OsString>, GitRunError> {
    read_protected_excludes_file_with_configurers(
        path,
        deadline,
        |command| configure(command),
        |_| {},
    )
}

#[cfg(test)]
fn read_protected_excludes_file_with_configurers(
    path: &Path,
    deadline: Instant,
    mut configure_before_sanitization: impl FnMut(&mut Command),
    mut configure_trusted_scope: impl FnMut(&mut Command),
) -> Result<Option<OsString>, GitRunError> {
    let mut effective = None;
    for scope in ["--system", "--global"] {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .filter(|remaining| !remaining.is_zero())
            .ok_or(GitRunError::Timeout(SNAPSHOT_TIMEOUT))?;
        let mut command = Command::new("git");
        configure_before_sanitization(&mut command);
        sanitize_git_environment(&mut command);
        configure_trusted_scope(&mut command);
        command
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("LC_ALL", "C")
            .current_dir(path)
            .args([
                "config",
                scope,
                "--includes",
                "--path",
                "--null",
                "--get-all",
                "core.excludesFile",
            ])
            .stdin(Stdio::null());
        let output = run_prepared_command(command, remaining)?;
        if !output.status.success {
            if output.status.code == Some(1) && output.stdout.is_empty() {
                continue;
            }
            return Err(GitRunError::Output(io::Error::other(
                "Git could not read protected core.excludesFile configuration",
            )));
        }
        if output.stdout.is_empty() || !output.stdout.ends_with(&[0]) {
            return Err(GitRunError::Output(io::Error::other(
                "Git returned malformed protected core.excludesFile configuration",
            )));
        }
        let value = output.stdout[..output.stdout.len() - 1]
            .split(|byte| *byte == 0)
            .next_back()
            .ok_or_else(|| {
                GitRunError::Output(io::Error::other(
                    "Git returned malformed protected core.excludesFile configuration",
                ))
            })?;
        effective = Some(os_string_from_bytes(value)?);
    }
    // An explicit empty value is not equivalent to absence: Git uses it to disable the
    // default XDG excludes file. Preserve it so command-scope replay keeps that reset.
    Ok(effective)
}

fn read_effective_repository_config(
    repository: &Path,
    safe_directories: &[OsString],
    deadline: Instant,
) -> Result<Vec<(OsString, OsString)>, GitRunError> {
    read_effective_repository_config_with(repository, safe_directories, deadline, |_| {})
}

fn read_effective_repository_config_with(
    repository: &Path,
    safe_directories: &[OsString],
    deadline: Instant,
    mut configure: impl FnMut(&mut Command),
) -> Result<Vec<(OsString, OsString)>, GitRunError> {
    // Only replay fixed, data-only keys whose absence would change Git's view of the
    // worktree. Reading their effective value in repository context preserves normal
    // system/global/local/worktree precedence without exposing the later inspection
    // commands to unrelated (and potentially executable) configuration.
    let keys = [
        ("core.autocrlf", false),
        ("core.eol", false),
        ("core.excludesFile", true),
        ("core.attributesFile", true),
        ("core.fileMode", false),
        ("core.symlinks", false),
        ("core.ignoreCase", false),
        ("core.precomposeUnicode", false),
        ("core.sparseCheckout", false),
        ("core.sparseCheckoutCone", false),
        ("index.sparse", false),
        ("diff.ignoreSubmodules", false),
    ];
    let mut effective = Vec::new();
    for (key, expand_path) in keys {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .filter(|remaining| !remaining.is_zero())
            .ok_or(GitRunError::Timeout(SNAPSHOT_TIMEOUT))?;
        let mut command = Command::new("git");
        configure(&mut command);
        sanitize_git_environment(&mut command);
        for directory in safe_directories {
            let mut setting = OsString::from("safe.directory=");
            setting.push(directory);
            command.arg("-c").arg(setting);
        }
        command
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("LC_ALL", "C")
            .arg("-C")
            .arg(repository)
            .args(["config", "--includes"]);
        if expand_path {
            command.arg("--path");
        }
        if matches!(
            key,
            "core.autocrlf"
                | "core.fileMode"
                | "core.symlinks"
                | "core.ignoreCase"
                | "core.precomposeUnicode"
                | "core.sparseCheckout"
                | "core.sparseCheckoutCone"
                | "index.sparse"
        ) {
            // Normalize every boolean spelling (including implicit true and explicit
            // empty false) independently while retaining `input` and arbitrary strings.
            // This keeps a lower non-boolean value from preventing normalization of the
            // higher-precedence value selected below.
            command.arg("--type=bool-or-str");
        }
        command
            .args(["--null", "--get-all", key])
            .stdin(Stdio::null());
        let output = run_prepared_command(command, remaining)?;
        if !output.status.success {
            if output.status.code == Some(1) && output.stdout.is_empty() {
                continue;
            }
            return Err(GitRunError::Output(io::Error::other(format!(
                "Git could not read effective {key} configuration"
            ))));
        }
        if output.stdout.is_empty() || !output.stdout.ends_with(&[0]) {
            return Err(GitRunError::Output(io::Error::other(format!(
                "Git returned malformed effective {key} configuration"
            ))));
        }
        let value = output.stdout[..output.stdout.len() - 1]
            .split(|byte| *byte == 0)
            .next_back()
            .ok_or_else(|| {
                GitRunError::Output(io::Error::other(format!(
                    "Git returned malformed effective {key} configuration"
                )))
            })?;
        let mut value = os_string_from_bytes(value)?;
        if expand_path && !value.is_empty() && Path::new(&value).is_relative() {
            value = repository.join(&value).into_os_string();
        }
        effective.push((OsString::from(key), value));
    }
    Ok(effective)
}

fn has_applied_transform_filter(
    repository: &Path,
    safety: &GitSafetyOverrides,
    deadline: Instant,
) -> Result<bool, GitRunError> {
    let tracked = run_bounded_command_with_safety(
        OsStr::new("git"),
        repository,
        &["ls-files", "-z"],
        safety,
        remaining_until(deadline)?,
        |_| {},
    )?;
    if !tracked.status.success {
        return Err(GitRunError::Output(io::Error::other(
            "Git could not enumerate tracked paths",
        )));
    }
    if tracked.stdout.is_empty() {
        return Ok(false);
    }
    if !tracked.stdout.ends_with(&[0]) {
        return Err(GitRunError::Output(io::Error::other(
            "Git returned malformed tracked paths",
        )));
    }
    let paths = tracked.stdout[..tracked.stdout.len() - 1]
        .split(|byte| *byte == 0)
        .collect::<Vec<_>>();
    let repository_argument_bytes = repository
        .as_os_str()
        .as_encoded_bytes()
        .len()
        .checked_mul(2)
        .and_then(|size| size.checked_add(CHECK_ATTR_FIXED_ARGUMENT_BYTES))
        .ok_or(GitRunError::OutputTooLarge)?;
    let pathname_budget = MAX_CHECK_ATTR_COMMAND_ARGUMENT_BYTES
        .checked_sub(repository_argument_bytes)
        .ok_or(GitRunError::OutputTooLarge)?;
    let mut applied_drivers = HashSet::new();
    let mut chunk_start = 0;
    while chunk_start < paths.len() {
        let chunk_end = check_attr_chunk_end(&paths, chunk_start, pathname_budget)?;
        let chunk = &paths[chunk_start..chunk_end];
        let mut command = Command::new("git");
        sanitize_git_environment(&mut command);
        isolate_git_configuration(&mut command);
        append_safety_arguments(&mut command, safety);
        command
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("LC_ALL", "C")
            .arg("-C")
            .arg(repository)
            .args(["check-attr", "-z", "filter", "--"]);
        for path in chunk {
            command.arg(os_string_from_bytes(path)?);
        }
        command.stdin(Stdio::null());
        let output = run_prepared_command(command, remaining_until(deadline)?)?;
        if !output.status.success || !output.stdout.ends_with(&[0]) {
            return Err(GitRunError::Output(io::Error::other(
                "Git could not inspect content-filter attributes",
            )));
        }
        let fields = output.stdout[..output.stdout.len() - 1]
            .split(|byte| *byte == 0)
            .collect::<Vec<_>>();
        if fields.len() % 3 != 0 {
            return Err(GitRunError::Output(io::Error::other(
                "Git returned malformed content-filter attributes",
            )));
        }
        for record in fields.chunks_exact(3) {
            let driver = record[2];
            if driver == b"unspecified" || driver == b"unset" || driver == b"set" {
                continue;
            }
            applied_drivers.insert(driver.to_vec());
        }
        chunk_start = chunk_end;
    }
    for driver in applied_drivers {
        for property in ["clean", "process"] {
            let mut key = OsString::from("filter.");
            key.push(os_string_from_bytes(&driver)?);
            key.push(".");
            key.push(property);
            if effective_config_last(repository, safety, &key, false, deadline)?.is_some() {
                return Ok(true);
            }
        }
        let mut required = OsString::from("filter.");
        required.push(os_string_from_bytes(&driver)?);
        required.push(".required");
        if effective_config_last(repository, safety, &required, true, deadline)?
            .is_some_and(|value| !value.eq_ignore_ascii_case(b"false"))
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn check_attr_chunk_end(
    paths: &[&[u8]],
    start: usize,
    pathname_budget: usize,
) -> Result<usize, GitRunError> {
    let mut end = start;
    let mut encoded_bytes = 0_usize;
    while end < paths.len() && end - start < MAX_CHECK_ATTR_PATH_ARGUMENTS {
        // Count a terminator/argument separator too. The 24K cap deliberately
        // leaves headroom for platform quoting, whose precise expansion is not
        // expressible from raw Git pathname bytes.
        let path_bytes = paths[end]
            .len()
            .checked_mul(2)
            .and_then(|size| size.checked_add(3))
            .ok_or(GitRunError::OutputTooLarge)?;
        if path_bytes > pathname_budget {
            return Err(GitRunError::OutputTooLarge);
        }
        if encoded_bytes
            .checked_add(path_bytes)
            .ok_or(GitRunError::OutputTooLarge)?
            > pathname_budget
        {
            break;
        }
        encoded_bytes += path_bytes;
        end += 1;
    }
    if end == start {
        return Err(GitRunError::OutputTooLarge);
    }
    Ok(end)
}

fn effective_config_last(
    repository: &Path,
    safety: &GitSafetyOverrides,
    key: &OsStr,
    boolean: bool,
    deadline: Instant,
) -> Result<Option<Vec<u8>>, GitRunError> {
    let mut command = Command::new("git");
    sanitize_git_environment(&mut command);
    for directory in &safety.safe_directories {
        let mut setting = OsString::from("safe.directory=");
        setting.push(directory);
        command.arg("-c").arg(setting);
    }
    command
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C")
        .arg("-C")
        .arg(repository)
        .args(["config", "--includes"]);
    if boolean {
        command.arg("--type=bool-or-str");
    }
    command
        .args(["--null", "--get-all"])
        .arg(key)
        .stdin(Stdio::null());
    let output = run_prepared_command(command, remaining_until(deadline)?)?;
    if !output.status.success {
        if output.status.code == Some(1) && output.stdout.is_empty() {
            return Ok(None);
        }
        return Err(GitRunError::Output(io::Error::other(
            "Git could not inspect content-filter configuration",
        )));
    }
    if output.stdout.is_empty() || !output.stdout.ends_with(&[0]) {
        return Err(GitRunError::Output(io::Error::other(
            "Git returned malformed content-filter configuration",
        )));
    }
    Ok(Some(
        output.stdout[..output.stdout.len() - 1]
            .split(|byte| *byte == 0)
            .next_back()
            .unwrap_or_default()
            .to_vec(),
    ))
}

fn effective_ignore_submodules(safety: &GitSafetyOverrides) -> &OsStr {
    safety
        .effective_config
        .iter()
        .rev()
        .find(|(key, _)| {
            key.as_os_str()
                .as_encoded_bytes()
                .eq_ignore_ascii_case(b"diff.ignoresubmodules")
        })
        .map(|(_, value)| value.as_os_str())
        // Git's ordinary default is `none`; use an explicit value so the
        // isolated shadow command cannot inherit a different host setting.
        .unwrap_or_else(|| OsStr::new("none"))
}

fn ignores_all_submodules(safety: &GitSafetyOverrides) -> bool {
    effective_ignore_submodules(safety)
        .as_encoded_bytes()
        .eq_ignore_ascii_case(b"all")
}

fn has_initialized_gitlink(
    repository: &Path,
    safety: &GitSafetyOverrides,
    deadline: Instant,
) -> Result<bool, GitRunError> {
    let output = run_bounded_command_with_safety(
        OsStr::new("git"),
        repository,
        &["ls-files", "--stage", "-z"],
        safety,
        remaining_until(deadline)?,
        |_| {},
    )?;
    if !output.status.success || (!output.stdout.is_empty() && !output.stdout.ends_with(&[0])) {
        return Err(GitRunError::Output(io::Error::other(
            "Git could not inspect tracked submodules",
        )));
    }
    for record in output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
    {
        let Some(tab) = record.iter().position(|byte| *byte == b'\t') else {
            return Err(GitRunError::Output(io::Error::other(
                "Git returned malformed tracked entries",
            )));
        };
        if !record[..tab].starts_with(b"160000 ") {
            continue;
        }
        let path = PathBuf::from(os_string_from_bytes(&record[tab + 1..])?);
        let worktree_path = repository.join(path);
        if worktree_path.is_dir() && worktree_path.join(".git").exists() {
            return Ok(true);
        }
    }
    Ok(false)
}

fn repository_state_token(
    repository: &Path,
    safety: &GitSafetyOverrides,
    deadline: Instant,
) -> Result<Vec<u8>, GitRunError> {
    let index = resolve_git_path(repository, safety, "index", deadline)?;
    let shared = run_bounded_command_with_safety(
        OsStr::new("git"),
        repository,
        &["rev-parse", "--path-format=absolute", "--shared-index-path"],
        safety,
        remaining_until(deadline)?,
        |_| {},
    )?;
    if !shared.status.success {
        return Err(GitRunError::Output(io::Error::other(
            "Git could not resolve split-index storage",
        )));
    }
    let mut hasher = Sha256::new();
    hash_snapshot_file(&index, &mut hasher, false, deadline)?;
    if let Some(shared) = repository_path(&shared.stdout) {
        hash_snapshot_file(&shared, &mut hasher, true, deadline)?;
    }
    Ok(hasher.finalize().to_vec())
}

fn hash_snapshot_file(
    path: &Path,
    hasher: &mut Sha256,
    required: bool,
    deadline: Instant,
) -> Result<(), GitRunError> {
    hash_snapshot_file_with_before_open(path, hasher, required, deadline, || {})
}

fn hash_snapshot_file_with_before_open(
    path: &Path,
    hasher: &mut Sha256,
    required: bool,
    deadline: Instant,
    before_open: impl FnOnce(),
) -> Result<(), GitRunError> {
    use std::io::Read as _;
    remaining_until(deadline)?;
    let before = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if !required && error.kind() == io::ErrorKind::NotFound => {
            hasher.update(b"missing");
            return Ok(());
        }
        Err(error) => return Err(GitRunError::Output(error)),
    };
    if !before.file_type().is_file() || before.len() > MAX_INDEX_BYTES {
        return Err(GitRunError::Output(io::Error::other(
            "Git index snapshot is not a bounded regular file",
        )));
    }
    before_open();
    remaining_until(deadline)?;
    let mut file = open_snapshot_file(path, &before, MAX_INDEX_BYTES)?;
    let mut hashed = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        remaining_until(deadline)?;
        let count = file.read(&mut buffer).map_err(GitRunError::Output)?;
        if count == 0 {
            break;
        }
        hashed = hashed
            .checked_add(count as u64)
            .ok_or(GitRunError::OutputTooLarge)?;
        if hashed > MAX_INDEX_BYTES {
            return Err(GitRunError::OutputTooLarge);
        }
        hasher.update(&buffer[..count]);
    }
    remaining_until(deadline)?;
    let after = std::fs::symlink_metadata(path).map_err(GitRunError::Output)?;
    if !after.file_type().is_file() || !same_snapshot_file(&before, &after) {
        return Err(GitRunError::Output(io::Error::other(
            "Git index snapshot changed while it was hashed",
        )));
    }
    Ok(())
}

fn run_shadow_diffs(
    repository: &Path,
    baseline: &str,
    safety: &GitSafetyOverrides,
    deadline: Instant,
) -> Result<(GitOutput, GitOutput), GitRunError> {
    run_shadow_diffs_with(repository, baseline, safety, deadline, || {})
}

fn run_shadow_diffs_with(
    repository: &Path,
    baseline: &str,
    safety: &GitSafetyOverrides,
    deadline: Instant,
    before_diff: impl FnOnce(),
) -> Result<(GitOutput, GitOutput), GitRunError> {
    let index = resolve_git_path(repository, safety, "index", deadline)?;
    let objects = resolve_git_path(repository, safety, "objects", deadline)?;
    let attributes = resolve_git_path(repository, safety, "info/attributes", deadline)?;
    let sparse_checkout = resolve_git_path(repository, safety, "info/sparse-checkout", deadline)?;
    let shared_index_output = run_bounded_command_with_safety(
        OsStr::new("git"),
        repository,
        &["rev-parse", "--path-format=absolute", "--shared-index-path"],
        safety,
        remaining_until(deadline)?,
        |_| {},
    )?;
    if !shared_index_output.status.success {
        return Err(GitRunError::Output(io::Error::other(
            "Git could not resolve split-index storage",
        )));
    }
    let shared_index = repository_path(&shared_index_output.stdout);
    let format = run_bounded_command_with_safety(
        OsStr::new("git"),
        repository,
        &["rev-parse", "--show-object-format"],
        safety,
        remaining_until(deadline)?,
        |_| {},
    )?;
    if !format.status.success {
        return Err(GitRunError::Output(io::Error::other(
            "Git could not resolve the repository object format",
        )));
    }
    let format = trimmed(&format.stdout);
    if format != "sha1" && format != "sha256" {
        return Err(GitRunError::Output(io::Error::other(
            "Git returned an unsupported repository object format",
        )));
    }
    let shadow = tempfile::tempdir().map_err(GitRunError::Output)?;
    std::fs::create_dir(shadow.path().join("objects")).map_err(GitRunError::Output)?;
    std::fs::create_dir(shadow.path().join("refs")).map_err(GitRunError::Output)?;
    std::fs::create_dir(shadow.path().join("info")).map_err(GitRunError::Output)?;
    std::fs::write(
        shadow.path().join("HEAD"),
        "ref: refs/heads/relayer-shadow\n",
    )
    .map_err(GitRunError::Output)?;
    let config = if format == "sha256" {
        "[core]\n\trepositoryformatversion = 1\n\tbare = false\n[extensions]\n\tobjectFormat = sha256\n"
    } else {
        "[core]\n\trepositoryformatversion = 0\n\tbare = false\n"
    };
    std::fs::write(shadow.path().join("config"), config).map_err(GitRunError::Output)?;
    copy_snapshot_file(
        &index,
        &shadow.path().join("index"),
        MAX_INDEX_BYTES,
        false,
        deadline,
    )?;
    if let Some(shared_index) = shared_index {
        let name = shared_index.file_name().ok_or_else(|| {
            GitRunError::Output(io::Error::other("Git returned invalid split-index storage"))
        })?;
        copy_snapshot_file(
            &shared_index,
            &shadow.path().join(name),
            MAX_INDEX_BYTES,
            true,
            deadline,
        )?;
    }
    copy_snapshot_file(
        &attributes,
        &shadow.path().join("info/attributes"),
        MAX_STDOUT_BYTES as u64,
        false,
        deadline,
    )?;
    copy_snapshot_file(
        &sparse_checkout,
        &shadow.path().join("info/sparse-checkout"),
        MAX_STDOUT_BYTES as u64,
        false,
        deadline,
    )?;
    let mut shadow_safety = safety.clone();
    if let Some((_, attributes_file)) =
        shadow_safety.effective_config.iter_mut().find(|(key, _)| {
            key.as_os_str()
                .as_encoded_bytes()
                .eq_ignore_ascii_case(b"core.attributesfile")
        })
        && !attributes_file.is_empty()
    {
        let source = PathBuf::from(&*attributes_file);
        let destination = shadow.path().join("info/global-attributes");
        copy_snapshot_file(
            &source,
            &destination,
            MAX_STDOUT_BYTES as u64,
            false,
            deadline,
        )?;
        if destination.exists() {
            *attributes_file = destination.into_os_string();
        }
    }
    before_diff();
    let staged = run_prepared_command(
        shadow_diff_command(
            repository,
            shadow.path(),
            &objects,
            &shadow_safety,
            &["--cached", baseline],
        ),
        remaining_until(deadline)?,
    )?;
    let worktree = run_prepared_command(
        shadow_diff_command(repository, shadow.path(), &objects, &shadow_safety, &[]),
        remaining_until(deadline)?,
    )?;
    Ok((staged, worktree))
}

fn shadow_diff_command(
    repository: &Path,
    shadow: &Path,
    objects: &Path,
    safety: &GitSafetyOverrides,
    extra: &[&str],
) -> Command {
    let mut command = Command::new("git");
    let mut ignore_submodules = OsString::from("--ignore-submodules=");
    ignore_submodules.push(effective_ignore_submodules(safety));
    sanitize_git_environment(&mut command);
    isolate_git_configuration(&mut command);
    append_safety_arguments(&mut command, safety);
    command
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C")
        .env("GIT_DIR", shadow)
        .env("GIT_WORK_TREE", repository)
        .env("GIT_INDEX_FILE", shadow.join("index"))
        .env("GIT_OBJECT_DIRECTORY", objects)
        .current_dir(repository)
        .args(["diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv"])
        .arg(ignore_submodules)
        .args(extra)
        .arg("--")
        .stdin(Stdio::null());
    command
}

fn copy_snapshot_file(
    source: &Path,
    destination: &Path,
    maximum: u64,
    required: bool,
    deadline: Instant,
) -> Result<(), GitRunError> {
    use std::io::{Read as _, Write as _};
    remaining_until(deadline)?;
    let before = match std::fs::symlink_metadata(source) {
        Ok(metadata) => metadata,
        Err(error) if !required && error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(GitRunError::Output(error)),
    };
    if !before.file_type().is_file() || before.len() > maximum {
        return Err(if before.len() > maximum {
            GitRunError::OutputTooLarge
        } else {
            GitRunError::Output(io::Error::other(
                "Git snapshot storage is not a regular file",
            ))
        });
    }
    let mut input = open_snapshot_file(source, &before, maximum)?;
    let mut output = std::fs::File::create(destination).map_err(GitRunError::Output)?;
    let mut copied = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        remaining_until(deadline)?;
        let count = input.read(&mut buffer).map_err(GitRunError::Output)?;
        if count == 0 {
            break;
        }
        copied = copied
            .checked_add(count as u64)
            .ok_or(GitRunError::OutputTooLarge)?;
        if copied > maximum {
            return Err(GitRunError::OutputTooLarge);
        }
        output
            .write_all(&buffer[..count])
            .map_err(GitRunError::Output)?;
    }
    output.flush().map_err(GitRunError::Output)?;
    remaining_until(deadline)?;
    let after = std::fs::symlink_metadata(source).map_err(GitRunError::Output)?;
    if !after.file_type().is_file() || !same_snapshot_file(&before, &after) {
        return Err(GitRunError::Output(io::Error::other(
            "Git snapshot storage changed while it was copied",
        )));
    }
    Ok(())
}

fn open_snapshot_file(
    path: &Path,
    before: &std::fs::Metadata,
    maximum: u64,
) -> Result<std::fs::File, GitRunError> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        // O_NONBLOCK ensures a regular-file-to-FIFO swap cannot hang the
        // inspection in open(2); the fstat check below then rejects the FIFO.
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt as _;
        options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    let file = options.open(path).map_err(GitRunError::Output)?;
    let opened = file.metadata().map_err(GitRunError::Output)?;
    if !opened.is_file() || opened.len() > maximum || !same_snapshot_file(before, &opened) {
        return Err(GitRunError::Output(io::Error::other(
            "Git snapshot storage changed before it was opened",
        )));
    }
    Ok(file)
}

fn same_snapshot_file(left: &std::fs::Metadata, right: &std::fs::Metadata) -> bool {
    if left.len() != right.len() || left.modified().ok() != right.modified().ok() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;
        left.dev() == right.dev() && left.ino() == right.ino()
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt as _;
        same_windows_snapshot_identity(
            left.volume_serial_number(),
            left.file_index(),
            right.volume_serial_number(),
            right.file_index(),
        )
    }
    #[cfg(not(any(unix, windows)))]
    {
        // Platforms without a stable filesystem identity API must fail closed.
        false
    }
}

#[cfg(any(windows, test))]
fn same_windows_snapshot_identity(
    left_volume: Option<u32>,
    left_index: Option<u64>,
    right_volume: Option<u32>,
    right_index: Option<u64>,
) -> bool {
    matches!(
        (left_volume, left_index, right_volume, right_index),
        (Some(left_volume), Some(left_index), Some(right_volume), Some(right_index))
            if left_volume == right_volume && left_index == right_index
    )
}

fn resolve_git_path(
    repository: &Path,
    safety: &GitSafetyOverrides,
    name: &str,
    deadline: Instant,
) -> Result<PathBuf, GitRunError> {
    let output = run_bounded_command_with_safety(
        OsStr::new("git"),
        repository,
        &["rev-parse", "--path-format=absolute", "--git-path", name],
        safety,
        remaining_until(deadline)?,
        |_| {},
    )?;
    if !output.status.success {
        return Err(GitRunError::Output(io::Error::other(
            "Git could not resolve repository storage",
        )));
    }
    repository_path(&output.stdout).ok_or_else(|| {
        GitRunError::Output(io::Error::other("Git returned invalid repository storage"))
    })
}

fn remaining_until(deadline: Instant) -> Result<Duration, GitRunError> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .ok_or(GitRunError::Timeout(SNAPSHOT_TIMEOUT))
}

fn append_safety_arguments(command: &mut Command, safety: &GitSafetyOverrides) {
    for directory in &safety.safe_directories {
        let mut setting = OsString::from("safe.directory=");
        setting.push(directory);
        command.arg("-c").arg(setting);
    }
    for (key, value) in &safety.effective_config {
        let mut setting = key.clone();
        setting.push("=");
        setting.push(value);
        command.arg("-c").arg(setting);
    }
}

fn validate_repository_identity(
    selected_path: &Path,
    reported_root: &Path,
    safety: &GitSafetyOverrides,
    deadline: Instant,
) -> Result<PathBuf, GitRunError> {
    let selected_git_dir = canonical_git_dir(selected_path, safety, deadline)?;
    let root = std::fs::canonicalize(reported_root).map_err(GitRunError::Output)?;
    if !root.is_dir() {
        return Err(GitRunError::Output(io::Error::other(
            "Git reported a repository root that is not a directory",
        )));
    }
    let selected = std::fs::canonicalize(selected_path).map_err(GitRunError::Output)?;
    if !selected.starts_with(&root) {
        return Err(GitRunError::Output(io::Error::other(
            "Git repository root does not contain the selected project path",
        )));
    }
    let root_git_dir = canonical_git_dir(&root, safety, deadline)?;
    if selected_git_dir != root_git_dir {
        return Err(GitRunError::Output(io::Error::other(
            "Git repository identity changed while resolving its root",
        )));
    }
    Ok(root)
}

fn canonical_git_dir(
    path: &Path,
    safety: &GitSafetyOverrides,
    deadline: Instant,
) -> Result<PathBuf, GitRunError> {
    let remaining = deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .ok_or(GitRunError::Timeout(SNAPSHOT_TIMEOUT))?;
    let output = run_bounded_command_with_safety(
        OsStr::new("git"),
        path,
        &["rev-parse", "--path-format=absolute", "--absolute-git-dir"],
        safety,
        remaining,
        |_| {},
    )?;
    if !output.status.success {
        return Err(GitRunError::Output(io::Error::other(
            "Git could not resolve the repository identity",
        )));
    }
    let git_dir = repository_path(&output.stdout).ok_or_else(|| {
        GitRunError::Output(io::Error::other(
            "Git returned an invalid repository identity",
        ))
    })?;
    let git_dir = std::fs::canonicalize(git_dir).map_err(GitRunError::Output)?;
    if !git_dir.is_dir() {
        return Err(GitRunError::Output(io::Error::other(
            "Git repository identity is not a directory",
        )));
    }
    Ok(git_dir)
}

#[cfg(test)]
fn read_local_filter_drivers(
    repository: &Path,
    safe_directories: &[OsString],
    deadline: Instant,
) -> Result<Vec<OsString>, GitRunError> {
    let remaining = deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .ok_or(GitRunError::Timeout(SNAPSHOT_TIMEOUT))?;
    let mut command = Command::new("git");
    sanitize_git_environment(&mut command);
    isolate_git_configuration(&mut command);
    for directory in safe_directories {
        let mut setting = OsString::from("safe.directory=");
        setting.push(directory);
        command.arg("-c").arg(setting);
    }
    command
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C")
        .current_dir(repository)
        .args([
            "config",
            "--includes",
            "--null",
            "--name-only",
            "--get-regexp",
            "^filter\\.",
        ])
        .stdin(Stdio::null());
    let output = run_prepared_command(command, remaining)?;
    if !output.status.success {
        if output.status.code == Some(1) && output.stdout.is_empty() {
            return Ok(Vec::new());
        }
        return Err(GitRunError::Output(io::Error::other(
            "Git could not enumerate repository filter configuration",
        )));
    }
    parse_local_filter_drivers(&output.stdout).ok_or_else(|| {
        GitRunError::Output(io::Error::other(
            "Git returned malformed local filter configuration",
        ))
    })
}

#[cfg(test)]
fn parse_local_filter_drivers(output: &[u8]) -> Option<Vec<OsString>> {
    if output.is_empty() {
        return Some(Vec::new());
    }
    if !output.ends_with(&[0]) {
        return None;
    }
    let mut seen = HashSet::new();
    let mut drivers = Vec::new();
    for key in output[..output.len() - 1].split(|byte| *byte == 0) {
        let separator = key.iter().rposition(|byte| *byte == b'.')?;
        let driver = &key[..separator];
        let property = &key[separator + 1..];
        if driver.len() <= b"filter.".len()
            || !driver[..b"filter.".len()].eq_ignore_ascii_case(b"filter.")
            || !(property.eq_ignore_ascii_case(b"clean")
                || property.eq_ignore_ascii_case(b"process")
                || property.eq_ignore_ascii_case(b"required"))
        {
            continue;
        }
        // Command-scope overrides use Git's `-c key=value` syntax, whose first '=' is the
        // delimiter. A subsection containing '=' cannot be encoded without changing the
        // key, so fail closed before any diff rather than claim that driver was neutralized.
        if driver.contains(&b'=') {
            return None;
        }
        if seen.insert(driver.to_vec()) {
            drivers.push(os_string_from_bytes(driver).ok()?);
        }
    }
    Some(drivers)
}

fn os_string_from_bytes(bytes: &[u8]) -> Result<OsString, GitRunError> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStringExt;
        Ok(OsString::from_vec(bytes.to_vec()))
    }
    #[cfg(not(unix))]
    {
        String::from_utf8(bytes.to_vec())
            .map(OsString::from)
            .map_err(|_| GitRunError::Output(io::Error::other("Git returned non-UTF-8 config")))
    }
}

#[cfg(unix)]
fn run_prepared_command(mut command: Command, timeout: Duration) -> Result<GitOutput, GitRunError> {
    use std::os::fd::AsRawFd;

    let slot = CommandSlot::acquire()?;
    let child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .group_spawn()
        .map_err(GitRunError::Start)?;
    let mut running = RunningCommand::new(child, slot);
    let stdout = running
        .child_mut()
        .inner()
        .stdout
        .take()
        .ok_or_else(|| GitRunError::Output(io::Error::other("missing stdout pipe")))?;
    let stderr = running
        .child_mut()
        .inner()
        .stderr
        .take()
        .ok_or_else(|| GitRunError::Output(io::Error::other("missing stderr pipe")))?;
    set_nonblocking(stdout.as_raw_fd())?;
    set_nonblocking(stderr.as_raw_fd())?;
    let stop = Arc::new(AtomicBool::new(false));
    let exceeded = Arc::new(AtomicBool::new(false));
    let stdout_reader =
        spawn_nonblocking_reader(stdout, MAX_STDOUT_BYTES, stop.clone(), exceeded.clone())?;
    let stderr_reader =
        spawn_nonblocking_reader(stderr, MAX_STDERR_BYTES, stop.clone(), exceeded.clone())?;
    let result = wait_for_command(&mut running, timeout, || {
        Ok(exceeded.load(Ordering::Acquire))
    });
    stop.store(true, Ordering::Release);
    let stdout = join_nonblocking_reader(stdout_reader)?;
    let stderr = join_nonblocking_reader(stderr_reader)?;
    if exceeded.load(Ordering::Acquire) {
        return Err(GitRunError::OutputTooLarge);
    }
    let status = result?;
    Ok(GitOutput {
        status: status.into(),
        stdout,
        stderr,
    })
}

#[cfg(not(unix))]
fn run_prepared_command(mut command: Command, timeout: Duration) -> Result<GitOutput, GitRunError> {
    let mut stdout_file = tempfile::tempfile().map_err(GitRunError::Output)?;
    let mut stderr_file = tempfile::tempfile().map_err(GitRunError::Output)?;
    let slot = CommandSlot::acquire()?;
    let child = command
        .stdout(Stdio::from(
            stdout_file.try_clone().map_err(GitRunError::Output)?,
        ))
        .stderr(Stdio::from(
            stderr_file.try_clone().map_err(GitRunError::Output)?,
        ))
        .group_spawn()
        .map_err(GitRunError::Start)?;
    let mut running = RunningCommand::new(child, slot);
    let status = wait_for_command(&mut running, timeout, || {
        if output_exceeds(&stdout_file, MAX_STDOUT_BYTES)?
            || output_exceeds(&stderr_file, MAX_STDERR_BYTES)?
        {
            Ok(true)
        } else {
            Ok(false)
        }
    })?;
    let stdout = read_bounded_file(&mut stdout_file, MAX_STDOUT_BYTES)?;
    let stderr = read_bounded_file(&mut stderr_file, MAX_STDERR_BYTES)?;
    Ok(GitOutput {
        status: status.into(),
        stdout,
        stderr,
    })
}

fn wait_for_command(
    running: &mut RunningCommand,
    timeout: Duration,
    mut output_exceeded: impl FnMut() -> Result<bool, GitRunError>,
) -> Result<ExitStatus, GitRunError> {
    let deadline = Instant::now() + timeout;
    let status = loop {
        if Instant::now() >= deadline {
            return Err(GitRunError::Timeout(timeout));
        }
        if output_exceeded()? {
            return Err(GitRunError::OutputTooLarge);
        }
        if let Some(status) = running
            .child_mut()
            .inner()
            .try_wait()
            .map_err(GitRunError::Output)?
        {
            break status;
        }
        thread::sleep(Duration::from_millis(10));
    };
    // The leader may exit while a descendant remains. Do not accept its status until the
    // group has been terminated and reaped; the enclosing bounded inspection keeps its
    // execution permit for this entire cleanup.
    running.leader_exited = true;
    running.finish_or_handoff();
    Ok(status)
}

#[cfg(unix)]
fn set_nonblocking(file_descriptor: std::os::fd::RawFd) -> Result<(), GitRunError> {
    // SAFETY: fcntl does not retain the valid descriptor borrowed from the live pipe object.
    let flags = unsafe { libc::fcntl(file_descriptor, libc::F_GETFL) };
    if flags < 0 {
        return Err(GitRunError::Output(io::Error::last_os_error()));
    }
    // SAFETY: the descriptor remains valid and F_SETFL only updates its status flags.
    if unsafe { libc::fcntl(file_descriptor, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(GitRunError::Output(io::Error::last_os_error()));
    }
    Ok(())
}

#[cfg(unix)]
fn spawn_nonblocking_reader(
    mut reader: impl Read + Send + 'static,
    maximum: usize,
    stop: Arc<AtomicBool>,
    exceeded: Arc<AtomicBool>,
) -> Result<thread::JoinHandle<io::Result<Vec<u8>>>, GitRunError> {
    thread::Builder::new()
        .name("relayer-git-pipe".into())
        .spawn(move || {
            let mut output = Vec::with_capacity(maximum.min(8192));
            let mut buffer = [0_u8; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => return Ok(output),
                    Ok(read) if output.len().saturating_add(read) > maximum => {
                        exceeded.store(true, Ordering::Release);
                        return Ok(output);
                    }
                    Ok(read) => output.extend_from_slice(&buffer[..read]),
                    Err(error)
                        if error.kind() == io::ErrorKind::WouldBlock
                            && stop.load(Ordering::Acquire) =>
                    {
                        return Ok(output);
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2));
                    }
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                    Err(error) => return Err(error),
                }
            }
        })
        .map_err(GitRunError::Output)
}

#[cfg(unix)]
fn join_nonblocking_reader(
    reader: thread::JoinHandle<io::Result<Vec<u8>>>,
) -> Result<Vec<u8>, GitRunError> {
    reader
        .join()
        .map_err(|_| GitRunError::Output(io::Error::other("Git pipe reader panicked")))?
        .map_err(GitRunError::Output)
}

fn sanitize_git_environment(command: &mut Command) {
    let prefixed_variables = std::env::vars_os()
        .map(|(key, _)| key)
        .chain(command.get_envs().map(|(key, _)| key.to_owned()))
        .filter(|key| {
            let key = key.to_string_lossy().to_ascii_uppercase();
            key.starts_with("GIT_CONFIG_KEY_")
                || key.starts_with("GIT_CONFIG_VALUE_")
                || key.starts_with("GIT_TRACE")
                || key.starts_with("GIT_REDIRECT_")
        })
        .collect::<Vec<_>>();
    for variable in prefixed_variables {
        command.env_remove(variable);
    }
    for variable in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_COMMON_DIR",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_NAMESPACE",
        "GIT_SHALLOW_FILE",
        "GIT_GRAFT_FILE",
        "GIT_REPLACE_REF_BASE",
        "GIT_CEILING_DIRECTORIES",
        "GIT_DISCOVERY_ACROSS_FILESYSTEM",
        "GIT_CONFIG",
        "GIT_CONFIG_COUNT",
        "GIT_CONFIG_GLOBAL",
        "GIT_CONFIG_NOSYSTEM",
        "GIT_CONFIG_PARAMETERS",
        "GIT_CONFIG_SYSTEM",
        "GIT_EXEC_PATH",
        "GIT_TEMPLATE_DIR",
        "GIT_TRACE",
        "GIT_TRACE2",
        "GIT_TRACE2_EVENT",
        "GIT_TRACE2_PERF",
        "GIT_TRACE_BARE",
        "GIT_TRACE_CURL",
        "GIT_TRACE_CURL_NO_DATA",
        "GIT_TRACE_FSMONITOR",
        "GIT_TRACE_PACKET",
        "GIT_TRACE_PACKFILE",
        "GIT_TRACE_PACK_ACCESS",
        "GIT_TRACE_PERFORMANCE",
        "GIT_TRACE_REFS",
        "GIT_TRACE_SETUP",
        "GIT_TRACE_SHALLOW",
        "GIT_REDIRECT_STDOUT",
        "GIT_REDIRECT_STDERR",
    ] {
        command.env_remove(variable);
    }
    command
        .env("GIT_ATTR_NOSYSTEM", "1")
        // Repository inspection must never hydrate missing objects. Besides making
        // the snapshot non-deterministic, lazy fetching can invoke a configured
        // transport helper while we are merely reading workspace state.
        .env("GIT_NO_LAZY_FETCH", "1");
}

fn isolate_git_configuration(command: &mut Command) {
    let null_config = if cfg!(windows) { "NUL" } else { "/dev/null" };
    command
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_SYSTEM", null_config)
        .env("GIT_CONFIG_GLOBAL", null_config);
}

struct CommandSlot;

impl CommandSlot {
    fn acquire() -> Result<Self, GitRunError> {
        ACTIVE_COMMANDS
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |active| {
                (active < MAX_ACTIVE_COMMANDS).then_some(active + 1)
            })
            .map(|_| Self)
            .map_err(|_| GitRunError::CleanupBusy {
                stuck: STUCK_CLEANUPS.load(Ordering::Acquire),
            })
    }
}

impl Drop for CommandSlot {
    fn drop(&mut self) {
        ACTIVE_COMMANDS.fetch_sub(1, Ordering::AcqRel);
    }
}

struct RunningCommand {
    child: Option<GroupChild>,
    slot: Option<CommandSlot>,
    finished: bool,
    leader_exited: bool,
}

impl RunningCommand {
    fn new(child: GroupChild, slot: CommandSlot) -> Self {
        Self {
            child: Some(child),
            slot: Some(slot),
            finished: false,
            leader_exited: false,
        }
    }

    fn child_mut(&mut self) -> &mut GroupChild {
        self.child.as_mut().expect("running command child")
    }

    fn cleanup_until(&mut self, deadline: Instant) -> bool {
        if self.finished {
            return true;
        }
        #[cfg(unix)]
        return self.terminate_and_reap_unix(deadline);
        #[cfg(not(unix))]
        return self.terminate_and_reap_group(deadline);
    }

    fn finish_or_handoff(&mut self) {
        if self.cleanup_until(Instant::now() + Duration::from_millis(100)) {
            return;
        }
        let Some(child) = self.child.take() else {
            return;
        };
        let slot = self.slot.take().expect("running command slot");
        STUCK_CLEANUPS.fetch_add(1, Ordering::AcqRel);
        let item = CleanupItem {
            child,
            slot,
            leader_exited: self.leader_exited,
        };
        if let Err(item) = enqueue_cleanup(item) {
            // If the bounded supervisor cannot accept ownership, remain fail-closed on this
            // already bounded inspection worker rather than dropping the child or its slot.
            cleanup_supervisor(item);
        }
        self.finished = true;
    }

    #[cfg(unix)]
    fn terminate_and_reap_unix(&mut self, deadline: Instant) -> bool {
        // GroupChild::wait can block after the direct child has already been observed on macOS.
        // Repeated killpg probes instead give us an explicit group-gone acknowledgement, while
        // the std Child handle independently verifies that the leader has been reaped.
        loop {
            if Instant::now() >= deadline {
                return false;
            }
            match self.child_mut().inner().try_wait() {
                Ok(Some(_)) => self.leader_exited = true,
                Ok(None) => {}
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(_) => {}
            }
            match self.child_mut().kill() {
                Ok(()) => {}
                Err(error) if process_group_is_gone(&error, self.leader_exited) => {
                    break;
                }
                Err(_) => {
                    thread::sleep(Duration::from_millis(5));
                    continue;
                }
            }
            thread::sleep(Duration::from_millis(5));
        }
        retry_cleanup_until(deadline, || {
            match self.child_mut().inner().kill() {
                Ok(()) => {}
                Err(error) if process_group_is_gone(&error, self.leader_exited) => {}
                Err(_) => return false,
            }
            match self.child_mut().inner().try_wait() {
                Ok(Some(_)) => {
                    self.finished = true;
                    true
                }
                Ok(None) | Err(_) => false,
            }
        })
    }

    #[cfg(not(unix))]
    fn terminate_and_reap_group(&mut self, deadline: Instant) -> bool {
        loop {
            if Instant::now() >= deadline {
                return false;
            }
            match self.child_mut().kill() {
                Ok(()) => {}
                Err(error) if process_group_is_gone(&error, self.leader_exited) => {}
                Err(_) => {
                    thread::sleep(Duration::from_millis(5));
                    continue;
                }
            }
            match self.child_mut().wait() {
                Ok(_) => {
                    self.finished = true;
                    return true;
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => thread::sleep(Duration::from_millis(5)),
            }
        }
    }
}

fn process_group_is_gone(error: &io::Error, leader_exited: bool) -> bool {
    if error.kind() == io::ErrorKind::InvalidInput {
        return true;
    }
    // macOS reports EPERM for a group containing only an exited/reaped leader. A group created
    // for our child cannot contain a foreign-user live process, so this is safe only after the
    // direct child status has been observed.
    if leader_exited && error.kind() == io::ErrorKind::PermissionDenied {
        return true;
    }
    #[cfg(unix)]
    {
        // ESRCH is 3 on the supported Unix targets and means the process group no longer exists.
        error.raw_os_error() == Some(3)
    }
    #[cfg(not(unix))]
    {
        false
    }
}

impl Drop for RunningCommand {
    fn drop(&mut self) {
        self.finish_or_handoff();
    }
}

struct CleanupItem {
    child: GroupChild,
    slot: CommandSlot,
    leader_exited: bool,
}

type CleanupSender = std::sync::mpsc::SyncSender<CleanupItem>;
static CLEANUP_SENDER: std::sync::OnceLock<Option<CleanupSender>> = std::sync::OnceLock::new();

fn enqueue_cleanup(item: CleanupItem) -> Result<(), CleanupItem> {
    let Some(sender) = CLEANUP_SENDER.get_or_init(start_cleanup_supervisor) else {
        return Err(item);
    };
    try_send_owned(sender, item)
}

fn try_send_owned<T>(sender: &std::sync::mpsc::SyncSender<T>, item: T) -> Result<(), T> {
    sender.try_send(item).map_err(|error| match error {
        std::sync::mpsc::TrySendError::Full(item)
        | std::sync::mpsc::TrySendError::Disconnected(item) => item,
    })
}

fn start_cleanup_supervisor() -> Option<CleanupSender> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(MAX_CONCURRENT_INSPECTIONS);
    let receiver = Arc::new(Mutex::new(receiver));
    let mut workers = 0;
    for index in 0..MAX_CONCURRENT_INSPECTIONS {
        let receiver = receiver.clone();
        if thread::Builder::new()
            .name(format!("relayer-git-cleanup-{index}"))
            .spawn(move || {
                loop {
                    let item = {
                        let receiver = receiver.lock().expect("Git cleanup receiver");
                        receiver.recv()
                    };
                    match item {
                        Ok(item) => cleanup_supervisor(item),
                        Err(_) => return,
                    }
                }
            })
            .is_ok()
        {
            workers += 1;
        }
    }
    (workers > 0).then_some(sender)
}

fn cleanup_supervisor(item: CleanupItem) {
    let mut running = RunningCommand {
        child: Some(item.child),
        slot: Some(item.slot),
        finished: false,
        leader_exited: item.leader_exited,
    };
    let mut cadence = Duration::from_millis(25);
    loop {
        if running.cleanup_until(Instant::now() + cadence) {
            STUCK_CLEANUPS.fetch_sub(1, Ordering::AcqRel);
            return;
        }
        thread::sleep(cadence);
        cadence = (cadence * 2).min(Duration::from_secs(1));
    }
}

fn retry_cleanup_until(deadline: Instant, mut attempt: impl FnMut() -> bool) -> bool {
    loop {
        if Instant::now() >= deadline {
            return false;
        }
        if attempt() {
            return true;
        }
        thread::sleep(Duration::from_millis(5));
    }
}

#[cfg(not(unix))]
fn read_bounded_file(file: &mut File, maximum: usize) -> Result<Vec<u8>, GitRunError> {
    file.rewind().map_err(GitRunError::Output)?;
    let mut output = Vec::with_capacity(maximum.min(8192));
    file.take(maximum as u64 + 1)
        .read_to_end(&mut output)
        .map_err(GitRunError::Output)?;
    if output.len() > maximum {
        Err(GitRunError::OutputTooLarge)
    } else {
        Ok(output)
    }
}

#[cfg(not(unix))]
fn output_exceeds(file: &File, maximum: usize) -> Result<bool, GitRunError> {
    file.metadata()
        .map(|metadata| metadata.len() > maximum as u64)
        .map_err(GitRunError::Output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::VecDeque,
        sync::{
            Mutex,
            atomic::{AtomicUsize, Ordering},
        },
    };

    struct FakeGitRunner(Mutex<VecDeque<Result<GitOutput, GitRunError>>>);

    impl FakeGitRunner {
        fn new(outputs: Vec<Result<GitOutput, GitRunError>>) -> Self {
            Self(Mutex::new(outputs.into()))
        }
    }

    impl GitRunner for FakeGitRunner {
        fn run(
            &self,
            _path: &Path,
            _arguments: &[&str],
            _safety: &GitSafetyOverrides,
            _timeout: Duration,
        ) -> Result<GitOutput, GitRunError> {
            self.0.lock().unwrap().pop_front().expect("fake output")
        }
    }

    fn output(code: i32, stdout: &str, stderr: &str) -> Result<GitOutput, GitRunError> {
        Ok(GitOutput {
            status: GitExit {
                success: code == 0,
                code: Some(code),
            },
            stdout: stdout.as_bytes().to_vec(),
            stderr: stderr.as_bytes().to_vec(),
        })
    }

    fn canonical_temp(directory: &tempfile::TempDir) -> PathBuf {
        std::fs::canonicalize(directory.path()).unwrap()
    }

    fn run_bounded_git_test(
        path: &Path,
        arguments: &[&str],
        safety: &GitSafetyOverrides,
        mut configure: impl FnMut(&mut Command),
    ) -> Result<GitOutput, GitRunError> {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match run_bounded_command_with_safety(
                OsStr::new("git"),
                path,
                arguments,
                safety,
                SNAPSHOT_TIMEOUT,
                |command| configure(command),
            ) {
                Err(GitRunError::CleanupBusy { .. }) if Instant::now() < deadline => {
                    thread::sleep(Duration::from_millis(10));
                }
                result => return result,
            }
        }
    }

    fn read_protected_safe_directories_test(
        path: &Path,
        mut configure: impl FnMut(&mut Command),
    ) -> Result<Vec<OsString>, GitRunError> {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match read_protected_safe_directories_with(
                path,
                Instant::now() + SNAPSHOT_TIMEOUT,
                |command| configure(command),
            ) {
                Err(GitRunError::CleanupBusy { .. } | GitRunError::Timeout(_))
                    if Instant::now() < deadline =>
                {
                    thread::sleep(Duration::from_millis(10));
                }
                result => return result,
            }
        }
    }

    fn read_protected_excludes_file_test(
        path: &Path,
        mut configure: impl FnMut(&mut Command),
    ) -> Result<Option<OsString>, GitRunError> {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match read_protected_excludes_file_with(
                path,
                Instant::now() + SNAPSHOT_TIMEOUT,
                |command| configure(command),
            ) {
                Err(GitRunError::CleanupBusy { .. } | GitRunError::Timeout(_))
                    if Instant::now() < deadline =>
                {
                    thread::sleep(Duration::from_millis(10));
                }
                result => return result,
            }
        }
    }

    fn read_protected_excludes_file_with_system_test(
        path: &Path,
        system_config: &Path,
        home: &Path,
    ) -> Result<Option<OsString>, GitRunError> {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match read_protected_excludes_file_with_configurers(
                path,
                Instant::now() + SNAPSHOT_TIMEOUT,
                |command| {
                    command.env("HOME", home);
                },
                |command| {
                    command.env("GIT_CONFIG_SYSTEM", system_config);
                },
            ) {
                Err(GitRunError::CleanupBusy { .. } | GitRunError::Timeout(_))
                    if Instant::now() < deadline =>
                {
                    thread::sleep(Duration::from_millis(10));
                }
                result => return result,
            }
        }
    }

    fn read_effective_repository_config_test(
        repository: &Path,
        mut configure: impl FnMut(&mut Command),
    ) -> Result<Vec<(OsString, OsString)>, GitRunError> {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match read_effective_repository_config_with(
                repository,
                &[],
                Instant::now() + SNAPSHOT_TIMEOUT,
                |command| configure(command),
            ) {
                Err(GitRunError::CleanupBusy { .. } | GitRunError::Timeout(_))
                    if Instant::now() < deadline =>
                {
                    thread::sleep(Duration::from_millis(10));
                }
                result => return result,
            }
        }
    }

    fn effective_config_value<'a>(
        config: &'a [(OsString, OsString)],
        key: &str,
    ) -> Option<&'a OsStr> {
        config
            .iter()
            .find(|(candidate, _)| candidate == key)
            .map(|(_, value)| value.as_os_str())
    }

    fn read_local_filter_drivers_test(repository: &Path) -> Result<Vec<OsString>, GitRunError> {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match read_local_filter_drivers(repository, &[], Instant::now() + SNAPSHOT_TIMEOUT) {
                Err(GitRunError::CleanupBusy { .. } | GitRunError::Timeout(_))
                    if Instant::now() < deadline =>
                {
                    thread::sleep(Duration::from_millis(10));
                }
                result => return result,
            }
        }
    }

    #[test]
    fn parses_git_snapshot_and_keeps_untracked_separate() {
        let directory = tempfile::tempdir().unwrap();
        let path = canonical_temp(&directory);
        let git = FakeGitRunner::new(vec![
            output(0, path.to_str().unwrap(), ""),
            output(0, "codex/environment-panel\n", ""),
            output(0, "abc123\n", ""),
            output(0, "10\t3\tfirst.rs\u{0}6\t0\tsecond.rs\u{0}", ""),
            output(0, "2\t1\tfirst.rs\u{0}0\t0\tthird.rs\u{0}", ""),
            output(0, "first.txt\0folder/second.txt\0", ""),
        ]);
        let snapshot = inspect_with(&path, "project", &git, Instant::now() + SNAPSHOT_TIMEOUT);
        assert_eq!(snapshot.kind, EnvironmentKind::Git);
        assert_eq!(snapshot.branch.as_deref(), Some("codex/environment-panel"));
        assert!(!snapshot.detached);
        assert_eq!(snapshot.changes.tracked_files, 3);
        assert_eq!(snapshot.changes.additions, 18);
        assert_eq!(snapshot.changes.deletions, 4);
        assert_eq!(snapshot.changes.untracked_files, 2);
    }

    #[test]
    fn detached_and_clean_are_explicit() {
        let directory = tempfile::tempdir().unwrap();
        let path = canonical_temp(&directory);
        let git = FakeGitRunner::new(vec![
            output(0, path.to_str().unwrap(), ""),
            output(1, "", ""),
            output(0, "abc123\n", ""),
            output(0, "", ""),
            output(0, "", ""),
            output(0, "", ""),
        ]);
        let snapshot = inspect_with(&path, "project", &git, Instant::now() + SNAPSHOT_TIMEOUT);
        assert_eq!(snapshot.kind, EnvironmentKind::Git);
        assert_eq!(snapshot.branch, None);
        assert!(snapshot.detached);
        assert_eq!(snapshot.changes, EnvironmentChanges::default());
    }

    #[test]
    fn non_git_folder_is_not_an_error() {
        let directory = tempfile::tempdir().unwrap();
        let path = canonical_temp(&directory);
        let git = FakeGitRunner::new(vec![output(
            128,
            "",
            "fatal: not a git repository (or any of the parent directories): .git\n",
        )]);
        let snapshot = inspect_with(&path, "project", &git, Instant::now() + SNAPSHOT_TIMEOUT);
        assert_eq!(snapshot.kind, EnvironmentKind::Folder);
        assert_eq!(snapshot.branch, None);
        assert_eq!(snapshot.changes, EnvironmentChanges::default());
    }

    #[test]
    fn missing_path_is_unavailable_without_running_git() {
        let path = Path::new("/definitely/missing/relayer-environment-test");
        let snapshot = inspect_with(
            path,
            "project",
            &FakeGitRunner::new(vec![]),
            Instant::now() + SNAPSHOT_TIMEOUT,
        );
        assert_eq!(snapshot.kind, EnvironmentKind::Unavailable);
        assert_eq!(
            snapshot.unavailable_reason.unwrap().code,
            "path_unavailable"
        );
    }

    #[test]
    fn missing_git_timeout_and_large_output_have_distinct_safe_states() {
        let directory = tempfile::tempdir().unwrap();
        let path = canonical_temp(&directory);
        for (error, code) in [
            (
                GitRunError::Start(io::Error::new(io::ErrorKind::NotFound, "missing")),
                "git_unavailable",
            ),
            (GitRunError::Timeout(SNAPSHOT_TIMEOUT), "git_timeout"),
            (GitRunError::OutputTooLarge, "git_output_too_large"),
        ] {
            let snapshot = inspect_with(
                &path,
                "project",
                &FakeGitRunner::new(vec![Err(error)]),
                Instant::now() + SNAPSHOT_TIMEOUT,
            );
            assert_eq!(snapshot.kind, EnvironmentKind::Unavailable);
            assert_eq!(snapshot.unavailable_reason.unwrap().code, code);
        }
    }

    #[test]
    fn invalid_git_output_degrades_safely() {
        let directory = tempfile::tempdir().unwrap();
        let path = canonical_temp(&directory);
        let git = FakeGitRunner::new(vec![
            output(0, path.to_str().unwrap(), ""),
            output(0, "main", ""),
            output(0, "abc123", ""),
            output(0, "unexpected", ""),
            output(0, "", ""),
        ]);
        let snapshot = inspect_with(&path, "project", &git, Instant::now() + SNAPSHOT_TIMEOUT);
        assert_eq!(snapshot.kind, EnvironmentKind::Unavailable);
        assert_eq!(
            snapshot.unavailable_reason.unwrap().code,
            "git_output_invalid"
        );
    }

    #[test]
    fn unborn_repository_uses_an_empty_tree_baseline() {
        let directory = tempfile::tempdir().unwrap();
        let path = canonical_temp(&directory);
        let git = FakeGitRunner::new(vec![
            output(0, path.to_str().unwrap(), ""),
            output(0, "main", ""),
            output(128, "", "fatal: Needed a single revision"),
            output(0, "empty-tree-id", ""),
            output(0, "2\t0\tnew.txt\0", ""),
            output(0, "", ""),
            output(0, "other.txt\0", ""),
        ]);
        let snapshot = inspect_with(&path, "project", &git, Instant::now() + SNAPSHOT_TIMEOUT);
        assert_eq!(snapshot.kind, EnvironmentKind::Git);
        assert_eq!(snapshot.branch.as_deref(), Some("main"));
        assert_eq!(snapshot.changes.tracked_files, 1);
        assert_eq!(snapshot.changes.additions, 2);
        assert_eq!(snapshot.changes.untracked_files, 1);
    }

    #[test]
    fn staged_and_worktree_reversals_do_not_cancel_change_counts() {
        let changes = parse_numstat_changes(&[
            b"1\t1\tsame.txt\0".as_slice(),
            b"1\t1\tsame.txt\0".as_slice(),
        ])
        .unwrap();
        assert_eq!(changes.tracked_files, 1);
        assert_eq!(changes.additions, 2);
        assert_eq!(changes.deletions, 2);
    }

    #[test]
    fn real_git_snapshot_keeps_staged_change_and_worktree_reversal() {
        struct DirectGitRunner;

        impl GitRunner for DirectGitRunner {
            fn run(
                &self,
                path: &Path,
                arguments: &[&str],
                _safety: &GitSafetyOverrides,
                _timeout: Duration,
            ) -> Result<GitOutput, GitRunError> {
                let output = Command::new("git")
                    .arg("-C")
                    .arg(path)
                    .args(arguments)
                    .output()
                    .map_err(GitRunError::Start)?;
                Ok(GitOutput {
                    status: output.status.into(),
                    stdout: output.stdout,
                    stderr: output.stderr,
                })
            }
        }

        let directory = tempfile::tempdir().unwrap();
        let path = canonical_temp(&directory);
        let run = |arguments: &[&str]| {
            let status = Command::new("git")
                .arg("-C")
                .arg(&path)
                .args(arguments)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .unwrap();
            assert!(status.success(), "git {arguments:?} failed");
        };
        run(&["init", "--initial-branch=main"]);
        run(&["config", "user.email", "relayer-test@example.invalid"]);
        run(&["config", "user.name", "Relayer test"]);
        std::fs::write(path.join("same.txt"), "original\n").unwrap();
        run(&["add", "same.txt"]);
        run(&["commit", "-m", "baseline"]);
        std::fs::write(path.join("same.txt"), "staged\n").unwrap();
        run(&["add", "same.txt"]);
        std::fs::write(path.join("same.txt"), "original\n").unwrap();

        let snapshot = inspect_with(
            &path,
            "project",
            &DirectGitRunner,
            Instant::now() + SNAPSHOT_TIMEOUT,
        );
        assert_eq!(snapshot.kind, EnvironmentKind::Git);
        assert_eq!(snapshot.changes.tracked_files, 1);
        assert_eq!(snapshot.changes.additions, 2);
        assert_eq!(snapshot.changes.deletions, 2);
    }

    #[test]
    fn repository_identity_allows_selected_subdirectories_and_linked_worktrees() {
        let directory = tempfile::tempdir().unwrap();
        let primary = directory.path().join("primary");
        std::fs::create_dir(&primary).unwrap();
        let run = |path: &Path, arguments: &[&str]| {
            let status = Command::new("git")
                .arg("-C")
                .arg(path)
                .args(arguments)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .unwrap();
            assert!(status.success(), "git {arguments:?} failed");
        };
        run(&primary, &["init", "--initial-branch=main"]);
        run(
            &primary,
            &["config", "user.email", "relayer-test@example.invalid"],
        );
        run(&primary, &["config", "user.name", "Relayer test"]);
        std::fs::write(primary.join("tracked.txt"), "baseline\n").unwrap();
        run(&primary, &["add", "tracked.txt"]);
        run(&primary, &["commit", "-m", "baseline"]);

        let primary_subdir = primary.join("selected-subdir");
        std::fs::create_dir(&primary_subdir).unwrap();
        let primary_subdir = std::fs::canonicalize(primary_subdir).unwrap();
        let primary_snapshot = inspect_with(
            &primary_subdir,
            "project",
            &SystemGitRunner,
            Instant::now() + SNAPSHOT_TIMEOUT,
        );
        assert_eq!(primary_snapshot.kind, EnvironmentKind::Git);
        assert_eq!(
            primary_snapshot.worktree_label,
            primary.file_name().unwrap().to_string_lossy()
        );

        let linked = directory.path().join("linked");
        run(
            &primary,
            &[
                "worktree",
                "add",
                "-b",
                "linked-test",
                linked.to_str().unwrap(),
            ],
        );
        let linked_subdir = linked.join("selected-subdir");
        std::fs::create_dir(&linked_subdir).unwrap();
        let linked_subdir = std::fs::canonicalize(linked_subdir).unwrap();
        let linked_snapshot = inspect_with(
            &linked_subdir,
            "project",
            &SystemGitRunner,
            Instant::now() + SNAPSHOT_TIMEOUT,
        );
        assert_eq!(linked_snapshot.kind, EnvironmentKind::Git);
        assert_eq!(linked_snapshot.branch.as_deref(), Some("linked-test"));
        assert_eq!(
            linked_snapshot.worktree_label,
            linked.file_name().unwrap().to_string_lossy()
        );
    }

    #[test]
    fn repository_identity_rejects_core_worktree_redirect() {
        let directory = tempfile::tempdir().unwrap();
        let repository = directory.path().join("repository");
        let redirected = directory.path().join("redirected");
        std::fs::create_dir(&repository).unwrap();
        std::fs::create_dir(&redirected).unwrap();
        let run = |arguments: &[&str]| {
            let status = Command::new("git")
                .arg("-C")
                .arg(&repository)
                .args(arguments)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .unwrap();
            assert!(status.success(), "git {arguments:?} failed");
        };
        run(&["init", "--initial-branch=main"]);
        run(&["config", "user.email", "relayer-test@example.invalid"]);
        run(&["config", "user.name", "Relayer test"]);
        std::fs::write(repository.join("tracked.txt"), "baseline\n").unwrap();
        run(&["add", "tracked.txt"]);
        run(&["commit", "-m", "baseline"]);
        run(&["config", "core.worktree", redirected.to_str().unwrap()]);

        let repository = std::fs::canonicalize(repository).unwrap();
        let reported = Command::new("git")
            .arg("-C")
            .arg(&repository)
            .args(["rev-parse", "--path-format=absolute", "--show-toplevel"])
            .output()
            .unwrap();
        assert!(reported.status.success());
        assert_eq!(
            std::fs::canonicalize(repository_path(&reported.stdout).unwrap()).unwrap(),
            std::fs::canonicalize(&redirected).unwrap()
        );

        let snapshot = inspect_with(
            &repository,
            "project",
            &SystemGitRunner,
            Instant::now() + SNAPSHOT_TIMEOUT,
        );
        assert_eq!(snapshot.kind, EnvironmentKind::Unavailable);
        assert_eq!(
            snapshot.unavailable_reason.unwrap().code,
            "git_output_failed"
        );
    }

    #[test]
    fn repository_identity_rejects_ancestor_core_worktree_redirect() {
        let directory = tempfile::tempdir().unwrap();
        let ancestor = std::fs::canonicalize(directory.path()).unwrap();
        let run = |path: &Path, arguments: &[&str]| {
            let status = Command::new("git")
                .arg("-C")
                .arg(path)
                .args(arguments)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .unwrap();
            assert!(status.success(), "git {arguments:?} failed");
        };
        run(&ancestor, &["init", "--initial-branch=main"]);
        run(
            &ancestor,
            &["config", "user.email", "relayer-test@example.invalid"],
        );
        run(&ancestor, &["config", "user.name", "Relayer test"]);
        std::fs::write(ancestor.join("outer.txt"), "outer\n").unwrap();
        run(&ancestor, &["add", "outer.txt"]);
        run(&ancestor, &["commit", "-m", "outer baseline"]);

        let repository = ancestor.join("repository");
        std::fs::create_dir(&repository).unwrap();
        run(&repository, &["init", "--initial-branch=main"]);
        run(
            &repository,
            &["config", "user.email", "relayer-test@example.invalid"],
        );
        run(&repository, &["config", "user.name", "Relayer test"]);
        std::fs::write(repository.join("tracked.txt"), "baseline\n").unwrap();
        run(&repository, &["add", "tracked.txt"]);
        run(&repository, &["commit", "-m", "nested baseline"]);
        run(
            &repository,
            &["config", "core.worktree", ancestor.to_str().unwrap()],
        );

        let repository = std::fs::canonicalize(repository).unwrap();
        let reported = Command::new("git")
            .arg("-C")
            .arg(&repository)
            .args(["rev-parse", "--path-format=absolute", "--show-toplevel"])
            .output()
            .unwrap();
        assert!(reported.status.success());
        let reported_root =
            std::fs::canonicalize(repository_path(&reported.stdout).unwrap()).unwrap();
        assert_eq!(reported_root, ancestor);
        assert!(
            repository.starts_with(&reported_root),
            "fixture must pass containment so Git-dir identity is the rejecting check"
        );
        let safety = GitSafetyOverrides::default();
        let nested_git_dir =
            canonical_git_dir(&repository, &safety, Instant::now() + SNAPSHOT_TIMEOUT).unwrap();
        let ancestor_git_dir =
            canonical_git_dir(&reported_root, &safety, Instant::now() + SNAPSHOT_TIMEOUT).unwrap();
        assert_ne!(nested_git_dir, ancestor_git_dir);

        let snapshot = inspect_with(
            &repository,
            "project",
            &SystemGitRunner,
            Instant::now() + SNAPSHOT_TIMEOUT,
        );
        assert_eq!(snapshot.kind, EnvironmentKind::Unavailable);
        assert_eq!(
            snapshot.unavailable_reason.unwrap().code,
            "git_output_failed"
        );
    }

    #[test]
    fn numstat_parser_handles_binary_and_rename_records() {
        let changes = parse_numstat_changes(&[
            b"-\t-\tbinary.dat\x000\t0\t\x00old name\x00new name\x00".as_slice(),
        ])
        .unwrap();
        assert_eq!(changes.tracked_files, 2);
        assert_eq!(changes.additions, 0);
        assert_eq!(changes.deletions, 0);
    }

    #[test]
    fn local_filter_parser_deduplicates_clean_process_and_required_keys() {
        let drivers = parse_local_filter_drivers(
            b"filter.attack.clean\0filter.attack.process\0filter.attack.required\0filter.other.process\0filter.smudge-only.smudge\0",
        )
        .unwrap();
        assert_eq!(
            drivers,
            [
                OsString::from("filter.attack"),
                OsString::from("filter.other")
            ]
        );
        assert!(parse_local_filter_drivers(b"filter.evil=x.clean\0").is_none());
    }

    #[test]
    fn all_git_commands_share_one_snapshot_deadline() {
        struct DeadlineRunner {
            calls: AtomicUsize,
            timeouts: Mutex<Vec<Duration>>,
        }

        impl GitRunner for DeadlineRunner {
            fn run(
                &self,
                path: &Path,
                _arguments: &[&str],
                _safety: &GitSafetyOverrides,
                timeout: Duration,
            ) -> Result<GitOutput, GitRunError> {
                self.timeouts.lock().unwrap().push(timeout);
                if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
                    thread::sleep(Duration::from_millis(40));
                    output(0, path.to_str().unwrap(), "")
                } else {
                    output(128, "", "branch inspection failed")
                }
            }
        }

        let directory = tempfile::tempdir().unwrap();
        let path = canonical_temp(&directory);
        let runner = DeadlineRunner {
            calls: AtomicUsize::new(0),
            timeouts: Mutex::new(Vec::new()),
        };
        let snapshot = inspect_with(
            &path,
            "project",
            &runner,
            Instant::now() + Duration::from_millis(200),
        );
        assert_eq!(snapshot.kind, EnvironmentKind::Unavailable);
        let timeouts = runner.timeouts.lock().unwrap();
        assert_eq!(timeouts.len(), 2);
        assert!(timeouts[1] < timeouts[0]);
        assert!(timeouts[1] <= Duration::from_millis(170));
    }

    #[test]
    #[cfg(unix)]
    fn repository_root_preserves_non_utf8_os_path_bytes() {
        use std::os::unix::ffi::OsStrExt;

        let path = repository_path(b"/tmp/relayer-\xff-worktree\n").unwrap();
        assert_eq!(path.as_os_str().as_bytes(), b"/tmp/relayer-\xff-worktree");
    }

    #[test]
    fn filesystem_root_uses_neutral_project_label() {
        assert_eq!(
            folder_label(Path::new("/"), "Named project"),
            "Named project"
        );
    }

    #[test]
    #[cfg(unix)]
    fn stored_path_rejects_a_symlink_retarget() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let stored = directory.path().join("stored");
        let replacement = directory.path().join("replacement");
        std::fs::create_dir(&stored).unwrap();
        std::fs::create_dir(&replacement).unwrap();
        std::fs::rename(&stored, directory.path().join("moved")).unwrap();
        symlink(&replacement, &stored).unwrap();
        let snapshot = *validate_stored_path(&stored, "Pinned project").unwrap_err();
        assert_eq!(snapshot.kind, EnvironmentKind::Unavailable);
        assert_eq!(snapshot.worktree_label, "Pinned project");
        assert_eq!(snapshot.unavailable_reason.unwrap().code, "path_retargeted");
    }

    #[tokio::test]
    async fn coordinator_coalesces_and_caches_the_same_project() {
        let directory = tempfile::tempdir().unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let observed_calls = calls.clone();
        let inspector = EnvironmentInspector::with_inspector(2, move |_, label, _| {
            observed_calls.fetch_add(1, Ordering::SeqCst);
            thread::sleep(Duration::from_millis(50));
            EnvironmentSnapshot::folder(label)
        });
        let path = canonical_temp(&directory);
        let (first, second) = tokio::join!(
            inspector.inspect(path.clone(), "Project".into()),
            inspector.inspect(path.clone(), "Project".into()),
        );
        assert_eq!(first.kind, EnvironmentKind::Folder);
        assert_eq!(second, first);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let cached = inspector.inspect(path, "Project".into()).await;
        assert_eq!(cached, first);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn coordinator_bounds_global_capacity() {
        let first_directory = tempfile::tempdir().unwrap();
        let second_directory = tempfile::tempdir().unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let observed_calls = calls.clone();
        let inspector = EnvironmentInspector::with_inspector(1, move |_, label, _| {
            observed_calls.fetch_add(1, Ordering::SeqCst);
            thread::sleep(Duration::from_millis(250));
            EnvironmentSnapshot::folder(label)
        });
        let first_inspector = inspector.clone();
        let first_path = canonical_temp(&first_directory);
        let first =
            tokio::spawn(async move { first_inspector.inspect(first_path, "First".into()).await });
        while calls.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        let second = inspector
            .inspect(canonical_temp(&second_directory), "Second".into())
            .await;
        assert_eq!(second.kind, EnvironmentKind::Unavailable);
        assert_eq!(
            second.unavailable_reason.unwrap().code,
            "inspection_capacity"
        );
        assert_eq!(first.await.unwrap().kind, EnvironmentKind::Folder);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn cached_snapshot_survives_unrelated_execution_saturation() {
        let cached_directory = tempfile::tempdir().unwrap();
        let blocking_directory = tempfile::tempdir().unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let blocker_started = Arc::new(AtomicUsize::new(0));
        let observed_calls = calls.clone();
        let observed_blocker = blocker_started.clone();
        let inspector = EnvironmentInspector::with_functions(
            1,
            4,
            Duration::from_millis(500),
            validate_stored_path,
            move |_, label, _| {
                observed_calls.fetch_add(1, Ordering::SeqCst);
                if label == "Blocking" {
                    observed_blocker.store(1, Ordering::SeqCst);
                    thread::sleep(Duration::from_millis(150));
                }
                EnvironmentSnapshot::folder(label)
            },
        );
        let cached_path = canonical_temp(&cached_directory);
        let cached = inspector
            .inspect(cached_path.clone(), "Cached".into())
            .await;
        let blocking_inspector = inspector.clone();
        let blocking_path = canonical_temp(&blocking_directory);
        let blocking = tokio::spawn(async move {
            blocking_inspector
                .inspect(blocking_path, "Blocking".into())
                .await
        });
        while blocker_started.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }

        let hit = inspector.inspect(cached_path, "Cached".into()).await;
        assert_eq!(hit, cached);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(blocking.await.unwrap().kind, EnvironmentKind::Folder);
    }

    #[tokio::test]
    async fn hung_validation_keeps_pending_capacity_and_key_lock_after_caller_timeout() {
        let directory = tempfile::tempdir().unwrap();
        let validations = Arc::new(AtomicUsize::new(0));
        let observed_validations = validations.clone();
        let inspector = EnvironmentInspector::with_functions(
            1,
            2,
            Duration::from_millis(50),
            move |_, _| {
                observed_validations.fetch_add(1, Ordering::SeqCst);
                thread::sleep(Duration::from_millis(200));
                Ok(())
            },
            |_, label, _| EnvironmentSnapshot::folder(label),
        );
        let path = canonical_temp(&directory);
        let first_inspector = inspector.clone();
        let first_path = path.clone();
        let first =
            tokio::spawn(
                async move { first_inspector.inspect(first_path, "Project".into()).await },
            );
        while validations.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        let first = first.await.unwrap();
        assert_eq!(first.unavailable_reason.unwrap().code, "git_timeout");

        let second = inspector.inspect(path, "Project".into()).await;
        assert_eq!(second.unavailable_reason.unwrap().code, "git_timeout");
        assert_eq!(validations.load(Ordering::SeqCst), 1);
        thread::sleep(Duration::from_millis(120));
    }

    #[tokio::test]
    async fn same_key_queue_is_bounded_before_validation() {
        let directory = tempfile::tempdir().unwrap();
        let validation_started = Arc::new(AtomicUsize::new(0));
        let observed_validation = validation_started.clone();
        let inspector = EnvironmentInspector::with_functions(
            1,
            1,
            Duration::from_millis(500),
            move |_, _| {
                observed_validation.store(1, Ordering::SeqCst);
                thread::sleep(Duration::from_millis(200));
                Ok(())
            },
            |_, label, _| EnvironmentSnapshot::folder(label),
        );
        let path = canonical_temp(&directory);
        let first_inspector = inspector.clone();
        let first_path = path.clone();
        let first =
            tokio::spawn(async move { first_inspector.inspect(first_path, "First".into()).await });
        while validation_started.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        let second = inspector.inspect(path, "Second".into()).await;
        assert_eq!(
            second.unavailable_reason.unwrap().code,
            "inspection_capacity"
        );
        assert_eq!(first.await.unwrap().kind, EnvironmentKind::Folder);
    }

    #[tokio::test]
    async fn timed_out_inspection_retains_execution_capacity_until_blocking_work_exits() {
        let first_directory = tempfile::tempdir().unwrap();
        let second_directory = tempfile::tempdir().unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let first_started = Arc::new(AtomicUsize::new(0));
        let observed_calls = calls.clone();
        let observed_first = first_started.clone();
        let inspector = EnvironmentInspector::with_functions(
            1,
            4,
            Duration::from_millis(50),
            validate_stored_path,
            move |_, label, _| {
                observed_calls.fetch_add(1, Ordering::SeqCst);
                if label == "First" {
                    observed_first.store(1, Ordering::SeqCst);
                    thread::sleep(Duration::from_millis(200));
                }
                EnvironmentSnapshot::folder(label)
            },
        );
        let first_inspector = inspector.clone();
        let first_path = canonical_temp(&first_directory);
        let first =
            tokio::spawn(async move { first_inspector.inspect(first_path, "First".into()).await });
        while first_started.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        assert_eq!(
            first.await.unwrap().unavailable_reason.unwrap().code,
            "git_timeout"
        );

        let second_path = canonical_temp(&second_directory);
        let blocked = inspector
            .inspect(second_path.clone(), "Second".into())
            .await;
        assert_eq!(blocked.unavailable_reason.unwrap().code, "git_timeout");
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        tokio::time::sleep(Duration::from_millis(120)).await;
        let after_cleanup = inspector.inspect(second_path, "Second".into()).await;
        assert_eq!(after_cleanup.kind, EnvironmentKind::Folder);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    #[cfg(unix)]
    fn command_runner_enforces_start_timeout_and_output_bounds() {
        use std::{fs, os::unix::fs::PermissionsExt};

        let directory = tempfile::tempdir().unwrap();
        let missing = directory.path().join("missing-git");
        assert!(matches!(
            run_bounded_command(
                missing.as_os_str(),
                directory.path(),
                &[],
                Duration::from_millis(20)
            ),
            Err(GitRunError::Start(_))
        ));
        let executable = directory.path().join("bounded-command-fixture");
        fs::write(
            &executable,
            "#!/bin/sh\nfor argument do mode=$argument; done\nif [ \"$mode\" = sleep ]; then while :; do :; done; else yes x | head -c 300000; fi\n",
        )
        .unwrap();
        let mut permissions = fs::metadata(&executable).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&executable, permissions).unwrap();
        assert!(matches!(
            run_bounded_command(
                executable.as_os_str(),
                directory.path(),
                &["sleep"],
                Duration::from_millis(20)
            ),
            Err(GitRunError::Timeout(_))
        ));
        assert!(matches!(
            run_bounded_command(
                executable.as_os_str(),
                directory.path(),
                &["output"],
                Duration::from_secs(1)
            ),
            Err(GitRunError::OutputTooLarge)
        ));

        let descriptor_holder = directory.path().join("descriptor-holder-fixture");
        let descendant_pid = directory.path().join("descendant.pid");
        fs::write(
            &descriptor_holder,
            format!(
                "#!/bin/sh\nsleep 10 &\necho $! > '{}'\nexit 0\n",
                descendant_pid.display()
            ),
        )
        .unwrap();
        let mut permissions = fs::metadata(&descriptor_holder).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&descriptor_holder, permissions).unwrap();
        let started = Instant::now();
        let output = run_bounded_command(
            descriptor_holder.as_os_str(),
            directory.path(),
            &[],
            Duration::from_millis(500),
        );
        let timed_out = matches!(&output, Err(GitRunError::Timeout(_)));
        assert!(
            matches!(
                &output,
                Ok(GitOutput {
                    status: GitExit { success: true, .. },
                    ..
                })
            ) || timed_out
        );
        assert!(started.elapsed() < Duration::from_secs(1));
        let pid = match fs::read_to_string(descendant_pid) {
            Ok(pid) => pid,
            Err(error) if timed_out && error.kind() == io::ErrorKind::NotFound => {
                // Under suite contention the deadline may expire before the fixture starts;
                // in that case no descendant was created and there is nothing to reap.
                return;
            }
            Err(error) => panic!("could not read descendant pid: {error}"),
        };
        let mut alive = true;
        for _ in 0..20 {
            alive = Command::new("/bin/kill")
                .args(["-0", pid.trim()])
                .stderr(Stdio::null())
                .status()
                .unwrap()
                .success();
            if !alive {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert!(
            !alive,
            "background descendant survived process-group cleanup"
        );
    }

    #[test]
    #[cfg(unix)]
    fn command_runner_clears_hostile_git_repository_environment() {
        use std::{fs, os::unix::fs::PermissionsExt};

        let directory = tempfile::tempdir().unwrap();
        let fixture = directory.path().join("git-environment-fixture");
        fs::write(
            &fixture,
            "#!/bin/sh\nprintf '%s|%s|%s|%s|%s|%s|%s|%s|%s|%s' \"${GIT_DIR-unset}\" \"${GIT_WORK_TREE-unset}\" \"${GIT_INDEX_FILE-unset}\" \"${GIT_CONFIG_PARAMETERS-unset}\" \"${GIT_CONFIG_COUNT-unset}\" \"${GIT_CONFIG_KEY_0-unset}\" \"${GIT_CONFIG_VALUE_0-unset}\" \"${GIT_TRACE-unset}\" \"${GIT_TRACE2_EVENT-unset}\" \"${GIT_NO_LAZY_FETCH-unset}\"\n",
        )
        .unwrap();
        let mut permissions = fs::metadata(&fixture).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&fixture, permissions).unwrap();

        let output = run_bounded_command_with(
            fixture.as_os_str(),
            directory.path(),
            &[],
            Duration::from_millis(500),
            |command| {
                command
                    .env("GIT_DIR", "/hostile/repository")
                    .env("GIT_WORK_TREE", "/hostile/worktree")
                    .env("GIT_INDEX_FILE", "/hostile/index")
                    .env("GIT_CONFIG_PARAMETERS", "'core.worktree=/hostile'")
                    .env("GIT_CONFIG_COUNT", "1")
                    .env("GIT_CONFIG_KEY_0", "core.worktree")
                    .env("GIT_CONFIG_VALUE_0", "/hostile")
                    .env("GIT_TRACE", "/hostile/trace")
                    .env("GIT_TRACE2_EVENT", "/hostile/trace2");
            },
        )
        .unwrap();
        assert!(output.status.success);
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            "unset|unset|unset|unset|unset|unset|unset|unset|unset|1"
        );

        let repository = directory.path().join("repository");
        fs::create_dir(&repository).unwrap();
        let repository = fs::canonicalize(repository).unwrap();
        assert!(
            Command::new("git")
                .args(["-C", repository.to_str().unwrap(), "init"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .unwrap()
                .success()
        );
        let trace = directory.path().join("git-trace.log");
        let trace2 = directory.path().join("git-trace2.log");
        let git_output = run_bounded_command_with(
            OsStr::new("git"),
            &repository,
            &["rev-parse", "--is-inside-work-tree"],
            Duration::from_millis(500),
            |command| {
                command
                    .env("GIT_TRACE", &trace)
                    .env("GIT_TRACE2_EVENT", &trace2);
            },
        )
        .unwrap();
        assert!(git_output.status.success);
        assert!(!trace.exists());
        assert!(!trace2.exists());
    }

    #[test]
    #[cfg(unix)]
    fn repository_commands_forward_only_protected_safe_directories() {
        use std::{fs, os::unix::fs::PermissionsExt};

        let directory = tempfile::tempdir().unwrap();
        let home = directory.path().join("home");
        fs::create_dir(&home).unwrap();
        let repository = directory.path().join("repository");
        fs::create_dir(&repository).unwrap();
        let run = |arguments: &[&str]| {
            let status = Command::new("git")
                .arg("-C")
                .arg(&repository)
                .args(arguments)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .unwrap();
            assert!(status.success(), "git {arguments:?} failed");
        };
        run(&["init", "--initial-branch=main"]);
        run(&["config", "user.email", "relayer-test@example.invalid"]);
        run(&["config", "user.name", "Relayer test"]);
        fs::write(repository.join(".gitattributes"), "*.txt filter=attack\n").unwrap();
        fs::write(repository.join("tracked.txt"), "baseline\n").unwrap();
        run(&["add", ".gitattributes", "tracked.txt"]);
        run(&["commit", "-m", "baseline"]);

        let marker = directory.path().join("global-filter-executed");
        let filter = directory.path().join("global-clean-filter");
        fs::write(
            &filter,
            format!("#!/bin/sh\ntouch '{}'\ncat\n", marker.display()),
        )
        .unwrap();
        let mut permissions = fs::metadata(&filter).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&filter, permissions).unwrap();
        let excludes_file = home.join("global-ignore");
        fs::write(&excludes_file, "ignored.tmp\n").unwrap();
        let included = home.join("safe-directory.inc");
        fs::write(
            &included,
            format!(
                "[safe]\n\tdirectory =\n\tdirectory = {}\n[core]\n\texcludesFile = ~/global-ignore\n",
                repository.display()
            ),
        )
        .unwrap();
        fs::write(
            home.join(".gitconfig"),
            format!(
                "[include]\n\tpath = {}\n[filter \"attack\"]\n\tclean = {}\n",
                included.display(),
                filter.display()
            ),
        )
        .unwrap();
        let injected = directory.path().join("injected.gitconfig");
        fs::write(
            &injected,
            "[safe]\n\tdirectory = /environment/injected/repository\n",
        )
        .unwrap();

        let safe_directories = read_protected_safe_directories_test(&repository, |command| {
            command
                .env("HOME", &home)
                .env("GIT_CONFIG_GLOBAL", &injected);
        })
        .unwrap();
        assert!(safe_directories.ends_with(&[OsString::new(), repository.as_os_str().to_owned(),]));
        assert!(
            !safe_directories
                .iter()
                .any(|directory| directory == OsStr::new("/environment/injected/repository"))
        );
        assert!(
            !marker.exists(),
            "protected-config discovery executed an unrelated global helper"
        );
        let protected_excludes_file = read_protected_excludes_file_test(&repository, |command| {
            command
                .env("HOME", &home)
                .env("GIT_CONFIG_GLOBAL", &injected);
        })
        .unwrap();
        assert_eq!(
            protected_excludes_file,
            Some(excludes_file.as_os_str().to_owned())
        );
        assert!(
            !marker.exists(),
            "protected excludes discovery executed an unrelated global helper"
        );
        let safety = GitSafetyOverrides {
            safe_directories,
            effective_config: protected_excludes_file
                .into_iter()
                .map(|value| (OsString::from("core.excludesFile"), value))
                .collect(),
            disabled_filter_drivers: Vec::new(),
        };

        fs::write(repository.join("tracked.txt"), "changed\n").unwrap();
        let unisolated = Command::new("git")
            .arg("-C")
            .arg(&repository)
            .args([
                "diff",
                "--numstat",
                "-z",
                "--no-ext-diff",
                "--no-textconv",
                "--",
            ])
            .env("HOME", &home)
            .env_remove("GIT_CONFIG_GLOBAL")
            .env_remove("GIT_CONFIG_NOSYSTEM")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(unisolated.success());
        assert!(
            marker.exists(),
            "regression fixture did not reproduce the global clean-filter execution"
        );
        fs::remove_file(&marker).unwrap();

        let output = run_bounded_git_test(
            &repository,
            &[
                "diff",
                "--numstat",
                "-z",
                "--no-ext-diff",
                "--no-textconv",
                "--",
            ],
            &safety,
            |command| {
                command
                    .env("HOME", &home)
                    .env("GIT_CONFIG_GLOBAL", &injected);
            },
        )
        .unwrap();
        assert!(output.status.success);
        assert!(!output.stdout.is_empty());
        assert!(
            !marker.exists(),
            "repository diff executed a globally configured clean filter"
        );

        fs::write(repository.join("ignored.tmp"), "ignored\n").unwrap();
        fs::write(repository.join("visible.tmp"), "visible\n").unwrap();
        let untracked = run_bounded_git_test(
            &repository,
            &["ls-files", "--others", "--exclude-standard", "-z"],
            &safety,
            |command| {
                command.env("HOME", &home);
            },
        )
        .unwrap();
        assert!(untracked.status.success);
        assert_eq!(untracked.stdout, b"visible.tmp\0");
        assert!(!marker.exists());

        let forwarded = run_bounded_git_test(
            &repository,
            &["config", "--null", "--get-all", "safe.directory"],
            &safety,
            |command| {
                command.env("HOME", &home);
            },
        )
        .unwrap();
        assert!(forwarded.status.success);
        let expected_forwarded = safety
            .safe_directories
            .iter()
            .flat_map(|directory| {
                directory
                    .as_os_str()
                    .as_encoded_bytes()
                    .iter()
                    .copied()
                    .chain(std::iter::once(0))
            })
            .collect::<Vec<_>>();
        assert_eq!(forwarded.stdout, expected_forwarded);
    }

    #[test]
    #[cfg(unix)]
    fn protected_excludes_preserve_global_empty_reset_and_system_precedence() {
        use std::fs;

        let directory = tempfile::tempdir().unwrap();
        let repository = directory.path().join("repository");
        fs::create_dir(&repository).unwrap();
        let repository = fs::canonicalize(repository).unwrap();
        let initialized = Command::new("git")
            .arg("-C")
            .arg(&repository)
            .args(["init", "--initial-branch=main"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(initialized.success());
        for name in ["system.tmp", "visible.tmp", "xdg.tmp"] {
            fs::write(repository.join(name), name).unwrap();
        }

        let system_excludes = directory.path().join("system-ignore");
        fs::write(&system_excludes, "system.tmp\n").unwrap();
        let system_config = directory.path().join("system.gitconfig");
        fs::write(
            &system_config,
            format!("[core]\n\texcludesFile = {}\n", system_excludes.display()),
        )
        .unwrap();
        let xdg = directory.path().join("xdg");
        fs::create_dir_all(xdg.join("git")).unwrap();
        fs::write(xdg.join("git/ignore"), "xdg.tmp\n").unwrap();

        let empty_home = directory.path().join("empty-home");
        fs::create_dir(&empty_home).unwrap();
        let system_value =
            read_protected_excludes_file_with_system_test(&repository, &system_config, &empty_home)
                .unwrap();
        assert_eq!(system_value, Some(system_excludes.as_os_str().to_owned()));
        let system_result = run_bounded_git_test(
            &repository,
            &["ls-files", "--others", "--exclude-standard", "-z"],
            &GitSafetyOverrides {
                safe_directories: Vec::new(),
                effective_config: system_value
                    .into_iter()
                    .map(|value| (OsString::from("core.excludesFile"), value))
                    .collect(),
                disabled_filter_drivers: Vec::new(),
            },
            |command| {
                command
                    .env("HOME", &empty_home)
                    .env("XDG_CONFIG_HOME", &xdg);
            },
        )
        .unwrap();
        assert!(system_result.status.success);
        assert_eq!(system_result.stdout, b"visible.tmp\0xdg.tmp\0");

        let reset_home = directory.path().join("reset-home");
        fs::create_dir(&reset_home).unwrap();
        fs::write(reset_home.join(".gitconfig"), "[core]\n\texcludesFile =\n").unwrap();
        let reset_value =
            read_protected_excludes_file_with_system_test(&repository, &system_config, &reset_home)
                .unwrap();
        assert_eq!(reset_value, Some(OsString::new()));
        let reset_result = run_bounded_git_test(
            &repository,
            &["ls-files", "--others", "--exclude-standard", "-z"],
            &GitSafetyOverrides {
                safe_directories: Vec::new(),
                effective_config: reset_value
                    .into_iter()
                    .map(|value| (OsString::from("core.excludesFile"), value))
                    .collect(),
                disabled_filter_drivers: Vec::new(),
            },
            |command| {
                command
                    .env("HOME", &reset_home)
                    .env("XDG_CONFIG_HOME", &xdg);
            },
        )
        .unwrap();
        assert!(reset_result.status.success);
        assert_eq!(reset_result.stdout, b"system.tmp\0visible.tmp\0xdg.tmp\0");
    }

    #[test]
    #[cfg(unix)]
    fn effective_global_autocrlf_keeps_clean_worktree_and_does_not_enable_filter_helper() {
        use std::{fs, os::unix::fs::PermissionsExt};

        let directory = tempfile::tempdir().unwrap();
        let repository = directory.path().join("repository");
        let home = directory.path().join("home");
        fs::create_dir(&repository).unwrap();
        fs::create_dir(&home).unwrap();
        let run = |arguments: &[&str]| {
            let status = Command::new("git")
                .arg("-C")
                .arg(&repository)
                .args(arguments)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .unwrap();
            assert!(status.success(), "git {arguments:?} failed");
        };
        run(&["init", "--initial-branch=main"]);
        run(&["config", "user.email", "relayer-test@example.invalid"]);
        run(&["config", "user.name", "Relayer test"]);
        fs::write(repository.join("line.txt"), "line one\nline two\n").unwrap();
        fs::write(repository.join("payload.flt"), "baseline\n").unwrap();
        fs::write(repository.join(".gitattributes"), "*.flt filter=attack\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "-m", "baseline"]);

        let marker = directory.path().join("global-filter-executed");
        let helper = directory.path().join("global-filter");
        fs::write(
            &helper,
            format!("#!/bin/sh\ntouch '{}'\ncat\n", marker.display()),
        )
        .unwrap();
        let mut permissions = fs::metadata(&helper).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&helper, permissions).unwrap();
        fs::write(
            home.join(".gitconfig"),
            format!(
                "[core]\n\tautocrlf = true\n[filter \"attack\"]\n\tclean = {}\n",
                helper.display()
            ),
        )
        .unwrap();
        fs::write(repository.join("line.txt"), "line one\r\nline two\r\n").unwrap();
        fs::write(repository.join("payload.flt"), "changed\n").unwrap();

        let effective = read_effective_repository_config_test(&repository, |command| {
            command.env("HOME", &home);
        })
        .unwrap();
        assert_eq!(
            effective_config_value(&effective, "core.autocrlf"),
            Some(OsStr::new("true"))
        );
        assert!(
            !marker.exists(),
            "effective config discovery executed an unrelated filter helper"
        );
        let output = run_bounded_git_test(
            &repository,
            &[
                "diff",
                "--name-only",
                "-z",
                "--no-ext-diff",
                "--no-textconv",
                "--",
            ],
            &GitSafetyOverrides {
                safe_directories: Vec::new(),
                effective_config: effective,
                disabled_filter_drivers: Vec::new(),
            },
            |command| {
                command.env("HOME", &home);
            },
        )
        .unwrap();
        assert!(output.status.success, "{}", trimmed(&output.stderr));
        assert_eq!(output.stdout, b"payload.flt\0");
        assert!(
            !marker.exists(),
            "isolated repository diff executed a global filter helper"
        );
    }

    #[test]
    #[cfg(unix)]
    fn effective_config_preserves_includes_paths_empty_values_and_local_precedence() {
        use std::{fs, io::Write};

        let directory = tempfile::tempdir().unwrap();
        let repository = directory.path().join("repository");
        let home = directory.path().join("home");
        fs::create_dir(&repository).unwrap();
        fs::create_dir(&home).unwrap();
        let run = |arguments: &[&str]| {
            let status = Command::new("git")
                .arg("-C")
                .arg(&repository)
                .args(arguments)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .unwrap();
            assert!(status.success(), "git {arguments:?} failed");
        };
        run(&["init", "--initial-branch=main"]);
        run(&["config", "user.email", "relayer-test@example.invalid"]);
        run(&["config", "user.name", "Relayer test"]);
        fs::write(repository.join("sample.attr"), "one\ntwo\n").unwrap();
        run(&["add", "sample.attr"]);
        run(&["commit", "-m", "baseline"]);

        let global_attributes = home.join("global-attributes");
        let global_excludes = home.join("global-ignore");
        fs::write(&global_attributes, "*.attr text\n").unwrap();
        fs::write(&global_excludes, "global.tmp\n").unwrap();
        let included = home.join("included.gitconfig");
        fs::write(
            &included,
            "[core]\n\tautocrlf = false\n\tattributesFile = ~/global-attributes\n\texcludesFile = ~/global-ignore\n",
        )
        .unwrap();
        fs::write(
            home.join(".gitconfig"),
            format!("[include]\n\tpath = {}\n", included.display()),
        )
        .unwrap();
        fs::write(repository.join("sample.attr"), "one\r\ntwo\r\n").unwrap();

        let global = read_effective_repository_config_test(&repository, |command| {
            command.env("HOME", &home);
        })
        .unwrap();
        assert_eq!(
            effective_config_value(&global, "core.autocrlf"),
            Some(OsStr::new("false"))
        );
        assert_eq!(
            effective_config_value(&global, "core.attributesFile"),
            Some(global_attributes.as_os_str())
        );
        assert_eq!(
            effective_config_value(&global, "core.excludesFile"),
            Some(global_excludes.as_os_str())
        );
        let normalized = run_bounded_git_test(
            &repository,
            &[
                "diff",
                "--name-only",
                "-z",
                "--no-ext-diff",
                "--no-textconv",
                "--",
            ],
            &GitSafetyOverrides {
                safe_directories: Vec::new(),
                effective_config: global,
                disabled_filter_drivers: Vec::new(),
            },
            |command| {
                command.env("HOME", &home);
            },
        )
        .unwrap();
        assert!(normalized.status.success);
        assert!(normalized.stdout.is_empty());

        fs::write(
            &included,
            "[core]\n\tautocrlf = input\n\tattributesFile = ~/global-attributes\n\texcludesFile = ~/global-ignore\n",
        )
        .unwrap();
        let input = read_effective_repository_config_test(&repository, |command| {
            command.env("HOME", &home);
        })
        .unwrap();
        assert_eq!(
            effective_config_value(&input, "core.autocrlf"),
            Some(OsStr::new("input"))
        );
        let mut local_config = fs::OpenOptions::new()
            .append(true)
            .open(repository.join(".git/config"))
            .unwrap();
        writeln!(local_config, "[core]\n\tautocrlf").unwrap();
        drop(local_config);
        let mixed_input = read_effective_repository_config_test(&repository, |command| {
            command.env("HOME", &home);
        })
        .unwrap();
        assert_eq!(
            effective_config_value(&mixed_input, "core.autocrlf"),
            Some(OsStr::new("true")),
            "a local implicit true must override a global input value"
        );
        fs::write(
            &included,
            "[core]\n\tautocrlf = invalid-lower-value\n\tattributesFile = ~/global-attributes\n\texcludesFile = ~/global-ignore\n",
        )
        .unwrap();
        let mixed_invalid = read_effective_repository_config_test(&repository, |command| {
            command.env("HOME", &home);
        })
        .unwrap();
        assert_eq!(
            effective_config_value(&mixed_invalid, "core.autocrlf"),
            Some(OsStr::new("true")),
            "a lower invalid string must not prevent normalization of the winning value"
        );
        run(&["config", "--unset-all", "core.autocrlf"]);
        fs::write(
            &included,
            "[core]\n\tautocrlf =\n\tattributesFile = ~/global-attributes\n\texcludesFile = ~/global-ignore\n",
        )
        .unwrap();
        let empty = read_effective_repository_config_test(&repository, |command| {
            command.env("HOME", &home);
        })
        .unwrap();
        assert_eq!(
            effective_config_value(&empty, "core.autocrlf"),
            Some(OsStr::new("false")),
            "Git's explicit empty boolean must be replayed as false, not implicit true"
        );
        fs::write(
            &included,
            "[core]\n\tautocrlf\n\tattributesFile = ~/global-attributes\n\texcludesFile = ~/global-ignore\n",
        )
        .unwrap();
        let implicit = read_effective_repository_config_test(&repository, |command| {
            command.env("HOME", &home);
        })
        .unwrap();
        assert_eq!(
            effective_config_value(&implicit, "core.autocrlf"),
            Some(OsStr::new("true")),
            "Git's implicit boolean must remain true"
        );

        let local_excludes = repository.join("local-ignore");
        fs::write(&local_excludes, "local.tmp\n").unwrap();
        run(&["config", "core.autocrlf", "false"]);
        run(&["config", "core.attributesFile", ""]);
        run(&["config", "core.excludesFile", "local-ignore"]);
        fs::write(&included, "[core]\n\tautocrlf = input\n\tattributesFile = ~/global-attributes\n\texcludesFile = ~/global-ignore\n").unwrap();
        let local = read_effective_repository_config_test(&repository, |command| {
            command.env("HOME", &home);
        })
        .unwrap();
        assert_eq!(
            effective_config_value(&local, "core.autocrlf"),
            Some(OsStr::new("false")),
            "local false must override included global input"
        );
        assert_eq!(
            effective_config_value(&local, "core.attributesFile"),
            Some(OsStr::new("")),
            "an explicit empty local path must reset the global attributes file"
        );
        assert_eq!(
            effective_config_value(&local, "core.excludesFile"),
            Some(local_excludes.as_os_str())
        );
        let dirty = run_bounded_git_test(
            &repository,
            &[
                "diff",
                "--name-only",
                "-z",
                "--no-ext-diff",
                "--no-textconv",
                "--",
            ],
            &GitSafetyOverrides {
                safe_directories: Vec::new(),
                effective_config: local.clone(),
                disabled_filter_drivers: Vec::new(),
            },
            |command| {
                command.env("HOME", &home);
            },
        )
        .unwrap();
        assert!(dirty.status.success);
        assert_eq!(dirty.stdout, b"sample.attr\0");

        for name in ["global.tmp", "local.tmp", "visible.tmp"] {
            fs::write(repository.join(name), name).unwrap();
        }
        let untracked = run_bounded_git_test(
            &repository,
            &["ls-files", "--others", "--exclude-standard", "-z"],
            &GitSafetyOverrides {
                safe_directories: Vec::new(),
                effective_config: local,
                disabled_filter_drivers: Vec::new(),
            },
            |command| {
                command.env("HOME", &home);
            },
        )
        .unwrap();
        assert!(untracked.status.success);
        assert_eq!(untracked.stdout, b"global.tmp\0local-ignore\0visible.tmp\0");

        run(&["config", "extensions.worktreeConfig", "true"]);
        run(&["config", "--worktree", "core.autocrlf", "input"]);
        let worktree = read_effective_repository_config_test(&repository, |command| {
            command.env("HOME", &home);
        })
        .unwrap();
        assert_eq!(
            effective_config_value(&worktree, "core.autocrlf"),
            Some(OsStr::new("input")),
            "worktree config must override local and global values"
        );
    }

    #[test]
    #[cfg(unix)]
    fn repository_commands_neutralize_local_clean_filter_commands() {
        use std::{fs, os::unix::fs::PermissionsExt};

        let directory = tempfile::tempdir().unwrap();
        let repository = directory.path().join("repository");
        fs::create_dir(&repository).unwrap();
        let run = |arguments: &[&str]| {
            let status = Command::new("git")
                .arg("-C")
                .arg(&repository)
                .args(arguments)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .unwrap();
            assert!(status.success(), "git {arguments:?} failed");
        };
        run(&["init", "--initial-branch=main"]);
        run(&["config", "user.email", "relayer-test@example.invalid"]);
        run(&["config", "user.name", "Relayer test"]);
        fs::write(
            repository.join(".gitattributes"),
            "*.txt filter=localattack\n",
        )
        .unwrap();
        fs::write(repository.join("tracked.txt"), "baseline\n").unwrap();
        run(&["add", ".gitattributes", "tracked.txt"]);
        run(&["commit", "-m", "baseline"]);

        let marker = directory.path().join("local-filter-executed");
        let filter = directory.path().join("local-clean-filter");
        fs::write(
            &filter,
            format!("#!/bin/sh\ntouch '{}'\ncat\n", marker.display()),
        )
        .unwrap();
        let mut permissions = fs::metadata(&filter).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&filter, permissions).unwrap();
        run(&[
            "config",
            "filter.localattack.clean",
            filter.to_str().unwrap(),
        ]);
        run(&["config", "filter.localattack.required", "true"]);
        fs::write(repository.join("tracked.txt"), "changed\n").unwrap();

        let arguments = [
            "diff",
            "--numstat",
            "-z",
            "--no-ext-diff",
            "--no-textconv",
            "--",
        ];
        let unguarded = Command::new("git")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .arg("-c")
            .arg("core.fsmonitor=false")
            .arg("-c")
            .arg("core.untrackedCache=false")
            .arg("-C")
            .arg(&repository)
            .args(arguments)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(unguarded.success());
        assert!(
            marker.exists(),
            "regression fixture did not reproduce local clean-filter execution"
        );
        fs::remove_file(&marker).unwrap();

        let disabled_filter_drivers = read_local_filter_drivers_test(&repository).unwrap();
        assert_eq!(
            disabled_filter_drivers,
            [OsString::from("filter.localattack")]
        );
        assert!(
            !marker.exists(),
            "repository filter enumeration executed the configured helper"
        );
        let guarded = run_bounded_git_test(
            &repository,
            &arguments,
            &GitSafetyOverrides {
                safe_directories: Vec::new(),
                effective_config: Vec::new(),
                disabled_filter_drivers,
            },
            |_| {},
        )
        .unwrap();
        assert!(guarded.status.success, "{}", trimmed(&guarded.stderr));
        assert!(!guarded.stdout.is_empty());
        assert!(
            !marker.exists(),
            "repository diff executed a locally configured clean filter"
        );
    }

    #[test]
    #[cfg(unix)]
    fn transforming_filter_fails_closed_without_executing_the_helper() {
        use std::{fs, io::Write, os::unix::fs::PermissionsExt};

        let directory = tempfile::tempdir().unwrap();
        let repository = directory.path().join("repository");
        fs::create_dir(&repository).unwrap();
        let repository = fs::canonicalize(repository).unwrap();
        let run = |arguments: &[&str]| {
            let status = Command::new("git")
                .arg("-C")
                .arg(&repository)
                .args(arguments)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .unwrap();
            assert!(status.success(), "git {arguments:?} failed");
        };
        run(&["init", "--initial-branch=main"]);
        run(&["config", "user.email", "relayer-test@example.invalid"]);
        run(&["config", "user.name", "Relayer test"]);
        let marker = directory.path().join("transform-filter-executed");
        let helper = directory.path().join("transform-filter");
        fs::write(
            &helper,
            format!(
                "#!/bin/sh\ntouch '{}'\nsed 's/^PREFIX://'\n",
                marker.display()
            ),
        )
        .unwrap();
        let mut permissions = fs::metadata(&helper).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&helper, permissions).unwrap();
        fs::write(
            repository.join(".gitattributes"),
            "*.txt filter=transform\n",
        )
        .unwrap();
        fs::write(repository.join("tracked.txt"), "PREFIX:value\n").unwrap();
        run(&["config", "filter.transform.clean", helper.to_str().unwrap()]);
        run(&["config", "filter.transform.required", "true"]);
        run(&["add", "."]);
        run(&["commit", "-m", "baseline"]);
        fs::remove_file(&marker).unwrap();

        for contents in ["PREFIX:value\n", "PREFIX:changed\n"] {
            fs::write(repository.join("tracked.txt"), contents).unwrap();
            let snapshot = inspect_with(
                &repository,
                "project",
                &SystemGitRunner,
                Instant::now() + SNAPSHOT_TIMEOUT,
            );
            assert_eq!(snapshot.kind, EnvironmentKind::Unavailable);
            assert_eq!(
                snapshot.unavailable_reason.unwrap().code,
                "unsupported_filter"
            );
            assert!(
                !marker.exists(),
                "filter audit or shadow diff executed the transforming helper"
            );
        }
        run(&["config", "--unset-all", "filter.transform.clean"]);
        run(&["config", "filter.transform.required", "not-a-boolean"]);
        let invalid_required = inspect_with(
            &repository,
            "project",
            &SystemGitRunner,
            Instant::now() + SNAPSHOT_TIMEOUT,
        );
        assert_eq!(invalid_required.kind, EnvironmentKind::Unavailable);
        assert_eq!(
            invalid_required.unavailable_reason.unwrap().code,
            "unsupported_filter"
        );
        run(&["config", "filter.transform.required", "false"]);
        let mut config = fs::OpenOptions::new()
            .append(true)
            .open(repository.join(".git/config"))
            .unwrap();
        writeln!(config, "[filter \"transform\"]\n\tclean").unwrap();
        drop(config);
        let implicit_clean = inspect_with(
            &repository,
            "project",
            &SystemGitRunner,
            Instant::now() + SNAPSHOT_TIMEOUT,
        );
        assert_eq!(implicit_clean.kind, EnvironmentKind::Unavailable);
        assert_eq!(
            implicit_clean.unavailable_reason.unwrap().code,
            "unsupported_filter"
        );
    }

    #[test]
    fn shadow_worktree_diff_supports_sha256_split_indexes() {
        let directory = tempfile::tempdir().unwrap();
        let repository = directory.path().join("repository");
        std::fs::create_dir(&repository).unwrap();
        let initialized = Command::new("git")
            .arg("-C")
            .arg(&repository)
            .args(["init", "--initial-branch=main", "--object-format=sha256"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        if !initialized.success() {
            return;
        }
        let repository = std::fs::canonicalize(repository).unwrap();
        let run = |arguments: &[&str]| {
            let status = Command::new("git")
                .arg("-C")
                .arg(&repository)
                .args(arguments)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .unwrap();
            assert!(status.success(), "git {arguments:?} failed");
        };
        run(&["config", "user.email", "relayer-test@example.invalid"]);
        run(&["config", "user.name", "Relayer test"]);
        std::fs::write(repository.join("tracked.txt"), "baseline\n").unwrap();
        run(&["add", "tracked.txt"]);
        run(&["commit", "-m", "baseline"]);
        run(&["update-index", "--split-index"]);
        std::fs::write(repository.join("tracked.txt"), "changed\n").unwrap();

        let snapshot = inspect_with(
            &repository,
            "project",
            &SystemGitRunner,
            Instant::now() + SNAPSHOT_TIMEOUT,
        );
        assert_eq!(snapshot.kind, EnvironmentKind::Git);
        assert_eq!(snapshot.changes.tracked_files, 1);
        assert_eq!(snapshot.changes.additions, 1);
        assert_eq!(snapshot.changes.deletions, 1);
    }

    #[test]
    #[cfg(unix)]
    fn shadow_diff_does_not_reread_filter_config_added_after_snapshot() {
        use std::{fs, os::unix::fs::PermissionsExt};

        let directory = tempfile::tempdir().unwrap();
        let repository = directory.path().join("repository");
        fs::create_dir(&repository).unwrap();
        let repository = fs::canonicalize(repository).unwrap();
        let run = |arguments: &[&str]| {
            let status = Command::new("git")
                .arg("-C")
                .arg(&repository)
                .args(arguments)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .unwrap();
            assert!(status.success(), "git {arguments:?} failed");
        };
        run(&["init", "--initial-branch=main"]);
        run(&["config", "user.email", "relayer-test@example.invalid"]);
        run(&["config", "user.name", "Relayer test"]);
        fs::write(repository.join("tracked.txt"), "baseline\n").unwrap();
        run(&["add", "tracked.txt"]);
        run(&["commit", "-m", "baseline"]);
        fs::write(repository.join("tracked.txt"), "changed\n").unwrap();
        let marker = directory.path().join("late-filter-executed");
        let helper = directory.path().join("late-filter");
        fs::write(
            &helper,
            format!("#!/bin/sh\ntouch '{}'\ncat\n", marker.display()),
        )
        .unwrap();
        let mut permissions = fs::metadata(&helper).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&helper, permissions).unwrap();

        let baseline = Command::new("git")
            .arg("-C")
            .arg(&repository)
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap();
        let baseline = trimmed(&baseline.stdout);
        let (_, output) = run_shadow_diffs_with(
            &repository,
            &baseline,
            &GitSafetyOverrides::default(),
            Instant::now() + SNAPSHOT_TIMEOUT,
            || {
                fs::write(repository.join(".gitattributes"), "*.txt filter=late\n").unwrap();
                run(&["config", "filter.late.clean", helper.to_str().unwrap()]);
                run(&["config", "filter.late.required", "true"]);
            },
        )
        .unwrap();
        assert!(output.status.success, "{}", trimmed(&output.stderr));
        assert!(!output.stdout.is_empty());
        assert!(
            !marker.exists(),
            "shadow diff reread filter configuration added after its snapshot"
        );
    }

    #[test]
    #[cfg(unix)]
    fn inspection_never_lazy_fetches_missing_objects_through_ext_transport() {
        use std::{fs, os::unix::fs::PermissionsExt};

        let directory = tempfile::tempdir().unwrap();
        let repository = directory.path().join("repository");
        fs::create_dir(&repository).unwrap();
        let repository = fs::canonicalize(repository).unwrap();
        let run = |arguments: &[&str]| {
            let status = Command::new("git")
                .arg("-C")
                .arg(&repository)
                .args(arguments)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .unwrap();
            assert!(status.success(), "git {arguments:?} failed");
        };
        run(&["init", "--initial-branch=main"]);
        run(&["config", "user.email", "relayer-test@example.invalid"]);
        run(&["config", "user.name", "Relayer test"]);
        fs::write(repository.join("tracked.txt"), "baseline\n").unwrap();
        run(&["add", "tracked.txt"]);
        run(&["commit", "-m", "baseline"]);

        let baseline_blob = Command::new("git")
            .arg("-C")
            .arg(&repository)
            .args(["rev-parse", "HEAD:tracked.txt"])
            .output()
            .unwrap();
        assert!(baseline_blob.status.success());
        let baseline_blob = trimmed(&baseline_blob.stdout);
        let object = repository
            .join(".git/objects")
            .join(&baseline_blob[..2])
            .join(&baseline_blob[2..]);

        fs::write(repository.join("tracked.txt"), "staged\n").unwrap();
        run(&["add", "tracked.txt"]);
        fs::remove_file(object).unwrap();

        let marker = directory.path().join("ext-transport-executed");
        let helper = directory.path().join("ext-transport");
        fs::write(
            &helper,
            format!("#!/bin/sh\ntouch '{}'\nexit 1\n", marker.display()),
        )
        .unwrap();
        let mut permissions = fs::metadata(&helper).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&helper, permissions).unwrap();
        run(&["config", "extensions.partialClone", "origin"]);
        run(&["config", "remote.origin.promisor", "true"]);
        run(&["config", "remote.origin.partialclonefilter", "blob:none"]);
        run(&[
            "config",
            "remote.origin.url",
            &format!("ext::{}", helper.display()),
        ]);
        run(&["config", "protocol.ext.allow", "always"]);

        let snapshot = inspect_with(
            &repository,
            "project",
            &SystemGitRunner,
            Instant::now() + SNAPSHOT_TIMEOUT,
        );
        assert_eq!(snapshot.kind, EnvironmentKind::Unavailable);
        assert_eq!(snapshot.unavailable_reason.unwrap().code, "git_failed");
        assert!(
            !marker.exists(),
            "repository inspection invoked a lazy-fetch transport helper"
        );
    }

    #[test]
    fn check_attr_chunks_respect_encoded_argument_budget() {
        let budget = 24 * 1024;
        let first = vec![b'a'; budget / 4 + 32];
        let second = vec![b'b'; budget / 4 + 32];
        let paths = vec![first.as_slice(), second.as_slice(), b"short".as_slice()];
        assert_eq!(check_attr_chunk_end(&paths, 0, budget).unwrap(), 1);
        assert_eq!(check_attr_chunk_end(&paths, 1, budget).unwrap(), 3);

        let oversized = vec![b'x'; budget];
        assert!(matches!(
            check_attr_chunk_end(&[oversized.as_slice()], 0, budget),
            Err(GitRunError::OutputTooLarge)
        ));
    }

    #[test]
    fn snapshot_copy_is_bounded_and_honors_its_deadline() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source");
        let destination = directory.path().join("destination");
        std::fs::write(&source, b"snapshot").unwrap();
        copy_snapshot_file(
            &source,
            &destination,
            8,
            true,
            Instant::now() + Duration::from_secs(1),
        )
        .unwrap();
        assert_eq!(std::fs::read(destination).unwrap(), b"snapshot");

        assert!(matches!(
            copy_snapshot_file(
                &source,
                &directory.path().join("oversized"),
                7,
                true,
                Instant::now() + Duration::from_secs(1),
            ),
            Err(GitRunError::OutputTooLarge)
        ));
        assert!(matches!(
            copy_snapshot_file(
                &source,
                &directory.path().join("expired"),
                8,
                true,
                Instant::now(),
            ),
            Err(GitRunError::Timeout(_))
        ));
    }

    #[test]
    #[cfg(unix)]
    fn snapshot_hash_rejects_a_fifo_swap_without_blocking() {
        use std::{ffi::CString, os::unix::ffi::OsStrExt as _};

        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("index");
        std::fs::write(&source, b"snapshot").unwrap();
        let started = Instant::now();
        let mut hasher = Sha256::new();
        let result = hash_snapshot_file_with_before_open(
            &source,
            &mut hasher,
            true,
            Instant::now() + Duration::from_millis(500),
            || {
                std::fs::remove_file(&source).unwrap();
                let source = CString::new(source.as_os_str().as_bytes()).unwrap();
                // SAFETY: source is a live NUL-terminated pathname and mkfifo does
                // not retain the pointer.
                assert_eq!(unsafe { libc::mkfifo(source.as_ptr(), 0o600) }, 0);
            },
        );
        assert!(matches!(result, Err(GitRunError::Output(_))));
        assert!(
            started.elapsed() < Duration::from_millis(500),
            "opening a swapped FIFO blocked past the snapshot deadline"
        );
    }

    #[test]
    fn windows_snapshot_identity_requires_matching_volume_and_file_index() {
        assert!(same_windows_snapshot_identity(
            Some(7),
            Some(42),
            Some(7),
            Some(42)
        ));
        assert!(!same_windows_snapshot_identity(
            Some(7),
            Some(42),
            Some(8),
            Some(42)
        ));
        assert!(!same_windows_snapshot_identity(
            Some(7),
            Some(42),
            Some(7),
            Some(43)
        ));
        assert!(!same_windows_snapshot_identity(
            Some(7),
            Some(42),
            None,
            Some(42)
        ));
    }

    #[test]
    #[cfg(unix)]
    fn initialized_gitlink_fails_closed_before_submodule_helpers_can_run() {
        use std::{fs, os::unix::fs::PermissionsExt};

        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source");
        let repository = directory.path().join("repository");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&repository).unwrap();
        let run = |path: &Path, arguments: &[&str]| {
            let status = Command::new("git")
                .arg("-C")
                .arg(path)
                .args(arguments)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .unwrap();
            assert!(status.success(), "git {arguments:?} failed");
        };
        for path in [&source, &repository] {
            run(path, &["init", "--initial-branch=main"]);
            run(
                path,
                &["config", "user.email", "relayer-test@example.invalid"],
            );
            run(path, &["config", "user.name", "Relayer test"]);
        }
        fs::write(source.join("tracked.txt"), "baseline\n").unwrap();
        run(&source, &["add", "tracked.txt"]);
        run(&source, &["commit", "-m", "baseline"]);
        run(
            &repository,
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                source.to_str().unwrap(),
                "sub",
            ],
        );
        run(&repository, &["commit", "-am", "submodule"]);
        let marker = directory.path().join("submodule-helper-executed");
        let helper = directory.path().join("submodule-helper");
        fs::write(
            &helper,
            format!("#!/bin/sh\ntouch '{}'\n", marker.display()),
        )
        .unwrap();
        let mut permissions = fs::metadata(&helper).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&helper, permissions).unwrap();
        run(
            &repository.join("sub"),
            &["config", "core.fsmonitor", helper.to_str().unwrap()],
        );
        fs::write(repository.join("sub/tracked.txt"), "changed\n").unwrap();
        let repository = fs::canonicalize(repository).unwrap();
        let snapshot = inspect_with(
            &repository,
            "project",
            &SystemGitRunner,
            Instant::now() + SNAPSHOT_TIMEOUT,
        );
        assert_eq!(snapshot.kind, EnvironmentKind::Unavailable);
        assert_eq!(
            snapshot.unavailable_reason.unwrap().code,
            "unsupported_submodule"
        );
        assert!(!marker.exists(), "inspection executed a submodule helper");
    }

    #[test]
    #[cfg(unix)]
    fn global_ignore_submodules_all_preserves_diff_semantics_without_helpers() {
        use std::{fs, os::unix::fs::PermissionsExt};

        struct HomeSystemGitRunner(PathBuf);

        impl GitRunner for HomeSystemGitRunner {
            fn effective_repository_config(
                &self,
                repository: &Path,
                safe_directories: &[OsString],
                deadline: Instant,
            ) -> Result<Vec<(OsString, OsString)>, GitRunError> {
                read_effective_repository_config_with(
                    repository,
                    safe_directories,
                    deadline,
                    |command| {
                        command.env("HOME", &self.0).env_remove("GIT_CONFIG_GLOBAL");
                    },
                )
            }

            fn validate_repository_selection(
                &self,
                selected_path: &Path,
                reported_root: &Path,
                safety: &GitSafetyOverrides,
                deadline: Instant,
            ) -> Result<PathBuf, GitRunError> {
                validate_repository_identity(selected_path, reported_root, safety, deadline)
            }

            fn has_applied_transform_filter(
                &self,
                repository: &Path,
                safety: &GitSafetyOverrides,
                deadline: Instant,
            ) -> Result<bool, GitRunError> {
                has_applied_transform_filter(repository, safety, deadline)
            }

            fn has_initialized_gitlink(
                &self,
                repository: &Path,
                safety: &GitSafetyOverrides,
                deadline: Instant,
            ) -> Result<bool, GitRunError> {
                has_initialized_gitlink(repository, safety, deadline)
            }

            fn repository_state_token(
                &self,
                repository: &Path,
                safety: &GitSafetyOverrides,
                deadline: Instant,
            ) -> Result<Vec<u8>, GitRunError> {
                repository_state_token(repository, safety, deadline)
            }

            fn diff_outputs(
                &self,
                repository: &Path,
                baseline: &str,
                safety: &GitSafetyOverrides,
                deadline: Instant,
            ) -> Result<(GitOutput, GitOutput), GitRunError> {
                run_shadow_diffs(repository, baseline, safety, deadline)
            }

            fn run(
                &self,
                path: &Path,
                arguments: &[&str],
                safety: &GitSafetyOverrides,
                timeout: Duration,
            ) -> Result<GitOutput, GitRunError> {
                run_bounded_command_with_safety(
                    OsStr::new("git"),
                    path,
                    arguments,
                    safety,
                    timeout,
                    |command| {
                        command.env("HOME", &self.0);
                    },
                )
            }
        }

        let directory = tempfile::tempdir().unwrap();
        let home = directory.path().join("home");
        let source = directory.path().join("source");
        let repository = directory.path().join("repository");
        fs::create_dir(&home).unwrap();
        fs::create_dir(&source).unwrap();
        fs::create_dir(&repository).unwrap();
        let run = |path: &Path, arguments: &[&str]| {
            let status = Command::new("git")
                .arg("-C")
                .arg(path)
                .args(arguments)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .unwrap();
            assert!(status.success(), "git {arguments:?} failed");
        };
        for path in [&source, &repository] {
            run(path, &["init", "--initial-branch=main"]);
            run(
                path,
                &["config", "user.email", "relayer-test@example.invalid"],
            );
            run(path, &["config", "user.name", "Relayer test"]);
        }
        fs::write(source.join("tracked.txt"), "baseline\n").unwrap();
        run(&source, &["add", "tracked.txt"]);
        run(&source, &["commit", "-m", "baseline"]);
        run(
            &repository,
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                source.to_str().unwrap(),
                "sub",
            ],
        );
        run(&repository, &["commit", "-am", "submodule"]);

        let marker = directory.path().join("submodule-helper-executed");
        let helper = directory.path().join("submodule-helper");
        fs::write(
            &helper,
            format!("#!/bin/sh\ntouch '{}'\nexit 0\n", marker.display()),
        )
        .unwrap();
        let mut permissions = fs::metadata(&helper).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&helper, permissions).unwrap();
        run(
            &repository.join("sub"),
            &["config", "core.fsmonitor", helper.to_str().unwrap()],
        );
        fs::write(repository.join("sub/tracked.txt"), "diverged\n").unwrap();
        fs::write(
            home.join(".gitconfig"),
            "[diff]\n\tignoreSubmodules = all\n",
        )
        .unwrap();
        let repository = fs::canonicalize(repository).unwrap();

        // Prove the configured helper is live, then clear the marker before the
        // ordinary and isolated parent-repository comparisons.
        run(&repository.join("sub"), &["status", "--porcelain"]);
        assert!(marker.exists(), "submodule helper fixture was not active");
        fs::remove_file(&marker).unwrap();

        let ordinary = Command::new("git")
            .arg("-C")
            .arg(&repository)
            .args(["diff", "--numstat", "-z", "--"])
            .env("HOME", &home)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env_remove("GIT_CONFIG_GLOBAL")
            .output()
            .unwrap();
        assert!(ordinary.status.success());
        assert!(ordinary.stdout.is_empty());
        assert!(!marker.exists(), "ordinary ignored diff invoked a helper");

        let effective = read_effective_repository_config_with(
            &repository,
            &[],
            Instant::now() + SNAPSHOT_TIMEOUT,
            |command| {
                command.env("HOME", &home).env_remove("GIT_CONFIG_GLOBAL");
            },
        )
        .unwrap();
        let safety = GitSafetyOverrides {
            effective_config: effective,
            ..GitSafetyOverrides::default()
        };
        assert!(ignores_all_submodules(&safety));
        assert!(
            has_initialized_gitlink(&repository, &safety, Instant::now() + SNAPSHOT_TIMEOUT)
                .unwrap(),
            "fixture must exercise the initialized-gitlink bypass"
        );
        let baseline = Command::new("git")
            .arg("-C")
            .arg(&repository)
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap();
        assert!(baseline.status.success());
        let (staged, worktree) = run_shadow_diffs(
            &repository,
            &trimmed(&baseline.stdout),
            &safety,
            Instant::now() + SNAPSHOT_TIMEOUT,
        )
        .unwrap();
        assert!(staged.status.success, "{}", trimmed(&staged.stderr));
        assert!(worktree.status.success, "{}", trimmed(&worktree.stderr));
        assert_eq!(staged.stdout, ordinary.stdout);
        assert_eq!(worktree.stdout, ordinary.stdout);
        assert!(!marker.exists(), "shadow diff invoked a submodule helper");

        let snapshot = inspect_with(
            &repository,
            "project",
            &HomeSystemGitRunner(home),
            Instant::now() + SNAPSHOT_TIMEOUT,
        );
        assert_eq!(snapshot.kind, EnvironmentKind::Git);
        assert_eq!(snapshot.changes, EnvironmentChanges::default());
        assert!(!marker.exists(), "environment inspection invoked a helper");
    }

    #[test]
    #[cfg(unix)]
    fn unrepresentable_local_filter_driver_fails_closed_before_diff() {
        use std::{fs, os::unix::fs::PermissionsExt};

        let directory = tempfile::tempdir().unwrap();
        let repository = canonical_temp(&directory);
        let run = |arguments: &[&str]| {
            let status = Command::new("git")
                .arg("-C")
                .arg(&repository)
                .args(arguments)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .unwrap();
            assert!(status.success(), "git {arguments:?} failed");
        };
        run(&["init", "--initial-branch=main"]);
        run(&["config", "user.email", "relayer-test@example.invalid"]);
        run(&["config", "user.name", "Relayer test"]);
        fs::write(repository.join(".gitattributes"), "*.txt filter=evil=x\n").unwrap();
        fs::write(repository.join("tracked.txt"), "baseline\n").unwrap();
        run(&["add", ".gitattributes", "tracked.txt"]);
        run(&["commit", "-m", "baseline"]);

        let marker = repository.join("equals-filter-executed");
        let filter = repository.join("equals-clean-filter");
        fs::write(
            &filter,
            format!("#!/bin/sh\ntouch '{}'\ncat\n", marker.display()),
        )
        .unwrap();
        let mut permissions = fs::metadata(&filter).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&filter, permissions).unwrap();
        run(&["config", "filter.evil=x.clean", filter.to_str().unwrap()]);
        run(&["config", "filter.evil=x.required", "true"]);
        fs::write(repository.join("tracked.txt"), "changed\n").unwrap();

        let unguarded = Command::new("git")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .arg("-C")
            .arg(&repository)
            .args([
                "diff",
                "--numstat",
                "-z",
                "--no-ext-diff",
                "--no-textconv",
                "--",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(unguarded.success());
        assert!(
            marker.exists(),
            "regression fixture did not execute the equals-sign filter driver"
        );
        fs::remove_file(&marker).unwrap();

        let snapshot = inspect_with(
            &repository,
            "project",
            &SystemGitRunner,
            Instant::now() + SNAPSHOT_TIMEOUT,
        );
        assert_eq!(snapshot.kind, EnvironmentKind::Unavailable);
        assert_eq!(
            snapshot.unavailable_reason.unwrap().code,
            "unsupported_filter"
        );
        assert!(
            !marker.exists(),
            "inspection reached diff after an unrepresentable filter driver"
        );
    }

    #[test]
    #[cfg(unix)]
    fn setsid_descendant_cannot_retain_writable_capture_storage() {
        use std::{fs, os::unix::fs::PermissionsExt};

        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("escaped-writer-closed");
        let fixture = directory.path().join("setsid-fixture");
        fs::write(
            &fixture,
            "#!/bin/sh\nperl -MPOSIX=setsid -e '$SIG{PIPE}=\"IGNORE\"; if (fork() == 0) { setsid(); while (syswrite(STDOUT, \"x\" x 4096)) {} open(my $f, \">\", $ENV{RELAYER_ESCAPE_MARKER}); print $f \"closed\"; exit 0; } exit 0;'\n",
        )
        .unwrap();
        let mut permissions = fs::metadata(&fixture).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&fixture, permissions).unwrap();
        let started = Instant::now();
        let result = run_bounded_command_with(
            fixture.as_os_str(),
            directory.path(),
            &[],
            Duration::from_millis(500),
            |command| {
                command.env("RELAYER_ESCAPE_MARKER", &marker);
            },
        );
        assert!(matches!(result, Ok(_) | Err(GitRunError::OutputTooLarge)));
        assert!(started.elapsed() < Duration::from_secs(1));
        for _ in 0..100 {
            if marker.exists() {
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }
        assert!(
            marker.exists(),
            "escaped writer never observed its closed pipe"
        );
    }

    #[test]
    #[cfg(unix)]
    fn process_group_cleanup_distinguishes_gone_from_retryable_failures() {
        let gone = io::Error::from_raw_os_error(3);
        assert!(process_group_is_gone(&gone, false));
        let zombie_only_group = io::Error::from(io::ErrorKind::PermissionDenied);
        assert!(!process_group_is_gone(&zombie_only_group, false));
        assert!(process_group_is_gone(&zombie_only_group, true));
        let retryable = io::Error::other("retry cleanup");
        assert!(!process_group_is_gone(&retryable, true));
    }

    #[test]
    fn persistent_direct_child_errors_respect_the_cleanup_deadline() {
        let calls = AtomicUsize::new(0);
        let started = Instant::now();
        let finished = retry_cleanup_until(Instant::now() + Duration::from_millis(30), || {
            calls.fetch_add(1, Ordering::SeqCst);
            false
        });
        assert!(!finished);
        assert!(started.elapsed() < Duration::from_millis(100));
        assert!((2..=10).contains(&calls.load(Ordering::SeqCst)));
    }

    #[test]
    fn failed_cleanup_enqueue_returns_ownership_to_the_caller() {
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        drop(receiver);
        let item = String::from("owned cleanup");
        assert_eq!(try_send_owned(&sender, item), Err("owned cleanup".into()));
    }
}
