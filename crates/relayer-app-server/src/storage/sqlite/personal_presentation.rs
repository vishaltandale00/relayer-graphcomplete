use super::SqliteProductStore;
use crate::{product::InteractionId, storage::StorageError};
use serde_json::Value;
use sqlx::{Row, SqliteConnection};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PersonalPresentationVersion {
    pub(crate) version_key: String,
    pub(crate) profile_interaction_id: i64,
    pub(crate) graph_node_id: Option<i64>,
    pub(crate) root_layer_id: Option<i64>,
    pub(crate) retired: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PersonalPresentationProfile {
    pub(crate) thread_id: i64,
    pub(crate) active_version_key: String,
    pub(crate) versions: Vec<PersonalPresentationVersion>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PersonalPresentationPin {
    pub(crate) interaction_id: InteractionId,
    pub(crate) version_key: String,
    pub(crate) version_interaction_node_id: i64,
    pub(crate) root_layer_id: i64,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct PersonalPresentationAttachmentState {
    pub(super) pin: Option<(String, i64, i64)>,
    pub(super) legacy_unpinned: bool,
}

pub(super) async fn personal_presentation_attachment_state(
    connection: &mut SqliteConnection,
    interaction_id: InteractionId,
) -> Result<PersonalPresentationAttachmentState, StorageError> {
    let pin = sqlx::query_as(
        "SELECT version_key,version_interaction_node_id,root_layer_id FROM interaction_personal_presentation_pins WHERE interaction_id=?1",
    )
    .bind(interaction_id.value())
    .fetch_optional(&mut *connection)
    .await?;
    let legacy_unpinned = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM legacy_unpinned_personal_presentation_interactions WHERE interaction_id=?1)",
    )
    .bind(interaction_id.value())
    .fetch_one(&mut *connection)
    .await?;
    Ok(PersonalPresentationAttachmentState {
        pin,
        legacy_unpinned,
    })
}

impl SqliteProductStore {
    pub(crate) async fn personal_presentation_profile(
        &self,
    ) -> Result<PersonalPresentationProfile, StorageError> {
        let mut transaction = self.pool.begin().await?;
        let policy = sqlx::query(
            "SELECT profile_thread_id,active_version_key FROM personal_presentation_policy WHERE singleton=1",
        )
        .fetch_one(&mut *transaction)
        .await?;
        let rows = sqlx::query(
            "SELECT version.version_key,version.profile_interaction_id,version.graph_node_id,version.root_layer_id,version.retired FROM personal_presentation_versions version JOIN interactions interaction ON interaction.id=version.profile_interaction_id ORDER BY interaction.sequence",
        )
        .fetch_all(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(PersonalPresentationProfile {
            thread_id: policy.try_get(0)?,
            active_version_key: policy.try_get(1)?,
            versions: rows
                .iter()
                .map(|row| {
                    Ok(PersonalPresentationVersion {
                        version_key: row.try_get(0)?,
                        profile_interaction_id: row.try_get(1)?,
                        graph_node_id: row.try_get(2)?,
                        root_layer_id: row.try_get(3)?,
                        retired: row.try_get::<i64, _>(4)? != 0,
                    })
                })
                .collect::<Result<_, sqlx::Error>>()?,
        })
    }

    pub(crate) async fn publish_personal_presentation_version(
        &self,
        version_key: &str,
        graph_node_id: i64,
        root_layer_id: i64,
        completion_output: &Value,
        published_at: &str,
    ) -> Result<PersonalPresentationVersion, StorageError> {
        if graph_node_id <= 0 || root_layer_id <= 0 {
            return Err(StorageError::PersonalPresentationConflict(
                "graph version and root layer IDs must be positive".into(),
            ));
        }
        if completion_output.get("nodeId").and_then(Value::as_i64) != Some(graph_node_id)
            || completion_output
                .pointer("/rootLayer/layer/id")
                .and_then(Value::as_i64)
                != Some(root_layer_id)
        {
            return Err(StorageError::PersonalPresentationConflict(
                "completion output does not match the published version identity".into(),
            ));
        }
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let row = sqlx::query(
            "SELECT profile_interaction_id,graph_node_id,root_layer_id,retired FROM personal_presentation_versions WHERE version_key=?1",
        )
        .bind(version_key)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(|| StorageError::PersonalPresentationConflict(format!(
            "unknown personal presentation version {version_key}"
        )))?;
        let profile_interaction_id = row.try_get(0)?;
        let stored_graph: Option<i64> = row.try_get(1)?;
        let stored_root: Option<i64> = row.try_get(2)?;
        let retired = row.try_get::<i64, _>(3)? != 0;
        match (stored_graph, stored_root) {
            (Some(stored_graph), Some(stored_root))
                if stored_graph == graph_node_id && stored_root == root_layer_id =>
            {
                transaction.commit().await?;
                return Ok(PersonalPresentationVersion {
                    version_key: version_key.into(),
                    profile_interaction_id,
                    graph_node_id: Some(graph_node_id),
                    root_layer_id: Some(root_layer_id),
                    retired,
                });
            }
            (Some(_), Some(_)) => {
                return Err(StorageError::PersonalPresentationConflict(format!(
                    "personal presentation version {version_key} is immutable"
                )));
            }
            (None, None) => {}
            _ => {
                return Err(StorageError::PersonalPresentationConflict(
                    "personal presentation version identity is partially populated".into(),
                ));
            }
        }
        let output_json = serde_json::to_string(completion_output)
            .map_err(|error| StorageError::Serialization(error.to_string()))?;
        let result = sqlx::query(
            "UPDATE personal_presentation_versions SET graph_node_id=?1,root_layer_id=?2,published_at=?3 WHERE version_key=?4 AND graph_node_id IS NULL AND root_layer_id IS NULL",
        )
        .bind(graph_node_id)
        .bind(root_layer_id)
        .bind(published_at)
        .bind(version_key)
        .execute(&mut *transaction)
        .await?;
        if result.rows_affected() != 1 {
            return Err(StorageError::PersonalPresentationConflict(
                "personal presentation publication raced with another value".into(),
            ));
        }
        sqlx::query(
            "UPDATE interactions SET graph_node_id=?1,completion_status='accepted',harness_configuration_name='personal-presentation-profile',harness_configuration_digest=?2,effective_execution_digest=?2,effective_permission_receipt_json='{}',completion_output_json=?3,completion_error=NULL WHERE id=?4 AND completion_status='profile_pending'",
        )
        .bind(graph_node_id)
        .bind(format!("sha256:{version_key}"))
        .bind(output_json)
        .bind(profile_interaction_id)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(PersonalPresentationVersion {
            version_key: version_key.into(),
            profile_interaction_id,
            graph_node_id: Some(graph_node_id),
            root_layer_id: Some(root_layer_id),
            retired,
        })
    }

    #[cfg(test)]
    pub(crate) async fn pin_personal_presentation(
        &self,
        interaction_id: InteractionId,
        version: &PersonalPresentationVersion,
        pinned_at: &str,
    ) -> Result<PersonalPresentationPin, StorageError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let pin = pin_in_transaction(&mut transaction, interaction_id, version, pinned_at).await?;
        transaction.commit().await?;
        Ok(pin)
    }

    pub(crate) async fn prepare_personal_presentation_pin(
        &self,
        interaction_id: InteractionId,
        requested_version_key: Option<&str>,
        pinned_at: &str,
    ) -> Result<Option<PersonalPresentationPin>, StorageError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        validate_personal_presentation_target(&mut transaction, interaction_id).await?;
        let attachment =
            personal_presentation_attachment_state(&mut transaction, interaction_id).await?;
        if let Some((version_key, graph_node_id, root_layer_id)) = attachment.pin {
            if requested_version_key.is_some_and(|requested| requested != version_key.as_str()) {
                return Err(StorageError::PersonalPresentationConflict(format!(
                    "interaction is pinned to {version_key}, not requested version {}",
                    requested_version_key.expect("checked as present")
                )));
            }
            transaction.commit().await?;
            return Ok(Some(PersonalPresentationPin {
                interaction_id,
                version_key,
                version_interaction_node_id: graph_node_id,
                root_layer_id,
            }));
        }
        if requested_version_key.is_none() && attachment.legacy_unpinned {
            transaction.commit().await?;
            return Ok(None);
        }
        let version_key =
            match requested_version_key {
                Some(value) => value.to_owned(),
                None => sqlx::query_scalar(
                    "SELECT active_version_key FROM personal_presentation_policy WHERE singleton=1",
                )
                .fetch_one(&mut *transaction)
                .await?,
            };
        let row = sqlx::query(
            "SELECT profile_interaction_id,graph_node_id,root_layer_id,retired FROM personal_presentation_versions WHERE version_key=?1",
        )
        .bind(&version_key)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(|| StorageError::PersonalPresentationConflict(format!(
            "unknown personal presentation version {version_key}"
        )))?;
        let version = PersonalPresentationVersion {
            version_key,
            profile_interaction_id: row.try_get(0)?,
            graph_node_id: row.try_get(1)?,
            root_layer_id: row.try_get(2)?,
            retired: row.try_get::<i64, _>(3)? != 0,
        };
        let pin = pin_in_transaction(&mut transaction, interaction_id, &version, pinned_at).await?;
        transaction.commit().await?;
        Ok(Some(pin))
    }

    #[cfg(test)]
    pub(crate) async fn activate_personal_presentation_version(
        &self,
        version_key: &str,
    ) -> Result<(), StorageError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let eligible: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM personal_presentation_versions WHERE version_key=?1 AND graph_node_id IS NOT NULL AND root_layer_id IS NOT NULL AND retired=0)",
        )
        .bind(version_key)
        .fetch_one(&mut *transaction)
        .await?;
        if !eligible {
            return Err(StorageError::PersonalPresentationConflict(format!(
                "personal presentation version {version_key} is not eligible for activation"
            )));
        }
        sqlx::query(
            "UPDATE personal_presentation_policy SET active_version_key=?1 WHERE singleton=1",
        )
        .bind(version_key)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(())
    }
}

async fn pin_in_transaction(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    interaction_id: InteractionId,
    version: &PersonalPresentationVersion,
    pinned_at: &str,
) -> Result<PersonalPresentationPin, StorageError> {
    let graph_node_id = version.graph_node_id.ok_or_else(|| {
        StorageError::PersonalPresentationConflict(
            "personal presentation version is unpublished".into(),
        )
    })?;
    let root_layer_id = version.root_layer_id.ok_or_else(|| {
        StorageError::PersonalPresentationConflict(
            "personal presentation version is unpublished".into(),
        )
    })?;
    if version.retired {
        return Err(StorageError::PersonalPresentationConflict(
            "personal presentation version is retired".into(),
        ));
    }
    validate_personal_presentation_target(transaction, interaction_id).await?;
    if let Some((version_key, stored_graph, stored_root)) =
        sqlx::query_as::<_, (String, i64, i64)>(
            "SELECT version_key,version_interaction_node_id,root_layer_id FROM interaction_personal_presentation_pins WHERE interaction_id=?1",
        )
        .bind(interaction_id.value())
        .fetch_optional(&mut **transaction)
        .await?
    {
        if version_key == version.version_key
            && stored_graph == graph_node_id
            && stored_root == root_layer_id
        {
            return Ok(PersonalPresentationPin {
                interaction_id,
                version_key,
                version_interaction_node_id: stored_graph,
                root_layer_id: stored_root,
            });
        }
        return Err(StorageError::PersonalPresentationConflict(
            "interaction already pins another personal presentation version".into(),
        ));
    }
    sqlx::query(
        "INSERT INTO interaction_personal_presentation_pins(interaction_id,version_key,version_interaction_node_id,root_layer_id,pinned_at) VALUES (?1,?2,?3,?4,?5)",
    )
    .bind(interaction_id.value())
    .bind(&version.version_key)
    .bind(graph_node_id)
    .bind(root_layer_id)
    .bind(pinned_at)
    .execute(&mut **transaction)
    .await?;
    Ok(PersonalPresentationPin {
        interaction_id,
        version_key: version.version_key.clone(),
        version_interaction_node_id: graph_node_id,
        root_layer_id,
    })
}

async fn validate_personal_presentation_target(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    interaction_id: InteractionId,
) -> Result<(), StorageError> {
    let target_is_visible: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM interactions i JOIN threads t ON t.id=i.thread_id WHERE i.id=?1 AND t.surface='conversation' AND t.conversation_import_id IS NULL)",
    )
    .bind(interaction_id.value())
    .fetch_one(&mut **transaction)
    .await?;
    if target_is_visible {
        return Ok(());
    }
    Err(StorageError::PersonalPresentationConflict(
        "personal presentation can only pin a product interaction".into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::super::SqliteProductStore;

    #[tokio::test]
    async fn hidden_profile_versions_publish_once_and_pin_interactions_immutably() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let store = SqliteProductStore::open(file.path()).await.unwrap();

        assert!(store.list_threads().await.unwrap().is_empty());
        let profile = store.personal_presentation_profile().await.unwrap();
        assert_eq!(
            profile
                .versions
                .iter()
                .map(|version| version.version_key.as_str())
                .collect::<Vec<_>>(),
            vec![
                "personal-presentation-v0",
                "personal-presentation-v1",
                "personal-presentation-v2",
                "personal-presentation-v3",
            ]
        );
        assert_eq!(profile.active_version_key, "personal-presentation-v1");
        assert!(
            profile
                .versions
                .iter()
                .all(|version| version.graph_node_id.is_none())
        );
        let v0 = store
            .publish_personal_presentation_version(
                "personal-presentation-v0",
                501,
                601,
                &serde_json::json!({"nodeId":501,"rootLayer":{"layer":{"id":601}}}),
                "1",
            )
            .await
            .unwrap();
        let replay = store
            .publish_personal_presentation_version(
                "personal-presentation-v0",
                501,
                601,
                &serde_json::json!({"nodeId":501,"rootLayer":{"layer":{"id":601}}}),
                "1",
            )
            .await
            .unwrap();
        assert_eq!(v0, replay);
        assert!(
            store
                .insert_thread_with_initial_interaction(crate::storage::NewThreadRecord {
                    title: "Unavailable",
                    project_id: None,
                    initial_message: "Must not persist",
                    harness_configuration_name: "codex-basic",
                    permission_profile_id: "auto",
                    model_selection: None,
                    timestamp: "0",
                })
                .await
                .is_err()
        );
        assert!(store.list_threads().await.unwrap().is_empty());
        store
            .publish_personal_presentation_version(
                "personal-presentation-v1",
                502,
                602,
                &serde_json::json!({"nodeId":502,"rootLayer":{"layer":{"id":602}}}),
                "1",
            )
            .await
            .unwrap();
        sqlx::query("INSERT INTO conversation_imports(id,source_sha256,export_version,producer_json,header_json,state,created_at) VALUES ('import-1','sha256:test',1,'{}','{}','staging','1')")
            .execute(&store.pool)
            .await
            .unwrap();
        let imported_thread = sqlx::query("INSERT INTO threads(title,created_at,updated_at,conversation_import_id) VALUES ('Imported','1','1','import-1')")
            .execute(&store.pool)
            .await
            .unwrap()
            .last_insert_rowid();
        let imported_interaction = sqlx::query("INSERT INTO interactions(thread_id,sequence,text,created_at,completion_status) VALUES (?1,1,'Historical turn','1','accepted')")
            .bind(imported_thread)
            .execute(&store.pool)
            .await
            .unwrap()
            .last_insert_rowid();
        let imported_pin_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM interaction_personal_presentation_pins WHERE interaction_id=?1",
        )
        .bind(imported_interaction)
        .fetch_one(&store.pool)
        .await
        .unwrap();
        assert_eq!(imported_pin_count, 0);
        assert!(
            store
                .publish_personal_presentation_version(
                    "personal-presentation-v0",
                    502,
                    602,
                    &serde_json::json!({"nodeId":502}),
                    "2",
                )
                .await
                .is_err()
        );

        let thread = store
            .insert_thread_with_initial_interaction_and_personal_presentation(
                crate::storage::NewThreadRecord {
                    title: "Visible",
                    project_id: None,
                    initial_message: "Question",
                    harness_configuration_name: "codex-layered-personal-presentation-v0",
                    permission_profile_id: "auto",
                    model_selection: None,
                    timestamp: "2",
                },
                Some("personal-presentation-v0"),
            )
            .await
            .unwrap();
        let pin = store
            .prepare_personal_presentation_pin(
                thread.root_interaction_id,
                Some("personal-presentation-v0"),
                "3",
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(pin.version_interaction_node_id, 501);
        assert!(
            store
                .prepare_personal_presentation_pin(
                    thread.root_interaction_id,
                    Some("personal-presentation-v1"),
                    "3",
                )
                .await
                .is_err()
        );
        assert_eq!(
            store
                .pin_personal_presentation(thread.root_interaction_id, &v0, "4")
                .await
                .unwrap(),
            pin
        );
        store
            .activate_personal_presentation_version("personal-presentation-v0")
            .await
            .unwrap();
        store
            .activate_personal_presentation_version("personal-presentation-v1")
            .await
            .unwrap();
        let next = store
            .insert_thread_with_initial_interaction(crate::storage::NewThreadRecord {
                title: "Next",
                project_id: None,
                initial_message: "Question after activation",
                harness_configuration_name: "codex-basic",
                permission_profile_id: "auto",
                model_selection: None,
                timestamp: "5",
            })
            .await
            .unwrap();
        let next_pin = store
            .prepare_personal_presentation_pin(next.root_interaction_id, None, "6")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(next_pin.version_interaction_node_id, 502);
        assert_eq!(
            store
                .prepare_personal_presentation_pin(thread.root_interaction_id, None, "7")
                .await
                .unwrap()
                .unwrap(),
            pin
        );
        assert!(
            store
                .prepare_personal_presentation_pin(
                    crate::product::InteractionId::from_database(imported_interaction),
                    None,
                    "8",
                )
                .await
                .is_err()
        );
        sqlx::query("INSERT INTO interaction_personal_presentation_pins(interaction_id,version_key,version_interaction_node_id,root_layer_id,pinned_at) VALUES (?1,'personal-presentation-v1',502,602,'legacy')")
            .bind(imported_interaction)
            .execute(&store.pool)
            .await
            .unwrap();
        assert!(
            store
                .prepare_personal_presentation_pin(
                    crate::product::InteractionId::from_database(imported_interaction),
                    None,
                    "9",
                )
                .await
                .is_err()
        );
        store.pool.close().await;
        assert!(SqliteProductStore::open(file.path()).await.is_err());
    }

    #[tokio::test]
    async fn retired_versions_preserve_historical_threads_and_pins() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let store = SqliteProductStore::open(file.path()).await.unwrap();
        let version = store
            .publish_personal_presentation_version(
                "personal-presentation-v0",
                501,
                601,
                &serde_json::json!({"nodeId":501,"rootLayer":{"layer":{"id":601}}}),
                "1",
            )
            .await
            .unwrap();
        let thread = store
            .insert_thread_with_initial_interaction_and_personal_presentation(
                crate::storage::NewThreadRecord {
                    title: "Historical",
                    project_id: None,
                    initial_message: "Question",
                    harness_configuration_name: "codex-layered-personal-presentation-v0",
                    permission_profile_id: "auto",
                    model_selection: None,
                    timestamp: "2",
                },
                Some("personal-presentation-v0"),
            )
            .await
            .unwrap();
        store
            .pin_personal_presentation(thread.root_interaction_id, &version, "3")
            .await
            .unwrap();
        sqlx::query(
            "UPDATE personal_presentation_versions SET retired=1 WHERE version_key='personal-presentation-v0'",
        )
        .execute(&store.pool)
        .await
        .unwrap();
        store.pool.close().await;

        let reopened = SqliteProductStore::open(file.path()).await.unwrap();
        let replay = reopened
            .prepare_personal_presentation_pin(thread.root_interaction_id, None, "4")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(replay.version_key, "personal-presentation-v0");
        assert_eq!(replay.version_interaction_node_id, 501);
        assert_eq!(replay.root_layer_id, 601);
        assert!(
            reopened
                .insert_thread_with_initial_interaction_and_personal_presentation(
                    crate::storage::NewThreadRecord {
                        title: "Rejected",
                        project_id: None,
                        initial_message: "New question",
                        harness_configuration_name: "codex-layered-personal-presentation-v0",
                        permission_profile_id: "auto",
                        model_selection: None,
                        timestamp: "5",
                    },
                    Some("personal-presentation-v0"),
                )
                .await
                .is_err()
        );
    }
}
