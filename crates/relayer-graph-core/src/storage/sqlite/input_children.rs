use std::collections::HashSet;

use sqlx::{FromRow, SqliteConnection};

use crate::{
    ActionKind, GraphError, InputAction, InputControl, InteractionInputChild,
    InteractionInputChildId, LayerId, NodeId, PresentingInputOccurrence, SubmittedInput,
    SubmittedInputDraft, SubmittedInputValue,
    graph::{InteractionScope, canonical_submitted_input_bytes},
    interaction_input_semantic_digest,
};

use super::actions::ActionTable;

pub(crate) struct InputChildTable<'connection> {
    connection: &'connection mut SqliteConnection,
}

#[derive(FromRow)]
struct InputChildRow {
    id: i64,
    parent_interaction_node_id: i64,
    presenting_interaction_node_id: i64,
    presenting_layer_id: i64,
    action_id: i64,
    source_node_id: i64,
    action_snapshot_json: String,
    value_snapshot_json: String,
    attempt_key: String,
    authority_digest: String,
    semantic_digest: String,
}

impl<'connection> InputChildTable<'connection> {
    pub(crate) fn new(connection: &'connection mut SqliteConnection) -> Self {
        Self { connection }
    }

    pub(crate) async fn validate_and_insert_all(
        &mut self,
        scope: &InteractionScope,
        text: &str,
        attempt_key: &str,
        authority_digest: &str,
        drafts: &[SubmittedInputDraft],
    ) -> Result<Vec<InteractionInputChild>, GraphError> {
        let mut drafts = drafts.to_vec();
        drafts.sort_by_key(|draft| draft.occurrence.clone());
        let mut occurrences = HashSet::new();
        let semantic_digest = interaction_input_semantic_digest(text, &drafts)
            .map_err(|error| GraphError::Internal(error.to_string()))?;
        let mut canonical = Vec::with_capacity(drafts.len());
        for (index, draft) in drafts.into_iter().enumerate() {
            if !occurrences.insert(draft.occurrence.clone()) {
                return Err(GraphError::validation(
                    "input_attachment_duplicate",
                    format!("attachments[{index}]"),
                    "Send at most one value for each exact occurrence.",
                ));
            }
            let accepted = ActionTable::new(&mut *self.connection)
                .canonical_input_occurrence(scope, &draft.occurrence)
                .await
                .map_err(|error| attachment_error(index, error))?;
            let accepted_action = accepted.input.ok_or_else(|| {
                GraphError::validation(
                    "input_action_snapshot_mismatch",
                    format!("attachments[{index}]"),
                    "Refresh the accepted action and recommit its value.",
                )
            })?;
            if accepted.kind != ActionKind::Input || accepted_action != draft.action {
                return Err(GraphError::validation(
                    "input_action_snapshot_mismatch",
                    format!("attachments[{index}]"),
                    "Refresh the accepted action and recommit its value.",
                ));
            }
            let value = validate_value(index, &accepted_action, &draft.value)?;
            canonical.push((
                draft.occurrence,
                accepted.source_node_id,
                accepted_action,
                value,
            ));
        }

        for (position, (occurrence, source_node_id, action, value)) in canonical.iter().enumerate()
        {
            sqlx::query(
                "INSERT INTO interaction_input_children(parent_interaction_node_id,position,presenting_interaction_node_id,presenting_layer_id,action_id,source_node_id,action_snapshot_json,value_snapshot_json,attempt_key,authority_digest,semantic_digest) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            )
            .bind(scope.root_node_id.value())
            .bind(i64::try_from(position).map_err(|_| GraphError::Internal("input child position exceeds SQLite range".into()))?)
            .bind(occurrence.presenting_interaction_node_id.value())
            .bind(occurrence.presenting_layer_id.value())
            .bind(occurrence.action_id.value())
            .bind(source_node_id.value())
            .bind(serde_json::to_string(action).map_err(|error| GraphError::Internal(error.to_string()))?)
            .bind(serde_json::to_string(value).map_err(|error| GraphError::Internal(error.to_string()))?)
            .bind(attempt_key)
            .bind(authority_digest)
            .bind(&semantic_digest)
            .execute(&mut *self.connection)
            .await?;
        }
        self.children(scope.root_node_id).await
    }

    pub(crate) async fn children(
        &mut self,
        parent: NodeId,
    ) -> Result<Vec<InteractionInputChild>, GraphError> {
        let rows = sqlx::query_as::<_, InputChildRow>(
            "SELECT id,parent_interaction_node_id,presenting_interaction_node_id,presenting_layer_id,action_id,source_node_id,action_snapshot_json,value_snapshot_json,attempt_key,authority_digest,semantic_digest FROM interaction_input_children WHERE parent_interaction_node_id=?1 ORDER BY position",
        )
        .bind(parent.value())
        .fetch_all(&mut *self.connection)
        .await?;
        rows.into_iter().map(InputChildRow::try_into).collect()
    }

    pub(crate) async fn normalized(
        &mut self,
        parent: NodeId,
    ) -> Result<Vec<SubmittedInput>, GraphError> {
        let mut inputs = self
            .children(parent)
            .await?
            .into_iter()
            .map(|child| SubmittedInput {
                action: child.action,
                value: child.value,
            })
            .collect::<Vec<_>>();
        inputs.sort_by(|left, right| {
            canonical_submitted_input_bytes(left)
                .expect("submitted input is serializable")
                .cmp(
                    &canonical_submitted_input_bytes(right)
                        .expect("submitted input is serializable"),
                )
        });
        Ok(inputs)
    }
}

fn validate_value(
    index: usize,
    action: &InputAction,
    value: &SubmittedInputValue,
) -> Result<SubmittedInputValue, GraphError> {
    let path = format!("attachments[{index}].value");
    match (action.control, value) {
        (InputControl::Text, SubmittedInputValue::Text { text }) => {
            if text.trim().is_empty() {
                return Err(GraphError::validation(
                    "input_text_blank",
                    path,
                    "Enter non-whitespace text or detach the input.",
                ));
            }
            Ok(value.clone())
        }
        (
            InputControl::SingleSelect | InputControl::MultiSelect,
            SubmittedInputValue::Selected { selected },
        ) => {
            let mut keys = HashSet::new();
            let known = action
                .options
                .iter()
                .map(|option| (&option.key, &option.label))
                .collect::<std::collections::HashMap<_, _>>();
            for option in selected {
                if !keys.insert(option.key.as_str()) {
                    return Err(GraphError::validation(
                        "input_option_duplicate",
                        path,
                        "Remove repeated multi-select keys.",
                    ));
                }
                if known.get(&option.key) != Some(&&option.label) {
                    return Err(GraphError::validation(
                        "input_option_unknown",
                        path,
                        "Select only keys and labels from the accepted action snapshot.",
                    ));
                }
            }
            let count_valid = match action.control {
                InputControl::SingleSelect => selected.len() == 1,
                InputControl::MultiSelect => action
                    .minimum_selections
                    .is_none_or(|minimum| selected.len() >= minimum),
                InputControl::Text => unreachable!(),
            };
            if !count_valid {
                return Err(GraphError::validation(
                    "input_selection_count",
                    path,
                    "Meet that action's exact selection count or minimum.",
                ));
            }
            Ok(value.canonicalized())
        }
        _ => Err(GraphError::validation(
            "input_action_snapshot_mismatch",
            path,
            "Refresh the accepted action and recommit its value.",
        )),
    }
}

fn attachment_error(index: usize, error: GraphError) -> GraphError {
    match error {
        GraphError::Validation {
            code,
            path,
            message,
        } => {
            let suffix = path.strip_prefix("occurrence").unwrap_or(&path);
            GraphError::validation(code, format!("attachments[{index}]{suffix}"), message)
        }
        GraphError::ValidationIssues { message, issues } => GraphError::ValidationIssues {
            message,
            issues: issues
                .into_iter()
                .map(|issue| {
                    let suffix = issue.path.strip_prefix("occurrence").unwrap_or(&issue.path);
                    crate::ValidationIssue {
                        code: issue.code,
                        path: format!("attachments[{index}]{suffix}"),
                        message: issue.message,
                    }
                })
                .collect(),
        },
        other => other,
    }
}

impl TryFrom<InputChildRow> for InteractionInputChild {
    type Error = GraphError;

    fn try_from(row: InputChildRow) -> Result<Self, Self::Error> {
        Ok(Self {
            id: InteractionInputChildId::new(row.id).ok_or_else(|| {
                GraphError::Internal("database returned an invalid input child ID".into())
            })?,
            parent_interaction_node_id: valid_node_id(row.parent_interaction_node_id)?,
            occurrence: PresentingInputOccurrence {
                presenting_interaction_node_id: valid_node_id(row.presenting_interaction_node_id)?,
                presenting_layer_id: LayerId::new(row.presenting_layer_id).ok_or_else(|| {
                    GraphError::Internal("database returned an invalid presenting layer ID".into())
                })?,
                action_id: crate::ActionId::new(row.action_id).ok_or_else(|| {
                    GraphError::Internal("database returned an invalid action ID".into())
                })?,
            },
            source_node_id: valid_node_id(row.source_node_id)?,
            action: serde_json::from_str(&row.action_snapshot_json)
                .map_err(|error| GraphError::Internal(error.to_string()))?,
            value: serde_json::from_str(&row.value_snapshot_json)
                .map_err(|error| GraphError::Internal(error.to_string()))?,
            attempt_key: row.attempt_key,
            authority_digest: row.authority_digest,
            semantic_digest: row.semantic_digest,
        })
    }
}

fn valid_node_id(value: i64) -> Result<NodeId, GraphError> {
    NodeId::new(value)
        .ok_or_else(|| GraphError::Internal("database returned an invalid node ID".into()))
}
