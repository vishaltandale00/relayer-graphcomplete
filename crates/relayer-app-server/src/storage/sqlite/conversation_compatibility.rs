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

impl ConversationCompatibility {
    /// Whether a root turn must continue this conversation's native session instead of
    /// starting a fresh one. The product passes this decision to the harness host.
    pub(crate) fn requires_native_continuity(&self) -> bool {
        !matches!(self.status, "unrestricted" | "portable")
    }
}

impl SqliteProductStore {
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
    let (harness_id, conversation_format): (String, String) = sqlx::query_as(
        "SELECT harness_configuration_name,conversation_format FROM threads WHERE id=?1",
    )
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
    // A continuation conversation reads its earlier turns from the graph (ADR 0014), so no
    // native route owns it. Its format is fixed at creation; a legacy thread never gets here.
    if conversation_format == "continuation-v1" {
        result.status = "portable";
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

#[cfg(test)]
mod tests {
    use super::super::{SqliteProductStore, migrations::MIGRATOR};
    use sqlx::{migrate::Migrator, sqlite::SqlitePoolOptions};
    use std::borrow::Cow;

    async fn open_store() -> (tempfile::TempDir, SqliteProductStore) {
        let directory = tempfile::Builder::new()
            .prefix("relayer-conversation-format-")
            .tempdir()
            .expect("test directory");
        let store = SqliteProductStore::open(directory.path().join("product.sqlite"))
            .await
            .expect("open test store");
        (directory, store)
    }

    /// CONT-001 and CONT-002: every thread has one format, legacy unless created otherwise,
    /// and no write can turn a legacy conversation into a continuation one or back.
    #[tokio::test]
    async fn conversation_format_is_legacy_by_default_and_fixed_at_creation() {
        let (_directory, store) = open_store().await;
        let legacy = sqlx::query(
            "INSERT INTO threads(title,created_at,updated_at) VALUES ('Legacy','1','1')",
        )
        .execute(&store.pool)
        .await
        .unwrap()
        .last_insert_rowid();
        let format: String =
            sqlx::query_scalar("SELECT conversation_format FROM threads WHERE id=?1")
                .bind(legacy)
                .fetch_one(&store.pool)
                .await
                .unwrap();
        assert_eq!(format, "legacy");
        let continuation = sqlx::query("INSERT INTO threads(title,created_at,updated_at,conversation_format) VALUES ('New','1','1','continuation-v1')")
            .execute(&store.pool)
            .await
            .unwrap()
            .last_insert_rowid();
        for (thread, format) in [(legacy, "continuation-v1"), (continuation, "legacy")] {
            let error = sqlx::query("UPDATE threads SET conversation_format=?1 WHERE id=?2")
                .bind(format)
                .bind(thread)
                .execute(&store.pool)
                .await
                .expect_err("a conversation's format never changes");
            assert!(
                error.to_string().contains("conversation_format_immutable"),
                "{error}"
            );
        }
        let unknown = sqlx::query("INSERT INTO threads(title,created_at,updated_at,conversation_format) VALUES ('Unknown','1','1','continuation-v2')")
            .execute(&store.pool)
            .await
            .expect_err("only known formats are stored");
        assert!(
            unknown.to_string().contains("CHECK constraint failed"),
            "{unknown}"
        );
    }

    /// CONT-001: imported and non-conversation threads are always legacy.
    #[tokio::test]
    async fn imported_and_profile_threads_cannot_be_continuation_conversations() {
        let (_directory, store) = open_store().await;
        sqlx::query("INSERT INTO conversation_imports(id,source_sha256,export_version,producer_json,header_json,state,created_at) VALUES ('import-1','sha256:x',1,'{}','{}','published','1')")
            .execute(&store.pool)
            .await
            .unwrap();
        let imported = sqlx::query("INSERT INTO threads(title,created_at,updated_at,conversation_import_id,conversation_format) VALUES ('Imported','1','1','import-1','continuation-v1')")
            .execute(&store.pool)
            .await
            .expect_err("an imported thread is legacy");
        assert!(
            imported.to_string().contains("CHECK constraint failed"),
            "{imported}"
        );
        sqlx::query("INSERT INTO threads(title,created_at,updated_at,conversation_import_id) VALUES ('Imported','1','1','import-1')")
            .execute(&store.pool)
            .await
            .expect("an imported legacy thread is still valid");
        let profile = sqlx::query("INSERT INTO threads(title,created_at,updated_at,surface,conversation_format) VALUES ('Profile','1','1','personal_presentation_profile','continuation-v1')")
            .execute(&store.pool)
            .await
            .expect_err("a profile thread is not a conversation");
        assert!(
            profile.to_string().contains("CHECK constraint failed"),
            "{profile}"
        );
    }

    /// CONT-001: a database from before the format column opens with every existing
    /// thread as a legacy conversation. The migration is found by name, not number, so
    /// renumbering it around concurrent migrations keeps this test valid.
    #[tokio::test]
    async fn threads_from_before_the_format_open_as_legacy_conversations() {
        let marker = MIGRATOR
            .iter()
            .find(|migration| migration.description == "thread conversation format")
            .expect("the conversation format migration exists")
            .version;
        let directory = tempfile::Builder::new()
            .prefix("relayer-conversation-format-upgrade-")
            .tempdir()
            .expect("test directory");
        let path = directory.path().join("product.sqlite");
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                sqlx::sqlite::SqliteConnectOptions::new()
                    .filename(&path)
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        Migrator {
            migrations: Cow::Owned(
                MIGRATOR
                    .iter()
                    .filter(|migration| migration.version < marker)
                    .cloned()
                    .collect(),
            ),
            ..Migrator::DEFAULT
        }
        .run(&pool)
        .await
        .unwrap();
        let thread = sqlx::query(
            "INSERT INTO threads(title,created_at,updated_at) VALUES ('Existing','1','1')",
        )
        .execute(&pool)
        .await
        .unwrap()
        .last_insert_rowid();
        sqlx::query("INSERT INTO interactions(thread_id,sequence,text,created_at,completion_status) VALUES (?1,1,'Existing turn','1','accepted')")
            .bind(thread)
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;

        let store = SqliteProductStore::open(&path).await.unwrap();
        // Includes the personal presentation profile thread that earlier migrations created.
        let profile_threads: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM threads WHERE surface='personal_presentation_profile'",
        )
        .fetch_one(&store.pool)
        .await
        .unwrap();
        assert_eq!(profile_threads, 1);
        let formats: Vec<String> =
            sqlx::query_scalar("SELECT DISTINCT conversation_format FROM threads")
                .fetch_all(&store.pool)
                .await
                .unwrap();
        assert_eq!(formats, ["legacy"]);
    }
}
