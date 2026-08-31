use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    InputAction, InputOption, InteractionContextDraft, InteractionInputChildId, NodeId,
    PresentingInputOccurrence,
};

#[derive(Debug, Clone, Copy)]
pub struct InteractionInputPreparation<'a> {
    pub attempt_key: &'a str,
    pub authority_digest: &'a str,
    pub contexts: &'a [InteractionContextDraft],
    pub submitted_inputs: &'a [SubmittedInputDraft],
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", untagged, deny_unknown_fields)]
pub enum SubmittedInputValue {
    Text { text: String },
    Selected { selected: Vec<InputOption> },
}

impl SubmittedInputValue {
    pub(crate) fn canonicalized(&self) -> Self {
        match self {
            Self::Text { text } => Self::Text { text: text.clone() },
            Self::Selected { selected } => {
                let mut selected = selected.clone();
                selected.sort_by(|left, right| left.key.as_bytes().cmp(right.key.as_bytes()));
                Self::Selected { selected }
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubmittedInputDraft {
    #[serde(flatten)]
    pub occurrence: PresentingInputOccurrence,
    pub action: InputAction,
    pub value: SubmittedInputValue,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubmittedInput {
    pub action: InputAction,
    pub value: SubmittedInputValue,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractionInputChild {
    pub id: InteractionInputChildId,
    pub parent_interaction_node_id: NodeId,
    pub occurrence: PresentingInputOccurrence,
    pub source_node_id: NodeId,
    pub action: InputAction,
    pub value: SubmittedInputValue,
    pub attempt_key: String,
    pub authority_digest: String,
    pub semantic_digest: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthorityDigestInput<'a> {
    schema_version: u32,
    text: &'a str,
    attachments: Vec<SubmittedInputDraft>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SemanticDigestInput<'a> {
    schema_version: u32,
    text: &'a str,
    submitted_inputs: Vec<SubmittedInput>,
}

pub fn interaction_input_authority_digest(
    text: &str,
    attachments: &[SubmittedInputDraft],
) -> Result<String, serde_json::Error> {
    let mut attachments = attachments
        .iter()
        .cloned()
        .map(|mut attachment| {
            attachment.value = attachment.value.canonicalized();
            attachment
        })
        .collect::<Vec<_>>();
    attachments.sort_by_key(|attachment| attachment.occurrence.clone());
    let bytes = canonical_json(&AuthorityDigestInput {
        schema_version: 1,
        text,
        attachments,
    })?;
    Ok(format!(
        "sha256:interaction-input-authority:v1:{:x}",
        Sha256::digest(bytes)
    ))
}

pub fn interaction_input_semantic_digest(
    text: &str,
    attachments: &[SubmittedInputDraft],
) -> Result<String, serde_json::Error> {
    let mut submitted_inputs = attachments
        .iter()
        .map(|attachment| SubmittedInput {
            action: attachment.action.clone(),
            value: attachment.value.canonicalized(),
        })
        .collect::<Vec<_>>();
    submitted_inputs.sort_by(|left, right| {
        canonical_json(left)
            .expect("semantic input is serializable")
            .cmp(&canonical_json(right).expect("semantic input is serializable"))
    });
    let bytes = canonical_json(&SemanticDigestInput {
        schema_version: 1,
        text,
        submitted_inputs,
    })?;
    Ok(format!(
        "sha256:interaction-input-semantic:v1:{:x}",
        Sha256::digest(bytes)
    ))
}

fn canonical_json(value: &impl Serialize) -> Result<Vec<u8>, serde_json::Error> {
    // These schemas contain only maps, arrays, positive integers, booleans, and strings.
    // serde_json's default sorted map representation is RFC 8785-equivalent for that subset.
    serde_json::to_vec(&serde_json::to_value(value)?)
}

pub(crate) fn canonical_submitted_input_bytes(
    value: &SubmittedInput,
) -> Result<Vec<u8>, serde_json::Error> {
    canonical_json(value)
}
