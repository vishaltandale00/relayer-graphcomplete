use crate::{
    permissions::PermissionProfile,
    product::{
        ExecutionHarnessPolicy, ExecutionModelSelection, FamilyPolicyReference,
        HarnessModelCompatibility, HarnessModelRule, HarnessModelRules, RuntimeProductHarness,
        validate_stable_id,
    },
};
use reqwest::{Client, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, path::Path};
use thiserror::Error;

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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigurationCatalog {
    schema_version: u32,
    configurations: Vec<CatalogEntry>,
}

#[derive(Clone)]
pub(crate) struct RuntimeClient {
    client: Client,
    graph_url: Url,
    harness_url: Url,
    graph_control_token: String,
    harness_control_token: String,
    configurations: HashMap<String, CatalogEntry>,
}

pub(crate) struct CompleteInteraction<'a> {
    pub(crate) project_id: Option<i64>,
    pub(crate) product_interaction_id: i64,
    pub(crate) thread_id: i64,
    pub(crate) text: &'a str,
    pub(crate) working_directory: &'a str,
    pub(crate) harness_configuration_name: &'a str,
    pub(crate) permission_profile: &'a PermissionProfile,
    pub(crate) model_selection: Option<&'a ExecutionModelSelection>,
    pub(crate) execution_lease_id: Option<&'a str>,
    pub(crate) harness_policy: Option<&'a ExecutionHarnessPolicy>,
}

#[derive(Debug)]
pub(crate) struct RuntimeExecutionAdmission {
    pub(crate) execution_lease_id: String,
    pub(crate) adapter_implementation_version: u32,
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeAction {
    pub(crate) id: i64,
    pub(crate) kind: String,
    pub(crate) interaction_text: Option<String>,
    pub(crate) state: String,
}

impl RuntimeClient {
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
        Ok(Self {
            client: Client::new(),
            graph_url: loopback_url(graph_url, "graph")?,
            harness_url: loopback_url(harness_url, "harness")?,
            graph_control_token,
            harness_control_token,
            configurations,
        })
    }

    pub(crate) fn has_configuration(&self, name: &str) -> bool {
        self.configurations.contains_key(name)
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
            })
            .collect::<Vec<_>>();
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

    pub(crate) async fn complete(
        &self,
        command: CompleteInteraction<'_>,
    ) -> Result<RuntimeCompletion, RuntimeError> {
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
        let interaction: CreateInteractionResponse = self
            .post(
                self.graph_url.join("api/control/interactions")?,
                &serde_json::json!({
                    "projectId": command.project_id,
                    "threadId": command.thread_id,
                    "text": command.text,
                }),
                &self.graph_control_token,
                StatusCode::OK,
            )
            .await?;
        let graph = serde_json::json!({
            "url": self.graph_url.as_str().trim_end_matches('/'),
            "token": &interaction.graph_token,
            "nodeId": interaction.node.id,
        });
        let completion = async {
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
            let mut complete_body = serde_json::json!({
                "graph": graph,
                "traceContext": { "productInteractionId": command.product_interaction_id },
            });
            if let Some(model_selection) = command.model_selection {
                complete_body["model"] = serde_json::json!({
                    "providerId": model_selection.provider_id.as_str(),
                    "adapterId": &model_selection.adapter_id,
                    "modelId": &model_selection.model_id,
                });
            }
            if let Some(execution_lease_id) = command.execution_lease_id {
                complete_body["executionLeaseId"] = Value::String(execution_lease_id.to_owned());
            }
            if let Some(harness_policy) = command.harness_policy {
                complete_body["harnessPolicy"] = serde_json::to_value(harness_policy)?;
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
        let revocation = self.revoke_capability(&interaction.graph_token).await;
        let completed: CompleteResponse = match (completion, revocation) {
            (Ok(completed), Ok(())) => completed,
            (Err(operation), Ok(())) => {
                return Err(RuntimeError::Completion {
                    graph_node_id: interaction.node.id,
                    operation: Box::new(operation),
                });
            }
            (Ok(_), Err(cleanup)) => {
                return Err(RuntimeError::Completion {
                    graph_node_id: interaction.node.id,
                    operation: Box::new(cleanup),
                });
            }
            (Err(operation), Err(cleanup)) => {
                return Err(RuntimeError::Completion {
                    graph_node_id: interaction.node.id,
                    operation: Box::new(RuntimeError::Cleanup {
                        operation: Box::new(operation),
                        cleanup: Box::new(cleanup),
                    }),
                });
            }
        };
        let harness_configuration_digest = command
            .harness_policy
            .map(|policy| policy.configuration_digest.as_str())
            .unwrap_or(&selected.digest);
        let effective_execution_digest = effective_execution_digest(
            harness_configuration_digest,
            &command.permission_profile.id,
            command.model_selection,
        );
        let unrestricted = command.permission_profile.authority == "unrestricted";
        Ok(RuntimeCompletion {
            graph_node_id: interaction.node.id,
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
            output: completed.output,
        })
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
                    "model": {
                        "providerId": model.provider_id.as_str(),
                        "adapterId": &model.adapter_id,
                        "modelId": &model.model_id,
                    },
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
        Ok(RuntimeExecutionAdmission {
            execution_lease_id: admitted.execution_lease_id,
            adapter_implementation_version,
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

    pub(crate) async fn get_layer(
        &self,
        interaction_node_id: i64,
        layer_id: i64,
    ) -> Result<Value, RuntimeError> {
        let capability = self.remint_capability(interaction_node_id).await?;
        let response = self
            .client
            .get(
                self.graph_url
                    .join(&format!("api/graph/layers/{layer_id}"))?,
            )
            .bearer_auth(capability.graph_token)
            .send()
            .await?;
        response_json(response, StatusCode::OK).await
    }

    pub(crate) async fn get_action(
        &self,
        interaction_node_id: i64,
        action_id: i64,
    ) -> Result<RuntimeAction, RuntimeError> {
        let capability = self.remint_capability(interaction_node_id).await?;
        let response = self
            .client
            .get(
                self.graph_url
                    .join(&format!("api/graph/actions/{action_id}"))?,
            )
            .bearer_auth(capability.graph_token)
            .send()
            .await?;
        let value = response_json(response, StatusCode::OK).await?;
        Ok(serde_json::from_value(value["action"].clone())?)
    }

    async fn remint_capability(
        &self,
        interaction_node_id: i64,
    ) -> Result<RemintCapabilityResponse, RuntimeError> {
        self.post(
            self.graph_url.join("api/control/capabilities")?,
            &serde_json::json!({"nodeId": interaction_node_id}),
            &self.graph_control_token,
            StatusCode::OK,
        )
        .await
    }

    async fn revoke_capability(&self, graph_token: &str) -> Result<(), RuntimeError> {
        let response = self
            .client
            .delete(self.graph_url.join("api/control/capabilities")?)
            .bearer_auth(&self.graph_control_token)
            .json(&serde_json::json!({"graphToken": graph_token}))
            .send()
            .await?;
        response_json(response, StatusCode::OK).await?;
        Ok(())
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
}

#[derive(Deserialize)]
struct CompleteResponse {
    output: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExecutionAdmissionResponse {
    execution_lease_id: String,
    adapter_implementation_version: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemintCapabilityResponse {
    graph_token: String,
}

async fn response_json(
    response: reqwest::Response,
    expected: StatusCode,
) -> Result<Value, RuntimeError> {
    let status = response.status();
    let value = response.json::<Value>().await.unwrap_or(Value::Null);
    if status != expected {
        return Err(RuntimeError::Remote {
            status: status.as_u16(),
            body: value,
        });
    }
    Ok(value)
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
    format!("sha256:{:x}", digest.finalize())
}

#[derive(Debug, Error)]
pub(crate) enum RuntimeError {
    #[error("runtime configuration error: {0}")]
    Configuration(String),
    #[error("runtime request failed with HTTP {status}: {body}")]
    Remote { status: u16, body: Value },
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
}

#[cfg(test)]
mod tests {
    use super::{CompleteInteraction, HarnessConfiguration, RuntimeClient};
    use crate::permissions::PermissionProfile;
    use axum::{
        Json, Router,
        http::{HeaderMap, StatusCode},
        routing,
    };
    use serde_json::json;
    use std::{
        fs,
        path::Path,
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
        time::{SystemTime, UNIX_EPOCH},
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
    async fn revokes_the_interaction_capability_when_session_registration_fails() {
        let revocations = Arc::new(AtomicUsize::new(0));
        let observed_revocations = revocations.clone();
        let graph = Router::new()
            .route(
                "/api/control/interactions",
                routing::post(|headers: HeaderMap| async move {
                    assert_eq!(headers["authorization"], "Bearer graph-control");
                    Json(json!({ "node": { "id": 41 }, "graphToken": "turn-token" }))
                }),
            )
            .route(
                "/api/control/capabilities",
                routing::delete(move |headers: HeaderMap| {
                    let observed_revocations = observed_revocations.clone();
                    async move {
                        assert_eq!(headers["authorization"], "Bearer graph-control");
                        observed_revocations.fetch_add(1, Ordering::SeqCst);
                        Json(json!({ "revoked": true }))
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
                text: "question",
                working_directory: root.to_str().unwrap(),
                harness_configuration_name: "test",
                permission_profile: &permission_profile,
                model_selection: None,
                execution_lease_id: None,
                harness_policy: None,
            })
            .await;

        assert!(result.is_err());
        assert_eq!(revocations.load(Ordering::SeqCst), 1);
        graph_task.abort();
        harness_task.abort();
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn revokes_the_interaction_capability_after_successful_completion() {
        let revocations = Arc::new(AtomicUsize::new(0));
        let observed_revocations = revocations.clone();
        let graph = Router::new()
            .route(
                "/api/control/interactions",
                routing::post(|headers: HeaderMap| async move {
                    assert_eq!(headers["authorization"], "Bearer graph-control");
                    Json(json!({ "node": { "id": 41 }, "graphToken": "turn-token" }))
                }),
            )
            .route(
                "/api/control/capabilities",
                routing::delete(move |headers: HeaderMap| {
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
                routing::post(|headers: HeaderMap| async move {
                    assert_eq!(headers["authorization"], "Bearer harness-control");
                    Json(json!({ "output": { "nodeId": 41 } }))
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

        let completed = runtime
            .complete(CompleteInteraction {
                project_id: None,
                product_interaction_id: 1,
                thread_id: 1,
                text: "question",
                working_directory: root.to_str().unwrap(),
                harness_configuration_name: "test",
                permission_profile: &permission_profile,
                model_selection: None,
                execution_lease_id: None,
                harness_policy: None,
            })
            .await
            .unwrap();

        assert_eq!(completed.output, json!({ "nodeId": 41 }));
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
