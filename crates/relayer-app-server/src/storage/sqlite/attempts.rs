use super::{SqliteProductStore, catalog};
use crate::product::{BeginInteractionAttempt, PreExecutionModelFailure};
#[cfg(test)]
use crate::product::{ExecutionModelSelection, InteractionId, InteractionModelSelection};
use crate::storage::StorageError;
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
        let id = sqlx::query("INSERT INTO interaction_attempts(interaction_id,attempt_number,started_at,finished_at,family_id,family_revision,harness_configuration_name,harness_configuration_revision,harness_configuration_digest,provider_id,adapter_id,adapter_implementation_version,model_id,access_contract,outcome,failure_category,effect_boundary) SELECT ?1,?2,?3,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,'model_failed',?14,'none' WHERE EXISTS(SELECT 1 FROM interactions WHERE id=?1 AND completion_status IN ('submitted','running')) AND NOT EXISTS(SELECT 1 FROM interaction_attempts WHERE interaction_id=?1 AND outcome='running')")
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
        if id.rows_affected() != 1 {
            return Err(StorageError::IncompatibleSchema(
                "pre-execution model failure requires one submitted or running interaction with no active attempt"
                    .into(),
            ));
        }
        let id = id.last_insert_rowid();
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
        let selection = crate::product::InteractionModelSelection {
            family_id: receipt.route.family_id,
            provider_id: receipt.route.provider_id.clone(),
            model_id: receipt.route.model_id.clone(),
        };
        let admitted = catalog::validate_execution_model_selection_on(
            &mut transaction,
            receipt.harness_name,
            &selection,
        )
        .await?;
        if admitted != *receipt.route {
            return Err(StorageError::IncompatibleSchema(
                "the execution route changed between resolution and atomic attempt admission"
                    .into(),
            ));
        }
        let family_revision: i64 =
            sqlx::query_scalar("SELECT revision FROM model_families WHERE id=?1")
                .bind(receipt.route.family_id.value())
                .fetch_one(&mut *transaction)
                .await?;
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
        let id = sqlx::query("INSERT INTO interaction_attempts(interaction_id,attempt_number,started_at,family_id,family_revision,harness_configuration_name,harness_configuration_revision,harness_configuration_digest,provider_id,adapter_id,adapter_implementation_version,model_id,access_contract,outcome,effect_boundary) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,'running','unknown')")
            .bind(receipt.interaction_id.value()).bind(attempt_number).bind(timestamp).bind(receipt.route.family_id.value())
            .bind(family_revision).bind(receipt.harness_name).bind(harness_revision).bind(harness_digest)
            .bind(receipt.route.provider_id.as_str()).bind(&receipt.route.adapter_id).bind(receipt.adapter_version).bind(&receipt.route.model_id)
            .bind(&receipt.route.access_contract).execute(&mut *transaction).await?.last_insert_rowid();
        transaction.commit().await?;
        Ok(id)
    }

    pub(crate) async fn record_model_attempt_admission_failure(
        &self,
        receipt: BeginInteractionAttempt<'_>,
        failure_category: &str,
        timestamp: &str,
    ) -> Result<i64, StorageError> {
        // The broker has already admitted a concrete adapter version at this point, but the
        // product-side catalog/policy guard rejected the attempt. Preserve that exact attempted
        // route as a terminal receipt while atomically restoring the prompt. Do not revalidate
        // the route here: the failed validation is precisely what this receipt records.
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let status: (String, bool) = sqlx::query_as(
            "SELECT completion_status,EXISTS(SELECT 1 FROM interaction_attempts WHERE interaction_id=?1 AND outcome='running') FROM interactions WHERE id=?1",
        )
        .bind(receipt.interaction_id.value())
        .fetch_one(&mut *transaction)
        .await?;
        if status.0 != "running" || status.1 {
            return Err(StorageError::IncompatibleSchema(
                "a failed attempt admission requires one running interaction with no active attempt"
                    .into(),
            ));
        }
        let family_revision: i64 =
            sqlx::query_scalar("SELECT revision FROM model_families WHERE id=?1")
                .bind(receipt.route.family_id.value())
                .fetch_one(&mut *transaction)
                .await?;
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
        let id = sqlx::query("INSERT INTO interaction_attempts(interaction_id,attempt_number,started_at,finished_at,family_id,family_revision,harness_configuration_name,harness_configuration_revision,harness_configuration_digest,provider_id,adapter_id,adapter_implementation_version,model_id,access_contract,outcome,failure_category,effect_boundary) VALUES (?1,?2,?3,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,'model_failed',?14,'none')")
            .bind(receipt.interaction_id.value())
            .bind(attempt_number)
            .bind(timestamp)
            .bind(receipt.route.family_id.value())
            .bind(family_revision)
            .bind(receipt.harness_name)
            .bind(harness_revision)
            .bind(harness_digest)
            .bind(receipt.route.provider_id.as_str())
            .bind(&receipt.route.adapter_id)
            .bind(receipt.adapter_version)
            .bind(&receipt.route.model_id)
            .bind(&receipt.route.access_contract)
            .bind(failure_category)
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
        transaction.commit().await?;
        Ok(id)
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
        AcceptedInteractionCompletion, FailedInteractionCompletion, ModelFamilyId, ProviderId,
    };
    use serde_json::json;
    use std::{
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    static TEST_STORE_ID: AtomicU64 = AtomicU64::new(1);

    fn receipt<'a>(
        interaction_id: InteractionId,
        route: &'a ExecutionModelSelection,
    ) -> BeginInteractionAttempt<'a> {
        BeginInteractionAttempt {
            interaction_id,
            harness_name: "codex-basic",
            route,
            adapter_version: 1,
            expected_harness_policy: None,
        }
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
        sqlx::query("UPDATE product_harnesses SET configuration_revision=7,configuration_digest='sha256:authoritative' WHERE configuration_name='codex-basic'")
            .execute(&store.pool).await.expect("harness receipt");
        let attempt = store
            .begin_interaction_attempt(receipt(interaction_id, &route), "10")
            .await
            .expect("begin");
        let recorded: (i64, String) = sqlx::query_as(
            "SELECT harness_configuration_revision,harness_configuration_digest FROM interaction_attempts WHERE id=?1",
        )
        .bind(attempt)
        .fetch_one(&store.pool)
        .await
        .expect("recorded receipt");
        assert_eq!(recorded, (7, "sha256:authoritative".into()));
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
        assert!(
            store
                .finish_interaction_attempt(attempt, "accepted", None, "graph_write", "12")
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn pre_execution_failure_preserves_exact_available_route_and_policy_snapshot() {
        let (store, interaction_id, route) = seeded_store().await;
        sqlx::query("UPDATE product_harnesses SET configuration_revision=9,configuration_digest='sha256:policy-nine' WHERE configuration_name='codex-basic'")
            .execute(&store.pool)
            .await
            .unwrap();
        sqlx::query("UPDATE interactions SET completion_status='submitted',graph_node_id=NULL,harness_configuration_digest=NULL,effective_execution_digest=NULL,effective_permission_receipt_json=NULL WHERE id=?1")
            .bind(interaction_id.value())
            .execute(&store.pool)
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
                    policy: None,
                    adapter_version: None,
                    failure_category: "provider_authentication",
                },
                "10",
            )
            .await
            .unwrap();
        let row: (
            String,
            Option<i64>,
            i64,
            String,
            String,
            String,
            i64,
            String,
            String,
        ) = sqlx::query_as("SELECT i.completion_status,i.graph_node_id,a.family_id,a.provider_id,a.model_id,a.harness_configuration_digest,a.adapter_implementation_version,a.outcome,a.failure_category FROM interactions i JOIN interaction_attempts a ON a.interaction_id=i.id WHERE a.id=?1")
            .bind(attempt)
            .fetch_one(&store.pool)
            .await
            .unwrap();
        assert_eq!(
            row,
            (
                "not_started".into(),
                None,
                route.family_id.value(),
                "codex".into(),
                "gpt-test".into(),
                "sha256:policy-nine".into(),
                0,
                "model_failed".into(),
                "provider_authentication".into(),
            )
        );
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
    async fn restart_preserves_a_recoverable_unsent_draft() {
        let (store, interaction_id, route) = seeded_store().await;
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
    async fn restart_preserves_a_model_failure_draft_even_after_partial_effects() {
        let (store, interaction_id, route) = seeded_store().await;
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
                    error: "provider failed after a tool effect",
                    outcome: "model_failed",
                    failure_category: "provider_timeout",
                    effect_boundary: "tool_effect",
                    return_to_unsent: true,
                    graph_node_id: Some(77),
                },
                "11",
            )
            .await
            .unwrap();

        assert_eq!(
            store
                .recover_interrupted_interactions("restart", false)
                .await
                .unwrap(),
            0
        );
        let row: (String, Option<i64>, Option<String>, Option<String>, String, String) =
            sqlx::query_as("SELECT i.completion_status,i.graph_node_id,i.harness_configuration_digest,i.effective_execution_digest,a.outcome,a.effect_boundary FROM interactions i JOIN interaction_attempts a ON a.interaction_id=i.id WHERE a.id=?1")
                .bind(attempt)
                .fetch_one(&store.pool)
                .await
                .unwrap();
        assert_eq!(
            row,
            (
                "not_started".into(),
                None,
                None,
                None,
                "model_failed".into(),
                "tool_effect".into(),
            )
        );
    }

    #[tokio::test]
    async fn canonical_acceptance_reconciles_the_running_attempt_before_restart_cleanup() {
        let (store, interaction_id, route) = seeded_store().await;
        let attempt = store
            .begin_interaction_attempt(receipt(interaction_id, &route), "10")
            .await
            .unwrap();
        sqlx::query("UPDATE interactions SET graph_node_id=99,completion_status='failed',completion_error='Canonical reconciliation pending: transient product write failure',harness_configuration_name='codex-basic',harness_configuration_digest='sha256:prepared',effective_execution_digest='sha256:execution',effective_permission_receipt_json='{}' WHERE id=?1")
            .bind(interaction_id.value())
            .execute(&store.pool)
            .await
            .unwrap();

        let interrupted = store.interrupted_interactions().await.unwrap();
        assert_eq!(interrupted.len(), 1);
        assert_eq!(interrupted[0].id, interaction_id);

        assert!(
            store
                .recover_interaction_accepted(interaction_id, &json!({"nodeId": 99}))
                .await
                .unwrap()
        );
        assert_eq!(
            store
                .recover_interrupted_interactions("restart", false)
                .await
                .unwrap(),
            0
        );
        let row: (String, String, String, Option<String>) = sqlx::query_as(
            "SELECT i.completion_status,a.outcome,a.effect_boundary,a.failure_category FROM interactions i JOIN interaction_attempts a ON a.interaction_id=i.id WHERE a.id=?1",
        )
        .bind(attempt)
        .fetch_one(&store.pool)
        .await
        .unwrap();
        assert_eq!(
            row,
            (
                "accepted".into(),
                "accepted".into(),
                "graph_write".into(),
                None,
            )
        );
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

        // The broker admission supplied an adapter version before the product snapshot changed.
        // Record that rejected route and restore the same prompt in one transaction.
        sqlx::query("UPDATE interactions SET graph_node_id=77,harness_configuration_digest='sha256:prepared',effective_execution_digest='sha256:execution',effective_permission_receipt_json='{}' WHERE id=?1")
            .bind(interaction_id.value())
            .execute(&store.pool)
            .await
            .unwrap();
        let mut rejected = receipt(interaction_id, &route);
        rejected.expected_harness_policy = Some(&policy);
        let attempt = store
            .record_model_attempt_admission_failure(rejected, "model_unavailable", "11")
            .await
            .unwrap();
        let row: (
            String,
            Option<i64>,
            Option<String>,
            Option<String>,
            String,
            String,
            String,
        ) = sqlx::query_as("SELECT i.completion_status,i.graph_node_id,i.harness_configuration_digest,i.effective_execution_digest,a.outcome,a.failure_category,a.effect_boundary FROM interactions i JOIN interaction_attempts a ON a.interaction_id=i.id WHERE a.id=?1")
            .bind(attempt)
            .fetch_one(&store.pool)
            .await
            .unwrap();
        assert_eq!(
            row,
            (
                "not_started".into(),
                None,
                None,
                None,
                "model_failed".into(),
                "model_unavailable".into(),
                "none".into(),
            )
        );
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
        assert!(
            store
                .return_interaction_to_unsent(interaction_id, "codex-basic")
                .await
                .is_err(),
            "a lost or duplicate rewind must not report success"
        );
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
                    "edited prompt",
                    None,
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
                    "duplicated click",
                    None,
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
                    "must not replay",
                    None,
                    &protected_selection,
                    "codex-basic",
                )
                .await
                .is_err()
        );
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
    async fn model_failure_after_each_effect_boundary_restores_the_same_draft() {
        for boundary in ["partial_output", "graph_write", "tool_effect", "unknown"] {
            let (store, interaction_id, route) = seeded_store().await;
            let attempt = store
                .begin_interaction_attempt(receipt(interaction_id, &route), "10")
                .await
                .unwrap();
            let graph_evidence = std::env::temp_dir().join(format!(
                "relayer-authoritative-graph-write-{}-{attempt}-{boundary}",
                std::process::id()
            ));
            std::fs::write(
                &graph_evidence,
                b"canonical graph write remains authoritative",
            )
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
            assert_eq!(
                std::fs::read(&graph_evidence).unwrap(),
                b"canonical graph write remains authoritative"
            );
            std::fs::remove_file(graph_evidence).unwrap();
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
                        "explicit retry accepts duplicate risk",
                        None,
                        &selection,
                        "codex-basic",
                    )
                    .await
                    .unwrap()
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
