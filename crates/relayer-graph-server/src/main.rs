use anyhow::Context;
use clap::Parser;
use relayer_graph_core::GraphDatabase;
use relayer_graph_server::{ServerState, router};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};

#[derive(Parser)]
struct Arguments {
    #[arg(long, default_value = "127.0.0.1")]
    host: IpAddr,
    #[arg(long, default_value_t = 0)]
    port: u16,
    #[arg(long)]
    database: String,
    #[arg(long)]
    control_token: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let arguments = Arguments::parse();
    if arguments.host != IpAddr::V4(Ipv4Addr::LOCALHOST) {
        anyhow::bail!("the v1 graph server only binds to 127.0.0.1");
    }
    let graph = GraphDatabase::open(&arguments.database)
        .await
        .context("open graph database")?;
    let listener =
        tokio::net::TcpListener::bind(SocketAddr::new(arguments.host, arguments.port)).await?;
    let address = listener.local_addr()?;
    println!(
        "{}",
        serde_json::json!({"ready":true,"url":format!("http://{address}")})
    );
    axum::serve(
        listener,
        router(ServerState::new(graph, arguments.control_token)),
    )
    .with_graceful_shutdown(async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await?;
    Ok(())
}
