use sqlx::{SqlitePool, migrate::Migrator};

use crate::GraphError;

static MIGRATOR: Migrator = sqlx::migrate!("./src/storage/sqlite/migrations");

pub(crate) async fn run(pool: &SqlitePool) -> Result<(), GraphError> {
    MIGRATOR.run(pool).await?;
    Ok(())
}
