use crate::{api, product::ProductService, storage::SqliteProductStore};
use axum::Router;
use std::path::PathBuf;

pub struct RelayerAppServerConfig {
    pub database_path: PathBuf,
    pub web_directory: PathBuf,
    pub control_token: String,
}

pub struct RelayerAppServer {
    product: ProductService,
    web_directory: PathBuf,
    control_token: String,
}

impl RelayerAppServer {
    pub async fn open(config: RelayerAppServerConfig) -> anyhow::Result<Self> {
        let storage = SqliteProductStore::open(&config.database_path).await?;
        Ok(Self {
            product: ProductService::new(storage),
            web_directory: config.web_directory,
            control_token: config.control_token,
        })
    }

    pub fn router(&self) -> Router {
        api::router(
            self.product.clone(),
            self.control_token.clone(),
            self.web_directory.clone(),
        )
    }
}
