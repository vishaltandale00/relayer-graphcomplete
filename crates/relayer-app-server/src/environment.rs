use command_group::{CommandGroup, GroupChild};
use serde::Serialize;
use std::{
    collections::HashMap,
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
const MAX_PENDING_INSPECTIONS: usize = 32;
const MAX_STDOUT_BYTES: usize = 256 * 1024;
const MAX_STDERR_BYTES: usize = 32 * 1024;
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
    fn run(
        &self,
        path: &Path,
        arguments: &[&str],
        timeout: Duration,
    ) -> Result<GitOutput, GitRunError>;
}

struct SystemGitRunner;

impl GitRunner for SystemGitRunner {
    fn run(
        &self,
        path: &Path,
        arguments: &[&str],
        timeout: Duration,
    ) -> Result<GitOutput, GitRunError> {
        run_bounded_command(OsStr::new("git"), path, arguments, timeout)
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

    let repository = match run_git(
        git,
        path,
        &["rev-parse", "--path-format=absolute", "--show-toplevel"],
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
    let worktree_label = folder_label(&repository, project_name);

    let branch_output = match run_git(
        git,
        &repository,
        &["symbolic-ref", "--quiet", "--short", "HEAD"],
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

    let diff_output = match run_git(
        git,
        &repository,
        &[
            "diff",
            "--shortstat",
            "--no-ext-diff",
            "--no-textconv",
            &baseline,
            "--",
        ],
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
    let (tracked_files, additions, deletions) = match parse_shortstat(&trimmed(&diff_output.stdout))
    {
        Some(counts) => counts,
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
            tracked_files,
            additions,
            deletions,
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
    deadline: Instant,
) -> Result<GitOutput, GitRunError> {
    let remaining = deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .ok_or(GitRunError::Timeout(SNAPSHOT_TIMEOUT))?;
    git.run(path, arguments, remaining)
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

fn parse_shortstat(summary: &str) -> Option<(u64, u64, u64)> {
    if summary.is_empty() {
        return Some((0, 0, 0));
    }
    let mut tracked_files = None;
    let mut additions = 0;
    let mut deletions = 0;
    for part in summary.split(',').map(str::trim) {
        let count = part.split_whitespace().next()?.parse::<u64>().ok()?;
        if part.contains("file changed") || part.contains("files changed") {
            tracked_files = Some(count);
        } else if part.contains("insertion") {
            additions = count;
        } else if part.contains("deletion") {
            deletions = count;
        }
    }
    Some((tracked_files?, additions, deletions))
}

fn observed_at() -> String {
    time::OffsetDateTime::from(SystemTime::now())
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".into())
}

fn run_bounded_command(
    executable: &OsStr,
    path: &Path,
    arguments: &[&str],
    timeout: Duration,
) -> Result<GitOutput, GitRunError> {
    run_bounded_command_with(executable, path, arguments, timeout, |_| {})
}

fn run_bounded_command_with(
    executable: &OsStr,
    path: &Path,
    arguments: &[&str],
    timeout: Duration,
    configure: impl FnOnce(&mut Command),
) -> Result<GitOutput, GitRunError> {
    let mut command = Command::new(executable);
    configure(&mut command);
    sanitize_git_environment(&mut command);
    command
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C")
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
        "GIT_CONFIG_PARAMETERS",
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
    let null_config = if cfg!(windows) { "NUL" } else { "/dev/null" };
    command
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_SYSTEM", null_config)
        .env("GIT_CONFIG_GLOBAL", null_config)
        .env("GIT_ATTR_NOSYSTEM", "1");
}

struct CommandSlot;

impl CommandSlot {
    fn acquire() -> Result<Self, GitRunError> {
        ACTIVE_COMMANDS
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |active| {
                (active < MAX_CONCURRENT_INSPECTIONS).then_some(active + 1)
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

    #[test]
    fn parses_git_snapshot_and_keeps_untracked_separate() {
        let directory = tempfile::tempdir().unwrap();
        let path = canonical_temp(&directory);
        let git = FakeGitRunner::new(vec![
            output(0, path.to_str().unwrap(), ""),
            output(0, "codex/environment-panel\n", ""),
            output(0, "abc123\n", ""),
            output(
                0,
                " 3 files changed, 18 insertions(+), 4 deletions(-)\n",
                "",
            ),
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
            output(0, " 1 file changed, 2 insertions(+)", ""),
            output(0, "new.txt\0", ""),
        ]);
        let snapshot = inspect_with(&path, "project", &git, Instant::now() + SNAPSHOT_TIMEOUT);
        assert_eq!(snapshot.kind, EnvironmentKind::Git);
        assert_eq!(snapshot.branch.as_deref(), Some("main"));
        assert_eq!(snapshot.changes.tracked_files, 1);
        assert_eq!(snapshot.changes.additions, 2);
        assert_eq!(snapshot.changes.untracked_files, 1);
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
        assert!(matches!(
            output,
            Ok(GitOutput {
                status: GitExit { success: true, .. },
                ..
            }) | Err(GitRunError::Timeout(_))
        ));
        assert!(started.elapsed() < Duration::from_secs(1));
        let pid = fs::read_to_string(descendant_pid).unwrap();
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
            "#!/bin/sh\nprintf '%s|%s|%s|%s|%s|%s|%s|%s|%s' \"${GIT_DIR-unset}\" \"${GIT_WORK_TREE-unset}\" \"${GIT_INDEX_FILE-unset}\" \"${GIT_CONFIG_PARAMETERS-unset}\" \"${GIT_CONFIG_COUNT-unset}\" \"${GIT_CONFIG_KEY_0-unset}\" \"${GIT_CONFIG_VALUE_0-unset}\" \"${GIT_TRACE-unset}\" \"${GIT_TRACE2_EVENT-unset}\"\n",
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
            "unset|unset|unset|unset|unset|unset|unset|unset|unset"
        );

        let repository = directory.path().join("repository");
        fs::create_dir(&repository).unwrap();
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
