use crate::{
    ActionId, GraphError, InputAction, InteractionPermission, NodeId, SubmittedInputValue,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Agent-visible semantic record. Only trusted preparation constructs and stores it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompletionContract {
    pub schema_version: u32,
    pub interaction_node_id: NodeId,
    pub input: CompletionContractInput,
    pub authorities: Vec<InteractionPermission>,
    pub return_requirements: Vec<CompletionReturnRequirement>,
    pub digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompletionContractInput {
    pub text: String,
    pub context: Vec<CompletionContractContext>,
    pub answers: Vec<CompletionContractAnswer>,
    pub invocation_references: Vec<CompletionInvocationReference>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompletionInvocationReference {
    pub invocation_id: i64,
    pub source_completion_id: NodeId,
    pub source_action_id: ActionId,
    pub parent_node_id: NodeId,
    pub action_snapshot: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompletionContractContext {
    pub node_id: NodeId,
    pub annotations: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompletionContractAnswer {
    pub source_node_id: NodeId,
    pub source_action_id: ActionId,
    pub question: InputAction,
    pub value: SubmittedInputValue,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum CompletionReturnRequirement {
    #[serde(rename = "navigate.response")]
    NavigateResponse {
        #[serde(rename = "nodeId")]
        node_id: NodeId,
    },
}

impl CompletionContract {
    pub(crate) fn seal(mut self) -> Result<Self, GraphError> {
        self.digest = self.computed_digest()?;
        Ok(self)
    }

    pub fn computed_digest(&self) -> Result<String, GraphError> {
        let mut value =
            serde_json::to_value(self).map_err(|e| GraphError::Internal(e.to_string()))?;
        value
            .as_object_mut()
            .expect("contract object")
            .remove("digest");
        let bytes = serde_json::to_vec(&value).map_err(|e| GraphError::Internal(e.to_string()))?;
        Ok(format!("sha256:v1:{:x}", Sha256::digest(bytes)))
    }

    pub fn validate(&self) -> Result<(), GraphError> {
        if self.schema_version != 1 || self.computed_digest()? != self.digest {
            return Err(GraphError::Forbidden(
                "Missing, incompatible, or mismatched CompletionContract.".into(),
            ));
        }
        for requirement in &self.return_requirements {
            let CompletionReturnRequirement::NavigateResponse { node_id } = requirement;
            if !self
                .authorities
                .contains(&InteractionPermission::NavigateAdd { node_id: *node_id })
            {
                return Err(GraphError::Forbidden(
                    "CompletionContract requirement lacks authority.".into(),
                ));
            }
        }
        Ok(())
    }
}
