use lbug::{Connection, Database, SystemConfig, Value};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let db = Database::new(temp.path().join("db"), SystemConfig::default())?;
    let conn = Connection::new(&db)?;
    println!("STORAGE_VERSION={}", lbug::get_storage_version());
    for query in [
        "CREATE NODE TABLE Content(id STRING, title STRING, PRIMARY KEY(id))",
        "CREATE REL TABLE CONNECTED(FROM Content TO Content, id STRING)",
        "CREATE (:Content {id:'content:1', title:'Queue'})",
        "CREATE (:Content {id:'content:2', title:'Worker'})",
        "MATCH (a:Content),(b:Content) WHERE a.id='content:1' AND b.id='content:2' CREATE (a)-[:CONNECTED {id:'edge:201'}]->(b)",
    ] {
        conn.query(query)?;
    }
    for query in [
        "MATCH p=(a:Content)-[r:CONNECTED]-(b:Content) RETURN p,r,[a,b] AS nodes,[r] AS rels",
        "MATCH (a:Content)-[r:CONNECTED]-(b:Content) RETURN count(r)",
        "MATCH (a:Content) RETURN {title:a.title, id:a.id} AS item, [a.title,a.id] AS vals",
        "MATCH (a:Content) RETURN a.title AS title ORDER BY title ASC NULLS LAST",
    ] {
        let prepared = match conn.prepare(query) {
            Ok(value) => value,
            Err(error) => {
                println!("PREPARE_ERROR={error}");
                continue;
            }
        };
        println!("READ_ONLY={} Q={query}", prepared.is_read_only());
        let mut result = match conn.query(query) {
            Ok(value) => value,
            Err(error) => {
                println!("QUERY_ERROR={error}");
                continue;
            }
        };
        println!("COLTYPES={:?}", result.get_column_data_types());
        for row in &mut result {
            println!("ROW={row:?}");
            for value in row {
                if let Value::RecursiveRel { nodes, rels } = value {
                    println!("PATH nodes={} rels={}", nodes.len(), rels.len());
                }
            }
        }
    }
    let args = std::env::args().collect::<Vec<_>>();
    if args.iter().any(|arg| arg == "--timeout-falsifier") {
        conn.set_query_timeout(1);
        let query = conn.query("UNWIND range(1,1000000000) AS x RETURN sum(x)");
        println!("TIMED_OUT={query:?}");
    }
    if args.iter().any(|arg| arg == "--interrupt-falsifier") {
        std::thread::scope(|scope| {
            let interrupter = scope.spawn(|| {
                std::thread::sleep(std::time::Duration::from_millis(1));
                conn.interrupt()
            });
            let query = conn.query("UNWIND range(1,1000000000) AS x RETURN sum(x)");
            println!("CANCELLED={query:?}");
            println!("INTERRUPT={:?}", interrupter.join().unwrap());
        });
    }
    Ok(())
}
