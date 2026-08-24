use crate::approval::ApprovalReceipt;
use crate::product::{
    ActionInvocation, Interaction, InteractionModelSelection, ProductCapabilities, ProductState,
    Project, Thread, ThreadDetail, ThreadView,
};
use serde::Serialize;

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
    projection_fresh: bool,
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
            projection_fresh: true,
        }
    }
}

impl InteractionResponse {
    pub(crate) fn mark_projection_stale(&mut self) {
        self.projection_fresh = false;
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
    approvals: Vec<ApprovalReceipt>,
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
            approvals: state.approvals,
            capabilities: state.capabilities.into(),
        }
    }
}

impl ProductStateResponse {
    pub(crate) fn mark_stale_interactions(&mut self, stale: &std::collections::HashSet<i64>) {
        for interaction in &mut self.interactions {
            if stale.contains(&interaction.id) {
                interaction.mark_projection_stale();
            }
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
    pub(crate) fn mark_stale_interactions(&mut self, stale: &std::collections::HashSet<i64>) {
        for interaction in &mut self.interactions {
            if stale.contains(&interaction.id) {
                interaction.mark_projection_stale();
            }
        }
    }
}
