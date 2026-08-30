//! Cold-start reconciliation of the derived Ladybug bytes from canonical SQLite.

use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use relayer_graph_core::{
    DEFAULT_IMPORT_INDEX_BUDGET, GraphDatabase, GraphError, ProjectId, SearchIndex,
    SearchIndexComponent, SearchIndexRebuildSnapshot, SearchTarget, ThreadId,
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
    Ok(index.inventory().await? == super::schema::canonical_inventory(snapshot))
}

async fn damaged_targets(
    index: &LadybugSearchIndex,
    snapshot: &SearchIndexRebuildSnapshot,
) -> Result<HashSet<relayer_graph_core::SearchTarget>, GraphError> {
    let expected_inventory = super::schema::canonical_inventory(snapshot);
    let actual_inventory = index.inventory().await?;
    let mut targets = snapshot
        .closures
        .iter()
        .flat_map(|item| item.published_to.iter().copied())
        .chain(snapshot.targets.iter().map(|(target, _)| *target))
        .collect::<HashSet<_>>();
    for name in index.revision_targets().await? {
        if let Some(target) = parse_target(&name) {
            targets.insert(target);
        }
    }
    for name in actual_inventory.target_names().map_err(internal)? {
        if let Some(target) = parse_target(&name) {
            targets.insert(target);
        }
    }
    let mut damaged = HashSet::new();
    for target in targets.drain() {
        let expected_revision = snapshot
            .targets
            .iter()
            .find_map(|(candidate, revision)| (*candidate == target).then_some(*revision));
        if index.revision(target).await? != expected_revision {
            damaged.insert(target);
            continue;
        }
        if expected_inventory.projection(target).map_err(internal)?
            != actual_inventory.projection(target).map_err(internal)?
        {
            damaged.insert(target);
        }
    }
    Ok(damaged)
}

fn parse_target(value: &str) -> Option<SearchTarget> {
    let (kind, id) = value.split_once(':')?;
    let id = id.parse::<i64>().ok()?;
    match kind {
        "project" => ProjectId::new(id).map(SearchTarget::Project),
        "thread" => ThreadId::new(id).map(SearchTarget::Thread),
        _ => None,
    }
}

async fn background_rebuild(
    layout: StoreLayout,
    graph: GraphDatabase,
    index: LadybugSearchIndex,
    timeout: Duration,
    expected_versions: Vec<(SearchIndexComponent, String)>,
    previous: PathBuf,
) {
    index.wait_for_background_gate().await;
    let deadline = Instant::now() + DEFAULT_IMPORT_INDEX_BUDGET;
    let outcome = async {
        loop {
            if Instant::now() >= deadline {
                return Err(GraphError::Internal(
                    "Ladybug canonical rebuild exceeded its 60 second deadline".into(),
                ));
            }
            let snapshot = graph.search_index_rebuild_snapshot().await?;
            let epoch = index.epoch();
            let candidate = layout.create_generation().map_err(internal)?;
            let attempt = async {
                let built =
                    build_generation(&layout, &candidate, timeout, &snapshot, deadline).await?;
                drop(built);
                let reopened = LadybugSearchIndex::from_store(
                    open_store(layout.clone(), candidate.clone(), timeout).await?,
                );
                if !revisions_match(&reopened, &snapshot).await? {
                    return Err(GraphError::Internal(
                        "rebuilt search store failed reopen validation".into(),
                    ));
                }
                drop(reopened);
                Ok::<_, GraphError>(())
            };
            match tokio::time::timeout_at(tokio::time::Instant::from_std(deadline), attempt).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    let _ = std::fs::remove_dir_all(&candidate);
                    return Err(error);
                }
                Err(_) => {
                    let _ = std::fs::remove_dir_all(&candidate);
                    return Err(GraphError::Internal(
                        "Ladybug canonical rebuild exceeded its 60 second deadline".into(),
                    ));
                }
            }

            // This barrier is held only for the final canonical comparison and
            // pointer swap. Unaffected targets remain readable and writable for
            // the entire side-by-side build.
            let _publication = graph.lock_search_rebuild().await;
            let latest = graph.search_index_rebuild_snapshot().await?;
            if latest != snapshot || index.epoch() != epoch {
                let _ = std::fs::remove_dir_all(&candidate);
                continue;
            }
            let _operations = index.lock_operations().await;
            if index.epoch() != epoch {
                let _ = std::fs::remove_dir_all(&candidate);
                continue;
            }
            layout.publish(&candidate).map_err(internal)?;
            let active = open_store(layout.clone(), candidate.clone(), timeout).await?;
            index.install_store(active);
            layout.retain_previous(&previous, true).map_err(internal)?;
            graph
                .record_search_index_rebuild_receipt(&snapshot.targets, &expected_versions)
                .await?;
            return Ok(());
        }
    }
    .await;
    index.finish_rebuild(outcome.is_ok());
}

async fn build_generation(
    layout: &StoreLayout,
    generation: &Path,
    timeout: Duration,
    snapshot: &SearchIndexRebuildSnapshot,
    deadline: Instant,
) -> Result<LadybugSearchIndex, GraphError> {
    let store = open_store(layout.clone(), generation.to_owned(), timeout).await?;
    let index = LadybugSearchIndex::from_store(store);
    for (target, revision) in &snapshot.targets {
        let mut write = index.begin_until(*target, *revision, deadline).await?;
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
        Err(error) => match layout.snapshot_legacy_active().map_err(internal)? {
            Some(previous) => (Some(previous), true),
            None => return Err(internal(error)),
        },
    };
    let existing = match previous.as_ref() {
        Some(path) => open_store(layout.clone(), path.clone(), timeout)
            .await
            .ok()
            .map(LadybugSearchIndex::from_store),
        None => None,
    };
    #[cfg(feature = "crash-test-support")]
    if fault == Some(SearchIndexLifecycleFault::ReplacePointerAfterOpen) && existing.is_some() {
        let replacement = layout.create_generation().map_err(internal)?;
        layout.publish(&replacement).map_err(internal)?;
    }
    let observed_after_open = layout.active_generation().ok().flatten();
    let pointer_stable = observed_after_open.as_ref() == previous.as_ref();
    if !legacy_active
        && pointer_stable
        && versions_match(graph, &expected).await?
        && let Some(index) = existing.as_ref()
    {
        if revisions_match(index, &snapshot).await? {
            return Ok(index.clone());
        }
        let damaged = damaged_targets(index, &snapshot).await?;
        let index = index.clone();
        index.mark_rebuilding(damaged);
        #[cfg(feature = "crash-test-support")]
        if fault == Some(SearchIndexLifecycleFault::HoldLogicalRebuild) {
            index
                .runtime
                .background_hold
                .store(true, std::sync::atomic::Ordering::Release);
        }
        tokio::spawn(background_rebuild(
            layout.clone(),
            graph.clone(),
            index.clone(),
            timeout,
            expected.clone(),
            previous
                .clone()
                .expect("an open existing generation has a path"),
        ));
        return Ok(index);
    }
    drop(existing);

    let candidate = layout.create_generation().map_err(internal)?;
    let rebuild_deadline = Instant::now() + DEFAULT_IMPORT_INDEX_BUDGET;
    let rebuild = async {
        let rebuilt =
            build_generation(&layout, &candidate, timeout, &snapshot, rebuild_deadline).await?;
        drop(rebuilt);

        // Reopen before publication: a store that only validates through its
        // live writer is not durable proof of a restart-safe generation.
        let reopened = LadybugSearchIndex::from_store(
            open_store(layout.clone(), candidate.clone(), timeout).await?,
        );
        if !revisions_match(&reopened, &snapshot).await? {
            return Err(GraphError::Internal(
                "rebuilt search store failed reopen validation".into(),
            ));
        }
        drop(reopened);
        Ok::<_, GraphError>(())
    };
    match tokio::time::timeout_at(tokio::time::Instant::from_std(rebuild_deadline), rebuild).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            let _ = std::fs::remove_dir_all(&candidate);
            return Err(error);
        }
        Err(_) => {
            let _ = std::fs::remove_dir_all(&candidate);
            return Err(GraphError::Internal(
                "Ladybug canonical rebuild exceeded its 60 second deadline".into(),
            ));
        }
    }

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
    if !pointer_stable
        && let Some(raced) = observed_after_open.as_deref()
        && Some(raced) != previous.as_deref()
        && raced != candidate
    {
        layout.retain_previous(raced, true).map_err(internal)?;
    }
    graph
        .record_search_index_rebuild_receipt(&snapshot.targets, &expected)
        .await?;
    let active = open_store(layout, candidate, timeout).await?;
    Ok(LadybugSearchIndex::from_store(active))
}
