use super::{
    SqliteProductStore, catalog, context_drafts::ensure_context_confirmation_restore_safe,
};
#[cfg(test)]
use crate::product::{ExecutionModelSelection, InteractionId, InteractionModelSelection};
use crate::{
    product::{BeginInteractionAttempt, ExecutionLeaseDebt, PreExecutionModelFailure, ThreadId},
    storage::StorageError,
};
#[cfg(test)]
use sqlx::Row;

impl SqliteProductStore {
    pub(crate) async fn record_pre_execution_model_failure(
        &self,
        failure: PreExecutionModelFailure<'_>,
        timestamp: &str,
    ) -> Result<i64, StorageError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let (adapter_id, access_contract): (String, String) = match failure.route {
            Some(route) => (route.adapter_id.clone(), route.access_contract.clone()),
            None => {
                sqlx::query_as("SELECT adapter_id,access_contract FROM model_providers WHERE id=?1")
                    .bind(failure.selection.provider_id.as_str())
                    .fetch_one(&mut *transaction)
                    .await?
            }
        };
        let family_revision: i64 =
            sqlx::query_scalar("SELECT revision FROM model_families WHERE id=?1")
                .bind(failure.selection.family_id.value())
                .fetch_one(&mut *transaction)
                .await?;
        let (harness_revision, harness_digest): (i64, String) = match failure.policy {
            Some(policy) => (
                i64::from(policy.configuration_revision),
                policy.configuration_digest.clone(),
            ),
            None => sqlx::query_as("SELECT configuration_revision,configuration_digest FROM product_harnesses WHERE configuration_name=?1")
                .bind(failure.harness_name)
                .fetch_one(&mut *transaction)
                .await?,
        };
        let attempt_number: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(attempt_number),0)+1 FROM interaction_attempts WHERE interaction_id=?1")
            .bind(failure.interaction_id.value())
            .fetch_one(&mut *transaction)
            .await?;
        let inserted = sqlx::query("INSERT INTO interaction_attempts(interaction_id,attempt_number,started_at,finished_at,family_id,family_revision,harness_configuration_name,harness_configuration_revision,harness_configuration_digest,provider_id,adapter_id,adapter_implementation_version,model_id,access_contract,outcome,failure_category,effect_boundary) SELECT ?1,?2,?3,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,'model_failed',?14,'none' WHERE EXISTS(SELECT 1 FROM interactions WHERE id=?1 AND completion_status IN ('submitted','running')) AND NOT EXISTS(SELECT 1 FROM interaction_attempts WHERE interaction_id=?1 AND outcome='running')")
            .bind(failure.interaction_id.value())
            .bind(attempt_number)
            .bind(timestamp)
            .bind(failure.selection.family_id.value())
            .bind(family_revision)
            .bind(failure.harness_name)
            .bind(harness_revision)
            .bind(harness_digest)
            .bind(failure.selection.provider_id.as_str())
            .bind(adapter_id)
            .bind(failure.adapter_version.unwrap_or(0))
            .bind(&failure.selection.model_id)
            .bind(access_contract)
            .bind(failure.failure_category)
            .execute(&mut *transaction)
            .await?;
        if inserted.rows_affected() != 1 {
            return Err(StorageError::IncompatibleSchema(
                "pre-execution model failure requires one submitted or running interaction with no active attempt".into(),
            ));
        }
        let id = inserted.last_insert_rowid();
        let restored = sqlx::query("UPDATE interactions SET graph_node_id=NULL,completion_status='not_started',harness_configuration_name=?1,harness_configuration_digest=NULL,effective_execution_digest=NULL,effective_permission_receipt_json=NULL,completion_output_json=NULL,completion_error=NULL WHERE id=?2 AND completion_status IN ('submitted','running')")
            .bind(failure.harness_name)
            .bind(failure.interaction_id.value())
            .execute(&mut *transaction)
            .await?;
        if restored.rows_affected() != 1 {
            return Err(StorageError::IncompatibleSchema(
                "interaction changed while recording its pre-execution model failure".into(),
            ));
        }
        ensure_context_confirmation_restore_safe(&mut transaction, failure.interaction_id.value())
            .await?;
        sqlx::query("UPDATE node_context_draft_resolutions SET consumed_interaction_id=NULL WHERE consumed_interaction_id=?1")
            .bind(failure.interaction_id.value())
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        Ok(id)
    }

    pub(crate) async fn begin_interaction_attempt(
        &self,
        receipt: BeginInteractionAttempt<'_>,
        timestamp: &str,
    ) -> Result<i64, StorageError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let admission: (String, bool) = sqlx::query_as(
            "SELECT completion_status,EXISTS(SELECT 1 FROM interaction_attempts WHERE interaction_id=?1 AND outcome='running') FROM interactions WHERE id=?1",
        )
        .bind(receipt.interaction_id.value())
        .fetch_one(&mut *transaction)
        .await?;
        if admission.0 != "running" || admission.1 {
            return Err(StorageError::IncompatibleSchema(
                "a new execution attempt requires one running interaction with no active attempt"
                    .into(),
            ));
        }
        if receipt.attempt_admission_id.is_empty() {
            return Err(StorageError::IncompatibleSchema(
                "an execution attempt requires a non-empty admission id".into(),
            ));
        }
        if receipt.execution_lease_id.is_empty() {
            return Err(StorageError::IncompatibleSchema(
                "an execution attempt requires a non-empty execution lease id".into(),
            ));
        }
        let selection = crate::product::InteractionModelSelection {
            family_id: receipt.route.family_id,
            provider_id: receipt.route.provider_id.clone(),
            model_id: receipt.route.model_id.clone(),
        };
        let (current_plan, admitted) = catalog::resolve_execution_model_plan_on(
            &mut transaction,
            receipt.harness_name,
            &selection,
        )
        .await?;
        if current_plan != receipt.model_plan {
            return Err(StorageError::IncompatibleSchema(
                "the model family plan changed between resolution and atomic attempt admission"
                    .into(),
            ));
        }
        if admitted != *receipt.route {
            return Err(StorageError::IncompatibleSchema(
                "the execution route changed between resolution and atomic attempt admission"
                    .into(),
            ));
        }
        if receipt.admitted_plan.family_id != receipt.model_plan.family_id
            || receipt.admitted_plan.family_revision != receipt.model_plan.family_revision
            || receipt.admitted_plan.orchestrator.provider_id
                != receipt.model_plan.orchestrator.provider_id
            || receipt.admitted_plan.orchestrator.adapter_id
                != receipt.model_plan.orchestrator.adapter_id
            || receipt.admitted_plan.orchestrator.access_contract
                != receipt.model_plan.orchestrator.access_contract
            || receipt.admitted_plan.orchestrator.model_id
                != receipt.model_plan.orchestrator.model_id
            || receipt.admitted_plan.roster.len() != receipt.model_plan.roster.len()
            || !receipt
                .admitted_plan
                .roster
                .iter()
                .zip(&receipt.model_plan.roster)
                .all(|(admitted, planned)| {
                    admitted.provider_id == planned.provider_id
                        && admitted.adapter_id == planned.adapter_id
                        && admitted.access_contract == planned.access_contract
                        && admitted.model_id == planned.model_id
                })
        {
            return Err(StorageError::IncompatibleSchema(
                "the provider broker admitted a different model family plan".into(),
            ));
        }
        let (harness_revision, harness_digest): (i64, String) = sqlx::query_as(
            "SELECT configuration_revision,configuration_digest FROM product_harnesses WHERE configuration_name=?1 AND product_visible=1 AND available=1",
        )
        .bind(receipt.harness_name)
        .fetch_one(&mut *transaction)
        .await?;
        if let Some(expected) = receipt.expected_harness_policy
            && (harness_revision != i64::from(expected.configuration_revision)
                || harness_digest != expected.configuration_digest)
        {
            return Err(StorageError::IncompatibleSchema(
                "the harness model policy changed between resolution and atomic attempt admission"
                    .into(),
            ));
        }
        let attempt_number: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(attempt_number),0)+1 FROM interaction_attempts WHERE interaction_id=?1")
            .bind(receipt.interaction_id.value()).fetch_one(&mut *transaction).await?;
        let admitted_plan_json = serde_json::to_string(&receipt.admitted_plan)
            .map_err(|error| StorageError::Serialization(error.to_string()))?;
        let id = sqlx::query("INSERT INTO interaction_attempts(interaction_id,attempt_number,started_at,family_id,family_revision,harness_configuration_name,harness_configuration_revision,harness_configuration_digest,provider_id,adapter_id,adapter_implementation_version,model_id,access_contract,outcome,effect_boundary,attempt_admission_id,admitted_plan_json,admitted_plan_digest,execution_lease_id) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,'running','unknown',?14,?15,?16,?17)")
            .bind(receipt.interaction_id.value()).bind(attempt_number).bind(timestamp).bind(receipt.route.family_id.value())
            .bind(receipt.model_plan.family_revision).bind(receipt.harness_name).bind(harness_revision).bind(harness_digest)
            .bind(receipt.route.provider_id.as_str()).bind(&receipt.route.adapter_id).bind(receipt.adapter_version).bind(&receipt.route.model_id)
            .bind(&receipt.route.access_contract).bind(&receipt.attempt_admission_id).bind(admitted_plan_json)
            .bind(&receipt.admitted_plan.digest).bind(receipt.execution_lease_id)
            .execute(&mut *transaction).await?.last_insert_rowid();
        transaction.commit().await?;
        Ok(id)
    }

    pub(crate) async fn record_model_attempt_admission_failure(
        &self,
        receipt: BeginInteractionAttempt<'_>,
        failure_category: &str,
        execution_lease_reconciled: bool,
        timestamp: &str,
    ) -> Result<i64, StorageError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let status: (String, bool) = sqlx::query_as(
            "SELECT completion_status,EXISTS(SELECT 1 FROM interaction_attempts WHERE interaction_id=?1 AND outcome='running') FROM interactions WHERE id=?1",
        )
        .bind(receipt.interaction_id.value())
        .fetch_one(&mut *transaction)
        .await?;
        if status.0 != "running" || status.1 {
            return Err(StorageError::IncompatibleSchema(
                "a failed attempt admission requires one running interaction with no active attempt".into(),
            ));
        }
        let (harness_revision, harness_digest) = receipt
            .expected_harness_policy
            .map(|policy| {
                (
                    i64::from(policy.configuration_revision),
                    policy.configuration_digest.clone(),
                )
            })
            .ok_or_else(|| {
                StorageError::IncompatibleSchema(
                    "failed attempt admission requires its expected harness policy snapshot".into(),
                )
            })?;
        let attempt_number: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(attempt_number),0)+1 FROM interaction_attempts WHERE interaction_id=?1")
            .bind(receipt.interaction_id.value())
            .fetch_one(&mut *transaction)
            .await?;
        let admitted_plan_json = serde_json::to_string(&receipt.admitted_plan)
            .map_err(|error| StorageError::Serialization(error.to_string()))?;
        let id = sqlx::query("INSERT INTO interaction_attempts(interaction_id,attempt_number,started_at,finished_at,family_id,family_revision,harness_configuration_name,harness_configuration_revision,harness_configuration_digest,provider_id,adapter_id,adapter_implementation_version,model_id,access_contract,outcome,failure_category,effect_boundary,attempt_admission_id,admitted_plan_json,admitted_plan_digest,execution_lease_id,execution_lease_reconciled_at) VALUES (?1,?2,?3,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,'model_failed',?14,'none',?15,?16,?17,?18,?19)")
            .bind(receipt.interaction_id.value())
            .bind(attempt_number)
            .bind(timestamp)
            .bind(receipt.route.family_id.value())
            .bind(receipt.model_plan.family_revision)
            .bind(receipt.harness_name)
            .bind(harness_revision)
            .bind(harness_digest)
            .bind(receipt.route.provider_id.as_str())
            .bind(&receipt.route.adapter_id)
            .bind(receipt.adapter_version)
            .bind(&receipt.route.model_id)
            .bind(&receipt.route.access_contract)
            .bind(failure_category)
            .bind(&receipt.attempt_admission_id)
            .bind(admitted_plan_json)
            .bind(&receipt.admitted_plan.digest)
            .bind(receipt.execution_lease_id)
            .bind(execution_lease_reconciled.then_some(timestamp))
            .execute(&mut *transaction)
            .await?
            .last_insert_rowid();
        let restored = sqlx::query("UPDATE interactions SET graph_node_id=NULL,completion_status='not_started',harness_configuration_name=?1,harness_configuration_digest=NULL,effective_execution_digest=NULL,effective_permission_receipt_json=NULL,completion_output_json=NULL,completion_error=NULL WHERE id=?2 AND completion_status='running'")
            .bind(receipt.harness_name)
            .bind(receipt.interaction_id.value())
            .execute(&mut *transaction)
            .await?;
        if restored.rows_affected() != 1 {
            return Err(StorageError::IncompatibleSchema(
                "interaction changed while recording its failed attempt admission".into(),
            ));
        }
        ensure_context_confirmation_restore_safe(&mut transaction, receipt.interaction_id.value())
            .await?;
        sqlx::query("UPDATE node_context_draft_resolutions SET consumed_interaction_id=NULL WHERE consumed_interaction_id=?1")
            .bind(receipt.interaction_id.value())
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        Ok(id)
    }

    pub(crate) async fn execution_lease_debt(
        &self,
        attempt_id: i64,
    ) -> Result<Option<ExecutionLeaseDebt>, StorageError> {
        let row: Option<(i64, i64, String)> = sqlx::query_as(
            "SELECT a.id,i.thread_id,a.execution_lease_id FROM interaction_attempts a JOIN interactions i ON i.id=a.interaction_id WHERE a.id=?1 AND a.execution_lease_id IS NOT NULL AND a.execution_lease_reconciled_at IS NULL AND a.outcome!='running'",
        )
        .bind(attempt_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(
            |(attempt_id, thread_id, execution_lease_id)| ExecutionLeaseDebt {
                attempt_id,
                thread_id: ThreadId::from_database(thread_id),
                execution_lease_id,
            },
        ))
    }

    pub(crate) async fn unreconciled_execution_lease_debts(
        &self,
    ) -> Result<Vec<ExecutionLeaseDebt>, StorageError> {
        let rows: Vec<(i64, i64, String)> = sqlx::query_as(
            "SELECT a.id,i.thread_id,a.execution_lease_id FROM interaction_attempts a JOIN interactions i ON i.id=a.interaction_id WHERE a.execution_lease_id IS NOT NULL AND a.execution_lease_reconciled_at IS NULL AND a.outcome!='running' ORDER BY a.id",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(
                |(attempt_id, thread_id, execution_lease_id)| ExecutionLeaseDebt {
                    attempt_id,
                    thread_id: ThreadId::from_database(thread_id),
                    execution_lease_id,
                },
            )
            .collect())
    }

    pub(crate) async fn acknowledge_execution_lease_reconciled(
        &self,
        attempt_id: i64,
        execution_lease_id: &str,
        timestamp: &str,
    ) -> Result<bool, StorageError> {
        let result = sqlx::query(
            "UPDATE interaction_attempts SET execution_lease_reconciled_at=?1 WHERE id=?2 AND execution_lease_id=?3 AND execution_lease_reconciled_at IS NULL AND outcome!='running'",
        )
        .bind(timestamp)
        .bind(attempt_id)
        .bind(execution_lease_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    #[cfg(test)]
    pub(crate) async fn finish_interaction_attempt(
        &self,
        attempt_id: i64,
        outcome: &str,
        failure_category: Option<&str>,
        effect_boundary: &str,
        timestamp: &str,
    ) -> Result<(), StorageError> {
        let result = sqlx::query("UPDATE interaction_attempts SET finished_at=?1,outcome=?2,failure_category=?3,effect_boundary=?4 WHERE id=?5 AND outcome='running'")
            .bind(timestamp).bind(outcome).bind(failure_category).bind(effect_boundary).bind(attempt_id)
            .execute(&self.pool).await?;
        if result.rows_affected() != 1 {
            return Err(StorageError::IncompatibleSchema(
                "interaction attempt was already terminal or missing".into(),
            ));
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) async fn attempt_effect_boundary(
        &self,
        attempt_id: i64,
    ) -> Result<Option<String>, StorageError> {
        Ok(
            sqlx::query("SELECT effect_boundary FROM interaction_attempts WHERE id=?1")
                .bind(attempt_id)
                .fetch_optional(&self.pool)
                .await?
                .map(|row| row.get(0)),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::product::{
        AcceptedInteractionCompletion, AdmittedExecutionModelPlan, AdmittedExecutionModelRoute,
        ExecutionModelPlan, ExecutionModelRoute, FailedInteractionCompletion, ModelFamilyId,
        ProductService, ProviderId,
    };
    use axum::{Json, Router, http::StatusCode, routing};
    use serde_json::json;
    use std::{
        fs,
        sync::Arc,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    static TEST_STORE_ID: AtomicU64 = AtomicU64::new(1);

    fn retry_input(text: &str) -> crate::storage::NewInteractionInput<'_> {
        crate::storage::NewInteractionInput {
            text,
            input_identity: "retry-input",
            input_digest: "sha256:retry-input",
            contexts: &[],
            context_confirmation_ids: &[],
        }
    }

    async fn test_runtime(
        harness: Router,
    ) -> (
        crate::runtime::RuntimeClient,
        tokio::task::JoinHandle<()>,
        std::path::PathBuf,
    ) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, harness).await.unwrap() });
        let unique = TEST_STORE_ID.fetch_add(1, Ordering::Relaxed);
        let directory = std::env::temp_dir().join(format!(
            "relayer-attempt-runtime-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).unwrap();
        let catalog = directory.join("catalog.json");
        fs::write(
            &catalog,
            json!({"schemaVersion":1,"configurations":[{"configuration":{
                "schemaVersion":1,"name":"codex-basic","implementation":"test",
                "implementationVersion":1,"permissionBindings":{"auto":{}},"settings":{}
            },"digest":"sha256:test"}]})
            .to_string(),
        )
        .unwrap();
        let runtime = crate::runtime::RuntimeClient::open(
            &url,
            &url,
            "graph-control".into(),
            "harness-control".into(),
            &catalog,
        )
        .await
        .unwrap();
        (runtime, task, directory)
    }

    fn receipt<'a>(
        interaction_id: InteractionId,
        route: &'a ExecutionModelSelection,
    ) -> BeginInteractionAttempt<'a> {
        let (model_plan, admitted_plan) = plans(route);
        BeginInteractionAttempt {
            interaction_id,
            attempt_admission_id: "00000000-0000-0000-0000-000000000001".into(),
            harness_name: "codex-basic",
            route,
            model_plan,
            admitted_plan,
            adapter_version: 1,
            expected_harness_policy: None,
            execution_lease_id: "lease-test",
        }
    }

    fn plans(route: &ExecutionModelSelection) -> (ExecutionModelPlan, AdmittedExecutionModelPlan) {
        let member = ExecutionModelRoute {
            provider_id: route.provider_id.clone(),
            adapter_id: route.adapter_id.clone(),
            access_contract: route.access_contract.clone(),
            model_id: route.model_id.clone(),
        };
        (
            ExecutionModelPlan {
                family_id: route.family_id,
                family_revision: 1,
                orchestrator: member.clone(),
                roster: vec![member],
            },
            AdmittedExecutionModelPlan {
                family_id: route.family_id,
                family_revision: 1,
                orchestrator: AdmittedExecutionModelRoute {
                    provider_id: route.provider_id.clone(),
                    adapter_id: route.adapter_id.clone(),
                    access_contract: route.access_contract.clone(),
                    model_id: route.model_id.clone(),
                    adapter_implementation_version: "1".into(),
                },
                roster: vec![AdmittedExecutionModelRoute {
                    provider_id: route.provider_id.clone(),
                    adapter_id: route.adapter_id.clone(),
                    access_contract: route.access_contract.clone(),
                    model_id: route.model_id.clone(),
                    adapter_implementation_version: "1".into(),
                }],
                harness_policy_digest: "sha256:test-policy".into(),
                digest: "sha256:test-plan".into(),
            },
        )
    }

    async fn seeded_store() -> (SqliteProductStore, InteractionId, ExecutionModelSelection) {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "relayer-attempts-{}-{nonce}-{}.sqlite",
            std::process::id(),
            TEST_STORE_ID.fetch_add(1, Ordering::Relaxed),
        ));
        let store = SqliteProductStore::open(path)
            .await
            .expect("open test store");
        sqlx::query("UPDATE product_harnesses SET available=1,execution_access_contracts_json='[\"managed-runtime@1\"]' WHERE configuration_name='codex-basic'")
            .execute(&store.pool).await.expect("available harness");
        sqlx::query(
            "UPDATE model_providers SET connected=1,lifecycle_state='active' WHERE id='codex'",
        )
        .execute(&store.pool)
        .await
        .expect("connected provider");
        sqlx::query("INSERT INTO provider_models(provider_id,model_id,label,provider_order,visible,available,provider_default,metadata_json) VALUES ('codex','gpt-test','GPT Test',0,1,1,1,'{}')")
            .execute(&store.pool).await.expect("model");
        let family_id = sqlx::query("INSERT INTO model_families(name,kind,system_key,enabled,position) VALUES ('Test','custom',NULL,1,0)")
            .execute(&store.pool).await.expect("family").last_insert_rowid();
        sqlx::query("INSERT INTO model_family_members(family_id,position,provider_id,model_id) VALUES (?1,0,'codex','gpt-test')")
            .bind(family_id).execute(&store.pool).await.expect("member");
        let thread_id =
            sqlx::query("INSERT INTO threads(title,created_at,updated_at) VALUES ('Test','1','1')")
                .execute(&store.pool)
                .await
                .expect("thread")
                .last_insert_rowid();
        let interaction_id = sqlx::query("INSERT INTO interactions(thread_id,sequence,text,created_at,completion_status,model_provider_id,provider_model_id,model_family_id) VALUES (?1,0,'hello','1','running','codex','gpt-test',?2)")
            .bind(thread_id).bind(family_id).execute(&store.pool).await.expect("interaction").last_insert_rowid();
        (
            store,
            InteractionId::from_database(interaction_id),
            ExecutionModelSelection {
                family_id: ModelFamilyId::from_database(family_id),
                provider_id: ProviderId::from_database("codex".into()),
                adapter_id: "codex-subscription".into(),
                access_contract: "managed-runtime@1".into(),
                model_id: "gpt-test".into(),
            },
        )
    }

    #[tokio::test]
    async fn attempt_receipt_is_immutable_and_terminal_transition_is_one_shot() {
        let (store, interaction_id, route) = seeded_store().await;
        sqlx::query("UPDATE model_providers SET endpoint='https://secret.example.test/v1?token=do-not-persist',credential_reference='provider:do-not-persist' WHERE id='codex'")
            .execute(&store.pool).await.expect("secret provider configuration");
        sqlx::query("UPDATE product_harnesses SET configuration_revision=7,configuration_digest='sha256:authoritative' WHERE configuration_name='codex-basic'")
            .execute(&store.pool).await.expect("harness receipt");
        let attempt = store
            .begin_interaction_attempt(receipt(interaction_id, &route), "10")
            .await
            .expect("begin");
        let recorded: (i64, String, String, String, String, String, Option<String>) = sqlx::query_as(
            "SELECT harness_configuration_revision,harness_configuration_digest,attempt_admission_id,admitted_plan_json,admitted_plan_digest,execution_lease_id,execution_lease_reconciled_at FROM interaction_attempts WHERE id=?1",
        )
        .bind(attempt)
        .fetch_one(&store.pool)
        .await
        .expect("recorded receipt");
        assert_eq!(recorded.0, 7);
        assert_eq!(recorded.1, "sha256:authoritative");
        assert_eq!(recorded.2, "00000000-0000-0000-0000-000000000001");
        assert!(
            recorded
                .3
                .contains("\"accessContract\":\"managed-runtime@1\"")
        );
        assert!(!recorded.3.contains("do-not-persist"));
        assert!(!recorded.3.contains("credential"));
        assert!(!recorded.3.contains("endpoint"));
        assert_eq!(recorded.4, "sha256:test-plan");
        assert_eq!(recorded.5, "lease-test");
        assert_eq!(recorded.6, None);
        assert!(store.execution_lease_debt(attempt).await.unwrap().is_none());
        store
            .finish_interaction_attempt(
                attempt,
                "model_failed",
                Some("model_not_found"),
                "none",
                "11",
            )
            .await
            .expect("finish");
        assert_eq!(
            store
                .attempt_effect_boundary(attempt)
                .await
                .unwrap()
                .as_deref(),
            Some("none")
        );
        let debt = store
            .execution_lease_debt(attempt)
            .await
            .unwrap()
            .expect("terminal attempt retains release debt");
        assert_eq!(debt.execution_lease_id, "lease-test");
        assert!(
            store
                .acknowledge_execution_lease_reconciled(attempt, "lease-test", "12")
                .await
                .unwrap()
        );
        assert!(store.execution_lease_debt(attempt).await.unwrap().is_none());
        assert!(
            store
                .finish_interaction_attempt(attempt, "accepted", None, "graph_write", "12")
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn pre_execution_model_failure_atomically_preserves_receipt_and_restores_draft() {
        let (store, interaction_id, route) = seeded_store().await;
        let thread_id: i64 = sqlx::query_scalar("SELECT thread_id FROM interactions WHERE id=?1")
            .bind(interaction_id.value())
            .fetch_one(&store.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO node_context_draft_resolutions(draft_id,thread_id,outcome,draft_revision,target_node_id,source_interaction_node_id,source_layer_id,target_node_json,text,resolved_at,composer_text,consumed_interaction_id) VALUES ('draft-retry',?1,'confirmed',1,7,3,5,?2,'FIFO','2','FIFO',?3)")
            .bind(thread_id)
            .bind(r#"{"id":7,"kind":"concept","icon":"list","title":"Queue","detail":"Tasks","state":"accepted"}"#)
            .bind(interaction_id.value())
            .execute(&store.pool)
            .await
            .unwrap();
        let policy = store
            .load_execution_harness_policy("codex-basic")
            .await
            .unwrap();
        let selection = InteractionModelSelection {
            family_id: route.family_id,
            provider_id: route.provider_id.clone(),
            model_id: route.model_id.clone(),
        };

        let attempt = store
            .record_pre_execution_model_failure(
                PreExecutionModelFailure {
                    interaction_id,
                    harness_name: "codex-basic",
                    selection: &selection,
                    route: Some(&route),
                    policy: Some(&policy),
                    adapter_version: None,
                    failure_category: "provider_authentication",
                },
                "10",
            )
            .await
            .unwrap();

        let receipt: (String, String, i64, Option<String>) = sqlx::query_as(
            "SELECT outcome,failure_category,adapter_implementation_version,admitted_plan_json FROM interaction_attempts WHERE id=?1",
        )
        .bind(attempt)
        .fetch_one(&store.pool)
        .await
        .unwrap();
        assert_eq!(
            receipt,
            (
                "model_failed".into(),
                "provider_authentication".into(),
                0,
                None,
            )
        );
        let interaction = store
            .get_interaction(interaction_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(interaction.completion_status, "not_started");
        assert_eq!(interaction.text, "hello");
        assert_eq!(interaction.latest_attempt.unwrap().id, attempt);
        let consumed_by: Option<i64> = sqlx::query_scalar(
            "SELECT consumed_interaction_id FROM node_context_draft_resolutions WHERE draft_id='draft-retry'",
        )
        .fetch_one(&store.pool)
        .await
        .unwrap();
        assert_eq!(consumed_by, None);

        sqlx::query("UPDATE interactions SET completion_status='submitted' WHERE id=?1")
            .bind(interaction_id.value())
            .execute(&store.pool)
            .await
            .unwrap();
        sqlx::query("UPDATE node_context_draft_resolutions SET consumed_interaction_id=?1 WHERE draft_id='draft-retry'")
            .bind(interaction_id.value())
            .execute(&store.pool)
            .await
            .unwrap();
        let second_attempt = store
            .record_pre_execution_model_failure(
                PreExecutionModelFailure {
                    interaction_id,
                    harness_name: "codex-basic",
                    selection: &selection,
                    route: Some(&route),
                    policy: Some(&policy),
                    adapter_version: None,
                    failure_category: "configuration",
                },
                "11",
            )
            .await
            .unwrap();
        assert_ne!(second_attempt, attempt);
        let interaction = store
            .get_interaction(interaction_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(interaction.completion_status, "not_started");
        assert_eq!(interaction.latest_attempt.unwrap().id, second_attempt);
        let consumed_by: Option<i64> = sqlx::query_scalar(
            "SELECT consumed_interaction_id FROM node_context_draft_resolutions WHERE draft_id='draft-retry'",
        )
        .fetch_one(&store.pool)
        .await
        .unwrap();
        assert_eq!(consumed_by, None);
    }

    #[tokio::test]
    async fn rejected_attempt_admission_preserves_frozen_plan_and_release_debt() {
        let (store, interaction_id, route) = seeded_store().await;
        let policy = store
            .load_execution_harness_policy("codex-basic")
            .await
            .unwrap();
        let expected_plan = receipt(interaction_id, &route).admitted_plan;
        let mut failed = receipt(interaction_id, &route);
        failed.expected_harness_policy = Some(&policy);

        let attempt = store
            .record_model_attempt_admission_failure(failed, "model_unavailable", false, "11")
            .await
            .unwrap();

        let recorded: (String, String, String, Option<String>) = sqlx::query_as(
            "SELECT outcome,failure_category,execution_lease_id,execution_lease_reconciled_at FROM interaction_attempts WHERE id=?1",
        )
        .bind(attempt)
        .fetch_one(&store.pool)
        .await
        .unwrap();
        assert_eq!(recorded.0, "model_failed");
        assert_eq!(recorded.1, "model_unavailable");
        assert_eq!(recorded.2, "lease-test");
        assert_eq!(recorded.3, None);
        assert_eq!(
            store
                .get_interaction(interaction_id)
                .await
                .unwrap()
                .unwrap()
                .latest_attempt
                .unwrap()
                .admitted_plan,
            Some(expected_plan),
        );
        assert_eq!(
            store
                .execution_lease_debt(attempt)
                .await
                .unwrap()
                .unwrap()
                .execution_lease_id,
            "lease-test",
        );
    }

    #[tokio::test]
    async fn legacy_attempt_without_an_admitted_plan_remains_readable() {
        let (store, interaction_id, route) = seeded_store().await;
        sqlx::query("INSERT INTO interaction_attempts(interaction_id,attempt_number,started_at,finished_at,family_id,family_revision,harness_configuration_name,harness_configuration_revision,harness_configuration_digest,provider_id,adapter_id,adapter_implementation_version,model_id,access_contract,outcome,effect_boundary) VALUES (?1,1,'1','2',?2,1,'codex-basic',1,'sha256:legacy','codex','codex-subscription',1,'gpt-test','managed-runtime@1','accepted','graph_write')")
            .bind(interaction_id.value()).bind(route.family_id.value()).execute(&store.pool).await.unwrap();
        let attempt = store
            .get_interaction(interaction_id)
            .await
            .unwrap()
            .unwrap()
            .latest_attempt
            .unwrap();
        assert!(attempt.attempt_admission_id.is_none());
        assert!(attempt.admitted_plan.is_none());
    }

    #[tokio::test]
    async fn restart_closes_running_attempt_with_unknown_effect_and_never_replays_it() {
        let (store, interaction_id, route) = seeded_store().await;
        let attempt = store
            .begin_interaction_attempt(receipt(interaction_id, &route), "10")
            .await
            .expect("begin");
        assert_eq!(
            store
                .recover_interrupted_interactions("restart", false)
                .await
                .unwrap(),
            1
        );
        let debt = store
            .execution_lease_debt(attempt)
            .await
            .unwrap()
            .expect("restart terminalization exposes the exact lease debt");
        assert_eq!(debt.execution_lease_id, "lease-test");
        assert_eq!(
            store.unreconciled_execution_lease_debts().await.unwrap(),
            vec![debt]
        );
        let row: (String, String, String) = sqlx::query_as(
            "SELECT outcome,failure_category,effect_boundary FROM interaction_attempts WHERE id=?1",
        )
        .bind(attempt)
        .fetch_one(&store.pool)
        .await
        .unwrap();
        assert_eq!(
            row,
            (
                "execution_failed".into(),
                "application_restart".into(),
                "unknown".into()
            )
        );
        assert_eq!(
            store
                .recover_interrupted_interactions("restart again", false)
                .await
                .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn terminal_lease_reconciliation_retries_release_and_accepts_host_absence() {
        let (store, interaction_id, route) = seeded_store().await;
        let attempt = store
            .begin_interaction_attempt(receipt(interaction_id, &route), "10")
            .await
            .unwrap();
        store
            .recover_interrupted_interactions("restart", false)
            .await
            .unwrap();
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed = calls.clone();
        let harness = Router::new().route(
            "/sessions/{thread}/execution-leases/{lease}",
            routing::delete(move || {
                let observed = observed.clone();
                async move {
                    if observed.fetch_add(1, Ordering::SeqCst) == 0 {
                        return (
                            StatusCode::SERVICE_UNAVAILABLE,
                            Json(json!({"error":"temporary"})),
                        );
                    }
                    (StatusCode::OK, Json(json!({"released":true})))
                }
            }),
        );
        let (runtime, task, directory) = test_runtime(harness).await;
        let product = ProductService::new(store.clone(), true);
        assert!(
            !crate::app_server::reconcile_terminal_execution_lease(&product, &runtime, attempt)
                .await
        );
        assert!(store.execution_lease_debt(attempt).await.unwrap().is_some());
        assert!(
            crate::app_server::reconcile_terminal_execution_lease(&product, &runtime, attempt)
                .await
        );
        assert!(store.execution_lease_debt(attempt).await.unwrap().is_none());
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        task.abort();
        fs::remove_dir_all(directory).unwrap();

        let (store, interaction_id, route) = seeded_store().await;
        let attempt = store
            .begin_interaction_attempt(receipt(interaction_id, &route), "10")
            .await
            .unwrap();
        store
            .recover_interrupted_interactions("restart", false)
            .await
            .unwrap();
        let harness = Router::new().route(
            "/sessions/{thread}/execution-leases/{lease}",
            routing::delete(|| async { Json(json!({"released":false})) }),
        );
        let (runtime, task, directory) = test_runtime(harness).await;
        let product = ProductService::new(store.clone(), true);
        assert!(
            crate::app_server::reconcile_terminal_execution_lease(&product, &runtime, attempt)
                .await
        );
        assert!(store.execution_lease_debt(attempt).await.unwrap().is_none());
        task.abort();
        fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn restart_preserves_a_recoverable_unsent_draft() {
        let (store, interaction_id, _) = seeded_store().await;
        sqlx::query("UPDATE interactions SET completion_status='not_started' WHERE id=?1")
            .bind(interaction_id.value())
            .execute(&store.pool)
            .await
            .unwrap();

        assert_eq!(
            store
                .recover_interrupted_interactions("restart", false)
                .await
                .unwrap(),
            0
        );
        let status: String =
            sqlx::query_scalar("SELECT completion_status FROM interactions WHERE id=?1")
                .bind(interaction_id.value())
                .fetch_one(&store.pool)
                .await
                .unwrap();
        assert_eq!(status, "not_started");
    }

    #[tokio::test]
    async fn attempt_admission_rejects_a_stale_harness_policy_snapshot() {
        let (store, interaction_id, route) = seeded_store().await;
        let policy = store
            .load_execution_harness_policy("codex-basic")
            .await
            .unwrap();
        sqlx::query(
            "UPDATE product_harnesses SET configuration_revision=configuration_revision+1,configuration_digest='sha256:changed' WHERE configuration_name='codex-basic'",
        )
        .execute(&store.pool)
        .await
        .unwrap();
        let mut stale = receipt(interaction_id, &route);
        stale.expected_harness_policy = Some(&policy);

        let error = store
            .begin_interaction_attempt(stale, "10")
            .await
            .expect_err("stale policy must not cross attempt admission");

        assert!(error.to_string().contains("harness model policy changed"));
    }

    #[tokio::test]
    async fn model_plan_preserves_resolvable_family_order_and_requires_the_orchestrator() {
        let (store, _, route) = seeded_store().await;
        sqlx::query("INSERT INTO model_providers(id,label,connected,refreshed_at,adapter_id,access_contract,lifecycle_state) VALUES ('openai-work','OpenAI work',1,'1','openai-api','managed-runtime@1','active')")
            .execute(&store.pool).await.unwrap();
        sqlx::query("INSERT INTO provider_models(provider_id,model_id,label,provider_order,visible,available,provider_default,metadata_json) VALUES ('openai-work','gpt-second','Second',0,1,1,0,'{}'),('openai-work','gpt-offline','Offline',1,1,0,0,'{}')")
            .execute(&store.pool).await.unwrap();
        sqlx::query("INSERT INTO harness_provider_compatibility(harness_configuration_name,provider_id,all_models) VALUES ('codex-basic','openai-work',1)")
            .execute(&store.pool).await.unwrap();
        sqlx::query("INSERT INTO model_family_members(family_id,position,provider_id,model_id) VALUES (?1,1,'openai-work','gpt-second'),(?1,2,'openai-work','gpt-offline')")
            .bind(route.family_id.value()).execute(&store.pool).await.unwrap();
        let selected = crate::product::InteractionModelSelection {
            family_id: route.family_id,
            provider_id: route.provider_id.clone(),
            model_id: route.model_id.clone(),
        };
        let (plan, _) = store
            .resolve_execution_model_plan("codex-basic", &selected)
            .await
            .unwrap();
        assert_eq!(
            plan.roster
                .iter()
                .map(|member| (member.provider_id.as_str(), member.model_id.as_str()))
                .collect::<Vec<_>>(),
            vec![("codex", "gpt-test"), ("openai-work", "gpt-second")]
        );
        let unavailable = crate::product::InteractionModelSelection {
            family_id: route.family_id,
            provider_id: ProviderId::from_database("openai-work".into()),
            model_id: "gpt-offline".into(),
        };
        assert!(
            store
                .resolve_execution_model_plan("codex-basic", &unavailable)
                .await
                .unwrap_err()
                .to_string()
                .contains("unavailable")
        );

        store
            .update_harness_model_rules(&crate::product::UpdateHarnessModelRulesCommand {
                harness_id: "codex-basic".into(),
                expected_revision: 1,
                rules: crate::product::HarnessModelRules {
                    allow: vec![
                        crate::product::HarnessModelRule {
                            adapter_id: "codex-subscription".into(),
                            model_id_exact: None,
                            model_id_regex: Some(".*".into()),
                        },
                        crate::product::HarnessModelRule {
                            adapter_id: "openai-api".into(),
                            model_id_exact: None,
                            model_id_regex: Some(".*".into()),
                        },
                    ],
                    deny: vec![crate::product::HarnessModelRule {
                        adapter_id: "openai-api".into(),
                        model_id_exact: Some("gpt-second".into()),
                        model_id_regex: None,
                    }],
                },
            })
            .await
            .unwrap();
        let (next_plan, _) = store
            .resolve_execution_model_plan("codex-basic", &selected)
            .await
            .unwrap();
        assert_eq!(next_plan.family_revision, plan.family_revision);
        assert_eq!(
            next_plan
                .roster
                .iter()
                .map(|member| (member.provider_id.as_str(), member.model_id.as_str()))
                .collect::<Vec<_>>(),
            vec![("codex", "gpt-test")]
        );
        let denied = crate::product::InteractionModelSelection {
            family_id: route.family_id,
            provider_id: ProviderId::from_database("openai-work".into()),
            model_id: "gpt-second".into(),
        };
        assert!(
            store
                .resolve_execution_model_plan("codex-basic", &denied)
                .await
                .unwrap_err()
                .to_string()
                .contains("No available models for this harness")
        );
    }

    #[tokio::test]
    async fn attempt_admission_rejects_family_revision_race_and_freezes_the_admitted_plan() {
        let (store, interaction_id, route) = seeded_store().await;
        let stale = receipt(interaction_id, &route);
        sqlx::query("UPDATE model_families SET revision=2 WHERE id=?1")
            .bind(route.family_id.value())
            .execute(&store.pool)
            .await
            .unwrap();
        assert!(
            store
                .begin_interaction_attempt(stale, "10")
                .await
                .unwrap_err()
                .to_string()
                .contains("family plan changed")
        );

        sqlx::query("UPDATE model_families SET revision=1 WHERE id=?1")
            .bind(route.family_id.value())
            .execute(&store.pool)
            .await
            .unwrap();
        let expected = receipt(interaction_id, &route).admitted_plan;
        store
            .begin_interaction_attempt(receipt(interaction_id, &route), "11")
            .await
            .unwrap();
        sqlx::query("UPDATE model_families SET revision=2 WHERE id=?1")
            .bind(route.family_id.value())
            .execute(&store.pool)
            .await
            .unwrap();
        let loaded = store
            .get_interaction(interaction_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(loaded.latest_attempt.unwrap().admitted_plan, Some(expected));
    }

    #[tokio::test]
    async fn no_effect_failure_atomically_returns_the_same_prompt_to_unsent() {
        let (store, interaction_id, route) = seeded_store().await;
        let attempt = store
            .begin_interaction_attempt(receipt(interaction_id, &route), "10")
            .await
            .unwrap();
        sqlx::query("UPDATE interactions SET graph_node_id=77 WHERE id=?1")
            .bind(interaction_id.value())
            .execute(&store.pool)
            .await
            .unwrap();
        store
            .fail_interaction_completion_with_attempt(
                FailedInteractionCompletion {
                    attempt_id: attempt,
                    interaction_id,
                    harness_configuration_name: "codex-basic",
                    error: "provider unavailable",
                    outcome: "model_failed",
                    failure_category: "provider_timeout",
                    effect_boundary: "none",
                    return_to_unsent: true,
                    graph_node_id: None,
                },
                "11",
            )
            .await
            .unwrap();
        let row: (String, String, String, String) = sqlx::query_as(
            "SELECT i.text,i.completion_status,a.outcome,a.effect_boundary FROM interactions i JOIN interaction_attempts a ON a.interaction_id=i.id WHERE a.id=?1",
        )
        .bind(attempt)
        .fetch_one(&store.pool)
        .await
        .unwrap();
        assert_eq!(
            row,
            (
                "hello".into(),
                "not_started".into(),
                "model_failed".into(),
                "none".into()
            )
        );
        let graph_node_id: Option<i64> =
            sqlx::query_scalar("SELECT graph_node_id FROM interactions WHERE id=?1")
                .bind(interaction_id.value())
                .fetch_one(&store.pool)
                .await
                .unwrap();
        assert_eq!(graph_node_id, None);
    }

    #[tokio::test]
    async fn repeated_retry_claim_is_idempotent_and_protected_effects_are_rejected() {
        let (store, interaction_id, route) = seeded_store().await;
        let refreshed_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis()
            .to_string();
        sqlx::query("UPDATE model_providers SET connected=1,refreshed_at=?1 WHERE id='codex'")
            .bind(refreshed_at)
            .execute(&store.pool)
            .await
            .unwrap();
        sqlx::query(
            "UPDATE product_harnesses SET available=1 WHERE configuration_name='codex-basic'",
        )
        .execute(&store.pool)
        .await
        .unwrap();
        let attempt = store
            .begin_interaction_attempt(receipt(interaction_id, &route), "10")
            .await
            .unwrap();
        store
            .fail_interaction_completion_with_attempt(
                FailedInteractionCompletion {
                    attempt_id: attempt,
                    interaction_id,
                    harness_configuration_name: "codex-basic",
                    error: "provider timeout",
                    outcome: "model_failed",
                    failure_category: "provider_timeout",
                    effect_boundary: "none",
                    return_to_unsent: true,
                    graph_node_id: None,
                },
                "11",
            )
            .await
            .unwrap();
        let selection = crate::product::InteractionModelSelection {
            family_id: route.family_id,
            provider_id: route.provider_id.clone(),
            model_id: route.model_id.clone(),
        };
        assert!(
            store
                .claim_interaction_retry(
                    interaction_id,
                    attempt,
                    retry_input("edited prompt"),
                    &selection,
                    "codex-basic",
                )
                .await
                .unwrap()
        );
        assert!(
            !store
                .claim_interaction_retry(
                    interaction_id,
                    attempt,
                    retry_input("duplicated click"),
                    &selection,
                    "codex-basic",
                )
                .await
                .unwrap()
        );

        let (protected_store, protected_interaction, protected_route) = seeded_store().await;
        let protected_attempt = protected_store
            .begin_interaction_attempt(receipt(protected_interaction, &protected_route), "20")
            .await
            .unwrap();
        protected_store
            .fail_interaction_completion_with_attempt(
                FailedInteractionCompletion {
                    attempt_id: protected_attempt,
                    interaction_id: protected_interaction,
                    harness_configuration_name: "codex-basic",
                    error: "tool result lost",
                    outcome: "execution_failed",
                    failure_category: "execution",
                    effect_boundary: "tool_effect",
                    return_to_unsent: false,
                    graph_node_id: Some(77),
                },
                "21",
            )
            .await
            .unwrap();
        assert!(
            protected_store
                .begin_interaction_attempt(receipt(protected_interaction, &protected_route), "22",)
                .await
                .is_err()
        );
        let protected_selection = crate::product::InteractionModelSelection {
            family_id: protected_route.family_id,
            provider_id: protected_route.provider_id,
            model_id: protected_route.model_id,
        };
        assert!(
            protected_store
                .claim_interaction_retry(
                    protected_interaction,
                    protected_attempt,
                    retry_input("must not replay"),
                    &protected_selection,
                    "codex-basic",
                )
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn model_failures_restore_the_same_draft_after_every_effect_boundary() {
        for boundary in ["partial_output", "graph_write", "tool_effect", "unknown"] {
            let (store, interaction_id, route) = seeded_store().await;
            let refreshed_at = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis()
                .to_string();
            sqlx::query("UPDATE model_providers SET refreshed_at=?1 WHERE id='codex'")
                .bind(refreshed_at)
                .execute(&store.pool)
                .await
                .unwrap();
            let attempt = store
                .begin_interaction_attempt(receipt(interaction_id, &route), "10")
                .await
                .unwrap();
            sqlx::query("UPDATE interactions SET graph_node_id=77,harness_configuration_digest='sha256:prepared',effective_execution_digest='sha256:execution',effective_permission_receipt_json='{}' WHERE id=?1")
                .bind(interaction_id.value())
                .execute(&store.pool)
                .await
                .unwrap();

            store
                .fail_interaction_completion_with_attempt(
                    FailedInteractionCompletion {
                        attempt_id: attempt,
                        interaction_id,
                        harness_configuration_name: "codex-basic",
                        error: "model stopped after partial work",
                        outcome: "model_failed",
                        failure_category: "provider_timeout",
                        effect_boundary: boundary,
                        return_to_unsent: true,
                        graph_node_id: Some(77),
                    },
                    "11",
                )
                .await
                .unwrap();

            let row: (String, Option<i64>, String, String) = sqlx::query_as(
                "SELECT i.completion_status,i.graph_node_id,a.outcome,a.effect_boundary FROM interactions i JOIN interaction_attempts a ON a.interaction_id=i.id WHERE a.id=?1",
            )
            .bind(attempt)
            .fetch_one(&store.pool)
            .await
            .unwrap();
            assert_eq!(
                row,
                (
                    "not_started".into(),
                    None,
                    "model_failed".into(),
                    boundary.into(),
                )
            );
            let selection = InteractionModelSelection {
                family_id: route.family_id,
                provider_id: route.provider_id.clone(),
                model_id: route.model_id.clone(),
            };
            assert!(
                store
                    .claim_interaction_retry(
                        interaction_id,
                        attempt,
                        retry_input("explicit retry accepts duplicate risk"),
                        &selection,
                        "codex-basic",
                    )
                    .await
                    .unwrap(),
                "model failure at {boundary} must remain explicitly resendable",
            );
        }
    }

    #[tokio::test]
    async fn partial_effect_boundaries_are_terminal_inspectable_and_one_shot() {
        for boundary in ["partial_output", "graph_write", "tool_effect", "unknown"] {
            let (store, interaction_id, route) = seeded_store().await;
            let attempt = store
                .begin_interaction_attempt(receipt(interaction_id, &route), "10")
                .await
                .unwrap();
            let failure = || FailedInteractionCompletion {
                attempt_id: attempt,
                interaction_id,
                harness_configuration_name: "codex-basic",
                error: "execution stopped after partial work",
                outcome: "execution_failed",
                failure_category: "execution",
                effect_boundary: boundary,
                return_to_unsent: false,
                graph_node_id: (boundary == "graph_write").then_some(77),
            };
            store
                .fail_interaction_completion_with_attempt(failure(), "11")
                .await
                .unwrap();
            let graph_node_id: Option<i64> =
                sqlx::query_scalar("SELECT graph_node_id FROM interactions WHERE id=?1")
                    .bind(interaction_id.value())
                    .fetch_one(&store.pool)
                    .await
                    .unwrap();
            assert_eq!(graph_node_id, (boundary == "graph_write").then_some(77));
            assert!(
                store
                    .fail_interaction_completion_with_attempt(failure(), "12")
                    .await
                    .is_err()
            );
            let row: (String, String, String, String, String) = sqlx::query_as(
                "SELECT i.text,i.completion_status,i.completion_error,a.outcome,a.effect_boundary FROM interactions i JOIN interaction_attempts a ON a.interaction_id=i.id WHERE a.id=?1",
            )
            .bind(attempt)
            .fetch_one(&store.pool)
            .await
            .unwrap();
            assert_eq!(
                row,
                (
                    "hello".into(),
                    "failed".into(),
                    "execution stopped after partial work".into(),
                    "execution_failed".into(),
                    boundary.into(),
                )
            );
        }
    }

    #[tokio::test]
    async fn accepted_attempt_and_interaction_commit_as_one_terminal_unit() {
        let (store, interaction_id, route) = seeded_store().await;
        let attempt = store
            .begin_interaction_attempt(receipt(interaction_id, &route), "10")
            .await
            .unwrap();
        let permission = json!({"profile": "auto"});
        let output = json!({"nodeId": 99});
        store
            .accept_interaction_completion_with_attempt(
                attempt,
                AcceptedInteractionCompletion {
                    interaction_id,
                    graph_node_id: 99,
                    harness_configuration_name: "codex-basic",
                    harness_configuration_digest: "sha256:test",
                    effective_execution_digest: "sha256:execution",
                    effective_permission_receipt: &permission,
                    output: &output,
                },
                "11",
            )
            .await
            .unwrap();
        let row: (String, String, String) = sqlx::query_as(
            "SELECT i.completion_status,a.outcome,a.effect_boundary FROM interactions i JOIN interaction_attempts a ON a.interaction_id=i.id WHERE a.id=?1",
        )
        .bind(attempt)
        .fetch_one(&store.pool)
        .await
        .unwrap();
        assert_eq!(
            row,
            ("accepted".into(), "accepted".into(), "graph_write".into())
        );
    }
}
