use super::{
    ExecutionModelSelection, InteractionId, InteractionModelSelection, ProjectId, ThreadId,
};
use crate::approval::ApprovalReceipt;
use serde_json::Value;

pub(crate) struct BeginInteractionAttempt<'a> {
    pub(crate) interaction_id: InteractionId,
    pub(crate) attempt_admission_id: String,
    pub(crate) harness_name: &'a str,
    pub(crate) route: &'a ExecutionModelSelection,
    pub(crate) model_plan: super::ExecutionModelPlan,
    pub(crate) admitted_plan: super::AdmittedExecutionModelPlan,
    pub(crate) adapter_version: u32,
    pub(crate) expected_harness_policy: Option<&'a super::ExecutionHarnessPolicy>,
    pub(crate) execution_lease_id: &'a str,
}

pub(crate) struct PreExecutionModelFailure<'a> {
    pub(crate) interaction_id: InteractionId,
    pub(crate) harness_name: &'a str,
    pub(crate) selection: &'a InteractionModelSelection,
    pub(crate) route: Option<&'a ExecutionModelSelection>,
    pub(crate) policy: Option<&'a super::ExecutionHarnessPolicy>,
    pub(crate) adapter_version: Option<u32>,
    pub(crate) failure_category: &'a str,
    pub(crate) error: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ExecutionLeaseDebt {
    pub(crate) attempt_id: i64,
    pub(crate) thread_id: ThreadId,
    pub(crate) execution_lease_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Project {
    pub(crate) id: ProjectId,
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Thread {
    pub(crate) id: ThreadId,
    pub(crate) title: String,
    pub(crate) project_id: Option<ProjectId>,
    pub(crate) root_interaction_id: InteractionId,
    pub(crate) harness_configuration_name: String,
    pub(crate) permission_profile_id: String,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    pub(crate) imported: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct InteractionAttempt {
    pub(crate) id: i64,
    pub(crate) attempt_number: i64,
    pub(crate) started_at: String,
    pub(crate) finished_at: Option<String>,
    pub(crate) family_id: super::ModelFamilyId,
    pub(crate) family_revision: i64,
    pub(crate) harness_configuration_name: String,
    pub(crate) harness_configuration_revision: i64,
    pub(crate) harness_configuration_digest: String,
    pub(crate) provider_id: super::ProviderId,
    pub(crate) adapter_id: String,
    pub(crate) adapter_implementation_version: i64,
    pub(crate) model_id: String,
    pub(crate) access_contract: String,
    pub(crate) outcome: String,
    pub(crate) failure_category: Option<String>,
    pub(crate) effect_boundary: String,
    pub(crate) attempt_admission_id: Option<String>,
    pub(crate) admitted_plan: Option<super::AdmittedExecutionModelPlan>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Interaction {
    pub(crate) id: InteractionId,
    pub(crate) thread_id: ThreadId,
    pub(crate) sequence: i64,
    pub(crate) text: String,
    pub(crate) graph_node_id: Option<i64>,
    pub(crate) completion_status: String,
    pub(crate) harness_configuration_name: Option<String>,
    pub(crate) harness_configuration_digest: Option<String>,
    pub(crate) permission_profile_id: String,
    pub(crate) model_selection: Option<InteractionModelSelection>,
    pub(crate) effective_execution_digest: Option<String>,
    pub(crate) effective_permission_receipt: Option<Value>,
    pub(crate) completion_output: Option<Value>,
    pub(crate) completion_error: Option<String>,
    pub(crate) latest_attempt: Option<InteractionAttempt>,
    pub(crate) created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InteractionContextTarget {
    pub(crate) node_id: i64,
    pub(crate) source_interaction_node_id: i64,
    pub(crate) source_layer_id: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InteractionContextIntent {
    pub(crate) target: InteractionContextTarget,
    #[serde(default)]
    pub(crate) annotations: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DurableInteractionInput {
    pub(crate) input_identity: String,
    pub(crate) input_digest: String,
    pub(crate) contexts: Vec<InteractionContextIntent>,
    pub(crate) submitted_inputs: Vec<relayer_graph_core::SubmittedInputDraft>,
    pub(crate) submitted_input_draft_revision: Option<i64>,
    pub(crate) semantic_digest: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SubmittedInputEvidence {
    pub(crate) occurrence: relayer_graph_core::PresentingInputOccurrence,
    pub(crate) source_node_id: i64,
    pub(crate) action: relayer_graph_core::InputAction,
    pub(crate) value: relayer_graph_core::SubmittedInputValue,
    pub(crate) attempt_state: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NodeContextDraft {
    pub(crate) id: String,
    pub(crate) thread_id: ThreadId,
    pub(crate) target: InteractionContextTarget,
    pub(crate) target_node: relayer_graph_core::InteractionInputNode,
    pub(crate) text: String,
    pub(crate) revision: i64,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NodeContextDraftConfirmation {
    pub(crate) draft_id: String,
    pub(crate) thread_id: ThreadId,
    pub(crate) target: InteractionContextTarget,
    pub(crate) target_node: relayer_graph_core::InteractionInputNode,
    pub(crate) annotation: String,
    pub(crate) draft_revision: i64,
    pub(crate) confirmation_revision: i64,
    pub(crate) confirmed_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", untagged, deny_unknown_fields)]
pub(crate) enum ActionInputValue {
    Text {
        text: String,
    },
    Selected {
        #[serde(rename = "selectedKeys")]
        selected_keys: Vec<String>,
    },
}

#[cfg(test)]
mod action_input_value_tests {
    use super::ActionInputValue;

    #[test]
    fn selected_input_value_uses_the_camel_case_api_contract() {
        let value: ActionInputValue = serde_json::from_value(serde_json::json!({
            "selectedKeys": ["logs", "traces"]
        }))
        .expect("camelCase selection payload should deserialize");
        assert_eq!(
            value,
            ActionInputValue::Selected {
                selected_keys: vec!["logs".into(), "traces".into()]
            }
        );
        assert_eq!(
            serde_json::to_value(value).expect("selection payload should serialize"),
            serde_json::json!({ "selectedKeys": ["logs", "traces"] })
        );
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ActionInputAttachment {
    pub(crate) thread_id: ThreadId,
    pub(crate) occurrence: relayer_graph_core::PresentingInputOccurrence,
    pub(crate) source_node_id: i64,
    pub(crate) action: relayer_graph_core::InputAction,
    pub(crate) value: ActionInputValue,
    pub(crate) draft_revision: i64,
    pub(crate) committed_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ActionInputDraft {
    pub(crate) thread_id: ThreadId,
    pub(crate) revision: i64,
    pub(crate) attachments: Vec<ActionInputAttachment>,
    pub(crate) updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ActionInvocation {
    pub(crate) source_interaction_id: InteractionId,
    pub(crate) action_id: i64,
    pub(crate) result_interaction_id: InteractionId,
    pub(crate) result_completion_status: String,
    pub(crate) created_at: String,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct ProductCapabilities {
    pub(crate) projects: bool,
    pub(crate) threads: bool,
    pub(crate) interactions: bool,
    pub(crate) graph: bool,
    pub(crate) harness: bool,
    pub(crate) credentials: bool,
}

impl Default for ProductCapabilities {
    fn default() -> Self {
        Self {
            projects: true,
            threads: true,
            interactions: true,
            graph: false,
            harness: false,
            credentials: false,
        }
    }
}

pub(crate) struct ProductState {
    pub(crate) projects: Vec<Project>,
    pub(crate) threads: Vec<ThreadView>,
    pub(crate) interactions: Vec<Interaction>,
    pub(crate) action_invocations: Vec<ActionInvocation>,
    pub(crate) approvals: Vec<ApprovalReceipt>,
    pub(crate) capabilities: ProductCapabilities,
}

pub(crate) struct ThreadView {
    pub(crate) thread: Thread,
    pub(crate) active: bool,
}
