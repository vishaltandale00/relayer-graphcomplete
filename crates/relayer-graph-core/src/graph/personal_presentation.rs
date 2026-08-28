use serde::{Deserialize, Serialize};

use crate::storage::sqlite::personal_presentation::{
    AttachPersonalPresentationResult, PublishPersonalPresentationResult,
};
use crate::{AcceptedGraphClosure, GraphDatabase, GraphError, LayerId, NodeId, ThreadId};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonalPresentationAttachment {
    pub interaction_node_id: NodeId,
    pub version_interaction_node_id: NodeId,
    pub root_layer_id: LayerId,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedPersonalPresentationVersion {
    pub profile_thread_id: ThreadId,
    pub version_interaction_node_id: NodeId,
    pub root_layer_id: LayerId,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedPersonalPresentation {
    pub attachment: PersonalPresentationAttachment,
    pub graph: AcceptedGraphClosure,
}

impl GraphDatabase {
    pub async fn publish_personal_presentation_version(
        &self,
        profile_thread_id: ThreadId,
        version_interaction_node_id: NodeId,
    ) -> Result<PublishedPersonalPresentationVersion, GraphError> {
        let root_layer_id = match self
            .storage
            .publish_personal_presentation_version(profile_thread_id, version_interaction_node_id)
            .await?
        {
            PublishPersonalPresentationResult::Published(root) => root,
            PublishPersonalPresentationResult::InvalidCompletion => {
                return Err(GraphError::validation(
                    "invalid_personal_presentation_version",
                    "versionInteractionNodeId",
                    "A personal presentation version must identify an accepted completion root in its profile scope.",
                ));
            }
            PublishPersonalPresentationResult::Immutable => {
                return Err(GraphError::validation(
                    "personal_presentation_version_immutable",
                    "versionInteractionNodeId",
                    "A published personal presentation version cannot change identity or scope.",
                ));
            }
            PublishPersonalPresentationResult::Retired => {
                return Err(GraphError::validation(
                    "personal_presentation_version_retired",
                    "versionInteractionNodeId",
                    "This personal presentation version is retired.",
                ));
            }
        };
        Ok(PublishedPersonalPresentationVersion {
            profile_thread_id,
            version_interaction_node_id,
            root_layer_id,
        })
    }

    pub async fn attach_personal_presentation(
        &self,
        interaction_node_id: NodeId,
        version_interaction_node_id: NodeId,
    ) -> Result<PersonalPresentationAttachment, GraphError> {
        let root_layer_id = match self
            .storage
            .attach_personal_presentation(interaction_node_id, version_interaction_node_id)
            .await?
        {
            AttachPersonalPresentationResult::Attached(root) => root,
            AttachPersonalPresentationResult::TargetNotFound => {
                return Err(GraphError::NotFound(format!(
                    "interaction node {interaction_node_id}"
                )));
            }
            AttachPersonalPresentationResult::VersionNotPublished => {
                return Err(GraphError::validation(
                    "invalid_personal_presentation_version",
                    "versionInteractionNodeId",
                    "A personal presentation version must be published before it can be attached.",
                ));
            }
            AttachPersonalPresentationResult::VersionRetired => {
                return Err(GraphError::validation(
                    "personal_presentation_version_retired",
                    "versionInteractionNodeId",
                    "This personal presentation version is retired.",
                ));
            }
            AttachPersonalPresentationResult::Conflict => {
                return Err(GraphError::validation(
                    "personal_presentation_already_attached",
                    "versionInteractionNodeId",
                    "This interaction already pins another personal presentation version.",
                ));
            }
        };
        Ok(PersonalPresentationAttachment {
            interaction_node_id,
            version_interaction_node_id,
            root_layer_id,
        })
    }

    pub async fn personal_presentation_attachment(
        &self,
        interaction_node_id: NodeId,
    ) -> Result<Option<ResolvedPersonalPresentation>, GraphError> {
        let Some((version_interaction_node_id, root_layer_id)) = self
            .storage
            .personal_presentation_attachment(interaction_node_id)
            .await?
        else {
            return Ok(None);
        };
        let graph = self
            .accepted_graph_closure(version_interaction_node_id)
            .await?
            .ok_or_else(|| {
                GraphError::Internal("attached personal presentation graph is missing".into())
            })?;
        if graph.root_layer_id != root_layer_id {
            return Err(GraphError::Internal(
                "attached personal presentation root no longer matches its immutable version"
                    .into(),
            ));
        }
        Ok(Some(ResolvedPersonalPresentation {
            attachment: PersonalPresentationAttachment {
                interaction_node_id,
                version_interaction_node_id,
                root_layer_id,
            },
            graph,
        }))
    }
}
