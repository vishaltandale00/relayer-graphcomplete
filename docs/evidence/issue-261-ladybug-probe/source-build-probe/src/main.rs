use lbug::{Connection, Database, SystemConfig, Value};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let db_path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "/tmp/lbug-static-probe.db".into());
    let db = Database::new(db_path, SystemConfig::default())?;
    let conn = Connection::new(&db)?;
    conn.query("CREATE NODE TABLE IF NOT EXISTS Probe(id INT64, PRIMARY KEY(id))")?;

    let mut version_result = conn.query("CALL DB_VERSION() RETURN *")?;
    let version_row = version_result.next().expect("version row");
    println!("version={version_row:?}");
    assert!(matches!(&version_row[0], Value::String(version) if version == "0.19.1"));

    let mut storage_result = conn.query("CALL STORAGE_VERSION() RETURN *")?;
    let storage_row = storage_result.next().expect("storage version row");
    println!("storage={storage_row:?}");
    assert!(matches!(
        &storage_row[0],
        Value::UInt64(43) | Value::Int64(43)
    ));
    Ok(())
}
