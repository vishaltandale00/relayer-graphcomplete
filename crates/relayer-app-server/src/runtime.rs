use crate::approval::{ApprovalDecisionSubmission, ApprovalRequest, ApprovalResolution};
use crate::{
    permissions::PermissionProfile,
    product::{
        AdmittedExecutionModelPlan, ExecutionHarnessPolicy, ExecutionModelPlan,
        ExecutionModelSelection, FamilyPolicyReference, HarnessModelCompatibility,
        HarnessModelRule, HarnessModelRules, RuntimeProductHarness, validate_stable_id,
    },
};
use relayer_graph_core::{
    ImportedConversationReceipt, ImportedConversationStage, ImportedTurn,
    PERSONAL_PRESENTATION_PROFILE_THREAD_ID,
};
use reqwest::{Client, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, path::Path};
use thiserror::Error;
use uuid::Uuid;

const CONTROL_RETRY_ATTEMPTS: u64 = 4;
const CONTROL_REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HarnessConfiguration {
    schema_version: u32,
    pub(crate) name: String,
    implementation: String,
    implementation_version: u32,
    #[serde(default = "default_configuration_revision")]
    revision: u32,
    permission_bindings: Map<String, Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    model_compatibility: Vec<HarnessModelCompatibility>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model_rules: Option<HarnessModelRules>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    execution_access_contracts: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model_defaults: Option<HarnessModelDefaults>,
    settings: Value,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct HarnessModelDefaults {
    family_policy: FamilyPolicyReference,
}

const fn default_configuration_revision() -> u32 {
    1
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogEntry {
    configuration: HarnessConfiguration,
    digest: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UnavailableCatalogEntry {
    name: String,
    reason: crate::product::UnavailableReason,
    #[serde(default)]
    #[serde(rename = "diagnostics")]
    _diagnostics: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigurationCatalog {
    schema_version: u32,
    configurations: Vec<CatalogEntry>,
    #[serde(default)]
    unavailable_configurations: Vec<UnavailableCatalogEntry>,
}

#[derive(Clone)]
pub(crate) struct RuntimeClient {
    client: Client,
    graph_url: Url,
    harness_url: Url,
    graph_control_token: String,
    harness_control_token: String,
    personal_presentation_supported: bool,
    configurations: HashMap<String, CatalogEntry>,
    unavailable_configurations: HashMap<String, UnavailableCatalogEntry>,
    temporal_features: relayer_graph_core::TemporalFeatureConfig,
}

pub(crate) struct CompleteInteraction<'a> {
    pub(crate) project_id: Option<i64>,
    pub(crate) product_interaction_id: i64,
    pub(crate) thread_id: i64,
    pub(crate) interaction_id: i64,
    pub(crate) text: &'a str,
    pub(crate) working_directory: &'a str,
    pub(crate) harness_configuration_name: &'a str,
    pub(crate) permission_profile: &'a PermissionProfile,
    pub(crate) model_selection: Option<&'a ExecutionModelSelection>,
    pub(crate) model_plan: Option<&'a ExecutionModelPlan>,
    pub(crate) attempt_admission_id: Option<&'a str>,
    pub(crate) execution_lease_id: Option<&'a str>,
    pub(crate) harness_policy: Option<&'a ExecutionHarnessPolicy>,
    pub(crate) invocation: Option<PreparedInvocation>,
    pub(crate) input_identity: Option<&'a str>,
    pub(crate) input_digest: Option<&'a str>,
    pub(crate) contexts: &'a [crate::product::InteractionContextIntent],
    pub(crate) personal_presentation: Option<&'a PersonalPresentationExecution>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PersonalPresentationExecution {
    pub(crate) version_key: String,
    pub(crate) version_interaction_node_id: i64,
    pub(crate) root_layer_id: i64,
}

impl From<&crate::storage::PersonalPresentationPin> for PersonalPresentationExecution {
    fn from(value: &crate::storage::PersonalPresentationPin) -> Self {
        Self {
            version_key: value.version_key.clone(),
            version_interaction_node_id: value.version_interaction_node_id,
            root_layer_id: value.root_layer_id,
        }
    }
}

#[derive(Debug)]
pub(crate) struct RuntimeExecutionAdmission {
    pub(crate) execution_lease_id: String,
    pub(crate) adapter_implementation_version: u32,
    pub(crate) admitted_plan: AdmittedExecutionModelPlan,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreparedInvocation {
    pub(crate) source_interaction_node_id: i64,
    pub(crate) source_action_id: i64,
}

#[derive(Debug)]
pub(crate) struct PreparedInteraction {
    pub(crate) graph_node_id: i64,
    graph_token: String,
    pub(crate) harness_configuration_name: String,
    pub(crate) harness_configuration_digest: String,
    pub(crate) permission_profile_id: String,
    pub(crate) effective_execution_digest: String,
    pub(crate) effective_permission_receipt: Value,
    configuration: HarnessConfiguration,
    model_selection: Option<ExecutionModelSelection>,
    personal_presentation_version_id: Option<i64>,
    /// The policy this execution was admitted under. A recursive child launch must carry it
    /// too: once a session has taken a dynamic policy update, every later execution needs one.
    harness_policy: Option<ExecutionHarnessPolicy>,
}

#[derive(Debug)]
pub(crate) struct RuntimeCompletion {
    pub(crate) graph_node_id: i64,
    pub(crate) harness_configuration_name: String,
    pub(crate) harness_configuration_digest: String,
    pub(crate) permission_profile_id: String,
    pub(crate) effective_execution_digest: String,
    pub(crate) effective_permission_receipt: Value,
    pub(crate) output: Value,
}

pub(crate) struct RuntimeCompletionBroker<'a> {
    pub(crate) url: &'a str,
    pub(crate) token: &'a str,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RuntimeInvokedCompletionStart {
    pub(crate) completion_id: i64,
    #[serde(default)]
    pub(crate) attachment: Option<Map<String, Value>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeAction {
    pub(crate) id: i64,
    pub(crate) kind: String,
    pub(crate) interaction_text: Option<String>,
    #[serde(default)]
    pub(crate) target_layer_id: Option<i64>,
    pub(crate) state: String,
}

#[derive(Debug, Deserialize)]
struct CancelCompletionResponse {
    cancelled: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ApprovalEventSnapshot {
    pub(crate) harness_session_id: String,
    pub(crate) latest_sequence: u64,
    pub(crate) pending_requests: Vec<ApprovalRequest>,
    pub(crate) events: Vec<ApprovalEvent>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum ApprovalEvent {
    Requested {
        sequence: u64,
        request: ApprovalRequest,
    },
    Resolved {
        sequence: u64,
        resolution: ApprovalResolution,
    },
}

impl ApprovalEvent {
    pub(crate) fn sequence(&self) -> u64 {
        match self {
            Self::Requested { sequence, .. } | Self::Resolved { sequence, .. } => *sequence,
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeLayerOwner {
    pub(crate) layer_id: i64,
    pub(crate) owner_interaction_node_id: i64,
}

#[derive(Debug, Clone)]
pub(crate) struct MaterializedPersonalPresentationVersion {
    pub(crate) interaction_node_id: i64,
    pub(crate) root_layer_id: i64,
    pub(crate) output: Value,
    #[cfg(test)]
    pub(crate) closure: relayer_graph_core::AcceptedGraphClosure,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeInteractionMetadata {
    pub(crate) node_id: i64,
    pub(crate) invocation: Option<PreparedInvocation>,
    #[serde(default)]
    pub(crate) input_identity: Option<String>,
    #[serde(default)]
    pub(crate) input_digest: Option<String>,
}

impl RuntimeClient {
    pub(crate) async fn begin_imported_conversation(
        &self,
        input: &ImportedConversationStage,
    ) -> Result<(), RuntimeError> {
        let response = self
            .client
            .post(
                self.graph_url
                    .join("api/control/conversation-import-stages")?,
            )
            .bearer_auth(&self.graph_control_token)
            .json(input)
            .send()
            .await?;
        response_json(response, StatusCode::OK).await?;
        Ok(())
    }

    pub(crate) async fn stage_imported_turn(
        &self,
        import_id: &str,
        input: &ImportedTurn,
    ) -> Result<(), RuntimeError> {
        let response = self
            .client
            .post(self.graph_url.join(&format!(
                "api/control/conversation-import-stages/{import_id}/turns"
            ))?)
            .bearer_auth(&self.graph_control_token)
            .json(input)
            .send()
            .await?;
        response_json(response, StatusCode::OK).await?;
        Ok(())
    }

    pub(crate) async fn finalize_imported_conversation(
        &self,
        import_id: &str,
    ) -> Result<ImportedConversationReceipt, RuntimeError> {
        let response = self
            .client
            .post(self.graph_url.join(&format!(
                "api/control/conversation-import-stages/{import_id}/finalize"
            ))?)
            .bearer_auth(&self.graph_control_token)
            .send()
            .await?;
        Ok(serde_json::from_value(
            response_json(response, StatusCode::OK).await?,
        )?)
    }

    pub(crate) async fn remove_imported_conversation(
        &self,
        import_id: &str,
    ) -> Result<(), RuntimeError> {
        let response = self
            .client
            .delete(self.graph_url.join("api/control/conversation-imports")?)
            .bearer_auth(&self.graph_control_token)
            .json(&serde_json::json!({"importId": import_id}))
            .send()
            .await?;
        response_json(response, StatusCode::OK).await?;
        Ok(())
    }

    pub(crate) async fn open(
        graph_url: &str,
        harness_url: &str,
        graph_control_token: String,
        harness_control_token: String,
        catalog_path: &Path,
    ) -> Result<Self, RuntimeError> {
        if graph_control_token == harness_control_token {
            return Err(RuntimeError::Configuration(
                "graph and harness control tokens must be distinct".into(),
            ));
        }
        let catalog: ConfigurationCatalog =
            serde_json::from_slice(&tokio::fs::read(catalog_path).await?)?;
        if catalog.schema_version != 1 {
            return Err(RuntimeError::Configuration(format!(
                "unsupported harness configuration catalog schema {}",
                catalog.schema_version
            )));
        }
        let mut configurations = HashMap::new();
        for entry in catalog.configurations {
            validate_configuration(&entry)?;
            let name = entry.configuration.name.clone();
            if configurations.insert(name.clone(), entry).is_some() {
                return Err(RuntimeError::Configuration(format!(
                    "duplicate harness configuration {name}"
                )));
            }
        }
        let mut unavailable_configurations = HashMap::new();
        for entry in catalog.unavailable_configurations {
            let name = entry.name.clone();
            if !machine_identifier(&name) {
                return Err(RuntimeError::Configuration(
                    "invalid unavailable harness configuration name".into(),
                ));
            }
            if configurations.contains_key(&name)
                || unavailable_configurations
                    .insert(name.clone(), entry)
                    .is_some()
            {
                return Err(RuntimeError::Configuration(format!(
                    "duplicate harness configuration {name}"
                )));
            }
        }
        let client = Client::new();
        let graph_url = loopback_url(graph_url, "graph")?;
        let harness_url = loopback_url(harness_url, "harness")?;
        let temporal_response = client
            .get(graph_url.join("api/control/temporal-features")?)
            .bearer_auth(&graph_control_token)
            .timeout(CONTROL_REQUEST_TIMEOUT)
            .send()
            .await;
        let temporal_features = match temporal_response {
            // Older graph runtimes, temporarily unavailable runtimes, and
            // narrow deterministic test doubles cannot opt into temporal
            // behavior. Compatibility is always the conservative all-off
            // stage.
            Err(_) => relayer_graph_core::TemporalFeatureConfig::default(),
            Ok(response) if response.status() == StatusCode::NOT_FOUND => {
                relayer_graph_core::TemporalFeatureConfig::default()
            }
            Ok(response) => serde_json::from_value(response_json(response, StatusCode::OK).await?)?,
        };
        Ok(Self {
            client,
            graph_url,
            harness_url,
            graph_control_token,
            harness_control_token,
            personal_presentation_supported: false,
            configurations,
            unavailable_configurations,
            temporal_features,
        })
    }

    pub(crate) fn has_configuration(&self, name: &str) -> bool {
        self.configurations.contains_key(name)
    }

    pub(crate) fn temporal_features(&self) -> relayer_graph_core::TemporalFeatureConfig {
        self.temporal_features
    }

    pub(crate) fn supports_personal_presentation(&self) -> bool {
        self.personal_presentation_supported
    }

    pub(crate) async fn detect_personal_presentation_support(
        &mut self,
    ) -> Result<(), RuntimeError> {
        let response = self
            .client
            .get(self.graph_url.join("api/control/personal-presentation")?)
            .bearer_auth(&self.graph_control_token)
            .timeout(CONTROL_REQUEST_TIMEOUT)
            .send()
            .await?;
        let status = response.status();
        if status != StatusCode::OK {
            return Err(RuntimeError::Remote {
                status: status.as_u16(),
                body: response.json::<Value>().await.unwrap_or(Value::Null),
            });
        }
        let contract = response.json::<Value>().await?;
        self.personal_presentation_supported = match contract["schemaVersion"].as_u64() {
            Some(1) => true,
            Some(0)
                if self
                    .configurations
                    .values()
                    .all(|entry| entry.configuration.implementation == "test") =>
            {
                false
            }
            _ => {
                return Err(RuntimeError::Protocol(
                    "graph personal presentation contract must use schema version 1".into(),
                ));
            }
        };
        Ok(())
    }

    pub(crate) fn product_harnesses(&self) -> Vec<RuntimeProductHarness> {
        let mut harnesses = self
            .configurations
            .values()
            .map(|entry| RuntimeProductHarness {
                id: entry.configuration.name.clone(),
                configuration_digest: entry.digest.clone(),
                model_compatibility: entry.configuration.model_compatibility.clone(),
                configuration_revision: entry.configuration.revision,
                model_rules: entry.configuration.model_rules.clone(),
                execution_access_contracts: entry.configuration.execution_access_contracts.clone(),
                family_policy: entry
                    .configuration
                    .model_defaults
                    .as_ref()
                    .map(|defaults| defaults.family_policy.clone()),
                runtime_available: true,
                unavailable_reason: None,
            })
            .collect::<Vec<_>>();
        harnesses.extend(self.unavailable_configurations.values().map(|entry| {
            RuntimeProductHarness {
                id: entry.name.clone(),
                configuration_digest: "sha256:unavailable".into(),
                model_compatibility: Vec::new(),
                configuration_revision: 1,
                model_rules: None,
                execution_access_contracts: Vec::new(),
                family_policy: None,
                runtime_available: false,
                unavailable_reason: Some(entry.reason.clone()),
            }
        }));
        harnesses.sort_by(|left, right| left.id.cmp(&right.id));
        harnesses
    }

    pub(crate) fn permission_bindings(
        &self,
        configuration_name: &str,
    ) -> Result<&Map<String, Value>, RuntimeError> {
        self.configurations
            .get(configuration_name)
            .map(|entry| &entry.configuration.permission_bindings)
            .ok_or_else(|| {
                RuntimeError::Configuration(format!(
                    "unknown harness configuration {configuration_name}"
                ))
            })
    }

    pub(crate) fn personal_presentation_version_key(
        &self,
        configuration_name: &str,
    ) -> Result<Option<&str>, RuntimeError> {
        let configuration = &self
            .configurations
            .get(configuration_name)
            .ok_or_else(|| {
                RuntimeError::Configuration(format!(
                    "unknown harness configuration {configuration_name}"
                ))
            })?
            .configuration;
        match configuration.settings.get("personalPresentationVersion") {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(value))
                if matches!(
                    value.as_str(),
                    "personal-presentation-v0" | "personal-presentation-v1"
                ) =>
            {
                Ok(Some(value))
            }
            Some(_) => Err(RuntimeError::Configuration(format!(
                "harness configuration {configuration_name} has an invalid personal presentation version"
            ))),
        }
    }

    #[cfg(test)]
    pub(crate) async fn complete(
        &self,
        command: CompleteInteraction<'_>,
    ) -> Result<RuntimeCompletion, RuntimeError> {
        let prepared = self.prepare(&command).await?;
        self.activate_prepared(&prepared).await?;
        self.complete_prepared(&command, prepared, None).await
    }

    pub(crate) async fn prepare(
        &self,
        command: &CompleteInteraction<'_>,
    ) -> Result<PreparedInteraction, RuntimeError> {
        let selected = self
            .configurations
            .get(command.harness_configuration_name)
            .ok_or_else(|| {
                RuntimeError::Configuration(format!(
                    "unknown harness configuration {}",
                    command.harness_configuration_name
                ))
            })?;
        selected
            .configuration
            .permission_bindings
            .get(&command.permission_profile.id)
            .and_then(Value::as_object)
            .ok_or_else(|| RuntimeError::PermissionUnsupported {
                profile_id: command.permission_profile.id.clone(),
                configuration_name: selected.configuration.name.clone(),
            })?;
        let invocation = command.invocation.map(|invocation| {
            serde_json::json!({
                "sourceInteractionNodeId": invocation.source_interaction_node_id,
                "sourceActionId": invocation.source_action_id,
            })
        });
        let create_url = self.graph_url.join("api/control/interactions")?;
        let create_body = serde_json::json!({
            "projectId": command.project_id,
            "threadId": command.thread_id,
            "text": command.text,
            "invocation": invocation,
            "inputIdentity": command.input_identity,
            "inputDigest": command.input_digest,
            "contexts": command.contexts,
            "mintCapability": false,
        });
        let interaction: CreateInteractionResponse =
            if command.invocation.is_some() || command.input_identity.is_some() {
                self.post_idempotent(
                    create_url.clone(),
                    &create_body,
                    &self.graph_control_token,
                    StatusCode::OK,
                    "graph interaction creation",
                )
                .await?
            } else {
                self.post(
                    create_url,
                    &create_body,
                    &self.graph_control_token,
                    StatusCode::OK,
                )
                .await?
            };
        if !interaction.graph_token.is_empty() {
            self.revoke_capability(&interaction.graph_token).await?;
            return Err(RuntimeError::Protocol(
                "graph server minted a capability before the product binding was durable".into(),
            ));
        }
        let harness_configuration_digest = command
            .harness_policy
            .map(|policy| policy.configuration_digest.as_str())
            .unwrap_or(&selected.digest);
        if command.input_identity.is_some()
            && (interaction.input_identity.as_deref() != command.input_identity
                || interaction.input_digest.as_deref() != command.input_digest)
        {
            return Err(RuntimeError::Protocol(
                "graph server returned a different interaction input identity".into(),
            ));
        }
        if let Some(personal_presentation) = command.personal_presentation {
            let attached: relayer_graph_core::PersonalPresentationAttachment = self
                .post_idempotent(
                    self.graph_url.join(&format!(
                        "api/control/interactions/{}/personal-presentation",
                        interaction.node.id
                    ))?,
                    &serde_json::json!({
                        "versionInteractionNodeId": personal_presentation.version_interaction_node_id,
                    }),
                    &self.graph_control_token,
                    StatusCode::OK,
                    "personal presentation attachment",
                )
                .await?;
            if attached.interaction_node_id.value() != interaction.node.id
                || attached.version_interaction_node_id.value()
                    != personal_presentation.version_interaction_node_id
                || attached.root_layer_id.value() != personal_presentation.root_layer_id
            {
                return Err(RuntimeError::Protocol(
                    "graph server attached a different personal presentation version".into(),
                ));
            }
        }
        let effective_execution_digest = effective_execution_digest(
            harness_configuration_digest,
            &command.permission_profile.id,
            command.model_selection,
            command.personal_presentation,
        );
        let unrestricted = command.permission_profile.authority == "unrestricted";
        Ok(PreparedInteraction {
            graph_node_id: interaction.node.id,
            graph_token: Uuid::new_v4().to_string(),
            harness_policy: command.harness_policy.cloned(),
            harness_configuration_name: selected.configuration.name.clone(),
            harness_configuration_digest: harness_configuration_digest.to_owned(),
            permission_profile_id: command.permission_profile.id.clone(),
            effective_execution_digest,
            effective_permission_receipt: serde_json::json!({
                "schemaVersion": 1,
                "permissionProfileId": &command.permission_profile.id,
                "label": &command.permission_profile.label,
                "authority": &command.permission_profile.authority,
                "reviewer": &command.permission_profile.reviewer,
                "bindingPresent": true,
                "unconfinedHostAccess": unrestricted,
                "disclosure": unrestricted.then_some("Filesystem and network access were not hard-confined."),
            }),
            configuration: selected.configuration.clone(),
            model_selection: command.model_selection.cloned(),
            personal_presentation_version_id: command
                .personal_presentation
                .map(|value| value.version_interaction_node_id),
        })
    }

    pub(crate) async fn activate_prepared(
        &self,
        prepared: &PreparedInteraction,
    ) -> Result<(), RuntimeError> {
        let url = self.graph_url.join("api/control/capabilities")?;
        let body = serde_json::json!({
            "nodeId": prepared.graph_node_id,
            "graphToken": &prepared.graph_token,
        });
        let mut attempt = 0;
        loop {
            attempt += 1;
            match tokio::time::timeout(
                CONTROL_REQUEST_TIMEOUT,
                self.post::<RemintCapabilityResponse>(
                    url.clone(),
                    &body,
                    &self.graph_control_token,
                    StatusCode::OK,
                ),
            )
            .await
            .unwrap_or(Err(RuntimeError::Timeout("graph capability activation")))
            {
                Ok(response) if response.graph_token == prepared.graph_token => return Ok(()),
                Ok(_) if attempt < CONTROL_RETRY_ATTEMPTS => {}
                Ok(_) => {
                    return Err(RuntimeError::Protocol(
                        "graph server returned a different prepared capability".into(),
                    ));
                }
                Err(
                    RuntimeError::Http(_)
                    | RuntimeError::ResponseDecode(_)
                    | RuntimeError::Timeout(_),
                ) if attempt < CONTROL_RETRY_ATTEMPTS => {}
                Err(error) => return Err(error),
            }
            tokio::time::sleep(std::time::Duration::from_millis(attempt * 25)).await;
        }
    }

    pub(crate) async fn invalidate_node_capabilities(
        &self,
        graph_node_id: i64,
    ) -> Result<(), RuntimeError> {
        let body = serde_json::json!({"nodeId": graph_node_id});
        let mut attempt = 0;
        loop {
            attempt += 1;
            match self.delete_control(&body).await {
                Ok(_) => return Ok(()),
                Err(
                    RuntimeError::Http(_)
                    | RuntimeError::ResponseDecode(_)
                    | RuntimeError::Timeout(_),
                ) if attempt < CONTROL_RETRY_ATTEMPTS => {
                    tokio::time::sleep(std::time::Duration::from_millis(attempt * 25)).await;
                }
                Err(error) => return Err(error),
            }
        }
    }

    pub(crate) async fn complete_prepared(
        &self,
        command: &CompleteInteraction<'_>,
        prepared: PreparedInteraction,
        completion_broker: Option<RuntimeCompletionBroker<'_>>,
    ) -> Result<RuntimeCompletion, RuntimeError> {
        let graph = serde_json::json!({
            "url": self.graph_url.as_str().trim_end_matches('/'),
            "token": &prepared.graph_token,
            "nodeId": prepared.graph_node_id,
        });
        let completion = async {
            let _: Value = self
                .post(
                    self.harness_url.join("sessions")?,
                    &serde_json::json!({
                        "threadId": command.thread_id,
                        "configuration": prepared.configuration,
                        "permissionProfileId": &prepared.permission_profile_id,
                        "workingDirectory": command.working_directory,
                    }),
                    &self.harness_control_token,
                    StatusCode::CREATED,
                )
                .await?;
            let mut complete_body = serde_json::json!({
                "interactionId": command.interaction_id,
                "graph": graph,
                "traceContext": { "productInteractionId": command.product_interaction_id },
            });
            if let Some(version_id) = prepared.personal_presentation_version_id {
                complete_body["traceContext"]["personalPresentationVersionId"] =
                    Value::from(version_id);
            }
            if let Some(model_selection) = prepared.model_selection.as_ref() {
                complete_body["model"] = serde_json::json!({
                    "providerId": model_selection.provider_id.as_str(),
                    "adapterId": &model_selection.adapter_id,
                    "modelId": &model_selection.model_id,
                });
            }
            if let Some(execution_lease_id) = command.execution_lease_id {
                complete_body["executionLeaseId"] = Value::String(execution_lease_id.to_owned());
            }
            if let Some(attempt_admission_id) = command.attempt_admission_id {
                complete_body["attemptAdmissionId"] =
                    Value::String(attempt_admission_id.to_owned());
            }
            if let Some(model_plan) = command.model_plan {
                complete_body["modelPlan"] = serde_json::to_value(model_plan)?;
            }
            if let Some(harness_policy) = command.harness_policy {
                complete_body["harnessPolicy"] = serde_json::to_value(harness_policy)?;
            }
            if let Some(completion_broker) = completion_broker {
                complete_body["completionBroker"] = serde_json::json!({
                    "url": completion_broker.url,
                    "token": completion_broker.token,
                });
            }
            self.post(
                self.harness_url
                    .join(&format!("sessions/{}/complete", command.thread_id))?,
                &complete_body,
                &self.harness_control_token,
                StatusCode::OK,
            )
            .await
        }
        .await;
        let revocation = self.revoke_capability(&prepared.graph_token).await;
        let completed: CompleteResponse = match (completion, revocation) {
            (Ok(completed), Ok(())) => completed,
            (Err(operation), Ok(())) => {
                return Err(RuntimeError::Completion {
                    graph_node_id: prepared.graph_node_id,
                    operation: Box::new(operation),
                });
            }
            (Ok(_), Err(cleanup)) => {
                return Err(RuntimeError::Completion {
                    graph_node_id: prepared.graph_node_id,
                    operation: Box::new(cleanup),
                });
            }
            (Err(operation), Err(cleanup)) => {
                return Err(RuntimeError::Completion {
                    graph_node_id: prepared.graph_node_id,
                    operation: Box::new(RuntimeError::Cleanup {
                        operation: Box::new(operation),
                        cleanup: Box::new(cleanup),
                    }),
                });
            }
        };
        Ok(RuntimeCompletion {
            graph_node_id: prepared.graph_node_id,
            harness_configuration_name: prepared.harness_configuration_name,
            harness_configuration_digest: prepared.harness_configuration_digest,
            permission_profile_id: prepared.permission_profile_id,
            effective_execution_digest: prepared.effective_execution_digest,
            effective_permission_receipt: prepared.effective_permission_receipt,
            output: completed.output,
        })
    }

    /// Starts one already-prepared recursive completion. The response is only
    /// the provider attachment acknowledgement; terminal graph state remains
    /// independently observable through GraphComplete control APIs.
    pub(crate) async fn start_invoked_completion(
        &self,
        thread_id: i64,
        prepared: &PreparedInteraction,
        invocation: PreparedInvocation,
        completion_broker: Option<RuntimeCompletionBroker<'_>>,
    ) -> Result<RuntimeInvokedCompletionStart, RuntimeError> {
        if thread_id < 1
            || prepared.graph_node_id < 1
            || invocation.source_interaction_node_id < 1
            || invocation.source_action_id < 1
        {
            return Err(RuntimeError::Configuration(
                "invoked completion binding identifiers must be positive".into(),
            ));
        }
        let mut body = serde_json::json!({
            "capability": {
                "url": self.graph_url.as_str().trim_end_matches('/'),
                "token": &prepared.graph_token,
                "nodeId": prepared.graph_node_id,
            },
            "origin": {
                "kind": "invoke",
                "sourceCompletionId": invocation.source_interaction_node_id,
                "actionId": invocation.source_action_id,
            },
        });
        if let Some(model_selection) = prepared.model_selection.as_ref() {
            body["model"] = serde_json::json!({
                "providerId": model_selection.provider_id.as_str(),
                "adapterId": &model_selection.adapter_id,
                "modelId": &model_selection.model_id,
            });
        }
        if let Some(harness_policy) = prepared.harness_policy.as_ref() {
            body["harnessPolicy"] = serde_json::to_value(harness_policy)?;
        }
        if let Some(completion_broker) = completion_broker {
            body["completionBroker"] = serde_json::json!({
                "url": completion_broker.url,
                "token": completion_broker.token,
            });
        }
        let started: RuntimeInvokedCompletionStart = self
            .post(
                self.harness_url
                    .join(&format!("sessions/{thread_id}/invoked-completions"))?,
                &body,
                &self.harness_control_token,
                StatusCode::CREATED,
            )
            .await?;
        if started.completion_id != prepared.graph_node_id {
            return Err(RuntimeError::Protocol(
                "harness attached a different invoked completion identity".into(),
            ));
        }
        Ok(started)
    }

    pub(crate) async fn observe_invoked_completion(
        &self,
        thread_id: i64,
        completion_id: i64,
    ) -> Result<Value, RuntimeError> {
        if thread_id < 1 || completion_id < 1 {
            return Err(RuntimeError::Configuration(
                "invoked completion observation identifiers must be positive".into(),
            ));
        }
        self.control_harness_get(&format!(
            "sessions/{thread_id}/invoked-completions/{completion_id}"
        ))
        .await
    }

    pub(crate) async fn admit_provider_execution(
        &self,
        command: &CompleteInteraction<'_>,
    ) -> Result<RuntimeExecutionAdmission, RuntimeError> {
        let selected = self
            .configurations
            .get(command.harness_configuration_name)
            .ok_or_else(|| {
                RuntimeError::Configuration(format!(
                    "unknown harness configuration {}",
                    command.harness_configuration_name
                ))
            })?;
        let model = command.model_selection.ok_or_else(|| {
            RuntimeError::Configuration(
                "provider execution admission requires a model selection".into(),
            )
        })?;
        let harness_policy = command.harness_policy.ok_or_else(|| {
            RuntimeError::Configuration(
                "provider execution admission requires a current harness policy".into(),
            )
        })?;
        let model_plan = command.model_plan.ok_or_else(|| {
            RuntimeError::Configuration("provider execution admission requires a model plan".into())
        })?;
        let attempt_admission_id = command.attempt_admission_id.ok_or_else(|| {
            RuntimeError::Configuration(
                "provider execution admission requires an attempt admission id".into(),
            )
        })?;
        let _: Value = self
            .post(
                self.harness_url.join("sessions")?,
                &serde_json::json!({
                    "threadId": command.thread_id,
                    "configuration": selected.configuration,
                    "permissionProfileId": command.permission_profile.id,
                    "workingDirectory": command.working_directory,
                }),
                &self.harness_control_token,
                StatusCode::CREATED,
            )
            .await?;
        let admitted: ExecutionAdmissionResponse = self
            .post(
                self.harness_url
                    .join(&format!("sessions/{}/execution-leases", command.thread_id))?,
                &serde_json::json!({
                    "interactionId": command.interaction_id,
                    "attemptAdmissionId": attempt_admission_id,
                    "modelPlan": model_plan,
                    "harnessPolicy": harness_policy,
                }),
                &self.harness_control_token,
                StatusCode::CREATED,
            )
            .await?;
        let adapter_implementation_version = admitted
            .adapter_implementation_version
            .parse::<u32>()
            .ok()
            .filter(|version| *version > 0);
        let Some(adapter_implementation_version) = adapter_implementation_version else {
            let _ = self
                .release_provider_execution(command.thread_id, &admitted.execution_lease_id)
                .await;
            return Err(RuntimeError::Configuration(
                "provider broker returned an invalid adapter implementation version".into(),
            ));
        };
        if let Err(error) =
            validate_admitted_plan(model_plan, harness_policy, &admitted.admitted_plan)
        {
            let _ = self
                .release_provider_execution(command.thread_id, &admitted.execution_lease_id)
                .await;
            return Err(error);
        }
        if admitted
            .admitted_plan
            .orchestrator
            .adapter_implementation_version
            != admitted.adapter_implementation_version
        {
            let _ = self
                .release_provider_execution(command.thread_id, &admitted.execution_lease_id)
                .await;
            return Err(RuntimeError::Protocol(
                "provider broker returned inconsistent orchestrator adapter versions".into(),
            ));
        }
        if admitted.admitted_plan.orchestrator.provider_id != model.provider_id
            || admitted.admitted_plan.orchestrator.adapter_id != model.adapter_id
            || admitted.admitted_plan.orchestrator.access_contract != model.access_contract
            || admitted.admitted_plan.orchestrator.model_id != model.model_id
        {
            let _ = self
                .release_provider_execution(command.thread_id, &admitted.execution_lease_id)
                .await;
            return Err(RuntimeError::Protocol(
                "provider broker changed the selected orchestrator".into(),
            ));
        }
        Ok(RuntimeExecutionAdmission {
            execution_lease_id: admitted.execution_lease_id,
            adapter_implementation_version,
            admitted_plan: admitted.admitted_plan,
        })
    }

    pub(crate) async fn release_provider_execution(
        &self,
        thread_id: i64,
        execution_lease_id: &str,
    ) -> Result<(), RuntimeError> {
        let response = self
            .client
            .delete(self.harness_url.join(&format!(
                "sessions/{thread_id}/execution-leases/{execution_lease_id}"
            ))?)
            .bearer_auth(&self.harness_control_token)
            .send()
            .await?;
        response_json(response, StatusCode::OK).await?;
        Ok(())
    }

    pub(crate) async fn approval_events(
        &self,
        thread_id: i64,
        after_sequence: u64,
    ) -> Result<ApprovalEventSnapshot, RuntimeError> {
        let mut url = self
            .harness_url
            .join(&format!("sessions/{thread_id}/approval-events"))?;
        url.query_pairs_mut()
            .append_pair("after", &after_sequence.to_string());
        let response = self
            .client
            .get(url)
            .bearer_auth(&self.harness_control_token)
            .send()
            .await?;
        let value = response_json(response, StatusCode::OK).await?;
        Ok(serde_json::from_value(value)?)
    }

    pub(crate) async fn cancel_completion(&self, thread_id: i64) -> Result<bool, RuntimeError> {
        self.cancel_completion_request(thread_id, None).await
    }

    pub(crate) async fn cancel_invoked_completion(
        &self,
        thread_id: i64,
        completion_id: i64,
    ) -> Result<bool, RuntimeError> {
        if completion_id < 1 {
            return Err(RuntimeError::Configuration(
                "invoked completion id must be positive".into(),
            ));
        }
        self.cancel_completion_request(thread_id, Some(completion_id))
            .await
    }

    async fn cancel_completion_request(
        &self,
        thread_id: i64,
        completion_id: Option<i64>,
    ) -> Result<bool, RuntimeError> {
        if thread_id < 1 {
            return Err(RuntimeError::Configuration(
                "completion thread id must be positive".into(),
            ));
        }
        let mut url = self
            .harness_url
            .join(&format!("sessions/{thread_id}/cancel"))?;
        if let Some(completion_id) = completion_id {
            url.query_pairs_mut()
                .append_pair("completionId", &completion_id.to_string());
        }
        let response: CancelCompletionResponse = self
            .post(
                url,
                &serde_json::json!({}),
                &self.harness_control_token,
                StatusCode::OK,
            )
            .await?;
        Ok(response.cancelled)
    }

    pub(crate) async fn decide_approval(
        &self,
        thread_id: i64,
        request_id: &str,
        submission: &ApprovalDecisionSubmission,
    ) -> Result<ApprovalResolution, RuntimeError> {
        let mut url = self.harness_url.join("sessions/")?;
        url.path_segments_mut()
            .map_err(|_| RuntimeError::Configuration("invalid harness URL".into()))?
            .pop_if_empty()
            .push(&thread_id.to_string())
            .push("approvals")
            .push(request_id)
            .push("decision");
        self.post(
            url,
            &serde_json::to_value(submission)?,
            &self.harness_control_token,
            StatusCode::OK,
        )
        .await
    }

    pub(crate) async fn discard_prepared(
        &self,
        prepared: PreparedInteraction,
    ) -> Result<(), RuntimeError> {
        self.revoke_capability(&prepared.graph_token).await
    }

    pub(crate) async fn completion_output(
        &self,
        interaction_node_id: i64,
    ) -> Result<Option<Value>, RuntimeError> {
        match self
            .control_get(&format!(
                "api/control/interactions/{interaction_node_id}/output"
            ))
            .await
        {
            Ok(value) => Ok(Some(value)),
            Err(RuntimeError::Remote { status: 404, body })
                if body.pointer("/error/code").and_then(Value::as_str)
                    == Some("completion_not_found") =>
            {
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }

    pub(crate) async fn completion_current(
        &self,
        interaction_node_id: i64,
    ) -> Result<relayer_graph_core::CompletionState, RuntimeError> {
        Ok(serde_json::from_value(
            self.control_get(&format!(
                "api/control/interactions/{interaction_node_id}/current"
            ))
            .await?,
        )?)
    }

    pub(crate) async fn ensure_personal_presentation_version(
        &self,
        version_key: &str,
    ) -> Result<MaterializedPersonalPresentationVersion, RuntimeError> {
        let definition = personal_presentation_definition(version_key)?;
        let digest = relayer_graph_core::interaction_input_digest(
            definition.interaction_text,
            &[] as &[relayer_graph_core::InteractionContextDraft],
        )
        .map_err(|error| {
            RuntimeError::Protocol(format!(
                "could not digest personal presentation input: {error}"
            ))
        })?;
        let created: CreateInteractionResponse = self
            .post_idempotent(
                self.graph_url.join("api/control/interactions")?,
                &serde_json::json!({
                    "projectId": null,
                    "threadId": PERSONAL_PRESENTATION_PROFILE_THREAD_ID,
                    "text": definition.interaction_text,
                    "inputIdentity": format!("relayer.personal-presentation:{version_key}"),
                    "inputDigest": digest,
                    "contexts": [],
                    "mintCapability": false,
                    "personalPresentationProfile": true,
                }),
                &self.graph_control_token,
                StatusCode::OK,
                "personal presentation version creation",
            )
            .await?;
        let node_id = created.node.id;
        // An already materialized version is an immutable accepted completion. Reuse its stored
        // materialization without activating execution authority on a terminal completion.
        if let Some(output) = self.completion_output(node_id).await? {
            let closure = self.accepted_graph_closure(node_id).await?;
            self.publish_personal_presentation_version(node_id).await?;
            return Ok(MaterializedPersonalPresentationVersion {
                interaction_node_id: node_id,
                root_layer_id: closure.root_layer_id.value(),
                output,
                #[cfg(test)]
                closure,
            });
        }
        let graph_token = self.mint_capability(node_id).await?;
        let operation = async {
            let mut nodes = Vec::with_capacity(definition.nodes.len());
            for node in definition.nodes {
                let value = self
                    .graph_capability_post(
                        "api/graph/nodes",
                        &graph_token,
                        &serde_json::json!({
                            "clientKey": node.client_key,
                            "kind": node.kind,
                            "icon": node.icon,
                            "title": node.title,
                            "detail": node.detail,
                        }),
                    )
                    .await?;
                let id = value
                    .pointer("/node/id")
                    .and_then(Value::as_i64)
                    .ok_or_else(|| {
                        RuntimeError::Protocol(
                            "graph server omitted a personal presentation node ID".into(),
                        )
                    })?;
                nodes.push(id);
            }
            let mut edges = Vec::with_capacity(definition.edges.len());
            for (index, [left, right]) in definition.edges.iter().copied().enumerate() {
                let value = self
                    .graph_capability_post(
                        "api/graph/edges",
                        &graph_token,
                        &serde_json::json!({
                            "clientKey": format!("preference-edge-{index}"),
                            "endpoints": [nodes[left], nodes[right]],
                        }),
                    )
                    .await?;
                edges.push(
                    value
                        .pointer("/edge/id")
                        .and_then(Value::as_i64)
                        .ok_or_else(|| {
                            RuntimeError::Protocol(
                                "graph server omitted a personal presentation edge ID".into(),
                            )
                        })?,
                );
            }
            let placements = nodes
                .iter()
                .enumerate()
                .map(|(index, node_id)| {
                    serde_json::json!({
                        "nodeId": node_id,
                        "x": if nodes.len() == 1 { 0.5 } else { 0.25 + index as f64 * 0.5 },
                        "y": 0.5,
                    })
                })
                .collect::<Vec<_>>();
            let layer = self
                .graph_capability_post(
                    "api/graph/layers",
                    &graph_token,
                    &serde_json::json!({
                        "clientKey": "personal-presentation-root",
                        "nodes": nodes,
                        "edges": edges,
                        "layout": {"version": 1, "placements": placements},
                    }),
                )
                .await?;
            let root_layer_id = layer
                .pointer("/layer/id")
                .and_then(Value::as_i64)
                .ok_or_else(|| {
                    RuntimeError::Protocol(
                        "graph server omitted the personal presentation root layer ID".into(),
                    )
                })?;
            self.graph_capability_post(
                "api/graph/actions",
                &graph_token,
                &serde_json::json!({
                    "clientKey": "personal-presentation-response",
                    "sourceNodeId": node_id,
                    "kind": "navigate",
                    "relation": "expand",
                    "label": "Personal presentation",
                    "variant": "pill",
                    "targetLayerId": root_layer_id,
                }),
            )
            .await?;
            let output = self
                .graph_capability_post(
                    "api/graph/submit",
                    &graph_token,
                    &serde_json::json!({"nodeId": node_id}),
                )
                .await?;
            let closure = self.accepted_graph_closure(node_id).await?;
            if closure.root_layer_id.value() != root_layer_id {
                return Err(RuntimeError::Protocol(
                    "personal presentation submission returned a mismatched root layer".into(),
                ));
            }
            self.publish_personal_presentation_version(node_id).await?;
            Ok(MaterializedPersonalPresentationVersion {
                interaction_node_id: node_id,
                root_layer_id,
                output,
                #[cfg(test)]
                closure,
            })
        }
        .await;
        let cleanup = self.revoke_capability(&graph_token).await;
        match (operation, cleanup) {
            (Ok(value), Ok(())) => Ok(value),
            (Err(operation), Ok(())) => Err(operation),
            (Ok(_), Err(cleanup)) => Err(cleanup),
            (Err(operation), Err(cleanup)) => Err(RuntimeError::Cleanup {
                operation: Box::new(operation),
                cleanup: Box::new(cleanup),
            }),
        }
    }

    async fn publish_personal_presentation_version(
        &self,
        version_interaction_node_id: i64,
    ) -> Result<(), RuntimeError> {
        let _: Value = self
            .post_idempotent(
                self.graph_url
                    .join("api/control/personal-presentation/versions")?,
                &serde_json::json!({
                    "versionInteractionNodeId": version_interaction_node_id,
                }),
                &self.graph_control_token,
                StatusCode::OK,
                "personal presentation publication",
            )
            .await?;
        Ok(())
    }

    pub(crate) async fn get_layer(
        &self,
        interaction_node_id: i64,
        layer_id: i64,
    ) -> Result<Value, RuntimeError> {
        self.control_get(&format!(
            "api/control/interactions/{interaction_node_id}/layers/{layer_id}"
        ))
        .await
    }

    pub(crate) async fn get_layer_owner(
        &self,
        interaction_node_id: i64,
        layer_id: i64,
    ) -> Result<RuntimeLayerOwner, RuntimeError> {
        Ok(serde_json::from_value(
            self.control_get(&format!(
                "api/control/interactions/{interaction_node_id}/layers/{layer_id}/owner"
            ))
            .await?,
        )?)
    }

    pub(crate) async fn accepted_graph_closure(
        &self,
        interaction_node_id: i64,
    ) -> Result<relayer_graph_core::AcceptedGraphClosure, RuntimeError> {
        let value = self
            .control_get(&format!(
                "api/control/interactions/{interaction_node_id}/accepted-closure"
            ))
            .await?;
        Ok(serde_json::from_value(value)?)
    }

    pub(crate) async fn get_action(
        &self,
        interaction_node_id: i64,
        action_id: i64,
    ) -> Result<RuntimeAction, RuntimeError> {
        let value = self
            .control_get(&format!(
                "api/control/interactions/{interaction_node_id}/actions/{action_id}"
            ))
            .await?;
        Ok(serde_json::from_value(value["action"].clone())?)
    }

    pub(crate) async fn interaction_metadata(
        &self,
        interaction_node_id: i64,
    ) -> Result<RuntimeInteractionMetadata, RuntimeError> {
        Ok(serde_json::from_value(
            self.control_get(&format!("api/control/interactions/{interaction_node_id}"))
                .await?,
        )?)
    }

    pub(crate) async fn interaction_input(
        &self,
        interaction_node_id: i64,
    ) -> Result<relayer_graph_core::InteractionInput, RuntimeError> {
        Ok(serde_json::from_value(
            self.control_get(&format!(
                "api/control/interactions/{interaction_node_id}/input"
            ))
            .await?,
        )?)
    }

    pub(crate) async fn fail_graph_completion(
        &self,
        interaction_node_id: i64,
        operation_key: &str,
        reason: &str,
    ) -> Result<relayer_graph_core::CurrentTransitionReceipt, RuntimeError> {
        self.terminate_graph_completion(
            interaction_node_id,
            operation_key,
            relayer_graph_core::CurrentTransition::Fail {
                reason: reason.to_owned(),
            },
        )
        .await
    }

    /// Settles one completion as explicitly stopped while retaining its last published current.
    pub(crate) async fn stop_graph_completion(
        &self,
        interaction_node_id: i64,
        operation_key: &str,
    ) -> Result<relayer_graph_core::CurrentTransitionReceipt, RuntimeError> {
        self.terminate_graph_completion(
            interaction_node_id,
            operation_key,
            relayer_graph_core::CurrentTransition::Stop {
                reason: "cancelled_by_user".to_owned(),
            },
        )
        .await
    }

    async fn terminate_graph_completion(
        &self,
        interaction_node_id: i64,
        operation_key: &str,
        transition: relayer_graph_core::CurrentTransition,
    ) -> Result<relayer_graph_core::CurrentTransitionReceipt, RuntimeError> {
        let current: relayer_graph_core::CompletionState = serde_json::from_value(
            self.control_get(&format!(
                "api/control/interactions/{interaction_node_id}/current"
            ))
            .await?,
        )?;
        let expected_revision = match current.lifecycle {
            relayer_graph_core::CompletionLifecycle::Active => current.head_revision,
            _ => current.head_revision.checked_sub(1).ok_or_else(|| {
                RuntimeError::Protocol(format!(
                    "terminal completion {interaction_node_id} has no transition revision"
                ))
            })?,
        };
        let request_digest =
            relayer_graph_core::current_transition_request_digest(expected_revision, &transition)
                .map_err(|error| RuntimeError::Protocol(error.to_string()))?;
        let recovered = self
            .client
            .post(self.graph_url.join(&format!(
                "api/control/interactions/{interaction_node_id}/current/receipts"
            ))?)
            .bearer_auth(&self.graph_control_token)
            .timeout(CONTROL_REQUEST_TIMEOUT)
            .json(&serde_json::json!({
                "operationKey": operation_key,
                "requestDigest": request_digest,
            }))
            .send()
            .await?;
        if recovered.status() == StatusCode::OK {
            return Ok(serde_json::from_value(
                response_json(recovered, StatusCode::OK).await?,
            )?);
        }
        if recovered.status() != StatusCode::NOT_FOUND {
            response_json(recovered, StatusCode::OK).await?;
            unreachable!("unexpected receipt response accepted")
        }
        if current.lifecycle != relayer_graph_core::CompletionLifecycle::Active {
            return Err(RuntimeError::Protocol(format!(
                "completion {interaction_node_id} is already terminal without the expected failure receipt"
            )));
        }
        let response = self
            .client
            .post(self.graph_url.join(&format!(
                "api/control/interactions/{interaction_node_id}/current/transitions"
            ))?)
            .bearer_auth(&self.graph_control_token)
            .timeout(CONTROL_REQUEST_TIMEOUT)
            .json(&serde_json::json!({
                "expectedRevision": current.head_revision,
                "operationKey": operation_key,
                "transition": transition,
            }))
            .send()
            .await?;
        Ok(serde_json::from_value(
            response_json(response, StatusCode::OK).await?,
        )?)
    }

    /// Reads one completion's projection page: its durable current plus the outbox records
    /// published since `after_sequence`, in the order the outbox committed them.
    pub(crate) async fn observed_completion_projection(
        &self,
        interaction_node_id: i64,
        after_sequence: u64,
    ) -> Result<relayer_graph_core::CurrentProjectionPage, RuntimeError> {
        let page = self
            .current_projection_page(&[interaction_node_id], after_sequence, 100)
            .await?;
        if !page
            .states
            .iter()
            .any(|state| state.completion_id.value() == interaction_node_id)
        {
            return Err(RuntimeError::Protocol(format!(
                "canonical current projection is missing for completion {interaction_node_id}"
            )));
        }
        Ok(page)
    }

    pub(crate) async fn current_projection_page(
        &self,
        completion_ids: &[i64],
        after: u64,
        limit: u32,
    ) -> Result<relayer_graph_core::CurrentProjectionPage, RuntimeError> {
        let response = self
            .client
            .post(self.graph_url.join("api/control/current-projections")?)
            .bearer_auth(&self.graph_control_token)
            .timeout(CONTROL_REQUEST_TIMEOUT)
            .json(&serde_json::json!({
                "completionIds": completion_ids,
                "after": after,
                "limit": limit,
            }))
            .send()
            .await?;
        Ok(serde_json::from_value(
            response_json(response, StatusCode::OK).await?,
        )?)
    }

    pub(crate) async fn interaction_context_actions(
        &self,
        interaction_node_id: i64,
    ) -> Result<Vec<relayer_graph_core::InteractionContextAction>, RuntimeError> {
        let value = self
            .control_get(&format!(
                "api/control/interactions/{interaction_node_id}/context-actions"
            ))
            .await?;
        Ok(serde_json::from_value(value["actions"].clone())?)
    }

    pub(crate) async fn canonical_interaction_context_occurrence(
        &self,
        target: &relayer_graph_core::InteractionContextTarget,
    ) -> Result<relayer_graph_core::InteractionInputNode, RuntimeError> {
        let response = self
            .client
            .post(
                self.graph_url
                    .join("api/control/context-occurrences/canonical")?,
            )
            .bearer_auth(&self.graph_control_token)
            .timeout(CONTROL_REQUEST_TIMEOUT)
            .json(target)
            .send()
            .await?;
        let value = response_json(response, StatusCode::OK).await?;
        Ok(serde_json::from_value(value)?)
    }

    async fn control_get(&self, path: &str) -> Result<Value, RuntimeError> {
        let response = self
            .client
            .get(self.graph_url.join(path)?)
            .bearer_auth(&self.graph_control_token)
            .timeout(CONTROL_REQUEST_TIMEOUT)
            .send()
            .await?;
        response_json(response, StatusCode::OK).await
    }

    async fn control_harness_get(&self, path: &str) -> Result<Value, RuntimeError> {
        let response = self
            .client
            .get(self.harness_url.join(path)?)
            .bearer_auth(&self.harness_control_token)
            .timeout(CONTROL_REQUEST_TIMEOUT)
            .send()
            .await?;
        response_json(response, StatusCode::OK).await
    }

    async fn graph_capability_post(
        &self,
        path: &str,
        graph_token: &str,
        body: &Value,
    ) -> Result<Value, RuntimeError> {
        let response = self
            .client
            .post(self.graph_url.join(path)?)
            .bearer_auth(graph_token)
            .timeout(CONTROL_REQUEST_TIMEOUT)
            .json(body)
            .send()
            .await?;
        response_json(response, StatusCode::OK).await
    }

    async fn mint_capability(&self, node_id: i64) -> Result<String, RuntimeError> {
        let response: RemintCapabilityResponse = self
            .post(
                self.graph_url.join("api/control/capabilities")?,
                &serde_json::json!({"nodeId": node_id}),
                &self.graph_control_token,
                StatusCode::OK,
            )
            .await?;
        Ok(response.graph_token)
    }

    async fn revoke_capability(&self, graph_token: &str) -> Result<(), RuntimeError> {
        let body = serde_json::json!({"graphToken": graph_token});
        for attempt in 1..=CONTROL_RETRY_ATTEMPTS {
            match self.delete_control(&body).await {
                Ok(_) => return Ok(()),
                Err(
                    RuntimeError::Http(_)
                    | RuntimeError::ResponseDecode(_)
                    | RuntimeError::Timeout(_),
                ) if attempt < CONTROL_RETRY_ATTEMPTS => {
                    tokio::time::sleep(std::time::Duration::from_millis((attempt * 25).min(1_000)))
                        .await;
                }
                Err(error) => return Err(error),
            }
        }
        unreachable!("bounded retry loop always returns")
    }

    async fn delete_control(&self, body: &Value) -> Result<Value, RuntimeError> {
        let response = self
            .client
            .delete(self.graph_url.join("api/control/capabilities")?)
            .bearer_auth(&self.graph_control_token)
            .timeout(CONTROL_REQUEST_TIMEOUT)
            .json(body)
            .send()
            .await?;
        response_json(response, StatusCode::OK).await
    }

    async fn post<T: for<'de> Deserialize<'de>>(
        &self,
        url: Url,
        body: &Value,
        control_token: &str,
        expected: StatusCode,
    ) -> Result<T, RuntimeError> {
        let response = self
            .client
            .post(url)
            .bearer_auth(control_token)
            .json(body)
            .send()
            .await?;
        let value = response_json(response, expected).await?;
        Ok(serde_json::from_value(value)?)
    }

    async fn post_idempotent<T: for<'de> Deserialize<'de>>(
        &self,
        url: Url,
        body: &Value,
        control_token: &str,
        expected: StatusCode,
        timeout_operation: &'static str,
    ) -> Result<T, RuntimeError> {
        for attempt in 1..=CONTROL_RETRY_ATTEMPTS {
            let result = tokio::time::timeout(
                CONTROL_REQUEST_TIMEOUT,
                self.post(url.clone(), body, control_token, expected),
            )
            .await
            .unwrap_or(Err(RuntimeError::Timeout(timeout_operation)));
            match result {
                Ok(value) => return Ok(value),
                Err(
                    RuntimeError::Http(_)
                    | RuntimeError::ResponseDecode(_)
                    | RuntimeError::Timeout(_),
                ) if attempt < CONTROL_RETRY_ATTEMPTS => {
                    tokio::time::sleep(std::time::Duration::from_millis((attempt * 25).min(1_000)))
                        .await;
                }
                Err(error) => return Err(error),
            }
        }
        unreachable!("bounded retry loop always returns")
    }
}

struct PersonalPresentationNodeDefinition {
    client_key: &'static str,
    kind: &'static str,
    icon: &'static str,
    title: &'static str,
    detail: &'static str,
}

struct PersonalPresentationDefinition {
    interaction_text: &'static str,
    nodes: &'static [PersonalPresentationNodeDefinition],
    edges: &'static [[usize; 2]],
}

const PERSONAL_PRESENTATION_V0_NODES: &[PersonalPresentationNodeDefinition] =
    &[PersonalPresentationNodeDefinition {
        client_key: "neutral-manifest",
        kind: "personal-presentation-manifest",
        icon: "settings",
        title: "Neutral personal presentation",
        detail: "This control version adds no personal presentation guidance.",
    }];

const PERSONAL_PRESENTATION_V1_NODES: &[PersonalPresentationNodeDefinition] = &[
    PersonalPresentationNodeDefinition {
        client_key: "decision-useful-center",
        kind: "presentation-preference",
        icon: "compass",
        title: "Decision-useful center",
        detail: "The user prefers central layers that are immediately decision-useful. Foreground the conclusion or current status, the reasoning that materially affects it, and the most important tradeoffs or limitations.",
    },
    PersonalPresentationNodeDefinition {
        client_key: "adaptive-progressive-disclosure",
        kind: "presentation-preference",
        icon: "layers",
        title: "Adaptive progressive disclosure",
        detail: "Reveal additional information according to its value to understanding. Keep information central when it is necessary to understand the response without navigating. Use graph actions when supporting evidence, implementation detail, or secondary context would materially improve understanding or help the user proceed. Do not add branches that merely repeat or decorate the central explanation.",
    },
];

fn personal_presentation_definition(
    version_key: &str,
) -> Result<PersonalPresentationDefinition, RuntimeError> {
    match version_key {
        "personal-presentation-v0" => Ok(PersonalPresentationDefinition {
            interaction_text: "Personal presentation V0",
            nodes: PERSONAL_PRESENTATION_V0_NODES,
            edges: &[],
        }),
        "personal-presentation-v1" => Ok(PersonalPresentationDefinition {
            interaction_text: "Personal presentation V1",
            nodes: PERSONAL_PRESENTATION_V1_NODES,
            edges: &[[0, 1]],
        }),
        _ => Err(RuntimeError::Configuration(format!(
            "unknown personal presentation version {version_key}"
        ))),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphNodeResponse {
    id: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateInteractionResponse {
    node: GraphNodeResponse,
    graph_token: String,
    #[serde(default)]
    input_identity: Option<String>,
    #[serde(default)]
    input_digest: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExecutionAdmissionResponse {
    execution_lease_id: String,
    adapter_implementation_version: String,
    admitted_plan: AdmittedExecutionModelPlan,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemintCapabilityResponse {
    graph_token: String,
}

#[derive(Deserialize)]
struct CompleteResponse {
    output: Value,
}

async fn response_json(
    response: reqwest::Response,
    expected: StatusCode,
) -> Result<Value, RuntimeError> {
    let status = response.status();
    if status != expected {
        let value = response.json::<Value>().await.unwrap_or(Value::Null);
        return Err(RuntimeError::Remote {
            status: status.as_u16(),
            body: value,
        });
    }
    response
        .json::<Value>()
        .await
        .map_err(RuntimeError::ResponseDecode)
}

fn loopback_url(value: &str, service: &str) -> Result<Url, RuntimeError> {
    let url = Url::parse(value)?;
    if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") || url.port().is_none() {
        return Err(RuntimeError::Configuration(format!(
            "{service} runtime URL must use authenticated 127.0.0.1 HTTP"
        )));
    }
    Ok(url)
}

fn validate_configuration(entry: &CatalogEntry) -> Result<(), RuntimeError> {
    let configuration = &entry.configuration;
    if configuration.schema_version != 1
        || configuration.implementation_version < 1
        || configuration.revision < 1
        || configuration.name.trim().is_empty()
        || configuration.implementation.trim().is_empty()
        || configuration.permission_bindings.is_empty()
        || configuration
            .permission_bindings
            .values()
            .any(|binding| !binding.is_object())
        || !configuration.settings.is_object()
        || !entry.digest.starts_with("sha256:")
    {
        return Err(RuntimeError::Configuration(
            "invalid harness configuration catalog entry".into(),
        ));
    }
    if configuration
        .execution_access_contracts
        .iter()
        .any(|contract| !versioned_identifier(contract))
        || configuration
            .execution_access_contracts
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len()
            != configuration.execution_access_contracts.len()
    {
        return Err(RuntimeError::Configuration(
            "invalid harness execution access contracts".into(),
        ));
    }
    if let Some(defaults) = &configuration.model_defaults
        && (defaults.family_policy.version < 1 || defaults.family_policy.id.trim().is_empty())
    {
        return Err(RuntimeError::Configuration(
            "invalid harness model-family policy reference".into(),
        ));
    }
    if (!configuration.model_compatibility.is_empty() || configuration.model_rules.is_some())
        && configuration.execution_access_contracts.is_empty()
    {
        return Err(RuntimeError::Configuration(
            "model-selecting harness configurations require execution access contracts".into(),
        ));
    }
    if let Some(rules) = &configuration.model_rules {
        for rule in rules.allow.iter().chain(&rules.deny) {
            validate_model_rule(rule)?;
        }
    }
    let mut providers = std::collections::HashSet::new();
    for compatibility in &configuration.model_compatibility {
        validate_stable_id(compatibility.provider_id.as_str(), "providerId")
            .map_err(|error| RuntimeError::Configuration(error.to_string()))?;
        if !providers.insert(compatibility.provider_id.as_str()) {
            return Err(RuntimeError::Configuration(
                "duplicate harness model compatibility provider".into(),
            ));
        }
        if let Some(model_ids) = &compatibility.model_ids {
            if model_ids.is_empty() {
                return Err(RuntimeError::Configuration(
                    "harness model compatibility subset cannot be empty".into(),
                ));
            }
            let mut models = std::collections::HashSet::new();
            for model_id in model_ids {
                validate_stable_id(model_id, "modelId")
                    .map_err(|error| RuntimeError::Configuration(error.to_string()))?;
                if !models.insert(model_id) {
                    return Err(RuntimeError::Configuration(
                        "duplicate harness compatible model ID".into(),
                    ));
                }
            }
            if compatibility
                .preferred_model_id
                .as_ref()
                .is_some_and(|preferred| !models.contains(preferred))
            {
                return Err(RuntimeError::Configuration(
                    "harness preferred model must be included in its model subset".into(),
                ));
            }
        }
        if let Some(preferred) = &compatibility.preferred_model_id {
            validate_stable_id(preferred, "preferredModelId")
                .map_err(|error| RuntimeError::Configuration(error.to_string()))?;
        }
    }
    Ok(())
}

fn machine_identifier(value: &str) -> bool {
    value
        .chars()
        .next()
        .is_some_and(|character| character.is_ascii_alphanumeric())
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        })
}

fn validate_model_rule(rule: &HarnessModelRule) -> Result<(), RuntimeError> {
    validate_stable_id(&rule.adapter_id, "adapterId")
        .map_err(|error| RuntimeError::Configuration(error.to_string()))?;
    match (&rule.model_id_exact, &rule.model_id_regex) {
        (Some(exact), None) => validate_stable_id(exact, "modelIdExact")
            .map_err(|error| RuntimeError::Configuration(error.to_string())),
        (None, Some(pattern)) if !pattern.is_empty() && pattern.len() <= 500 => {
            if pattern.contains("(?")
                || [
                    "\\1", "\\2", "\\3", "\\4", "\\5", "\\6", "\\7", "\\8", "\\9", "\\k", "\\A",
                    "\\z", "\\Z", "\\G",
                ]
                .iter()
                .any(|unsupported| pattern.contains(unsupported))
            {
                return Err(RuntimeError::Configuration(
                    "harness model regex uses syntax outside the supported cross-runtime subset"
                        .into(),
                ));
            }
            regex::Regex::new(pattern).map(|_| ()).map_err(|error| {
                RuntimeError::Configuration(format!("invalid harness model regex: {error}"))
            })
        }
        _ => Err(RuntimeError::Configuration(
            "harness model rule requires exactly one exact or regex matcher".into(),
        )),
    }
}

fn versioned_identifier(value: &str) -> bool {
    let Some((id, version)) = value.rsplit_once('@') else {
        return false;
    };
    !id.is_empty()
        && id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character))
        && version.parse::<u32>().is_ok_and(|version| version > 0)
}

fn effective_execution_digest(
    configuration_digest: &str,
    permission_profile_id: &str,
    model_selection: Option<&ExecutionModelSelection>,
    personal_presentation: Option<&PersonalPresentationExecution>,
) -> String {
    let mut digest = Sha256::new();
    digest.update(b"relayer.effective-execution.v2");
    digest.update([0]);
    digest.update(b"harness");
    digest.update([0]);
    digest.update(configuration_digest.as_bytes());
    digest.update([0]);
    digest.update(b"permission");
    digest.update([0]);
    digest.update(permission_profile_id.as_bytes());
    if let Some(model_selection) = model_selection {
        digest.update([0]);
        digest.update(b"model-provider");
        digest.update([0]);
        digest.update(model_selection.provider_id.as_str().as_bytes());
        digest.update([0]);
        digest.update(b"provider-model");
        digest.update([0]);
        digest.update(model_selection.model_id.as_bytes());
    }
    if let Some(personal_presentation) = personal_presentation {
        digest.update([0]);
        digest.update(b"personal-presentation-version");
        digest.update([0]);
        digest.update(personal_presentation.version_key.as_bytes());
        digest.update([0]);
        digest.update(
            personal_presentation
                .version_interaction_node_id
                .to_string()
                .as_bytes(),
        );
    }
    format!("sha256:{:x}", digest.finalize())
}

fn validate_admitted_plan(
    requested: &ExecutionModelPlan,
    harness_policy: &ExecutionHarnessPolicy,
    admitted: &AdmittedExecutionModelPlan,
) -> Result<(), RuntimeError> {
    if admitted.family_id != requested.family_id
        || admitted.family_revision != requested.family_revision
        || admitted.roster.len() != requested.roster.len()
    {
        return Err(RuntimeError::Protocol(
            "provider broker changed the requested model plan".into(),
        ));
    }
    let route_matches =
        |requested: &crate::product::ExecutionModelRoute,
         admitted: &crate::product::AdmittedExecutionModelRoute| {
            requested.provider_id == admitted.provider_id
                && requested.adapter_id == admitted.adapter_id
                && requested.access_contract == admitted.access_contract
                && requested.model_id == admitted.model_id
                && admitted
                    .adapter_implementation_version
                    .parse::<u32>()
                    .is_ok_and(|version| version > 0)
        };
    if !route_matches(&requested.orchestrator, &admitted.orchestrator)
        || !requested
            .roster
            .iter()
            .zip(&admitted.roster)
            .all(|(requested, admitted)| route_matches(requested, admitted))
    {
        return Err(RuntimeError::Protocol(
            "provider broker changed the requested model plan roster".into(),
        ));
    }
    let expected_policy_digest = harness_policy_digest(harness_policy)?;
    if admitted.harness_policy_digest != expected_policy_digest {
        return Err(RuntimeError::Protocol(
            "provider broker admitted a different harness policy".into(),
        ));
    }
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct UnsignedPlan<'a> {
        family_id: crate::product::ModelFamilyId,
        family_revision: i64,
        orchestrator: &'a crate::product::AdmittedExecutionModelRoute,
        roster: &'a [crate::product::AdmittedExecutionModelRoute],
        harness_policy_digest: &'a str,
    }
    let unsigned = UnsignedPlan {
        family_id: admitted.family_id,
        family_revision: admitted.family_revision,
        orchestrator: &admitted.orchestrator,
        roster: &admitted.roster,
        harness_policy_digest: &admitted.harness_policy_digest,
    };
    let mut plan_hasher = Sha256::new();
    plan_hasher.update(b"relayer.harness-model-plan.v1\0");
    plan_hasher.update(serde_json::to_vec(&unsigned)?);
    let expected_plan_digest = format!("sha256:{:x}", plan_hasher.finalize());
    if admitted.digest != expected_plan_digest {
        return Err(RuntimeError::Protocol(
            "provider broker returned an invalid admitted model-plan digest".into(),
        ));
    }
    Ok(())
}

fn harness_policy_digest(harness_policy: &ExecutionHarnessPolicy) -> Result<String, RuntimeError> {
    let mut hasher = Sha256::new();
    hasher.update(b"relayer.harness-policy.v1\0");
    hasher.update(serde_json::to_vec(&serde_json::to_value(harness_policy)?)?);
    Ok(format!("sha256:{:x}", hasher.finalize()))
}

#[derive(Debug, Error)]
pub(crate) enum RuntimeError {
    #[error("runtime configuration error: {0}")]
    Configuration(String),
    #[error("runtime protocol error: {0}")]
    Protocol(String),
    #[error("runtime control request timed out during {0}")]
    Timeout(&'static str),
    #[error("runtime request failed with HTTP {status}: {body}")]
    Remote { status: u16, body: Value },
    #[error("runtime successful response body could not be decoded: {0}")]
    ResponseDecode(#[source] reqwest::Error),
    #[error(
        "runtime completion failed: {operation}; graph capability revocation also failed: {cleanup}"
    )]
    Cleanup {
        operation: Box<RuntimeError>,
        cleanup: Box<RuntimeError>,
    },
    #[error("runtime completion for graph node {graph_node_id} failed: {operation}")]
    Completion {
        graph_node_id: i64,
        operation: Box<RuntimeError>,
    },
    #[error(
        "harness configuration {configuration_name} does not support permission profile {profile_id}"
    )]
    PermissionUnsupported {
        profile_id: String,
        configuration_name: String,
    },
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Http(#[from] reqwest::Error),
    #[error(transparent)]
    Url(#[from] url::ParseError),
}

impl RuntimeError {
    pub(crate) fn attempt_failure(&self) -> (&str, &str, bool) {
        if let Self::Completion { operation, .. } = self {
            return operation.attempt_failure();
        }
        if let Self::Remote { body, .. } = self {
            let reported_category = body
                .get("failureCategory")
                .and_then(Value::as_str)
                .unwrap_or("execution");
            let category = match reported_category {
                "authentication"
                | "model_not_found"
                | "rate_limit"
                | "provider_5xx"
                | "provider_timeout"
                | "transport"
                | "provider_disconnected"
                | "model_unavailable"
                | "configuration"
                | "permission_receipt_mismatch"
                | "application_restart"
                | "execution" => reported_category,
                _ => "execution",
            };
            let reported_boundary = body
                .get("effectBoundary")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            // The harness is outside the product database's trust boundary. Unknown or
            // malformed effect claims must fail closed rather than leaving a running attempt
            // behind because a database CHECK rejected the value.
            let boundary = match reported_boundary {
                "none" | "partial_output" | "graph_write" | "tool_effect" | "unknown" => {
                    reported_boundary
                }
                _ => "unknown",
            };
            let model_related = matches!(
                category,
                "authentication"
                    | "model_not_found"
                    | "rate_limit"
                    | "provider_5xx"
                    | "provider_timeout"
                    | "transport"
                    | "provider_disconnected"
                    | "model_unavailable"
            );
            return (category, boundary, model_related);
        }
        ("execution", "unknown", false)
    }

    pub(crate) fn graph_node_id(&self) -> Option<i64> {
        match self {
            Self::Completion { graph_node_id, .. } => Some(*graph_node_id),
            Self::Cleanup { operation, .. } => operation.graph_node_id(),
            _ => None,
        }
    }

    pub(crate) fn safe_failure_message(&self) -> &'static str {
        let (category, _, _) = self.attempt_failure();
        match category {
            "authentication" | "provider_disconnected" => {
                "The selected provider is not connected. Reconnect it or choose another model."
            }
            "model_not_found" | "model_unavailable" => {
                "The selected model is no longer available. Choose another model and send again."
            }
            "rate_limit" => {
                "The selected provider is rate limited. Choose another model or try again later."
            }
            "provider_5xx" | "provider_timeout" | "transport" => {
                "The selected provider could not complete this turn. Choose an available model and send again."
            }
            "configuration" => "The selected harness or provider configuration is unavailable.",
            "permission_receipt_mismatch" => "The runtime returned an invalid permission receipt.",
            "application_restart" => "The attempt was interrupted by an application restart.",
            _ => "The harness could not complete this attempt.",
        }
    }

    pub(crate) fn is_retryable_startup_failure(&self) -> bool {
        match self {
            Self::Timeout(_) | Self::Io(_) | Self::ResponseDecode(_) => true,
            Self::Remote { status, .. } => matches!(*status, 408 | 425 | 429) || *status >= 500,
            Self::Http(error) => error.is_timeout() || error.is_connect() || error.is_request(),
            // The primary operation determines whether recovery is safe to retry. A transient
            // capability-cleanup failure must not turn a deterministic protocol violation into
            // a resumable lease.
            Self::Cleanup { operation, .. } => operation.is_retryable_startup_failure(),
            Self::Completion { operation, .. } => operation.is_retryable_startup_failure(),
            Self::Configuration(_)
            | Self::Protocol(_)
            | Self::PermissionUnsupported { .. }
            | Self::Json(_)
            | Self::Url(_) => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        CONTROL_REQUEST_TIMEOUT, CompleteInteraction, HarnessConfiguration, PreparedInteraction,
        PreparedInvocation, RuntimeClient, RuntimeError,
    };
    use crate::{permissions::PermissionProfile, product::ExecutionHarnessPolicy};
    use axum::{
        Json, Router,
        http::{HeaderMap, StatusCode, Uri},
        response::IntoResponse,
        routing,
    };
    use serde_json::{Value, json};
    use std::{
        fs,
        path::Path,
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
        time::{Duration, SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn harness_effect_boundary_is_allowlisted_and_unknown_values_fail_closed() {
        for boundary in [
            "none",
            "partial_output",
            "graph_write",
            "tool_effect",
            "unknown",
        ] {
            let error = super::RuntimeError::Remote {
                status: 500,
                body: json!({
                    "failureCategory": "provider_timeout",
                    "effectBoundary": boundary,
                }),
            };
            assert_eq!(
                error.attempt_failure(),
                ("provider_timeout", boundary, true)
            );
        }
        let invalid = super::RuntimeError::Remote {
            status: 500,
            body: json!({
                "failureCategory": "provider_timeout",
                "effectBoundary": "definitely_safe",
            }),
        };
        assert_eq!(
            invalid.attempt_failure(),
            ("provider_timeout", "unknown", true)
        );
        let invalid_category = super::RuntimeError::Remote {
            status: 500,
            body: json!({
                "failureCategory": "secret value from an untrusted harness",
                "effectBoundary": "none",
            }),
        };
        assert_eq!(
            invalid_category.attempt_failure(),
            ("execution", "none", false)
        );
    }

    #[test]
    fn startup_retry_classification_follows_the_primary_runtime_failure() {
        assert!(
            RuntimeError::Remote {
                status: 503,
                body: json!({}),
            }
            .is_retryable_startup_failure()
        );
        assert!(
            !RuntimeError::Remote {
                status: 409,
                body: json!({}),
            }
            .is_retryable_startup_failure()
        );

        let failure = RuntimeError::Cleanup {
            operation: Box::new(RuntimeError::Protocol("wrong node identity".into())),
            cleanup: Box::new(RuntimeError::Timeout("capability cleanup")),
        };
        assert!(!failure.is_retryable_startup_failure());
    }

    #[tokio::test]
    async fn invoked_start_returns_attachment_before_graph_terminal_and_cancels_exact_completion() {
        let graph_observations = Arc::new(AtomicUsize::new(0));
        let current_observations = graph_observations.clone();
        let output_observations = graph_observations.clone();
        let graph = Router::new()
            .route(
                "/api/control/temporal-features",
                routing::get(|| async {
                    Json(json!({
                        "configVersion": 1,
                        "schemaRead": true,
                        "rootCurrentWrite": true,
                        "projectionUi": true,
                        "invokeResolution": true,
                        "providerRecursion": true
                    }))
                }),
            )
            .route(
                "/api/control/interactions/41/current",
                routing::get(move |headers: HeaderMap| {
                    let current_observations = current_observations.clone();
                    async move {
                        assert_eq!(headers["authorization"], "Bearer graph-control");
                        current_observations.fetch_add(1, Ordering::SeqCst);
                        Json(json!({
                            "completionId": 41,
                            "lifecycle": "active",
                            "headRevision": 0,
                            "currentLayerId": null,
                            "finalLayerId": null,
                            "safeReason": null,
                            "temporalFeatures": {
                                "configVersion": 1,
                                "schemaRead": true,
                                "rootCurrentWrite": true,
                                "projectionUi": true,
                                "invokeResolution": true,
                                "providerRecursion": true
                            }
                        }))
                    }
                }),
            )
            .route(
                "/api/control/interactions/41/output",
                routing::get(move |headers: HeaderMap| {
                    let output_observations = output_observations.clone();
                    async move {
                        assert_eq!(headers["authorization"], "Bearer graph-control");
                        output_observations.fetch_add(1, Ordering::SeqCst);
                        Json(json!({ "nodeId": 41, "rootLayer": { "layer": { "id": 9 } } }))
                    }
                }),
            );
        let starts = Arc::new(AtomicUsize::new(0));
        let observed_starts = starts.clone();
        let harness = Router::new()
            .route(
                "/sessions/7/invoked-completions",
                routing::post(move |headers: HeaderMap, Json(body): Json<Value>| {
                    let observed_starts = observed_starts.clone();
                    async move {
                        assert_eq!(headers["authorization"], "Bearer harness-control");
                        assert_eq!(
                            body,
                            json!({
                                "capability": {
                                    "url": body["capability"]["url"],
                                    "token": "child-token",
                                    "nodeId": 41
                                },
                                "origin": {
                                    "kind": "invoke",
                                    "sourceCompletionId": 17,
                                    "actionId": 23
                                }
                            })
                        );
                        observed_starts.fetch_add(1, Ordering::SeqCst);
                        (
                            StatusCode::CREATED,
                            Json(json!({
                                "completionId": 41,
                                "attachment": {
                                    "schemaVersion": 1,
                                    "provider": "codex",
                                    "threadId": "native-thread",
                                    "turnId": "native-turn"
                                }
                            })),
                        )
                    }
                }),
            )
            .route(
                "/sessions/7/cancel",
                routing::post(
                    |headers: HeaderMap, uri: Uri, Json(body): Json<Value>| async move {
                        assert_eq!(headers["authorization"], "Bearer harness-control");
                        assert_eq!(uri.query(), Some("completionId=41"));
                        assert_eq!(body, json!({}));
                        Json(json!({ "cancelled": true }))
                    },
                ),
            );
        let (graph_url, graph_task) = serve(graph).await;
        let (harness_url, harness_task) = serve(harness).await;
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "relayer-runtime-invoked-start-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        let catalog = root.join("catalog.json");
        fs::write(
            &catalog,
            json!({"schemaVersion":1,"configurations":[{"configuration":{
                "schemaVersion":1,"name":"test","implementation":"test",
                "implementationVersion":1,"permissionBindings":{"auto":{}},"settings":{}
            },"digest":"sha256:test"}]})
            .to_string(),
        )
        .unwrap();
        let runtime = RuntimeClient::open(
            &graph_url,
            &harness_url,
            "graph-control".into(),
            "harness-control".into(),
            &catalog,
        )
        .await
        .unwrap();
        let prepared = PreparedInteraction {
            graph_node_id: 41,
            graph_token: "child-token".into(),
            harness_policy: None,
            harness_configuration_name: "test".into(),
            harness_configuration_digest: "sha256:test".into(),
            permission_profile_id: "auto".into(),
            effective_execution_digest: "sha256:execution".into(),
            effective_permission_receipt: json!({}),
            configuration: HarnessConfiguration {
                schema_version: 1,
                name: "test".into(),
                implementation: "test".into(),
                implementation_version: 1,
                revision: 1,
                permission_bindings: serde_json::Map::from_iter([("auto".into(), json!({}))]),
                model_compatibility: vec![],
                model_rules: None,
                execution_access_contracts: vec![],
                model_defaults: None,
                settings: json!({}),
            },
            model_selection: None,
            personal_presentation_version_id: None,
        };

        let started = runtime
            .start_invoked_completion(
                7,
                &prepared,
                PreparedInvocation {
                    source_interaction_node_id: 17,
                    source_action_id: 23,
                },
                None,
            )
            .await
            .unwrap();
        assert_eq!(started.completion_id, 41);
        assert_eq!(
            started.attachment,
            json!({
                "schemaVersion": 1,
                "provider": "codex",
                "threadId": "native-thread",
                "turnId": "native-turn"
            })
            .as_object()
            .cloned()
        );
        assert_eq!(starts.load(Ordering::SeqCst), 1);
        assert_eq!(graph_observations.load(Ordering::SeqCst), 0);

        let current = runtime.completion_current(41).await.unwrap();
        assert_eq!(current.completion_id.value(), 41);
        assert_eq!(
            current.lifecycle,
            relayer_graph_core::CompletionLifecycle::Active
        );
        assert!(runtime.completion_output(41).await.unwrap().is_some());
        assert_eq!(graph_observations.load(Ordering::SeqCst), 2);
        assert!(runtime.cancel_invoked_completion(7, 41).await.unwrap());

        graph_task.abort();
        harness_task.abort();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invoked_start_acknowledgement_is_strict_and_attachment_is_an_object() {
        assert!(
            serde_json::from_value::<super::RuntimeInvokedCompletionStart>(json!({
                "completionId": 41,
                "attachment": {},
                "unexpected": true
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<super::RuntimeInvokedCompletionStart>(json!({
                "completionId": 41,
                "attachment": ["not", "opaque", "object"]
            }))
            .is_err()
        );
    }

    #[test]
    fn configuration_owned_model_omits_empty_compatibility_when_forwarded() {
        let configuration: HarnessConfiguration = serde_json::from_value(json!({
            "schemaVersion": 1,
            "name": "configuration-owned-model",
            "implementation": "test",
            "implementationVersion": 1,
            "permissionBindings": { "auto": {} },
            "settings": { "model": "pinned-model" }
        }))
        .unwrap();

        let forwarded = serde_json::to_value(configuration).unwrap();

        assert!(forwarded.get("modelCompatibility").is_none());
        assert!(forwarded.get("modelRules").is_none());
        assert!(forwarded.get("executionAccessContracts").is_none());
        assert!(forwarded.get("modelDefaults").is_none());
    }

    #[tokio::test]
    async fn unavailable_catalog_entries_are_visible_but_never_executable() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let catalog = std::env::temp_dir().join(format!(
            "relayer-unavailable-runtime-{}-{unique}.json",
            std::process::id()
        ));
        fs::write(
            &catalog,
            json!({
                "schemaVersion": 1,
                "configurations": [],
                "unavailableConfigurations": [{
                    "name": "prime-agent-basic",
                    "reason": {
                        "code": "prime_agent_boundary_unsupported",
                        "message": "Prime Agent Ask and Auto require macOS. Choose another available harness on this device."
                    },
                    "diagnostics": {
                        "sourceCommit": "f6130839ad3043f1cd3d5294fe03023035bfcd5c",
                        "packages": [{"name": "@earendil-works/pi-coding-agent", "version": "0.8.1"}]
                    }
                }]
            })
            .to_string(),
        )
        .unwrap();
        let runtime = RuntimeClient::open(
            "http://127.0.0.1:1",
            "http://127.0.0.1:2",
            "graph-control".into(),
            "harness-control".into(),
            &catalog,
        )
        .await
        .unwrap();
        assert!(!runtime.has_configuration("prime-agent-basic"));
        let harness = runtime.product_harnesses().pop().unwrap();
        assert!(!harness.runtime_available);
        assert_eq!(
            harness.unavailable_reason.unwrap().code,
            "prime_agent_boundary_unsupported"
        );
        assert!(harness.model_rules.is_none());
        assert!(harness.execution_access_contracts.is_empty());
        fs::remove_file(catalog).unwrap();
    }

    #[test]
    fn absent_model_rules_match_the_host_harness_policy_digest() {
        let policy = ExecutionHarnessPolicy {
            configuration_revision: 7,
            configuration_digest: "sha256:test".into(),
            model_rules: None,
            execution_access_contracts: vec!["managed-runtime@1".into()],
        };

        let serialized = serde_json::to_value(&policy).unwrap();
        assert_eq!(
            serialized,
            json!({
                "configurationRevision": 7,
                "configurationDigest": "sha256:test",
                "executionAccessContracts": ["managed-runtime@1"]
            })
        );
        assert_eq!(
            super::harness_policy_digest(&policy).unwrap(),
            "sha256:3481694b27c6a207f740f67968966c423a8b2e2172d8707d913f44a33c649f61"
        );
    }

    #[tokio::test]
    async fn rejects_shared_graph_and_harness_control_authority() {
        let error = RuntimeClient::open(
            "http://127.0.0.1:1234/",
            "http://127.0.0.1:5678/",
            "shared".to_owned(),
            "shared".to_owned(),
            Path::new("/not-read"),
        )
        .await
        .err()
        .unwrap();

        assert!(error.to_string().contains("must be distinct"));
    }

    #[tokio::test]
    async fn missing_personal_presentation_contract_fails_runtime_detection() {
        let (graph_url, graph_task) = serve(Router::new()).await;
        let catalog = tempfile::NamedTempFile::new().unwrap();
        fs::write(
            catalog.path(),
            json!({"schemaVersion":1,"configurations":[{"configuration":{
                "schemaVersion":1,"name":"test","implementation":"test",
                "implementationVersion":1,"permissionBindings":{"auto":{}},"settings":{}
            },"digest":"sha256:test"}]})
            .to_string(),
        )
        .unwrap();
        let mut runtime = RuntimeClient::open(
            &graph_url,
            "http://127.0.0.1:2/",
            "graph-control".into(),
            "harness-control".into(),
            catalog.path(),
        )
        .await
        .unwrap();

        let error = runtime
            .detect_personal_presentation_support()
            .await
            .unwrap_err();
        assert!(matches!(error, RuntimeError::Remote { status: 404, .. }));
        assert!(!runtime.supports_personal_presentation());
        graph_task.abort();
    }

    #[tokio::test]
    async fn personal_presentation_contract_probe_times_out_when_headers_stall() {
        let (graph_url, graph_task) = serve(Router::new().route(
            "/api/control/personal-presentation",
            routing::get(|| async {
                tokio::time::sleep(Duration::from_secs(30)).await;
                Json(json!({"schemaVersion": 1}))
            }),
        ))
        .await;
        let catalog = tempfile::NamedTempFile::new().unwrap();
        fs::write(
            catalog.path(),
            json!({"schemaVersion":1,"configurations":[{"configuration":{
                "schemaVersion":1,"name":"test","implementation":"test",
                "implementationVersion":1,"permissionBindings":{"auto":{}},"settings":{}
            },"digest":"sha256:test"}]})
            .to_string(),
        )
        .unwrap();
        let mut runtime = RuntimeClient::open(
            &graph_url,
            "http://127.0.0.1:2/",
            "graph-control".into(),
            "harness-control".into(),
            catalog.path(),
        )
        .await
        .unwrap();

        let bounded = tokio::time::timeout(
            CONTROL_REQUEST_TIMEOUT + Duration::from_secs(1),
            runtime.detect_personal_presentation_support(),
        )
        .await
        .expect("the contract probe must honor its request timeout")
        .unwrap_err();
        assert!(matches!(bounded, RuntimeError::Http(ref error) if error.is_timeout()));
        assert!(!runtime.supports_personal_presentation());
        graph_task.abort();
    }

    #[tokio::test]
    async fn accepted_graph_closure_times_out_when_headers_stall() {
        let (graph_url, graph_task) = serve(Router::new().route(
            "/api/control/interactions/1/accepted-closure",
            routing::get(|| async {
                tokio::time::sleep(Duration::from_secs(30)).await;
                Json(json!({"rootLayerId": 1, "layers": []}))
            }),
        ))
        .await;
        let catalog = tempfile::NamedTempFile::new().unwrap();
        fs::write(
            catalog.path(),
            json!({"schemaVersion":1,"configurations":[{"configuration":{
                "schemaVersion":1,"name":"test","implementation":"test",
                "implementationVersion":1,"permissionBindings":{"auto":{}},"settings":{}
            },"digest":"sha256:test"}]})
            .to_string(),
        )
        .unwrap();
        let runtime = RuntimeClient::open(
            &graph_url,
            "http://127.0.0.1:2/",
            "graph-control".into(),
            "harness-control".into(),
            catalog.path(),
        )
        .await
        .unwrap();

        let bounded = tokio::time::timeout(
            CONTROL_REQUEST_TIMEOUT + Duration::from_secs(1),
            runtime.accepted_graph_closure(1),
        )
        .await
        .expect("the accepted-closure read must honor its request timeout")
        .unwrap_err();
        assert!(matches!(bounded, RuntimeError::Http(ref error) if error.is_timeout()));
        graph_task.abort();
    }

    #[tokio::test]
    async fn invoke_and_identified_prepare_retry_lost_create_responses_with_stable_identity() {
        let creates = Arc::new(AtomicUsize::new(0));
        let observed_creates = creates.clone();
        let identified_creates = Arc::new(AtomicUsize::new(0));
        let observed_identified = identified_creates.clone();
        let graph = Router::new()
            .route(
                "/api/control/interactions",
                routing::post(move |Json(body): Json<serde_json::Value>| {
                    let observed_creates = observed_creates.clone();
                    let observed_identified = observed_identified.clone();
                    async move {
                        if body["inputIdentity"] == "product:99" {
                            assert_eq!(body["inputDigest"], "sha256:v1:stable");
                            if observed_identified.fetch_add(1, Ordering::SeqCst) < 2 {
                                return (StatusCode::OK, "response was truncated").into_response();
                            }
                            return Json(json!({
                                "node": { "id": 42 }, "graphToken": "",
                                "inputIdentity": "product:99", "inputDigest": "sha256:v1:stable"
                            }))
                            .into_response();
                        }
                        assert_eq!(body["invocation"]["sourceInteractionNodeId"], 17);
                        assert_eq!(body["invocation"]["sourceActionId"], 23);
                        if observed_creates.fetch_add(1, Ordering::SeqCst) < 2 {
                            return (StatusCode::OK, "response was truncated").into_response();
                        }
                        Json(json!({ "node": { "id": 41 }, "graphToken": "" })).into_response()
                    }
                }),
            )
            .route(
                "/api/control/capabilities",
                routing::delete(|| async { Json(json!({ "revoked": true })) }),
            );
        let (graph_url, graph_task) = serve(graph).await;
        let (harness_url, harness_task) = serve(Router::new()).await;
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "relayer-runtime-create-retry-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        let catalog = root.join("catalog.json");
        fs::write(
            &catalog,
            json!({
                "schemaVersion":1,
                "configurations":[{"configuration":{
                    "schemaVersion":1,"name":"test","implementation":"test",
                    "implementationVersion":1,"permissionBindings":{"auto":{}},"settings":{}
                },"digest":"sha256:test"}]
            })
            .to_string(),
        )
        .unwrap();
        let runtime = RuntimeClient::open(
            &graph_url,
            &harness_url,
            "graph-control".into(),
            "harness-control".into(),
            &catalog,
        )
        .await
        .unwrap();
        let permission_profile = PermissionProfile {
            id: "auto".into(),
            label: "Approve for me".into(),
            authority: "bounded".into(),
            reviewer: "automatic".into(),
        };
        let command = CompleteInteraction {
            project_id: None,
            product_interaction_id: 1,
            thread_id: 1,
            interaction_id: 1,
            text: "question",
            working_directory: root.to_str().unwrap(),
            harness_configuration_name: "test",
            permission_profile: &permission_profile,
            model_selection: None,
            model_plan: None,
            attempt_admission_id: None,
            execution_lease_id: None,
            harness_policy: None,
            invocation: Some(PreparedInvocation {
                source_interaction_node_id: 17,
                source_action_id: 23,
            }),
            input_identity: None,
            input_digest: None,
            contexts: &[],
            personal_presentation: None,
        };

        let prepared = runtime.prepare(&command).await.unwrap();
        assert_eq!(prepared.graph_node_id, 41);
        assert_eq!(creates.load(Ordering::SeqCst), 3);
        runtime.discard_prepared(prepared).await.unwrap();
        let identified = CompleteInteraction {
            project_id: None,
            product_interaction_id: 99,
            thread_id: 1,
            interaction_id: 99,
            text: "question",
            working_directory: root.to_str().unwrap(),
            harness_configuration_name: "test",
            permission_profile: &permission_profile,
            model_selection: None,
            model_plan: None,
            attempt_admission_id: None,
            execution_lease_id: None,
            harness_policy: None,
            invocation: None,
            input_identity: Some("product:99"),
            input_digest: Some("sha256:v1:stable"),
            contexts: &[],
            personal_presentation: None,
        };
        let prepared = runtime.prepare(&identified).await.unwrap();
        assert_eq!(prepared.graph_node_id, 42);
        assert_eq!(identified_creates.load(Ordering::SeqCst), 3);
        runtime.discard_prepared(prepared).await.unwrap();
        graph_task.abort();
        harness_task.abort();
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn retries_personal_presentation_publication_with_stable_identity() {
        let publications = Arc::new(AtomicUsize::new(0));
        let observed = publications.clone();
        let graph = Router::new().route(
            "/api/control/personal-presentation/versions",
            routing::post(move || {
                let observed = observed.clone();
                async move {
                    if observed.fetch_add(1, Ordering::SeqCst)
                        < super::CONTROL_RETRY_ATTEMPTS as usize - 1
                    {
                        (StatusCode::OK, "invalid json")
                    } else {
                        (StatusCode::OK, "{}")
                    }
                }
            }),
        );
        let (graph_url, graph_task) = serve(graph).await;
        let (harness_url, harness_task) = serve(Router::new()).await;
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "relayer-personal-presentation-publication-retry-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        let catalog = root.join("catalog.json");
        fs::write(
            &catalog,
            json!({"schemaVersion":1,"configurations":[]}).to_string(),
        )
        .unwrap();
        let runtime = RuntimeClient::open(
            &graph_url,
            &harness_url,
            "graph-control".into(),
            "harness-control".into(),
            &catalog,
        )
        .await
        .unwrap();

        runtime
            .publish_personal_presentation_version(90)
            .await
            .unwrap();

        assert_eq!(
            publications.load(Ordering::SeqCst),
            super::CONTROL_RETRY_ATTEMPTS as usize
        );
        graph_task.abort();
        harness_task.abort();
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn materializes_built_in_personal_presentation_versions_as_ordinary_completions() {
        let graph = relayer_graph_core::GraphDatabase::in_memory()
            .await
            .unwrap();
        let graph_reader = graph.clone();
        let graph_app = relayer_graph_server::router(relayer_graph_server::ServerState::new(
            graph,
            "graph-control",
        ));
        let (graph_url, graph_task) = serve(graph_app).await;
        let (harness_url, harness_task) = serve(Router::new()).await;
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "relayer-personal-presentation-runtime-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        let catalog = root.join("catalog.json");
        fs::write(
            &catalog,
            json!({
                "schemaVersion":1,
                "configurations":[{"configuration":{
                    "schemaVersion":1,"name":"test","implementation":"test",
                    "implementationVersion":1,"permissionBindings":{"auto":{}},"settings":{}
                },"digest":"sha256:test"}]
            })
            .to_string(),
        )
        .unwrap();
        let runtime = RuntimeClient::open(
            &graph_url,
            &harness_url,
            "graph-control".into(),
            "harness-control".into(),
            &catalog,
        )
        .await
        .unwrap();

        let v0 = runtime
            .ensure_personal_presentation_version("personal-presentation-v0")
            .await
            .unwrap();
        assert_eq!(
            v0.closure.layers[0].nodes[0].kind,
            "personal-presentation-manifest"
        );
        let v1 = runtime
            .ensure_personal_presentation_version("personal-presentation-v1")
            .await
            .unwrap();
        assert_eq!(
            v1.closure.layers[0]
                .nodes
                .iter()
                .map(|node| node.title.as_str())
                .collect::<Vec<_>>(),
            vec!["Decision-useful center", "Adaptive progressive disclosure"]
        );
        assert_eq!(v1.closure.layers[0].edges.len(), 1);
        let replay = runtime
            .ensure_personal_presentation_version("personal-presentation-v1")
            .await
            .unwrap();
        assert_eq!(replay.interaction_node_id, v1.interaction_node_id);
        assert_eq!(replay.root_layer_id, v1.root_layer_id);
        let ordinary = graph_reader
            .create_interaction(
                None,
                relayer_graph_core::ThreadId::new(900).unwrap(),
                "ordinary standalone interaction",
            )
            .await
            .unwrap();
        let ordinary_writer = graph_reader.writer_for_subgraph(ordinary.id).await.unwrap();
        assert!(
            ordinary_writer
                .get_node(v1.closure.layers[0].nodes[0].id)
                .await
                .is_err(),
            "an ordinary standalone thread must not see the reserved profile graph"
        );

        graph_task.abort();
        harness_task.abort();
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn invoke_prepare_bounds_permanent_invalid_json_and_transport_outage() {
        let creates = Arc::new(AtomicUsize::new(0));
        let observed = creates.clone();
        let graph = Router::new().route(
            "/api/control/interactions",
            routing::post(move || {
                let observed = observed.clone();
                async move {
                    observed.fetch_add(1, Ordering::SeqCst);
                    (StatusCode::OK, "permanently invalid json")
                }
            }),
        );
        let (graph_url, graph_task) = serve(graph).await;
        let (harness_url, harness_task) = serve(Router::new()).await;
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "relayer-runtime-bounded-retry-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        let catalog = root.join("catalog.json");
        fs::write(
            &catalog,
            json!({"schemaVersion":1,"configurations":[{"configuration":{
                "schemaVersion":1,"name":"test","implementation":"test",
                "implementationVersion":1,"permissionBindings":{"auto":{}},"settings":{}
            },"digest":"sha256:test"}]})
            .to_string(),
        )
        .unwrap();
        let runtime = RuntimeClient::open(
            &graph_url,
            &harness_url,
            "graph-control".into(),
            "harness-control".into(),
            &catalog,
        )
        .await
        .unwrap();
        let permission_profile = PermissionProfile {
            id: "auto".into(),
            label: "Approve for me".into(),
            authority: "bounded".into(),
            reviewer: "automatic".into(),
        };
        let command = CompleteInteraction {
            project_id: None,
            product_interaction_id: 1,
            thread_id: 1,
            interaction_id: 1,
            text: "question",
            working_directory: root.to_str().unwrap(),
            harness_configuration_name: "test",
            permission_profile: &permission_profile,
            model_selection: None,
            model_plan: None,
            attempt_admission_id: None,
            execution_lease_id: None,
            harness_policy: None,
            invocation: Some(PreparedInvocation {
                source_interaction_node_id: 17,
                source_action_id: 23,
            }),
            input_identity: None,
            input_digest: None,
            contexts: &[],
            personal_presentation: None,
        };
        let error = runtime.prepare(&command).await.unwrap_err();
        assert!(matches!(&error, super::RuntimeError::ResponseDecode(_)));
        assert!(error.is_retryable_startup_failure());
        assert_eq!(
            creates.load(Ordering::SeqCst),
            super::CONTROL_RETRY_ATTEMPTS as usize
        );

        let unavailable = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let unavailable_url = format!("http://{}/", unavailable.local_addr().unwrap());
        drop(unavailable);
        let unavailable_runtime = RuntimeClient::open(
            &unavailable_url,
            &harness_url,
            "graph-control".into(),
            "harness-control".into(),
            &catalog,
        )
        .await
        .unwrap();
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            unavailable_runtime.prepare(&command),
        )
        .await;
        assert!(matches!(result, Ok(Err(super::RuntimeError::Http(_)))));
        graph_task.abort();
        harness_task.abort();
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn retries_capability_revocation_when_session_registration_fails() {
        let revocations = Arc::new(AtomicUsize::new(0));
        let observed_revocations = revocations.clone();
        let graph = Router::new()
            .route(
                "/api/control/interactions",
                routing::post(|headers: HeaderMap| async move {
                    assert_eq!(headers["authorization"], "Bearer graph-control");
                    Json(json!({ "node": { "id": 41 }, "graphToken": "" }))
                }),
            )
            .route(
                "/api/control/capabilities",
                routing::post(|Json(body): Json<Value>| async move {
                    Json(json!({"graphToken": body["graphToken"]}))
                })
                .delete(move |headers: HeaderMap| {
                    let observed_revocations = observed_revocations.clone();
                    async move {
                        assert_eq!(headers["authorization"], "Bearer graph-control");
                        if observed_revocations.fetch_add(1, Ordering::SeqCst) == 0 {
                            return (StatusCode::OK, "response was truncated").into_response();
                        }
                        Json(json!({ "revoked": true })).into_response()
                    }
                }),
            );
        let harness = Router::new().route(
            "/sessions",
            routing::post(|headers: HeaderMap| async move {
                assert_eq!(headers["authorization"], "Bearer harness-control");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "error": "registration failed" })),
                )
            }),
        );
        let (graph_url, graph_task) = serve(graph).await;
        let (harness_url, harness_task) = serve(harness).await;
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "relayer-runtime-capability-cleanup-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        let catalog = root.join("catalog.json");
        fs::write(
            &catalog,
            json!({
                "schemaVersion": 1,
                "configurations": [{
                    "configuration": {
                        "schemaVersion": 1,
                        "name": "test",
                        "implementation": "test",
                        "implementationVersion": 1,
                        "permissionBindings": { "auto": {} },
                        "settings": {}
                    },
                    "digest": "sha256:test"
                }]
            })
            .to_string(),
        )
        .unwrap();
        let runtime = RuntimeClient::open(
            &graph_url,
            &harness_url,
            "graph-control".to_owned(),
            "harness-control".to_owned(),
            &catalog,
        )
        .await
        .unwrap();
        let permission_profile = PermissionProfile {
            id: "auto".into(),
            label: "Approve for me".into(),
            authority: "bounded".into(),
            reviewer: "automatic".into(),
        };

        let result = runtime
            .complete(CompleteInteraction {
                project_id: None,
                product_interaction_id: 1,
                thread_id: 1,
                interaction_id: 7,
                text: "question",
                working_directory: root.to_str().unwrap(),
                harness_configuration_name: "test",
                permission_profile: &permission_profile,
                model_selection: None,
                model_plan: None,
                attempt_admission_id: None,
                execution_lease_id: None,
                harness_policy: None,
                invocation: None,
                input_identity: None,
                input_digest: None,
                contexts: &[],
                personal_presentation: None,
            })
            .await;

        assert!(result.is_err());
        assert_eq!(revocations.load(Ordering::SeqCst), 2);
        graph_task.abort();
        harness_task.abort();
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn revokes_the_interaction_capability_after_successful_completion() {
        let revocations = Arc::new(AtomicUsize::new(0));
        let observed_revocations = revocations.clone();
        let attachments = Arc::new(AtomicUsize::new(0));
        let observed_attachments = attachments.clone();
        let graph = Router::new()
            .route(
                "/api/control/interactions",
                routing::post(|headers: HeaderMap| async move {
                    assert_eq!(headers["authorization"], "Bearer graph-control");
                    Json(json!({ "node": { "id": 41 }, "graphToken": "" }))
                }),
            )
            .route(
                "/api/control/interactions/{id}/personal-presentation",
                routing::post(move |Json(body): Json<Value>| {
                    let observed_attachments = observed_attachments.clone();
                    async move {
                        assert_eq!(body["versionInteractionNodeId"], 90);
                        if observed_attachments.fetch_add(1, Ordering::SeqCst) < 2 {
                            return (StatusCode::OK, "response was truncated").into_response();
                        }
                        Json(json!({
                            "interactionNodeId": 41,
                            "versionInteractionNodeId": 90,
                            "rootLayerId": 91,
                        }))
                        .into_response()
                    }
                }),
            )
            .route(
                "/api/control/capabilities",
                routing::post(|Json(body): Json<Value>| async move {
                    Json(json!({"graphToken": body["graphToken"]}))
                })
                .delete(move |headers: HeaderMap| {
                    let observed_revocations = observed_revocations.clone();
                    async move {
                        assert_eq!(headers["authorization"], "Bearer graph-control");
                        observed_revocations.fetch_add(1, Ordering::SeqCst);
                        Json(json!({ "revoked": true }))
                    }
                }),
            );
        let harness = Router::new()
            .route(
                "/sessions",
                routing::post(|headers: HeaderMap| async move {
                    assert_eq!(headers["authorization"], "Bearer harness-control");
                    (StatusCode::CREATED, Json(json!({ "ok": true })))
                }),
            )
            .route(
                "/sessions/1/complete",
                routing::post(|headers: HeaderMap, Json(body): Json<Value>| async move {
                    assert_eq!(headers["authorization"], "Bearer harness-control");
                    assert_eq!(body["interactionId"], 7);
                    assert_eq!(body["graph"]["nodeId"], 41);
                    assert_eq!(body["traceContext"]["personalPresentationVersionId"], 90);
                    Json(json!({ "output": { "nodeId": 41 } }))
                }),
            )
            .route(
                "/sessions/1/approval-events",
                routing::get(|| async {
                    Json(json!({
                        "harnessSessionId": "session-1",
                        "latestSequence": 0,
                        "pendingRequests": [],
                        "events": []
                    }))
                }),
            );
        let (graph_url, graph_task) = serve(graph).await;
        let (harness_url, harness_task) = serve(harness).await;
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "relayer-runtime-capability-owner-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        let catalog = root.join("catalog.json");
        fs::write(
            &catalog,
            json!({
                "schemaVersion": 1,
                "configurations": [{
                    "configuration": {
                        "schemaVersion": 1,
                        "name": "test",
                        "implementation": "test",
                        "implementationVersion": 1,
                        "permissionBindings": { "auto": {} },
                        "settings": {}
                    },
                    "digest": "sha256:test"
                }]
            })
            .to_string(),
        )
        .unwrap();
        let runtime = RuntimeClient::open(
            &graph_url,
            &harness_url,
            "graph-control".to_owned(),
            "harness-control".to_owned(),
            &catalog,
        )
        .await
        .unwrap();
        let permission_profile = PermissionProfile {
            id: "auto".into(),
            label: "Approve for me".into(),
            authority: "bounded".into(),
            reviewer: "automatic".into(),
        };

        let personal_presentation = super::PersonalPresentationExecution {
            version_key: "personal-presentation-v1".into(),
            version_interaction_node_id: 90,
            root_layer_id: 91,
        };
        let completed = runtime
            .complete(CompleteInteraction {
                project_id: None,
                product_interaction_id: 1,
                thread_id: 1,
                interaction_id: 7,
                text: "question",
                working_directory: root.to_str().unwrap(),
                harness_configuration_name: "test",
                permission_profile: &permission_profile,
                model_selection: None,
                model_plan: None,
                attempt_admission_id: None,
                execution_lease_id: None,
                harness_policy: None,
                invocation: None,
                input_identity: None,
                input_digest: None,
                contexts: &[],
                personal_presentation: Some(&personal_presentation),
            })
            .await
            .unwrap();

        assert_eq!(completed.output, json!({ "nodeId": 41 }));
        assert_eq!(attachments.load(Ordering::SeqCst), 3);
        assert_eq!(revocations.load(Ordering::SeqCst), 1);
        graph_task.abort();
        harness_task.abort();
        fs::remove_dir_all(root).unwrap();
    }

    async fn serve(app: Router) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{address}/"), task)
    }
}
