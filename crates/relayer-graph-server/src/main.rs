use anyhow::Context;
use clap::Parser;
use relayer_graph_core::{GraphDatabase, TemporalFeatureConfig};
use relayer_graph_server::{ServerState, router};
use relayer_telemetry_capability::{
    PanicEventDefinition, PanicReporter, install_panic_reporter, read_capability_bootstrap,
    read_capability_update,
};
use std::{
    io::{self, BufRead, Read},
    net::{IpAddr, Ipv4Addr, SocketAddr},
    panic,
};
use tokio::sync::oneshot;

#[derive(Parser)]
struct Arguments {
    #[arg(long, default_value = "127.0.0.1")]
    host: IpAddr,
    #[arg(long, default_value_t = 0)]
    port: u16,
    #[arg(long)]
    database: String,
    #[arg(long)]
    control_token: Option<String>,
    #[arg(long)]
    temporal_schema_read: bool,
    #[arg(long)]
    temporal_root_current_write: bool,
    #[arg(long)]
    temporal_projection_ui: bool,
    #[arg(long)]
    temporal_invoke_resolution: bool,
    #[arg(long)]
    temporal_provider_recursion: bool,
    #[cfg(feature = "ladybug")]
    #[arg(long, hide = true)]
    ladybug_qualification: bool,
    #[cfg(feature = "ladybug")]
    #[arg(long, hide = true, requires = "ladybug_qualification")]
    ladybug_qualification_hold: bool,
    #[arg(long, default_value_t = false)]
    authenticated_error_capability_stdin: bool,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let mut arguments = Arguments::parse();
    #[cfg(feature = "ladybug")]
    if arguments.ladybug_qualification {
        return run_ladybug_qualification(
            &arguments.database,
            arguments.ladybug_qualification_hold,
        );
    }
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let control_token_from_stdin = arguments.control_token.is_none();
    let control_token = match arguments.control_token.take() {
        Some(token) => token,
        None => read_control_token(&mut input)?,
    };
    let error_capability = arguments
        .authenticated_error_capability_stdin
        .then(|| read_capability_bootstrap(&mut input).ok().flatten())
        .flatten();
    drop(input);
    let panic_reporter = arguments.authenticated_error_capability_stdin.then(|| {
        install_panic_reporter(
            error_capability,
            PanicEventDefinition {
                code: "rust_graph_server.unexpected_exit",
                approved_module_prefix: "crates/relayer-graph-server/",
            },
        )
    });
    let parent_disconnected =
        control_token_from_stdin.then(|| watch_parent_connection(panic_reporter.clone()));
    let execution = tokio::spawn(run(arguments, control_token, parent_disconnected)).await;
    match execution {
        Ok(result) => result,
        Err(error) if error.is_panic() => {
            panic_reporter
                .as_ref()
                .map(PanicReporter::report_terminal_panic);
            panic::resume_unwind(error.into_panic());
        }
        Err(error) => Err(anyhow::anyhow!(
            "graph server task stopped unexpectedly: {error}"
        )),
    }
}

async fn run(
    arguments: Arguments,
    control_token: String,
    parent_disconnected: Option<oneshot::Receiver<()>>,
) -> anyhow::Result<()> {
    if arguments.host != IpAddr::V4(Ipv4Addr::LOCALHOST) {
        anyhow::bail!("the v1 graph server only binds to 127.0.0.1");
    }
    let temporal_features = TemporalFeatureConfig {
        config_version: 1,
        schema_read: arguments.temporal_schema_read,
        root_current_write: arguments.temporal_root_current_write,
        projection_ui: arguments.temporal_projection_ui,
        invoke_resolution: arguments.temporal_invoke_resolution,
        provider_recursion: arguments.temporal_provider_recursion,
    };
    let state = open_server_state(&arguments.database, control_token, temporal_features)
        .await
        .context("open graph database")?;
    let listener =
        tokio::net::TcpListener::bind(SocketAddr::new(arguments.host, arguments.port)).await?;
    let address = listener.local_addr()?;
    println!(
        "{}",
        serde_json::json!({"ready":true,"url":format!("http://{address}")})
    );
    axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown_signal(parent_disconnected))
        .await?;
    Ok(())
}

/// Open the graph with its search store attached, so an accepted closure is
/// saved and made searchable as one action.
#[cfg(feature = "ladybug")]
async fn open_server_state(
    path: &str,
    control_token: String,
    temporal_features: TemporalFeatureConfig,
) -> anyhow::Result<ServerState> {
    use relayer_graph_server::search_index::LadybugSearchIndex;
    use std::{path::Path, sync::Arc};

    let graph = GraphDatabase::open(path).await?;
    graph.set_temporal_features(temporal_features).await?;
    let index = Arc::new(
        LadybugSearchIndex::open_reconciled(Path::new(path), &graph)
            .await
            .context("reconcile the search index")?,
    );
    Ok(ServerState::new(graph, control_token)
        .with_temporal_features(temporal_features)
        .with_search_index(index))
}

/// Without the Ladybug feature there is no search store, so closures are saved
/// to SQLite and indexed nowhere.
#[cfg(not(feature = "ladybug"))]
async fn open_server_state(
    path: &str,
    control_token: String,
    temporal_features: TemporalFeatureConfig,
) -> anyhow::Result<ServerState> {
    let graph = GraphDatabase::open(path).await?;
    graph.set_temporal_features(temporal_features).await?;
    Ok(ServerState::new(graph, control_token).with_temporal_features(temporal_features))
}

#[cfg(feature = "ladybug")]
fn run_ladybug_qualification(path: &str, hold: bool) -> anyhow::Result<()> {
    use lbug::{Connection, Database, SystemConfig, Value};
    use std::path::Path;

    let existed = Path::new(path).exists();
    let database = Database::new(path, SystemConfig::default())
        .context("open Ladybug qualification database")?;
    let connection =
        Connection::new(&database).context("connect Ladybug qualification database")?;
    if existed {
        let mut rows = connection
            .query("MATCH (n:Qualification) WHERE n.id='lifecycle' RETURN n.value")
            .context("read Ladybug qualification marker after reopen")?;
        let row = rows
            .next()
            .context("Ladybug qualification marker was not persisted")?;
        if row.first() != Some(&Value::String("persisted".into())) || rows.next().is_some() {
            anyhow::bail!("Ladybug qualification marker did not reopen exactly");
        }
    } else {
        connection
            .query("CREATE NODE TABLE Qualification(id STRING, value STRING, PRIMARY KEY(id))")
            .context("create Ladybug qualification schema")?;
        connection
            .query("CREATE (:Qualification {id:'lifecycle',value:'persisted'})")
            .context("create Ladybug qualification marker")?;
    }
    println!(
        "{}",
        serde_json::json!({
            "ready": true,
            "ladybugQualification": true,
            "state": if existed { "reopened" } else { "created" },
            "storageVersion": lbug::get_storage_version(),
        })
    );
    if hold {
        drain_stdin_until_eof().context("wait for qualification shutdown")?;
        println!("{}", serde_json::json!({"shutdown": "clean"}));
    }
    Ok(())
}

/// Read stdin to EOF, retrying through interrupts. Returns the first real error
/// so each caller decides whether to propagate or ignore it. Only the
/// qualification path needs this; `watch_parent_connection` drains the handle it
/// already holds rather than locking stdin a second time.
#[cfg(feature = "ladybug")]
fn drain_stdin_until_eof() -> io::Result<()> {
    let mut input = io::stdin().lock();
    let mut buffer = [0_u8; 256];
    loop {
        match input.read(&mut buffer) {
            Ok(0) => return Ok(()),
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
}

fn read_control_token(input: &mut impl BufRead) -> anyhow::Result<String> {
    let mut token = String::new();
    input.read_line(&mut token)?;
    if !token.ends_with('\n') {
        anyhow::bail!("graph control token must be newline terminated");
    }
    let token = token.trim_end_matches(['\r', '\n']).to_owned();
    if token.len() < 32 {
        anyhow::bail!("graph control token must contain at least 32 characters");
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

async fn shutdown_signal(parent_disconnected: Option<oneshot::Receiver<()>>) {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut terminate = signal(SignalKind::terminate()).expect("install SIGTERM handler");
        let parent_disconnected = async {
            match parent_disconnected {
                Some(disconnected) => {
                    let _ = disconnected.await;
                }
                None => std::future::pending::<()>().await,
            }
        };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = terminate.recv() => {},
            _ = parent_disconnected => {},
        }
    }
    #[cfg(not(unix))]
    {
        match parent_disconnected {
            Some(disconnected) => tokio::select! {
                _ = tokio::signal::ctrl_c() => {},
                _ = disconnected => {},
            },
            None => {
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
}
