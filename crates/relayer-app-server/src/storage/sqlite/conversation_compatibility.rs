//! Conservative continuation policy for conversations whose native history is not portable.
use super::SqliteProductStore;
use crate::{
    product::{CatalogError, ThreadId, ValidateModelSelectionCommand},
    storage::StorageError,
};
use sqlx::{Row, SqliteConnection};

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConversationCompatibility {
    #[serde(skip)]
    pub(crate) native_history_anchor: Option<serde_json::Value>,
    pub(crate) thread_id: i64,
    pub(crate) status: &'static str,
    pub(crate) harness_id: String,
    pub(crate) provider_id: Option<String>,
    pub(crate) message: Option<&'static str>,
}

impl SqliteProductStore {
    pub(crate) async fn graph_backed_continuation(
        &self,
        id: ThreadId,
    ) -> Result<bool, StorageError> {
        Ok(
            sqlx::query_scalar::<_, String>("SELECT continuation_mode FROM threads WHERE id=?1")
                .bind(id.value())
                .fetch_one(&self.pool)
                .await?
                == "graph-v1",
        )
    }
    pub(crate) async fn conversation_compatibility(
        &self,
        id: ThreadId,
    ) -> Result<ConversationCompatibility, StorageError> {
        compatibility_on(&mut *self.pool.acquire().await?, id.value(), None).await
    }
}

fn canonical_harness(value: &str) -> &str {
    match value {
        "codex-basic-high" => "codex-basic",
        "prime-agent-deep" => "prime-agent-basic",
        other => other,
    }
}

pub(super) async fn compatibility_on(
    connection: &mut SqliteConnection,
    thread_id: i64,
    exclude: Option<i64>,
) -> Result<ConversationCompatibility, StorageError> {
    let harness_id: String =
        sqlx::query_scalar("SELECT harness_configuration_name FROM threads WHERE id=?1")
            .bind(thread_id)
            .fetch_one(&mut *connection)
            .await?;
    let mut result = ConversationCompatibility {
        native_history_anchor: None,
        thread_id,
        status: "unrestricted",
        harness_id,
        provider_id: None,
        message: None,
    };
    let mode: String = sqlx::query_scalar("SELECT continuation_mode FROM threads WHERE id=?1")
        .bind(thread_id)
        .fetch_one(&mut *connection)
        .await?;
    if mode == "graph-v1" {
        return Ok(result);
    }
    // Successful root receipts are authoritative. A failed foreign attempt cannot become
    // the owner. Semantic children have independent native attachments and are excluded.
    let rows = sqlx::query("SELECT i.id,i.graph_node_id,i.text,i.completion_status,i.model_provider_id,i.harness_configuration_name,a.provider_id,a.adapter_id,a.access_contract,a.harness_configuration_name AS attempt_harness,p.adapter_id AS current_adapter,p.access_contract AS current_contract,EXISTS(SELECT 1 FROM interaction_attempts any_attempt WHERE any_attempt.interaction_id=i.id) AS has_attempts FROM interactions i LEFT JOIN interaction_attempts a ON a.interaction_id=i.id AND a.outcome='accepted' LEFT JOIN model_providers p ON p.id=COALESCE(a.provider_id,i.model_provider_id) WHERE i.thread_id=?1 AND (?2 IS NULL OR i.id!=?2) AND NOT EXISTS(SELECT 1 FROM action_invocations v WHERE v.result_interaction_id=i.id) ORDER BY i.sequence")
        .bind(thread_id).bind(exclude).fetch_all(&mut *connection).await?;
    let mut uncertain = false;
    let mut saw_execution = false;
    for row in rows {
        let attempted_provider: Option<String> = row.try_get("provider_id")?;
        let selected_provider: Option<String> = row.try_get("model_provider_id")?;
        let status: String = row.try_get("completion_status")?;
        let has_attempts: bool = row.try_get("has_attempts")?;
        if selected_provider.is_none() && !has_attempts {
            if matches!(status.as_str(), "accepted" | "failed" | "stopped") {
                uncertain = true;
            }
            continue;
        }
        if !matches!(status.as_str(), "not_started" | "submitted" | "running") {
            saw_execution = true;
        }
        let provider = if attempted_provider.is_some() {
            attempted_provider
        } else if status == "accepted" && !has_attempts {
            selected_provider
        } else {
            continue;
        };
        let owner_harness: Option<String> = row.try_get("attempt_harness")?;
        let owner_harness = owner_harness.or(row.try_get("harness_configuration_name")?);
        if provider.is_none()
            || owner_harness
                .as_deref()
                .is_none_or(|h| canonical_harness(h) != canonical_harness(&result.harness_id))
        {
            uncertain = true;
            continue;
        }
        let adapter: Option<String> = row.try_get("adapter_id")?;
        let contract: Option<String> = row.try_get("access_contract")?;
        if adapter.is_some()
            && (adapter != row.try_get("current_adapter")?
                || contract != row.try_get("current_contract")?)
        {
            uncertain = true;
        }
        if result.provider_id.is_some() && result.provider_id != provider {
            uncertain = true;
        }
        result.provider_id = provider;
        if let Some(node_id) = row.try_get::<Option<i64>, _>("graph_node_id")? {
            result.native_history_anchor = Some(
                serde_json::json!({"interactionNodeId": node_id, "message": row.try_get::<String, _>("text")?}),
            );
        }
    }
    if uncertain || (saw_execution && result.provider_id.is_none()) {
        result.status = "blocked";
        result.provider_id = None;
        result.message = Some(
            "This conversation's original execution route cannot be verified. Its history is preserved, but continuing it is unavailable.",
        );
    } else if result.provider_id.is_some() {
        result.status = "compatible";
        result.message = Some(
            "This legacy conversation can continue only with its original provider and harness. Compatible model changes are available; history is preserved.",
        );
    }
    Ok(result)
}

pub(super) async fn validate_on(
    connection: &mut SqliteConnection,
    thread_id: i64,
    exclude: Option<i64>,
    command: &ValidateModelSelectionCommand,
) -> Result<(), StorageError> {
    let compatibility = compatibility_on(connection, thread_id, exclude).await?;
    if compatibility.status == "blocked"
        || (compatibility.status == "compatible"
            && (compatibility.provider_id.as_deref() != Some(command.provider_id.as_str())
                || compatibility.harness_id != command.harness_id))
    {
        return Err(StorageError::Catalog(CatalogError::selection(
            "conversation_route_incompatible",
            compatibility
                .message
                .unwrap_or("This route cannot safely continue the conversation."),
            command,
        )));
    }
    Ok(())
}
