use crate::{api, product::ProductService, runtime::RuntimeClient, storage::SqliteProductStore};
use axum::Router;
use std::path::PathBuf;

pub struct RelayerRuntimeConfig {
    pub graph_url: String,
    pub harness_url: String,
    pub control_token: String,
    pub harness_configurations: PathBuf,
    pub default_harness_configuration: String,
    pub allow_harness_override: bool,
    pub standalone_workspaces_directory: PathBuf,
}

pub struct RelayerAppServerConfig {
    pub database_path: PathBuf,
    pub web_directory: PathBuf,
    pub control_token: String,
    pub runtime: Option<RelayerRuntimeConfig>,
}

pub struct RelayerAppServer {
    product: ProductService,
    web_directory: PathBuf,
    control_token: String,
    runtime: Option<RuntimeClient>,
    default_harness_configuration: String,
    allow_harness_override: bool,
    standalone_workspaces_directory: PathBuf,
}

impl RelayerAppServer {
    pub async fn open(config: RelayerAppServerConfig) -> anyhow::Result<Self> {
        let storage = SqliteProductStore::open(&config.database_path).await?;
        let runtime = match &config.runtime {
            Some(runtime) => Some(
                RuntimeClient::open(
                    &runtime.graph_url,
                    &runtime.harness_url,
                    runtime.control_token.clone(),
                    &runtime.harness_configurations,
                )
                .await?,
            ),
            None => None,
        };
        let default_harness_configuration = config
            .runtime
            .as_ref()
            .map(|runtime| runtime.default_harness_configuration.clone())
            .unwrap_or_else(|| "codex-basic".into());
        let allow_harness_override = config
            .runtime
            .as_ref()
            .is_some_and(|runtime| runtime.allow_harness_override);
        let standalone_workspaces_directory = config
            .runtime
            .as_ref()
            .map(|runtime| runtime.standalone_workspaces_directory.clone())
            .unwrap_or_else(|| config.database_path.with_file_name("workspaces"));
        if let Some(runtime) = &runtime
            && !runtime.has_configuration(&default_harness_configuration)
        {
            anyhow::bail!(
                "default harness configuration is unavailable: {default_harness_configuration}"
            );
        }
        Ok(Self {
            product: ProductService::new(storage, runtime.is_some()),
            web_directory: config.web_directory,
            control_token: config.control_token,
            runtime,
            default_harness_configuration,
            allow_harness_override,
            standalone_workspaces_directory,
        })
    }

    pub fn router(&self) -> Router {
        api::router(
            self.product.clone(),
            self.control_token.clone(),
            self.web_directory.clone(),
            self.runtime.clone(),
            self.default_harness_configuration.clone(),
            self.allow_harness_override,
            self.standalone_workspaces_directory.clone(),
        )
    }
}
