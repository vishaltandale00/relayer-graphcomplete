//! Inspect a graph's search store.
//!
//! The product has no query path yet — that is #263 — so this is how the store
//! is observed by hand until it does. It opens `<db>.ladybug/active/` and runs one
//! read-only query through the same normalization the contract froze.
//!
//! Usage:
//!   cargo run -p relayer-graph-server --example search -- <graph.db> "<query>"
//!
//! The store takes an exclusive lock, so the graph server must not be running.

#[cfg(not(feature = "ladybug"))]
fn main() {
    eprintln!("this example needs the ladybug feature, which is on by default");
    std::process::exit(2);
}

#[cfg(feature = "ladybug")]
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    use relayer_graph_core::{ProjectId, SearchIndex, SearchTarget, ThreadId};
    use relayer_graph_server::search_index::LadybugSearchIndex;
    use std::path::Path;

    let mut arguments = std::env::args().skip(1);
    let database = arguments
        .next()
        .ok_or_else(|| anyhow::anyhow!("usage: search <graph.db> [query]"))?;
    let query = arguments.next().unwrap_or_else(|| {
        "MATCH (n:Content) RETURN n.kind AS kind, n.title AS title ORDER BY kind, title".into()
    });

    let index = LadybugSearchIndex::open(Path::new(&database))?;
    println!("store: {}", index.layout().active().display());

    for (label, count) in [
        ("content", "MATCH (n:Content) RETURN count(n) AS n"),
        ("layers", "MATCH (l:Layer) RETURN count(l) AS n"),
        ("edges", "MATCH ()-[r:CONNECTED]->() RETURN count(r) AS n"),
        ("expands", "MATCH ()-[a:EXPANDS]->() RETURN count(a) AS n"),
        (
            "references",
            "MATCH ()-[a:REFERENCES]->() RETURN count(a) AS n",
        ),
        (
            "memberships",
            "MATCH ()-[m:CONTAINS]->() RETURN count(m) AS n",
        ),
    ] {
        let rows = index.normalized_rows(count).await?;
        let value = rows
            .first()
            .and_then(|row| row.first())
            .and_then(|cell| cell["value"].as_str())
            .unwrap_or("?");
        println!("{label:>12}: {value}");
    }

    // Revisions are per logical target: the project a closure belongs to, or its
    // standalone thread. Probe a small range of each rather than guess.
    for id in 1..=64 {
        for target in [
            SearchTarget::Project(ProjectId::new(id).unwrap()),
            SearchTarget::Thread(ThreadId::new(id).unwrap()),
        ] {
            if let Some(revision) = index.revision(target).await? {
                println!("    revision: {target} -> {revision}");
            }
        }
    }

    println!("\nquery: {query}\n");
    for row in index.normalized_rows(&query).await? {
        let cells: Vec<String> = row
            .iter()
            .map(|cell| match cell["value"].as_str() {
                Some(text) => text.to_owned(),
                None => cell.to_string(),
            })
            .collect();
        println!("  {}", cells.join("  |  "));
    }
    Ok(())
}
