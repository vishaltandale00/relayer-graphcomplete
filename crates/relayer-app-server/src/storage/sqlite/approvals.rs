use super::SqliteProductStore;
use crate::{
    approval::{
        ApprovalCorrelation, ApprovalDecision, ApprovalOutcome, ApprovalReceipt, ApprovalRequest,
        ApprovalResolution,
    },
    product::{InteractionId, ThreadId},
    storage::StorageError,
};
use sqlx::{Row, SqliteConnection, sqlite::SqliteRow};

impl SqliteProductStore {
    pub(crate) async fn get_approval(
        &self,
        request_id: &str,
    ) -> Result<Option<ApprovalReceipt>, StorageError> {
        let mut connection = self.pool.acquire().await?;
        fetch_approval(&mut connection, request_id).await
    }

    pub(crate) async fn record_approval_request(
        &self,
        request: &ApprovalRequest,
    ) -> Result<ApprovalReceipt, StorageError> {
        request.validate().map_err(StorageError::ApprovalConflict)?;
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let stored_thread_id: Option<i64> =
            sqlx::query_scalar("SELECT thread_id FROM interactions WHERE id=?1")
                .bind(request.correlation.interaction_id)
                .fetch_optional(&mut *transaction)
                .await?;
        if stored_thread_id != Some(request.correlation.thread_id) {
            return Err(StorageError::ApprovalConflict(
                "request correlation does not identify one stored interaction".into(),
            ));
        }
        if let Some(existing) = fetch_approval(&mut transaction, &request.request_id).await? {
            if existing.request != *request {
                return Err(StorageError::ApprovalConflict(format!(
                    "request ID {} was reused with different content",
                    request.request_id
                )));
            }
            transaction.commit().await?;
            return Ok(existing);
        }
        sqlx::query(
            "INSERT INTO approval_requests(request_id,interaction_id,complete_call_id,harness_session_id,title,reason,action_json,scope_keys_json,scope_description,created_at,expires_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
        )
        .bind(&request.request_id)
        .bind(request.correlation.interaction_id)
        .bind(&request.correlation.complete_call_id)
        .bind(&request.correlation.harness_session_id)
        .bind(&request.title)
        .bind(&request.reason)
        .bind(json(&request.action)?)
        .bind(json(&request.scope_keys)?)
        .bind(&request.scope_description)
        .bind(&request.created_at)
        .bind(&request.expires_at)
        .execute(&mut *transaction)
        .await?;
        let status: String =
            sqlx::query_scalar("SELECT completion_status FROM interactions WHERE id=?1")
                .bind(request.correlation.interaction_id)
                .fetch_one(&mut *transaction)
                .await?;
        if status == "running" {
            sqlx::query(
                "UPDATE interactions SET completion_status='waiting_for_approval' WHERE id=?1 AND completion_status='running'",
            )
            .bind(request.correlation.interaction_id)
            .execute(&mut *transaction)
            .await?;
        } else if status != "waiting_for_approval" {
            return Err(StorageError::ApprovalConflict(format!(
                "interaction {} cannot request approval while {status}",
                request.correlation.interaction_id
            )));
        }
        transaction.commit().await?;
        Ok(ApprovalReceipt {
            request: request.clone(),
            resolution: None,
        })
    }

    pub(crate) async fn record_approval_resolution(
        &self,
        resolution: &ApprovalResolution,
        harness_live: bool,
    ) -> Result<ApprovalReceipt, StorageError> {
        resolution
            .validate()
            .map_err(StorageError::ApprovalConflict)?;
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let Some(mut receipt) = fetch_approval(&mut transaction, &resolution.request_id).await?
        else {
            return Err(StorageError::ApprovalConflict(format!(
                "resolution references unknown request {}",
                resolution.request_id
            )));
        };
        if receipt.request.correlation != resolution.correlation {
            return Err(StorageError::ApprovalConflict(format!(
                "resolution correlation differs from request {}",
                resolution.request_id
            )));
        }
        if let Some(existing) = &receipt.resolution {
            if existing != resolution {
                return Err(StorageError::ApprovalConflict(format!(
                    "request {} already has a different terminal resolution",
                    resolution.request_id
                )));
            }
            transaction.commit().await?;
            return Ok(receipt);
        }
        sqlx::query(
            "INSERT INTO approval_resolutions(request_id,outcome,actor,decision,rationale,source_request_id,resolved_at) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        )
        .bind(&resolution.request_id)
        .bind(resolution.outcome.as_str())
        .bind(resolution.actor.as_str())
        .bind(resolution.decision.map(ApprovalDecision::as_str))
        .bind(&resolution.rationale)
        .bind(&resolution.source_request_id)
        .bind(&resolution.resolved_at)
        .execute(&mut *transaction)
        .await?;

        let interaction_id = receipt.request.correlation.interaction_id;
        // An agent's child ends only through its own graph settlement, which its observers
        // project onto its row. An approval's end, whatever its outcome, never makes the row
        // terminal: once nothing is pending the child is running again until it settles.
        let agent_child: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM action_invocations WHERE result_interaction_id=?1 AND agent_invoked=1)",
        )
        .bind(interaction_id)
        .fetch_one(&mut *transaction)
        .await?;
        if agent_child {
            sqlx::query(
                "UPDATE interactions SET completion_status='running' WHERE id=?1 AND completion_status='waiting_for_approval' AND NOT EXISTS(SELECT 1 FROM approval_requests request LEFT JOIN approval_resolutions resolution ON resolution.request_id=request.request_id WHERE request.interaction_id=?1 AND resolution.request_id IS NULL)",
            )
            .bind(interaction_id)
            .execute(&mut *transaction)
            .await?;
            receipt.resolution = Some(resolution.clone());
            transaction.commit().await?;
            return Ok(receipt);
        }
        match resolution.outcome {
            ApprovalOutcome::Approved | ApprovalOutcome::Denied => {
                let pending: i64 = sqlx::query_scalar(
                    "SELECT COUNT(*) FROM approval_requests request LEFT JOIN approval_resolutions resolution ON resolution.request_id=request.request_id WHERE request.interaction_id=?1 AND resolution.request_id IS NULL",
                )
                .bind(interaction_id)
                .fetch_one(&mut *transaction)
                .await?;
                if pending == 0 && harness_live {
                    sqlx::query(
                        "UPDATE interactions SET completion_status='running' WHERE id=?1 AND completion_status='waiting_for_approval'",
                    )
                    .bind(interaction_id)
                    .execute(&mut *transaction)
                    .await?;
                }
            }
            ApprovalOutcome::Cancelled => {
                sqlx::query(
                    "UPDATE interactions SET completion_status='stopped',completion_error='Approval request was cancelled.' WHERE id=?1 AND completion_status IN ('running','waiting_for_approval') AND NOT EXISTS(SELECT 1 FROM interaction_stop_requests WHERE interaction_id=?1)",
                )
                .bind(interaction_id)
                .execute(&mut *transaction)
                .await?;
            }
            ApprovalOutcome::Expired => {
                sqlx::query(
                    "UPDATE interactions SET completion_status='failed',completion_error='Approval request expired at the provider.' WHERE id=?1 AND completion_status IN ('running','waiting_for_approval') AND NOT EXISTS(SELECT 1 FROM interaction_stop_requests WHERE interaction_id=?1)",
                )
                .bind(interaction_id)
                .execute(&mut *transaction)
                .await?;
            }
            ApprovalOutcome::Aborted => {
                sqlx::query(
                    "UPDATE interactions SET completion_status='failed',completion_error='Approval request was aborted because its harness session ended.' WHERE id=?1 AND completion_status IN ('running','waiting_for_approval') AND NOT EXISTS(SELECT 1 FROM interaction_stop_requests WHERE interaction_id=?1)",
                )
                .bind(interaction_id)
                .execute(&mut *transaction)
                .await?;
            }
        }
        // A Stop acknowledgment closes the approval, but only the execution
        // observer can declare the provider settled and write a terminal state.
        sqlx::query("UPDATE interactions SET completion_status='running' WHERE id=?1 AND completion_status='waiting_for_approval' AND EXISTS(SELECT 1 FROM interaction_stop_requests WHERE interaction_id=?1)")
            .bind(interaction_id).execute(&mut *transaction).await?;
        receipt.resolution = Some(resolution.clone());
        transaction.commit().await?;
        Ok(receipt)
    }

    pub(crate) async fn abort_pending_approvals(
        &self,
        interaction_id: Option<InteractionId>,
        rationale: &str,
        resolved_at: &str,
    ) -> Result<u64, StorageError> {
        self.abort_pending_approvals_with_restart_recovery(
            interaction_id,
            rationale,
            resolved_at,
            false,
        )
        .await
    }

    pub(crate) async fn abort_pending_approvals_on_restart(
        &self,
        rationale: &str,
        resolved_at: &str,
    ) -> Result<u64, StorageError> {
        self.abort_pending_approvals_with_restart_recovery(None, rationale, resolved_at, true)
            .await
    }

    async fn abort_pending_approvals_with_restart_recovery(
        &self,
        interaction_id: Option<InteractionId>,
        rationale: &str,
        resolved_at: &str,
        preserve_strict_graph_leases: bool,
    ) -> Result<u64, StorageError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let filter = interaction_id.map(InteractionId::value);
        let result = sqlx::query(
            "INSERT INTO approval_resolutions(request_id,outcome,actor,decision,rationale,source_request_id,resolved_at) SELECT request.request_id,'aborted','host',NULL,?1,NULL,?2 FROM approval_requests request LEFT JOIN approval_resolutions resolution ON resolution.request_id=request.request_id WHERE resolution.request_id IS NULL AND (?3 IS NULL OR request.interaction_id=?3)",
        )
        .bind(rationale)
        .bind(resolved_at)
        .bind(filter)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            "UPDATE interactions
             SET completion_status=CASE
                   WHEN ?3 AND EXISTS (
                     SELECT 1 FROM action_invocations
                     WHERE result_interaction_id=interactions.id AND graph_lease_required=1 AND authoritative=1
                   ) THEN 'submitted'
                   ELSE 'failed'
                 END,
                 completion_error=?1
             WHERE completion_status='waiting_for_approval' AND (?2 IS NULL OR id=?2)",
        )
        .bind(rationale)
        .bind(filter)
        .bind(preserve_strict_graph_leases)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(result.rows_affected())
    }
}

pub(super) async fn fetch_approvals(
    connection: &mut SqliteConnection,
    thread_id: ThreadId,
) -> Result<Vec<ApprovalReceipt>, StorageError> {
    let rows = sqlx::query(&format!(
        "{} WHERE interaction.thread_id=?1 ORDER BY request.created_at,request.request_id",
        approval_select()
    ))
    .bind(thread_id.value())
    .fetch_all(connection)
    .await?;
    rows.iter().map(approval_from_row).collect()
}

async fn fetch_approval(
    connection: &mut SqliteConnection,
    request_id: &str,
) -> Result<Option<ApprovalReceipt>, StorageError> {
    sqlx::query(&format!(
        "{} WHERE request.request_id=?1",
        approval_select()
    ))
    .bind(request_id)
    .fetch_optional(connection)
    .await?
    .as_ref()
    .map(approval_from_row)
    .transpose()
}

fn approval_select() -> &'static str {
    "SELECT request.request_id,request.interaction_id,interaction.thread_id,request.complete_call_id,request.harness_session_id,request.title,request.reason,request.action_json,request.scope_keys_json,request.scope_description,request.created_at,request.expires_at,resolution.outcome,resolution.actor,resolution.decision,resolution.rationale,resolution.source_request_id,resolution.resolved_at FROM approval_requests request JOIN interactions interaction ON interaction.id=request.interaction_id LEFT JOIN approval_resolutions resolution ON resolution.request_id=request.request_id"
}

fn approval_from_row(row: &SqliteRow) -> Result<ApprovalReceipt, StorageError> {
    let correlation = ApprovalCorrelation {
        thread_id: row.try_get(2)?,
        interaction_id: row.try_get(1)?,
        complete_call_id: row.try_get(3)?,
        harness_session_id: row.try_get(4)?,
    };
    let request_id: String = row.try_get(0)?;
    let outcome = row
        .try_get::<Option<String>, _>(12)?
        .map(|value| parse_json_string::<ApprovalOutcome>(&value))
        .transpose()?;
    let resolution = if let Some(outcome) = outcome {
        Some(ApprovalResolution {
            request_id: request_id.clone(),
            correlation: correlation.clone(),
            outcome,
            actor: parse_json_string(&row.try_get::<String, _>(13)?)?,
            decision: row
                .try_get::<Option<String>, _>(14)?
                .map(|value| parse_json_string(&value))
                .transpose()?,
            rationale: row.try_get(15)?,
            source_request_id: row.try_get(16)?,
            resolved_at: row.try_get(17)?,
        })
    } else {
        None
    };
    Ok(ApprovalReceipt {
        request: ApprovalRequest {
            request_id,
            correlation,
            title: row.try_get(5)?,
            reason: row.try_get(6)?,
            action: parse_json(&row.try_get::<String, _>(7)?)?,
            scope_keys: parse_json(&row.try_get::<String, _>(8)?)?,
            scope_description: row.try_get(9)?,
            created_at: row.try_get(10)?,
            expires_at: row.try_get(11)?,
        },
        resolution,
    })
}

fn json(value: &impl serde::Serialize) -> Result<String, StorageError> {
    serde_json::to_string(value).map_err(|error| StorageError::Serialization(error.to_string()))
}

fn parse_json<T: serde::de::DeserializeOwned>(value: &str) -> Result<T, StorageError> {
    serde_json::from_str(value).map_err(|error| StorageError::Serialization(error.to_string()))
}

fn parse_json_string<T: serde::de::DeserializeOwned>(value: &str) -> Result<T, StorageError> {
    parse_json(&serde_json::to_string(value).expect("serializing a string cannot fail"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approval::{ApprovalAction, ApprovalActor};

    #[tokio::test]
    async fn approval_records_are_idempotent_first_terminal_wins_and_drive_waiting_state() {
        let (store, _directory) = store().await;
        let thread = store
            .insert_thread_with_initial_interaction(crate::storage::NewThreadRecord {
                icon_selection_eligible: true,
                title: "Thread",
                project_id: None,
                initial_message: "Question",
                harness_configuration_name: "test",
                permission_profile_id: "ask",
                model_selection: None,
                timestamp: "1",
            })
            .await
            .unwrap();
        store
            .mark_interaction_running(thread.root_interaction_id, "test")
            .await
            .unwrap();
        let first = request(&thread, "request-1");
        let second = request(&thread, "request-2");

        assert_eq!(
            store.record_approval_request(&first).await.unwrap(),
            store.record_approval_request(&first).await.unwrap()
        );
        store.record_approval_request(&second).await.unwrap();
        assert_eq!(
            store
                .get_interaction(thread.root_interaction_id)
                .await
                .unwrap()
                .unwrap()
                .completion_status,
            "waiting_for_approval"
        );

        let first_resolution = resolution(&first, ApprovalOutcome::Approved);
        assert_eq!(
            store
                .record_approval_resolution(&first_resolution, true)
                .await
                .unwrap()
                .resolution,
            Some(first_resolution.clone())
        );
        assert_eq!(
            store
                .get_interaction(thread.root_interaction_id)
                .await
                .unwrap()
                .unwrap()
                .completion_status,
            "waiting_for_approval"
        );
        let conflicting = ApprovalResolution {
            outcome: ApprovalOutcome::Denied,
            decision: Some(ApprovalDecision::Deny),
            ..first_resolution.clone()
        };
        assert!(matches!(
            store.record_approval_resolution(&conflicting, true).await,
            Err(StorageError::ApprovalConflict(_))
        ));

        store
            .record_approval_resolution(&resolution(&second, ApprovalOutcome::Denied), true)
            .await
            .unwrap();
        assert_eq!(
            store
                .get_interaction(thread.root_interaction_id)
                .await
                .unwrap()
                .unwrap()
                .completion_status,
            "running"
        );
        drop(store);
    }

    /// An agent's child ends only through its own graph settlement. An approval that ends as
    /// aborted, cancelled or expired returns the child to running instead of ending its row,
    /// so the settlement its observers project never conflicts with it.
    #[tokio::test]
    async fn an_agent_childs_approval_never_ends_its_row() {
        let (store, _directory) = store().await;
        let thread = store
            .insert_thread_with_initial_interaction(crate::storage::NewThreadRecord {
                icon_selection_eligible: true,
                title: "Thread",
                project_id: None,
                initial_message: "Question",
                harness_configuration_name: "test",
                permission_profile_id: "ask",
                model_selection: None,
                timestamp: "1",
            })
            .await
            .unwrap();
        let child = sqlx::query("INSERT INTO interactions(thread_id,sequence,text,created_at,completion_status,permission_profile_id) VALUES (?1,2,'Child','2','running','ask')")
            .bind(thread.id.value())
            .execute(&store.pool)
            .await
            .unwrap()
            .last_insert_rowid();
        sqlx::query("INSERT INTO action_invocations(source_interaction_id,action_id,result_interaction_id,created_at,graph_lease_required,authoritative,agent_invoked) VALUES (?1,41,?2,'2',1,1,1)")
            .bind(thread.root_interaction_id.value())
            .bind(child)
            .execute(&store.pool)
            .await
            .unwrap();
        let status = |store: &SqliteProductStore| {
            let store = store.clone();
            async move {
                store
                    .get_interaction(InteractionId::from_database(child))
                    .await
                    .unwrap()
                    .unwrap()
                    .completion_status
            }
        };
        for (index, outcome) in [
            ApprovalOutcome::Aborted,
            ApprovalOutcome::Cancelled,
            ApprovalOutcome::Expired,
        ]
        .into_iter()
        .enumerate()
        {
            let mut pending = request(&thread, &format!("child-request-{index}"));
            pending.correlation.interaction_id = child;
            store.record_approval_request(&pending).await.unwrap();
            assert_eq!(status(&store).await, "waiting_for_approval");
            let ended = ApprovalResolution {
                actor: ApprovalActor::Host,
                decision: None,
                rationale: Some("The run ended.".into()),
                ..resolution(&pending, ApprovalOutcome::Approved)
            };
            store
                .record_approval_resolution(&ApprovalResolution { outcome, ..ended }, false)
                .await
                .unwrap();
            assert_eq!(status(&store).await, "running", "{outcome:?}");
        }
        drop(store);
    }

    #[tokio::test]
    async fn session_loss_aborts_pending_requests_and_never_restores_running() {
        let (store, _directory) = store().await;
        let thread = store
            .insert_thread_with_initial_interaction(crate::storage::NewThreadRecord {
                icon_selection_eligible: true,
                title: "Thread",
                project_id: None,
                initial_message: "Question",
                harness_configuration_name: "test",
                permission_profile_id: "ask",
                model_selection: None,
                timestamp: "1",
            })
            .await
            .unwrap();
        store
            .mark_interaction_running(thread.root_interaction_id, "test")
            .await
            .unwrap();
        let pending = request(&thread, "request-1");
        store.record_approval_request(&pending).await.unwrap();

        assert_eq!(
            store
                .abort_pending_approvals(None, "session ended", "3")
                .await
                .unwrap(),
            1
        );
        let receipt = store.get_approval("request-1").await.unwrap().unwrap();
        assert_eq!(
            receipt.resolution.unwrap().outcome,
            ApprovalOutcome::Aborted
        );
        let interaction = store
            .get_interaction(thread.root_interaction_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(interaction.completion_status, "failed");
        assert_eq!(
            interaction.completion_error.as_deref(),
            Some("session ended")
        );
        drop(store);
    }

    #[tokio::test]
    async fn stop_closes_approval_without_claiming_provider_settlement() {
        let (store, _directory) = store().await;
        let thread = store
            .insert_thread_with_initial_interaction(crate::storage::NewThreadRecord {
                icon_selection_eligible: true,
                title: "Stop pending approval",
                project_id: None,
                initial_message: "Work",
                harness_configuration_name: "test",
                permission_profile_id: "ask",
                model_selection: None,
                timestamp: "1",
            })
            .await
            .unwrap();
        store
            .mark_interaction_running(thread.root_interaction_id, "test")
            .await
            .unwrap();
        let pending = request(&thread, "stop-approval");
        store.record_approval_request(&pending).await.unwrap();
        store
            .request_interaction_stop(thread.id, thread.root_interaction_id)
            .await
            .unwrap();
        let mut cancelled = resolution(&pending, ApprovalOutcome::Approved);
        cancelled.outcome = ApprovalOutcome::Cancelled;
        cancelled.actor = ApprovalActor::Host;
        cancelled.decision = None;
        store
            .record_approval_resolution(&cancelled, true)
            .await
            .unwrap();
        let interaction = store
            .get_interaction(thread.root_interaction_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(interaction.completion_status, "running");
        assert!(interaction.stop_requested);
        store
            .finish_interaction_stopped(thread.root_interaction_id, "4")
            .await
            .unwrap();
        assert_eq!(
            store
                .get_interaction(thread.root_interaction_id)
                .await
                .unwrap()
                .unwrap()
                .completion_status,
            "stopped"
        );
    }

    async fn store() -> (SqliteProductStore, tempfile::TempDir) {
        let directory = tempfile::tempdir().unwrap();
        let store = SqliteProductStore::open(&directory.path().join("product.sqlite3"))
            .await
            .unwrap();
        (store, directory)
    }

    fn request(thread: &crate::product::Thread, request_id: &str) -> ApprovalRequest {
        ApprovalRequest {
            request_id: request_id.into(),
            correlation: ApprovalCorrelation {
                thread_id: thread.id.value(),
                interaction_id: thread.root_interaction_id.value(),
                complete_call_id: "complete-1".into(),
                harness_session_id: "session-1".into(),
            },
            title: "Run tests".into(),
            reason: "The command needs approval".into(),
            action: ApprovalAction::Command {
                command: "npm test".into(),
                working_directory: "/workspace".into(),
            },
            scope_keys: vec!["command:npm test".into(), "cwd:/workspace".into()],
            scope_description: "Run npm test in /workspace".into(),
            created_at: "2".into(),
            expires_at: None,
        }
    }

    fn resolution(request: &ApprovalRequest, outcome: ApprovalOutcome) -> ApprovalResolution {
        ApprovalResolution {
            request_id: request.request_id.clone(),
            correlation: request.correlation.clone(),
            outcome,
            actor: ApprovalActor::User,
            resolved_at: "3".into(),
            decision: Some(match outcome {
                ApprovalOutcome::Approved => ApprovalDecision::ApproveOnce,
                ApprovalOutcome::Denied => ApprovalDecision::Deny,
                _ => unreachable!(),
            }),
            rationale: None,
            source_request_id: None,
        }
    }
}
