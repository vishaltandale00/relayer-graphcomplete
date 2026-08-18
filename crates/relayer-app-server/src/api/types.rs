use crate::product::{
    Interaction, ProductCapabilities, ProductState, Project, Thread, ThreadDetail, ThreadView,
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
            harness_configuration_name: thread.harness_configuration_name,
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
    completion_output: Option<serde_json::Value>,
    completion_error: Option<String>,
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
            completion_output: interaction.completion_output,
            completion_error: interaction.completion_error,
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
    capabilities: CapabilitiesResponse,
}

impl From<ProductState> for ProductStateResponse {
    fn from(state: ProductState) -> Self {
        Self {
            projects: state.projects.into_iter().map(Into::into).collect(),
            threads: state.threads.into_iter().map(Into::into).collect(),
            interactions: state.interactions.into_iter().map(Into::into).collect(),
            capabilities: state.capabilities.into(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ThreadDetailResponse {
    thread: ThreadResponse,
    interactions: Vec<InteractionResponse>,
}

impl From<ThreadDetail> for ThreadDetailResponse {
    fn from(detail: ThreadDetail) -> Self {
        Self {
            thread: detail.thread.into(),
            interactions: detail.interactions.into_iter().map(Into::into).collect(),
        }
    }
}
