use crate::storage::StorageError;
use sqlx::{Row, SqlitePool, sqlite::SqliteRow};

#[derive(Debug, PartialEq, Eq)]
struct Column {
    name: String,
    declared_type: String,
    required: bool,
    primary_key_position: i64,
}

const PROJECT_COLUMNS: &[(&str, &str, bool, i64)] = &[
    ("id", "INTEGER", false, 1),
    ("name", "TEXT", true, 0),
    ("path", "TEXT", true, 0),
    ("created_at", "TEXT", true, 0),
    ("updated_at", "TEXT", true, 0),
];
const THREAD_COLUMNS: &[(&str, &str, bool, i64)] = &[
    ("id", "INTEGER", false, 1),
    ("title", "TEXT", true, 0),
    ("project_id", "INTEGER", false, 0),
    ("created_at", "TEXT", true, 0),
    ("updated_at", "TEXT", true, 0),
];
const INTERACTION_COLUMNS: &[(&str, &str, bool, i64)] = &[
    ("id", "INTEGER", false, 1),
    ("thread_id", "INTEGER", true, 0),
    ("sequence", "INTEGER", true, 0),
    ("text", "TEXT", true, 0),
    ("created_at", "TEXT", true, 0),
];

pub(super) async fn validate_existing_or_empty(pool: &SqlitePool) -> Result<(), StorageError> {
    let table_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_schema WHERE type='table' AND name IN ('projects','threads','interactions')",
    )
    .fetch_one(pool)
    .await?;
    if table_count == 0 {
        return Ok(());
    }
    let has_migration_history: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='_sqlx_migrations')",
    )
    .fetch_one(pool)
    .await?;
    if !has_migration_history {
        return Err(incompatible(
            "product tables exist without Relayer migration history",
        ));
    }
    Ok(())
}

pub(super) async fn validate(pool: &SqlitePool) -> Result<(), StorageError> {
    validate_columns(pool, "projects", PROJECT_COLUMNS).await?;
    validate_columns(pool, "threads", THREAD_COLUMNS).await?;
    validate_columns(pool, "interactions", INTERACTION_COLUMNS).await?;
    validate_index(pool, "projects", &["path"], true).await?;
    validate_index(pool, "interactions", &["thread_id", "sequence"], true).await?;
    validate_foreign_key(pool, "threads", "project_id", "projects", "id", "SET NULL").await?;
    validate_foreign_key(
        pool,
        "interactions",
        "thread_id",
        "threads",
        "id",
        "CASCADE",
    )
    .await?;
    let violations = sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(pool)
        .await?;
    if !violations.is_empty() {
        return Err(incompatible("stored rows violate product foreign keys"));
    }
    let thread_without_interaction: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM threads t WHERE NOT EXISTS (SELECT 1 FROM interactions i WHERE i.thread_id=t.id))",
    )
    .fetch_one(pool)
    .await?;
    if thread_without_interaction {
        return Err(incompatible(
            "every stored thread must have a root interaction",
        ));
    }
    Ok(())
}

async fn validate_columns(
    pool: &SqlitePool,
    table: &str,
    expected: &[(&str, &str, bool, i64)],
) -> Result<(), StorageError> {
    let rows = sqlx::query(&format!("PRAGMA table_info({table})"))
        .fetch_all(pool)
        .await?;
    let actual = rows
        .iter()
        .map(column_from_row)
        .collect::<Result<Vec<_>, _>>()?;
    let expected = expected
        .iter()
        .map(
            |(name, declared_type, required, primary_key_position)| Column {
                name: (*name).to_owned(),
                declared_type: (*declared_type).to_owned(),
                required: *required,
                primary_key_position: *primary_key_position,
            },
        )
        .collect::<Vec<_>>();
    if actual != expected {
        return Err(incompatible(&format!(
            "table {table} does not match the supported schema"
        )));
    }
    Ok(())
}

fn column_from_row(row: &SqliteRow) -> Result<Column, StorageError> {
    Ok(Column {
        name: row.try_get("name")?,
        declared_type: row.try_get::<String, _>("type")?.to_ascii_uppercase(),
        required: row.try_get::<i64, _>("notnull")? == 1,
        primary_key_position: row.try_get("pk")?,
    })
}

async fn validate_index(
    pool: &SqlitePool,
    table: &str,
    expected_columns: &[&str],
    unique: bool,
) -> Result<(), StorageError> {
    let indexes = sqlx::query(&format!("PRAGMA index_list({table})"))
        .fetch_all(pool)
        .await?;
    for index in indexes {
        if (index.try_get::<i64, _>("unique")? == 1) != unique {
            continue;
        }
        if index.try_get::<i64, _>("partial")? == 1 {
            continue;
        }
        let name: String = index.try_get("name")?;
        let escaped = name.replace('"', "\"\"");
        let columns = sqlx::query(&format!("PRAGMA index_info(\"{escaped}\")"))
            .fetch_all(pool)
            .await?
            .into_iter()
            .map(|row| row.try_get::<String, _>("name"))
            .collect::<Result<Vec<_>, _>>()?;
        if columns
            .iter()
            .map(String::as_str)
            .eq(expected_columns.iter().copied())
        {
            return Ok(());
        }
    }
    Err(incompatible(&format!(
        "table {table} is missing its required {} index on {}",
        if unique { "unique" } else { "non-unique" },
        expected_columns.join(", ")
    )))
}

async fn validate_foreign_key(
    pool: &SqlitePool,
    table: &str,
    from: &str,
    target_table: &str,
    target_column: &str,
    on_delete: &str,
) -> Result<(), StorageError> {
    let foreign_keys = sqlx::query(&format!("PRAGMA foreign_key_list({table})"))
        .fetch_all(pool)
        .await?;
    let present = foreign_keys.iter().any(|row| {
        let Ok(actual_from) = row.try_get::<String, _>("from") else {
            return false;
        };
        let Ok(actual_table) = row.try_get::<String, _>("table") else {
            return false;
        };
        let Ok(actual_column) = row.try_get::<String, _>("to") else {
            return false;
        };
        let Ok(actual_on_delete) = row.try_get::<String, _>("on_delete") else {
            return false;
        };
        actual_from == from
            && actual_table == target_table
            && actual_column == target_column
            && actual_on_delete == on_delete
    });
    if present {
        Ok(())
    } else {
        Err(incompatible(&format!(
            "table {table} is missing the required {from} foreign key"
        )))
    }
}

fn incompatible(message: &str) -> StorageError {
    StorageError::IncompatibleSchema(message.to_owned())
}
