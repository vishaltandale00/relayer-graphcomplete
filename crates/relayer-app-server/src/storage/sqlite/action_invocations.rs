use super::{
    SqliteProductStore, catalog, interactions,
    personal_presentation::personal_presentation_attachment_state,
};
use crate::product::{
    ActionInvocation, CatalogError, Interaction, InteractionId, InteractionModelSelection,
    ModelFamilyId, ProviderId, ThreadId,
};
use crate::storage::{ActionInvocationInsertOutcome, StorageError};
use sqlx::{Row, SqliteConnection, sqlite::SqliteRow};

impl SqliteProductStore {
    pub(crate) async fn action_invocations_for_export(
        &self,
        thread_id: ThreadId,
    ) -> Result<Vec<ActionInvocation>, StorageError> {
        let mut connection = self.pool.acquire().await?;
        fetch_action_invocations_for_export(&mut connection, thread_id).await
    }

    /// Resolves the graph invoke occurrence one result interaction was created from.
    ///
    /// A running source is included deliberately. A human clicks an invoke action only after
    /// its turn is accepted, but an agent delegates from a completion that is still running,
    /// and that occurrence is what binds its child's identity. The graph engine, not this
    /// lookup, decides whether the occurrence is a published and leasable one.
    pub(crate) async fn invocation_graph_source(
        &self,
        result_interaction_id: InteractionId,
    ) -> Result<Option<(i64, i64)>, StorageError> {
        sqlx::query_as(
            "SELECT source.graph_node_id,ai.action_id FROM action_invocations ai JOIN interactions source ON source.id=ai.source_interaction_id WHERE ai.result_interaction_id=?1 AND ai.authoritative=1 AND source.completion_status IN ('accepted','running') AND source.graph_node_id IS NOT NULL",
        )
        .bind(result_interaction_id.value())
        .fetch_optional(&self.pool)
        .await
        .map_err(Into::into)
    }

    /// The graph invoke occurrence one result interaction was created from, whatever its
    /// source's status. This is the result's provenance; `invocation_graph_source` answers
    /// only while the occurrence can still authorize a new preparation.
    pub(crate) async fn invocation_graph_occurrence(
        &self,
        result_interaction_id: InteractionId,
    ) -> Result<Option<(i64, i64)>, StorageError> {
        sqlx::query_as(
            "SELECT source.graph_node_id,ai.action_id FROM action_invocations ai JOIN interactions source ON source.id=ai.source_interaction_id WHERE ai.result_interaction_id=?1 AND ai.authoritative=1 AND source.graph_node_id IS NOT NULL",
        )
        .bind(result_interaction_id.value())
        .fetch_optional(&self.pool)
        .await
        .map_err(Into::into)
    }

    /// Whether an agent launched this result as a semantic child through its broker.
    pub(crate) async fn is_agent_invoked_child(
        &self,
        result_interaction_id: InteractionId,
    ) -> Result<bool, StorageError> {
        sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM action_invocations WHERE result_interaction_id=?1 AND authoritative=1 AND agent_invoked=1)",
        )
        .bind(result_interaction_id.value())
        .fetch_one(&self.pool)
        .await
        .map_err(Into::into)
    }

    /// Marks the interrupted results an older build left without the agent marker, when only
    /// an agent could have created them. A user invokes only from an accepted source, and
    /// accepted is terminal, so a result whose source is not accepted, or was accepted only
    /// after the result was created, is an agent's child. The acceptance time is read from the
    /// source's accepted attempt only for a source that is not itself a launched child: a
    /// child's attempt finishes after its provider unwinds, which can be after acceptance. A
    /// launched child's acceptance time is its execution's settlement instead: the settlement
    /// and the accepted product row are written in one transaction, and nothing updates a
    /// settled execution afterwards.
    /// A root an older build accepted without an attempt row carries no acceptance time, so a
    /// result of it stays unmarked: the product row records no other acceptance evidence.
    /// Returns how many were marked.
    pub(crate) async fn mark_unrecorded_agent_children(&self) -> Result<u64, StorageError> {
        let marked = sqlx::query(
            "UPDATE action_invocations SET agent_invoked=1
             WHERE agent_invoked=0 AND authoritative=1 AND graph_lease_required=1
               AND result_interaction_id IN (SELECT id FROM interactions
                   WHERE completion_status IN ('not_started','submitted','running','waiting_for_approval'))
               AND (EXISTS(SELECT 1 FROM interactions source
                           WHERE source.id=action_invocations.source_interaction_id
                             AND source.completion_status!='accepted')
                    OR EXISTS(SELECT 1 FROM completion_executions launched
                              WHERE launched.interaction_id=action_invocations.source_interaction_id
                                AND launched.phase='settled'
                                AND CAST(launched.updated_at AS INTEGER)
                                    > CAST(action_invocations.created_at AS INTEGER))
                    OR EXISTS(SELECT 1 FROM interaction_attempts attempt
                              WHERE attempt.interaction_id=action_invocations.source_interaction_id
                                AND NOT EXISTS(SELECT 1 FROM completion_executions launched
                                               WHERE launched.interaction_id=attempt.interaction_id)
                                AND attempt.outcome='accepted' AND attempt.finished_at IS NOT NULL
                                AND CAST(attempt.finished_at AS INTEGER)
                                    > CAST(action_invocations.created_at AS INTEGER)))",
        )
        .execute(&self.pool)
        .await?;
        Ok(marked.rows_affected())
    }

    /// Agent children the refused-launch cleanup failed in the product before it could fail
    /// their graph current: the product row fences out later launches first. Startup finishes
    /// the graph half.
    pub(crate) async fn refused_children_awaiting_graph_failure(
        &self,
    ) -> Result<Vec<(InteractionId, i64)>, StorageError> {
        let rows: Vec<(i64, i64)> = sqlx::query_as(
            "SELECT result.id,result.graph_node_id FROM interactions result
             JOIN action_invocations ai ON ai.result_interaction_id=result.id
             WHERE ai.authoritative=1 AND ai.agent_invoked=1 AND ai.graph_failure_pending=1
               AND result.completion_status='failed' AND result.graph_node_id IS NOT NULL
             ORDER BY result.id",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|(id, node)| (InteractionId::from_database(id), node))
            .collect())
    }

    pub(crate) async fn invocation_requires_graph_lease(
        &self,
        result_interaction_id: InteractionId,
    ) -> Result<bool, StorageError> {
        Ok(sqlx::query_scalar(
            "SELECT graph_lease_required FROM action_invocations WHERE result_interaction_id=?1 AND authoritative=1",
        )
        .bind(result_interaction_id.value())
        .fetch_optional(&self.pool)
        .await?
        .unwrap_or(false))
    }

    pub(crate) async fn terminate_legacy_action_invocation(
        &self,
        result_interaction_id: InteractionId,
        error: &str,
    ) -> Result<bool, StorageError> {
        let result = sqlx::query(
            "UPDATE interactions SET completion_error=?1 WHERE id=?2 AND completion_status='failed' AND completion_error LIKE 'Canonical reconciliation pending:%' AND EXISTS (SELECT 1 FROM action_invocations WHERE result_interaction_id=?2 AND graph_lease_required=0 AND authoritative=1)",
        )
        .bind(error)
        .bind(result_interaction_id.value())
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    pub(crate) async fn interrupted_interactions(&self) -> Result<Vec<Interaction>, StorageError> {
        let rows = sqlx::query(
            "SELECT i.id,i.thread_id,i.sequence,i.text,i.created_at,i.graph_node_id,i.completion_status,i.harness_configuration_name,i.harness_configuration_digest,i.completion_output_json,i.completion_error,i.permission_profile_id,i.effective_execution_digest,i.effective_permission_receipt_json,i.model_provider_id,i.provider_model_id,i.model_family_id,a.id,a.attempt_number,a.started_at,a.finished_at,a.family_id,a.family_revision,a.harness_configuration_name,a.harness_configuration_revision,a.harness_configuration_digest,a.provider_id,a.adapter_id,a.adapter_implementation_version,a.model_id,a.access_contract,a.outcome,a.failure_category,a.effect_boundary,a.attempt_admission_id,a.admitted_plan_json,a.admitted_plan_digest,EXISTS(SELECT 1 FROM interaction_stop_requests stop WHERE stop.interaction_id=i.id), (SELECT error FROM interaction_stop_requests stop WHERE stop.interaction_id=i.id) FROM interactions i LEFT JOIN interaction_attempts a ON a.id=(SELECT latest.id FROM interaction_attempts latest WHERE latest.interaction_id=i.id ORDER BY latest.attempt_number DESC LIMIT 1) WHERE i.completion_status IN ('not_started','running','submitted','waiting_for_approval') ORDER BY i.id",
        )
        .fetch_all(&self.pool)
        .await?;
        rows.iter()
            .map(interactions::interaction_from_row)
            .collect()
    }

    pub(crate) async fn recover_interaction_accepted(
        &self,
        interaction_id: InteractionId,
        output: &serde_json::Value,
    ) -> Result<bool, StorageError> {
        let accepted_output = output;
        let output = serde_json::to_string(output)
            .map_err(|error| StorageError::Serialization(error.to_string()))?;
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let result = sqlx::query("UPDATE interactions SET completion_status='accepted',completion_output_json=?1,completion_error=NULL WHERE id=?2 AND graph_node_id IS NOT NULL AND harness_configuration_name IS NOT NULL AND harness_configuration_digest IS NOT NULL AND effective_execution_digest IS NOT NULL AND effective_permission_receipt_json IS NOT NULL AND (completion_status IN ('not_started','running','submitted','waiting_for_approval') OR (completion_status='failed' AND completion_error LIKE 'Canonical reconciliation pending:%'))")
            .bind(output)
            .bind(interaction_id.value())
            .execute(&mut *transaction)
            .await?;
        if result.rows_affected() != 1 {
            transaction.rollback().await?;
            return Ok(false);
        }
        sqlx::query(
            "UPDATE interaction_attempts
             SET finished_at=COALESCE(finished_at,strftime('%s','now') || '000'),
                 outcome='accepted',failure_category=NULL,effect_boundary='graph_write'
             WHERE interaction_id=?1 AND outcome='running'",
        )
        .bind(interaction_id.value())
        .execute(&mut *transaction)
        .await?;
        super::threads::commit_thread_icon(&mut transaction, interaction_id, accepted_output)
            .await?;
        transaction.commit().await?;
        Ok(true)
    }

    pub(crate) async fn permits_unselected_action_execution(
        &self,
        result_interaction_id: InteractionId,
    ) -> Result<bool, StorageError> {
        sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM action_invocations ai JOIN interactions source ON source.id=ai.source_interaction_id JOIN interactions result ON result.id=ai.result_interaction_id AND result.thread_id=source.thread_id WHERE result.id=?1 AND ai.authoritative=1 AND result.model_provider_id IS NULL AND result.provider_model_id IS NULL AND result.model_family_id IS NULL AND source.completion_status='accepted' AND source.graph_node_id IS NOT NULL AND source.model_provider_id IS NULL AND source.provider_model_id IS NULL AND source.model_family_id IS NULL)",
        )
        .bind(result_interaction_id.value())
        .fetch_one(&self.pool)
        .await
        .map_err(Into::into)
    }

    pub(crate) async fn get_action_invocation(
        &self,
        source_interaction_id: InteractionId,
        action_id: i64,
    ) -> Result<Option<(ActionInvocation, Interaction)>, StorageError> {
        let mut connection = self.pool.acquire().await?;
        existing_for_action_scope(&mut connection, source_interaction_id, action_id).await
    }

    pub(crate) async fn recover_interrupted_action_invocations(
        &self,
        error: &str,
    ) -> Result<u64, StorageError> {
        // The graph lease is durable and keyed by the immutable source pair. Preserve the result
        // as submitted so invoking the same action can remint authority for that exact graph node
        // and resume it rather than terminalizing the only interaction allowed to consume it.
        // An agent's child left here is not resumed by a user's invoke; startup's background
        // retry ends it, and its message says so.
        let result = sqlx::query(
            "UPDATE interactions
             SET completion_status=CASE
                   WHEN id IN (SELECT result_interaction_id FROM action_invocations WHERE graph_lease_required=1 AND authoritative=1)
                     THEN 'submitted'
                   ELSE 'failed'
                 END,
                 completion_error=CASE
                   WHEN id IN (SELECT result_interaction_id FROM action_invocations WHERE graph_lease_required=1 AND authoritative=1 AND agent_invoked=1)
                     THEN 'Delegated work was interrupted when Relayer stopped. It ends as soon as the graph can be reached.'
                   WHEN id IN (SELECT result_interaction_id FROM action_invocations WHERE graph_lease_required=1 AND authoritative=1)
                     THEN ?1
                   ELSE 'Legacy action invocation was interrupted before graph acceptance. Its action remains unresolved.'
                 END
             WHERE id IN (SELECT result_interaction_id FROM action_invocations WHERE authoritative=1)
               AND completion_status IN ('not_started','running','submitted')",
        )
        .bind(error)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected())
    }

    pub(crate) async fn insert_action_invocation(
        &self,
        source_interaction_id: InteractionId,
        action_id: i64,
        text: &str,
    ) -> Result<ActionInvocationInsertOutcome, StorageError> {
        self.insert_action_invocation_with_mode(
            source_interaction_id,
            action_id,
            text,
            false,
            None,
            None,
        )
        .await
    }

    pub(crate) async fn insert_recursive_action_invocation(
        &self,
        source_interaction_id: InteractionId,
        action_id: i64,
        text: &str,
    ) -> Result<ActionInvocationInsertOutcome, StorageError> {
        self.insert_action_invocation_with_mode(
            source_interaction_id,
            action_id,
            text,
            true,
            None,
            None,
        )
        .await
    }

    pub(crate) async fn insert_durable_action_invocation(
        &self,
        source: InteractionId,
        action: i64,
        text: &str,
        node: i64,
        agent_invoked: bool,
        invocation_key: &str,
    ) -> Result<ActionInvocationInsertOutcome, StorageError> {
        self.insert_action_invocation_with_mode(
            source,
            action,
            text,
            agent_invoked,
            Some((node, invocation_key)),
            None,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn insert_user_durable_action_invocation_with_inputs(
        &self,
        source: InteractionId,
        action: i64,
        text: &str,
        node: i64,
        invocation_key: &str,
        revision: Option<i64>,
        attachments: &[crate::product::ActionInputAttachment],
    ) -> Result<ActionInvocationInsertOutcome, StorageError> {
        self.insert_action_invocation_with_mode(
            source,
            action,
            text,
            false,
            Some((node, invocation_key)),
            Some((revision, attachments)),
        )
        .await
    }

    pub(crate) async fn prepared_invocation_node(
        &self,
        result: InteractionId,
    ) -> Result<Option<i64>, StorageError> {
        Ok(sqlx::query_scalar("SELECT prepared_graph_node_id FROM action_invocations WHERE result_interaction_id=?1 AND authoritative=1").bind(result.value()).fetch_optional(&self.pool).await?.flatten())
    }

    pub(crate) async fn prepared_invocation_call(
        &self,
        result: InteractionId,
    ) -> Result<Option<(i64, String)>, StorageError> {
        Ok(sqlx::query_as("SELECT prepared_graph_node_id,invocation_key FROM action_invocations WHERE result_interaction_id=?1 AND authoritative=1 AND prepared_graph_node_id IS NOT NULL").bind(result.value()).fetch_optional(&self.pool).await?)
    }

    pub(crate) async fn invocation_for_graph_node(
        &self,
        source: InteractionId,
        action: i64,
        node: i64,
    ) -> Result<Option<(ActionInvocation, Interaction)>, StorageError> {
        let mut connection = self.pool.acquire().await?;
        let row = sqlx::query("SELECT ai.source_interaction_id,ai.action_id,ai.result_interaction_id,ai.created_at,result.completion_status,ai.agent_invoked,(ai.prepared_graph_node_id IS NOT NULL) AS durable,ai.invocation_key FROM action_invocations ai JOIN interactions result ON result.id=ai.result_interaction_id WHERE ai.source_interaction_id=?1 AND ai.action_id=?2 AND ai.prepared_graph_node_id=?3 AND ai.authoritative=1").bind(source.value()).bind(action).bind(node).fetch_optional(&mut *connection).await?;
        match row {
            Some(row) => invocation_with_result(&mut connection, row).await,
            None => Ok(None),
        }
    }

    async fn insert_action_invocation_with_mode(
        &self,
        source_interaction_id: InteractionId,
        action_id: i64,
        text: &str,
        recursive: bool,
        prepared_call: Option<(i64, &str)>,
        submission: Option<(Option<i64>, &[crate::product::ActionInputAttachment])>,
    ) -> Result<ActionInvocationInsertOutcome, StorageError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let prepared_graph_node = prepared_call.map(|(node, _)| node);
        let invocation_key = prepared_call.map(|(_, key)| key).unwrap_or("legacy");
        let existing = if let Some(node) = prepared_graph_node {
            let row = sqlx::query("SELECT ai.source_interaction_id,ai.action_id,ai.result_interaction_id,ai.created_at,result.completion_status,ai.agent_invoked,(ai.prepared_graph_node_id IS NOT NULL) AS durable,ai.invocation_key FROM action_invocations ai JOIN interactions result ON result.id=ai.result_interaction_id WHERE ai.prepared_graph_node_id=?1 AND ai.source_interaction_id=?2 AND ai.action_id=?3 AND ai.authoritative=1")
                .bind(node).bind(source_interaction_id.value()).bind(action_id).fetch_optional(&mut *transaction).await?;
            match row {
                Some(row) => invocation_with_result(&mut transaction, row).await?,
                None => None,
            }
        } else {
            existing_for_action_scope(&mut transaction, source_interaction_id, action_id).await?
        };
        if let Some((mut invocation, interaction)) = existing {
            if prepared_graph_node.is_some()
                && (interaction.text != text || invocation.invocation_key != invocation_key)
            {
                return Err(StorageError::Catalog(CatalogError::invalid(
                    "invocation_input_conflict",
                    "Invocation instruction changed.",
                )));
            }
            // An older build recorded an agent's child without the marker. An agent's retry of
            // the same recursive invocation marks it only on proof that no user created it: the
            // broker launched it (it has a completion execution), or its source was never
            // accepted, and a user invokes only from an accepted source, which stays accepted.
            // A result's status is no proof: a user's own preparation also claims `submitted`.
            if recursive && !invocation.agent_invoked {
                let marked = sqlx::query(
                    "UPDATE action_invocations SET agent_invoked=1
                     WHERE result_interaction_id=?1 AND authoritative=1 AND agent_invoked=0
                       AND (EXISTS(SELECT 1 FROM completion_executions WHERE interaction_id=?1)
                            OR EXISTS(SELECT 1 FROM interactions source
                                      WHERE source.id=action_invocations.source_interaction_id
                                        AND source.completion_status!='accepted'))",
                )
                .bind(interaction.id.value())
                .execute(&mut *transaction)
                .await?;
                invocation.agent_invoked = marked.rows_affected() == 1;
            }
            if recursive {
                validate_inherited_personal_presentation(
                    &mut transaction,
                    source_interaction_id,
                    interaction.id,
                )
                .await?;
            }
            transaction.commit().await?;
            return Ok(ActionInvocationInsertOutcome::Existing {
                invocation,
                interaction,
            });
        }

        let source = sqlx::query("SELECT i.thread_id,t.conversation_import_id,t.permission_profile_id,t.harness_configuration_name,i.model_provider_id,i.provider_model_id,i.model_family_id,i.completion_status,i.graph_node_id FROM interactions i JOIN threads t ON t.id=i.thread_id WHERE i.id=?1")
            .bind(source_interaction_id.value())
            .fetch_one(&mut *transaction)
            .await?;
        let thread_id = ThreadId::from_database(source.try_get("thread_id")?);
        if submission.is_some()
            && source
                .try_get::<Option<String>, _>("conversation_import_id")?
                .is_some()
        {
            return Err(StorageError::IncompatibleSchema(
                "Imported calls cannot record executable input submissions".into(),
            ));
        }
        let permission_profile_id: String = source.try_get("permission_profile_id")?;
        let harness_id: String = source.try_get("harness_configuration_name")?;
        let model_provider_id: Option<String> = source.try_get("model_provider_id")?;
        let provider_model_id: Option<String> = source.try_get("provider_model_id")?;
        let model_family_id: Option<i64> = source.try_get("model_family_id")?;
        let interaction_in_progress: bool = sqlx::query_scalar(super::HUMAN_TURN_IN_PROGRESS)
            .bind(thread_id.value())
            .fetch_one(&mut *transaction)
            .await?;
        if interaction_in_progress && !recursive {
            return Err(StorageError::Catalog(CatalogError::invalid(
                "interaction_in_progress",
                "Wait for the active interaction to finish.",
            )));
        }
        let source_status: String = source.try_get("completion_status")?;
        let source_has_graph = source.try_get::<Option<i64>, _>("graph_node_id")?.is_some();
        let source_accepted = source_status == "accepted" && source_has_graph;
        if recursive
            && (!source_has_graph
                || !matches!(source_status.as_str(), "running" | "submitted" | "accepted"))
        {
            return Err(StorageError::Catalog(CatalogError::invalid(
                "recursive_source_inactive",
                "Recursive Complete requires an active or accepted graph-bound source completion.",
            )));
        }
        let model_selection = match (model_provider_id, provider_model_id, model_family_id) {
            (Some(provider_id), Some(model_id), Some(family_id)) if family_id > 0 => {
                Some(InteractionModelSelection {
                    family_id: ModelFamilyId::from_database(family_id),
                    provider_id: ProviderId::from_database(provider_id),
                    model_id,
                })
            }
            // Accepted pre-selector interactions have no provider/model columns. Their pinned
            // thread harness remains the only execution authority; ordinary callers still
            // cannot supply a raw harness override.
            (None, None, None) if source_accepted => None,
            _ => {
                return Err(StorageError::Catalog(CatalogError::invalid(
                    "source_model_selection_missing",
                    "The source interaction has no model selection to inherit.",
                )));
            }
        };
        if let Some(selection) = model_selection.as_ref() {
            catalog::validate_execution_model_selection_on(
                &mut transaction,
                &harness_id,
                selection,
            )
            .await?;
        }
        let previous_timestamp: String =
            sqlx::query_scalar("SELECT updated_at FROM threads WHERE id=?1")
                .bind(thread_id.value())
                .fetch_one(&mut *transaction)
                .await?;
        let timestamp = interactions::monotonic_timestamp(&previous_timestamp);
        let sequence: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(sequence),0)+1 FROM interactions WHERE thread_id=?1",
        )
        .bind(thread_id.value())
        .fetch_one(&mut *transaction)
        .await?;
        let result = sqlx::query(
            "INSERT INTO interactions(thread_id,sequence,text,created_at,permission_profile_id,model_provider_id,provider_model_id,model_family_id) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        )
        .bind(thread_id.value())
        .bind(sequence)
        .bind(text)
        .bind(&timestamp)
        .bind(&permission_profile_id)
        .bind(model_selection.as_ref().map(|selection| selection.provider_id.as_str()))
        .bind(model_selection.as_ref().map(|selection| selection.model_id.as_str()))
        .bind(model_selection.as_ref().map(|selection| selection.family_id.value()))
        .execute(&mut *transaction)
        .await?;
        let interaction = Interaction {
            stop_requested: false,
            stop_error: None,
            id: InteractionId::from_database(result.last_insert_rowid()),
            thread_id,
            sequence,
            text: text.to_owned(),
            graph_node_id: None,
            completion_status: "not_started".into(),
            harness_configuration_name: None,
            harness_configuration_digest: None,
            permission_profile_id,
            model_selection,
            effective_execution_digest: None,
            effective_permission_receipt: None,
            completion_output: None,
            completion_error: None,
            latest_attempt: None,
            created_at: timestamp.clone(),
        };
        if recursive {
            // Interaction insertion may have pinned the version active for the thread at this
            // instant. A semantic child belongs to the source task tree instead: replace that
            // transaction-local choice with the source interaction's exact immutable pin (or
            // exact legacy absence) before this transaction becomes visible.
            sqlx::query(
                "DELETE FROM interaction_personal_presentation_pins WHERE interaction_id=?1",
            )
            .bind(interaction.id.value())
            .execute(&mut *transaction)
            .await?;
            sqlx::query(
                "INSERT INTO interaction_personal_presentation_pins(interaction_id,version_key,version_interaction_node_id,root_layer_id,pinned_at) SELECT ?1,version_key,version_interaction_node_id,root_layer_id,?2 FROM interaction_personal_presentation_pins WHERE interaction_id=?3",
            )
            .bind(interaction.id.value())
            .bind(&timestamp)
            .bind(source_interaction_id.value())
            .execute(&mut *transaction)
            .await?;
            sqlx::query(
                "INSERT INTO legacy_unpinned_personal_presentation_interactions(interaction_id) SELECT ?1 WHERE EXISTS(SELECT 1 FROM legacy_unpinned_personal_presentation_interactions WHERE interaction_id=?2)",
            )
            .bind(interaction.id.value())
            .bind(source_interaction_id.value())
            .execute(&mut *transaction)
            .await?;
        }
        sqlx::query(
            "INSERT INTO action_invocations(source_interaction_id,action_id,result_interaction_id,created_at,graph_lease_required,authoritative,agent_invoked,invocation_key,prepared_graph_node_id) VALUES (?1,?2,?3,?4,1,1,?5,?6,?7)",
        )
        .bind(source_interaction_id.value())
        .bind(action_id)
        .bind(interaction.id.value())
        .bind(&timestamp)
        .bind(recursive)
        .bind(invocation_key)
        .bind(prepared_graph_node)
        .execute(&mut *transaction)
        .await?;
        if let Some((revision, attachments)) = submission {
            if recursive
                || prepared_graph_node.is_none()
                || attachments.iter().any(|input| input.thread_id != thread_id)
            {
                return Err(StorageError::IncompatibleSchema(
                    "Submission receipt requires a native user call and same-thread inputs".into(),
                ));
            }
            sqlx::query("INSERT INTO invocation_input_submission_receipts(result_interaction_id,input_draft_revision,attachments_json) VALUES (?1,?2,?3)")
                .bind(interaction.id.value()).bind(revision).bind(super::input_drafts::submission_json(attachments)?).execute(&mut *transaction).await?;
        }
        sqlx::query("UPDATE threads SET updated_at=?1 WHERE id=?2")
            .bind(&timestamp)
            .bind(thread_id.value())
            .execute(&mut *transaction)
            .await?;
        let invocation = ActionInvocation {
            invocation_key: invocation_key.into(),
            durable: prepared_graph_node.is_some(),
            source_interaction_id,
            action_id,
            result_interaction_id: interaction.id,
            result_completion_status: interaction.completion_status.clone(),
            created_at: timestamp,
            agent_invoked: recursive,
        };
        transaction.commit().await?;
        Ok(ActionInvocationInsertOutcome::Created {
            invocation,
            interaction,
        })
    }
}

async fn validate_inherited_personal_presentation(
    connection: &mut SqliteConnection,
    source_interaction_id: InteractionId,
    child_interaction_id: InteractionId,
) -> Result<(), StorageError> {
    let source = personal_presentation_attachment_state(connection, source_interaction_id).await?;
    let child = personal_presentation_attachment_state(connection, child_interaction_id).await?;
    if source != child {
        return Err(StorageError::PersonalPresentationConflict(format!(
            "semantic child {} does not inherit the exact personal presentation attachment of source interaction {}",
            child_interaction_id.value(),
            source_interaction_id.value(),
        )));
    }
    Ok(())
}

pub(super) async fn fetch_action_invocations(
    connection: &mut SqliteConnection,
    thread_id: ThreadId,
) -> Result<Vec<ActionInvocation>, StorageError> {
    let rows = sqlx::query(
        "SELECT ai.source_interaction_id,ai.action_id,ai.result_interaction_id,ai.created_at,result.completion_status,ai.agent_invoked,(ai.prepared_graph_node_id IS NOT NULL) AS durable,ai.invocation_key
         FROM action_invocations ai
         JOIN interactions source ON source.id=ai.source_interaction_id
         JOIN interactions result ON result.id=ai.result_interaction_id
         JOIN threads source_thread ON source_thread.id=source.thread_id
         JOIN threads requested_thread ON requested_thread.id=?1
         WHERE ai.authoritative=1
           AND (source.thread_id=?1
             OR (requested_thread.project_id IS NOT NULL
                AND source_thread.project_id=requested_thread.project_id))
         ORDER BY source_thread.id,source.sequence,ai.action_id",
    )
    .bind(thread_id.value())
    .fetch_all(connection)
    .await?;
    rows.iter().map(invocation_from_row).collect()
}

pub(super) async fn fetch_action_invocations_for_export(
    connection: &mut SqliteConnection,
    thread_id: ThreadId,
) -> Result<Vec<ActionInvocation>, StorageError> {
    let rows = sqlx::query(
        "SELECT ai.source_interaction_id,ai.action_id,ai.result_interaction_id,ai.created_at,result.completion_status,ai.agent_invoked,(ai.prepared_graph_node_id IS NOT NULL) AS durable,ai.invocation_key
         FROM action_invocations ai
         JOIN interactions source ON source.id=ai.source_interaction_id
         JOIN interactions result ON result.id=ai.result_interaction_id
         WHERE source.thread_id=?1 AND result.thread_id=?1
         ORDER BY source.sequence,ai.action_id,ai.created_at,ai.result_interaction_id",
    )
    .bind(thread_id.value())
    .fetch_all(connection)
    .await?;
    rows.iter().map(invocation_from_row).collect()
}

async fn existing_for_action_scope(
    connection: &mut SqliteConnection,
    source_interaction_id: InteractionId,
    action_id: i64,
) -> Result<Option<(ActionInvocation, Interaction)>, StorageError> {
    let Some(row) = sqlx::query(
        "SELECT ai.source_interaction_id,ai.action_id,ai.result_interaction_id,ai.created_at,result.completion_status,ai.agent_invoked,(ai.prepared_graph_node_id IS NOT NULL) AS durable,ai.invocation_key
         FROM interactions requested_source
         JOIN threads requested_thread ON requested_thread.id=requested_source.thread_id
         JOIN action_invocations ai ON ai.action_id=?2
         JOIN interactions existing_source ON existing_source.id=ai.source_interaction_id
         JOIN interactions result ON result.id=ai.result_interaction_id
         JOIN threads existing_thread ON existing_thread.id=existing_source.thread_id
         WHERE requested_source.id=?1
           AND ai.authoritative=1 AND ai.invocation_key='legacy'
           AND (
             (requested_thread.project_id IS NOT NULL
               AND existing_thread.project_id=requested_thread.project_id)
             OR (requested_thread.project_id IS NULL
               AND existing_source.thread_id=requested_source.thread_id)
           )
         ORDER BY ai.created_at,ai.source_interaction_id
         LIMIT 1",
    )
    .bind(source_interaction_id.value())
    .bind(action_id)
    .fetch_optional(&mut *connection)
    .await?
    else {
        return Ok(None);
    };
    invocation_with_result(connection, row).await
}

async fn invocation_with_result(
    connection: &mut SqliteConnection,
    row: SqliteRow,
) -> Result<Option<(ActionInvocation, Interaction)>, StorageError> {
    let invocation = invocation_from_row(&row)?;
    let interaction = sqlx::query(
        "SELECT i.id,i.thread_id,i.sequence,i.text,i.created_at,i.graph_node_id,i.completion_status,i.harness_configuration_name,i.harness_configuration_digest,i.completion_output_json,i.completion_error,i.permission_profile_id,i.effective_execution_digest,i.effective_permission_receipt_json,i.model_provider_id,i.provider_model_id,i.model_family_id,a.id,a.attempt_number,a.started_at,a.finished_at,a.family_id,a.family_revision,a.harness_configuration_name,a.harness_configuration_revision,a.harness_configuration_digest,a.provider_id,a.adapter_id,a.adapter_implementation_version,a.model_id,a.access_contract,a.outcome,a.failure_category,a.effect_boundary,a.attempt_admission_id,a.admitted_plan_json,a.admitted_plan_digest,EXISTS(SELECT 1 FROM interaction_stop_requests stop WHERE stop.interaction_id=i.id), (SELECT error FROM interaction_stop_requests stop WHERE stop.interaction_id=i.id) FROM interactions i LEFT JOIN interaction_attempts a ON a.id=(SELECT latest.id FROM interaction_attempts latest WHERE latest.interaction_id=i.id ORDER BY latest.attempt_number DESC LIMIT 1) WHERE i.id=?1",
    )
    .bind(invocation.result_interaction_id.value())
    .fetch_one(&mut *connection)
    .await?;
    Ok(Some((
        invocation,
        interactions::interaction_from_row(&interaction)?,
    )))
}

fn invocation_from_row(row: &SqliteRow) -> Result<ActionInvocation, StorageError> {
    Ok(ActionInvocation {
        invocation_key: row.try_get("invocation_key")?,
        durable: row.try_get("durable")?,
        source_interaction_id: InteractionId::from_database(row.try_get(0)?),
        action_id: row.try_get(1)?,
        result_interaction_id: InteractionId::from_database(row.try_get(2)?),
        created_at: row.try_get(3)?,
        result_completion_status: row.try_get(4)?,
        agent_invoked: row.try_get(5)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::NewThreadRecord;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[tokio::test]
    async fn user_call_receipt_is_atomic_reopens_and_never_recaptures_retry_epochs() {
        use relayer_graph_core::{
            ActionId, InputAction, InputControl, LayerId, NodeId, PresentingInputOccurrence,
        };
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("receipt.sqlite3");
        let store = SqliteProductStore::open(&path).await.unwrap();
        seed_test_model_selection(&store).await;
        let selection = InteractionModelSelection {
            family_id: ModelFamilyId::from_database(1),
            provider_id: ProviderId::parse("codex").unwrap(),
            model_id: "test-model".into(),
        };
        let thread = store
            .insert_thread_with_initial_interaction(NewThreadRecord {
                icon_selection_eligible: true,
                title: "Receipt",
                project_id: None,
                initial_message: "Analyze",
                harness_configuration_name: "codex-basic",
                permission_profile_id: "auto",
                model_selection: Some(&selection),
                timestamp: "9999999999999",
            })
            .await
            .unwrap();
        mark_interaction_accepted(&store, thread.root_interaction_id).await;
        let occurrence = PresentingInputOccurrence {
            presenting_interaction_node_id: NodeId::new(100).unwrap(),
            presenting_layer_id: LayerId::new(200).unwrap(),
            action_id: ActionId::new(300).unwrap(),
        };
        let action = InputAction {
            control: InputControl::Text,
            prompt: "Destination".into(),
            options: vec![],
            minimum_selections: None,
            unsupported_fields: Default::default(),
        };
        let value = crate::product::ActionInputValue::Text {
            text: "Kyoto".into(),
        };
        let first_draft = store
            .commit_action_input_attachment(
                thread.id,
                crate::storage::NewActionInputAttachment {
                    occurrence: &occurrence,
                    source_node_id: 400,
                    action: &action,
                    value: &value,
                },
                0,
            )
            .await
            .unwrap();
        let created = store
            .insert_user_durable_action_invocation_with_inputs(
                thread.root_interaction_id,
                41,
                "Analyze",
                101,
                "first",
                Some(first_draft.revision),
                &first_draft.attachments,
            )
            .await
            .unwrap();
        let result = match created {
            ActionInvocationInsertOutcome::Created { interaction, .. } => interaction.id,
            _ => panic!("not created"),
        };
        // Reopen sees the call and receipt together, not a gap where fresh epochs can be captured.
        drop(store);
        let store = SqliteProductStore::open(&path).await.unwrap();
        let receipt = store
            .invocation_input_submission(thread.id, thread.root_interaction_id, 41, "first")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            receipt,
            (Some(first_draft.revision), first_draft.attachments.clone())
        );
        let newer = store
            .commit_action_input_attachment(
                thread.id,
                crate::storage::NewActionInputAttachment {
                    occurrence: &occurrence,
                    source_node_id: 400,
                    action: &action,
                    value: &value,
                },
                first_draft.revision,
            )
            .await
            .unwrap();
        let recovered = store
            .insert_user_durable_action_invocation_with_inputs(
                thread.root_interaction_id,
                41,
                "Analyze",
                101,
                "first",
                Some(newer.revision),
                &newer.attachments,
            )
            .await
            .unwrap();
        assert!(matches!(
            recovered,
            ActionInvocationInsertOutcome::Existing { .. }
        ));
        assert_eq!(
            store
                .invocation_input_submission(thread.id, thread.root_interaction_id, 41, "first")
                .await
                .unwrap()
                .unwrap(),
            receipt
        );
        assert_eq!(
            store
                .consume_invocation_inputs(thread.id, &receipt.1)
                .await
                .unwrap(),
            newer
        );
        mark_interaction_accepted_with_node(&store, result, 101).await;
        // Existing historical user calls have no receipt: a retry must never invent one.
        let historical = store
            .insert_durable_action_invocation(
                thread.root_interaction_id,
                42,
                "Analyze",
                102,
                false,
                "historical",
            )
            .await
            .unwrap();
        let historical_result = match historical {
            ActionInvocationInsertOutcome::Created { interaction, .. } => interaction.id,
            _ => panic!("not created"),
        };
        store
            .insert_user_durable_action_invocation_with_inputs(
                thread.root_interaction_id,
                42,
                "Analyze",
                102,
                "historical",
                Some(newer.revision),
                &newer.attachments,
            )
            .await
            .unwrap();
        assert!(
            store
                .invocation_input_submission(
                    thread.id,
                    thread.root_interaction_id,
                    42,
                    "historical"
                )
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(store.action_input_draft(thread.id).await.unwrap(), newer);
        mark_interaction_accepted_with_node(&store, historical_result, 102).await;
        // Invalid input ownership rolls back child, call, and receipt as one transaction.
        let before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM interactions")
            .fetch_one(&store.pool)
            .await
            .unwrap();
        let mut foreign = newer.attachments.clone();
        foreign[0].thread_id = ThreadId::from_database(thread.id.value() + 1000);
        assert!(
            store
                .insert_user_durable_action_invocation_with_inputs(
                    thread.root_interaction_id,
                    43,
                    "Analyze",
                    103,
                    "invalid",
                    Some(newer.revision),
                    &foreign
                )
                .await
                .is_err()
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM interactions")
                .fetch_one(&store.pool)
                .await
                .unwrap(),
            before
        );
        assert!(
            store
                .invocation_input_submission(thread.id, thread.root_interaction_id, 43, "invalid")
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn reusable_calls_keep_exact_keys_and_survive_product_reopen() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("product.sqlite3");
        let store = SqliteProductStore::open(&path).await.unwrap();
        seed_test_model_selection(&store).await;
        let selection = InteractionModelSelection {
            family_id: ModelFamilyId::from_database(1),
            provider_id: ProviderId::parse("codex").unwrap(),
            model_id: "test-model".into(),
        };
        let thread = store
            .insert_thread_with_initial_interaction(NewThreadRecord {
                icon_selection_eligible: true,
                title: "Callable",
                project_id: None,
                initial_message: "Investigate",
                harness_configuration_name: "codex-basic",
                permission_profile_id: "auto",
                model_selection: Some(&selection),
                timestamp: "1",
            })
            .await
            .unwrap();
        mark_interaction_accepted(&store, thread.root_interaction_id).await;
        for (node, key) in [(101, "first-call"), (102, "second-call")] {
            let created = store
                .insert_durable_action_invocation(
                    thread.root_interaction_id,
                    41,
                    "Investigate",
                    node,
                    true,
                    key,
                )
                .await
                .unwrap();
            assert!(matches!(
                created,
                ActionInvocationInsertOutcome::Created { .. }
            ));
        }
        let calls = fetch_action_invocations(&mut store.pool.acquire().await.unwrap(), thread.id)
            .await
            .unwrap();
        assert_eq!(calls.len(), 2);
        assert!(calls.iter().all(|call| call.durable));
        assert_ne!(
            calls[0].result_interaction_id,
            calls[1].result_interaction_id
        );
        assert_eq!(calls[0].invocation_key, "first-call");
        assert_eq!(calls[1].invocation_key, "second-call");
        assert!(
            store
                .insert_durable_action_invocation(
                    thread.root_interaction_id,
                    41,
                    "Changed",
                    101,
                    true,
                    "first-call"
                )
                .await
                .is_err()
        );
        assert!(
            store
                .insert_durable_action_invocation(
                    thread.root_interaction_id,
                    41,
                    "Investigate",
                    101,
                    true,
                    "wrong-key"
                )
                .await
                .is_err()
        );
        store.pool.close().await;
        let reopened = SqliteProductStore::open(&path).await.unwrap();
        let recovered = reopened
            .insert_durable_action_invocation(
                thread.root_interaction_id,
                41,
                "Investigate",
                101,
                true,
                "first-call",
            )
            .await
            .unwrap();
        match recovered {
            ActionInvocationInsertOutcome::Existing { invocation, .. } => assert_eq!(
                invocation.result_interaction_id,
                calls[0].result_interaction_id
            ),
            _ => panic!("recreated durable call"),
        }
        reopened.pool.close().await;
    }

    #[tokio::test]
    async fn one_shot_invocation_is_atomic_idempotent_and_durable() {
        let temporary = tempfile::Builder::new()
            .prefix("relayer-action-invocation-")
            .tempdir()
            .unwrap();
        let path = temporary.path().join("product.sqlite3");
        let store = SqliteProductStore::open(&path).await.unwrap();
        seed_test_model_selection(&store).await;
        let model_selection = InteractionModelSelection {
            family_id: ModelFamilyId::from_database(1),
            provider_id: ProviderId::parse("codex").unwrap(),
            model_id: "test-model".into(),
        };
        let thread = store
            .insert_thread_with_initial_interaction(NewThreadRecord {
                icon_selection_eligible: true,
                title: "Action source",
                project_id: None,
                initial_message: "Original prompt",
                harness_configuration_name: "codex-basic",
                permission_profile_id: "auto",
                model_selection: Some(&model_selection),
                timestamp: "1",
            })
            .await
            .unwrap();
        mark_interaction_accepted(&store, thread.root_interaction_id).await;

        let mut attempts = tokio::task::JoinSet::new();
        for _ in 0..12 {
            let store = store.clone();
            attempts.spawn(async move {
                store
                    .insert_action_invocation(thread.root_interaction_id, 41, "Authored follow-up")
                    .await
                    .unwrap()
            });
        }
        let mut result_ids = Vec::new();
        let mut created = 0;
        while let Some(outcome) = attempts.join_next().await {
            match outcome.unwrap() {
                ActionInvocationInsertOutcome::Created { interaction, .. } => {
                    created += 1;
                    result_ids.push(interaction.id);
                }
                ActionInvocationInsertOutcome::Existing { interaction, .. } => {
                    result_ids.push(interaction.id);
                }
            }
        }
        assert_eq!(created, 1);
        assert!(result_ids.windows(2).all(|pair| pair[0] == pair[1]));
        assert_eq!(store.list_interactions(thread.id).await.unwrap().len(), 2);
        assert!(
            store
                .invocation_requires_graph_lease(result_ids[0])
                .await
                .unwrap()
        );

        drop(store);
        let reopened = SqliteProductStore::open(&path).await.unwrap();
        let replay = reopened
            .insert_action_invocation(thread.root_interaction_id, 41, "Different text is ignored")
            .await
            .unwrap();
        let replay_interaction = match replay {
            ActionInvocationInsertOutcome::Existing {
                invocation,
                interaction,
            } => {
                assert_eq!(invocation.result_interaction_id, result_ids[0]);
                interaction
            }
            ActionInvocationInsertOutcome::Created { .. } => {
                panic!("persisted invocation was created twice")
            }
        };
        assert_eq!(replay_interaction.id, result_ids[0]);
        assert_eq!(replay_interaction.text, "Authored follow-up");
        assert_eq!(replay_interaction.model_selection, Some(model_selection));
        sqlx::query("UPDATE interactions SET completion_status='running' WHERE id=?1")
            .bind(replay_interaction.id.value())
            .execute(&reopened.pool)
            .await
            .unwrap();
        assert!(
            reopened
                .restore_leased_interaction_submitted(
                    replay_interaction.id,
                    "retryable capability activation failure",
                )
                .await
                .unwrap()
        );
        let restored = reopened
            .get_interaction(replay_interaction.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(restored.completion_status, "submitted");
        assert_eq!(
            restored.completion_error.as_deref(),
            Some("retryable capability activation failure")
        );
        assert!(
            reopened
                .fail_interaction_completion(replay_interaction.id, "codex-basic", "test failure")
                .await
                .unwrap()
        );
        assert!(
            !reopened
                .fail_interaction_completion(replay_interaction.id, "codex-basic", "late failure")
                .await
                .unwrap()
        );
        assert!(
            !reopened
                .fail_interaction_completion(
                    thread.root_interaction_id,
                    "codex-basic",
                    "must not overwrite accepted",
                )
                .await
                .unwrap()
        );
        reopened.pool.close().await;
    }

    #[tokio::test]
    async fn recursive_invocations_can_bind_concurrent_children_while_the_parent_is_active() {
        let temporary = tempfile::Builder::new()
            .prefix("relayer-recursive-action-invocation-")
            .tempdir()
            .unwrap();
        let path = temporary.path().join("product.sqlite3");
        let store = SqliteProductStore::open(&path).await.unwrap();
        for (key, node_id, layer_id) in [
            ("personal-presentation-v1", 501, 601),
            ("personal-presentation-v2", 502, 602),
        ] {
            store
                .publish_personal_presentation_version(
                    key,
                    node_id,
                    layer_id,
                    &serde_json::json!({"nodeId":node_id,"rootLayer":{"layer":{"id":layer_id}}}),
                    "0",
                )
                .await
                .unwrap();
        }
        seed_test_model_selection(&store).await;
        let model_selection = InteractionModelSelection {
            family_id: ModelFamilyId::from_database(1),
            provider_id: ProviderId::parse("codex").unwrap(),
            model_id: "test-model".into(),
        };
        let thread = store
            .insert_thread_with_initial_interaction(NewThreadRecord {
                icon_selection_eligible: true,
                title: "Active recursive source",
                project_id: None,
                initial_message: "Original prompt",
                harness_configuration_name: "codex-basic",
                permission_profile_id: "auto",
                model_selection: Some(&model_selection),
                timestamp: "1",
            })
            .await
            .unwrap();
        sqlx::query(
            "UPDATE interactions SET completion_status='running',graph_node_id=701 WHERE id=?1",
        )
        .bind(thread.root_interaction_id.value())
        .execute(&store.pool)
        .await
        .unwrap();
        store
            .activate_personal_presentation_version("personal-presentation-v2")
            .await
            .unwrap();

        let (first, second) = tokio::join!(
            store.insert_recursive_action_invocation(
                thread.root_interaction_id,
                41,
                "First semantic child",
            ),
            store.insert_recursive_action_invocation(
                thread.root_interaction_id,
                42,
                "Second semantic child",
            ),
        );
        let first = first.unwrap();
        let second = second.unwrap();
        let child_id = |outcome: &ActionInvocationInsertOutcome| match outcome {
            ActionInvocationInsertOutcome::Created { interaction, .. }
            | ActionInvocationInsertOutcome::Existing { interaction, .. } => interaction.id,
        };
        assert_ne!(child_id(&first), child_id(&second));
        for child in [child_id(&first), child_id(&second)] {
            assert_eq!(
                store
                    .prepare_personal_presentation_pin(child, None, "2")
                    .await
                    .unwrap()
                    .unwrap()
                    .version_key,
                "personal-presentation-v1"
            );
        }
        store.pool.close().await;
        drop(store);
        let store = SqliteProductStore::open(&path).await.unwrap();
        assert_eq!(
            store
                .prepare_personal_presentation_pin(child_id(&first), None, "3")
                .await
                .unwrap()
                .unwrap()
                .version_key,
            "personal-presentation-v1"
        );

        let retry = store
            .insert_recursive_action_invocation(
                thread.root_interaction_id,
                41,
                "Ignored exact retry text",
            )
            .await
            .unwrap();
        assert_eq!(child_id(&first), child_id(&retry));
        assert!(matches!(
            retry,
            ActionInvocationInsertOutcome::Existing { .. }
        ));

        sqlx::query("UPDATE interaction_personal_presentation_pins SET version_key='personal-presentation-v2',version_interaction_node_id=502,root_layer_id=602 WHERE interaction_id=?1")
            .bind(child_id(&first).value())
            .execute(&store.pool)
            .await
            .unwrap();
        assert!(matches!(
            store
                .insert_recursive_action_invocation(
                    thread.root_interaction_id,
                    41,
                    "Mismatched retry",
                )
                .await,
            Err(StorageError::PersonalPresentationConflict(_))
        ));

        let ordinary = match store
            .insert_action_invocation(thread.root_interaction_id, 43, "User action")
            .await
        {
            Ok(_) => panic!("ordinary invocation unexpectedly bypassed active interaction"),
            Err(error) => error,
        };
        match ordinary {
            StorageError::Catalog(error) => assert_eq!(error.code(), "interaction_in_progress"),
            other => panic!("unexpected error: {other}"),
        }

        let legacy_thread = store
            .insert_thread_with_initial_interaction(NewThreadRecord {
                icon_selection_eligible: true,
                title: "Legacy recursive source",
                project_id: None,
                initial_message: "Legacy prompt",
                harness_configuration_name: "codex-basic",
                permission_profile_id: "auto",
                model_selection: Some(&model_selection),
                timestamp: "4",
            })
            .await
            .unwrap();
        sqlx::query("DELETE FROM interaction_personal_presentation_pins WHERE interaction_id=?1")
            .bind(legacy_thread.root_interaction_id.value())
            .execute(&store.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO legacy_unpinned_personal_presentation_interactions(interaction_id) VALUES (?1)")
            .bind(legacy_thread.root_interaction_id.value())
            .execute(&store.pool)
            .await
            .unwrap();
        sqlx::query(
            "UPDATE interactions SET completion_status='running',graph_node_id=702 WHERE id=?1",
        )
        .bind(legacy_thread.root_interaction_id.value())
        .execute(&store.pool)
        .await
        .unwrap();
        let legacy_child = store
            .insert_recursive_action_invocation(
                legacy_thread.root_interaction_id,
                44,
                "Legacy semantic child",
            )
            .await
            .unwrap();
        assert_eq!(
            store
                .prepare_personal_presentation_pin(child_id(&legacy_child), None, "5")
                .await
                .unwrap(),
            None
        );

        store.pool.close().await;
    }

    #[tokio::test]
    async fn reused_project_action_is_deduplicated_across_sources_and_concurrent_requests() {
        let temporary = tempfile::Builder::new()
            .prefix("relayer-project-action-dedupe-")
            .tempdir()
            .unwrap();
        let path = temporary.path().join("product.sqlite3");
        let store = SqliteProductStore::open(&path).await.unwrap();
        seed_test_model_selection(&store).await;
        let (project, _) = store
            .insert_or_get_project("Shared project", "/tmp/shared-project", "1")
            .await
            .unwrap();
        let model_selection = InteractionModelSelection {
            family_id: ModelFamilyId::from_database(1),
            provider_id: ProviderId::parse("codex").unwrap(),
            model_id: "test-model".into(),
        };
        let mut source_ids = Vec::new();
        let mut thread_ids = Vec::new();
        for timestamp in ["2", "3"] {
            let thread = store
                .insert_thread_with_initial_interaction(NewThreadRecord {
                    icon_selection_eligible: true,
                    title: "Reused action source",
                    project_id: Some(project.id),
                    initial_message: "Original prompt",
                    harness_configuration_name: "codex-basic",
                    permission_profile_id: "auto",
                    model_selection: Some(&model_selection),
                    timestamp,
                })
                .await
                .unwrap();
            mark_interaction_accepted_with_node(
                &store,
                thread.root_interaction_id,
                700 + thread.root_interaction_id.value(),
            )
            .await;
            source_ids.push(thread.root_interaction_id);
            thread_ids.push(thread.id);
        }

        let mut attempts = tokio::task::JoinSet::new();
        for index in 0..12 {
            let store = store.clone();
            let source_id = source_ids[index % source_ids.len()];
            attempts.spawn(async move {
                store
                    .insert_action_invocation(source_id, 41, "Authored follow-up")
                    .await
                    .unwrap()
            });
        }
        let mut created = 0;
        let mut result_ids = Vec::new();
        while let Some(outcome) = attempts.join_next().await {
            match outcome.unwrap() {
                ActionInvocationInsertOutcome::Created { interaction, .. } => {
                    created += 1;
                    result_ids.push(interaction.id);
                }
                ActionInvocationInsertOutcome::Existing { interaction, .. } => {
                    result_ids.push(interaction.id);
                }
            }
        }

        assert_eq!(created, 1);
        assert!(result_ids.windows(2).all(|pair| pair[0] == pair[1]));
        for source_id in source_ids {
            let replay = store
                .insert_action_invocation(source_id, 41, "Ignored replay text")
                .await
                .unwrap();
            let interaction = match replay {
                ActionInvocationInsertOutcome::Existing { interaction, .. } => interaction,
                ActionInvocationInsertOutcome::Created { .. } => {
                    panic!("project-visible action invocation was duplicated")
                }
            };
            assert_eq!(interaction.id, result_ids[0]);
        }
        let interaction_count = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM interactions WHERE thread_id IN (?1,?2)",
        )
        .bind(thread_ids[0].value())
        .bind(thread_ids[1].value())
        .fetch_one(&store.pool)
        .await
        .unwrap();
        assert_eq!(interaction_count, 3);

        store.pool.close().await;
    }

    #[tokio::test]
    async fn standalone_threads_do_not_share_action_invocation_dedupe_scope() {
        let temporary = tempfile::Builder::new()
            .prefix("relayer-standalone-action-scope-")
            .tempdir()
            .unwrap();
        let path = temporary.path().join("product.sqlite3");
        let store = SqliteProductStore::open(&path).await.unwrap();
        seed_test_model_selection(&store).await;
        let model_selection = InteractionModelSelection {
            family_id: ModelFamilyId::from_database(1),
            provider_id: ProviderId::parse("codex").unwrap(),
            model_id: "test-model".into(),
        };
        let mut result_ids = Vec::new();
        for timestamp in ["1", "2"] {
            let thread = store
                .insert_thread_with_initial_interaction(NewThreadRecord {
                    icon_selection_eligible: true,
                    title: "Standalone source",
                    project_id: None,
                    initial_message: "Original prompt",
                    harness_configuration_name: "codex-basic",
                    permission_profile_id: "auto",
                    model_selection: Some(&model_selection),
                    timestamp,
                })
                .await
                .unwrap();
            mark_interaction_accepted_with_node(
                &store,
                thread.root_interaction_id,
                700 + thread.root_interaction_id.value(),
            )
            .await;
            let outcome = store
                .insert_action_invocation(thread.root_interaction_id, 41, "Follow-up")
                .await
                .unwrap();
            match outcome {
                ActionInvocationInsertOutcome::Created { interaction, .. } => {
                    result_ids.push(interaction.id)
                }
                ActionInvocationInsertOutcome::Existing { .. } => {
                    panic!("standalone thread reused another thread's invocation")
                }
            }
        }
        assert_ne!(result_ids[0], result_ids[1]);

        store.pool.close().await;
    }

    #[tokio::test]
    async fn interrupted_leased_result_stays_recoverable_and_keeps_its_binding() {
        let temporary = tempfile::Builder::new()
            .prefix("relayer-invoke-binding-recovery-")
            .tempdir()
            .unwrap();
        let path = temporary.path().join("product.sqlite3");
        let store = SqliteProductStore::open(&path).await.unwrap();
        seed_test_model_selection(&store).await;
        let model_selection = InteractionModelSelection {
            family_id: ModelFamilyId::from_database(1),
            provider_id: ProviderId::parse("codex").unwrap(),
            model_id: "test-model".into(),
        };
        let thread = store
            .insert_thread_with_initial_interaction(NewThreadRecord {
                icon_selection_eligible: true,
                title: "Recoverable invoke",
                project_id: None,
                initial_message: "Original prompt",
                harness_configuration_name: "codex-basic",
                permission_profile_id: "auto",
                model_selection: Some(&model_selection),
                timestamp: "1",
            })
            .await
            .unwrap();
        mark_interaction_accepted(&store, thread.root_interaction_id).await;
        let result = match store
            .insert_action_invocation(thread.root_interaction_id, 41, "Follow-up")
            .await
            .unwrap()
        {
            ActionInvocationInsertOutcome::Created { interaction, .. } => interaction,
            ActionInvocationInsertOutcome::Existing { .. } => panic!("first invocation existed"),
        };
        sqlx::query(
            "UPDATE interactions SET completion_status='running',graph_node_id=901,harness_configuration_name='codex-basic',harness_configuration_digest='sha256:config',effective_execution_digest='sha256:execution',effective_permission_receipt_json='{}' WHERE id=?1",
        )
        .bind(result.id.value())
        .execute(&store.pool)
        .await
        .unwrap();

        assert_eq!(
            store
                .recover_interrupted_action_invocations("Invoke again to resume.")
                .await
                .unwrap(),
            1
        );
        let recovered = store.get_interaction(result.id).await.unwrap().unwrap();
        assert_eq!(recovered.completion_status, "submitted");
        assert_eq!(recovered.graph_node_id, Some(901));
        assert_eq!(
            recovered.harness_configuration_digest.as_deref(),
            Some("sha256:config")
        );
        assert_eq!(
            recovered.completion_error.as_deref(),
            Some("Invoke again to resume.")
        );
        let replay = store
            .insert_action_invocation(thread.root_interaction_id, 41, "Ignored")
            .await
            .unwrap();
        match replay {
            ActionInvocationInsertOutcome::Existing { interaction, .. } => {
                assert_eq!(interaction.id, result.id);
                assert_eq!(interaction.completion_status, "submitted");
            }
            ActionInvocationInsertOutcome::Created { .. } => {
                panic!("recovery created a second product result")
            }
        }

        store.pool.close().await;
    }

    #[tokio::test]
    async fn migrated_source_without_model_selection_preserves_action_execution() {
        let temporary = tempfile::Builder::new()
            .prefix("relayer-legacy-action-invocation-")
            .tempdir()
            .unwrap();
        let path = temporary.path().join("product.sqlite3");
        let store = SqliteProductStore::open(&path).await.unwrap();
        let thread = store
            .insert_thread_with_initial_interaction(NewThreadRecord {
                icon_selection_eligible: true,
                title: "Legacy source",
                project_id: None,
                initial_message: "Original prompt",
                harness_configuration_name: "codex-basic",
                permission_profile_id: "auto",
                model_selection: None,
                timestamp: "1",
            })
            .await
            .unwrap();
        mark_interaction_accepted(&store, thread.root_interaction_id).await;

        let outcome = store
            .insert_action_invocation(thread.root_interaction_id, 41, "Migrated follow-up")
            .await
            .unwrap();
        let interaction = match outcome {
            ActionInvocationInsertOutcome::Created { interaction, .. } => interaction,
            ActionInvocationInsertOutcome::Existing { .. } => panic!("first invocation existed"),
        };
        assert_eq!(interaction.model_selection, None);
        assert!(
            store
                .permits_unselected_action_execution(interaction.id)
                .await
                .unwrap()
        );
        assert!(
            !store
                .permits_unselected_action_execution(thread.root_interaction_id)
                .await
                .unwrap()
        );
        assert_eq!(store.list_interactions(thread.id).await.unwrap().len(), 2);

        store.pool.close().await;
    }

    #[tokio::test]
    async fn configuration_owned_source_can_invoke_without_a_model_selection() {
        let temporary = tempfile::Builder::new()
            .prefix("relayer-configuration-action-invocation-")
            .tempdir()
            .unwrap();
        let path = temporary.path().join("product.sqlite3");
        let store = SqliteProductStore::open(&path).await.unwrap();
        let thread = store
            .insert_thread_with_initial_interaction(NewThreadRecord {
                icon_selection_eligible: true,
                title: "Configuration-owned source",
                project_id: None,
                initial_message: "Original prompt",
                harness_configuration_name: "prime-agent-basic",
                permission_profile_id: "auto",
                model_selection: None,
                timestamp: "1",
            })
            .await
            .unwrap();
        mark_interaction_accepted(&store, thread.root_interaction_id).await;

        let outcome = store
            .insert_action_invocation(
                thread.root_interaction_id,
                41,
                "Configuration-owned follow-up",
            )
            .await
            .unwrap();
        let interaction = match outcome {
            ActionInvocationInsertOutcome::Created { interaction, .. } => interaction,
            ActionInvocationInsertOutcome::Existing { .. } => panic!("first invocation existed"),
        };
        assert_eq!(interaction.model_selection, None);

        store.pool.close().await;
    }

    #[tokio::test]
    async fn historical_action_requires_a_current_family() {
        let temporary = tempfile::Builder::new()
            .prefix("relayer-deleted-family-action-invocation-")
            .tempdir()
            .unwrap();
        let path = temporary.path().join("product.sqlite3");
        let store = SqliteProductStore::open(&path).await.unwrap();
        seed_test_model_selection(&store).await;
        sqlx::query("INSERT INTO model_families(id,name,kind,enabled,position) VALUES (2,'Historical','custom',1,1)")
            .execute(&store.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO model_family_members(family_id,position,provider_id,model_id) VALUES (2,0,'codex','test-model')")
            .execute(&store.pool)
            .await
            .unwrap();
        let model_selection = InteractionModelSelection {
            family_id: ModelFamilyId::from_database(2),
            provider_id: ProviderId::parse("codex").unwrap(),
            model_id: "test-model".into(),
        };
        let thread = store
            .insert_thread_with_initial_interaction(NewThreadRecord {
                icon_selection_eligible: true,
                title: "Historical source",
                project_id: None,
                initial_message: "Original prompt",
                harness_configuration_name: "codex-basic",
                permission_profile_id: "auto",
                model_selection: Some(&model_selection),
                timestamp: "1",
            })
            .await
            .unwrap();
        mark_interaction_accepted(&store, thread.root_interaction_id).await;
        assert!(
            store
                .delete_model_family(ModelFamilyId::from_database(2))
                .await
                .unwrap()
        );

        let error = store
            .insert_action_invocation(thread.root_interaction_id, 41, "Historical follow-up")
            .await
            .err()
            .unwrap();
        match error {
            StorageError::Catalog(error) => assert_eq!(error.code(), "model_family_removed"),
            other => panic!("unexpected error: {other}"),
        }

        store.pool.close().await;
    }

    #[tokio::test]
    async fn historical_action_cannot_reuse_a_hidden_model() {
        let temporary = tempfile::Builder::new()
            .prefix("relayer-hidden-model-action-invocation-")
            .tempdir()
            .unwrap();
        let path = temporary.path().join("product.sqlite3");
        let store = SqliteProductStore::open(&path).await.unwrap();
        seed_test_model_selection(&store).await;
        let model_selection = InteractionModelSelection {
            family_id: ModelFamilyId::from_database(1),
            provider_id: ProviderId::parse("codex").unwrap(),
            model_id: "test-model".into(),
        };
        let thread = store
            .insert_thread_with_initial_interaction(NewThreadRecord {
                icon_selection_eligible: true,
                title: "Historical hidden model",
                project_id: None,
                initial_message: "Original prompt",
                harness_configuration_name: "codex-basic",
                permission_profile_id: "auto",
                model_selection: Some(&model_selection),
                timestamp: "1",
            })
            .await
            .unwrap();
        mark_interaction_accepted(&store, thread.root_interaction_id).await;
        sqlx::query(
            "UPDATE provider_models SET visible=0 WHERE provider_id='codex' AND model_id='test-model'",
        )
        .execute(&store.pool)
        .await
        .unwrap();

        let selection_error = store
            .validate_model_selection(&crate::product::ValidateModelSelectionCommand {
                harness_id: "codex-basic".into(),
                family_id: model_selection.family_id,
                provider_id: model_selection.provider_id.clone(),
                model_id: model_selection.model_id.clone(),
            })
            .await
            .err()
            .unwrap();
        match selection_error {
            StorageError::Catalog(error) => assert_eq!(error.code(), "model_hidden"),
            other => panic!("unexpected error: {other}"),
        }

        let error = store
            .insert_action_invocation(thread.root_interaction_id, 41, "Historical follow-up")
            .await
            .err()
            .unwrap();
        match error {
            StorageError::Catalog(error) => assert_eq!(error.code(), "model_hidden"),
            other => panic!("unexpected error: {other}"),
        }

        store.pool.close().await;
    }

    #[tokio::test]
    async fn action_uses_the_last_successful_catalog_snapshot() {
        let temporary = tempfile::Builder::new()
            .prefix("relayer-stale-catalog-action-invocation-")
            .tempdir()
            .unwrap();
        let path = temporary.path().join("product.sqlite3");
        let store = SqliteProductStore::open(&path).await.unwrap();
        seed_test_model_selection(&store).await;
        let model_selection = InteractionModelSelection {
            family_id: ModelFamilyId::from_database(1),
            provider_id: ProviderId::parse("codex").unwrap(),
            model_id: "test-model".into(),
        };
        let thread = store
            .insert_thread_with_initial_interaction(NewThreadRecord {
                icon_selection_eligible: true,
                title: "Stale source",
                project_id: None,
                initial_message: "Original prompt",
                harness_configuration_name: "codex-basic",
                permission_profile_id: "auto",
                model_selection: Some(&model_selection),
                timestamp: "1",
            })
            .await
            .unwrap();
        mark_interaction_accepted(&store, thread.root_interaction_id).await;
        sqlx::query("UPDATE model_providers SET refreshed_at='0' WHERE id='codex'")
            .execute(&store.pool)
            .await
            .unwrap();

        store
            .insert_action_invocation(thread.root_interaction_id, 41, "Use last-known catalog")
            .await
            .unwrap();
        assert_eq!(store.list_interactions(thread.id).await.unwrap().len(), 2);

        store.pool.close().await;
    }

    #[tokio::test]
    async fn active_turn_blocks_a_second_action_interaction() {
        let temporary = tempfile::Builder::new()
            .prefix("relayer-active-turn-action-invocation-")
            .tempdir()
            .unwrap();
        let path = temporary.path().join("product.sqlite3");
        let store = SqliteProductStore::open(&path).await.unwrap();
        seed_test_model_selection(&store).await;
        let model_selection = InteractionModelSelection {
            family_id: ModelFamilyId::from_database(1),
            provider_id: ProviderId::parse("codex").unwrap(),
            model_id: "test-model".into(),
        };
        let thread = store
            .insert_thread_with_initial_interaction(NewThreadRecord {
                icon_selection_eligible: true,
                title: "Action source",
                project_id: None,
                initial_message: "Original prompt",
                harness_configuration_name: "codex-basic",
                permission_profile_id: "auto",
                model_selection: Some(&model_selection),
                timestamp: "1",
            })
            .await
            .unwrap();
        mark_interaction_accepted(&store, thread.root_interaction_id).await;
        sqlx::query("INSERT INTO interactions(thread_id,sequence,text,created_at,completion_status,permission_profile_id,model_provider_id,provider_model_id,model_family_id) VALUES (?1,2,'Running turn','2','running','auto','codex','test-model',1)")
            .bind(thread.id.value())
            .execute(&store.pool)
            .await
            .unwrap();

        let error = store
            .insert_action_invocation(thread.root_interaction_id, 41, "Must wait")
            .await
            .err()
            .unwrap();
        match error {
            StorageError::Catalog(error) => assert_eq!(error.code(), "interaction_in_progress"),
            other => panic!("unexpected error: {other}"),
        }
        assert_eq!(store.list_interactions(thread.id).await.unwrap().len(), 2);

        store.pool.close().await;
    }

    #[tokio::test]
    async fn hidden_available_model_is_blocked_for_new_historical_actions() {
        let temporary = tempfile::Builder::new()
            .prefix("relayer-hidden-model-action-invocation-")
            .tempdir()
            .unwrap();
        let path = temporary.path().join("product.sqlite3");
        let store = SqliteProductStore::open(&path).await.unwrap();
        seed_test_model_selection(&store).await;
        let model_selection = InteractionModelSelection {
            family_id: ModelFamilyId::from_database(1),
            provider_id: ProviderId::parse("codex").unwrap(),
            model_id: "test-model".into(),
        };
        let thread = store
            .insert_thread_with_initial_interaction(NewThreadRecord {
                icon_selection_eligible: true,
                title: "Historical hidden model",
                project_id: None,
                initial_message: "Original prompt",
                harness_configuration_name: "codex-basic",
                permission_profile_id: "auto",
                model_selection: Some(&model_selection),
                timestamp: "1",
            })
            .await
            .unwrap();
        mark_interaction_accepted(&store, thread.root_interaction_id).await;
        sqlx::query("UPDATE provider_models SET visible=0 WHERE provider_id='codex' AND model_id='test-model'")
            .execute(&store.pool)
            .await
            .unwrap();

        let error = store
            .insert_action_invocation(thread.root_interaction_id, 41, "Historical follow-up")
            .await
            .err()
            .unwrap();
        match error {
            StorageError::Catalog(error) => assert_eq!(error.code(), "model_hidden"),
            other => panic!("unexpected error: {other}"),
        }

        store.pool.close().await;
    }

    /// Startup marks an older build's unmarked result as an agent's child only when a user
    /// could not have created it: its source was not accepted, or was a root accepted after
    /// the result existed. A launched child's attempt finishes after its provider unwinds, so
    /// its late finish never marks a user's invoke made from its output.
    #[tokio::test]
    async fn only_results_a_user_could_not_have_created_are_marked_as_agent_children() {
        let temporary = tempfile::Builder::new()
            .prefix("relayer-mark-agent-children-")
            .tempdir()
            .unwrap();
        let store = SqliteProductStore::open(temporary.path().join("product.sqlite3"))
            .await
            .unwrap();
        seed_test_model_selection(&store).await;
        let thread = store
            .insert_thread_with_initial_interaction(NewThreadRecord {
                icon_selection_eligible: true,
                title: "Marking",
                project_id: None,
                initial_message: "Root",
                harness_configuration_name: "codex-basic",
                permission_profile_id: "auto",
                model_selection: None,
                timestamp: "1",
            })
            .await
            .unwrap();
        let root = thread.root_interaction_id.value();
        let thread_id = thread.id.value();
        for statement in [
            // 10: an accepted launched child, whose attempt finished late, at 900.
            "INSERT INTO interactions(id,thread_id,sequence,text,created_at,graph_node_id,completion_status,harness_configuration_name,harness_configuration_digest,effective_execution_digest,effective_permission_receipt_json) VALUES (10,?1,2,'Child','2',210,'accepted','codex-basic','sha256:h','sha256:e','{}')",
            "INSERT INTO completion_executions(interaction_id,graph_completion_id,harness_configuration_name,harness_configuration_digest,model_execution_digest,permission_origin_digest,phase,safe_reason,created_at,updated_at) VALUES (10,210,'codex-basic','sha256:h','sha256:e','sha256:o','settled','done','2','3')",
            "INSERT INTO interaction_attempts(interaction_id,attempt_number,started_at,finished_at,family_id,family_revision,harness_configuration_name,harness_configuration_revision,harness_configuration_digest,provider_id,adapter_id,adapter_implementation_version,model_id,access_contract,outcome,effect_boundary) VALUES (10,1,'2','900',1,1,'codex-basic',1,'sha256:h','codex','codex-subscription',1,'test-model','managed-runtime@1','accepted','graph_write')",
            // 11: a user's invoke from the child's output at 500, interrupted.
            "INSERT INTO interactions(id,thread_id,sequence,text,created_at,completion_status) VALUES (11,?1,3,'User action','500','submitted')",
            "INSERT INTO action_invocations(source_interaction_id,action_id,result_interaction_id,created_at,graph_lease_required,authoritative,agent_invoked) VALUES (10,41,11,'500',1,1,0)",
            // 12: a root accepted at 900 whose result was created at 500: an agent's child.
            "INSERT INTO interactions(id,thread_id,sequence,text,created_at,graph_node_id,completion_status) VALUES (12,?1,4,'Later root','400',212,'accepted')",
            "INSERT INTO interaction_attempts(interaction_id,attempt_number,started_at,finished_at,family_id,family_revision,harness_configuration_name,harness_configuration_revision,harness_configuration_digest,provider_id,adapter_id,adapter_implementation_version,model_id,access_contract,outcome,effect_boundary) VALUES (12,1,'400','900',1,1,'codex-basic',1,'sha256:h','codex','codex-subscription',1,'test-model','managed-runtime@1','accepted','graph_write')",
            "INSERT INTO interactions(id,thread_id,sequence,text,created_at,completion_status) VALUES (13,?1,5,'Early child','500','submitted')",
            "INSERT INTO action_invocations(source_interaction_id,action_id,result_interaction_id,created_at,graph_lease_required,authoritative,agent_invoked) VALUES (12,42,13,'500',1,1,0)",
            // 15: a grandchild the launched child 10 invoked at 2, before its execution settled
            // at 3, whose own launch never started: an agent's child.
            "INSERT INTO interactions(id,thread_id,sequence,text,created_at,completion_status) VALUES (15,?1,7,'Grandchild','2','submitted')",
            "INSERT INTO action_invocations(source_interaction_id,action_id,result_interaction_id,created_at,graph_lease_required,authoritative,agent_invoked) VALUES (10,44,15,'2',1,1,0)",
        ] {
            sqlx::query(statement)
                .bind(thread_id)
                .execute(&store.pool)
                .await
                .unwrap_or_else(|error| panic!("{statement}: {error}"));
        }
        // 14: an interrupted result of the root, which is still running: an agent's child.
        sqlx::query("INSERT INTO interactions(id,thread_id,sequence,text,created_at,completion_status) VALUES (14,?1,6,'Running root child','600','submitted')")
            .bind(thread_id)
            .execute(&store.pool)
            .await
            .unwrap();
        sqlx::query(
            "UPDATE interactions SET completion_status='running',graph_node_id=201 WHERE id=?1",
        )
        .bind(root)
        .execute(&store.pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO action_invocations(source_interaction_id,action_id,result_interaction_id,created_at,graph_lease_required,authoritative,agent_invoked) VALUES (?1,43,14,'600',1,1,0)")
            .bind(root)
            .execute(&store.pool)
            .await
            .unwrap();

        assert_eq!(store.mark_unrecorded_agent_children().await.unwrap(), 3);
        for (result, agent) in [(11, false), (13, true), (14, true), (15, true)] {
            assert_eq!(
                store
                    .is_agent_invoked_child(InteractionId::from_database(result))
                    .await
                    .unwrap(),
                agent,
                "result {result}"
            );
        }
        store.pool.close().await;
    }

    /// An older build recorded an agent's child without the marker. The agent's exact retry
    /// of the same recursive invocation establishes its origin, so it marks the row.
    #[tokio::test]
    async fn a_recursive_retry_marks_an_unmarked_child_as_an_agents() {
        let temporary = tempfile::Builder::new()
            .prefix("relayer-recursive-retry-marks-")
            .tempdir()
            .unwrap();
        let store = SqliteProductStore::open(temporary.path().join("product.sqlite3"))
            .await
            .unwrap();
        seed_test_model_selection(&store).await;
        let model_selection = InteractionModelSelection {
            family_id: ModelFamilyId::from_database(1),
            provider_id: ProviderId::parse("codex").unwrap(),
            model_id: "test-model".into(),
        };
        let thread = store
            .insert_thread_with_initial_interaction(NewThreadRecord {
                icon_selection_eligible: true,
                title: "Legacy child",
                project_id: None,
                initial_message: "Root",
                harness_configuration_name: "codex-basic",
                permission_profile_id: "auto",
                model_selection: Some(&model_selection),
                timestamp: "1",
            })
            .await
            .unwrap();
        // The root is still running: no user can have invoked from it yet.
        sqlx::query(
            "UPDATE interactions SET completion_status='running',graph_node_id=701 WHERE id=?1",
        )
        .bind(thread.root_interaction_id.value())
        .execute(&store.pool)
        .await
        .unwrap();
        let child = match store
            .insert_recursive_action_invocation(thread.root_interaction_id, 41, "Child")
            .await
            .unwrap()
        {
            ActionInvocationInsertOutcome::Created { interaction, .. } => interaction,
            _ => panic!("the child is new"),
        };
        sqlx::query("UPDATE action_invocations SET agent_invoked=0")
            .execute(&store.pool)
            .await
            .unwrap();

        let retry = store
            .insert_recursive_action_invocation(thread.root_interaction_id, 41, "Child")
            .await
            .unwrap();
        assert!(matches!(
            retry,
            ActionInvocationInsertOutcome::Existing { .. }
        ));
        assert!(store.is_agent_invoked_child(child.id).await.unwrap());

        // Once the root is accepted, a user's own invoke of another action keeps its origin
        // when the agent retries it, whether the product has only claimed its preparation or
        // already runs it.
        for id in [thread.root_interaction_id, child.id] {
            sqlx::query("UPDATE interactions SET completion_status='accepted' WHERE id=?1")
                .bind(id.value())
                .execute(&store.pool)
                .await
                .unwrap();
        }
        let user = match store
            .insert_action_invocation(thread.root_interaction_id, 42, "User action")
            .await
            .unwrap()
        {
            ActionInvocationInsertOutcome::Created { interaction, .. } => interaction,
            _ => panic!("the user's result is new"),
        };
        for status in ["submitted", "running"] {
            sqlx::query("UPDATE interactions SET completion_status=?1 WHERE id=?2")
                .bind(status)
                .bind(user.id.value())
                .execute(&store.pool)
                .await
                .unwrap();
            let retried = store
                .insert_recursive_action_invocation(thread.root_interaction_id, 42, "User action")
                .await
                .unwrap();
            let ActionInvocationInsertOutcome::Existing { invocation, .. } = retried else {
                panic!("the user's result exists");
            };
            assert!(!invocation.agent_invoked, "{status}");
            assert!(
                !store.is_agent_invoked_child(user.id).await.unwrap(),
                "{status}"
            );
        }
        store.pool.close().await;
    }

    async fn seed_test_model_selection(store: &SqliteProductStore) {
        let refreshed_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis()
            .to_string();
        sqlx::query("UPDATE model_providers SET connected=1,unavailable_reason_code=NULL,unavailable_reason_message=NULL,refreshed_at=?1 WHERE id='codex'")
            .bind(refreshed_at)
            .execute(&store.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO provider_models(provider_id,model_id,label,provider_order,visible,available,provider_default,metadata_json) VALUES ('codex','test-model','Test model',0,1,1,1,'{}')")
            .execute(&store.pool)
            .await
            .unwrap();
        sqlx::query("UPDATE product_harnesses SET available=1,unavailable_reason_code=NULL,unavailable_reason_message=NULL WHERE configuration_name='codex-basic'")
            .execute(&store.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO model_families(id,name,kind,system_key,enabled,position) VALUES (1,'Codex','system','codex',1,0)")
            .execute(&store.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO model_family_members(family_id,position,provider_id,model_id) VALUES (1,0,'codex','test-model')")
            .execute(&store.pool)
            .await
            .unwrap();
    }

    async fn mark_interaction_accepted(store: &SqliteProductStore, id: InteractionId) {
        mark_interaction_accepted_with_node(store, id, 777).await;
    }

    async fn mark_interaction_accepted_with_node(
        store: &SqliteProductStore,
        id: InteractionId,
        graph_node_id: i64,
    ) {
        sqlx::query(
            "UPDATE interactions SET completion_status='accepted',graph_node_id=COALESCE(graph_node_id,?2) WHERE id=?1",
        )
            .bind(id.value())
            .bind(graph_node_id)
            .execute(&store.pool)
            .await
            .unwrap();
    }
}
