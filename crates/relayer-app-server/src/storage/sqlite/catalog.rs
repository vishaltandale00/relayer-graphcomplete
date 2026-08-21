use super::SqliteProductStore;
use crate::product::{
    CatalogError, CreateModelFamilyCommand, HarnessModelCompatibility, ModelFamily, ModelFamilyId,
    ModelFamilyKind, ModelFamilyMember, ModelSettings, ModelSettingsDefaults, ProductHarness,
    Provider, ProviderCatalogSnapshot, ProviderId, ProviderModel, ReorderModelFamiliesCommand,
    RuntimeProductHarness, SystemFamilySnapshot, UnavailableReason, UpdateModelFamilyCommand,
    UpdateModelSettingsDefaultsCommand, ValidateModelSelectionCommand, validate_family,
};
use crate::storage::StorageError;
use sqlx::{Row, SqliteConnection, SqlitePool, sqlite::SqliteRow};
use std::{
    collections::HashMap,
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_PROVIDER_CATALOG_AGE_MS: u128 = 10_000;

impl SqliteProductStore {
    pub(crate) async fn initialize_model_catalog(
        &self,
        default_harness: &str,
        runtime_harnesses: &[RuntimeProductHarness],
    ) -> Result<(), StorageError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        sqlx::query(
            "UPDATE product_harnesses SET available=0,unavailable_reason_code='harness_unavailable',unavailable_reason_message='The harness runtime is unavailable.'",
        )
        .execute(&mut *transaction)
        .await?;
        let mut harnesses = runtime_harnesses.to_vec();
        if !harnesses
            .iter()
            .any(|harness| harness.id == default_harness)
        {
            harnesses.push(RuntimeProductHarness {
                id: default_harness.to_owned(),
                model_compatibility: Vec::new(),
            });
        }
        harnesses.sort_by(|left, right| left.id.cmp(&right.id));
        harnesses.dedup_by(|left, right| left.id == right.id);
        for harness in harnesses {
            let available = runtime_harnesses.iter().any(|item| item.id == harness.id);
            sqlx::query(
                "INSERT INTO product_harnesses(configuration_name,label,product_visible,available,unavailable_reason_code,unavailable_reason_message) VALUES (?1,?2,1,?3,?4,?5) ON CONFLICT(configuration_name) DO UPDATE SET label=excluded.label,product_visible=1,available=excluded.available,unavailable_reason_code=excluded.unavailable_reason_code,unavailable_reason_message=excluded.unavailable_reason_message",
            )
            .bind(&harness.id)
            .bind(harness_label(&harness.id))
            .bind(available)
            .bind((!available).then_some("harness_unavailable"))
            .bind((!available).then_some("The harness runtime is unavailable."))
            .execute(&mut *transaction)
            .await?;
            if available {
                sqlx::query("DELETE FROM harness_provider_compatibility WHERE harness_configuration_name=?1")
                    .bind(&harness.id)
                    .execute(&mut *transaction)
                    .await?;
                for compatibility in &harness.model_compatibility {
                    sqlx::query("INSERT OR IGNORE INTO model_providers(id,label,connected,unavailable_reason_code,unavailable_reason_message,refreshed_at) VALUES (?1,?1,0,'provider_disconnected','The provider is not connected.','0')")
                        .bind(compatibility.provider_id.as_str())
                        .execute(&mut *transaction)
                        .await?;
                    sqlx::query("INSERT INTO harness_provider_compatibility(harness_configuration_name,provider_id,all_models,preferred_model_id) VALUES (?1,?2,?3,?4)")
                        .bind(&harness.id)
                        .bind(compatibility.provider_id.as_str())
                        .bind(compatibility.model_ids.is_none())
                        .bind(compatibility.preferred_model_id.as_deref())
                        .execute(&mut *transaction)
                        .await?;
                    for model_id in compatibility.model_ids.iter().flatten() {
                        sqlx::query("INSERT INTO harness_model_compatibility(harness_configuration_name,provider_id,model_id) VALUES (?1,?2,?3)")
                            .bind(&harness.id)
                            .bind(compatibility.provider_id.as_str())
                            .bind(model_id)
                            .execute(&mut *transaction)
                            .await?;
                    }
                }
            }
        }
        sqlx::query(
            "UPDATE product_model_preferences SET default_harness_configuration_name=?1 WHERE singleton=1 AND defaults_modified=0",
        )
        .bind(default_harness)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(())
    }

    pub(crate) async fn load_model_settings(&self) -> Result<ModelSettings, StorageError> {
        let mut transaction = self.pool.begin().await?;
        let defaults = load_defaults(&mut transaction).await?;
        let harnesses = load_harnesses(&mut transaction).await?;
        let providers = load_providers(&mut transaction).await?;
        let families = load_families(&mut transaction).await?;
        transaction.commit().await?;
        Ok(ModelSettings {
            defaults,
            harnesses,
            providers,
            families,
        })
    }

    pub(crate) async fn update_model_settings_defaults(
        &self,
        command: &UpdateModelSettingsDefaultsCommand,
    ) -> Result<ModelSettingsDefaults, StorageError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        if let Some(harness_id) = command.harness_id.as_deref() {
            let available = sqlx::query_scalar::<_, bool>(
                "SELECT available FROM product_harnesses WHERE configuration_name=?1 AND product_visible=1",
            )
            .bind(harness_id)
            .fetch_optional(&mut *transaction)
            .await?
            .ok_or_else(|| {
                StorageError::Catalog(CatalogError::invalid(
                    "harness_unknown",
                    "Unknown product harness.",
                ))
            })?;
            if !available {
                return Err(StorageError::Catalog(CatalogError::invalid(
                    "harness_unavailable",
                    "The selected harness is unavailable.",
                )));
            }
        }
        if let Some(provider_id) = command.provider_id.as_ref() {
            let connected =
                sqlx::query_scalar::<_, bool>("SELECT connected FROM model_providers WHERE id=?1")
                    .bind(provider_id.as_str())
                    .fetch_optional(&mut *transaction)
                    .await?
                    .ok_or_else(|| {
                        StorageError::Catalog(CatalogError::invalid(
                            "provider_unknown",
                            "Unknown provider.",
                        ))
                    })?;
            if !connected {
                return Err(StorageError::Catalog(CatalogError::invalid(
                    "provider_disconnected",
                    "The selected provider is not connected.",
                )));
            }
        }
        sqlx::query(
            "UPDATE product_model_preferences SET default_harness_configuration_name=COALESCE(?1,default_harness_configuration_name),default_provider_id=COALESCE(?2,default_provider_id),defaults_modified=1 WHERE singleton=1",
        )
        .bind(command.harness_id.as_deref())
        .bind(command.provider_id.as_ref().map(ProviderId::as_str))
        .execute(&mut *transaction)
        .await?;
        let defaults = load_defaults(&mut transaction).await?;
        transaction.commit().await?;
        Ok(defaults)
    }

    pub(crate) async fn publish_provider_catalog(
        &self,
        snapshot: &ProviderCatalogSnapshot,
        timestamp: &str,
    ) -> Result<(), StorageError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        sqlx::query(
            "INSERT INTO model_providers(id,label,connected,unavailable_reason_code,unavailable_reason_message,refreshed_at) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET label=excluded.label,connected=excluded.connected,unavailable_reason_code=excluded.unavailable_reason_code,unavailable_reason_message=excluded.unavailable_reason_message,refreshed_at=excluded.refreshed_at",
        )
        .bind(snapshot.provider_id.as_str())
        .bind(&snapshot.label)
        .bind(snapshot.connected)
        .bind(snapshot.unavailable_reason.as_ref().map(|reason| &reason.code))
        .bind(snapshot.unavailable_reason.as_ref().map(|reason| &reason.message))
        .bind(timestamp)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            "UPDATE provider_models SET available=0,unavailable_reason_code='model_not_reported',unavailable_reason_message='The provider no longer reports this model.' WHERE provider_id=?1",
        )
        .bind(snapshot.provider_id.as_str())
        .execute(&mut *transaction)
        .await?;
        for model in &snapshot.models {
            sqlx::query(
                "INSERT INTO provider_models(provider_id,model_id,label,provider_order,visible,available,unavailable_reason_code,unavailable_reason_message,provider_default,replacement_model_id,metadata_json) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11) ON CONFLICT(provider_id,model_id) DO UPDATE SET label=excluded.label,provider_order=excluded.provider_order,visible=excluded.visible,available=excluded.available,unavailable_reason_code=excluded.unavailable_reason_code,unavailable_reason_message=excluded.unavailable_reason_message,provider_default=excluded.provider_default,replacement_model_id=excluded.replacement_model_id,metadata_json=excluded.metadata_json",
            )
            .bind(snapshot.provider_id.as_str())
            .bind(&model.id)
            .bind(&model.label)
            .bind(model.order as i64)
            .bind(model.visible)
            .bind(model.available)
            .bind(model.unavailable_reason.as_ref().map(|reason| &reason.code))
            .bind(model.unavailable_reason.as_ref().map(|reason| &reason.message))
            .bind(model.provider_default)
            .bind(&model.replacement_model_id)
            .bind(serde_json::to_string(&model.metadata).map_err(|error| {
                StorageError::Serialization(error.to_string())
            })?)
            .execute(&mut *transaction)
            .await?;
        }
        if let Some(system_family) = &snapshot.system_family
            && !system_family.model_ids.is_empty()
        {
            replace_system_family(&mut transaction, snapshot, system_family).await?;
        }
        transaction.commit().await?;
        Ok(())
    }

    pub(crate) async fn create_model_family(
        &self,
        command: &CreateModelFamilyCommand,
    ) -> Result<ModelFamily, StorageError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let position: i64 =
            sqlx::query_scalar("SELECT COALESCE(MAX(position),-1)+1 FROM model_families")
                .fetch_one(&mut *transaction)
                .await?;
        let result = sqlx::query(
            "INSERT INTO model_families(name,kind,system_key,enabled,position) VALUES (?1,'custom',NULL,?2,?3)",
        )
        .bind(&command.name)
        .bind(command.enabled)
        .bind(position)
        .execute(&mut *transaction)
        .await?;
        let id = ModelFamilyId::from_database(result.last_insert_rowid());
        replace_family_members(&mut transaction, id, &command.members).await?;
        transaction.commit().await?;
        self.get_model_family(id)
            .await?
            .ok_or_else(|| sqlx::Error::RowNotFound.into())
    }

    pub(crate) async fn get_model_family(
        &self,
        id: ModelFamilyId,
    ) -> Result<Option<ModelFamily>, StorageError> {
        let mut connection = self.pool.acquire().await?;
        load_family(&mut connection, id).await
    }

    pub(crate) async fn update_model_family(
        &self,
        command: &UpdateModelFamilyCommand,
    ) -> Result<ModelFamily, StorageError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        if let Some(name) = &command.name {
            sqlx::query("UPDATE model_families SET name=?1,enabled=?2 WHERE id=?3")
                .bind(name)
                .bind(command.enabled)
                .bind(command.id.value())
                .execute(&mut *transaction)
                .await?;
        } else {
            sqlx::query("UPDATE model_families SET enabled=?1 WHERE id=?2")
                .bind(command.enabled)
                .bind(command.id.value())
                .execute(&mut *transaction)
                .await?;
        }
        if let Some(members) = &command.members {
            replace_family_members(&mut transaction, command.id, members).await?;
        }
        transaction.commit().await?;
        self.get_model_family(command.id)
            .await?
            .ok_or_else(|| sqlx::Error::RowNotFound.into())
    }

    pub(crate) async fn delete_model_family(
        &self,
        id: ModelFamilyId,
    ) -> Result<bool, StorageError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let deleted = sqlx::query("DELETE FROM model_families WHERE id=?1 AND kind='custom'")
            .bind(id.value())
            .execute(&mut *transaction)
            .await?
            .rows_affected()
            == 1;
        compact_family_positions(&mut transaction).await?;
        transaction.commit().await?;
        Ok(deleted)
    }

    pub(crate) async fn reorder_model_families(
        &self,
        command: &ReorderModelFamiliesCommand,
    ) -> Result<(), StorageError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let expected = sqlx::query_scalar::<_, i64>("SELECT id FROM model_families")
            .fetch_all(&mut *transaction)
            .await?
            .into_iter()
            .collect::<std::collections::HashSet<_>>();
        let supplied = command
            .family_ids
            .iter()
            .map(|id| id.value())
            .collect::<std::collections::HashSet<_>>();
        if supplied.len() != command.family_ids.len() || supplied != expected {
            return Err(StorageError::Catalog(CatalogError::invalid(
                "model_family_order_invalid",
                "familyIds must contain every model family exactly once.",
            )));
        }
        // Offset first so the UNIQUE(position) constraint cannot observe transient collisions.
        sqlx::query("UPDATE model_families SET position=position+1000000")
            .execute(&mut *transaction)
            .await?;
        for (position, id) in command.family_ids.iter().enumerate() {
            sqlx::query("UPDATE model_families SET position=?1 WHERE id=?2")
                .bind(position as i64)
                .bind(id.value())
                .execute(&mut *transaction)
                .await?;
        }
        transaction.commit().await?;
        Ok(())
    }

    pub(crate) async fn validate_model_selection(
        &self,
        command: &ValidateModelSelectionCommand,
    ) -> Result<(), StorageError> {
        let mut connection = self.pool.acquire().await?;
        validate_model_selection_on(&mut connection, command).await
    }

    pub(crate) async fn validate_execution_model_selection(
        &self,
        harness_id: &str,
        selection: &crate::product::InteractionModelSelection,
    ) -> Result<(), StorageError> {
        let mut connection = self.pool.acquire().await?;
        validate_execution_model_selection_on(&mut connection, harness_id, selection).await
    }
}

pub(super) async fn validate_model_selection_on(
    connection: &mut SqliteConnection,
    command: &ValidateModelSelectionCommand,
) -> Result<(), StorageError> {
    let row = sqlx::query(
            "SELECT h.product_visible AS harness_visible,h.available AS harness_available,p.connected AS provider_connected,m.visible AS model_visible,m.available AS model_available,f.enabled AS family_enabled,EXISTS(SELECT 1 FROM harness_provider_compatibility c WHERE c.harness_configuration_name=h.configuration_name AND c.provider_id=p.id AND (c.all_models=1 OR EXISTS(SELECT 1 FROM harness_model_compatibility cm WHERE cm.harness_configuration_name=c.harness_configuration_name AND cm.provider_id=c.provider_id AND cm.model_id=m.model_id))) AS compatible,EXISTS(SELECT 1 FROM model_family_members fm WHERE fm.family_id=f.id AND fm.provider_id=p.id AND fm.model_id=m.model_id) AS member FROM product_harnesses h JOIN model_providers p ON p.id=?2 JOIN provider_models m ON m.provider_id=p.id AND m.model_id=?3 JOIN model_families f ON f.id=?4 WHERE h.configuration_name=?1",
        )
        .bind(&command.harness_id)
        .bind(command.provider_id.as_str())
        .bind(&command.model_id)
        .bind(command.family_id.value())
        .fetch_optional(connection)
        .await?;
    let Some(row) = row else {
        return Err(StorageError::Catalog(CatalogError::selection(
            "model_selection_unknown",
            "The selected harness, family, provider, or model is unknown.",
            command,
        )));
    };
    let checks = [
        (
            row.get::<bool, _>("harness_visible"),
            "harness_not_product_visible",
            "The selected harness is not available to product callers.",
        ),
        (
            row.get::<bool, _>("harness_available"),
            "harness_unavailable",
            "No available models for this harness",
        ),
        (
            row.get::<bool, _>("provider_connected"),
            "provider_disconnected",
            "The selected provider is not connected.",
        ),
        (
            row.get::<bool, _>("model_visible"),
            "model_hidden",
            "The selected model is hidden.",
        ),
        (
            row.get::<bool, _>("model_available"),
            "model_unavailable",
            "The selected model is unavailable.",
        ),
        (
            row.get::<bool, _>("family_enabled"),
            "model_family_disabled",
            "The selected model family is disabled.",
        ),
        (
            row.get::<bool, _>("compatible"),
            "harness_model_incompatible",
            "No available models for this harness",
        ),
        (
            row.get::<bool, _>("member"),
            "model_not_in_family",
            "The selected model is not in this family.",
        ),
    ];
    for (valid, code, message) in checks {
        if !valid {
            return Err(StorageError::Catalog(CatalogError::selection(
                code, message, command,
            )));
        }
    }
    Ok(())
}

pub(super) async fn validate_execution_model_selection_on(
    connection: &mut SqliteConnection,
    harness_id: &str,
    selection: &crate::product::InteractionModelSelection,
) -> Result<(), StorageError> {
    let command = ValidateModelSelectionCommand {
        harness_id: harness_id.to_owned(),
        family_id: selection.family_id,
        provider_id: selection.provider_id.clone(),
        model_id: selection.model_id.clone(),
    };
    let row = sqlx::query(
        "SELECT h.product_visible AS harness_visible,h.available AS harness_available,p.connected AS provider_connected,p.refreshed_at AS provider_refreshed_at,m.available AS model_available,EXISTS(SELECT 1 FROM harness_provider_compatibility c WHERE c.harness_configuration_name=h.configuration_name AND c.provider_id=p.id AND (c.all_models=1 OR EXISTS(SELECT 1 FROM harness_model_compatibility cm WHERE cm.harness_configuration_name=c.harness_configuration_name AND cm.provider_id=c.provider_id AND cm.model_id=m.model_id))) AS compatible FROM product_harnesses h JOIN model_providers p ON p.id=?2 JOIN provider_models m ON m.provider_id=p.id AND m.model_id=?3 WHERE h.configuration_name=?1",
    )
    .bind(harness_id)
    .bind(selection.provider_id.as_str())
    .bind(&selection.model_id)
    .fetch_optional(&mut *connection)
    .await?;
    let Some(row) = row else {
        return Err(StorageError::Catalog(CatalogError::selection(
            "model_selection_unknown",
            "The selected harness, provider, or model is unknown.",
            &command,
        )));
    };
    let checks = [
        (
            row.get::<bool, _>("harness_visible"),
            "harness_not_product_visible",
            "The selected harness is not available to product callers.",
        ),
        (
            row.get::<bool, _>("harness_available"),
            "harness_unavailable",
            "No available models for this harness",
        ),
        (
            row.get::<bool, _>("provider_connected"),
            "provider_disconnected",
            "The selected provider is not connected.",
        ),
        (
            row.get::<bool, _>("model_available"),
            "model_unavailable",
            "The selected model is unavailable.",
        ),
        (
            row.get::<bool, _>("compatible"),
            "harness_model_incompatible",
            "No available models for this harness",
        ),
    ];
    for (valid, code, message) in checks {
        if !valid {
            return Err(StorageError::Catalog(CatalogError::selection(
                code, message, &command,
            )));
        }
    }
    validate_provider_catalog_timestamp(row.get("provider_refreshed_at"), &command)
}

pub(super) async fn validate_provider_catalog_freshness_on(
    connection: &mut SqliteConnection,
    command: &ValidateModelSelectionCommand,
) -> Result<(), StorageError> {
    let refreshed_at: String =
        sqlx::query_scalar("SELECT refreshed_at FROM model_providers WHERE id=?1")
            .bind(command.provider_id.as_str())
            .fetch_optional(&mut *connection)
            .await?
            .ok_or_else(|| {
                StorageError::Catalog(CatalogError::selection(
                    "model_selection_unknown",
                    "The selected provider is unknown.",
                    command,
                ))
            })?;
    validate_provider_catalog_timestamp(&refreshed_at, command)
}

fn validate_provider_catalog_timestamp(
    refreshed_at: &str,
    command: &ValidateModelSelectionCommand,
) -> Result<(), StorageError> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time is before unix epoch")
        .as_millis();
    let fresh = refreshed_at
        .parse::<u128>()
        .ok()
        .is_some_and(|timestamp| now.saturating_sub(timestamp) <= MAX_PROVIDER_CATALOG_AGE_MS);
    if fresh {
        Ok(())
    } else {
        Err(StorageError::Catalog(CatalogError::selection(
            "provider_catalog_stale",
            "Refresh models before continuing.",
            command,
        )))
    }
}

async fn load_defaults(
    connection: &mut SqliteConnection,
) -> Result<ModelSettingsDefaults, StorageError> {
    let row = sqlx::query(
        "SELECT default_harness_configuration_name,default_provider_id FROM product_model_preferences WHERE singleton=1",
    )
    .fetch_one(connection)
    .await?;
    Ok(ModelSettingsDefaults {
        harness_id: row.try_get(0)?,
        provider_id: ProviderId::from_database(row.try_get(1)?),
    })
}

async fn load_harnesses(
    connection: &mut SqliteConnection,
) -> Result<Vec<ProductHarness>, StorageError> {
    let rows = sqlx::query(
        "SELECT configuration_name,label,available,unavailable_reason_code,unavailable_reason_message FROM product_harnesses WHERE product_visible=1 ORDER BY label,configuration_name",
    )
    .fetch_all(&mut *connection)
    .await?;
    let compatibility = sqlx::query(
        "SELECT harness_configuration_name,provider_id,all_models,preferred_model_id FROM harness_provider_compatibility ORDER BY provider_id",
    )
    .fetch_all(&mut *connection)
    .await?;
    let mut providers: HashMap<String, Vec<ProviderId>> = HashMap::new();
    let model_rows = sqlx::query(
        "SELECT harness_configuration_name,provider_id,model_id FROM harness_model_compatibility ORDER BY model_id",
    )
    .fetch_all(&mut *connection)
    .await?;
    let mut models: HashMap<(String, String), Vec<String>> = HashMap::new();
    for row in model_rows {
        models
            .entry((row.try_get(0)?, row.try_get(1)?))
            .or_default()
            .push(row.try_get(2)?);
    }
    let mut compatibility_by_harness: HashMap<String, Vec<HarnessModelCompatibility>> =
        HashMap::new();
    for row in compatibility {
        let harness_id: String = row.try_get(0)?;
        let provider_id: String = row.try_get(1)?;
        providers
            .entry(harness_id.clone())
            .or_default()
            .push(ProviderId::from_database(provider_id.clone()));
        let all_models: bool = row.try_get(2)?;
        let compatible_models = (!all_models).then(|| {
            models
                .remove(&(harness_id.clone(), provider_id.clone()))
                .unwrap_or_default()
        });
        compatibility_by_harness
            .entry(harness_id)
            .or_default()
            .push(HarnessModelCompatibility {
                provider_id: ProviderId::from_database(provider_id.clone()),
                model_ids: compatible_models,
                preferred_model_id: row.try_get(3)?,
            });
    }
    rows.iter()
        .map(|row| {
            let id: String = row.try_get(0)?;
            Ok(ProductHarness {
                compatible_provider_ids: providers.remove(&id).unwrap_or_default(),
                model_compatibility: compatibility_by_harness.remove(&id).unwrap_or_default(),
                id,
                label: row.try_get(1)?,
                available: row.try_get(2)?,
                unavailable_reason: reason_from_row(row, 3, 4)?,
            })
        })
        .collect()
}

async fn load_providers(connection: &mut SqliteConnection) -> Result<Vec<Provider>, StorageError> {
    let rows = sqlx::query(
        "SELECT id,label,connected,unavailable_reason_code,unavailable_reason_message FROM model_providers ORDER BY label,id",
    )
    .fetch_all(&mut *connection)
    .await?;
    let model_rows = sqlx::query(
        "SELECT provider_id,model_id,label,visible,available,unavailable_reason_code,unavailable_reason_message,provider_default,replacement_model_id FROM provider_models ORDER BY provider_id,provider_order,model_id",
    )
    .fetch_all(&mut *connection)
    .await?;
    let mut models: HashMap<String, Vec<ProviderModel>> = HashMap::new();
    for row in model_rows {
        models
            .entry(row.try_get(0)?)
            .or_default()
            .push(ProviderModel {
                id: row.try_get(1)?,
                label: row.try_get(2)?,
                visible: row.try_get(3)?,
                available: row.try_get(4)?,
                unavailable_reason: reason_from_row(&row, 5, 6)?,
                provider_default: row.try_get(7)?,
                replacement_model_id: row.try_get(8)?,
            });
    }
    rows.iter()
        .map(|row| {
            let id: String = row.try_get(0)?;
            Ok(Provider {
                models: models.remove(&id).unwrap_or_default(),
                id: ProviderId::from_database(id),
                label: row.try_get(1)?,
                connected: row.try_get(2)?,
                unavailable_reason: reason_from_row(row, 3, 4)?,
            })
        })
        .collect()
}

async fn load_families(
    connection: &mut SqliteConnection,
) -> Result<Vec<ModelFamily>, StorageError> {
    let ids = sqlx::query_scalar::<_, i64>("SELECT id FROM model_families ORDER BY position,id")
        .fetch_all(&mut *connection)
        .await?;
    let mut families = Vec::with_capacity(ids.len());
    for id in ids {
        families.push(
            load_family(&mut *connection, ModelFamilyId::from_database(id))
                .await?
                .ok_or(sqlx::Error::RowNotFound)?,
        );
    }
    Ok(families)
}

async fn load_family(
    connection: &mut SqliteConnection,
    id: ModelFamilyId,
) -> Result<Option<ModelFamily>, StorageError> {
    let Some(row) =
        sqlx::query("SELECT id,name,kind,enabled,position FROM model_families WHERE id=?1")
            .bind(id.value())
            .fetch_optional(&mut *connection)
            .await?
    else {
        return Ok(None);
    };
    let members = sqlx::query(
        "SELECT provider_id,model_id,position FROM model_family_members WHERE family_id=?1 ORDER BY position",
    )
    .bind(id.value())
    .fetch_all(&mut *connection)
    .await?
    .into_iter()
    .map(|member| {
        Ok(ModelFamilyMember {
            provider_id: ProviderId::from_database(member.try_get(0)?),
            model_id: member.try_get(1)?,
            position: member.try_get::<i64, _>(2)? as usize,
        })
    })
    .collect::<Result<Vec<_>, StorageError>>()?;
    Ok(Some(ModelFamily {
        id: ModelFamilyId::from_database(row.try_get(0)?),
        name: row.try_get(1)?,
        kind: ModelFamilyKind::from_database(row.try_get::<String, _>(2)?.as_str())
            .map_err(StorageError::Catalog)?,
        enabled: row.try_get(3)?,
        position: row.try_get::<i64, _>(4)? as usize,
        members,
    }))
}

async fn replace_system_family(
    connection: &mut SqliteConnection,
    snapshot: &ProviderCatalogSnapshot,
    system_family: &SystemFamilySnapshot,
) -> Result<(), StorageError> {
    let members = system_family
        .model_ids
        .iter()
        .enumerate()
        .map(|(position, model_id)| ModelFamilyMember {
            provider_id: snapshot.provider_id.clone(),
            model_id: model_id.clone(),
            position,
        })
        .collect::<Vec<_>>();
    validate_family(&system_family.name, &members).map_err(StorageError::Catalog)?;
    let key = format!("{}:{}", snapshot.provider_id.as_str(), system_family.key);
    let family_id =
        sqlx::query_scalar::<_, i64>("SELECT id FROM model_families WHERE system_key=?1")
            .bind(&key)
            .fetch_optional(&mut *connection)
            .await?;
    let id = match family_id {
        Some(id) => {
            sqlx::query("UPDATE model_families SET name=?1 WHERE id=?2")
                .bind(&system_family.name)
                .bind(id)
                .execute(&mut *connection)
                .await?;
            ModelFamilyId::from_database(id)
        }
        None => {
            let position: i64 =
                sqlx::query_scalar("SELECT COALESCE(MAX(position),-1)+1 FROM model_families")
                    .fetch_one(&mut *connection)
                    .await?;
            let result = sqlx::query(
                "INSERT INTO model_families(name,kind,system_key,enabled,position) VALUES (?1,'system',?2,1,?3)",
            )
            .bind(&system_family.name)
            .bind(key)
            .bind(position)
            .execute(&mut *connection)
            .await?;
            ModelFamilyId::from_database(result.last_insert_rowid())
        }
    };
    replace_family_members(connection, id, &members).await
}

async fn replace_family_members(
    connection: &mut SqliteConnection,
    family_id: ModelFamilyId,
    members: &[ModelFamilyMember],
) -> Result<(), StorageError> {
    sqlx::query("DELETE FROM model_family_members WHERE family_id=?1")
        .bind(family_id.value())
        .execute(&mut *connection)
        .await?;
    for (position, member) in members.iter().enumerate() {
        sqlx::query(
            "INSERT INTO model_family_members(family_id,position,provider_id,model_id) VALUES (?1,?2,?3,?4)",
        )
        .bind(family_id.value())
        .bind(position as i64)
        .bind(member.provider_id.as_str())
        .bind(&member.model_id)
        .execute(&mut *connection)
        .await?;
    }
    Ok(())
}

async fn compact_family_positions(connection: &mut SqliteConnection) -> Result<(), StorageError> {
    let ids = sqlx::query_scalar::<_, i64>("SELECT id FROM model_families ORDER BY position,id")
        .fetch_all(&mut *connection)
        .await?;
    sqlx::query("UPDATE model_families SET position=position+1000000")
        .execute(&mut *connection)
        .await?;
    for (position, id) in ids.into_iter().enumerate() {
        sqlx::query("UPDATE model_families SET position=?1 WHERE id=?2")
            .bind(position as i64)
            .bind(id)
            .execute(&mut *connection)
            .await?;
    }
    Ok(())
}

fn reason_from_row(
    row: &SqliteRow,
    code_index: usize,
    message_index: usize,
) -> Result<Option<UnavailableReason>, StorageError> {
    let code: Option<String> = row.try_get(code_index)?;
    let message: Option<String> = row.try_get(message_index)?;
    match (code, message) {
        (Some(code), Some(message)) => Ok(Some(UnavailableReason { code, message })),
        (None, None) => Ok(None),
        _ => Err(StorageError::IncompatibleSchema(
            "availability reason code and message must be stored together".into(),
        )),
    }
}

fn harness_label(name: &str) -> String {
    name.split('-')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut characters = part.chars();
            characters
                .next()
                .map(|first| first.to_uppercase().collect::<String>() + characters.as_str())
                .unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

pub(super) async fn validate_catalog_rows(pool: &SqlitePool) -> Result<(), StorageError> {
    let invalid_harness_subset: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM harness_provider_compatibility c WHERE (c.all_models=0 AND NOT EXISTS(SELECT 1 FROM harness_model_compatibility m WHERE m.harness_configuration_name=c.harness_configuration_name AND m.provider_id=c.provider_id)) OR (c.preferred_model_id IS NOT NULL AND c.all_models=0 AND NOT EXISTS(SELECT 1 FROM harness_model_compatibility m WHERE m.harness_configuration_name=c.harness_configuration_name AND m.provider_id=c.provider_id AND m.model_id=c.preferred_model_id)))",
    )
    .fetch_one(pool)
    .await?;
    if invalid_harness_subset {
        return Err(StorageError::IncompatibleSchema(
            "stored harness model compatibility is empty or excludes its preferred model".into(),
        ));
    }
    let too_large: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT family_id FROM model_family_members GROUP BY family_id HAVING COUNT(*) > 5)",
    )
    .fetch_one(pool)
    .await?;
    if too_large {
        return Err(StorageError::IncompatibleSchema(
            "stored model family contains more than five models".into(),
        ));
    }
    let positions: Vec<i64> =
        sqlx::query_scalar("SELECT position FROM model_families ORDER BY position")
            .fetch_all(pool)
            .await?;
    if positions
        .iter()
        .enumerate()
        .any(|(expected, actual)| *actual != expected as i64)
    {
        return Err(StorageError::IncompatibleSchema(
            "stored model family positions must be contiguous".into(),
        ));
    }
    let partial_model_identity: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM interactions WHERE NOT ((model_provider_id IS NULL AND provider_model_id IS NULL AND model_family_id IS NULL) OR (model_provider_id IS NOT NULL AND provider_model_id IS NOT NULL AND model_family_id IS NOT NULL AND model_family_id > 0)))",
    )
    .fetch_one(pool)
    .await?;
    if partial_model_identity {
        return Err(StorageError::IncompatibleSchema(
            "stored interaction model family, provider, and model ID must be present together"
                .into(),
        ));
    }
    Ok(())
}
