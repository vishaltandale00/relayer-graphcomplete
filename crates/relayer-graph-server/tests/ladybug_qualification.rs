#![cfg(feature = "ladybug")]

use std::{
    io::{BufRead, BufReader},
    process::{Command, Stdio},
    thread::sleep,
    time::{Duration, Instant},
};

fn json_line(bytes: &[u8]) -> serde_json::Value {
    serde_json::from_slice(bytes).unwrap()
}

#[test]
fn qualification_mode_proves_lock_shutdown_and_reopen() {
    let temp = tempfile::tempdir().unwrap();
    let database = temp.path().join("ladybug");
    let executable = option_env!("CARGO_BIN_EXE_relayer-graph-server")
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("CARGO_BIN_EXE_relayer-graph-server").map(Into::into))
        .expect("Cargo must provide the relayer-graph-server test executable");

    let created = Command::new(&executable)
        .args([
            "--database",
            database.to_str().unwrap(),
            "--ladybug-qualification",
        ])
        .output()
        .unwrap();
    assert!(
        created.status.success(),
        "{}",
        String::from_utf8_lossy(&created.stderr)
    );
    assert_eq!(json_line(&created.stdout)["state"], "created");

    let mut holder = Command::new(&executable)
        .args([
            "--database",
            database.to_str().unwrap(),
            "--ladybug-qualification",
            "--ladybug-qualification-hold",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut output = BufReader::new(holder.stdout.take().unwrap());
    let mut ready = String::new();
    output.read_line(&mut ready).unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&ready).unwrap()["state"],
        "reopened"
    );

    let mut contended = Command::new(&executable)
        .args([
            "--database",
            database.to_str().unwrap(),
            "--ladybug-qualification",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let status = loop {
        if let Some(status) = contended.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= deadline {
            contended.kill().unwrap();
            let _ = contended.wait();
            panic!("lock-contended Ladybug open did not fail within five seconds");
        }
        sleep(Duration::from_millis(20));
    };
    assert!(
        !status.success(),
        "a second process opened the locked Ladybug store"
    );

    drop(holder.stdin.take());
    assert!(holder.wait().unwrap().success());
    let mut shutdown = String::new();
    output.read_line(&mut shutdown).unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&shutdown).unwrap()["shutdown"],
        "clean"
    );

    let reopened = Command::new(&executable)
        .args([
            "--database",
            database.to_str().unwrap(),
            "--ladybug-qualification",
        ])
        .output()
        .unwrap();
    assert!(
        reopened.status.success(),
        "{}",
        String::from_utf8_lossy(&reopened.stderr)
    );
    assert_eq!(json_line(&reopened.stdout)["state"], "reopened");
}
