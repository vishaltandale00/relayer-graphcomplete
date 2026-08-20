use crate::{
    api, permissions::PermissionCatalog, product::ProductService, runtime::RuntimeClient,
    storage::SqliteProductStore,
};
use axum::Router;
use std::path::PathBuf;

pub struct RelayerRuntimeConfig {
    pub graph_url: String,
    pub harness_url: String,
    pub graph_control_token: String,
    pub harness_control_token: String,
    pub harness_configurations: PathBuf,
    pub default_harness_configuration: String,
    pub allow_harness_override: bool,
    pub standalone_workspaces_directory: PathBuf,
}

pub struct RelayerAppServerConfig {
    pub database_path: PathBuf,
    pub web_directory: PathBuf,
    pub permission_catalog: PathBuf,
    pub control_token: String,
    pub read_only_control_token: Option<String>,
    pub runtime: Option<RelayerRuntimeConfig>,
}

pub struct RelayerAppServer {
    product: ProductService,
    web_directory: PathBuf,
    control_token: String,
    read_only_control_token: Option<String>,
    runtime: Option<RuntimeClient>,
    permission_catalog: PermissionCatalog,
    default_harness_configuration: String,
    allow_harness_override: bool,
    standalone_workspaces_directory: PathBuf,
}

impl RelayerAppServer {
    pub async fn open(config: RelayerAppServerConfig) -> anyhow::Result<Self> {
        if config.read_only_control_token.as_deref() == Some(config.control_token.as_str()) {
            anyhow::bail!("read-only control token must be distinct from write authority");
        }
        let permission_catalog = PermissionCatalog::load(&config.permission_catalog).await?;
        let storage = SqliteProductStore::open(&config.database_path).await?;
        let interrupted = storage
            .recover_interrupted_action_invocations(
                "Action invocation was interrupted when Relayer stopped. Retry is unavailable while actions use the temporary one-shot UX.",
            )
            .await?;
        if interrupted > 0 {
            eprintln!(
                "marked {interrupted} interrupted action invocation result(s) failed during backend startup"
            );
        }
        let runtime = match &config.runtime {
            Some(runtime) => Some(
                RuntimeClient::open(
                    &runtime.graph_url,
                    &runtime.harness_url,
                    runtime.graph_control_token.clone(),
                    runtime.harness_control_token.clone(),
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
        if let Some(runtime) = &runtime {
            let bindings = runtime.permission_bindings(&default_harness_configuration)?;
            if !permission_catalog
                .availability(Some(bindings))
                .iter()
                .any(|profile| profile.available)
            {
                anyhow::bail!(
                    "default harness configuration has no enabled permission profile: {default_harness_configuration}"
                );
            }
        }
        let runtime_harnesses = runtime
            .as_ref()
            .map(RuntimeClient::product_harnesses)
            .unwrap_or_default();
        storage
            .initialize_model_catalog(&default_harness_configuration, &runtime_harnesses)
            .await?;
        Ok(Self {
            product: ProductService::new(storage, runtime.is_some()),
            web_directory: config.web_directory,
            control_token: config.control_token,
            read_only_control_token: config.read_only_control_token,
            runtime,
            permission_catalog,
            default_harness_configuration,
            allow_harness_override,
            standalone_workspaces_directory,
        })
    }

    pub fn router(&self) -> Router {
        api::router(
            self.product.clone(),
            (
                self.control_token.clone(),
                self.read_only_control_token.clone(),
            ),
            self.web_directory.clone(),
            api::ApiRuntime {
                runtime: self.runtime.clone(),
                permission_catalog: self.permission_catalog.clone(),
                default_harness_configuration: self.default_harness_configuration.clone(),
                allow_harness_override: self.allow_harness_override,
                standalone_workspaces_directory: self.standalone_workspaces_directory.clone(),
            },
        )
    }
}
