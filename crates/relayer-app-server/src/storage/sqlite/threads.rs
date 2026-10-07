use super::{SqliteProductStore, catalog};
use crate::product::{InteractionId, ProjectId, Thread, ThreadId};
use crate::storage::{NewThreadRecord, StorageError};
use sqlx::{Row, SqliteConnection, sqlite::SqliteRow};

const THREAD_COLUMNS: &str = r#"
    SELECT t.id,t.title,t.project_id,t.created_at,t.updated_at,
           t.harness_configuration_name,
           t.permission_profile_id,
           (SELECT id FROM interactions WHERE thread_id=t.id ORDER BY sequence ASC LIMIT 1),
           t.conversation_import_id IS NOT NULL, t.icon, t.icon_selection_eligible, t.working_directory,
           COALESCE((SELECT group_project_id FROM projects WHERE id=t.project_id),t.project_id),t.checkout_context_json,
           (SELECT CASE
                WHEN i.completion_status IN ('not_started','running','submitted','waiting_for_approval')
                     AND EXISTS(SELECT 1 FROM interaction_stop_requests stop WHERE stop.interaction_id=i.id AND stop.error IS NULL) THEN 'stopping'
                WHEN i.completion_status='waiting_for_approval' THEN 'needs_approval'
                WHEN i.completion_status IN ('not_started','running','submitted') THEN 'running'
                WHEN i.completion_status='failed' THEN 'failed'
            END FROM interactions i WHERE i.thread_id=t.id ORDER BY i.sequence DESC LIMIT 1)
 ,t.archived_at, (SELECT busy FROM thread_archive_activity WHERE id=t.id)
    FROM threads t
"#;

const VISIBLE_THREAD: &str = "t.surface='conversation' AND (t.conversation_import_id IS NULL OR EXISTS(SELECT 1 FROM conversation_imports ci WHERE ci.id=t.conversation_import_id AND ci.state='published'))";

impl SqliteProductStore {
    pub(crate) async fn list_archived_threads(&self) -> Result<Vec<Thread>, StorageError> {
        let rows = sqlx::query(&format!("{THREAD_COLUMNS} WHERE {VISIBLE_THREAD} AND t.archived_at IS NOT NULL ORDER BY t.archived_at DESC,t.id DESC"))
            .fetch_all(&self.pool).await?;
        rows.iter().map(thread_from_row).collect()
    }

    pub(crate) async fn set_thread_archived(
        &self,
        id: ThreadId,
        archived: bool,
    ) -> Result<Option<Thread>, StorageError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let Some(thread) = fetch_thread(&mut transaction, id).await? else {
            return Ok(None);
        };
        if archived && thread.archive_blocked {
            return Err(StorageError::ThreadArchiveBusy);
        }
        // Idempotent archive preserves its original archive ordering.
        sqlx::query("UPDATE threads SET archived_at=CASE WHEN ?2 THEN COALESCE(archived_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ELSE NULL END WHERE id=?1")
            .bind(id.value()).bind(archived).execute(&mut *transaction).await?;
        let thread = fetch_thread(&mut transaction, id).await?;
        transaction.commit().await?;
        Ok(thread)
    }

    pub(crate) async fn restore_unstarted_thread_root(
        &self,
        id: ThreadId,
    ) -> Result<bool, StorageError> {
        let result=sqlx::query("UPDATE interactions SET completion_status='not_started',completion_error=NULL WHERE id=(SELECT id FROM interactions WHERE thread_id=?1 ORDER BY sequence LIMIT 1) AND completion_status='failed' AND graph_node_id IS NULL AND NOT EXISTS(SELECT 1 FROM interaction_attempts a WHERE a.interaction_id=interactions.id)").bind(id.value()).execute(&self.pool).await?;
        Ok(result.rows_affected() == 1)
    }
    pub(crate) async fn list_threads(&self) -> Result<Vec<Thread>, StorageError> {
        let mut connection = self.pool.acquire().await?;
        fetch_threads(&mut connection).await
    }

    pub(crate) async fn get_thread(&self, id: ThreadId) -> Result<Option<Thread>, StorageError> {
        let mut connection = self.pool.acquire().await?;
        fetch_thread(&mut connection, id).await
    }

    #[cfg(test)]
    pub(crate) async fn insert_thread_with_initial_interaction(
        &self,
        record: NewThreadRecord<'_>,
    ) -> Result<Thread, StorageError> {
        self.insert_thread_with_initial_interaction_and_personal_presentation(record, None)
            .await
    }

    #[cfg(test)]
    pub(crate) async fn insert_thread_with_initial_interaction_and_personal_presentation(
        &self,
        record: NewThreadRecord<'_>,
        personal_presentation_version_key: Option<&str>,
    ) -> Result<Thread, StorageError> {
        self.insert_thread_in_directory(record, personal_presentation_version_key, None)
            .await
    }

    #[cfg(test)]
    pub(crate) async fn insert_thread_in_directory(
        &self,
        record: NewThreadRecord<'_>,
        personal_presentation_version_key: Option<&str>,
        working_directory: Option<&str>,
    ) -> Result<Thread, StorageError> {
        self.insert_thread_with_creation_request(
            record,
            personal_presentation_version_key,
            working_directory,
            None,
            None,
        )
        .await
        .map(|(thread, _)| thread)
    }

    pub(crate) async fn insert_thread_with_creation_request(
        &self,
        record: NewThreadRecord<'_>,
        personal_presentation_version_key: Option<&str>,
        working_directory: Option<&str>,
        checkout_context: Option<&str>,
        creation_request: Option<(&str, &str)>,
    ) -> Result<(Thread, bool), StorageError> {
        if record
            .required_provider_adapter_id
            .is_some_and(|id| id != "codex-subscription")
        {
            return Err(crate::product::CatalogError::invalid(
                "execution_constraint_invalid",
                "The required provider adapter is unsupported.",
            )
            .into());
        }
        if record.required_provider_adapter_id.is_some() && record.model_selection.is_none() {
            return Err(crate::product::CatalogError::invalid(
                "execution_constraint_requires_route",
                "A constrained task requires a product family route.",
            )
            .into());
        }
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        if let Some((request_id, payload)) = creation_request
            && let Some(row) = sqlx::query(
                "SELECT thread_id,payload FROM thread_creation_requests WHERE request_id=?1",
            )
            .bind(request_id)
            .fetch_optional(&mut *transaction)
            .await?
        {
            if row.try_get::<String, _>(1)? != payload {
                return Err(StorageError::ThreadCreationConflict(
                    "creationRequestId already used for another draft".into(),
                ));
            }
            let id = ThreadId::from_database(row.try_get(0)?);
            let thread = fetch_thread(&mut transaction, id)
                .await?
                .ok_or(sqlx::Error::RowNotFound)?;
            transaction.commit().await?;
            return Ok((thread, false));
        }

        let resolved_model_selection = match record.model_selection {
            Some(selection) => {
                let (_, route) = catalog::resolve_execution_model_plan_on(
                    &mut transaction,
                    record.harness_configuration_name,
                    selection,
                )
                .await?;
                if record
                    .required_provider_adapter_id
                    .is_some_and(|required| required != route.adapter_id)
                {
                    return Err(crate::product::CatalogError::invalid("execution_provider_not_authorized", "This task requires the Codex subscription; API spending is not authorized.").into());
                }
                Some(crate::product::InteractionModelSelection {
                    family_id: route.family_id,
                    provider_id: route.provider_id,
                    model_id: route.model_id,
                })
            }
            None => None,
        };
        let thread = sqlx::query(
            "INSERT INTO threads(title,project_id,created_at,updated_at,harness_configuration_name,permission_profile_id,personal_presentation_version_key,working_directory,checkout_context_json,icon_selection_eligible) VALUES (?1,?2,?3,?3,?4,?5,?6,COALESCE(?7,(SELECT path FROM projects WHERE id=?2)),?8,?9)",
        )
        .bind(record.title)
        .bind(record.project_id.map(ProjectId::value))
        .bind(record.timestamp)
        .bind(record.harness_configuration_name)
        .bind(record.permission_profile_id)
        .bind(personal_presentation_version_key)
        .bind(working_directory)
        .bind(checkout_context)
        .bind(record.icon_selection_eligible)
        .execute(&mut *transaction)
        .await?;
        let thread_id = ThreadId::from_database(thread.last_insert_rowid());
        if let Some(required) = record.required_provider_adapter_id {
            sqlx::query("INSERT INTO thread_execution_constraints(thread_id,required_provider_adapter_id) VALUES (?1,?2)")
                .bind(thread_id.value()).bind(required).execute(&mut *transaction).await?;
        }

        sqlx::query(
            "INSERT INTO interactions(thread_id,sequence,text,created_at,permission_profile_id,model_provider_id,provider_model_id,model_family_id) VALUES (?1,1,?2,?3,?4,?5,?6,?7)",
        )
        .bind(thread_id.value())
        .bind(record.initial_message)
        .bind(record.timestamp)
        .bind(record.permission_profile_id)
        .bind(resolved_model_selection.as_ref().map(|selection| selection.provider_id.as_str()))
        .bind(resolved_model_selection.as_ref().map(|selection| selection.model_id.as_str()))
        .bind(resolved_model_selection.as_ref().map(|selection| selection.family_id.value()))
        .execute(&mut *transaction)
        .await?;
        if let Some((request_id, payload)) = creation_request {
            sqlx::query("INSERT INTO thread_creation_requests(request_id,payload,thread_id) VALUES (?1,?2,?3)").bind(request_id).bind(payload).bind(thread_id.value()).execute(&mut *transaction).await?;
        }
        transaction.commit().await?;
        self.get_thread(thread_id)
            .await?
            .ok_or_else(|| sqlx::Error::RowNotFound.into())
            .map(|thread| (thread, true))
    }
}

pub(super) async fn fetch_threads(
    connection: &mut SqliteConnection,
) -> Result<Vec<Thread>, StorageError> {
    let rows = sqlx::query(&format!(
        "{THREAD_COLUMNS} WHERE {VISIBLE_THREAD} AND t.archived_at IS NULL ORDER BY t.updated_at DESC, t.created_at DESC, t.id DESC"
    ))
    .fetch_all(connection)
    .await?;
    rows.iter().map(thread_from_row).collect()
}

pub(super) async fn fetch_thread(
    connection: &mut SqliteConnection,
    id: ThreadId,
) -> Result<Option<Thread>, StorageError> {
    sqlx::query(&format!(
        "{THREAD_COLUMNS} WHERE t.id=?1 AND {VISIBLE_THREAD}"
    ))
    .bind(id.value())
    .fetch_optional(connection)
    .await?
    .as_ref()
    .map(thread_from_row)
    .transpose()
}

fn thread_from_row(row: &SqliteRow) -> Result<Thread, StorageError> {
    Ok(Thread {
        id: ThreadId::from_database(row.try_get(0)?),
        title: row.try_get(1)?,
        icon: row.try_get(9)?,
        icon_selection_eligible: row.try_get::<i64, _>(10)? != 0,
        project_id: row
            .try_get::<Option<i64>, _>(2)?
            .map(ProjectId::from_database),
        created_at: row.try_get(3)?,
        updated_at: row.try_get(4)?,
        harness_configuration_name: row.try_get(5)?,
        permission_profile_id: row.try_get(6)?,
        root_interaction_id: InteractionId::from_database(row.try_get(7)?),
        imported: row.try_get::<i64, _>(8)? != 0,
        working_directory: row.try_get(11)?,
        checkout_context: row
            .try_get::<Option<String>, _>(13)?
            .map(|text| {
                serde_json::from_str(&text).map_err(|e| StorageError::Serialization(e.to_string()))
            })
            .transpose()?,
        grouped_project_id: row
            .try_get::<Option<i64>, _>(12)?
            .map(ProjectId::from_database),

        activity: row.try_get(14)?,
        archived_at: row.try_get(15)?,
        archive_blocked: row.try_get::<i64, _>(16)? != 0,
    })
}

/// Product metadata commits in the same transaction as the graph-authoritative receipt.
/// Invalid or absent selection never blocks otherwise accepted graph work.
pub(super) async fn commit_thread_icon(
    connection: &mut SqliteConnection,
    interaction_id: InteractionId,
    output: &serde_json::Value,
) -> Result<(), StorageError> {
    let Some(icon) = output
        .get("threadIconProposal")
        .and_then(serde_json::Value::as_str)
        .and_then(relayer_graph_core::resolve_icon_name)
    else {
        return Ok(());
    };
    sqlx::query("UPDATE threads SET icon=?1 WHERE id=(SELECT thread_id FROM interactions WHERE id=?2 AND completion_status='accepted') AND icon IS NULL AND icon_selection_eligible=1 AND surface='conversation' AND conversation_import_id IS NULL")
        .bind(icon).bind(interaction_id.value()).execute(connection).await?;
    Ok(())
}

#[cfg(test)]
mod icon_tests {
    use super::*;
    use crate::product::AcceptedInteractionCompletion;

    async fn accept(store: &SqliteProductStore, thread: &Thread, proposal: serde_json::Value) {
        let id = store
            .insert_interaction(thread.id, "Later completion", None, false, false)
            .await
            .unwrap()
            .id;
        sqlx::query("UPDATE interactions SET completion_status='running',graph_node_id=?2,harness_configuration_name='fixture',harness_configuration_digest='digest',effective_execution_digest='execution',effective_permission_receipt_json='{}' WHERE id=?1")
            .bind(id.value()).bind(id.value() + 10000).execute(&store.pool).await.unwrap();
        store
            .accept_interaction_completion(AcceptedInteractionCompletion {
                interaction_id: id,
                graph_node_id: id.value() + 10000,
                harness_configuration_name: "fixture",
                harness_configuration_digest: "digest",
                effective_execution_digest: "execution",
                effective_permission_receipt: &serde_json::json!({}),
                output: &proposal,
            })
            .await
            .unwrap();
    }

    async fn create(store: &SqliteProductStore, eligible: bool) -> Thread {
        store
            .insert_thread_with_initial_interaction(NewThreadRecord {
                required_provider_adapter_id: None,
                icon_selection_eligible: eligible,
                title: "Learn Rust",
                project_id: None,
                initial_message: "Help me learn Rust",
                harness_configuration_name: "fixture",
                permission_profile_id: "auto",
                model_selection: None,
                timestamp: "1",
            })
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn thread_icon_acceptance_retry_write_once_and_reopen() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("product.sqlite");
        let store = SqliteProductStore::open(&path).await.unwrap();
        let thread = create(&store, true).await;
        assert_eq!(thread.icon, None);
        // Draft, failed and stopped records have no acceptance authority.
        for state in ["running", "failed", "stopped"] {
            sqlx::query("UPDATE interactions SET completion_status=?1 WHERE id=?2")
                .bind(state)
                .bind(thread.root_interaction_id.value())
                .execute(&store.pool)
                .await
                .unwrap();
            let mut tx = store.pool.begin().await.unwrap();
            commit_thread_icon(
                &mut tx,
                thread.root_interaction_id,
                &serde_json::json!({"threadIconProposal":"book-open"}),
            )
            .await
            .unwrap();
            tx.commit().await.unwrap();
            assert_eq!(
                store.get_thread(thread.id).await.unwrap().unwrap().icon,
                None
            );
        }
        for proposal in [
            serde_json::json!({}),
            serde_json::json!({"threadIconProposal":"bad-icon"}),
            serde_json::json!({"threadIconProposal":42}),
        ] {
            accept(&store, &thread, proposal).await;
            assert_eq!(
                store.get_thread(thread.id).await.unwrap().unwrap().icon,
                None
            );
        }
        accept(
            &store,
            &thread,
            serde_json::json!({"threadIconProposal":"Book Open"}),
        )
        .await;
        assert_eq!(
            store
                .get_thread(thread.id)
                .await
                .unwrap()
                .unwrap()
                .icon
                .as_deref(),
            Some("book-open")
        );
        accept(
            &store,
            &thread,
            serde_json::json!({"threadIconProposal":"code"}),
        )
        .await;
        sqlx::query("UPDATE threads SET title='New topic' WHERE id=?1")
            .bind(thread.id.value())
            .execute(&store.pool)
            .await
            .unwrap();
        assert!(
            sqlx::query("UPDATE threads SET icon='code' WHERE id=?1")
                .bind(thread.id.value())
                .execute(&store.pool)
                .await
                .is_err()
        );
        store.pool.close().await;
        let reopened = SqliteProductStore::open(&path).await.unwrap();
        let saved = reopened.get_thread(thread.id).await.unwrap().unwrap();
        assert_eq!(saved.title, "New topic");
        assert_eq!(saved.icon.as_deref(), Some("book-open"));
    }

    #[tokio::test]
    async fn thread_icon_eval_exclusion_and_acceptance_recovery() {
        let directory = tempfile::tempdir().unwrap();
        let store = SqliteProductStore::open(&directory.path().join("product.sqlite"))
            .await
            .unwrap();
        let eval = create(&store, false).await;
        accept(
            &store,
            &eval,
            serde_json::json!({"threadIconProposal":"code"}),
        )
        .await;
        assert_eq!(store.get_thread(eval.id).await.unwrap().unwrap().icon, None);
        let normal = create(&store, true).await;
        sqlx::query("UPDATE interactions SET completion_status='running',graph_node_id=42,harness_configuration_name='fixture',harness_configuration_digest='digest',effective_execution_digest='execution',effective_permission_receipt_json='{}' WHERE id=?1")
            .bind(normal.root_interaction_id.value()).execute(&store.pool).await.unwrap();
        let output = serde_json::json!({"threadIconProposal":"compass"});
        assert!(
            store
                .recover_interaction_accepted(normal.root_interaction_id, &output)
                .await
                .unwrap()
        );
        assert!(
            !store
                .recover_interaction_accepted(
                    normal.root_interaction_id,
                    &serde_json::json!({"threadIconProposal":"code"})
                )
                .await
                .unwrap()
        );
        assert_eq!(
            store
                .get_thread(normal.id)
                .await
                .unwrap()
                .unwrap()
                .icon
                .as_deref(),
            Some("compass")
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn archive_round_trip_preserves_thread_history_scope_and_activity_order() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("archive.sqlite3");
        let store = SqliteProductStore::open(&database).await.unwrap();
        let (project, _) = store
            .insert_or_get_project("Project", directory.path().to_str().unwrap(), "1")
            .await
            .unwrap();
        for project_id in [None, Some(project.id)] {
            let thread = store
                .insert_thread_with_initial_interaction(NewThreadRecord {
                    required_provider_adapter_id: None,
                    icon_selection_eligible: true,
                    title: "Archive fixture",
                    project_id,
                    initial_message: "Saved question",
                    harness_configuration_name: "test",
                    permission_profile_id: "ask",
                    model_selection: None,
                    timestamp: "1",
                })
                .await
                .unwrap();
            set_status(&store, &thread, "failed").await;
            // Real persisted draft and saved checkout metadata remain attached to this identity.
            sqlx::query(
                "UPDATE threads SET working_directory=?1,checkout_context_json=?2 WHERE id=?3",
            )
            .bind(directory.path().to_str().unwrap())
            .bind(r#"{"kind":"existing","path":"/saved/checkout","branch":"feature"}"#)
            .bind(thread.id.value())
            .execute(&store.pool)
            .await
            .unwrap();
            sqlx::query("INSERT INTO node_context_drafts(id,thread_id,target_node_id,source_interaction_node_id,source_layer_id,target_node_json,text,revision,created_at,updated_at) VALUES (?1,?2,1,1,1,'{}','Unsent attached draft',1,'1','1')")
                .bind(format!("draft-{}", thread.id.value())).bind(thread.id.value()).execute(&store.pool).await.unwrap();
            let saved_thread = store.get_thread(thread.id).await.unwrap().unwrap();
            let before = store.load_thread(thread.id).await.unwrap();
            let archived = store
                .set_thread_archived(thread.id, true)
                .await
                .unwrap()
                .unwrap();
            assert!(archived.archived_at.is_some());
            assert_eq!(archived.updated_at, thread.updated_at);
            assert!(
                !store
                    .list_threads()
                    .await
                    .unwrap()
                    .iter()
                    .any(|t| t.id == thread.id)
            );
            assert_eq!(store.list_archived_threads().await.unwrap()[0], archived);
            assert_eq!(
                store
                    .set_thread_archived(thread.id, true)
                    .await
                    .unwrap()
                    .unwrap(),
                archived
            );
            let readable = store.load_thread(thread.id).await.unwrap();
            assert_eq!(readable.interactions, before.interactions);
            assert_eq!(readable.thread.unwrap().archived_at, archived.archived_at);
            let current = store.load_product_state(Some(thread.id)).await.unwrap();
            assert_eq!(current.selected_thread_id, Some(thread.id));
            assert!(
                current
                    .threads
                    .iter()
                    .any(|t| t.id == thread.id && t.archived_at.is_some())
            );
            let reopened = SqliteProductStore::open(&database).await.unwrap();
            assert_eq!(
                reopened.get_thread(thread.id).await.unwrap().unwrap(),
                archived
            );
            let restored = reopened
                .set_thread_archived(thread.id, false)
                .await
                .unwrap()
                .unwrap();
            let mut expected = archived;
            expected.archived_at = None;
            assert_eq!(restored, expected);
            assert_eq!(restored.project_id, thread.project_id);
            assert_eq!(restored.working_directory, saved_thread.working_directory);
            assert_eq!(restored.checkout_context, saved_thread.checkout_context);
            let draft: (String, i64) =
                sqlx::query_as("SELECT text,revision FROM node_context_drafts WHERE thread_id=?1")
                    .bind(thread.id.value())
                    .fetch_one(&reopened.pool)
                    .await
                    .unwrap();
            assert_eq!(draft, ("Unsent attached draft".into(), 1));
            assert_eq!(
                reopened.load_thread(thread.id).await.unwrap().interactions,
                before.interactions
            );
        }
    }

    #[tokio::test]
    async fn archive_serializes_both_admission_orders_and_checks_earlier_work() {
        let directory = tempfile::tempdir().unwrap();
        let store = SqliteProductStore::open(&directory.path().join("archive.sqlite3"))
            .await
            .unwrap();
        let thread = store
            .insert_thread_with_initial_interaction(NewThreadRecord {
                required_provider_adapter_id: None,
                icon_selection_eligible: true,
                title: "Race fixture",
                project_id: None,
                initial_message: "Saved question",
                harness_configuration_name: "test",
                permission_profile_id: "ask",
                model_selection: None,
                timestamp: "1",
            })
            .await
            .unwrap();
        for status in [
            "not_started",
            "submitted",
            "running",
            "waiting_for_approval",
        ] {
            set_status(&store, &thread, status).await;
            assert!(
                matches!(
                    store.set_thread_archived(thread.id, true).await,
                    Err(StorageError::ThreadArchiveBusy)
                ),
                "{status}"
            );
            assert!(
                store
                    .get_thread(thread.id)
                    .await
                    .unwrap()
                    .unwrap()
                    .archived_at
                    .is_none()
            );
        }
        store
            .request_interaction_stop(thread.id, thread.root_interaction_id)
            .await
            .unwrap();
        assert!(matches!(
            store.set_thread_archived(thread.id, true).await,
            Err(StorageError::ThreadArchiveBusy)
        ));
        set_status(&store, &thread, "stopped").await;
        // Archive wins: both follow-up admission and retry through the real storage seams fail.
        store.set_thread_archived(thread.id, true).await.unwrap();
        let error = store
            .insert_interaction(thread.id, "Follow-up", None, false, false)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("thread_archived"));
        let error = store
            .mark_interaction_running(thread.root_interaction_id, "test")
            .await
            .unwrap_err();
        assert!(error.to_string().contains("thread_archived"));
        store.set_thread_archived(thread.id, false).await.unwrap();
        // Admission wins: archive refuses, even when a newer interaction is idle.
        let later = store
            .insert_interaction(thread.id, "Later idle turn", None, false, false)
            .await
            .unwrap();
        sqlx::query("UPDATE interactions SET completion_status='failed' WHERE id=?1")
            .bind(later.id.value())
            .execute(&store.pool)
            .await
            .unwrap();
        set_status(&store, &thread, "running").await;
        assert_eq!(
            store
                .get_thread(thread.id)
                .await
                .unwrap()
                .unwrap()
                .activity
                .as_deref(),
            Some("failed")
        );
        assert!(matches!(
            store.set_thread_archived(thread.id, true).await,
            Err(StorageError::ThreadArchiveBusy)
        ));
        set_status(&store, &thread, "accepted").await;
        // A graph-settled execution can still have an active native unwind.
        sqlx::query("INSERT INTO interaction_attempts(interaction_id,attempt_number,started_at,family_id,family_revision,harness_configuration_name,harness_configuration_revision,harness_configuration_digest,provider_id,adapter_id,adapter_implementation_version,model_id,access_contract,outcome,effect_boundary) VALUES (?1,1,'1',1,1,'test',1,'digest','test','test',1,'model','contract','running','unknown')")
            .bind(thread.root_interaction_id.value()).execute(&store.pool).await.unwrap();
        assert!(matches!(
            store.set_thread_archived(thread.id, true).await,
            Err(StorageError::ThreadArchiveBusy)
        ));
        sqlx::query(
            "UPDATE interaction_attempts SET native_wait_ended_at='2' WHERE interaction_id=?1",
        )
        .bind(thread.root_interaction_id.value())
        .execute(&store.pool)
        .await
        .unwrap();
        store.set_thread_archived(thread.id, true).await.unwrap();
    }

    async fn set_status(store: &SqliteProductStore, thread: &Thread, status: &str) {
        sqlx::query("UPDATE interactions SET completion_status=?1 WHERE id=?2")
            .bind(status)
            .bind(thread.root_interaction_id.value())
            .execute(&store.pool)
            .await
            .unwrap();
    }

    async fn activity(store: &SqliteProductStore, thread: &Thread) -> Option<String> {
        store.get_thread(thread.id).await.unwrap().unwrap().activity
    }

    #[tokio::test]
    async fn thread_lists_report_the_latest_interactions_live_state_only() {
        let directory = tempfile::tempdir().unwrap();
        let store = SqliteProductStore::open(&directory.path().join("product.sqlite3"))
            .await
            .unwrap();
        let thread = store
            .insert_thread_with_initial_interaction(NewThreadRecord {
                required_provider_adapter_id: None,
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
        for (status, expected) in [
            ("running", Some("running")),
            ("waiting_for_approval", Some("needs_approval")),
            ("failed", Some("failed")),
            ("accepted", None),
            ("stopped", None),
            ("cancelled", None),
        ] {
            set_status(&store, &thread, status).await;
            assert_eq!(
                activity(&store, &thread).await.as_deref(),
                expected,
                "{status}"
            );
        }
        set_status(&store, &thread, "running").await;
        store
            .request_interaction_stop(thread.id, thread.root_interaction_id)
            .await
            .unwrap();
        assert_eq!(activity(&store, &thread).await.as_deref(), Some("stopping"));
        // A stop that could not be delivered leaves the run running.
        sqlx::query(
            "UPDATE interaction_stop_requests SET error='unreachable' WHERE interaction_id=?1",
        )
        .bind(thread.root_interaction_id.value())
        .execute(&store.pool)
        .await
        .unwrap();
        assert_eq!(activity(&store, &thread).await.as_deref(), Some("running"));
        sqlx::query("UPDATE interaction_stop_requests SET error=NULL WHERE interaction_id=?1")
            .bind(thread.root_interaction_id.value())
            .execute(&store.pool)
            .await
            .unwrap();
        let listed = store.list_threads().await.unwrap();
        assert_eq!(listed[0].activity.as_deref(), Some("stopping"));
    }
}
