use anyhow::Context;
use clap::Parser;
use relayer_app_server::{CONTROL_COOKIE, RelayerAppServer, RelayerAppServerConfig};
use serde_json::json;
use std::{
    io,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
};

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
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let arguments = Arguments::parse();
    let control_token = read_control_token()?;
    if arguments.host != IpAddr::V4(Ipv4Addr::LOCALHOST) {
        anyhow::bail!("Relayer app server only binds to 127.0.0.1");
    }
    if control_token.len() < 32 {
        anyhow::bail!("control token must contain at least 32 characters");
    }
    std::fs::create_dir_all(&arguments.data_dir).context("create product data directory")?;
    if !arguments.web_dir.is_dir() {
        anyhow::bail!(
            "web directory does not exist: {}",
            arguments.web_dir.display()
        );
    }
    let database = arguments.data_dir.join("product.sqlite3");
    let app_server = RelayerAppServer::open(RelayerAppServerConfig {
        database_path: database,
        web_directory: arguments.web_dir,
        control_token,
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
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("serve Relayer app server")?;
    Ok(())
}

fn read_control_token() -> anyhow::Result<String> {
    let mut token = String::new();
    io::stdin()
        .read_line(&mut token)
        .context("read desktop control token")?;
    let token = token.trim_end_matches(['\r', '\n']).to_owned();
    if token.is_empty() {
        anyhow::bail!("desktop control token was not supplied");
    }
    Ok(token)
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut terminate = signal(SignalKind::terminate()).expect("install SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = terminate.recv() => {},
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
