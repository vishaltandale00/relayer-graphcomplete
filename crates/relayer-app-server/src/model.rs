use serde::{Deserialize, Serialize};

macro_rules! product_id {
    ($name:ident) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub i64);

        impl std::fmt::Display for $name {
            fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                self.0.fmt(formatter)
            }
        }
    };
}

product_id!(ProjectId);
product_id!(ThreadId);
product_id!(InteractionId);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: ProjectId,
    pub name: String,
    pub path: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub id: ThreadId,
    pub title: String,
    pub project_id: Option<ProjectId>,
    pub root_interaction_id: InteractionId,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Interaction {
    pub id: InteractionId,
    pub thread_id: ThreadId,
    pub sequence: i64,
    pub text: String,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProject {
    pub path: String,
    pub name: Option<String>,
    #[serde(default)]
    pub reuse_existing: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateThread {
    pub title: Option<String>,
    pub project_id: Option<ProjectId>,
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
    pub interactions: Vec<Interaction>,
    pub capabilities: ProductCapabilities,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadView {
    #[serde(flatten)]
    pub thread: Thread,
    pub active: bool,
}
