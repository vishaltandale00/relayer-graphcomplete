use std::collections::{HashSet, VecDeque};

use sha2::{Digest, Sha256};

use crate::{
    CompletionLifecycle, CurrentProjectionEvent, CurrentProjectionPage, CurrentTransition,
    CurrentTransitionReceipt, GraphDatabase, GraphError, LayerId, NavigateRelation, NodeId,
    SearchTarget,
    graph::InteractionScope,
    storage::sqlite::{
        currents::{CurrentTable, HeadMove, RevisionInsert},
        layers,
    },
};

use super::{
    accept, canonical_publication_matches, index_and_record, plan::CompletionPlan,
    read_accepted_publication_on,
};

pub(crate) async fn transition(
    database: &GraphDatabase,
    scope: &InteractionScope,
    expected_revision: u64,
    operation_key: &str,
    intent: &CurrentTransition,
) -> Result<CurrentTransitionReceipt, GraphError> {
    validate_operation_key(operation_key)?;
    if scope.authority_epoch.is_some() && matches!(intent, CurrentTransition::Fail { .. }) {
        return Err(GraphError::Forbidden(
            "Completion failure is owned by trusted control and is not available through the model broker."
                .into(),
        ));
    }
    validate_terminal_reason(intent)?;
    let request_digest = current_transition_request_digest(expected_revision, intent)?;
    let publishes_graph = matches!(
        intent,
        CurrentTransition::Advance { .. } | CurrentTransition::Return { .. }
    );
    let target = SearchTarget::new(scope.project_id, scope.thread_id);
    let _order = if publishes_graph {
        Some(database.order_writes_to(target).await)
    } else {
        None
    };
    let _publication = if publishes_graph {
        Some(database.enter_search_publication().await)
    } else {
        None
    };
    let expiry = database.expiry();
    let mut transaction = database.storage.begin_write().await?;
    scope.require_active_authority(&mut transaction).await?;
    if let Some(receipt) = CurrentTable::new(&mut transaction)
        .receipt(scope.root_node_id, operation_key)
        .await?
    {
        if receipt.request_digest == request_digest {
            let confirm = publishes_graph
                && canonical_publication_matches(database, &mut transaction, target).await?;
            transaction.commit().await?;
            if confirm {
                database.search_index.canonical_commit_confirmed(target);
            }
            return Ok(receipt);
        }
        return Err(GraphError::validation(
            "idempotency_conflict",
            "operationKey",
            "This operation key is already committed with different transition input.",
        ));
    }
    let persisted = CurrentTable::new(&mut transaction)
        .state(scope.root_node_id)
        .await?;
    if persisted.lifecycle != CompletionLifecycle::Active {
        return Err(GraphError::validation(
            "terminal_completion",
            "completion",
            "This completion is terminal and cannot publish more graph work.",
        ));
    }
    if persisted.head_revision != expected_revision {
        return Err(GraphError::validation(
            "stale_revision",
            "expectedRevision",
            format!(
                "Expected revision {expected_revision}, but the durable current is revision {}.",
                persisted.head_revision
            ),
        ));
    }
    let revision = expected_revision
        .checked_add(1)
        .ok_or_else(|| GraphError::Internal("completion revision overflow".into()))?;
    let (current_layer_id, final_layer_id, snapshot_digest, search_publication) = match intent {
        CurrentTransition::Advance { layer_id } => {
            if persisted.current_layer_id == Some(*layer_id) {
                return Err(GraphError::validation(
                    "current_unchanged",
                    "layerId",
                    "Advance must publish a new current layer.",
                ));
            }
            let plan = CompletionPlan::build_current(&mut transaction, scope, *layer_id).await?;
            require_accessibility(
                &mut transaction,
                scope,
                persisted.current_layer_id,
                *layer_id,
            )
            .await?;
            let digest = snapshot_digest(&plan);
            accept::publish(&mut transaction, scope, &plan, Some(revision)).await?;
            let publication =
                read_accepted_publication_on(&mut transaction, scope, *layer_id, None).await?;
            (Some(*layer_id), None, digest, Some(publication))
        }
        CurrentTransition::Return { layer_id } => {
            let plan = CompletionPlan::build_return(
                &mut transaction,
                scope,
                *layer_id,
                persisted.current_layer_id,
            )
            .await?;
            require_accessibility(
                &mut transaction,
                scope,
                persisted.current_layer_id,
                *layer_id,
            )
            .await?;
            let digest = snapshot_digest(&plan);
            accept::publish(&mut transaction, scope, &plan, Some(revision)).await?;
            let root_action = plan.root_action()?.clone();
            accept::finalize(&mut transaction, scope, &plan).await?;
            let publication =
                read_accepted_publication_on(&mut transaction, scope, *layer_id, Some(root_action))
                    .await?;
            (Some(*layer_id), Some(*layer_id), digest, Some(publication))
        }
        CurrentTransition::Stop { .. } | CurrentTransition::Fail { .. } => (
            persisted.current_layer_id,
            None,
            format!("sha256:{:x}", Sha256::digest(b"no-publication")),
            None,
        ),
    };
    CurrentTable::new(&mut transaction)
        .append_revision(RevisionInsert {
            interaction: scope.root_node_id,
            revision,
            transition: intent.name(),
            base_revision: expected_revision,
            current_layer_id,
            lifecycle: intent.lifecycle(),
            operation_key,
            request_digest: &request_digest,
            snapshot_digest: &snapshot_digest,
            safe_reason: intent.safe_reason(),
        })
        .await?;
    let moved = CurrentTable::new(&mut transaction)
        .move_head(HeadMove {
            interaction: scope.root_node_id,
            expected_revision,
            revision,
            lifecycle: intent.lifecycle(),
            current_layer_id,
            final_layer_id,
            safe_reason: intent.safe_reason(),
        })
        .await?;
    if !moved {
        return Err(GraphError::validation(
            "stale_revision",
            "expectedRevision",
            "The completion current changed before this transition committed.",
        ));
    }
    let projection_sequence = CurrentTable::new(&mut transaction)
        .append_projection(
            scope.root_node_id,
            revision,
            match intent {
                CurrentTransition::Advance { .. } => "advanced",
                CurrentTransition::Return { .. } => "returned",
                CurrentTransition::Stop { .. } => "stopped",
                CurrentTransition::Fail { .. } => "failed",
            },
        )
        .await?;
    if let Some(publication) = search_publication {
        #[cfg(feature = "crash-test-support")]
        super::crash_checkpoint(
            database,
            super::CompletionCrashPoint::AfterSqliteClosureWrite,
        );
        if let Err(error) = index_and_record(
            database,
            &mut transaction,
            target,
            vec![publication],
            crate::publication_targets(scope.project_id, scope.thread_id),
            expiry,
        )
        .await
        {
            transaction.rollback().await?;
            return Err(error);
        }
    }
    if publishes_graph {
        database.commit_indexed_write(transaction, target).await?;
    } else {
        transaction.commit().await?;
    }
    #[cfg(feature = "crash-test-support")]
    super::crash_checkpoint(database, super::CompletionCrashPoint::AfterSqliteCommit);
    Ok(CurrentTransitionReceipt {
        completion_id: scope.root_node_id,
        revision,
        lifecycle: intent.lifecycle(),
        current_layer_id,
        final_layer_id,
        operation_key: operation_key.into(),
        request_digest,
        snapshot_digest,
        projection_sequence,
    })
}

async fn require_accessibility(
    connection: &mut crate::storage::GraphConnection,
    scope: &InteractionScope,
    old_layer: Option<LayerId>,
    new_layer: LayerId,
) -> Result<(), GraphError> {
    if let Some(old_layer) = old_layer
        && old_layer != new_layer
        && !layer_reachable(connection, scope, new_layer, old_layer).await?
    {
        return Err(GraphError::validation(
            "current_accessibility_lost",
            "layerId",
            format!(
                "The proposed current layer {new_layer} does not preserve graph navigation to prior current layer {old_layer}. Add a genuine reference path to that exact layer."
            ),
        ));
    }
    Ok(())
}

pub(crate) async fn projections_after(
    database: &GraphDatabase,
    after_sequence: u64,
    limit: u32,
) -> Result<Vec<CurrentProjectionEvent>, GraphError> {
    if !(1..=500).contains(&limit) {
        return Err(GraphError::validation(
            "invalid_projection_limit",
            "limit",
            "Projection page limit must be between 1 and 500.",
        ));
    }
    let mut transaction = database.storage.begin_read().await?;
    let events = CurrentTable::new(&mut transaction)
        .projections_after(after_sequence, limit)
        .await?;
    transaction.commit().await?;
    Ok(events)
}

pub(crate) async fn projection_page(
    database: &GraphDatabase,
    completion_ids: &[NodeId],
    after_sequence: u64,
    limit: u32,
) -> Result<CurrentProjectionPage, GraphError> {
    if completion_ids.is_empty() || completion_ids.len() > 200 {
        return Err(GraphError::validation(
            "invalid_projection_subjects",
            "completionIds",
            "Projection reads require 1-200 completion identities.",
        ));
    }
    let mut unique = completion_ids.to_vec();
    unique.sort_unstable_by_key(|id| id.value());
    unique.dedup();
    if unique.len() != completion_ids.len() {
        return Err(GraphError::validation(
            "duplicate_projection_subject",
            "completionIds",
            "Projection completion identities must be unique.",
        ));
    }
    if !(1..=500).contains(&limit) {
        return Err(GraphError::validation(
            "invalid_projection_limit",
            "limit",
            "Projection page limit must be between 1 and 500.",
        ));
    }
    let mut transaction = database.storage.begin_read().await?;
    let states = CurrentTable::new(&mut transaction)
        .states_for(&unique)
        .await?;
    if states.len() != unique.len() {
        return Err(GraphError::Forbidden(
            "one or more requested completion projections are unavailable".into(),
        ));
    }
    let enabled_ids = states
        .iter()
        .filter(|state| state.temporal_features.projection_ui)
        .map(|state| state.completion_id)
        .collect::<Vec<_>>();
    let states = states
        .into_iter()
        .filter(|state| state.temporal_features.projection_ui)
        .collect::<Vec<_>>();
    let mut events = if enabled_ids.is_empty() {
        Vec::new()
    } else {
        CurrentTable::new(&mut transaction)
            .projections_after_for(&enabled_ids, after_sequence, limit + 1)
            .await?
    };
    let has_more = events.len() > limit as usize;
    events.truncate(limit as usize);
    let cursor = events.last().map_or(after_sequence, |event| event.sequence);
    transaction.commit().await?;
    Ok(CurrentProjectionPage {
        cursor,
        has_more,
        states,
        events,
    })
}

async fn layer_reachable(
    connection: &mut crate::storage::GraphConnection,
    scope: &InteractionScope,
    start: LayerId,
    expected: LayerId,
) -> Result<bool, GraphError> {
    let mut pending = VecDeque::from([start]);
    let mut visited = HashSet::new();
    while let Some(layer_id) = pending.pop_front() {
        if !visited.insert(layer_id) {
            continue;
        }
        if layer_id == expected {
            return Ok(true);
        }
        let layer = layers::resolve(&mut *connection, scope, layer_id, false).await?;
        for action in layer.actions {
            if action.kind == crate::ActionKind::Navigate
                && matches!(
                    action.relation,
                    Some(NavigateRelation::Expand | NavigateRelation::Reference)
                )
                && let Some(target) = action.target_layer_id
            {
                pending.push_back(target);
            }
        }
    }
    Ok(false)
}

pub fn current_transition_request_digest(
    expected_revision: u64,
    intent: &CurrentTransition,
) -> Result<String, GraphError> {
    let canonical = serde_json::to_vec(&(expected_revision, intent)).map_err(|error| {
        GraphError::Internal(format!("could not digest current request: {error}"))
    })?;
    Ok(format!("sha256:{:x}", Sha256::digest(canonical)))
}

fn snapshot_digest(plan: &CompletionPlan) -> String {
    let mut nodes = plan.nodes.iter().map(|id| id.value()).collect::<Vec<_>>();
    let mut edges = plan.edges.iter().map(|id| id.value()).collect::<Vec<_>>();
    let mut layers = plan.layers.iter().map(|id| id.value()).collect::<Vec<_>>();
    let mut actions = plan.actions.iter().map(|id| id.value()).collect::<Vec<_>>();
    nodes.sort_unstable();
    edges.sort_unstable();
    layers.sort_unstable();
    actions.sort_unstable();
    let canonical = serde_json::to_vec(&(plan.root_layer.value(), nodes, edges, layers, actions))
        .expect("snapshot identity is serializable");
    format!("sha256:{:x}", Sha256::digest(canonical))
}

fn validate_operation_key(value: &str) -> Result<(), GraphError> {
    if value.is_empty() || value.len() > 200 || value.chars().any(char::is_control) {
        return Err(GraphError::validation(
            "invalid_operation_key",
            "operationKey",
            "Operation key must contain 1-200 non-control UTF-8 characters.",
        ));
    }
    Ok(())
}

fn validate_terminal_reason(intent: &CurrentTransition) -> Result<(), GraphError> {
    const FAILURE_REASONS: &[&str] = &[
        "authentication",
        "model_not_found",
        "rate_limit",
        "provider_5xx",
        "provider_timeout",
        "transport",
        "provider_disconnected",
        "model_unavailable",
        "configuration",
        "permission_receipt_mismatch",
        "application_restart",
        "provider_crashed",
        "provider_exited_without_return",
        "execution",
    ];
    let valid = match intent {
        CurrentTransition::Stop { reason } => reason == "cancelled_by_user",
        CurrentTransition::Fail { reason } => FAILURE_REASONS.contains(&reason.as_str()),
        CurrentTransition::Advance { .. } | CurrentTransition::Return { .. } => true,
    };
    if valid {
        Ok(())
    } else {
        Err(GraphError::validation(
            "invalid_terminal_reason",
            "reason",
            "Terminal reason must be a canonical user-safe reason code.",
        ))
    }
}
