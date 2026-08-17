use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub id: String,
    pub title: String,
    pub project_id: Option<String>,
    pub root_interaction_id: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Interaction {
    pub id: String,
    pub thread_id: String,
    pub sequence: i64,
    pub text: String,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProject {
    pub path: String,
    pub name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateThread {
    pub title: Option<String>,
    pub project_id: Option<String>,
    pub initial_message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateInteraction {
    pub text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductCapabilities {
    pub projects: bool,
    pub threads: bool,
    pub interactions: bool,
    pub graph: bool,
    pub harness: bool,
    pub credentials: bool,
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductState {
    pub projects: Vec<Project>,
    pub threads: Vec<ThreadView>,
    pub nodes: Vec<InteractionNode>,
    pub edges: Vec<serde_json::Value>,
    pub status: &'static str,
    pub capabilities: ProductCapabilities,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadView {
    #[serde(flatten)]
    pub thread: Thread,
    pub root_node_id: String,
    pub active: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractionNode {
    pub id: String,
    pub kind: &'static str,
    pub title: String,
    pub summary: String,
}
