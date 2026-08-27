use crate::approval::ApprovalReceipt;
use crate::product::{
    ActionInvocation, Interaction, InteractionModelSelection, ProductCapabilities, ProductState,
    Project, Thread, ThreadDetail, ThreadView,
};
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InteractionContextResponse {
    id: relayer_graph_core::ActionId,
    #[serde(rename = "type")]
    type_id: String,
    target: crate::product::InteractionContextTarget,
    target_node: relayer_graph_core::InteractionInputNode,
    annotations: Vec<String>,
}

fn project_interaction_contexts(
    intents: Vec<crate::product::InteractionContextIntent>,
    contexts: Vec<relayer_graph_core::InteractionContext>,
    actions: Vec<relayer_graph_core::InteractionContextAction>,
) -> Result<Vec<InteractionContextResponse>, &'static str> {
    if intents.len() != contexts.len()
        || contexts.len() != actions.len()
        || intents
            .iter()
            .zip(&contexts)
            .zip(&actions)
            .any(|((intent, context), action)| {
                intent.target.node_id != context.target_node.id.value()
                    || intent.target.node_id != action.target.node_id.value()
                    || intent.target.source_interaction_node_id
                        != action.target.source_interaction_node_id.value()
                    || intent.target.source_layer_id != action.target.source_layer_id.value()
                    || intent.annotations != context.annotations
                    || intent.annotations != action.annotations
            })
    {
        return Err("product and graph interaction contexts diverged");
    }
    Ok(intents
        .into_iter()
        .zip(contexts)
        .zip(actions)
        .map(|((intent, context), action)| InteractionContextResponse {
            id: action.id,
            type_id: action.type_id,
            target: intent.target,
            target_node: context.target_node,
            annotations: context.annotations,
        })
        .collect())
}

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
    attempt_admission_id: Option<String>,
    admitted_plan: Option<crate::product::AdmittedExecutionModelPlan>,
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
            attempt_admission_id: attempt.attempt_admission_id,
            admitted_plan: attempt.admitted_plan,
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
    imported: bool,
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
            imported: thread.imported,
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
    projection_fresh: bool,
    contexts: Vec<InteractionContextResponse>,
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
            projection_fresh: true,
            contexts: Vec::new(),
        }
    }
}

impl InteractionResponse {
    pub(crate) fn mark_projection_stale(&mut self) {
        self.projection_fresh = false;
    }

    pub(crate) fn set_contexts(
        &mut self,
        intents: Vec<crate::product::InteractionContextIntent>,
        contexts: Vec<relayer_graph_core::InteractionContext>,
        actions: Vec<relayer_graph_core::InteractionContextAction>,
    ) -> Result<(), &'static str> {
        self.contexts = project_interaction_contexts(intents, contexts, actions)?;
        Ok(())
    }

    pub(crate) fn set_imported_contexts(
        &mut self,
        actions: Vec<relayer_graph_core::InteractionContextAction>,
        contexts: Vec<relayer_graph_core::InteractionContext>,
    ) -> Result<(), &'static str> {
        let intents = actions
            .iter()
            .map(|action| crate::product::InteractionContextIntent {
                target: crate::product::InteractionContextTarget {
                    node_id: action.target.node_id.value(),
                    source_interaction_node_id: action.target.source_interaction_node_id.value(),
                    source_layer_id: action.target.source_layer_id.value(),
                },
                annotations: action.annotations.clone(),
            })
            .collect();
        self.contexts = project_interaction_contexts(intents, contexts, actions)?;
        Ok(())
    }
}

#[cfg(test)]
mod attempt_response_tests {
    use super::*;
    use crate::product::{InteractionContextIntent, InteractionContextTarget};
    use serde_json::json;

    fn action(annotations: Vec<&str>) -> relayer_graph_core::InteractionContextAction {
        serde_json::from_value(json!({
            "id":11,"type":"interaction.context","sourceNodeId":9,
            "target":{"nodeId":7,"sourceInteractionNodeId":3,"sourceLayerId":5},
            "annotations":annotations,"state":"accepted"
        }))
        .unwrap()
    }

    #[test]
    fn context_projection_preserves_node_content_order_and_hidden_occurrence_identity() {
        let intents = vec![InteractionContextIntent {
            target: InteractionContextTarget {
                node_id: 7,
                source_interaction_node_id: 3,
                source_layer_id: 5,
            },
            annotations: vec!["first".into(), "second".into()],
        }];
        let contexts = vec![
            serde_json::from_value(json!({
                "type":"interaction.context",
                "targetNode":{
                    "id":7,"kind":"concept","icon":"circle","title":"Target",
                    "detail":"Immutable detail","state":"accepted"
                },
                "annotations":["first","second"]
            }))
            .unwrap(),
        ];
        let projected =
            project_interaction_contexts(intents, contexts, vec![action(vec!["first", "second"])])
                .unwrap();
        assert_eq!(
            serde_json::to_value(projected).unwrap(),
            json!([{
                "id":11,"type":"interaction.context",
                "target":{"nodeId":7,"sourceInteractionNodeId":3,"sourceLayerId":5},
                "targetNode":{
                    "id":7,"kind":"concept","icon":"circle","title":"Target",
                    "detail":"Immutable detail","state":"accepted"
                },
                "annotations":["first","second"]
            }])
        );
    }

    #[test]
    fn context_projection_rejects_product_graph_drift() {
        let intents = vec![InteractionContextIntent {
            target: InteractionContextTarget {
                node_id: 7,
                source_interaction_node_id: 3,
                source_layer_id: 5,
            },
            annotations: vec!["product".into()],
        }];
        let contexts = vec![
            serde_json::from_value(json!({
                "type":"interaction.context",
                "targetNode":{
                    "id":7,"kind":"concept","icon":"circle","title":"Target",
                    "detail":"Immutable detail","state":"accepted"
                },
                "annotations":["graph"]
            }))
            .unwrap(),
        ];
        assert_eq!(
            project_interaction_contexts(intents, contexts, vec![action(vec!["graph"])])
                .unwrap_err(),
            "product and graph interaction contexts diverged"
        );
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActionInvocationResponse {
    pub(super) source_interaction_id: i64,
    pub(super) action_id: i64,
    pub(super) result_interaction_id: i64,
    pub(super) result_completion_status: String,
    pub(super) created_at: String,
}

impl From<ActionInvocation> for ActionInvocationResponse {
    fn from(invocation: ActionInvocation) -> Self {
        Self {
            source_interaction_id: invocation.source_interaction_id.value(),
            action_id: invocation.action_id,
            result_interaction_id: invocation.result_interaction_id.value(),
            result_completion_status: invocation.result_completion_status,
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
    annotations: bool,
}

impl CapabilitiesResponse {
    pub(crate) fn with_annotations(mut self, annotations: bool) -> Self {
        self.annotations = annotations;
        self
    }
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
            annotations: false,
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
    approvals: Vec<ApprovalReceipt>,
    capabilities: CapabilitiesResponse,
}

impl ProductStateResponse {
    pub(crate) fn with_interactions(mut self, interactions: Vec<InteractionResponse>) -> Self {
        self.interactions = interactions;
        self
    }

    pub(crate) fn with_annotations(mut self, annotations: bool) -> Self {
        self.capabilities.annotations = annotations;
        self
    }
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
            approvals: state.approvals,
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
    approvals: Vec<ApprovalReceipt>,
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
            approvals: detail.approvals,
        }
    }
}

impl ThreadDetailResponse {
    pub(crate) fn with_interactions(mut self, interactions: Vec<InteractionResponse>) -> Self {
        self.interactions = interactions;
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::product::{
        AdmittedExecutionModelPlan, AdmittedExecutionModelRoute, InteractionAttempt, InteractionId,
        ModelFamilyId, ProviderId, ThreadId,
    };
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
                attempt_admission_id: Some("admission-44".into()),
                admitted_plan: Some(AdmittedExecutionModelPlan {
                    family_id: ModelFamilyId::from_database(12),
                    family_revision: 3,
                    orchestrator: AdmittedExecutionModelRoute {
                        provider_id: ProviderId::from_database("openai-work".into()),
                        adapter_id: "openai-api".into(),
                        access_contract: "secret@1".into(),
                        model_id: "gpt-5.2".into(),
                        adapter_implementation_version: "1".into(),
                    },
                    roster: vec![],
                    harness_policy_digest: "sha256:policy".into(),
                    digest: "sha256:plan".into(),
                }),
            }),
            created_at: "1".into(),
        };

        let value = serde_json::to_value(InteractionResponse::from(interaction)).unwrap();
        assert_eq!(value["completionStatus"], "not_started");
        assert_eq!(value["latestAttempt"]["id"], 44);
        assert_eq!(value["latestAttempt"]["outcome"], "model_failed");
        assert_eq!(value["latestAttempt"]["effectBoundary"], "none");
        assert_eq!(value["latestAttempt"]["attemptAdmissionId"], "admission-44");
        assert_eq!(
            value["latestAttempt"]["admittedPlan"]["orchestrator"]["accessContract"],
            "secret@1"
        );
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
