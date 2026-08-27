use crate::storage::StorageError;
use sqlx::{Row, SqlitePool, sqlite::SqliteRow};

#[derive(Debug, PartialEq, Eq)]
struct Column {
    name: String,
    declared_type: String,
    required: bool,
    primary_key_position: i64,
}

const PROJECT_COLUMNS: &[(&str, &str, bool, i64)] = &[
    ("id", "INTEGER", false, 1),
    ("name", "TEXT", true, 0),
    ("path", "TEXT", true, 0),
    ("created_at", "TEXT", true, 0),
    ("updated_at", "TEXT", true, 0),
];
const THREAD_COLUMNS: &[(&str, &str, bool, i64)] = &[
    ("id", "INTEGER", false, 1),
    ("title", "TEXT", true, 0),
    ("project_id", "INTEGER", false, 0),
    ("created_at", "TEXT", true, 0),
    ("updated_at", "TEXT", true, 0),
    ("harness_configuration_name", "TEXT", true, 0),
    ("permission_profile_id", "TEXT", true, 0),
    ("conversation_import_id", "TEXT", false, 0),
];
const CONVERSATION_IMPORT_COLUMNS: &[(&str, &str, bool, i64)] = &[
    ("id", "TEXT", true, 1),
    ("source_sha256", "TEXT", true, 0),
    ("export_version", "INTEGER", true, 0),
    ("producer_json", "TEXT", true, 0),
    ("header_json", "TEXT", true, 0),
    ("state", "TEXT", true, 0),
    ("created_at", "TEXT", true, 0),
    ("published_at", "TEXT", false, 0),
];
const IMPORTED_TURN_COLUMNS: &[(&str, &str, bool, i64)] = &[
    ("conversation_import_id", "TEXT", true, 1),
    ("source_turn_id", "TEXT", true, 2),
    ("product_interaction_id", "INTEGER", true, 0),
    ("source_origin_json", "TEXT", true, 0),
    ("source_completion_json", "TEXT", true, 0),
];
const INTERACTION_COLUMNS: &[(&str, &str, bool, i64)] = &[
    ("id", "INTEGER", false, 1),
    ("thread_id", "INTEGER", true, 0),
    ("sequence", "INTEGER", true, 0),
    ("text", "TEXT", true, 0),
    ("created_at", "TEXT", true, 0),
    ("graph_node_id", "INTEGER", false, 0),
    ("completion_status", "TEXT", true, 0),
    ("harness_configuration_name", "TEXT", false, 0),
    ("harness_configuration_digest", "TEXT", false, 0),
    ("completion_output_json", "TEXT", false, 0),
    ("completion_error", "TEXT", false, 0),
    ("permission_profile_id", "TEXT", true, 0),
    ("effective_execution_digest", "TEXT", false, 0),
    ("effective_permission_receipt_json", "TEXT", false, 0),
    ("model_provider_id", "TEXT", false, 0),
    ("provider_model_id", "TEXT", false, 0),
    ("model_family_id", "INTEGER", false, 0),
    ("input_identity", "TEXT", false, 0),
    ("input_digest", "TEXT", false, 0),
];
const INTERACTION_CONTEXT_COLUMNS: &[(&str, &str, bool, i64)] = &[
    ("interaction_id", "INTEGER", true, 1),
    ("position", "INTEGER", true, 2),
    ("target_node_id", "INTEGER", true, 0),
    ("source_interaction_node_id", "INTEGER", true, 0),
    ("source_layer_id", "INTEGER", true, 0),
];
const INTERACTION_CONTEXT_ANNOTATION_COLUMNS: &[(&str, &str, bool, i64)] = &[
    ("interaction_id", "INTEGER", true, 1),
    ("context_position", "INTEGER", true, 2),
    ("position", "INTEGER", true, 3),
    ("text", "TEXT", true, 0),
];
const INTERACTION_ATTEMPT_COLUMNS: &[(&str, &str, bool, i64)] = &[
    ("id", "INTEGER", false, 1),
    ("interaction_id", "INTEGER", true, 0),
    ("attempt_number", "INTEGER", true, 0),
    ("started_at", "TEXT", true, 0),
    ("finished_at", "TEXT", false, 0),
    ("family_id", "INTEGER", true, 0),
    ("family_revision", "INTEGER", true, 0),
    ("harness_configuration_name", "TEXT", true, 0),
    ("harness_configuration_revision", "INTEGER", true, 0),
    ("harness_configuration_digest", "TEXT", true, 0),
    ("provider_id", "TEXT", true, 0),
    ("adapter_id", "TEXT", true, 0),
    ("adapter_implementation_version", "INTEGER", true, 0),
    ("model_id", "TEXT", true, 0),
    ("access_contract", "TEXT", true, 0),
    ("outcome", "TEXT", true, 0),
    ("failure_category", "TEXT", false, 0),
    ("effect_boundary", "TEXT", true, 0),
    ("attempt_admission_id", "TEXT", false, 0),
    ("admitted_plan_json", "TEXT", false, 0),
    ("admitted_plan_digest", "TEXT", false, 0),
    ("execution_lease_id", "TEXT", false, 0),
    ("execution_lease_reconciled_at", "TEXT", false, 0),
];
const ACTION_INVOCATION_COLUMNS: &[(&str, &str, bool, i64)] = &[
    ("source_interaction_id", "INTEGER", true, 1),
    ("action_id", "INTEGER", true, 2),
    ("result_interaction_id", "INTEGER", true, 0),
    ("created_at", "TEXT", true, 0),
    ("graph_lease_required", "INTEGER", true, 0),
    ("authoritative", "INTEGER", true, 0),
];
const MODEL_PROVIDER_COLUMNS: &[(&str, &str, bool, i64)] = &[
    ("id", "TEXT", true, 1),
    ("label", "TEXT", true, 0),
    ("connected", "INTEGER", true, 0),
    ("unavailable_reason_code", "TEXT", false, 0),
    ("unavailable_reason_message", "TEXT", false, 0),
    ("refreshed_at", "TEXT", true, 0),
    ("adapter_id", "TEXT", true, 0),
    ("access_contract", "TEXT", true, 0),
    ("endpoint", "TEXT", false, 0),
    ("credential_reference", "TEXT", false, 0),
    ("lifecycle_state", "TEXT", true, 0),
    ("removed_at", "TEXT", false, 0),
];
const PROVIDER_MODEL_COLUMNS: &[(&str, &str, bool, i64)] = &[
    ("provider_id", "TEXT", true, 1),
    ("model_id", "TEXT", true, 2),
    ("label", "TEXT", true, 0),
    ("provider_order", "INTEGER", true, 0),
    ("visible", "INTEGER", true, 0),
    ("available", "INTEGER", true, 0),
    ("unavailable_reason_code", "TEXT", false, 0),
    ("unavailable_reason_message", "TEXT", false, 0),
    ("provider_default", "INTEGER", true, 0),
    ("replacement_model_id", "TEXT", false, 0),
    ("metadata_json", "TEXT", true, 0),
];
const PRODUCT_HARNESS_COLUMNS: &[(&str, &str, bool, i64)] = &[
    ("configuration_name", "TEXT", true, 1),
    ("label", "TEXT", true, 0),
    ("product_visible", "INTEGER", true, 0),
    ("available", "INTEGER", true, 0),
    ("unavailable_reason_code", "TEXT", false, 0),
    ("unavailable_reason_message", "TEXT", false, 0),
    ("configuration_revision", "INTEGER", true, 0),
    ("configuration_digest", "TEXT", true, 0),
    ("model_rules_present", "INTEGER", true, 0),
    ("execution_access_contracts_json", "TEXT", true, 0),
    ("family_policy_id", "TEXT", false, 0),
    ("family_policy_version", "INTEGER", false, 0),
    ("model_rules_modified", "INTEGER", true, 0),
    ("runtime_configuration_revision", "INTEGER", true, 0),
    ("runtime_configuration_digest", "TEXT", true, 0),
];
const HARNESS_MODEL_RULE_COLUMNS: &[(&str, &str, bool, i64)] = &[
    ("harness_configuration_name", "TEXT", true, 1),
    ("effect", "TEXT", true, 2),
    ("position", "INTEGER", true, 3),
    ("adapter_id", "TEXT", true, 0),
    ("match_kind", "TEXT", true, 0),
    ("model_pattern", "TEXT", true, 0),
];
const HARNESS_PROVIDER_COLUMNS: &[(&str, &str, bool, i64)] = &[
    ("harness_configuration_name", "TEXT", true, 1),
    ("provider_id", "TEXT", true, 2),
    ("all_models", "INTEGER", true, 0),
    ("preferred_model_id", "TEXT", false, 0),
];
const HARNESS_MODEL_COLUMNS: &[(&str, &str, bool, i64)] = &[
    ("harness_configuration_name", "TEXT", true, 1),
    ("provider_id", "TEXT", true, 2),
    ("model_id", "TEXT", true, 3),
];
const MODEL_FAMILY_COLUMNS: &[(&str, &str, bool, i64)] = &[
    ("id", "INTEGER", false, 1),
    ("name", "TEXT", true, 0),
    ("kind", "TEXT", true, 0),
    ("system_key", "TEXT", false, 0),
    ("enabled", "INTEGER", true, 0),
    ("position", "INTEGER", true, 0),
    ("revision", "INTEGER", true, 0),
    ("managed_provider_id", "TEXT", false, 0),
    ("policy_id", "TEXT", false, 0),
    ("policy_version", "INTEGER", false, 0),
    ("lifecycle_state", "TEXT", true, 0),
    ("removed_at", "TEXT", false, 0),
];
const MODEL_FAMILY_MEMBER_COLUMNS: &[(&str, &str, bool, i64)] = &[
    ("family_id", "INTEGER", true, 1),
    ("position", "INTEGER", true, 2),
    ("provider_id", "TEXT", true, 0),
    ("model_id", "TEXT", true, 0),
];
const PRODUCT_MODEL_PREFERENCE_COLUMNS: &[(&str, &str, bool, i64)] = &[
    ("singleton", "INTEGER", true, 1),
    ("default_harness_configuration_name", "TEXT", true, 0),
    ("default_provider_id", "TEXT", true, 0),
    ("defaults_modified", "INTEGER", true, 0),
    ("default_family_id", "INTEGER", false, 0),
];
const APPROVAL_REQUEST_COLUMNS: &[(&str, &str, bool, i64)] = &[
    ("request_id", "TEXT", true, 1),
    ("interaction_id", "INTEGER", true, 0),
    ("complete_call_id", "TEXT", true, 0),
    ("harness_session_id", "TEXT", true, 0),
    ("title", "TEXT", true, 0),
    ("reason", "TEXT", true, 0),
    ("action_json", "TEXT", true, 0),
    ("scope_keys_json", "TEXT", true, 0),
    ("scope_description", "TEXT", true, 0),
    ("created_at", "TEXT", true, 0),
    ("expires_at", "TEXT", false, 0),
];
const APPROVAL_RESOLUTION_COLUMNS: &[(&str, &str, bool, i64)] = &[
    ("request_id", "TEXT", true, 1),
    ("outcome", "TEXT", true, 0),
    ("actor", "TEXT", true, 0),
    ("decision", "TEXT", false, 0),
    ("rationale", "TEXT", false, 0),
    ("source_request_id", "TEXT", false, 0),
    ("resolved_at", "TEXT", true, 0),
];
const ANNOTATION_COLUMNS: &[(&str, &str, bool, i64)] = &[
    ("id", "INTEGER", false, 1),
    ("thread_id", "INTEGER", true, 0),
    ("anchor_json", "TEXT", true, 0),
    ("created_at", "TEXT", true, 0),
];
const ANNOTATION_REVISION_COLUMNS: &[(&str, &str, bool, i64)] = &[
    ("annotation_id", "INTEGER", true, 1),
    ("revision", "INTEGER", true, 2),
    ("author_id", "TEXT", true, 0),
    ("author_display_name", "TEXT", true, 0),
    ("comment", "TEXT", true, 0),
    ("rating", "INTEGER", false, 0),
    ("state", "TEXT", true, 0),
    ("navigation_context_json", "TEXT", true, 0),
    ("evidence_refs_json", "TEXT", true, 0),
    ("created_at", "TEXT", true, 0),
];

pub(super) async fn validate_existing_or_empty(pool: &SqlitePool) -> Result<(), StorageError> {
    let table_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_schema WHERE type='table' AND name IN ('projects','threads','interactions')",
    )
    .fetch_one(pool)
    .await?;
    if table_count == 0 {
        return Ok(());
    }
    let has_migration_history: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='_sqlx_migrations')",
    )
    .fetch_one(pool)
    .await?;
    if !has_migration_history {
        return Err(incompatible(
            "product tables exist without Relayer migration history",
        ));
    }
    Ok(())
}

pub(super) async fn validate(pool: &SqlitePool) -> Result<(), StorageError> {
    validate_columns(pool, "projects", PROJECT_COLUMNS).await?;
    validate_columns(pool, "threads", THREAD_COLUMNS).await?;
    validate_columns(pool, "interactions", INTERACTION_COLUMNS).await?;
    validate_columns(pool, "interaction_attempts", INTERACTION_ATTEMPT_COLUMNS).await?;
    validate_columns(
        pool,
        "interaction_context_intents",
        INTERACTION_CONTEXT_COLUMNS,
    )
    .await?;
    validate_columns(
        pool,
        "interaction_context_annotations",
        INTERACTION_CONTEXT_ANNOTATION_COLUMNS,
    )
    .await?;
    validate_columns(pool, "conversation_imports", CONVERSATION_IMPORT_COLUMNS).await?;
    validate_columns(pool, "imported_turns", IMPORTED_TURN_COLUMNS).await?;
    validate_columns(pool, "action_invocations", ACTION_INVOCATION_COLUMNS).await?;
    validate_columns(pool, "model_providers", MODEL_PROVIDER_COLUMNS).await?;
    validate_columns(pool, "provider_models", PROVIDER_MODEL_COLUMNS).await?;
    validate_columns(pool, "product_harnesses", PRODUCT_HARNESS_COLUMNS).await?;
    validate_columns(pool, "harness_model_rules", HARNESS_MODEL_RULE_COLUMNS).await?;
    validate_columns(
        pool,
        "harness_provider_compatibility",
        HARNESS_PROVIDER_COLUMNS,
    )
    .await?;
    validate_columns(pool, "harness_model_compatibility", HARNESS_MODEL_COLUMNS).await?;
    validate_columns(pool, "model_families", MODEL_FAMILY_COLUMNS).await?;
    validate_columns(pool, "model_family_members", MODEL_FAMILY_MEMBER_COLUMNS).await?;
    validate_columns(
        pool,
        "product_model_preferences",
        PRODUCT_MODEL_PREFERENCE_COLUMNS,
    )
    .await?;
    validate_columns(pool, "approval_requests", APPROVAL_REQUEST_COLUMNS).await?;
    validate_columns(pool, "approval_resolutions", APPROVAL_RESOLUTION_COLUMNS).await?;
    validate_columns(pool, "annotations", ANNOTATION_COLUMNS).await?;
    validate_columns(pool, "annotation_revisions", ANNOTATION_REVISION_COLUMNS).await?;
    validate_index(pool, "projects", &["path"], true).await?;
    validate_index(pool, "interactions", &["thread_id", "sequence"], true).await?;
    validate_index(pool, "threads", &["conversation_import_id"], false).await?;
    validate_index(
        pool,
        "imported_turns",
        &["conversation_import_id", "source_turn_id"],
        true,
    )
    .await?;
    validate_index(pool, "imported_turns", &["product_interaction_id"], true).await?;
    validate_index(
        pool,
        "interaction_attempts",
        &["interaction_id", "attempt_number"],
        true,
    )
    .await?;
    validate_index(
        pool,
        "action_invocations",
        &["source_interaction_id", "action_id"],
        true,
    )
    .await?;
    validate_index(pool, "action_invocations", &["result_interaction_id"], true).await?;
    validate_index(pool, "provider_models", &["provider_id", "model_id"], true).await?;
    validate_index(
        pool,
        "harness_provider_compatibility",
        &["harness_configuration_name", "provider_id"],
        true,
    )
    .await?;
    validate_index(
        pool,
        "harness_model_compatibility",
        &["harness_configuration_name", "provider_id", "model_id"],
        true,
    )
    .await?;
    validate_index(pool, "model_families", &["system_key"], true).await?;
    validate_index(pool, "model_families", &["position"], true).await?;
    validate_active_family_name_index(pool).await?;
    validate_index(
        pool,
        "model_families",
        &["managed_provider_id", "policy_id", "policy_version"],
        true,
    )
    .await?;
    validate_index(
        pool,
        "model_family_members",
        &["family_id", "position"],
        true,
    )
    .await?;
    validate_index(
        pool,
        "model_family_members",
        &["family_id", "provider_id", "model_id"],
        true,
    )
    .await?;
    validate_index(
        pool,
        "approval_requests",
        &["interaction_id", "created_at"],
        false,
    )
    .await?;
    validate_index(
        pool,
        "annotations",
        &["thread_id", "created_at", "id"],
        false,
    )
    .await?;
    validate_foreign_key(pool, "threads", "project_id", "projects", "id", "SET NULL").await?;
    validate_foreign_key(
        pool,
        "interactions",
        "thread_id",
        "threads",
        "id",
        "CASCADE",
    )
    .await?;
    validate_foreign_key(
        pool,
        "interaction_attempts",
        "interaction_id",
        "interactions",
        "id",
        "CASCADE",
    )
    .await?;
    validate_foreign_key(
        pool,
        "threads",
        "conversation_import_id",
        "conversation_imports",
        "id",
        "NO ACTION",
    )
    .await?;
    validate_foreign_key(
        pool,
        "imported_turns",
        "conversation_import_id",
        "conversation_imports",
        "id",
        "CASCADE",
    )
    .await?;
    validate_foreign_key(
        pool,
        "imported_turns",
        "product_interaction_id",
        "interactions",
        "id",
        "CASCADE",
    )
    .await?;
    validate_foreign_key(
        pool,
        "harness_model_rules",
        "harness_configuration_name",
        "product_harnesses",
        "configuration_name",
        "CASCADE",
    )
    .await?;
    validate_foreign_key(
        pool,
        "provider_models",
        "provider_id",
        "model_providers",
        "id",
        "CASCADE",
    )
    .await?;
    validate_foreign_key(
        pool,
        "model_families",
        "managed_provider_id",
        "model_providers",
        "id",
        "RESTRICT",
    )
    .await?;
    validate_foreign_key(
        pool,
        "product_model_preferences",
        "default_family_id",
        "model_families",
        "id",
        "RESTRICT",
    )
    .await?;
    validate_foreign_key(
        pool,
        "approval_requests",
        "interaction_id",
        "interactions",
        "id",
        "CASCADE",
    )
    .await?;
    validate_foreign_key(
        pool,
        "harness_provider_compatibility",
        "harness_configuration_name",
        "product_harnesses",
        "configuration_name",
        "CASCADE",
    )
    .await?;
    validate_foreign_key(
        pool,
        "approval_resolutions",
        "request_id",
        "approval_requests",
        "request_id",
        "CASCADE",
    )
    .await?;
    validate_foreign_key(pool, "annotations", "thread_id", "threads", "id", "CASCADE").await?;
    validate_foreign_key(
        pool,
        "annotation_revisions",
        "annotation_id",
        "annotations",
        "id",
        "CASCADE",
    )
    .await?;
    validate_foreign_key(
        pool,
        "harness_model_compatibility",
        "harness_configuration_name",
        "harness_provider_compatibility",
        "harness_configuration_name",
        "CASCADE",
    )
    .await?;
    validate_foreign_key(
        pool,
        "harness_model_compatibility",
        "provider_id",
        "harness_provider_compatibility",
        "provider_id",
        "CASCADE",
    )
    .await?;
    validate_foreign_key(
        pool,
        "harness_provider_compatibility",
        "provider_id",
        "model_providers",
        "id",
        "CASCADE",
    )
    .await?;
    validate_foreign_key(
        pool,
        "model_family_members",
        "family_id",
        "model_families",
        "id",
        "CASCADE",
    )
    .await?;
    validate_foreign_key(
        pool,
        "model_family_members",
        "provider_id",
        "provider_models",
        "provider_id",
        "RESTRICT",
    )
    .await?;
    validate_foreign_key(
        pool,
        "model_family_members",
        "model_id",
        "provider_models",
        "model_id",
        "RESTRICT",
    )
    .await?;
    validate_foreign_key(
        pool,
        "product_model_preferences",
        "default_harness_configuration_name",
        "product_harnesses",
        "configuration_name",
        "RESTRICT",
    )
    .await?;
    validate_foreign_key(
        pool,
        "product_model_preferences",
        "default_provider_id",
        "model_providers",
        "id",
        "RESTRICT",
    )
    .await?;
    validate_foreign_key(
        pool,
        "action_invocations",
        "source_interaction_id",
        "interactions",
        "id",
        "CASCADE",
    )
    .await?;
    validate_foreign_key(
        pool,
        "action_invocations",
        "result_interaction_id",
        "interactions",
        "id",
        "CASCADE",
    )
    .await?;
    let violations = sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(pool)
        .await?;
    if !violations.is_empty() {
        return Err(incompatible("stored rows violate product foreign keys"));
    }
    let thread_without_interaction: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM threads t WHERE NOT EXISTS (SELECT 1 FROM interactions i WHERE i.thread_id=t.id))",
    )
    .fetch_one(pool)
    .await?;
    if thread_without_interaction {
        return Err(incompatible(
            "every stored thread must have a root interaction",
        ));
    }
    let cross_thread_invocation: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM action_invocations ai JOIN interactions source ON source.id=ai.source_interaction_id JOIN interactions result ON result.id=ai.result_interaction_id WHERE source.thread_id != result.thread_id)",
    )
    .fetch_one(pool)
    .await?;
    if cross_thread_invocation {
        return Err(incompatible(
            "action invocation source and result must belong to the same thread",
        ));
    }
    let duplicate_action_invocation: bool = sqlx::query_scalar(
        "SELECT EXISTS(
            SELECT 1
            FROM action_invocations ai
            JOIN interactions source ON source.id=ai.source_interaction_id
            JOIN threads thread ON thread.id=source.thread_id
            GROUP BY CASE
                       WHEN thread.project_id IS NOT NULL THEN 'project:' || thread.project_id
                       ELSE 'thread:' || thread.id
                     END,
                     ai.action_id
            HAVING SUM(ai.authoritative) != 1
        )",
    )
    .fetch_one(pool)
    .await?;
    if duplicate_action_invocation {
        return Err(incompatible(
            "a node-owned action must have exactly one authoritative invocation result in its project scope",
        ));
    }
    super::catalog::validate_catalog_rows(pool).await?;
    let invalid_approval_resolution: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM approval_resolutions WHERE outcome NOT IN ('approved','denied','cancelled','expired','aborted') OR actor NOT IN ('user','session_grant','harness','host') OR (decision IS NOT NULL AND decision NOT IN ('approve_once','approve_always','deny')) OR (outcome='approved' AND (decision IS NULL OR decision NOT IN ('approve_once','approve_always'))) OR (outcome='denied' AND (decision IS NULL OR decision!='deny')) OR (outcome IN ('cancelled','expired','aborted') AND decision IS NOT NULL) OR (actor='user' AND (outcome NOT IN ('approved','denied') OR source_request_id IS NOT NULL)) OR (actor='session_grant' AND (outcome!='approved' OR decision IS NULL OR decision!='approve_once' OR source_request_id IS NULL)) OR (actor IN ('harness','host') AND (outcome IN ('approved','denied') OR source_request_id IS NOT NULL)))",
    )
    .fetch_one(pool)
    .await?;
    if invalid_approval_resolution {
        return Err(incompatible(
            "stored approval resolution contains an unsupported product value",
        ));
    }
    let invalid_annotation: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM annotations a WHERE NOT EXISTS (SELECT 1 FROM annotation_revisions r WHERE r.annotation_id=a.id AND r.revision=1) OR (SELECT COUNT(*) FROM annotation_revisions r WHERE r.annotation_id=a.id) != (SELECT MAX(r.revision) FROM annotation_revisions r WHERE r.annotation_id=a.id) OR EXISTS (SELECT 1 FROM annotation_revisions r WHERE r.annotation_id=a.id AND (r.revision<=0 OR r.state NOT IN ('active','retracted') OR (r.rating IS NOT NULL AND r.rating NOT BETWEEN 1 AND 4) OR trim(r.author_id)='' OR trim(r.author_display_name)='' OR (r.state='active' AND trim(r.comment)='') OR (r.state='retracted' AND (r.comment!='' OR r.rating IS NOT NULL)) OR NOT json_valid(r.navigation_context_json) OR NOT json_valid(r.evidence_refs_json))))",
    )
    .fetch_one(pool)
    .await?;
    if invalid_annotation {
        return Err(incompatible(
            "stored annotation history contains invalid rows",
        ));
    }
    Ok(())
}

async fn validate_columns(
    pool: &SqlitePool,
    table: &str,
    expected: &[(&str, &str, bool, i64)],
) -> Result<(), StorageError> {
    let rows = sqlx::query(&format!("PRAGMA table_info({table})"))
        .fetch_all(pool)
        .await?;
    let actual = rows
        .iter()
        .map(column_from_row)
        .collect::<Result<Vec<_>, _>>()?;
    let expected = expected
        .iter()
        .map(
            |(name, declared_type, required, primary_key_position)| Column {
                name: (*name).to_owned(),
                declared_type: (*declared_type).to_owned(),
                required: *required,
                primary_key_position: *primary_key_position,
            },
        )
        .collect::<Vec<_>>();
    if actual != expected {
        return Err(incompatible(&format!(
            "table {table} does not match the supported schema"
        )));
    }
    Ok(())
}

fn column_from_row(row: &SqliteRow) -> Result<Column, StorageError> {
    Ok(Column {
        name: row.try_get("name")?,
        declared_type: row.try_get::<String, _>("type")?.to_ascii_uppercase(),
        required: row.try_get::<i64, _>("notnull")? == 1,
        primary_key_position: row.try_get("pk")?,
    })
}

async fn validate_active_family_name_index(pool: &SqlitePool) -> Result<(), StorageError> {
    let indexes = sqlx::query("PRAGMA index_list(model_families)")
        .fetch_all(pool)
        .await?;
    for index in indexes {
        if index.try_get::<i64, _>("unique")? != 1 || index.try_get::<i64, _>("partial")? != 1 {
            continue;
        }
        let name: String = index.try_get("name")?;
        let escaped = name.replace('"', "\"\"");
        let columns = sqlx::query(&format!("PRAGMA index_xinfo(\"{escaped}\")"))
            .fetch_all(pool)
            .await?
            .into_iter()
            .filter_map(|row| match row.try_get::<i64, _>("key") {
                Ok(1) => Some(Ok((
                    row.try_get::<String, _>("name"),
                    row.try_get::<String, _>("coll"),
                ))),
                Ok(_) => None,
                Err(error) => Some(Err(error)),
            })
            .map(|entry| {
                let (name, collation) = entry?;
                Ok((name?, collation?))
            })
            .collect::<Result<Vec<_>, sqlx::Error>>()?;
        if columns != [("name".to_owned(), "NOCASE".to_owned())] {
            continue;
        }
        let sql: String =
            sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE type='index' AND name=?1")
                .bind(&name)
                .fetch_one(pool)
                .await?;
        let normalized = sql
            .chars()
            .filter(|character| !character.is_whitespace())
            .collect::<String>()
            .to_ascii_lowercase();
        let predicates = normalized.split("where").collect::<Vec<_>>();
        if predicates.len() == 2 && predicates[1] == "lifecycle_state='active'" {
            return Ok(());
        }
    }
    Err(incompatible(
        "table model_families is missing its active-only unique name index",
    ))
}

async fn validate_index(
    pool: &SqlitePool,
    table: &str,
    expected_columns: &[&str],
    unique: bool,
) -> Result<(), StorageError> {
    let indexes = sqlx::query(&format!("PRAGMA index_list({table})"))
        .fetch_all(pool)
        .await?;
    for index in indexes {
        if (index.try_get::<i64, _>("unique")? == 1) != unique {
            continue;
        }
        if index.try_get::<i64, _>("partial")? == 1 {
            continue;
        }
        let name: String = index.try_get("name")?;
        let escaped = name.replace('"', "\"\"");
        let columns = sqlx::query(&format!("PRAGMA index_info(\"{escaped}\")"))
            .fetch_all(pool)
            .await?
            .into_iter()
            .map(|row| row.try_get::<String, _>("name"))
            .collect::<Result<Vec<_>, _>>()?;
        if columns
            .iter()
            .map(String::as_str)
            .eq(expected_columns.iter().copied())
        {
            return Ok(());
        }
    }
    Err(incompatible(&format!(
        "table {table} is missing its required {} index on {}",
        if unique { "unique" } else { "non-unique" },
        expected_columns.join(", ")
    )))
}

async fn validate_foreign_key(
    pool: &SqlitePool,
    table: &str,
    from: &str,
    target_table: &str,
    target_column: &str,
    on_delete: &str,
) -> Result<(), StorageError> {
    let foreign_keys = sqlx::query(&format!("PRAGMA foreign_key_list({table})"))
        .fetch_all(pool)
        .await?;
    let present = foreign_keys.iter().any(|row| {
        let Ok(actual_from) = row.try_get::<String, _>("from") else {
            return false;
        };
        let Ok(actual_table) = row.try_get::<String, _>("table") else {
            return false;
        };
        let Ok(actual_column) = row.try_get::<String, _>("to") else {
            return false;
        };
        let Ok(actual_on_delete) = row.try_get::<String, _>("on_delete") else {
            return false;
        };
        actual_from == from
            && actual_table == target_table
            && actual_column == target_column
            && actual_on_delete == on_delete
    });
    if present {
        Ok(())
    } else {
        Err(incompatible(&format!(
            "table {table} is missing the required {from} foreign key"
        )))
    }
}

fn incompatible(message: &str) -> StorageError {
    StorageError::IncompatibleSchema(message.to_owned())
}

#[cfg(test)]
mod tests {
    use super::super::SqliteProductStore;

    #[tokio::test]
    async fn malformed_active_family_name_index_fails_current_schema_open() {
        for (label, index_sql) in [
            (
                "false-predicate",
                "CREATE UNIQUE INDEX model_families_name_nocase ON model_families(name COLLATE NOCASE) WHERE 1=0 AND lifecycle_state='active'",
            ),
            (
                "binary-collation",
                "CREATE UNIQUE INDEX model_families_name_nocase ON model_families(name) WHERE lifecycle_state='active'",
            ),
        ] {
            let path = std::env::temp_dir().join(format!(
                "relayer-malformed-family-name-index-{label}-{}-{}.sqlite3",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
            ));
            let store = SqliteProductStore::open(&path).await.unwrap();
            let mut connection = store.pool.acquire().await.unwrap();
            sqlx::query("DROP INDEX model_families_name_nocase")
                .execute(&mut *connection)
                .await
                .unwrap();
            sqlx::query(index_sql)
                .execute(&mut *connection)
                .await
                .unwrap();
            drop(connection);
            store.pool.close().await;
            let error = SqliteProductStore::open(&path).await.err().unwrap();
            assert!(error.to_string().contains("active-only unique name index"));
            std::fs::remove_file(path).unwrap();
        }
    }

    #[tokio::test]
    async fn malformed_interaction_context_table_fails_current_schema_open() {
        let path = std::env::temp_dir().join(format!(
            "relayer-malformed-context-schema-{}-{}.sqlite3",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        let store = SqliteProductStore::open(&path).await.unwrap();
        sqlx::query("DROP TABLE interaction_context_annotations")
            .execute(&store.pool)
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE interaction_context_annotations(interaction_id INTEGER NOT NULL,context_position INTEGER NOT NULL,position INTEGER NOT NULL,PRIMARY KEY(interaction_id,context_position,position))",
        )
        .execute(&store.pool)
        .await
        .unwrap();
        store.pool.close().await;
        let error = SqliteProductStore::open(&path).await.err().unwrap();
        assert!(
            error.to_string().contains(
                "table interaction_context_annotations does not match the supported schema"
            )
        );
        std::fs::remove_file(path).unwrap();
    }
}
