use super::SqliteProductStore;
use crate::product::{Project, ProjectId};
use crate::storage::StorageError;
use sqlx::{Row, sqlite::SqliteRow};

impl SqliteProductStore {
    pub(crate) async fn list_projects(&self) -> Result<Vec<Project>, StorageError> {
        let rows = sqlx::query(
            "SELECT id,name,path,created_at,updated_at FROM projects ORDER BY created_at ASC",
        )
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(project_from_row).collect()
    }

    pub(crate) async fn get_project(&self, id: ProjectId) -> Result<Option<Project>, StorageError> {
        sqlx::query("SELECT id,name,path,created_at,updated_at FROM projects WHERE id=?1")
            .bind(id.value())
            .fetch_optional(&self.pool)
            .await?
            .as_ref()
            .map(project_from_row)
            .transpose()
    }

    pub(crate) async fn project_by_path(
        &self,
        path: &str,
    ) -> Result<Option<Project>, StorageError> {
        sqlx::query("SELECT id,name,path,created_at,updated_at FROM projects WHERE path=?1")
            .bind(path)
            .fetch_optional(&self.pool)
            .await?
            .as_ref()
            .map(project_from_row)
            .transpose()
    }

    pub(crate) async fn insert_project(
        &self,
        name: &str,
        path: &str,
        timestamp: &str,
    ) -> Result<Project, StorageError> {
        let result = sqlx::query(
            "INSERT INTO projects(name,path,created_at,updated_at) VALUES (?1,?2,?3,?3)",
        )
        .bind(name)
        .bind(path)
        .bind(timestamp)
        .execute(&self.pool)
        .await?;
        let id = ProjectId::from_database(result.last_insert_rowid());
        self.get_project(id)
            .await?
            .ok_or_else(|| sqlx::Error::RowNotFound.into())
    }
}

fn project_from_row(row: &SqliteRow) -> Result<Project, StorageError> {
    Ok(Project {
        id: ProjectId::from_database(row.try_get(0)?),
        name: row.try_get(1)?,
        path: row.try_get(2)?,
        created_at: row.try_get(3)?,
        updated_at: row.try_get(4)?,
    })
}
