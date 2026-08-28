use anyhow::Context;
use clap::Parser;
use relayer_graph_core::{GraphDatabase, TemporalFeatureConfig};
use relayer_graph_server::{ServerState, router};
use std::{
    io::{self, BufRead, Read},
    net::{IpAddr, Ipv4Addr, SocketAddr},
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
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let arguments = Arguments::parse();
    let (control_token, parent_disconnected) = match arguments.control_token {
        Some(token) => (token, None),
        None => {
            let token = read_control_token()?;
            (token, Some(watch_parent_connection()))
        }
    };
    if arguments.host != IpAddr::V4(Ipv4Addr::LOCALHOST) {
        anyhow::bail!("the v1 graph server only binds to 127.0.0.1");
    }
    let graph = GraphDatabase::open(&arguments.database)
        .await
        .context("open graph database")?;
    let temporal_features = TemporalFeatureConfig {
        config_version: 1,
        schema_read: arguments.temporal_schema_read,
        root_current_write: arguments.temporal_root_current_write,
        projection_ui: arguments.temporal_projection_ui,
        invoke_resolution: arguments.temporal_invoke_resolution,
        provider_recursion: arguments.temporal_provider_recursion,
    };
    graph
        .set_temporal_features(temporal_features)
        .await
        .context("persist temporal feature config")?;
    let listener =
        tokio::net::TcpListener::bind(SocketAddr::new(arguments.host, arguments.port)).await?;
    let address = listener.local_addr()?;
    println!(
        "{}",
        serde_json::json!({"ready":true,"url":format!("http://{address}")})
    );
    axum::serve(
        listener,
        router(ServerState::new(graph, control_token).with_temporal_features(temporal_features)),
    )
    .with_graceful_shutdown(shutdown_signal(parent_disconnected))
    .await?;
    Ok(())
}

fn read_control_token() -> anyhow::Result<String> {
    let mut token = String::new();
    io::stdin().lock().read_line(&mut token)?;
    if !token.ends_with('\n') {
        anyhow::bail!("graph control token must be newline terminated");
    }
    let token = token.trim_end_matches(['\r', '\n']).to_owned();
    if token.len() < 32 {
        anyhow::bail!("graph control token must contain at least 32 characters");
    }
    Ok(token)
}

fn watch_parent_connection() -> oneshot::Receiver<()> {
    let (disconnected, parent_disconnected) = oneshot::channel();
    std::thread::spawn(move || {
        let mut input = io::stdin().lock();
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
