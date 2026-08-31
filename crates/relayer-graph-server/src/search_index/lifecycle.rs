//! Cold-start reconciliation of the derived Ladybug bytes from canonical SQLite.
//!
//! Product startup has one primary Electron process per desktop profile (see
//! `docs/architecture.md`), and that process owns one graph-server child through
//! its private standard-input control channel. This lifecycle relies on that
//! authority: it serializes publication inside the process and fails closed if
//! the active-generation pointer changes across a publication boundary. It does
//! not claim a multi-process writer protocol; Ladybug's exclusive store lock is
//! the remaining guard against unsupported competing processes.

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

fn rebuild_timeout() -> GraphError {
    GraphError::Internal("Ladybug canonical rebuild exceeded its 60 second deadline".into())
}

async fn until<T>(
    deadline: Instant,
    work: impl std::future::Future<Output = Result<T, GraphError>>,
) -> Result<T, GraphError> {
    tokio::time::timeout_at(tokio::time::Instant::from_std(deadline), work)
        .await
        .map_err(|_| rebuild_timeout())?
}

async fn blocking_until<T, F>(deadline: Instant, work: F) -> Result<T, GraphError>
where
    T: Send + 'static,
    F: FnOnce() -> anyhow::Result<T> + Send + 'static,
{
    until(deadline, async move {
        tokio::task::spawn_blocking(work)
            .await
            .map_err(|error| {
                GraphError::Internal(format!("search lifecycle worker failed: {error}"))
            })?
            .map_err(internal)
    })
    .await
}

async fn open_store_until(
    layout: StoreLayout,
    generation: PathBuf,
    timeout: Duration,
    deadline: Instant,
) -> Result<LadybugStore, GraphError> {
    until(deadline, open_store(layout, generation, timeout)).await
}

async fn require_unchanged_pointer(
    layout: &StoreLayout,
    expected: Option<&PathBuf>,
    deadline: Instant,
) -> Result<(), GraphError> {
    let check_layout = layout.clone();
    let current = blocking_until(deadline, move || check_layout.active_generation()).await?;
    if current.as_ref() != expected {
        return Err(GraphError::Internal(
            "active Ladybug generation changed during canonical rebuild".into(),
        ));
    }
    Ok(())
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
    let outcome = until(deadline, async {
        loop {
            let snapshot = graph.search_index_rebuild_snapshot().await?;
            let epoch = index.epoch();
            let create_layout = layout.clone();
            let candidate =
                blocking_until(deadline, move || create_layout.create_generation()).await?;
            if let Err(error) = async {
                let built =
                    build_generation(&layout, &candidate, timeout, &snapshot, deadline).await?;
                drop(built);
                let reopened = LadybugSearchIndex::from_store(
                    open_store_until(layout.clone(), candidate.clone(), timeout, deadline).await?,
                );
                if !revisions_match(&reopened, &snapshot).await? {
                    return Err(GraphError::Internal(
                        "rebuilt search store failed reopen validation".into(),
                    ));
                }
                Ok::<_, GraphError>(())
            }
            .await
            {
                let cleanup = candidate.clone();
                let _ = blocking_until(deadline, move || {
                    std::fs::remove_dir_all(cleanup).map_err(anyhow::Error::from)
                })
                .await;
                return Err(error);
            }

            // This barrier is held only for the final canonical comparison and
            // pointer swap. Unaffected targets remain readable and writable for
            // the entire side-by-side build.
            let _publication = graph.lock_search_rebuild().await;
            let latest = graph.search_index_rebuild_snapshot().await?;
            if latest != snapshot || index.epoch() != epoch {
                let cleanup = candidate.clone();
                blocking_until(deadline, move || {
                    std::fs::remove_dir_all(cleanup).map_err(anyhow::Error::from)
                })
                .await?;
                continue;
            }
            let _operations = index.lock_operations().await;
            if index.epoch() != epoch {
                let cleanup = candidate.clone();
                blocking_until(deadline, move || {
                    std::fs::remove_dir_all(cleanup).map_err(anyhow::Error::from)
                })
                .await?;
                continue;
            }
            if let Err(error) = require_unchanged_pointer(&layout, Some(&previous), deadline).await
            {
                let cleanup = candidate.clone();
                let _ = blocking_until(deadline, move || {
                    std::fs::remove_dir_all(cleanup).map_err(anyhow::Error::from)
                })
                .await;
                return Err(error);
            }
            let publish_layout = layout.clone();
            let publish_candidate = candidate.clone();
            blocking_until(deadline, move || publish_layout.publish(&publish_candidate)).await?;
            let active =
                open_store_until(layout.clone(), candidate.clone(), timeout, deadline).await?;
            index.install_store(active);
            let retain_layout = layout.clone();
            let retain_previous = previous.clone();
            blocking_until(deadline, move || {
                retain_layout.retain_previous(&retain_previous, true)
            })
            .await?;
            until(
                deadline,
                graph.record_search_index_rebuild_receipt(&snapshot.targets, &expected_versions),
            )
            .await?;
            return Ok(());
        }
    })
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
    let store = open_store_until(layout.clone(), generation.to_owned(), timeout, deadline).await?;
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
    rebuild_budget: Duration,
    fault: Option<SearchIndexLifecycleFault>,
) -> Result<LadybugSearchIndex, GraphError> {
    let layout = StoreLayout::beside(database);
    let rebuild_deadline = Instant::now() + rebuild_budget;
    let snapshot = graph.search_index_rebuild_snapshot().await?;
    let expected = expected_versions();
    let (previous, legacy_active) = match layout.active_generation() {
        Ok(previous) => (previous, false),
        Err(error) => match blocking_until(rebuild_deadline, {
            let layout = layout.clone();
            move || layout.snapshot_legacy_active()
        })
        .await?
        {
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
        match revisions_match(index, &snapshot).await {
            Ok(true) => return Ok(index.clone()),
            Ok(false) => {
                // Only a decodable logical mismatch can be isolated by target.
                // An inventory query or value-shape error means the shared
                // physical store is corrupt even when Ladybug can open it, so
                // startup must take the synchronous global rebuild path below.
                if let Ok(damaged) = damaged_targets(index, &snapshot).await {
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
            }
            Err(_) => {}
        }
    }
    drop(existing);

    let candidate = blocking_until(rebuild_deadline, {
        let layout = layout.clone();
        move || layout.create_generation()
    })
    .await?;
    until(rebuild_deadline, async {
        let rebuilt =
            build_generation(&layout, &candidate, timeout, &snapshot, rebuild_deadline).await?;
        drop(rebuilt);

        // Reopen before publication: a store that only validates through its
        // live writer is not durable proof of a restart-safe generation.
        let reopened = LadybugSearchIndex::from_store(
            open_store_until(layout.clone(), candidate.clone(), timeout, rebuild_deadline).await?,
        );
        if !revisions_match(&reopened, &snapshot).await? {
            return Err(GraphError::Internal(
                "rebuilt search store failed reopen validation".into(),
            ));
        }
        drop(reopened);

        #[cfg(feature = "crash-test-support")]
        if fault == Some(SearchIndexLifecycleFault::BeforePublish) {
            let cleanup = candidate.clone();
            blocking_until(rebuild_deadline, move || {
                std::fs::remove_dir_all(cleanup).map_err(anyhow::Error::from)
            })
            .await?;
            return Err(GraphError::Internal(
                "injected rebuilt search validation failure".into(),
            ));
        }

        #[cfg(not(feature = "crash-test-support"))]
        let _ = fault;

        #[cfg(feature = "crash-test-support")]
        if fault == Some(SearchIndexLifecycleFault::ReplacePointerBeforePublish) {
            let replacement_layout = layout.clone();
            blocking_until(rebuild_deadline, move || {
                let replacement = replacement_layout.create_generation()?;
                replacement_layout.publish(&replacement)
            })
            .await?;
        }

        // A pre-generation Ladybug database occupies `active` with binary
        // bytes, so it cannot participate in the text-pointer comparison. Its
        // immutable snapshot above is the migration input; normal generation
        // layouts always require the compare-before-publish guard.
        if !legacy_active
            && let Err(error) =
                require_unchanged_pointer(&layout, observed_after_open.as_ref(), rebuild_deadline)
                    .await
        {
            let cleanup = candidate.clone();
            let _ = blocking_until(rebuild_deadline, move || {
                std::fs::remove_dir_all(cleanup).map_err(anyhow::Error::from)
            })
            .await;
            return Err(error);
        }

        let publish_layout = layout.clone();
        let publish_candidate = candidate.clone();
        blocking_until(rebuild_deadline, move || {
            publish_layout.publish(&publish_candidate)
        })
        .await?;
        if legacy_active {
            let legacy_layout = layout.clone();
            blocking_until(rebuild_deadline, move || {
                legacy_layout.remove_legacy_sidecars()
            })
            .await?;
        }
        if let Some(previous) = previous.as_ref() {
            // A generation rejected by version, open, or revision validation is
            // evidence, not rollback material.
            let retain_layout = layout.clone();
            let previous = previous.clone();
            blocking_until(rebuild_deadline, move || {
                retain_layout.retain_previous(&previous, true)
            })
            .await?;
        }
        if !pointer_stable
            && let Some(raced) = observed_after_open.as_ref()
            && Some(raced) != previous.as_ref()
            && *raced != candidate
        {
            let retain_layout = layout.clone();
            let raced = raced.clone();
            blocking_until(rebuild_deadline, move || {
                retain_layout.retain_previous(&raced, true)
            })
            .await?;
        }
        until(
            rebuild_deadline,
            graph.record_search_index_rebuild_receipt(&snapshot.targets, &expected),
        )
        .await?;
        #[cfg(feature = "crash-test-support")]
        if fault == Some(SearchIndexLifecycleFault::DelayBeforeFinalOpen) {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let active = open_store_until(layout, candidate, timeout, rebuild_deadline).await?;
        Ok(LadybugSearchIndex::from_store(active))
    })
    .await
}
