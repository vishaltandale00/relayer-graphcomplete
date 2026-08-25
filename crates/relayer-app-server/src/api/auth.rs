use super::{ApiState, CONTROL_COOKIE, error::ApiError};
use axum::http::HeaderMap;
use std::sync::Arc;

pub const ANNOTATION_COOKIE: &str = "relayer_annotation";

#[derive(Clone)]
pub(crate) struct DesktopSessionAuthenticator {
    control_token: Arc<str>,
    read_only_control_token: Option<Arc<str>>,
}

impl DesktopSessionAuthenticator {
    pub(crate) fn new(
        control_token: impl Into<String>,
        read_only_control_token: Option<String>,
    ) -> Self {
        Self {
            control_token: Arc::from(control_token.into()),
            read_only_control_token: read_only_control_token.map(Arc::from),
        }
    }

    fn supplied_token<'a>(&self, headers: &'a HeaderMap) -> Option<&'a str> {
        cookie(headers, CONTROL_COOKIE)
    }

    pub(crate) fn annotation_token<'a>(&self, headers: &'a HeaderMap) -> Option<&'a str> {
        cookie(headers, ANNOTATION_COOKIE)
    }

    pub(crate) fn is_control(&self, headers: &HeaderMap) -> bool {
        self.supplied_token(headers) == Some(self.control_token.as_ref())
    }
}

fn cookie<'a>(headers: &'a HeaderMap, expected_name: &str) -> Option<&'a str> {
    headers
        .get("cookie")
        .and_then(|value| value.to_str().ok())
        .and_then(|cookies| {
            cookies.split(';').find_map(|cookie| {
                let (name, value) = cookie.trim().split_once('=')?;
                (name == expected_name).then_some(value)
            })
        })
}

impl DesktopSessionAuthenticator {
    pub(crate) fn authorize_read(&self, headers: &HeaderMap) -> Result<(), ApiError> {
        let supplied = self.supplied_token(headers);
        if supplied == Some(self.control_token.as_ref())
            || self
                .read_only_control_token
                .as_deref()
                .is_some_and(|token| supplied == Some(token))
        {
            Ok(())
        } else {
            Err(ApiError::unauthorized())
        }
    }

    pub(crate) fn authorize_write(&self, headers: &HeaderMap) -> Result<(), ApiError> {
        let supplied = self.supplied_token(headers);
        if supplied == Some(self.control_token.as_ref()) {
            Ok(())
        } else if self
            .read_only_control_token
            .as_deref()
            .is_some_and(|token| supplied == Some(token))
        {
            Err(ApiError::read_only())
        } else {
            Err(ApiError::unauthorized())
        }
    }

    pub(crate) fn authorize_provider_publish(&self, headers: &HeaderMap) -> Result<(), ApiError> {
        let supplied = headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "));
        if supplied == Some(self.control_token.as_ref()) {
            Ok(())
        } else {
            Err(ApiError::unauthorized())
        }
    }
}

pub(crate) fn authorize_read(state: &ApiState, headers: &HeaderMap) -> Result<(), ApiError> {
    state.authenticator.authorize_read(headers)
}

pub(crate) fn authorize_write(state: &ApiState, headers: &HeaderMap) -> Result<(), ApiError> {
    state.authenticator.authorize_write(headers)
}

pub(crate) fn authorize_provider_publish(
    state: &ApiState,
    headers: &HeaderMap,
) -> Result<(), ApiError> {
    state.authenticator.authorize_provider_publish(headers)
}
