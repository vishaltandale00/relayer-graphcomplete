use super::{ApiState, auth::authorize_write, error::ApiError, input_operator_sessions};
use crate::product::{ActionInputDraft, ActionInputValue, ThreadId};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::HeaderMap,
};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CommitActionInputRequest {
    occurrence: relayer_graph_core::PresentingInputOccurrence,
    value: ActionInputValue,
    expected_revision: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DetachActionInputQuery {
    expected_revision: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ActionInputDraftResponse {
    thread_id: i64,
    revision: i64,
    attachments: Vec<ActionInputAttachmentResponse>,
    updated_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ActionInputAttachmentResponse {
    occurrence: relayer_graph_core::PresentingInputOccurrence,
    source_node_id: i64,
    action: relayer_graph_core::InputAction,
    value: ActionInputValue,
    draft_revision: i64,
    committed_at: String,
    composer_eligible: bool,
}

impl From<ActionInputDraft> for ActionInputDraftResponse {
    fn from(draft: ActionInputDraft) -> Self {
        Self {
            thread_id: draft.thread_id.value(),
            revision: draft.revision,
            attachments: draft
                .attachments
                .into_iter()
                .map(|attachment| ActionInputAttachmentResponse {
                    occurrence: attachment.occurrence,
                    source_node_id: attachment.source_node_id,
                    action: attachment.action,
                    value: attachment.value,
                    draft_revision: attachment.draft_revision,
                    committed_at: attachment.committed_at,
                    composer_eligible: true,
                })
                .collect(),
            updated_at: draft.updated_at,
        }
    }
}

// Classification is trusted graph-derived presentation state, never caller input.
// It follows the attachment's accepted occurrence even after UI navigation.
pub(super) async fn composer_occurrences(
    state: &ApiState,
    draft: &ActionInputDraft,
) -> Result<Vec<relayer_graph_core::PresentingInputOccurrence>, ApiError> {
    let mut ordinary = Vec::new();
    if draft.attachments.is_empty() {
        return Ok(ordinary);
    }
    let runtime = state.runtime.as_ref().ok_or_else(|| {
        ApiError::internal("graph runtime is unavailable for input scope validation")
    })?;
    let project = state
        .product
        .get_thread(draft.thread_id)
        .await?
        .thread
        .project_id
        .map(|id| id.value());
    for input in &draft.attachments {
        let consumers = runtime
            .canonical_input_action_consumer_state(
                project,
                draft.thread_id.value(),
                &input.occurrence,
            )
            .await?;
        if consumers.composer_eligible {
            ordinary.push(input.occurrence.clone());
        }
    }
    Ok(ordinary)
}

/// Presentation-only admission flags use the same whole canonical Node binding
/// inventory as commit refusal and composer scoping. They never alter stored
/// accepted action definitions or grant execution authority.
pub(super) async fn project_layer_input_availability(
    state: &ApiState,
    thread_id: ThreadId,
    presenting_interaction: i64,
    layer: &mut serde_json::Value,
    deadline: tokio::time::Instant,
) -> Result<(), ApiError> {
    let Some(actions) = layer
        .get_mut("actions")
        .and_then(serde_json::Value::as_array_mut)
    else {
        return Ok(());
    };
    if !actions.iter().any(|action| action["kind"] == "input") {
        return Ok(());
    }
    let thread = state.product.get_thread(thread_id).await?.thread;
    let project = thread.project_id.map(|id| id.value());
    let layer_id = layer["layer"]["id"].as_i64();
    // Reborrow after reading immutable Layer identity.
    let actions = layer["actions"].as_array_mut().unwrap();
    for action in actions
        .iter_mut()
        .filter(|action| action["kind"] == "input")
    {
        let occurrence = match (
            relayer_graph_core::NodeId::new(presenting_interaction),
            layer_id.and_then(relayer_graph_core::LayerId::new),
            action["id"]
                .as_i64()
                .and_then(relayer_graph_core::ActionId::new),
        ) {
            (Some(presenting_interaction_node_id), Some(presenting_layer_id), Some(action_id)) => {
                relayer_graph_core::PresentingInputOccurrence {
                    presenting_interaction_node_id,
                    presenting_layer_id,
                    action_id,
                }
            }
            _ => {
                action["inputCanAcceptAnswer"] = serde_json::json!(false);
                continue;
            }
        };
        let flags = match &state.runtime {
            Some(runtime) if !thread.imported => tokio::time::timeout_at(
                deadline,
                runtime.canonical_input_action_consumer_state(
                    project,
                    thread_id.value(),
                    &occurrence,
                ),
            )
            .await
            .ok()
            .and_then(Result::ok),
            _ => None,
        };
        // Unknown availability cannot invite an answer that may have no consumer.
        action["inputCanAcceptAnswer"] =
            serde_json::json!(flags.is_some_and(|state| state.editable));
    }
    Ok(())
}

pub(super) async fn scoped_response(
    state: &ApiState,
    draft: ActionInputDraft,
) -> Result<ActionInputDraftResponse, ApiError> {
    let ordinary = composer_occurrences(state, &draft).await?;
    let mut response: ActionInputDraftResponse = draft.into();
    for input in &mut response.attachments {
        input.composer_eligible = ordinary.contains(&input.occurrence);
    }
    Ok(response)
}

pub(super) async fn get(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(thread_id): Path<i64>,
) -> Result<Json<ActionInputDraftResponse>, ApiError> {
    let operator = if state.authenticator.is_control(&headers) {
        authorize_write(&state, &headers)?;
        None
    } else if state.authenticator.input_operator_token(&headers).is_some() {
        Some(input_operator_sessions::authorize_thread(
            &state, &headers, thread_id,
        )?)
    } else {
        authorize_write(&state, &headers)?;
        None
    };
    let draft = state
        .product
        .action_input_draft(ThreadId::try_from(thread_id)?)
        .await?;
    let mut response = scoped_response(&state, draft).await?;
    if let Some(operator) = operator {
        response.attachments.retain(|attachment| {
            operator
                .occurrences
                .contains(&input_operator_sessions::occurrence_key(
                    &attachment.occurrence,
                ))
        });
    }
    Ok(Json(response))
}

pub(super) async fn commit(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(thread_id): Path<i64>,
    Json(request): Json<CommitActionInputRequest>,
) -> Result<Json<ActionInputDraftResponse>, ApiError> {
    let operator = if state.authenticator.is_control(&headers) {
        authorize_write(&state, &headers)?;
        None
    } else if state.authenticator.input_operator_token(&headers).is_some() {
        Some(input_operator_sessions::authorize_occurrence(
            &state,
            &headers,
            thread_id,
            &request.occurrence,
        )?)
    } else {
        authorize_write(&state, &headers)?;
        None
    };
    let thread_id = ThreadId::try_from(thread_id)?;
    let runtime = state.runtime.as_ref().ok_or_else(|| {
        ApiError::internal("graph runtime is unavailable for input occurrence validation")
    })?;
    let destination_project_id = state
        .product
        .get_thread(thread_id)
        .await?
        .thread
        .project_id
        .map(|project_id| project_id.value());
    let action = runtime
        .canonical_editable_input_action_occurrence(
            destination_project_id,
            thread_id.value(),
            &request.occurrence,
        )
        .await?;
    let draft = state
        .product
        .commit_action_input_attachment(
            thread_id,
            &request.occurrence,
            &action,
            &request.value,
            request.expected_revision,
        )
        .await?;
    let mut response = scoped_response(&state, draft).await?;
    if let Some(operator) = operator {
        response.attachments.retain(|attachment| {
            operator
                .occurrences
                .contains(&input_operator_sessions::occurrence_key(
                    &attachment.occurrence,
                ))
        });
    }
    Ok(Json(response))
}

pub(super) async fn detach(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path((thread_id, presenting_interaction_node_id, presenting_layer_id, action_id)): Path<(
        i64,
        i64,
        i64,
        i64,
    )>,
    Query(query): Query<DetachActionInputQuery>,
) -> Result<Json<ActionInputDraftResponse>, ApiError> {
    authorize_write(&state, &headers)?;
    let occurrence = relayer_graph_core::PresentingInputOccurrence {
        presenting_interaction_node_id: relayer_graph_core::NodeId::new(
            presenting_interaction_node_id,
        )
        .ok_or_else(|| ApiError::invalid("presentingInteractionNodeId must be positive"))?,
        presenting_layer_id: relayer_graph_core::LayerId::new(presenting_layer_id)
            .ok_or_else(|| ApiError::invalid("presentingLayerId must be positive"))?,
        action_id: relayer_graph_core::ActionId::new(action_id)
            .ok_or_else(|| ApiError::invalid("actionId must be positive"))?,
    };
    let draft = state
        .product
        .detach_action_input_attachment(
            ThreadId::try_from(thread_id)?,
            &occurrence,
            query.expected_revision,
        )
        .await?;
    Ok(Json(scoped_response(&state, draft).await?))
}

#[cfg(test)]
mod tests {
    use super::CommitActionInputRequest;
    use crate::product::ActionInputValue;
    use serde_json::json;

    fn commit_request(value: serde_json::Value) -> serde_json::Value {
        json!({
            "occurrence": {
                "presentingInteractionNodeId": 11,
                "presentingLayerId": 12,
                "actionId": 13
            },
            "value": value,
            "expectedRevision": 0
        })
    }

    #[test]
    fn committed_input_value_rejects_mixed_text_and_selection_fields() {
        assert!(
            serde_json::from_value::<CommitActionInputRequest>(commit_request(json!({
                "text": "Tonight",
                "selectedKeys": ["canary"]
            })))
            .is_err()
        );
    }

    #[test]
    fn committed_input_value_rejects_unknown_nested_fields() {
        for value in [
            json!({ "text": "Tonight", "texxt": "misspelled" }),
            json!({ "selectedKeys": ["canary"], "selectedKey": "misspelled" }),
        ] {
            assert!(
                serde_json::from_value::<CommitActionInputRequest>(commit_request(value)).is_err()
            );
        }
    }

    #[test]
    fn committed_input_value_accepts_exact_text_and_selection_shapes() {
        let text: CommitActionInputRequest =
            serde_json::from_value(commit_request(json!({ "text": "Tonight" })))
                .expect("exact text input should parse");
        assert_eq!(
            text.value,
            ActionInputValue::Text {
                text: "Tonight".into()
            }
        );

        let selected: CommitActionInputRequest = serde_json::from_value(commit_request(json!({
            "selectedKeys": ["canary", "logs"]
        })))
        .expect("exact selected input should parse");
        assert_eq!(
            selected.value,
            ActionInputValue::Selected {
                selected_keys: vec!["canary".into(), "logs".into()]
            }
        );
    }
}
