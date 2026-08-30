//! Cold-start reconciliation of the derived Ladybug bytes from canonical SQLite.

use std::{
    path::Path,
    time::{Duration, Instant},
};

use relayer_graph_core::{
    DEFAULT_IMPORT_INDEX_BUDGET, GraphDatabase, GraphError, SearchIndex, SearchIndexComponent,
    SearchIndexRebuildSnapshot,
};

use super::{
    LadybugSearchIndex, internal,
    store::{LadybugStore, StoreLayout},
};

#[cfg(feature = "crash-test-support")]
use super::SearchIndexLifecycleFault;

#[cfg(not(feature = "crash-test-support"))]
type SearchIndexLifecycleFault = ();

fn expected_versions() -> Vec<(SearchIndexComponent, String)> {
    vec![
        (SearchIndexComponent::Engine, "lbug 0.18.0".into()),
        (
            SearchIndexComponent::StorageFormat,
            lbug::get_storage_version().to_string(),
        ),
        (SearchIndexComponent::RelayerSchema, "1".into()),
        (
            SearchIndexComponent::QueryContract,
            "relayer.graph-query 1".into(),
        ),
        (SearchIndexComponent::DerivedIndex, "1".into()),
    ]
}

async fn open_store(
    layout: StoreLayout,
    generation: std::path::PathBuf,
    timeout: Duration,
) -> Result<LadybugStore, GraphError> {
    tokio::task::spawn_blocking(move || LadybugStore::open_path(layout, generation, timeout))
        .await
        .map_err(|error| GraphError::Internal(format!("search index worker failed: {error}")))?
        .map_err(internal)
}

async fn versions_match(
    graph: &GraphDatabase,
    expected: &[(SearchIndexComponent, String)],
) -> Result<bool, GraphError> {
    for (component, version) in expected {
        if graph.search_index_version(*component).await?.as_deref() != Some(version.as_str()) {
            return Ok(false);
        }
    }
    Ok(true)
}

async fn revisions_match(
    index: &LadybugSearchIndex,
    snapshot: &SearchIndexRebuildSnapshot,
) -> Result<bool, GraphError> {
    if index.revision_count().await? != snapshot.targets.len() {
        return Ok(false);
    }
    for (target, revision) in &snapshot.targets {
        if index.revision(*target).await? != Some(*revision) {
            return Ok(false);
        }
    }
    Ok(true)
}

async fn build_generation(
    layout: &StoreLayout,
    generation: &Path,
    timeout: Duration,
    snapshot: &SearchIndexRebuildSnapshot,
) -> Result<LadybugSearchIndex, GraphError> {
    let store = open_store(layout.clone(), generation.to_owned(), timeout).await?;
    let index = LadybugSearchIndex::from_store(store);
    for (target, revision) in &snapshot.targets {
        let mut write = index
            .begin_until(
                *target,
                *revision,
                Instant::now() + DEFAULT_IMPORT_INDEX_BUDGET,
            )
            .await?;
        for item in snapshot
            .closures
            .iter()
            .filter(|item| item.target == *target)
        {
            write
                .apply(item.closure.clone(), item.published_to.clone())
                .await?;
        }
        let committed = write.commit().await?;
        if committed != *revision {
            return Err(GraphError::Internal(
                "rebuilt search revision did not match canonical SQLite".into(),
            ));
        }
    }
    if !revisions_match(&index, snapshot).await? {
        return Err(GraphError::Internal(
            "rebuilt search store failed revision validation".into(),
        ));
    }
    Ok(index)
}

pub async fn open_reconciled(
    database: &Path,
    graph: &GraphDatabase,
    timeout: Duration,
    fault: Option<SearchIndexLifecycleFault>,
) -> Result<LadybugSearchIndex, GraphError> {
    let layout = StoreLayout::beside(database);
    let snapshot = graph.search_index_rebuild_snapshot().await?;
    let expected = expected_versions();
    let (previous, legacy_active) = match layout.active_generation() {
        Ok(previous) => (previous, false),
        Err(_) => (layout.snapshot_legacy_active().map_err(internal)?, true),
    };
    let existing = match previous.as_ref() {
        Some(path) => open_store(layout.clone(), path.clone(), timeout)
            .await
            .ok()
            .map(LadybugSearchIndex::from_store),
        None => None,
    };
    if !legacy_active
        && versions_match(graph, &expected).await?
        && let Some(index) = existing.as_ref()
        && revisions_match(index, &snapshot).await?
    {
        return Ok(index.clone());
    }
    drop(existing);

    let candidate = layout.create_generation().map_err(internal)?;
    let rebuilt = match build_generation(&layout, &candidate, timeout, &snapshot).await {
        Ok(index) => index,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&candidate);
            return Err(error);
        }
    };
    drop(rebuilt);

    // Reopen before publication: a store that only validates through its live
    // writer is not durable proof of a restart-safe generation.
    let reopened = LadybugSearchIndex::from_store(
        open_store(layout.clone(), candidate.clone(), timeout).await?,
    );
    if !revisions_match(&reopened, &snapshot).await? {
        drop(reopened);
        let _ = std::fs::remove_dir_all(&candidate);
        return Err(GraphError::Internal(
            "rebuilt search store failed reopen validation".into(),
        ));
    }
    drop(reopened);

    #[cfg(feature = "crash-test-support")]
    if fault == Some(SearchIndexLifecycleFault::BeforePublish) {
        let _ = std::fs::remove_dir_all(&candidate);
        return Err(GraphError::Internal(
            "injected rebuilt search validation failure".into(),
        ));
    }

    #[cfg(not(feature = "crash-test-support"))]
    let _ = fault;

    layout.publish(&candidate).map_err(internal)?;
    if legacy_active {
        layout.remove_legacy_sidecars().map_err(internal)?;
    }
    if let Some(previous) = previous.as_deref() {
        // A generation rejected by version, open, or revision validation is
        // evidence, not rollback material.
        layout.retain_previous(previous, true).map_err(internal)?;
    }
    graph.record_search_index_versions(&expected).await?;
    let active = open_store(layout, candidate, timeout).await?;
    Ok(LadybugSearchIndex::from_store(active))
}
