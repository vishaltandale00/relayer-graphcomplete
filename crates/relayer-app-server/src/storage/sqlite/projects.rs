use super::SqliteProductStore;
use crate::product::{Project, ProjectId};
use crate::storage::StorageError;
use sqlx::{Row, SqliteConnection, sqlite::SqliteRow};

impl SqliteProductStore {
    pub(crate) async fn list_projects(&self) -> Result<Vec<Project>, StorageError> {
        let mut connection = self.pool.acquire().await?;
        fetch_projects(&mut connection).await
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

    pub(crate) async fn insert_or_get_project(
        &self,
        name: &str,
        path: &str,
        timestamp: &str,
    ) -> Result<(Project, bool), StorageError> {
        let result = sqlx::query(
            "INSERT INTO projects(name,path,created_at,updated_at) VALUES (?1,?2,?3,?3) ON CONFLICT(path) DO NOTHING",
        )
        .bind(name)
        .bind(path)
        .bind(timestamp)
        .execute(&self.pool)
        .await?;
        let created = result.rows_affected() == 1;
        let project = self
            .project_by_path(path)
            .await?
            .ok_or(sqlx::Error::RowNotFound)?;
        Ok((project, created))
    }
}

pub(super) async fn fetch_projects(
    connection: &mut SqliteConnection,
) -> Result<Vec<Project>, StorageError> {
    let rows = sqlx::query(
        "SELECT id,name,path,created_at,updated_at FROM projects ORDER BY created_at ASC",
    )
    .fetch_all(connection)
    .await?;
    rows.iter().map(project_from_row).collect()
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
