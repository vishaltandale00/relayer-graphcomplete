use super::{InteractionId, ProjectId, ThreadId};

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
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Interaction {
    pub(crate) id: InteractionId,
    pub(crate) thread_id: ThreadId,
    pub(crate) sequence: i64,
    pub(crate) text: String,
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
    pub(crate) capabilities: ProductCapabilities,
}

pub(crate) struct ThreadView {
    pub(crate) thread: Thread,
    pub(crate) active: bool,
}
