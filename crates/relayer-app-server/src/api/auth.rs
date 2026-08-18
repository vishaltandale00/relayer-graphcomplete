use super::{ApiState, CONTROL_COOKIE, error::ApiError};
use axum::http::HeaderMap;
use std::sync::Arc;

#[derive(Clone)]
pub(crate) struct DesktopSessionAuthenticator {
    control_token: Arc<str>,
}

impl DesktopSessionAuthenticator {
    pub(crate) fn new(control_token: impl Into<String>) -> Self {
        Self {
            control_token: Arc::from(control_token.into()),
        }
    }

    pub(crate) fn authorize(&self, headers: &HeaderMap) -> Result<(), ApiError> {
        let supplied = headers
            .get("cookie")
            .and_then(|value| value.to_str().ok())
            .and_then(|cookies| {
                cookies.split(';').find_map(|cookie| {
                    let (name, value) = cookie.trim().split_once('=')?;
                    (name == CONTROL_COOKIE).then_some(value)
                })
            });
        if supplied == Some(self.control_token.as_ref()) {
            Ok(())
        } else {
            Err(ApiError::unauthorized())
        }
    }
}

pub(crate) fn authorize(state: &ApiState, headers: &HeaderMap) -> Result<(), ApiError> {
    state.authenticator.authorize(headers)
}
