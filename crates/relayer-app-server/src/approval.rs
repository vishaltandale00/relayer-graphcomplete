use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ApprovalCorrelation {
    pub(crate) thread_id: i64,
    pub(crate) interaction_id: i64,
    pub(crate) complete_call_id: String,
    pub(crate) harness_session_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum ApprovalAction {
    Command {
        command: String,
        #[serde(rename = "workingDirectory")]
        working_directory: String,
    },
    FileChange {
        action: String,
        #[serde(rename = "workingDirectory")]
        working_directory: String,
        #[serde(rename = "affectedFiles")]
        affected_files: Vec<String>,
    },
    Network {
        action: String,
        #[serde(rename = "networkDestination")]
        network_destination: String,
        #[serde(rename = "workingDirectory", skip_serializing_if = "Option::is_none")]
        working_directory: Option<String>,
    },
    Other {
        action: String,
        #[serde(rename = "workingDirectory", skip_serializing_if = "Option::is_none")]
        working_directory: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ApprovalRequest {
    pub(crate) request_id: String,
    pub(crate) correlation: ApprovalCorrelation,
    pub(crate) title: String,
    pub(crate) reason: String,
    pub(crate) action: ApprovalAction,
    pub(crate) scope_keys: Vec<String>,
    pub(crate) scope_description: String,
    pub(crate) created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) expires_at: Option<String>,
}

impl ApprovalRequest {
    pub(crate) fn validate(&self) -> Result<(), String> {
        required(&self.request_id, "requestId")?;
        positive(self.correlation.thread_id, "correlation.threadId")?;
        positive(self.correlation.interaction_id, "correlation.interactionId")?;
        required(
            &self.correlation.complete_call_id,
            "correlation.completeCallId",
        )?;
        required(
            &self.correlation.harness_session_id,
            "correlation.harnessSessionId",
        )?;
        required(&self.title, "title")?;
        required(&self.reason, "reason")?;
        if self.scope_keys.is_empty() || self.scope_keys.iter().any(|key| key.trim().is_empty()) {
            return Err("scopeKeys must contain non-empty strings".into());
        }
        if self
            .scope_keys
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len()
            != self.scope_keys.len()
        {
            return Err("scopeKeys must not contain duplicates".into());
        }
        required(&self.scope_description, "scopeDescription")?;
        required(&self.created_at, "createdAt")?;
        if let Some(expires_at) = &self.expires_at {
            required(expires_at, "expiresAt")?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ApprovalOutcome {
    Approved,
    Denied,
    Cancelled,
    Expired,
    Aborted,
}

impl ApprovalOutcome {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Approved => "approved",
            Self::Denied => "denied",
            Self::Cancelled => "cancelled",
            Self::Expired => "expired",
            Self::Aborted => "aborted",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ApprovalActor {
    User,
    SessionGrant,
    Harness,
    Host,
}

impl ApprovalActor {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::SessionGrant => "session_grant",
            Self::Harness => "harness",
            Self::Host => "host",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ApprovalDecision {
    ApproveOnce,
    ApproveAlways,
    Deny,
}

impl ApprovalDecision {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::ApproveOnce => "approve_once",
            Self::ApproveAlways => "approve_always",
            Self::Deny => "deny",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ApprovalResolution {
    pub(crate) request_id: String,
    pub(crate) correlation: ApprovalCorrelation,
    pub(crate) outcome: ApprovalOutcome,
    pub(crate) actor: ApprovalActor,
    pub(crate) resolved_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) decision: Option<ApprovalDecision>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) rationale: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) source_request_id: Option<String>,
}

impl ApprovalResolution {
    pub(crate) fn validate(&self) -> Result<(), String> {
        required(&self.request_id, "requestId")?;
        positive(self.correlation.thread_id, "correlation.threadId")?;
        positive(self.correlation.interaction_id, "correlation.interactionId")?;
        required(
            &self.correlation.complete_call_id,
            "correlation.completeCallId",
        )?;
        required(
            &self.correlation.harness_session_id,
            "correlation.harnessSessionId",
        )?;
        required(&self.resolved_at, "resolvedAt")?;
        if let Some(source_request_id) = &self.source_request_id {
            required(source_request_id, "sourceRequestId")?;
        }
        if let Some(rationale) = &self.rationale {
            required(rationale, "rationale")?;
        }
        match self.outcome {
            ApprovalOutcome::Approved
                if !matches!(
                    self.decision,
                    Some(ApprovalDecision::ApproveOnce | ApprovalDecision::ApproveAlways)
                ) =>
            {
                return Err("approved resolution requires an approval decision".into());
            }
            ApprovalOutcome::Denied if self.decision != Some(ApprovalDecision::Deny) => {
                return Err("denied resolution requires the deny decision".into());
            }
            ApprovalOutcome::Cancelled | ApprovalOutcome::Expired | ApprovalOutcome::Aborted
                if self.decision.is_some() =>
            {
                return Err("terminated resolution must not contain a decision".into());
            }
            _ => {}
        }
        match self.actor {
            ApprovalActor::User
                if self.source_request_id.is_some()
                    || !matches!(
                        self.outcome,
                        ApprovalOutcome::Approved | ApprovalOutcome::Denied
                    ) =>
            {
                return Err("user resolution must be a direct approval or denial".into());
            }
            ApprovalActor::SessionGrant => {
                if self.outcome != ApprovalOutcome::Approved
                    || self.decision != Some(ApprovalDecision::ApproveOnce)
                    || self.source_request_id.is_none()
                {
                    return Err(
                        "session_grant resolution requires an approve_once decision and sourceRequestId"
                            .into(),
                    );
                }
            }
            ApprovalActor::Harness | ApprovalActor::Host
                if matches!(
                    self.outcome,
                    ApprovalOutcome::Approved | ApprovalOutcome::Denied
                ) || self.source_request_id.is_some() =>
            {
                return Err("harness terminal resolution cannot grant or deny authority".into());
            }
            _ => {}
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApprovalReceipt {
    pub(crate) request: ApprovalRequest,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) resolution: Option<ApprovalResolution>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ApprovalDecisionSubmission {
    pub(crate) decision: ApprovalDecision,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) rationale: Option<String>,
}

fn required(value: &str, field: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        Err(format!("{field} must be a non-empty string"))
    } else {
        Ok(())
    }
}

fn positive(value: i64, field: &str) -> Result<(), String> {
    if value <= 0 {
        Err(format!("{field} must be a positive integer"))
    } else {
        Ok(())
    }
}
