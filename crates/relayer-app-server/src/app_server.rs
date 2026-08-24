use crate::{
    api, permissions::PermissionCatalog, product::ProductService,
    provider_catalog_refresh::ProviderCatalogRefreshClient, runtime::RuntimeClient,
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
    pub provider_catalog_refresh_url: Option<String>,
    pub provider_catalog_refresh_token: Option<String>,
    pub runtime: Option<RelayerRuntimeConfig>,
    pub allow_conversation_import: bool,
    pub export_producer: crate::conversation_export::ExportProducer,
}

pub struct RelayerAppServer {
    product: ProductService,
    web_directory: PathBuf,
    control_token: String,
    read_only_control_token: Option<String>,
    provider_catalog_refresh: Option<ProviderCatalogRefreshClient>,
    runtime: Option<RuntimeClient>,
    permission_catalog: PermissionCatalog,
    default_harness_configuration: String,
    allow_harness_override: bool,
    allow_conversation_import: bool,
    standalone_workspaces_directory: PathBuf,
    export_producer: crate::conversation_export::ExportProducer,
}

impl RelayerAppServer {
    pub async fn open(config: RelayerAppServerConfig) -> anyhow::Result<Self> {
        if config.read_only_control_token.as_deref() == Some(config.control_token.as_str()) {
            anyhow::bail!("read-only control token must be distinct from write authority");
        }
        if config
            .provider_catalog_refresh_token
            .as_deref()
            .is_some_and(|token| {
                token == config.control_token
                    || config.read_only_control_token.as_deref() == Some(token)
            })
        {
            anyhow::bail!(
                "provider catalog refresh token must be distinct from desktop session tokens"
            );
        }
        let permission_catalog = PermissionCatalog::load(&config.permission_catalog).await?;
        let storage = SqliteProductStore::open(&config.database_path).await?;
        let interrupted_approvals = storage
            .abort_pending_approvals(
                None,
                "Approval request was aborted because its harness session ended when Relayer stopped.",
                &startup_timestamp(),
            )
            .await?;
        if interrupted_approvals > 0 {
            eprintln!(
                "marked {interrupted_approvals} interrupted approval request(s) aborted during backend startup"
            );
        }
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
        let interrupted = storage
            .recover_interrupted_interactions(
                "Interaction was interrupted when Relayer stopped. Send a follow-up to continue.",
            )
            .await?;
        if interrupted > 0 {
            eprintln!(
                "marked {interrupted} interrupted ordinary interaction(s) failed during backend startup"
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
        if config.allow_conversation_import {
            let runtime = runtime.as_ref().ok_or_else(|| {
                anyhow::anyhow!("conversation import requires the GraphComplete runtime")
            })?;
            for import_id in storage.staged_conversation_import_ids().await? {
                runtime.remove_imported_conversation(&import_id).await?;
                storage.remove_conversation_import(&import_id).await?;
            }
        }
        let default_harness_configuration = config
            .runtime
            .as_ref()
            .map(|runtime| runtime.default_harness_configuration.clone())
            .unwrap_or_else(|| "codex-basic".into());
        let allow_harness_override = config
            .runtime
            .as_ref()
            .is_some_and(|runtime| runtime.allow_harness_override);
        let provider_catalog_refresh = match (
            config.provider_catalog_refresh_url.as_deref(),
            config.provider_catalog_refresh_token,
        ) {
            (Some(origin), Some(token)) => Some(ProviderCatalogRefreshClient::new(origin, token)?),
            (None, None) if runtime.is_some() && !allow_harness_override => {
                anyhow::bail!(
                    "ordinary product runtime requires a trusted provider catalog refresh service"
                )
            }
            (None, None) => None,
            _ => anyhow::bail!("provider catalog refresh URL and token must be supplied together"),
        };
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
            provider_catalog_refresh,
            runtime,
            permission_catalog,
            default_harness_configuration,
            allow_harness_override,
            allow_conversation_import: config.allow_conversation_import,
            standalone_workspaces_directory,
            export_producer: config.export_producer,
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
                allow_conversation_import: self.allow_conversation_import,
                provider_catalog_refresh: self.provider_catalog_refresh.clone(),
                standalone_workspaces_directory: self.standalone_workspaces_directory.clone(),
                export_producer: self.export_producer.clone(),
            },
        )
    }
}

fn startup_timestamp() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system time is before unix epoch")
        .as_millis()
        .to_string()
}
