use crate::model::{CreateProject, CreateThread, Interaction, Project, Thread};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use std::{
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("not found: {0}")]
    NotFound(String),
    #[error("invalid input: {0}")]
    Invalid(String),
    #[error("storage failed: {0}")]
    Storage(#[from] rusqlite::Error),
    #[error("filesystem failed: {0}")]
    Filesystem(#[from] std::io::Error),
}

pub struct ProductStore {
    connection: Connection,
}

impl ProductStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let connection = Connection::open(path)?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        let store = Self { connection };
        store.migrate()?;
        Ok(store)
    }

    pub fn in_memory() -> Result<Self, StoreError> {
        let connection = Connection::open_in_memory()?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        let store = Self { connection };
        store.migrate()?;
        Ok(store)
    }

    fn migrate(&self) -> Result<(), StoreError> {
        self.connection.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS projects (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              path TEXT NOT NULL UNIQUE,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS threads (
              id TEXT PRIMARY KEY,
              title TEXT NOT NULL,
              project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS interactions (
              id TEXT PRIMARY KEY,
              thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
              sequence INTEGER NOT NULL,
              text TEXT NOT NULL,
              created_at TEXT NOT NULL,
              UNIQUE(thread_id, sequence)
            );
            CREATE INDEX IF NOT EXISTS threads_project_updated
              ON threads(project_id, updated_at DESC);
            CREATE INDEX IF NOT EXISTS interactions_thread_sequence
              ON interactions(thread_id, sequence);
            "#,
        )?;
        Ok(())
    }

    pub fn list_projects(&self) -> Result<Vec<Project>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT id,name,path,created_at,updated_at FROM projects ORDER BY created_at ASC",
        )?;
        let rows = statement.query_map([], project_from_row)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn create_project(&mut self, input: CreateProject) -> Result<Project, StoreError> {
        let path = canonical_directory(&input.path)?;
        let path_text = path.to_string_lossy().into_owned();
        if let Some(project) = self.project_by_path(&path_text)? {
            return Ok(project);
        }
        let name = input
            .name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .or_else(|| {
                path.file_name()
                    .map(|value| value.to_string_lossy().into_owned())
            })
            .ok_or_else(|| StoreError::Invalid("project name cannot be determined".into()))?;
        let id = Uuid::new_v4().to_string();
        let timestamp = now();
        self.connection.execute(
            "INSERT INTO projects(id,name,path,created_at,updated_at) VALUES (?1,?2,?3,?4,?4)",
            params![id, name, path_text, timestamp],
        )?;
        self.get_project(&id)
    }

    pub fn get_project(&self, id: &str) -> Result<Project, StoreError> {
        self.connection
            .query_row(
                "SELECT id,name,path,created_at,updated_at FROM projects WHERE id=?1",
                [id],
                project_from_row,
            )
            .optional()?
            .ok_or_else(|| StoreError::NotFound(format!("project {id}")))
    }

    fn project_by_path(&self, path: &str) -> Result<Option<Project>, StoreError> {
        self.connection
            .query_row(
                "SELECT id,name,path,created_at,updated_at FROM projects WHERE path=?1",
                [path],
                project_from_row,
            )
            .optional()
            .map_err(StoreError::from)
    }

    pub fn list_threads(&self) -> Result<Vec<Thread>, StoreError> {
        let mut statement = self.connection.prepare(
            r#"SELECT t.id,t.title,t.project_id,t.created_at,t.updated_at,
                      (SELECT id FROM interactions WHERE thread_id=t.id ORDER BY sequence ASC LIMIT 1)
               FROM threads t ORDER BY t.updated_at DESC, t.created_at DESC"#,
        )?;
        let rows = statement.query_map([], thread_from_row)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn get_thread(&self, id: &str) -> Result<Thread, StoreError> {
        self.connection
            .query_row(
                r#"SELECT t.id,t.title,t.project_id,t.created_at,t.updated_at,
                          (SELECT id FROM interactions WHERE thread_id=t.id ORDER BY sequence ASC LIMIT 1)
                   FROM threads t WHERE t.id=?1"#,
                [id],
                thread_from_row,
            )
            .optional()?
            .ok_or_else(|| StoreError::NotFound(format!("thread {id}")))
    }

    pub fn create_thread(&mut self, input: CreateThread) -> Result<Thread, StoreError> {
        let message = required(&input.initial_message, "initialMessage")?;
        if let Some(project_id) = input.project_id.as_deref() {
            self.get_project(project_id)?;
        }
        let title = input
            .title
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(message)
            .chars()
            .take(120)
            .collect::<String>();
        let thread_id = Uuid::new_v4().to_string();
        let interaction_id = Uuid::new_v4().to_string();
        let timestamp = now();
        let transaction = self.connection.transaction()?;
        transaction.execute(
            "INSERT INTO threads(id,title,project_id,created_at,updated_at) VALUES (?1,?2,?3,?4,?4)",
            params![thread_id, title, input.project_id, timestamp],
        )?;
        transaction.execute(
            "INSERT INTO interactions(id,thread_id,sequence,text,created_at) VALUES (?1,?2,1,?3,?4)",
            params![interaction_id, thread_id, message, timestamp],
        )?;
        transaction.commit()?;
        self.get_thread(&thread_id)
    }

    pub fn list_interactions(&self, thread_id: &str) -> Result<Vec<Interaction>, StoreError> {
        self.get_thread(thread_id)?;
        let mut statement = self.connection.prepare(
            "SELECT id,thread_id,sequence,text,created_at FROM interactions WHERE thread_id=?1 ORDER BY sequence ASC",
        )?;
        let rows = statement.query_map([thread_id], interaction_from_row)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn create_interaction(
        &mut self,
        thread_id: &str,
        text: &str,
    ) -> Result<Interaction, StoreError> {
        let text = required(text, "text")?;
        self.get_thread(thread_id)?;
        let transaction = self.connection.transaction()?;
        let sequence: i64 = transaction.query_row(
            "SELECT COALESCE(MAX(sequence),0)+1 FROM interactions WHERE thread_id=?1",
            [thread_id],
            |row| row.get(0),
        )?;
        let interaction = Interaction {
            id: Uuid::new_v4().to_string(),
            thread_id: thread_id.to_owned(),
            sequence,
            text: text.to_owned(),
            created_at: now(),
        };
        insert_interaction(&transaction, &interaction)?;
        transaction.execute(
            "UPDATE threads SET updated_at=?1 WHERE id=?2",
            params![interaction.created_at, thread_id],
        )?;
        transaction.commit()?;
        Ok(interaction)
    }
}

fn required<'a>(value: &'a str, name: &str) -> Result<&'a str, StoreError> {
    let value = value.trim();
    if value.is_empty() {
        Err(StoreError::Invalid(format!(
            "{name} must be a non-empty string"
        )))
    } else {
        Ok(value)
    }
}

fn canonical_directory(value: &str) -> Result<PathBuf, StoreError> {
    let path = std::fs::canonicalize(required(value, "path")?)?;
    if !path.is_dir() {
        return Err(StoreError::Invalid(format!(
            "project path is not a directory: {}",
            path.display()
        )));
    }
    Ok(path)
}

fn now() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time is before unix epoch")
        .as_millis()
        .to_string()
}

fn project_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Project> {
    Ok(Project {
        id: row.get(0)?,
        name: row.get(1)?,
        path: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
    })
}

fn thread_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Thread> {
    Ok(Thread {
        id: row.get(0)?,
        title: row.get(1)?,
        project_id: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
        root_interaction_id: row.get(5)?,
    })
}

fn interaction_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Interaction> {
    Ok(Interaction {
        id: row.get(0)?,
        thread_id: row.get(1)?,
        sequence: row.get(2)?,
        text: row.get(3)?,
        created_at: row.get(4)?,
    })
}

fn insert_interaction(
    transaction: &Transaction<'_>,
    interaction: &Interaction,
) -> Result<(), StoreError> {
    transaction.execute(
        "INSERT INTO interactions(id,thread_id,sequence,text,created_at) VALUES (?1,?2,?3,?4,?5)",
        params![
            interaction.id,
            interaction.thread_id,
            interaction.sequence,
            interaction.text,
            interaction.created_at
        ],
    )?;
    Ok(())
}
