use anyhow::Context;
use clap::Parser;
use relayer_app_server::{
    CONTROL_COOKIE, RelayerAppServer, RelayerAppServerConfig, RelayerRuntimeConfig,
};
use relayer_telemetry_capability::{
    PanicEventDefinition, PanicReporter, install_panic_reporter, read_capability_bootstrap,
    read_capability_update,
};
use serde_json::json;
use std::{
    io::{self, BufRead, Read},
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
};
use tokio::sync::oneshot;

#[derive(Debug, Parser)]
struct Arguments {
    #[arg(long, default_value = "127.0.0.1")]
    host: IpAddr,
    #[arg(long, default_value_t = 0)]
    port: u16,
    #[arg(long)]
    data_dir: PathBuf,
    #[arg(long)]
    web_dir: PathBuf,
    #[arg(long)]
    permission_catalog: PathBuf,
    #[arg(long)]
    graph_url: Option<String>,
    #[arg(long)]
    harness_url: Option<String>,
    #[arg(long)]
    graph_control_token: Option<String>,
    #[arg(long)]
    harness_control_token: Option<String>,
    #[arg(long)]
    harness_configurations: Option<PathBuf>,
    #[arg(long, default_value = "codex-basic")]
    default_harness_configuration: String,
    #[arg(long, default_value_t = false)]
    allow_harness_override: bool,
    #[arg(long, default_value_t = false)]
    allow_conversation_import: bool,
    #[arg(long, default_value_t = false)]
    read_only_control_token_stdin: bool,
    #[arg(long, default_value_t = false)]
    authenticated_error_capability_stdin: bool,
    #[arg(long)]
    producer_desktop_version: String,
    #[arg(long)]
    producer_build_commit: String,
    #[arg(long)]
    producer_platform: String,
    #[arg(long)]
    producer_architecture: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let arguments = Arguments::parse();
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let (control_token, read_only_control_token) =
        read_control_tokens(&mut input, arguments.read_only_control_token_stdin)?;
    let error_capability = arguments
        .authenticated_error_capability_stdin
        .then(|| read_capability_bootstrap(&mut input).ok().flatten())
        .flatten();
    drop(input);
    let panic_reporter = arguments.authenticated_error_capability_stdin.then(|| {
        install_panic_reporter(
            error_capability,
            PanicEventDefinition {
                code: "rust_app_server.unexpected_exit",
                approved_module_prefix: "crates/relayer-app-server/",
            },
        )
    });
    let parent_disconnected = watch_parent_connection(panic_reporter.clone());
    let execution = tokio::spawn(run(
        arguments,
        control_token,
        read_only_control_token,
        parent_disconnected,
    ))
    .await;
    match execution {
        Ok(result) => result,
        Err(error) if error.is_panic() => {
            panic_reporter
                .as_ref()
                .map(PanicReporter::report_terminal_panic);
            std::panic::resume_unwind(error.into_panic());
        }
        Err(error) => Err(anyhow::anyhow!(
            "Relayer app server task stopped unexpectedly: {error}"
        )),
    }
}

async fn run(
    arguments: Arguments,
    control_token: String,
    read_only_control_token: Option<String>,
    parent_disconnected: oneshot::Receiver<()>,
) -> anyhow::Result<()> {
    if arguments.host != IpAddr::V4(Ipv4Addr::LOCALHOST) {
        anyhow::bail!("Relayer app server only binds to 127.0.0.1");
    }
    std::fs::create_dir_all(&arguments.data_dir).context("create product data directory")?;
    if !arguments.web_dir.is_dir() {
        anyhow::bail!(
            "web directory does not exist: {}",
            arguments.web_dir.display()
        );
    }
    let database = arguments.data_dir.join("product.sqlite3");
    let runtime = match (
        arguments.graph_url,
        arguments.harness_url,
        arguments.graph_control_token,
        arguments.harness_control_token,
        arguments.harness_configurations,
    ) {
        (
            Some(graph_url),
            Some(harness_url),
            Some(graph_control_token),
            Some(harness_control_token),
            Some(configurations),
        ) => Some(RelayerRuntimeConfig {
            graph_url,
            harness_url,
            graph_control_token,
            harness_control_token,
            harness_configurations: configurations,
            default_harness_configuration: arguments.default_harness_configuration,
            allow_harness_override: arguments.allow_harness_override,
            standalone_workspaces_directory: arguments.data_dir.join("workspaces"),
        }),
        (None, None, None, None, None) => None,
        _ => anyhow::bail!("GraphComplete runtime arguments must be supplied together"),
    };
    let app_server = RelayerAppServer::open(RelayerAppServerConfig {
        database_path: database,
        web_directory: arguments.web_dir,
        permission_catalog: arguments.permission_catalog,
        control_token,
        read_only_control_token,
        runtime,
        allow_conversation_import: arguments.allow_conversation_import,
        export_producer: relayer_app_server::conversation_export::ExportProducer {
            desktop_version: arguments.producer_desktop_version,
            build_commit: arguments.producer_build_commit,
            platform: arguments.producer_platform,
            architecture: arguments.producer_architecture,
        },
    })
    .await
    .context("open Relayer app server")?;
    let listener = tokio::net::TcpListener::bind(SocketAddr::new(arguments.host, arguments.port))
        .await
        .context("bind Relayer app server")?;
    let address = listener.local_addr()?;
    println!(
        "{}",
        json!({
            "ready": true,
            "origin": format!("http://{address}"),
            "cookieName": CONTROL_COOKIE,
        })
    );
    axum::serve(listener, app_server.router())
        .with_graceful_shutdown(shutdown_signal(parent_disconnected))
        .await
        .context("serve Relayer app server")?;
    Ok(())
}

fn read_control_tokens(
    input: &mut impl BufRead,
    read_only_enabled: bool,
) -> anyhow::Result<(String, Option<String>)> {
    let control_token = read_token_line(input, "desktop control token")?;
    let read_only_control_token = read_only_enabled
        .then(|| read_token_line(input, "read-only desktop control token"))
        .transpose()?;
    if read_only_control_token.as_deref() == Some(control_token.as_str()) {
        anyhow::bail!("desktop control tokens must be distinct");
    }
    Ok((control_token, read_only_control_token))
}

fn read_token_line(input: &mut impl BufRead, label: &str) -> anyhow::Result<String> {
    let mut token = String::new();
    input
        .read_line(&mut token)
        .with_context(|| format!("read {label}"))?;
    if !token.ends_with('\n') {
        anyhow::bail!("{label} must be newline terminated");
    }
    let token = token.trim_end_matches(['\r', '\n']).to_owned();
    if token.len() < 32 {
        anyhow::bail!("{label} must contain at least 32 characters");
    }
    Ok(token)
}

fn watch_parent_connection(reporter: Option<PanicReporter>) -> oneshot::Receiver<()> {
    let (disconnected, parent_disconnected) = oneshot::channel();
    std::thread::spawn(move || {
        let mut input = io::stdin().lock();
        if let Some(reporter) = reporter {
            while read_capability_update(&mut input, &reporter).is_ok() {}
            reporter.replace_capability(None);
        }
        let mut buffer = [0_u8; 256];
        loop {
            match input.read(&mut buffer) {
                Ok(0) => break,
                Ok(_) => {}
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        let _ = disconnected.send(());
    });
    parent_disconnected
}

async fn shutdown_signal(parent_disconnected: oneshot::Receiver<()>) {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut terminate = signal(SignalKind::terminate()).expect("install SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = terminate.recv() => {},
            _ = parent_disconnected => {},
        }
    }
    #[cfg(not(unix))]
    {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = parent_disconnected => {},
        }
    }
}
