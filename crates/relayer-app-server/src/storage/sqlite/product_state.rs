use super::{SqliteProductStore, interactions, projects, threads};
use crate::product::ThreadId;
use crate::storage::{ProductStateSnapshot, StorageError, ThreadSnapshot};

impl SqliteProductStore {
    pub(crate) async fn load_product_state(
        &self,
        requested_thread_id: Option<ThreadId>,
    ) -> Result<ProductStateSnapshot, StorageError> {
        let mut transaction = self.pool.begin().await?;
        let projects = projects::fetch_projects(&mut transaction).await?;
        let threads = threads::fetch_threads(&mut transaction).await?;
        let selected_thread_id = requested_thread_id
            .filter(|id| threads.iter().any(|thread| thread.id == *id))
            .or_else(|| threads.first().map(|thread| thread.id));
        let interactions = match selected_thread_id {
            Some(thread_id) => {
                interactions::fetch_interactions(&mut transaction, thread_id).await?
            }
            None => Vec::new(),
        };
        transaction.commit().await?;
        Ok(ProductStateSnapshot {
            projects,
            threads,
            selected_thread_id,
            interactions,
        })
    }

    pub(crate) async fn load_thread(
        &self,
        thread_id: ThreadId,
    ) -> Result<ThreadSnapshot, StorageError> {
        let mut transaction = self.pool.begin().await?;
        let thread = threads::fetch_thread(&mut transaction, thread_id).await?;
        let interactions = match thread {
            Some(_) => interactions::fetch_interactions(&mut transaction, thread_id).await?,
            None => Vec::new(),
        };
        transaction.commit().await?;
        Ok(ThreadSnapshot {
            thread,
            interactions,
        })
    }
}
