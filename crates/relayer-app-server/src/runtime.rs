use reqwest::{Client, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashMap, path::Path};
use thiserror::Error;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HarnessConfiguration {
    schema_version: u32,
    pub(crate) name: String,
    implementation: String,
    implementation_version: u32,
    settings: Value,
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
    control_token: String,
    configurations: HashMap<String, CatalogEntry>,
}

pub(crate) struct CompleteInteraction<'a> {
    pub(crate) project_id: Option<i64>,
    pub(crate) thread_id: i64,
    pub(crate) text: &'a str,
    pub(crate) working_directory: &'a str,
    pub(crate) harness_configuration_name: &'a str,
}

#[derive(Debug)]
pub(crate) struct RuntimeCompletion {
    pub(crate) graph_node_id: i64,
    pub(crate) harness_configuration_name: String,
    pub(crate) harness_configuration_digest: String,
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
        control_token: String,
        catalog_path: &Path,
    ) -> Result<Self, RuntimeError> {
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
            control_token,
            configurations,
        })
    }

    pub(crate) fn has_configuration(&self, name: &str) -> bool {
        self.configurations.contains_key(name)
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
        let interaction: CreateInteractionResponse = self
            .post(
                self.graph_url.join("api/control/interactions")?,
                &serde_json::json!({
                    "projectId": command.project_id,
                    "threadId": command.thread_id,
                    "text": command.text,
                }),
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
                        "workingDirectory": command.working_directory,
                    }),
                    StatusCode::CREATED,
                )
                .await?;
            self.post(
                self.harness_url
                    .join(&format!("sessions/{}/complete", command.thread_id))?,
                &serde_json::json!({"graph": graph}),
                StatusCode::OK,
            )
            .await
        }
        .await;
        let revocation = self.revoke_capability(&interaction.graph_token).await;
        let completed: CompleteResponse = match (completion, revocation) {
            (Ok(completed), Ok(())) => completed,
            (Err(operation), Ok(())) => return Err(operation),
            (Ok(_), Err(cleanup)) => return Err(cleanup),
            (Err(operation), Err(cleanup)) => {
                return Err(RuntimeError::Cleanup {
                    operation: Box::new(operation),
                    cleanup: Box::new(cleanup),
                });
            }
        };
        Ok(RuntimeCompletion {
            graph_node_id: interaction.node.id,
            harness_configuration_name: selected.configuration.name.clone(),
            harness_configuration_digest: selected.digest.clone(),
            output: completed.output,
        })
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
            StatusCode::OK,
        )
        .await
    }

    async fn revoke_capability(&self, graph_token: &str) -> Result<(), RuntimeError> {
        let response = self
            .client
            .delete(self.graph_url.join("api/control/capabilities")?)
            .bearer_auth(&self.control_token)
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
        expected: StatusCode,
    ) -> Result<T, RuntimeError> {
        let response = self
            .client
            .post(url)
            .bearer_auth(&self.control_token)
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
        || configuration.name.trim().is_empty()
        || configuration.implementation.trim().is_empty()
        || !configuration.settings.is_object()
        || !entry.digest.starts_with("sha256:")
    {
        return Err(RuntimeError::Configuration(
            "invalid harness configuration catalog entry".into(),
        ));
    }
    Ok(())
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
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Http(#[from] reqwest::Error),
    #[error(transparent)]
    Url(#[from] url::ParseError),
}

#[cfg(test)]
mod tests {
    use super::{CompleteInteraction, RuntimeClient};
    use axum::{Json, Router, http::StatusCode, routing};
    use serde_json::json;
    use std::{
        fs,
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
        time::{SystemTime, UNIX_EPOCH},
    };

    #[tokio::test]
    async fn revokes_the_interaction_capability_when_session_registration_fails() {
        let revocations = Arc::new(AtomicUsize::new(0));
        let observed_revocations = revocations.clone();
        let graph = Router::new()
            .route(
                "/api/control/interactions",
                routing::post(|| async {
                    Json(json!({ "node": { "id": 41 }, "graphToken": "turn-token" }))
                }),
            )
            .route(
                "/api/control/capabilities",
                routing::delete(move || {
                    let observed_revocations = observed_revocations.clone();
                    async move {
                        observed_revocations.fetch_add(1, Ordering::SeqCst);
                        Json(json!({ "revoked": true }))
                    }
                }),
            );
        let harness = Router::new().route(
            "/sessions",
            routing::post(|| async {
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
                        "settings": {}
                    },
                    "digest": "sha256:test"
                }]
            })
            .to_string(),
        )
        .unwrap();
        let runtime = RuntimeClient::open(&graph_url, &harness_url, "control".to_owned(), &catalog)
            .await
            .unwrap();

        let result = runtime
            .complete(CompleteInteraction {
                project_id: None,
                thread_id: 1,
                text: "question",
                working_directory: root.to_str().unwrap(),
                harness_configuration_name: "test",
            })
            .await;

        assert!(result.is_err());
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
