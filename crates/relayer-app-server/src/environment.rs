use serde::Serialize;
use std::{
    ffi::{OsStr, OsString},
    io::{self, Read},
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant, SystemTime},
};

const GIT_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_STDOUT_BYTES: usize = 256 * 1024;
const MAX_STDERR_BYTES: usize = 32 * 1024;

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

pub(crate) async fn inspect(path: PathBuf) -> EnvironmentSnapshot {
    let fallback_label = folder_label(&path);
    match tokio::task::spawn_blocking(move || inspect_with(&path, &SystemGitRunner)).await {
        Ok(snapshot) => snapshot,
        Err(error) => EnvironmentSnapshot::unavailable(
            fallback_label,
            "inspection_failed",
            format!("Environment inspection could not finish: {error}"),
        ),
    }
}

trait GitRunner {
    fn run(&self, path: &Path, arguments: &[&str]) -> Result<GitOutput, GitRunError>;
}

struct SystemGitRunner;

impl GitRunner for SystemGitRunner {
    fn run(&self, path: &Path, arguments: &[&str]) -> Result<GitOutput, GitRunError> {
        run_bounded_command(OsStr::new("git"), path, arguments, GIT_TIMEOUT)
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
}

fn inspect_with(path: &Path, git: &impl GitRunner) -> EnvironmentSnapshot {
    let fallback_label = folder_label(path);
    if !path.is_dir() {
        return EnvironmentSnapshot::unavailable(
            fallback_label,
            "path_unavailable",
            "The project folder is missing or is not a directory.".into(),
        );
    }

    let repository = match git.run(
        path,
        &["rev-parse", "--path-format=absolute", "--show-toplevel"],
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
    let worktree_label = folder_label(&repository);

    let branch_output = match git.run(&repository, &["symbolic-ref", "--quiet", "--short", "HEAD"])
    {
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

    let head_output = match git.run(&repository, &["rev-parse", "--verify", "HEAD"]) {
        Ok(output) => output,
        Err(error) => return unavailable_from_error(worktree_label, error),
    };
    let baseline = if head_output.status.success {
        trimmed(&head_output.stdout)
    } else {
        let empty_tree = match git.run(&repository, &["hash-object", "-t", "tree", "--stdin"]) {
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

    let diff_output = match git.run(
        &repository,
        &[
            "diff",
            "--shortstat",
            "--no-ext-diff",
            "--no-textconv",
            &baseline,
            "--",
        ],
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

    let untracked_output = match git.run(
        &repository,
        &["ls-files", "--others", "--exclude-standard", "-z"],
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
    };
    EnvironmentSnapshot::unavailable(label, code, error.to_string())
}

fn folder_label(path: &Path) -> String {
    path.file_name()
        .filter(|name| !name.is_empty())
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
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
    let child = Command::new(executable)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C")
        .arg("-c")
        .arg("core.fsmonitor=false")
        .arg("-c")
        .arg("core.untrackedCache=false")
        .arg("-C")
        .arg(path)
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(GitRunError::Start)?;
    let mut running = RunningCommand::new(child);
    let stdout = running
        .child
        .stdout
        .take()
        .ok_or_else(|| GitRunError::Output(io::Error::other("missing piped stdout")))?;
    let stderr = running
        .child
        .stderr
        .take()
        .ok_or_else(|| GitRunError::Output(io::Error::other("missing piped stderr")))?;
    let exceeded = Arc::new(AtomicBool::new(false));
    running.stdout_reader = Some(
        spawn_bounded_reader(stdout, MAX_STDOUT_BYTES, exceeded.clone())
            .map_err(GitRunError::Output)?,
    );
    running.stderr_reader = Some(
        spawn_bounded_reader(stderr, MAX_STDERR_BYTES, exceeded.clone())
            .map_err(GitRunError::Output)?,
    );
    let deadline = Instant::now() + timeout;

    let status = loop {
        if exceeded.load(Ordering::Acquire) {
            return Err(GitRunError::OutputTooLarge);
        }
        if let Some(status) = running.child.try_wait().map_err(GitRunError::Output)? {
            break status;
        }
        if Instant::now() >= deadline {
            return Err(GitRunError::Timeout(timeout));
        }
        thread::sleep(Duration::from_millis(10));
    };
    let (stdout, stderr) = running.collect_output()?;
    if exceeded.load(Ordering::Acquire) {
        return Err(GitRunError::OutputTooLarge);
    }
    Ok(GitOutput {
        status: status.into(),
        stdout,
        stderr,
    })
}

struct RunningCommand {
    child: Child,
    stdout_reader: Option<thread::JoinHandle<io::Result<Vec<u8>>>>,
    stderr_reader: Option<thread::JoinHandle<io::Result<Vec<u8>>>>,
}

impl RunningCommand {
    fn new(child: Child) -> Self {
        Self {
            child,
            stdout_reader: None,
            stderr_reader: None,
        }
    }

    fn collect_output(&mut self) -> Result<(Vec<u8>, Vec<u8>), GitRunError> {
        let stdout = join_reader(self.stdout_reader.take(), "stdout");
        let stderr = join_reader(self.stderr_reader.take(), "stderr");
        Ok((stdout?, stderr?))
    }

    fn cleanup(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(reader) = self.stdout_reader.take() {
            let _ = reader.join();
        }
        if let Some(reader) = self.stderr_reader.take() {
            let _ = reader.join();
        }
    }
}

impl Drop for RunningCommand {
    fn drop(&mut self) {
        self.cleanup();
    }
}

fn join_reader(
    reader: Option<thread::JoinHandle<io::Result<Vec<u8>>>>,
    stream: &str,
) -> Result<Vec<u8>, GitRunError> {
    reader
        .ok_or_else(|| GitRunError::Output(io::Error::other(format!("missing {stream} reader"))))?
        .join()
        .map_err(|_| GitRunError::Output(io::Error::other(format!("{stream} reader panicked"))))?
        .map_err(GitRunError::Output)
}

fn spawn_bounded_reader(
    mut reader: impl Read + Send + 'static,
    maximum: usize,
    exceeded: Arc<AtomicBool>,
) -> io::Result<thread::JoinHandle<io::Result<Vec<u8>>>> {
    thread::Builder::new()
        .name("relayer-git-output".into())
        .spawn(move || {
            let mut captured = Vec::new();
            let mut buffer = [0_u8; 8192];
            loop {
                let read = reader.read(&mut buffer)?;
                if read == 0 {
                    return Ok(captured);
                }
                if captured.len().saturating_add(read) > maximum {
                    exceeded.store(true, Ordering::Release);
                } else {
                    captured.extend_from_slice(&buffer[..read]);
                }
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::VecDeque, sync::Mutex};

    struct FakeGitRunner(Mutex<VecDeque<Result<GitOutput, GitRunError>>>);

    impl FakeGitRunner {
        fn new(outputs: Vec<Result<GitOutput, GitRunError>>) -> Self {
            Self(Mutex::new(outputs.into()))
        }
    }

    impl GitRunner for FakeGitRunner {
        fn run(&self, _path: &Path, _arguments: &[&str]) -> Result<GitOutput, GitRunError> {
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

    #[test]
    fn parses_git_snapshot_and_keeps_untracked_separate() {
        let directory = tempfile::tempdir().unwrap();
        let git = FakeGitRunner::new(vec![
            output(0, directory.path().to_str().unwrap(), ""),
            output(0, "codex/environment-panel\n", ""),
            output(0, "abc123\n", ""),
            output(
                0,
                " 3 files changed, 18 insertions(+), 4 deletions(-)\n",
                "",
            ),
            output(0, "first.txt\0folder/second.txt\0", ""),
        ]);
        let snapshot = inspect_with(directory.path(), &git);
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
        let git = FakeGitRunner::new(vec![
            output(0, directory.path().to_str().unwrap(), ""),
            output(1, "", ""),
            output(0, "abc123\n", ""),
            output(0, "", ""),
            output(0, "", ""),
        ]);
        let snapshot = inspect_with(directory.path(), &git);
        assert_eq!(snapshot.kind, EnvironmentKind::Git);
        assert_eq!(snapshot.branch, None);
        assert!(snapshot.detached);
        assert_eq!(snapshot.changes, EnvironmentChanges::default());
    }

    #[test]
    fn non_git_folder_is_not_an_error() {
        let directory = tempfile::tempdir().unwrap();
        let git = FakeGitRunner::new(vec![output(
            128,
            "",
            "fatal: not a git repository (or any of the parent directories): .git\n",
        )]);
        let snapshot = inspect_with(directory.path(), &git);
        assert_eq!(snapshot.kind, EnvironmentKind::Folder);
        assert_eq!(snapshot.branch, None);
        assert_eq!(snapshot.changes, EnvironmentChanges::default());
    }

    #[test]
    fn missing_path_is_unavailable_without_running_git() {
        let path = Path::new("/definitely/missing/relayer-environment-test");
        let snapshot = inspect_with(path, &FakeGitRunner::new(vec![]));
        assert_eq!(snapshot.kind, EnvironmentKind::Unavailable);
        assert_eq!(
            snapshot.unavailable_reason.unwrap().code,
            "path_unavailable"
        );
    }

    #[test]
    fn missing_git_timeout_and_large_output_have_distinct_safe_states() {
        let directory = tempfile::tempdir().unwrap();
        for (error, code) in [
            (
                GitRunError::Start(io::Error::new(io::ErrorKind::NotFound, "missing")),
                "git_unavailable",
            ),
            (GitRunError::Timeout(GIT_TIMEOUT), "git_timeout"),
            (GitRunError::OutputTooLarge, "git_output_too_large"),
        ] {
            let snapshot = inspect_with(directory.path(), &FakeGitRunner::new(vec![Err(error)]));
            assert_eq!(snapshot.kind, EnvironmentKind::Unavailable);
            assert_eq!(snapshot.unavailable_reason.unwrap().code, code);
        }
    }

    #[test]
    fn invalid_git_output_degrades_safely() {
        let directory = tempfile::tempdir().unwrap();
        let git = FakeGitRunner::new(vec![
            output(0, directory.path().to_str().unwrap(), ""),
            output(0, "main", ""),
            output(0, "abc123", ""),
            output(0, "unexpected", ""),
        ]);
        let snapshot = inspect_with(directory.path(), &git);
        assert_eq!(snapshot.kind, EnvironmentKind::Unavailable);
        assert_eq!(
            snapshot.unavailable_reason.unwrap().code,
            "git_output_invalid"
        );
    }

    #[test]
    fn unborn_repository_uses_an_empty_tree_baseline() {
        let directory = tempfile::tempdir().unwrap();
        let git = FakeGitRunner::new(vec![
            output(0, directory.path().to_str().unwrap(), ""),
            output(0, "main", ""),
            output(128, "", "fatal: Needed a single revision"),
            output(0, "empty-tree-id", ""),
            output(0, " 1 file changed, 2 insertions(+)", ""),
            output(0, "new.txt\0", ""),
        ]);
        let snapshot = inspect_with(directory.path(), &git);
        assert_eq!(snapshot.kind, EnvironmentKind::Git);
        assert_eq!(snapshot.branch.as_deref(), Some("main"));
        assert_eq!(snapshot.changes.tracked_files, 1);
        assert_eq!(snapshot.changes.additions, 2);
        assert_eq!(snapshot.changes.untracked_files, 1);
    }

    #[test]
    #[cfg(unix)]
    fn repository_root_preserves_non_utf8_os_path_bytes() {
        use std::os::unix::ffi::OsStrExt;

        let path = repository_path(b"/tmp/relayer-\xff-worktree\n").unwrap();
        assert_eq!(path.as_os_str().as_bytes(), b"/tmp/relayer-\xff-worktree");
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
    }
}
