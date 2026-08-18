use serde_json::Value;
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    process::{Command, Stdio},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[test]
fn reads_private_control_token_from_stdin_and_exits_with_desktop_parent() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "relayer-graph-server-parent-exit-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir_all(&root).unwrap();

    let mut child = Command::new(env!("CARGO_BIN_EXE_relayer-graph-server"))
        .args([
            "--database",
            root.join("graph.sqlite3").to_str().unwrap(),
            "--port",
            "0",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();

    let mut control_pipe = child.stdin.take().unwrap();
    writeln!(
        control_pipe,
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    )
    .unwrap();
    control_pipe.flush().unwrap();

    let mut ready_line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut ready_line)
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&ready_line).unwrap()["ready"],
        true
    );

    drop(control_pipe);
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    let exit_status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if std::time::Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("Relayer graph server remained alive after its desktop control pipe closed");
        }
        thread::sleep(Duration::from_millis(10));
    };
    assert!(exit_status.success());
    fs::remove_dir_all(root).unwrap();
}
