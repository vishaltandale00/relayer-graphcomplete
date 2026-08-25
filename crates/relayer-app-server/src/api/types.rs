use crate::product::{
    ActionInvocation, Interaction, InteractionModelSelection, ProductCapabilities, ProductState,
    Project, Thread, ThreadDetail, ThreadView,
};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InteractionAttemptResponse {
    id: i64,
    attempt_number: i64,
    started_at: String,
    finished_at: Option<String>,
    model_selection: InteractionModelSelection,
    family_revision: i64,
    harness_configuration_name: String,
    harness_configuration_revision: i64,
    harness_configuration_digest: String,
    adapter_id: String,
    adapter_implementation_version: i64,
    access_contract: String,
    outcome: String,
    failure_category: Option<String>,
    failure_message: Option<String>,
    effect_boundary: String,
}

impl From<crate::product::InteractionAttempt> for InteractionAttemptResponse {
    fn from(attempt: crate::product::InteractionAttempt) -> Self {
        let failure_message = attempt
            .failure_category
            .as_deref()
            .map(model_failure_message);
        Self {
            id: attempt.id,
            attempt_number: attempt.attempt_number,
            started_at: attempt.started_at,
            finished_at: attempt.finished_at,
            model_selection: InteractionModelSelection {
                family_id: attempt.family_id,
                provider_id: attempt.provider_id,
                model_id: attempt.model_id,
            },
            family_revision: attempt.family_revision,
            harness_configuration_name: attempt.harness_configuration_name,
            harness_configuration_revision: attempt.harness_configuration_revision,
            harness_configuration_digest: attempt.harness_configuration_digest,
            adapter_id: attempt.adapter_id,
            adapter_implementation_version: attempt.adapter_implementation_version,
            access_contract: attempt.access_contract,
            outcome: attempt.outcome,
            failure_category: attempt.failure_category,
            failure_message,
            effect_boundary: attempt.effect_boundary,
        }
    }
}

fn model_failure_message(category: &str) -> String {
    match category {
        "model_unavailable" | "model_not_found" | "model_denied" => {
            "The selected model is no longer available. Choose another model and send again."
        }
        "provider_disconnected" | "provider_authentication" | "authentication" => {
            "The selected provider is not connected. Reconnect it or choose another model."
        }
        "provider_rate_limit" | "rate_limit" => {
            "The selected provider is rate limited. Choose another model or try again later."
        }
        "provider_timeout" | "provider_transport" | "transport" | "provider_5xx" => {
            "The selected provider could not complete this turn. Choose an available model and send again."
        }
        _ => "This attempt failed. Review the attempt details before trying again.",
    }
    .into()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectResponse {
    id: i64,
    name: String,
    path: String,
    created_at: String,
    updated_at: String,
}

impl From<Project> for ProjectResponse {
    fn from(project: Project) -> Self {
        Self {
            id: project.id.value(),
            name: project.name,
            path: project.path,
            created_at: project.created_at,
            updated_at: project.updated_at,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ThreadResponse {
    id: i64,
    title: String,
    project_id: Option<i64>,
    root_interaction_id: i64,
    harness_configuration_name: String,
    harness_id: String,
    permission_profile_id: String,
    created_at: String,
    updated_at: String,
}

impl From<Thread> for ThreadResponse {
    fn from(thread: Thread) -> Self {
        Self {
            id: thread.id.value(),
            title: thread.title,
            project_id: thread.project_id.map(|id| id.value()),
            root_interaction_id: thread.root_interaction_id.value(),
            harness_id: thread.harness_configuration_name.clone(),
            harness_configuration_name: thread.harness_configuration_name,
            permission_profile_id: thread.permission_profile_id,
            created_at: thread.created_at,
            updated_at: thread.updated_at,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InteractionResponse {
    id: i64,
    thread_id: i64,
    sequence: i64,
    text: String,
    created_at: String,
    graph_node_id: Option<i64>,
    completion_status: String,
    harness_configuration_name: Option<String>,
    harness_configuration_digest: Option<String>,
    permission_profile_id: String,
    model_selection: Option<InteractionModelSelection>,
    effective_execution_digest: Option<String>,
    effective_permission_receipt: Option<serde_json::Value>,
    completion_output: Option<serde_json::Value>,
    completion_error: Option<String>,
    latest_attempt: Option<InteractionAttemptResponse>,
}

impl From<Interaction> for InteractionResponse {
    fn from(interaction: Interaction) -> Self {
        Self {
            id: interaction.id.value(),
            thread_id: interaction.thread_id.value(),
            sequence: interaction.sequence,
            text: interaction.text,
            created_at: interaction.created_at,
            graph_node_id: interaction.graph_node_id,
            completion_status: interaction.completion_status,
            harness_configuration_name: interaction.harness_configuration_name,
            harness_configuration_digest: interaction.harness_configuration_digest,
            permission_profile_id: interaction.permission_profile_id,
            model_selection: interaction.model_selection,
            effective_execution_digest: interaction.effective_execution_digest,
            effective_permission_receipt: interaction.effective_permission_receipt,
            completion_output: interaction.completion_output,
            completion_error: interaction.completion_error,
            latest_attempt: interaction.latest_attempt.map(Into::into),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActionInvocationResponse {
    pub(super) source_interaction_id: i64,
    pub(super) action_id: i64,
    pub(super) result_interaction_id: i64,
    pub(super) created_at: String,
}

impl From<ActionInvocation> for ActionInvocationResponse {
    fn from(invocation: ActionInvocation) -> Self {
        Self {
            source_interaction_id: invocation.source_interaction_id.value(),
            action_id: invocation.action_id,
            result_interaction_id: invocation.result_interaction_id.value(),
            created_at: invocation.created_at,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CapabilitiesResponse {
    projects: bool,
    threads: bool,
    interactions: bool,
    graph: bool,
    harness: bool,
    credentials: bool,
}

impl From<ProductCapabilities> for CapabilitiesResponse {
    fn from(capabilities: ProductCapabilities) -> Self {
        Self {
            projects: capabilities.projects,
            threads: capabilities.threads,
            interactions: capabilities.interactions,
            graph: capabilities.graph,
            harness: capabilities.harness,
            credentials: capabilities.credentials,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ThreadViewResponse {
    #[serde(flatten)]
    thread: ThreadResponse,
    active: bool,
}

impl From<ThreadView> for ThreadViewResponse {
    fn from(view: ThreadView) -> Self {
        Self {
            thread: view.thread.into(),
            active: view.active,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProductStateResponse {
    projects: Vec<ProjectResponse>,
    threads: Vec<ThreadViewResponse>,
    interactions: Vec<InteractionResponse>,
    action_invocations: Vec<ActionInvocationResponse>,
    capabilities: CapabilitiesResponse,
}

impl From<ProductState> for ProductStateResponse {
    fn from(state: ProductState) -> Self {
        Self {
            projects: state.projects.into_iter().map(Into::into).collect(),
            threads: state.threads.into_iter().map(Into::into).collect(),
            interactions: state.interactions.into_iter().map(Into::into).collect(),
            action_invocations: state
                .action_invocations
                .into_iter()
                .map(Into::into)
                .collect(),
            capabilities: state.capabilities.into(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ThreadDetailResponse {
    thread: ThreadResponse,
    interactions: Vec<InteractionResponse>,
    action_invocations: Vec<ActionInvocationResponse>,
}

impl From<ThreadDetail> for ThreadDetailResponse {
    fn from(detail: ThreadDetail) -> Self {
        Self {
            thread: detail.thread.into(),
            interactions: detail.interactions.into_iter().map(Into::into).collect(),
            action_invocations: detail
                .action_invocations
                .into_iter()
                .map(Into::into)
                .collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::product::{InteractionAttempt, InteractionId, ModelFamilyId, ProviderId, ThreadId};
    use serde_json::json;

    #[test]
    fn recoverable_attempt_serializes_with_the_real_not_started_contract() {
        let interaction = Interaction {
            id: InteractionId::from_database(9),
            thread_id: ThreadId::from_database(4),
            sequence: 2,
            text: "Review this repository".into(),
            graph_node_id: None,
            completion_status: "not_started".into(),
            harness_configuration_name: Some("codex-basic".into()),
            harness_configuration_digest: None,
            permission_profile_id: "auto".into(),
            model_selection: Some(InteractionModelSelection {
                family_id: ModelFamilyId::from_database(12),
                provider_id: ProviderId::from_database("openai-work".into()),
                model_id: "gpt-5.2".into(),
            }),
            effective_execution_digest: None,
            effective_permission_receipt: None,
            completion_output: None,
            completion_error: None,
            latest_attempt: Some(InteractionAttempt {
                id: 44,
                attempt_number: 1,
                started_at: "10".into(),
                finished_at: Some("11".into()),
                family_id: ModelFamilyId::from_database(12),
                family_revision: 3,
                harness_configuration_name: "codex-basic".into(),
                harness_configuration_revision: 5,
                harness_configuration_digest: "sha256:harness".into(),
                provider_id: ProviderId::from_database("openai-work".into()),
                adapter_id: "openai-api".into(),
                adapter_implementation_version: 1,
                model_id: "gpt-5.2".into(),
                access_contract: "secret@1".into(),
                outcome: "model_failed".into(),
                failure_category: Some("provider_rate_limit".into()),
                effect_boundary: "none".into(),
            }),
            created_at: "1".into(),
        };

        let value = serde_json::to_value(InteractionResponse::from(interaction)).unwrap();
        assert_eq!(value["completionStatus"], "not_started");
        assert_eq!(value["latestAttempt"]["id"], 44);
        assert_eq!(value["latestAttempt"]["outcome"], "model_failed");
        assert_eq!(value["latestAttempt"]["effectBoundary"], "none");
        assert_eq!(
            value["latestAttempt"]["modelSelection"],
            json!({
                "familyId": 12,
                "providerId": "openai-work",
                "modelId": "gpt-5.2"
            })
        );
        assert!(
            value["latestAttempt"]["failureMessage"]
                .as_str()
                .unwrap()
                .contains("rate limited")
        );
    }
}
