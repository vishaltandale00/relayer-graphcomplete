use reqwest::{Client, StatusCode};
use std::{sync::Arc, time::Duration};
use thiserror::Error;
use url::Url;

const REFRESH_PATH: &str = "/v1/provider-catalog/refresh";

#[derive(Clone)]
pub(crate) struct ProviderCatalogRefreshClient {
    endpoint: Url,
    token: Arc<str>,
    client: Client,
}

#[derive(Debug, Error)]
pub(crate) enum ProviderCatalogRefreshError {
    #[error("invalid provider catalog refresh configuration: {0}")]
    Configuration(String),
    #[error("provider catalog refresh service is unavailable: {0}")]
    Transport(String),
    #[error("provider catalog refresh failed ({status})")]
    Rejected { status: StatusCode },
}

impl ProviderCatalogRefreshClient {
    pub(crate) fn new(
        origin: &str,
        token: impl Into<String>,
    ) -> Result<Self, ProviderCatalogRefreshError> {
        let mut endpoint = Url::parse(origin)
            .map_err(|error| ProviderCatalogRefreshError::Configuration(error.to_string()))?;
        if endpoint.scheme() != "http"
            || endpoint.host_str() != Some("127.0.0.1")
            || endpoint.port().is_none()
            || endpoint.username() != ""
            || endpoint.password().is_some()
            || endpoint.path() != "/"
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
        {
            return Err(ProviderCatalogRefreshError::Configuration(
                "origin must be an authenticated http://127.0.0.1:<port> origin".into(),
            ));
        }
        endpoint.set_path(REFRESH_PATH);
        let token = token.into();
        if token.len() < 32 {
            return Err(ProviderCatalogRefreshError::Configuration(
                "token must contain at least 32 characters".into(),
            ));
        }
        let client = Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|error| ProviderCatalogRefreshError::Configuration(error.to_string()))?;
        Ok(Self {
            endpoint,
            token: Arc::from(token),
            client,
        })
    }

    pub(crate) async fn refresh(&self) -> Result<(), ProviderCatalogRefreshError> {
        let response = self
            .client
            .post(self.endpoint.clone())
            .bearer_auth(self.token.as_ref())
            .header("accept", "application/json")
            .send()
            .await
            .map_err(|error| ProviderCatalogRefreshError::Transport(error.to_string()))?;
        if response.status() == StatusCode::NO_CONTENT {
            Ok(())
        } else {
            Err(ProviderCatalogRefreshError::Rejected {
                status: response.status(),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, http::HeaderMap, routing::post};
    use std::sync::{Arc, Mutex};

    #[test]
    fn accepts_only_exact_ipv4_loopback_origins_and_strong_tokens() {
        let token = "r".repeat(32);
        assert!(ProviderCatalogRefreshClient::new("http://127.0.0.1:43123", &token).is_ok());
        for origin in [
            "https://127.0.0.1:43123",
            "http://localhost:43123",
            "http://[::1]:43123",
            "http://127.0.0.1",
            "http://127.0.0.1:43123/path",
            "http://user@127.0.0.1:43123",
        ] {
            assert!(
                ProviderCatalogRefreshClient::new(origin, &token).is_err(),
                "{origin}"
            );
        }
        assert!(ProviderCatalogRefreshClient::new("http://127.0.0.1:43123", "short").is_err());
    }

    #[tokio::test]
    async fn posts_the_bearer_to_the_fixed_refresh_path() {
        let observed = Arc::new(Mutex::new(None));
        let captured = observed.clone();
        let app = Router::new().route(
            REFRESH_PATH,
            post(move |headers: HeaderMap| {
                let captured = captured.clone();
                async move {
                    *captured.lock().unwrap() = headers
                        .get("authorization")
                        .and_then(|value| value.to_str().ok())
                        .map(str::to_owned);
                    StatusCode::NO_CONTENT
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(axum::serve(listener, app).into_future());
        let token = "t".repeat(32);
        ProviderCatalogRefreshClient::new(&format!("http://{address}"), &token)
            .unwrap()
            .refresh()
            .await
            .unwrap();
        assert_eq!(
            observed.lock().unwrap().clone(),
            Some(format!("Bearer {token}"))
        );
        task.abort();
    }

    #[tokio::test]
    async fn rejects_non_success_responses() {
        let app = Router::new().route(
            REFRESH_PATH,
            post(|| async { StatusCode::SERVICE_UNAVAILABLE }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(axum::serve(listener, app).into_future());
        let error = ProviderCatalogRefreshClient::new(&format!("http://{address}"), "t".repeat(32))
            .unwrap()
            .refresh()
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            ProviderCatalogRefreshError::Rejected { .. }
        ));
        task.abort();
    }
}
