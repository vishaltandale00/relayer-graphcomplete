use relayer_telemetry_capability::{
    PanicEventDefinition, install_panic_reporter, read_capability_bootstrap, read_capability_update,
};
use serde_json::{Value, json};
use std::{
    io::{BufReader, Read, Write},
    net::TcpListener,
    panic,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

static PANIC_HOOK_TEST: Mutex<()> = Mutex::new(());

#[test]
fn exact_bootstrap_installs_a_bounded_private_capability() {
    let bootstrap = format!(
        "{}\n",
        json!({
            "schema": "relayer.authenticated-error-capability/v1",
            "capability": {
                "endpoint": "http://127.0.0.1:43123/v1/authenticated-errors/report",
                "authorization": format!("Bearer {}", "a".repeat(43)),
            }
        })
    );
    assert!(
        read_capability_bootstrap(&mut bootstrap.as_bytes())
            .unwrap()
            .is_some()
    );

    let extra = bootstrap.replace("\"capability\":", "\"extra\":true,\"capability\":");
    assert!(read_capability_bootstrap(&mut extra.as_bytes()).is_err());
}

#[test]
fn panic_report_omits_raw_detail_and_preserves_the_prior_hook() {
    let _guard = PANIC_HOOK_TEST.lock().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let received = Arc::new(Mutex::new(String::new()));
    let received_by_server = Arc::clone(&received);
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(1)))
            .unwrap();
        let mut request = String::new();
        BufReader::new(&mut stream)
            .read_to_string(&mut request)
            .unwrap_or_default();
        *received_by_server.lock().unwrap() = request;
        let _ = stream.write_all(b"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\n\r\n");
    });
    let bootstrap = format!(
        "{}\n",
        json!({
            "schema": "relayer.authenticated-error-capability/v1",
            "capability": {
                "endpoint": format!("http://{address}/v1/authenticated-errors/report"),
                "authorization": format!("Bearer {}", "b".repeat(43)),
            }
        })
    );
    let capability = read_capability_bootstrap(&mut bootstrap.as_bytes()).unwrap();
    let previous_calls = Arc::new(AtomicUsize::new(0));
    let previous_calls_from_hook = Arc::clone(&previous_calls);
    let original = panic::take_hook();
    panic::set_hook(Box::new(move |_| {
        previous_calls_from_hook.fetch_add(1, Ordering::SeqCst);
    }));
    let reporter = install_panic_reporter(
        capability,
        PanicEventDefinition {
            code: "rust_graph_server.unexpected_exit",
            approved_module_prefix: "crates/relayer-graph-server/",
        },
    );

    let _ = panic::catch_unwind(|| panic!("raw panic secret /Users/person/workspace"));
    reporter.report_terminal_panic();
    let installed = panic::take_hook();
    drop(installed);
    panic::set_hook(original);
    server.join().unwrap();

    assert_eq!(previous_calls.load(Ordering::SeqCst), 1);
    let request = received.lock().unwrap();
    let body = request.split("\r\n\r\n").nth(1).unwrap();
    let payload: Value = serde_json::from_str(body).unwrap();
    assert_eq!(
        payload,
        json!({
            "code": "rust_graph_server.unexpected_exit",
            "exceptionClass": null,
            "frames": [],
        })
    );
    assert!(!request.contains("raw panic secret"));
    assert!(!request.contains("/Users/person/workspace"));
}

#[test]
fn reporting_failure_is_bounded_and_does_not_replace_panic_behavior() {
    let _guard = PANIC_HOOK_TEST.lock().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    let bootstrap = format!(
        "{}\n",
        json!({
            "schema": "relayer.authenticated-error-capability/v1",
            "capability": {
                "endpoint": format!("http://{address}/v1/authenticated-errors/report"),
                "authorization": format!("Bearer {}", "c".repeat(43)),
            }
        })
    );
    let capability = read_capability_bootstrap(&mut bootstrap.as_bytes()).unwrap();
    let previous_calls = Arc::new(AtomicUsize::new(0));
    let previous_calls_from_hook = Arc::clone(&previous_calls);
    let original = panic::take_hook();
    panic::set_hook(Box::new(move |_| {
        previous_calls_from_hook.fetch_add(1, Ordering::SeqCst);
    }));
    let reporter = install_panic_reporter(
        capability,
        PanicEventDefinition {
            code: "rust_app_server.unexpected_exit",
            approved_module_prefix: "crates/relayer-app-server/",
        },
    );

    let started = Instant::now();
    let panic_result = panic::catch_unwind(|| panic!("still reaches the previous panic path"));
    reporter.report_terminal_panic();
    let installed = panic::take_hook();
    drop(installed);
    panic::set_hook(original);

    assert!(panic_result.is_err());
    assert_eq!(previous_calls.load(Ordering::SeqCst), 1);
    assert!(started.elapsed() < Duration::from_secs(1));
}

#[test]
fn caught_panic_never_submits_the_pending_record() {
    let _guard = PANIC_HOOK_TEST.lock().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    let bootstrap = format!(
        "{}\n",
        json!({
            "schema": "relayer.authenticated-error-capability/v1",
            "capability": {
                "endpoint": format!("http://{address}/v1/authenticated-errors/report"),
                "authorization": format!("Bearer {}", "d".repeat(43)),
            }
        })
    );
    let capability = read_capability_bootstrap(&mut bootstrap.as_bytes()).unwrap();
    let original = panic::take_hook();
    panic::set_hook(Box::new(|_| {}));
    let installed = install_panic_reporter(
        capability,
        PanicEventDefinition {
            code: "rust_app_server.unexpected_exit",
            approved_module_prefix: "crates/relayer-app-server/",
        },
    );

    let panic_result = panic::catch_unwind(|| panic!("handled task panic"));
    thread::sleep(Duration::from_millis(25));
    let hook = panic::take_hook();
    drop(hook);
    panic::set_hook(original);

    assert!(panic_result.is_err());
    assert!(
        matches!(listener.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock)
    );
    drop(installed);
}

#[test]
fn private_stdin_update_equips_an_already_running_panic_reporter() {
    let _guard = PANIC_HOOK_TEST.lock().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let received = Arc::new(Mutex::new(String::new()));
    let received_by_server = Arc::clone(&received);
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        let mut request = String::new();
        BufReader::new(&mut stream)
            .read_to_string(&mut request)
            .unwrap_or_default();
        *received_by_server.lock().unwrap() = request;
        let _ = stream.write_all(b"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\n\r\n");
    });
    let original = panic::take_hook();
    panic::set_hook(Box::new(|_| {}));
    let reporter = install_panic_reporter(
        None,
        PanicEventDefinition {
            code: "rust_graph_server.unexpected_exit",
            approved_module_prefix: "crates/relayer-graph-server/",
        },
    );
    let update = format!(
        "{}\n",
        json!({
            "schema": "relayer.authenticated-error-capability/v1",
            "capability": {
                "endpoint": format!("http://{address}/v1/authenticated-errors/report"),
                "authorization": format!("Bearer {}", "e".repeat(43)),
            }
        })
    );
    read_capability_update(&mut update.as_bytes(), &reporter).unwrap();

    let _ = panic::catch_unwind(|| panic!("terminal fixture"));
    reporter.report_terminal_panic();
    let hook = panic::take_hook();
    drop(hook);
    panic::set_hook(original);
    server.join().unwrap();

    assert!(
        received
            .lock()
            .unwrap()
            .contains(&format!("Authorization: Bearer {}", "e".repeat(43)))
    );
}
