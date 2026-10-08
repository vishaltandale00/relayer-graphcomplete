use crate::storage::sqlite::{actions::ActionTable, nodes::NodeTable};
use crate::{
    ActionId, ActionKind, CompletionState, GraphDatabase, GraphError, GraphNode, GraphWriter,
    LayerId, NodeId, RecordState, SubmittedInputDraft, interaction_input_authority_digest,
};
use serde::{Deserialize, Serialize};

/// A bound call has its own identity; the source action remains reusable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphInvocation {
    pub id: i64,
    pub invocation_key: String,
    pub source_completion_id: NodeId,
    pub source_action_id: ActionId,
    pub parent_node_id: NodeId,
    pub child_interaction_node_id: NodeId,
    pub action_snapshot: serde_json::Value,
    pub state: CompletionState,
}

impl GraphWriter {
    pub async fn prepare_recursive_invocation(
        &self,
        action_id: ActionId,
        invocation_key: &str,
    ) -> Result<(GraphNode, GraphInvocation), GraphError> {
        self.prepare_invocation(action_id, invocation_key, false, &[], None)
            .await
    }
    /// Trusted Product preparation after validating an accepted action occurrence.
    pub async fn prepare_user_invocation(
        &self,
        action_id: ActionId,
        invocation_key: &str,
    ) -> Result<(GraphNode, GraphInvocation), GraphError> {
        self.prepare_user_invocation_with_inputs(action_id, invocation_key, &[])
            .await
    }
    /// Trusted Product binds validated committed answers to this call, not the callable.
    pub async fn prepare_user_invocation_with_inputs(
        &self,
        action_id: ActionId,
        invocation_key: &str,
        submitted_inputs: &[SubmittedInputDraft],
    ) -> Result<(GraphNode, GraphInvocation), GraphError> {
        self.prepare_user_invocation_in_layer(action_id, invocation_key, submitted_inputs, None)
            .await
    }
    /// Freeze the accepted layer occurrence activated by the user, independently of
    /// the callable's original authored source layer.
    pub async fn prepare_user_invocation_in_layer(
        &self,
        action_id: ActionId,
        invocation_key: &str,
        submitted_inputs: &[SubmittedInputDraft],
        presenting_layer: Option<LayerId>,
    ) -> Result<(GraphNode, GraphInvocation), GraphError> {
        if self.scope.authority_epoch.is_some() || self.scope.read_only {
            return Err(GraphError::Forbidden(
                "User invocation preparation requires trusted native control.".into(),
            ));
        }
        self.prepare_invocation(
            action_id,
            invocation_key,
            true,
            submitted_inputs,
            presenting_layer,
        )
        .await
    }
    async fn prepare_invocation(
        &self,
        action_id: ActionId,
        invocation_key: &str,
        user_initiated: bool,
        submitted_inputs: &[SubmittedInputDraft],
        presenting_layer: Option<LayerId>,
    ) -> Result<(GraphNode, GraphInvocation), GraphError> {
        if invocation_key.trim().is_empty() || invocation_key.len() > 256 {
            return Err(GraphError::validation(
                "invocation_key_invalid",
                "invocationKey",
                "Provide a stable nonempty invocation key of at most 256 bytes.",
            ));
        }
        let mut transaction = self.database.storage.begin_write().await?;
        self.scope
            .require_active_authority(&mut transaction)
            .await?;
        if !user_initiated
            && !crate::storage::sqlite::invocations::source_active(
                &mut transaction,
                self.scope.root_node_id,
            )
            .await?
        {
            return Err(GraphError::Forbidden(
                "Only an active completion may prepare its own child invocation.".into(),
            ));
        }
        ActionTable::new(&mut transaction)
            .require_native_provenance(action_id)
            .await?;
        let action = ActionTable::new(&mut transaction)
            .record(&self.scope, action_id)
            .await?
            .ok_or_else(|| GraphError::NotFound(format!("action {action_id}")))?
            .action;
        let owned = crate::storage::sqlite::invocations::action_owned(
            &mut transaction,
            action_id,
            self.scope.root_node_id,
        )
        .await?;
        if (!owned && !user_initiated)
            || (user_initiated && action.state != RecordState::Accepted)
            || action.kind != ActionKind::Invoke
            || !matches!(action.state, RecordState::Draft | RecordState::Accepted)
        {
            return Err(GraphError::Forbidden(
                "This completion may invoke only its own native callable actions.".into(),
            ));
        }
        if let Some(existing) = crate::storage::sqlite::invocations::for_key(
            &mut transaction,
            self.scope.root_node_id,
            invocation_key,
        )
        .await?
        {
            let frozen = &existing.action_snapshot;
            let original_layer = frozen
                .get("presentingLayerId")
                .or_else(|| frozen.get("sourceLayerId"))
                .and_then(serde_json::Value::as_i64)
                .and_then(LayerId::new);
            if existing.source_action_id != action_id
                || existing.parent_node_id != action.source_node_id
                || frozen.get("actionId").and_then(serde_json::Value::as_i64)
                    != Some(action_id.value())
                || frozen
                    .get("sourceNodeId")
                    .and_then(serde_json::Value::as_i64)
                    != Some(existing.parent_node_id.value())
                || presenting_layer.is_some_and(|layer| Some(layer) != original_layer)
            {
                return Err(GraphError::validation(
                    "invocation_key_conflict",
                    "invocationKey",
                    "Recover the original action and presenting occurrence of this invocation.",
                ));
            }
            if user_initiated {
                let closure = crate::graph::completion::read_accepted_closure_on(
                    &mut transaction,
                    &self.scope,
                    self.scope.root_node_id,
                )
                .await?
                .ok_or_else(|| {
                    GraphError::Forbidden(
                        "User Invoke requires an accepted source response.".into(),
                    )
                })?;
                if !closure.layers.iter().any(|layer| {
                    Some(layer.layer.id) == original_layer
                        && layer.layer.state == RecordState::Accepted
                        && layer
                            .nodes
                            .iter()
                            .any(|node| node.id == existing.parent_node_id)
                }) {
                    return Err(GraphError::validation(
                        "invalid_invocation_presentation",
                        "presentingLayerId",
                        "Recover the original accepted presenting occurrence of this invocation.",
                    ));
                }
            }
            let instruction = frozen
                .get("instruction")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| {
                    GraphError::Internal("Frozen Invoke instruction is missing".into())
                })?;
            let stored_inputs =
                crate::storage::sqlite::input_children::InputChildTable::new(&mut transaction)
                    .children(existing.child_interaction_node_id)
                    .await?
                    .into_iter()
                    .map(|child| SubmittedInputDraft {
                        occurrence: child.occurrence,
                        action: child.action,
                        value: child.value,
                    })
                    .collect::<Vec<_>>();
            let frozen_digest = interaction_input_authority_digest(instruction, &stored_inputs)
                .map_err(|error| GraphError::Internal(error.to_string()))?;
            let supplied_digest = interaction_input_authority_digest(instruction, submitted_inputs)
                .map_err(|error| GraphError::Internal(error.to_string()))?;
            if frozen_digest != supplied_digest {
                return Err(GraphError::validation(
                    "invocation_key_conflict",
                    "submittedInputs",
                    "Recover this invocation's original frozen argument payload.",
                ));
            }
            // This is a read of an already-prepared child, not a new call or
            // execution retry. Mutable own-draft repairs cannot rewrite its
            // instruction, bindings, policy, activator or presenting provenance.
            let node = NodeTable::new(&mut transaction)
                .visible(&self.scope, existing.child_interaction_node_id)
                .await?;
            transaction.commit().await?;
            return Ok((node, existing));
        }
        let presenting_layer = presenting_layer.or(action.source_layer_id);
        if user_initiated {
            let closure = crate::graph::completion::read_accepted_closure_on(
                &mut transaction,
                &self.scope,
                self.scope.root_node_id,
            )
            .await?
            .ok_or_else(|| {
                GraphError::Forbidden("User Invoke requires an accepted source response.".into())
            })?;
            if !closure.layers.iter().any(|layer| {
                Some(layer.layer.id) == presenting_layer
                    && layer.layer.state == RecordState::Accepted
                    && layer
                        .nodes
                        .iter()
                        .any(|node| node.id == action.source_node_id)
            }) {
                return Err(GraphError::validation(
                    "invalid_invocation_presentation",
                    "presentingLayerId",
                    "Invoke must name an accepted presenting layer containing this callable in the source response.",
                ));
            }
        }
        let mut snapshot_value = serde_json::json!({ "actionId": action.id, "sourceNodeId": action.source_node_id, "sourceLayerId": action.source_layer_id, "instruction": action.interaction_text, "label": action.label, "icon": action.icon, "description": action.description, "variant": action.variant });
        snapshot_value["state"] = serde_json::json!(action.state);
        snapshot_value["presentingLayerId"] = serde_json::json!(presenting_layer);
        snapshot_value["activator"] =
            serde_json::json!(if user_initiated { "human" } else { "agent" });
        if !action.input_action_ids.is_empty() {
            snapshot_value["inputActionIds"] = serde_json::json!(action.input_action_ids);
        }
        if let Some(reusable) = action.reusable {
            snapshot_value["reusable"] = serde_json::json!(reusable);
        }
        let snapshot = serde_json::to_string(&snapshot_value)
            .map_err(|error| GraphError::Internal(error.to_string()))?;
        let instruction = action
            .interaction_text
            .as_deref()
            .ok_or_else(|| GraphError::Forbidden("Invoke action has no instruction.".into()))?;
        let input_digest = interaction_input_authority_digest(instruction, submitted_inputs)
            .map_err(|error| GraphError::Internal(error.to_string()))?;
        ActionTable::new(&mut transaction)
            .validate_invoke_inputs(&self.scope, action.source_node_id, &action.input_action_ids)
            .await?;
        if action.reusable == Some(false)
            && sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM durable_invocations WHERE source_action_id=?1)",
            )
            .bind(action_id.value())
            .fetch_one(&mut *transaction)
            .await?
        {
            return Err(GraphError::validation(
                "invoke_single_call_already_prepared",
                "actionId",
                "This Invoke already has its call. Recover the existing invocation key; author reusable=true only for an intentionally reusable callable.",
            ));
        }
        let required = action
            .input_action_ids
            .iter()
            .copied()
            .collect::<std::collections::BTreeSet<_>>();
        let supplied = submitted_inputs
            .iter()
            .map(|input| input.occurrence.action_id)
            .collect::<std::collections::BTreeSet<_>>();
        if required != supplied || supplied.len() != submitted_inputs.len() {
            return Err(GraphError::validation(
                "invoke_input_binding_mismatch",
                "submittedInputs",
                "Confirm exactly the input actions connected to this Invoke before calling it.",
            ));
        }
        let child = NodeTable::new(&mut transaction)
            .insert_interaction(
                self.scope.project_id,
                self.scope.thread_id,
                instruction,
                None,
            )
            .await?;
        crate::storage::sqlite::invocations::insert(
            &mut transaction,
            self.scope.root_node_id,
            action_id,
            action.source_node_id,
            invocation_key,
            &snapshot,
            child.id,
        )
        .await?;
        let child_scope = NodeTable::new(&mut transaction)
            .interaction_scope(child.id)
            .await?;
        crate::storage::sqlite::input_children::InputChildTable::new(&mut transaction)
            .validate_and_insert_all(
                &child_scope,
                instruction,
                invocation_key,
                &input_digest,
                submitted_inputs,
            )
            .await?;
        crate::graph::database::initialize_completion(
            &mut transaction,
            &child,
            self.scope.project_id,
            self.scope.thread_id,
        )
        .await?;
        let invocation = crate::storage::sqlite::invocations::for_key(
            &mut transaction,
            self.scope.root_node_id,
            invocation_key,
        )
        .await?
        .expect("inserted invocation");
        transaction.commit().await?;
        Ok((child, invocation))
    }

    pub async fn action_invocations(
        &self,
        action_id: ActionId,
    ) -> Result<Vec<GraphInvocation>, GraphError> {
        let mut transaction = self.database.storage.begin_read().await?;
        self.scope
            .require_active_authority(&mut transaction)
            .await?;
        let action = ActionTable::new(&mut transaction)
            .record(&self.scope, action_id)
            .await?
            .ok_or_else(|| GraphError::NotFound(format!("action {action_id}")))?
            .action;
        NodeTable::new(&mut transaction)
            .visible(&self.scope, action.source_node_id)
            .await?;
        if action.state != RecordState::Accepted
            && !(action.state == RecordState::Draft
                && crate::storage::sqlite::invocations::action_owned(
                    &mut transaction,
                    action_id,
                    self.scope.root_node_id,
                )
                .await?)
        {
            return Err(GraphError::Forbidden(format!(
                "action {action_id} is not readable by this interaction"
            )));
        }
        let ids =
            crate::storage::sqlite::invocations::children(&mut transaction, action_id).await?;
        let mut result = Vec::new();
        for id in ids {
            result.push(
                crate::storage::sqlite::invocations::for_child(&mut transaction, id)
                    .await?
                    .expect("invocation row"),
            );
        }
        transaction.commit().await?;
        Ok(result)
    }
}

impl GraphDatabase {
    pub async fn durable_invocation_by_id(
        &self,
        id: i64,
    ) -> Result<Option<GraphInvocation>, GraphError> {
        let mut connection = self.storage.acquire().await?;
        crate::storage::sqlite::invocations::by_id(&mut connection, id).await
    }
    pub async fn durable_invocation(
        &self,
        child: NodeId,
    ) -> Result<Option<GraphInvocation>, GraphError> {
        let mut connection = self.storage.acquire().await?;
        crate::storage::sqlite::invocations::for_child(&mut connection, child).await
    }
}
