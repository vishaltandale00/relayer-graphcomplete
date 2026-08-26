use super::SqliteProductStore;
use crate::product::{
    CatalogError, CreateModelFamilyCommand, ExecutionHarnessPolicy, FamilyPolicyReference,
    HarnessModelCompatibility, HarnessModelRule, HarnessModelRules, ManagedFamilyPolicy,
    ModelFamily, ModelFamilyId, ModelFamilyKind, ModelFamilyMember, ModelSettings,
    ModelSettingsDefaults, ProductHarness, Provider, ProviderCatalogSnapshot, ProviderDefinition,
    ProviderId, ProviderModel, ReorderModelFamiliesCommand, RuntimeProductHarness,
    SystemFamilySnapshot, UnavailableReason, UpdateHarnessModelRulesCommand,
    UpdateModelFamilyCommand, UpdateModelSettingsDefaultsCommand, ValidateModelSelectionCommand,
    validate_family,
};
use crate::storage::StorageError;
use sha2::{Digest, Sha256};
use sqlx::{Row, SqliteConnection, SqlitePool, sqlite::SqliteRow};
use std::collections::HashMap;

impl SqliteProductStore {
    pub(crate) async fn update_harness_model_rules(
        &self,
        command: &UpdateHarnessModelRulesCommand,
    ) -> Result<u32, StorageError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let (current_revision, current_digest): (i64, String) = sqlx::query_as(
            "SELECT configuration_revision,configuration_digest FROM product_harnesses WHERE configuration_name=?1 AND product_visible=1",
        )
        .bind(&command.harness_id)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(|| {
            StorageError::Catalog(CatalogError::invalid(
                "harness_unknown",
                "Unknown product harness.",
            ))
        })?;
        if current_revision != i64::from(command.expected_revision) {
            return Err(StorageError::Catalog(CatalogError::invalid(
                "harness_revision_conflict",
                "This harness configuration changed. Refresh Settings before saving.",
            )));
        }
        sqlx::query("DELETE FROM harness_model_rules WHERE harness_configuration_name=?1")
            .bind(&command.harness_id)
            .execute(&mut *transaction)
            .await?;
        for (effect, rules) in [
            ("allow", &command.rules.allow),
            ("deny", &command.rules.deny),
        ] {
            for (position, rule) in rules.iter().enumerate() {
                let (kind, pattern) = match (&rule.model_id_exact, &rule.model_id_regex) {
                    (Some(exact), None) => ("exact", exact),
                    (None, Some(regex)) => ("regex", regex),
                    _ => unreachable!("model rules are validated before persistence"),
                };
                sqlx::query("INSERT INTO harness_model_rules(harness_configuration_name,effect,position,adapter_id,match_kind,model_pattern) VALUES (?1,?2,?3,?4,?5,?6)")
                    .bind(&command.harness_id)
                    .bind(effect)
                    .bind(position as i64)
                    .bind(&rule.adapter_id)
                    .bind(kind)
                    .bind(pattern)
                    .execute(&mut *transaction)
                    .await?;
            }
        }
        let next_revision = current_revision + 1;
        let mut digest = Sha256::new();
        digest.update(current_digest.as_bytes());
        digest.update([0]);
        digest.update(
            serde_json::to_vec(&command.rules)
                .map_err(|error| StorageError::Serialization(error.to_string()))?,
        );
        digest.update([0]);
        digest.update(next_revision.to_le_bytes());
        let next_digest = format!("sha256:{:x}", digest.finalize());
        sqlx::query("UPDATE product_harnesses SET configuration_revision=?1,configuration_digest=?2,model_rules_present=1,model_rules_modified=1 WHERE configuration_name=?3")
            .bind(next_revision)
            .bind(next_digest)
            .bind(&command.harness_id)
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        Ok(next_revision as u32)
    }

    pub(crate) async fn load_provider_definitions(
        &self,
    ) -> Result<Vec<ProviderDefinition>, StorageError> {
        sqlx::query("SELECT id,adapter_id,label,endpoint,access_contract,credential_reference,lifecycle_state,removed_at FROM model_providers ORDER BY label,id")
            .fetch_all(&self.pool).await?.into_iter().map(|row| Ok(ProviderDefinition {
                id: ProviderId::from_database(row.try_get(0)?), adapter_id: row.try_get(1)?,
                label: row.try_get(2)?, endpoint: row.try_get(3)?, access_contract: row.try_get(4)?,
                credential_reference: row.try_get(5)?, lifecycle_state: row.try_get(6)?, removed_at: row.try_get(7)?,
            })).collect()
    }

    pub(crate) async fn sync_provider_definitions(
        &self,
        definitions: &[ProviderDefinition],
    ) -> Result<(), StorageError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        for definition in definitions {
            validate_provider_lifecycle_shape(definition)?;
            let existing = sqlx::query("SELECT adapter_id,endpoint,access_contract,lifecycle_state FROM model_providers WHERE id=?1")
                .bind(definition.id.as_str()).fetch_optional(&mut *transaction).await?;
            if let Some(existing) = existing {
                let old_adapter: String = existing.try_get(0)?;
                let old_endpoint: Option<String> = existing.try_get(1)?;
                let old_access: String = existing.try_get(2)?;
                let old_state: String = existing.try_get(3)?;
                if old_adapter != "legacy"
                    && (old_adapter != definition.adapter_id
                        || old_endpoint != definition.endpoint
                        || old_access != definition.access_contract)
                {
                    return Err(StorageError::Catalog(CatalogError::invalid(
                        "provider_identity_immutable",
                        "Provider adapter, endpoint, and access contract cannot be changed.",
                    )));
                }
                let transition = old_state == definition.lifecycle_state
                    || (old_state == "active" && definition.lifecycle_state == "removal_pending")
                    || (old_state == "removal_pending"
                        && definition.lifecycle_state == "tombstoned");
                if !transition {
                    return Err(StorageError::Catalog(CatalogError::invalid(
                        "provider_lifecycle_invalid",
                        "Provider lifecycle transition is invalid.",
                    )));
                }
                if old_state == "active" && definition.lifecycle_state == "removal_pending" {
                    guard_provider_removal(&mut transaction, definition.id.as_str()).await?;
                }
                if old_state == "removal_pending" && definition.lifecycle_state == "tombstoned" {
                    let running: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM interaction_attempts WHERE provider_id=?1 AND outcome='running')")
                        .bind(definition.id.as_str()).fetch_one(&mut *transaction).await?;
                    if running {
                        return Err(StorageError::Catalog(CatalogError::invalid(
                            "provider_execution_drain_incomplete",
                            "Provider removal cannot finish while an execution attempt is running.",
                        )));
                    }
                }
                sqlx::query("UPDATE model_providers SET adapter_id=?1,label=?2,endpoint=?3,access_contract=?4,credential_reference=?5,lifecycle_state=?6,removed_at=?7 WHERE id=?8")
                    .bind(&definition.adapter_id).bind(&definition.label).bind(&definition.endpoint)
                    .bind(&definition.access_contract).bind(&definition.credential_reference)
                    .bind(&definition.lifecycle_state).bind(&definition.removed_at).bind(definition.id.as_str())
                    .execute(&mut *transaction).await?;
            } else {
                if definition.lifecycle_state != "active" {
                    return Err(StorageError::Catalog(CatalogError::invalid(
                        "provider_lifecycle_invalid",
                        "New provider definitions must be active.",
                    )));
                }
                sqlx::query("INSERT INTO model_providers(id,label,connected,unavailable_reason_code,unavailable_reason_message,refreshed_at,adapter_id,access_contract,endpoint,credential_reference,lifecycle_state,removed_at) VALUES (?1,?2,0,'provider_disconnected','The provider is not connected.','0',?3,?4,?5,?6,'active',NULL)")
                    .bind(definition.id.as_str()).bind(&definition.label).bind(&definition.adapter_id)
                    .bind(&definition.access_contract).bind(&definition.endpoint).bind(&definition.credential_reference)
                    .execute(&mut *transaction).await?;
            }
        }
        transaction.commit().await?;
        Ok(())
    }

    pub(crate) async fn create_provider_with_catalog(
        &self,
        definition: &ProviderDefinition,
        snapshot: &ProviderCatalogSnapshot,
        managed_policy: Option<&FamilyPolicyReference>,
        timestamp: &str,
    ) -> Result<(), StorageError> {
        validate_provider_lifecycle_shape(definition)?;
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        if sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM model_providers WHERE id=?1)")
            .bind(definition.id.as_str())
            .fetch_one(&mut *transaction)
            .await?
        {
            return Err(StorageError::Catalog(CatalogError::invalid(
                "provider_definition_exists",
                "Provider definition already exists.",
            )));
        }
        sqlx::query("INSERT INTO model_providers(id,label,connected,unavailable_reason_code,unavailable_reason_message,refreshed_at,adapter_id,access_contract,endpoint,credential_reference,lifecycle_state,removed_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'active',NULL)")
            .bind(definition.id.as_str()).bind(&definition.label).bind(snapshot.connected)
            .bind(snapshot.unavailable_reason.as_ref().map(|reason| &reason.code))
            .bind(snapshot.unavailable_reason.as_ref().map(|reason| &reason.message))
            .bind(timestamp).bind(&definition.adapter_id).bind(&definition.access_contract)
            .bind(&definition.endpoint).bind(&definition.credential_reference)
            .execute(&mut *transaction).await?;
        for model in &snapshot.models {
            sqlx::query("INSERT INTO provider_models(provider_id,model_id,label,provider_order,visible,available,unavailable_reason_code,unavailable_reason_message,provider_default,replacement_model_id,metadata_json) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)")
                .bind(definition.id.as_str()).bind(&model.id).bind(&model.label).bind(model.order as i64)
                .bind(model.visible).bind(model.available)
                .bind(model.unavailable_reason.as_ref().map(|reason| &reason.code))
                .bind(model.unavailable_reason.as_ref().map(|reason| &reason.message))
                .bind(model.provider_default).bind(&model.replacement_model_id)
                .bind(serde_json::to_string(&model.metadata).map_err(|error| StorageError::Serialization(error.to_string()))?)
                .execute(&mut *transaction).await?;
        }
        if let Some(system_family) = &snapshot.system_family
            && !system_family.model_ids.is_empty()
            && let Some(managed_policy) = managed_policy
        {
            replace_system_family(&mut transaction, snapshot, system_family, managed_policy)
                .await?;
        }
        transaction.commit().await?;
        Ok(())
    }

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
                configuration_digest: "sha256:unavailable".into(),
                model_compatibility: Vec::new(),
                configuration_revision: 1,
                model_rules: None,
                execution_access_contracts: Vec::new(),
                family_policy: None,
            });
        }
        harnesses.sort_by(|left, right| left.id.cmp(&right.id));
        harnesses.dedup_by(|left, right| left.id == right.id);
        for harness in harnesses {
            let runtime_present = runtime_harnesses.iter().any(|item| item.id == harness.id);
            let model_selecting =
                harness.model_rules.is_some() || !harness.model_compatibility.is_empty();
            let available = runtime_present
                && (!model_selecting || !harness.execution_access_contracts.is_empty());
            sqlx::query(
                "INSERT INTO product_harnesses(configuration_name,label,product_visible,available,unavailable_reason_code,unavailable_reason_message,configuration_revision,configuration_digest,model_rules_present,execution_access_contracts_json,family_policy_id,family_policy_version) VALUES (?1,?2,1,?3,?4,?5,?6,?7,?8,?9,?10,?11) ON CONFLICT(configuration_name) DO UPDATE SET label=excluded.label,product_visible=1,available=excluded.available,unavailable_reason_code=excluded.unavailable_reason_code,unavailable_reason_message=excluded.unavailable_reason_message,configuration_revision=CASE WHEN product_harnesses.model_rules_modified=1 THEN product_harnesses.configuration_revision ELSE excluded.configuration_revision END,configuration_digest=CASE WHEN product_harnesses.model_rules_modified=1 THEN product_harnesses.configuration_digest ELSE excluded.configuration_digest END,model_rules_present=CASE WHEN product_harnesses.model_rules_modified=1 THEN product_harnesses.model_rules_present ELSE excluded.model_rules_present END,execution_access_contracts_json=excluded.execution_access_contracts_json,family_policy_id=excluded.family_policy_id,family_policy_version=excluded.family_policy_version",
            )
            .bind(&harness.id)
            .bind(harness_label(&harness.id))
            .bind(available)
            .bind((!available).then_some(if runtime_present { "harness_access_contract_missing" } else { "harness_unavailable" }))
            .bind((!available).then_some(if runtime_present { "The model-selecting harness has no execution access contract." } else { "The harness runtime is unavailable." }))
            .bind(harness.configuration_revision)
            .bind(&harness.configuration_digest)
            .bind(harness.model_rules.is_some())
            .bind(serde_json::to_string(&harness.execution_access_contracts).map_err(|error| StorageError::Serialization(error.to_string()))?)
            .bind(harness.family_policy.as_ref().map(|policy| policy.id.as_str()))
            .bind(harness.family_policy.as_ref().map(|policy| policy.version))
            .execute(&mut *transaction)
            .await?;
            let model_rules_modified: bool = sqlx::query_scalar(
                "SELECT model_rules_modified FROM product_harnesses WHERE configuration_name=?1",
            )
            .bind(&harness.id)
            .fetch_one(&mut *transaction)
            .await?;
            if available && !model_rules_modified {
                sqlx::query("DELETE FROM harness_model_rules WHERE harness_configuration_name=?1")
                    .bind(&harness.id)
                    .execute(&mut *transaction)
                    .await?;
                if let Some(rules) = &harness.model_rules {
                    for (effect, rules) in [("allow", &rules.allow), ("deny", &rules.deny)] {
                        for (position, rule) in rules.iter().enumerate() {
                            let (kind, pattern) = match (&rule.model_id_exact, &rule.model_id_regex)
                            {
                                (Some(exact), None) => ("exact", exact),
                                (None, Some(regex)) => ("regex", regex),
                                _ => {
                                    return Err(StorageError::Catalog(CatalogError::invalid(
                                        "harness_model_rule_invalid",
                                        "Harness model rule requires exactly one matcher.",
                                    )));
                                }
                            };
                            sqlx::query("INSERT INTO harness_model_rules(harness_configuration_name,effect,position,adapter_id,match_kind,model_pattern) VALUES (?1,?2,?3,?4,?5,?6)")
                                .bind(&harness.id).bind(effect).bind(position as i64).bind(&rule.adapter_id).bind(kind).bind(pattern)
                                .execute(&mut *transaction).await?;
                        }
                    }
                }
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

    pub(crate) async fn load_execution_harness_policy(
        &self,
        harness_id: &str,
    ) -> Result<ExecutionHarnessPolicy, StorageError> {
        let mut transaction = self.pool.begin().await?;
        let (revision, digest, rules_present): (i64, String, bool) = sqlx::query_as(
            "SELECT configuration_revision,configuration_digest,model_rules_present FROM product_harnesses WHERE configuration_name=?1 AND product_visible=1 AND available=1",
        )
        .bind(harness_id)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(|| {
            StorageError::Catalog(CatalogError::invalid(
                "harness_unavailable",
                "The selected harness is not available.",
            ))
        })?;
        let mut rules = HarnessModelRules::default();
        if rules_present {
            let rows = sqlx::query(
                "SELECT effect,adapter_id,match_kind,model_pattern FROM harness_model_rules WHERE harness_configuration_name=?1 ORDER BY effect,position",
            )
            .bind(harness_id)
            .fetch_all(&mut *transaction)
            .await?;
            for row in rows {
                let effect: String = row.try_get(0)?;
                let match_kind: String = row.try_get(2)?;
                let pattern: String = row.try_get(3)?;
                let rule = HarnessModelRule {
                    adapter_id: row.try_get(1)?,
                    model_id_exact: (match_kind == "exact").then_some(pattern.clone()),
                    model_id_regex: (match_kind == "regex").then_some(pattern),
                };
                match effect.as_str() {
                    "allow" => rules.allow.push(rule),
                    "deny" => rules.deny.push(rule),
                    _ => {
                        return Err(StorageError::IncompatibleSchema(
                            "unknown harness model rule effect".into(),
                        ));
                    }
                }
            }
        }
        transaction.commit().await?;
        Ok(ExecutionHarnessPolicy {
            configuration_revision: revision as u32,
            configuration_digest: digest,
            model_rules: rules_present.then_some(rules),
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
            let connected = sqlx::query_scalar::<_, bool>(
                "SELECT connected AND lifecycle_state='active' FROM model_providers WHERE id=?1",
            )
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
        if let Some(family_id) = command.family_id {
            let harness_id = command.harness_id.clone().unwrap_or(
                sqlx::query_scalar("SELECT default_harness_configuration_name FROM product_model_preferences WHERE singleton=1")
                    .fetch_one(&mut *transaction)
                    .await?,
            );
            let candidates = sqlx::query_as::<_, (String, String)>(
                "SELECT provider_id,model_id FROM model_family_members WHERE family_id=?1 ORDER BY position",
            )
            .bind(family_id.value())
            .fetch_all(&mut *transaction)
            .await?;
            let mut resolvable = false;
            for (provider_id, model_id) in candidates {
                let validation = ValidateModelSelectionCommand {
                    harness_id: harness_id.clone(),
                    family_id,
                    provider_id: ProviderId::from_database(provider_id),
                    model_id,
                };
                if validate_model_selection_on(&mut transaction, &validation)
                    .await
                    .is_ok()
                {
                    resolvable = true;
                    break;
                }
            }
            if !resolvable {
                return Err(StorageError::Catalog(CatalogError::invalid(
                    "default_family_unresolvable",
                    "The default family must contain a model resolvable by the default harness.",
                )));
            }
        }
        sqlx::query(
            "UPDATE product_model_preferences SET default_harness_configuration_name=COALESCE(?1,default_harness_configuration_name),default_provider_id=COALESCE(?2,default_provider_id),default_family_id=COALESCE(?3,default_family_id),defaults_modified=1 WHERE singleton=1",
        )
        .bind(command.harness_id.as_deref())
        .bind(command.provider_id.as_ref().map(ProviderId::as_str))
        .bind(command.family_id.map(ModelFamilyId::value))
        .execute(&mut *transaction)
        .await?;
        let defaults = load_defaults(&mut transaction).await?;
        transaction.commit().await?;
        Ok(defaults)
    }

    pub(crate) async fn publish_provider_catalog(
        &self,
        snapshot: &ProviderCatalogSnapshot,
        managed_policy: Option<&FamilyPolicyReference>,
        timestamp: &str,
    ) -> Result<(), StorageError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let lifecycle = sqlx::query_scalar::<_, String>(
            "SELECT lifecycle_state FROM model_providers WHERE id=?1",
        )
        .bind(snapshot.provider_id.as_str())
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(|| {
            StorageError::Catalog(CatalogError::invalid(
                "provider_unknown",
                "Unknown provider definition.",
            ))
        })?;
        if lifecycle != "active" {
            return Err(StorageError::Catalog(CatalogError::invalid(
                "provider_not_active",
                "Only active provider definitions can publish model catalogs.",
            )));
        }
        sqlx::query(
            "UPDATE model_providers SET connected=?2,unavailable_reason_code=?3,unavailable_reason_message=?4,refreshed_at=?5 WHERE id=?1 AND lifecycle_state='active'",
        )
        .bind(snapshot.provider_id.as_str())
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
            && let Some(managed_policy) = managed_policy
        {
            replace_system_family(&mut transaction, snapshot, system_family, managed_policy)
                .await?;
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
            "INSERT INTO model_families(name,kind,system_key,enabled,position,revision,lifecycle_state) VALUES (?1,'custom',NULL,?2,?3,1,'active')",
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
            sqlx::query("UPDATE model_families SET name=?1,revision=revision+CASE WHEN enabled<>?2 OR ?4 THEN 1 ELSE 0 END,enabled=?2 WHERE id=?3 AND lifecycle_state='active'")
                .bind(name)
                .bind(command.enabled)
                .bind(command.id.value())
                .bind(command.members.is_some())
                .execute(&mut *transaction)
                .await?;
        } else {
            sqlx::query("UPDATE model_families SET revision=revision+CASE WHEN enabled<>?1 OR ?3 THEN 1 ELSE 0 END,enabled=?1 WHERE id=?2 AND lifecycle_state='active'")
                .bind(command.enabled)
                .bind(command.id.value())
                .bind(command.members.is_some())
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
        let deleted = sqlx::query("UPDATE model_families SET lifecycle_state='tombstoned',enabled=0,removed_at=CAST(strftime('%s','now') AS TEXT) WHERE id=?1 AND kind='custom' AND lifecycle_state='active' AND NOT EXISTS (SELECT 1 FROM product_model_preferences WHERE default_family_id=?1)")
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
        let expected = sqlx::query_scalar::<_, i64>(
            "SELECT id FROM model_families WHERE lifecycle_state='active'",
        )
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
        sqlx::query(
            "UPDATE model_families SET position=position+1000000 WHERE lifecycle_state='active'",
        )
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

    pub(crate) async fn provider_onboarding_model_compatible(
        &self,
        harness_id: &str,
        provider_id: &ProviderId,
        model_id: &str,
    ) -> Result<bool, StorageError> {
        let mut connection = self.pool.acquire().await?;
        match validate_onboarding_model_on(&mut connection, harness_id, provider_id, model_id).await
        {
            Ok(()) => Ok(true),
            Err(StorageError::Catalog(_)) => Ok(false),
            Err(error) => Err(error),
        }
    }

    pub(crate) async fn complete_provider_onboarding(
        &self,
        command: &crate::product::CompleteProviderOnboardingCommand,
    ) -> Result<(ModelSettingsDefaults, ModelFamily), StorageError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        validate_onboarding_model_on(
            &mut transaction,
            &command.harness_id,
            &command.provider_id,
            &command.model_id,
        )
        .await?;
        let existing: Option<i64> = sqlx::query_scalar(
            "SELECT f.id FROM product_model_preferences preferences JOIN model_families f ON f.id=preferences.default_family_id WHERE preferences.singleton=1 AND preferences.default_harness_configuration_name=?1 AND preferences.default_provider_id=?2 AND f.kind='custom' AND f.lifecycle_state='active' AND (SELECT COUNT(*) FROM model_family_members member WHERE member.family_id=f.id)=1 AND EXISTS(SELECT 1 FROM model_family_members member WHERE member.family_id=f.id AND member.provider_id=?2 AND member.model_id=?3)",
        )
        .bind(&command.harness_id)
        .bind(command.provider_id.as_str())
        .bind(&command.model_id)
        .fetch_optional(&mut *transaction)
        .await?;
        if let Some(family_id) = existing {
            let defaults = load_defaults(&mut transaction).await?;
            let family = load_family(&mut transaction, ModelFamilyId::from_database(family_id))
                .await?
                .ok_or(sqlx::Error::RowNotFound)?;
            transaction.commit().await?;
            return Ok((defaults, family));
        }
        let family_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM model_families")
            .fetch_one(&mut *transaction)
            .await?;
        let mut family_name = command.family_name.clone();
        for suffix in 2..=(family_count + 2) {
            let available = !sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM model_families WHERE lower(name)=lower(?1))",
            )
            .bind(&family_name)
            .fetch_one(&mut *transaction)
            .await?;
            if available {
                break;
            }
            family_name = format!("{} ({suffix})", command.family_name);
        }
        let position: i64 =
            sqlx::query_scalar("SELECT COALESCE(MAX(position),-1)+1 FROM model_families")
                .fetch_one(&mut *transaction)
                .await?;
        let result = sqlx::query(
            "INSERT INTO model_families(name,kind,system_key,enabled,position,revision,lifecycle_state) VALUES (?1,'custom',NULL,1,?2,1,'active')",
        )
        .bind(&family_name)
        .bind(position)
        .execute(&mut *transaction)
        .await?;
        let family_id = ModelFamilyId::from_database(result.last_insert_rowid());
        replace_family_members(
            &mut transaction,
            family_id,
            &[ModelFamilyMember {
                provider_id: command.provider_id.clone(),
                model_id: command.model_id.clone(),
                position: 0,
            }],
        )
        .await?;
        sqlx::query(
            "UPDATE product_model_preferences SET default_harness_configuration_name=?1,default_provider_id=?2,default_family_id=?3,defaults_modified=1 WHERE singleton=1",
        )
        .bind(&command.harness_id)
        .bind(command.provider_id.as_str())
        .bind(family_id.value())
        .execute(&mut *transaction)
        .await?;
        let defaults = load_defaults(&mut transaction).await?;
        let family = load_family(&mut transaction, family_id)
            .await?
            .ok_or(sqlx::Error::RowNotFound)?;
        transaction.commit().await?;
        Ok((defaults, family))
    }

    pub(crate) async fn validate_execution_model_selection(
        &self,
        harness_id: &str,
        selection: &crate::product::InteractionModelSelection,
    ) -> Result<crate::product::ExecutionModelSelection, StorageError> {
        let mut connection = self.pool.acquire().await?;
        validate_execution_model_selection_on(&mut connection, harness_id, selection).await
    }
}

async fn validate_onboarding_model_on(
    connection: &mut SqliteConnection,
    harness_id: &str,
    provider_id: &ProviderId,
    model_id: &str,
) -> Result<(), StorageError> {
    let command = ValidateModelSelectionCommand {
        harness_id: harness_id.to_owned(),
        family_id: ModelFamilyId::from_database(1),
        provider_id: provider_id.clone(),
        model_id: model_id.to_owned(),
    };
    let row = sqlx::query(
        "SELECT h.product_visible AS harness_visible,h.available AS harness_available,h.model_rules_present,h.execution_access_contracts_json,p.connected AS provider_connected,p.lifecycle_state='active' AS provider_active,p.adapter_id,p.access_contract,m.visible AS model_visible,m.available AS model_available,EXISTS(SELECT 1 FROM harness_provider_compatibility c WHERE c.harness_configuration_name=h.configuration_name AND c.provider_id=p.id AND (c.all_models=1 OR EXISTS(SELECT 1 FROM harness_model_compatibility cm WHERE cm.harness_configuration_name=c.harness_configuration_name AND cm.provider_id=c.provider_id AND cm.model_id=m.model_id))) AS compatible FROM product_harnesses h JOIN model_providers p ON p.id=?2 JOIN provider_models m ON m.provider_id=p.id AND m.model_id=?3 WHERE h.configuration_name=?1",
    )
    .bind(harness_id)
    .bind(provider_id.as_str())
    .bind(model_id)
    .fetch_optional(&mut *connection)
    .await?;
    let Some(row) = row else {
        return Err(StorageError::Catalog(CatalogError::selection(
            "onboarding_model_unknown",
            "The selected onboarding harness, provider, or model is unknown.",
            &command,
        )));
    };
    for (valid, code, message) in [
        (
            row.get::<bool, _>("harness_visible"),
            "harness_not_product_visible",
            "The selected harness is not product visible.",
        ),
        (
            row.get::<bool, _>("harness_available"),
            "harness_unavailable",
            "The selected harness is unavailable.",
        ),
        (
            row.get::<bool, _>("provider_connected"),
            "provider_disconnected",
            "The selected provider is disconnected.",
        ),
        (
            row.get::<bool, _>("provider_active"),
            "provider_removal_pending",
            "The selected provider is unavailable for new interactions.",
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
    ] {
        if !valid {
            return Err(StorageError::Catalog(CatalogError::selection(
                code, message, &command,
            )));
        }
    }
    validate_harness_route(connection, harness_id, model_id, &row, &command).await
}

pub(super) async fn validate_model_selection_on(
    connection: &mut SqliteConnection,
    command: &ValidateModelSelectionCommand,
) -> Result<(), StorageError> {
    let row = sqlx::query(
            "SELECT h.product_visible AS harness_visible,h.available AS harness_available,h.model_rules_present,h.execution_access_contracts_json,p.connected AS provider_connected,p.lifecycle_state='active' AS provider_active,p.adapter_id,p.access_contract,m.visible AS model_visible,m.available AS model_available,f.enabled AS family_enabled,EXISTS(SELECT 1 FROM harness_provider_compatibility c WHERE c.harness_configuration_name=h.configuration_name AND c.provider_id=p.id AND (c.all_models=1 OR EXISTS(SELECT 1 FROM harness_model_compatibility cm WHERE cm.harness_configuration_name=c.harness_configuration_name AND cm.provider_id=c.provider_id AND cm.model_id=m.model_id))) AS compatible,EXISTS(SELECT 1 FROM model_family_members fm WHERE fm.family_id=f.id AND fm.provider_id=p.id AND fm.model_id=m.model_id) AS member FROM product_harnesses h JOIN model_providers p ON p.id=?2 JOIN provider_models m ON m.provider_id=p.id AND m.model_id=?3 JOIN model_families f ON f.id=?4 WHERE h.configuration_name=?1",
        )
        .bind(&command.harness_id)
        .bind(command.provider_id.as_str())
        .bind(&command.model_id)
        .bind(command.family_id.value())
        .fetch_optional(&mut *connection)
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
            row.get::<bool, _>("provider_active"),
            "provider_removal_pending",
            "The selected provider is unavailable for new interactions.",
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
    validate_harness_route(
        connection,
        &command.harness_id,
        &command.model_id,
        &row,
        command,
    )
    .await?;
    Ok(())
}

pub(super) async fn validate_execution_model_selection_on(
    connection: &mut SqliteConnection,
    harness_id: &str,
    selection: &crate::product::InteractionModelSelection,
) -> Result<crate::product::ExecutionModelSelection, StorageError> {
    let command = ValidateModelSelectionCommand {
        harness_id: harness_id.to_owned(),
        family_id: selection.family_id,
        provider_id: selection.provider_id.clone(),
        model_id: selection.model_id.clone(),
    };
    let row = sqlx::query(
        "SELECT h.product_visible AS harness_visible,h.available AS harness_available,h.model_rules_present,h.execution_access_contracts_json,p.connected AS provider_connected,p.lifecycle_state='active' AS provider_active,p.adapter_id,p.access_contract,m.visible AS model_visible,m.available AS model_available,f.enabled AS family_enabled,f.lifecycle_state='active' AS family_active,EXISTS(SELECT 1 FROM model_family_members fm WHERE fm.family_id=f.id AND fm.provider_id=p.id AND fm.model_id=m.model_id) AS member,EXISTS(SELECT 1 FROM harness_provider_compatibility c WHERE c.harness_configuration_name=h.configuration_name AND c.provider_id=p.id AND (c.all_models=1 OR EXISTS(SELECT 1 FROM harness_model_compatibility cm WHERE cm.harness_configuration_name=c.harness_configuration_name AND cm.provider_id=c.provider_id AND cm.model_id=m.model_id))) AS compatible FROM product_harnesses h JOIN model_providers p ON p.id=?2 JOIN provider_models m ON m.provider_id=p.id AND m.model_id=?3 JOIN model_families f ON f.id=?4 WHERE h.configuration_name=?1",
    )
    .bind(harness_id)
    .bind(selection.provider_id.as_str())
    .bind(&selection.model_id)
    .bind(selection.family_id.value())
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
            row.get::<bool, _>("provider_active"),
            "provider_removal_pending",
            "The selected provider is unavailable for new interactions.",
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
            row.get::<bool, _>("family_active"),
            "model_family_removed",
            "The selected model family was removed.",
        ),
        (
            row.get::<bool, _>("family_enabled"),
            "model_family_disabled",
            "The selected model family is disabled.",
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
                code, message, &command,
            )));
        }
    }
    validate_harness_route(connection, harness_id, &selection.model_id, &row, &command).await?;
    Ok(crate::product::ExecutionModelSelection {
        family_id: selection.family_id,
        provider_id: selection.provider_id.clone(),
        adapter_id: row.get("adapter_id"),
        access_contract: row.get("access_contract"),
        model_id: selection.model_id.clone(),
    })
}

async fn validate_harness_route(
    connection: &mut SqliteConnection,
    harness_id: &str,
    model_id: &str,
    row: &SqliteRow,
    command: &ValidateModelSelectionCommand,
) -> Result<(), StorageError> {
    let adapter_id: String = row.get("adapter_id");
    let access_contract: String = row.get("access_contract");
    let accepted_json: String = row.get("execution_access_contracts_json");
    let accepted: Vec<String> = if accepted_json.trim().is_empty() {
        Vec::new()
    } else {
        serde_json::from_str(&accepted_json)
            .map_err(|error| StorageError::Serialization(error.to_string()))?
    };
    if !accepted.is_empty() && !accepted.contains(&access_contract) {
        return Err(StorageError::Catalog(CatalogError::selection(
            "harness_access_contract_incompatible",
            "The selected provider access contract is not supported by this harness.",
            command,
        )));
    }
    let compatible = if row.get::<bool, _>("model_rules_present") {
        let rules = sqlx::query("SELECT effect,adapter_id,match_kind,model_pattern FROM harness_model_rules WHERE harness_configuration_name=?1 ORDER BY effect,position")
            .bind(harness_id).fetch_all(connection).await?;
        let mut allow_count = 0;
        let mut allowed = false;
        for rule in rules {
            let effect: String = rule.try_get(0)?;
            if effect == "allow" {
                allow_count += 1;
            }
            if rule.get::<String, _>(1) != adapter_id {
                continue;
            }
            let kind: String = rule.try_get(2)?;
            let pattern: String = rule.try_get(3)?;
            let matches = match kind.as_str() {
                "exact" => pattern == model_id,
                "regex" => regex::Regex::new(&pattern)
                    .map_err(|error| {
                        StorageError::IncompatibleSchema(format!(
                            "invalid stored harness regex: {error}"
                        ))
                    })?
                    .is_match(model_id),
                _ => {
                    return Err(StorageError::IncompatibleSchema(
                        "unknown harness model matcher".into(),
                    ));
                }
            };
            if matches && effect == "deny" {
                return Err(StorageError::Catalog(CatalogError::selection(
                    "harness_model_incompatible",
                    "No available models for this harness",
                    command,
                )));
            }
            if matches && effect == "allow" {
                allowed = true;
            }
        }
        allow_count == 0 || allowed
    } else {
        row.get::<bool, _>("compatible")
    };
    if compatible {
        Ok(())
    } else {
        Err(StorageError::Catalog(CatalogError::selection(
            "harness_model_incompatible",
            "No available models for this harness",
            command,
        )))
    }
}

async fn load_defaults(
    connection: &mut SqliteConnection,
) -> Result<ModelSettingsDefaults, StorageError> {
    let row = sqlx::query(
        "SELECT default_harness_configuration_name,default_provider_id,default_family_id FROM product_model_preferences WHERE singleton=1",
    )
    .fetch_one(connection)
    .await?;
    Ok(ModelSettingsDefaults {
        harness_id: row.try_get(0)?,
        provider_id: ProviderId::from_database(row.try_get(1)?),
        family_id: row
            .try_get::<Option<i64>, _>(2)?
            .map(ModelFamilyId::from_database),
    })
}

async fn load_harnesses(
    connection: &mut SqliteConnection,
) -> Result<Vec<ProductHarness>, StorageError> {
    let rows = sqlx::query(
        "SELECT configuration_name,label,available,unavailable_reason_code,unavailable_reason_message,configuration_revision,model_rules_present,execution_access_contracts_json,family_policy_id,family_policy_version FROM product_harnesses WHERE product_visible=1 ORDER BY label,configuration_name",
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
    let rule_rows = sqlx::query("SELECT harness_configuration_name,effect,adapter_id,match_kind,model_pattern FROM harness_model_rules ORDER BY harness_configuration_name,effect,position")
        .fetch_all(&mut *connection).await?;
    let mut rules_by_harness: HashMap<String, HarnessModelRules> = HashMap::new();
    for row in rule_rows {
        let harness_id: String = row.try_get(0)?;
        let effect: String = row.try_get(1)?;
        let match_kind: String = row.try_get(3)?;
        let pattern: String = row.try_get(4)?;
        let rule = HarnessModelRule {
            adapter_id: row.try_get(2)?,
            model_id_exact: (match_kind == "exact").then_some(pattern.clone()),
            model_id_regex: (match_kind == "regex").then_some(pattern),
        };
        let rules = rules_by_harness.entry(harness_id).or_default();
        match effect.as_str() {
            "allow" => rules.allow.push(rule),
            "deny" => rules.deny.push(rule),
            _ => {
                return Err(StorageError::IncompatibleSchema(
                    "unknown harness model rule effect".into(),
                ));
            }
        }
    }
    rows.iter()
        .map(|row| {
            let id: String = row.try_get(0)?;
            Ok(ProductHarness {
                compatible_provider_ids: providers.remove(&id).unwrap_or_default(),
                model_compatibility: compatibility_by_harness.remove(&id).unwrap_or_default(),
                id: id.clone(),
                label: row.try_get(1)?,
                available: row.try_get(2)?,
                unavailable_reason: reason_from_row(row, 3, 4)?,
                configuration_revision: row.try_get::<i64, _>(5)? as u32,
                model_rules: row
                    .try_get::<bool, _>(6)?
                    .then(|| rules_by_harness.remove(&id).unwrap_or_default()),
                execution_access_contracts: serde_json::from_str(&row.try_get::<String, _>(7)?)
                    .map_err(|error| StorageError::Serialization(error.to_string()))?,
                family_policy: match (
                    row.try_get::<Option<String>, _>(8)?,
                    row.try_get::<Option<i64>, _>(9)?,
                ) {
                    (Some(id), Some(version)) => Some(FamilyPolicyReference {
                        id,
                        version: version as u32,
                    }),
                    (None, None) => None,
                    _ => {
                        return Err(StorageError::IncompatibleSchema(
                            "harness family policy is partially populated".into(),
                        ));
                    }
                },
            })
        })
        .collect()
}

async fn load_providers(connection: &mut SqliteConnection) -> Result<Vec<Provider>, StorageError> {
    let rows = sqlx::query(
        "SELECT id,label,connected,unavailable_reason_code,unavailable_reason_message FROM model_providers WHERE lifecycle_state='active' ORDER BY label,id",
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
    let ids = sqlx::query_scalar::<_, i64>(
        "SELECT id FROM model_families WHERE lifecycle_state='active' ORDER BY position,id",
    )
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
        sqlx::query("SELECT id,name,kind,enabled,position,revision,managed_provider_id,policy_id,policy_version FROM model_families WHERE id=?1")
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
        revision: row.try_get::<i64, _>(5)? as u32,
        managed_policy: match (
            row.try_get::<Option<String>, _>(6)?,
            row.try_get::<Option<String>, _>(7)?,
            row.try_get::<Option<i64>, _>(8)?,
        ) {
            (Some(provider_id), Some(policy_id), Some(policy_version)) => {
                Some(ManagedFamilyPolicy {
                    provider_id: ProviderId::from_database(provider_id),
                    policy_id,
                    policy_version: policy_version as u32,
                })
            }
            (None, None, None) => None,
            _ => {
                return Err(StorageError::IncompatibleSchema(
                    "managed family policy identity is partially populated".into(),
                ));
            }
        },
        enabled: row.try_get(3)?,
        position: row.try_get::<i64, _>(4)? as usize,
        members,
    }))
}

async fn replace_system_family(
    connection: &mut SqliteConnection,
    snapshot: &ProviderCatalogSnapshot,
    system_family: &SystemFamilySnapshot,
    policy: &FamilyPolicyReference,
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
    let key = format!(
        "{}:{}@{}",
        snapshot.provider_id.as_str(),
        policy.id,
        policy.version
    );
    let legacy_default: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM product_model_preferences pref JOIN model_families family ON family.id=pref.default_family_id WHERE pref.singleton=1 AND family.kind='system' AND family.managed_provider_id IS NULL AND family.lifecycle_state='active' AND EXISTS(SELECT 1 FROM model_family_members member WHERE member.family_id=family.id AND member.provider_id=?1))",
    )
    .bind(snapshot.provider_id.as_str())
    .fetch_one(&mut *connection)
    .await?;
    // Legacy system families predate the declarative policy identity. Retire any family owned
    // solely by this provider in the same transaction that creates the policy-owned successor.
    sqlx::query("UPDATE model_families SET name=name || ' (retired ' || id || ')',lifecycle_state='tombstoned',enabled=0,removed_at=CAST(strftime('%s','now') AS TEXT) WHERE kind='system' AND managed_provider_id IS NULL AND lifecycle_state='active' AND EXISTS(SELECT 1 FROM model_family_members member WHERE member.family_id=model_families.id AND member.provider_id=?1) AND NOT EXISTS(SELECT 1 FROM model_family_members member WHERE member.family_id=model_families.id AND member.provider_id!=?1)")
        .bind(snapshot.provider_id.as_str())
        .execute(&mut *connection)
        .await?;
    // Retire obsolete policy identities before inserting the replacement so the user-facing
    // name remains stable. This is inside the catalog transaction, so any later failure restores
    // the prior family and default unchanged.
    sqlx::query("UPDATE model_families SET name=name || ' (retired ' || id || ')',lifecycle_state='tombstoned',enabled=0,removed_at=CAST(strftime('%s','now') AS TEXT) WHERE managed_provider_id=?1 AND (policy_id!=?2 OR policy_version!=?3) AND lifecycle_state='active'")
        .bind(snapshot.provider_id.as_str())
        .bind(&policy.id)
        .bind(policy.version)
        .execute(&mut *connection)
        .await?;
    let family_id = sqlx::query_scalar::<_, i64>(
        "SELECT id FROM model_families WHERE managed_provider_id=?1 AND policy_id=?2 AND policy_version=?3",
    )
            .bind(snapshot.provider_id.as_str())
            .bind(&policy.id)
            .bind(policy.version)
            .fetch_optional(&mut *connection)
            .await?;
    let id = match family_id {
        Some(id) => {
            let existing = sqlx::query_as::<_, (String, String)>(
                "SELECT provider_id,model_id FROM model_family_members WHERE family_id=?1 ORDER BY position",
            )
            .bind(id)
            .fetch_all(&mut *connection)
            .await?;
            let changed = existing
                != members
                    .iter()
                    .map(|member| {
                        (
                            member.provider_id.as_str().to_owned(),
                            member.model_id.clone(),
                        )
                    })
                    .collect::<Vec<_>>();
            sqlx::query("UPDATE model_families SET name=?1,revision=revision+?2,system_key=?3,lifecycle_state='active',enabled=1,removed_at=NULL WHERE id=?4")
                .bind(&system_family.name)
                .bind(i64::from(changed))
                .bind(&key)
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
                "INSERT INTO model_families(name,kind,system_key,enabled,position,managed_provider_id,policy_id,policy_version) VALUES (?1,'system',?2,1,?3,?4,?5,?6)",
            )
            .bind(&system_family.name)
            .bind(key)
            .bind(position)
            .bind(snapshot.provider_id.as_str())
            .bind(&policy.id)
            .bind(policy.version)
            .execute(&mut *connection)
            .await?;
            ModelFamilyId::from_database(result.last_insert_rowid())
        }
    };
    replace_family_members(connection, id, &members).await?;
    // Move only an unset or managed default. A user-owned custom family is never replaced by
    // reconciliation. The entire catalog/family/default transition commits atomically.
    sqlx::query("UPDATE product_model_preferences SET default_family_id=CASE WHEN ?3 OR EXISTS(SELECT 1 FROM model_families current WHERE current.id=default_family_id AND current.kind='system' AND current.managed_provider_id IS NOT NULL) OR (default_family_id IS NULL AND (default_provider_id IS NULL OR default_provider_id=?2 OR NOT EXISTS(SELECT 1 FROM model_providers chosen WHERE chosen.id=default_provider_id AND chosen.lifecycle_state='active' AND chosen.connected=1))) THEN ?1 ELSE default_family_id END,default_provider_id=CASE WHEN ?3 OR EXISTS(SELECT 1 FROM model_families current WHERE current.id=default_family_id AND current.kind='system' AND current.managed_provider_id IS NOT NULL) OR (default_family_id IS NULL AND (default_provider_id IS NULL OR default_provider_id=?2 OR NOT EXISTS(SELECT 1 FROM model_providers chosen WHERE chosen.id=default_provider_id AND chosen.lifecycle_state='active' AND chosen.connected=1))) THEN ?2 ELSE default_provider_id END WHERE singleton=1")
        .bind(id.value())
        .bind(snapshot.provider_id.as_str())
        .bind(legacy_default)
        .execute(&mut *connection)
        .await?;
    Ok(())
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

async fn guard_provider_removal(
    connection: &mut SqliteConnection,
    provider_id: &str,
) -> Result<(), StorageError> {
    let is_default: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM product_model_preferences WHERE singleton=1 AND default_provider_id=?1)",
    ).bind(provider_id).fetch_one(&mut *connection).await?;
    if is_default {
        return Err(StorageError::Catalog(CatalogError::invalid(
            "default_provider_removal_blocked",
            "Change the default provider before removing it.",
        )));
    }
    let defaults: (String, Option<i64>) = sqlx::query_as(
        "SELECT default_harness_configuration_name,default_family_id FROM product_model_preferences WHERE singleton=1",
    )
    .fetch_one(&mut *connection)
    .await?;
    let mut preserves_default_family = defaults.1.is_none();
    if let Some(family_id) = defaults.1 {
        let remaining: Vec<(String, String)> = sqlx::query_as(
            "SELECT provider_id,model_id FROM model_family_members WHERE family_id=?1 AND provider_id!=?2 ORDER BY position",
        )
        .bind(family_id)
        .bind(provider_id)
        .fetch_all(&mut *connection)
        .await?;
        for (remaining_provider, model_id) in remaining {
            let command = ValidateModelSelectionCommand {
                harness_id: defaults.0.clone(),
                family_id: ModelFamilyId::from_database(family_id),
                provider_id: ProviderId::from_database(remaining_provider),
                model_id,
            };
            if validate_model_selection_on(connection, &command)
                .await
                .is_ok()
            {
                preserves_default_family = true;
                break;
            }
        }
    }
    if !preserves_default_family {
        return Err(StorageError::Catalog(CatalogError::invalid(
            "default_family_provider_removal_blocked",
            "Change the default model family before removing this provider.",
        )));
    }
    Ok(())
}

fn validate_provider_lifecycle_shape(definition: &ProviderDefinition) -> Result<(), StorageError> {
    let valid = match definition.lifecycle_state.as_str() {
        "active" | "removal_pending" => definition.removed_at.is_none(),
        "tombstoned" => {
            definition
                .removed_at
                .as_ref()
                .is_some_and(|value| !value.trim().is_empty())
                && definition.credential_reference.is_none()
        }
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(StorageError::Catalog(CatalogError::invalid(
            "provider_lifecycle_shape_invalid",
            "Provider lifecycle metadata is inconsistent.",
        )))
    }
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

#[cfg(test)]
mod provider_definition_tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn definition(id: &str) -> ProviderDefinition {
        ProviderDefinition {
            id: ProviderId::parse(id).unwrap(),
            adapter_id: "openai-api".into(),
            label: "Work OpenAI".into(),
            endpoint: Some("https://api.openai.com/v1".into()),
            access_contract: "secret@1".into(),
            credential_reference: Some(format!("provider:{id}")),
            lifecycle_state: "active".into(),
            removed_at: None,
        }
    }

    #[tokio::test]
    async fn sqlite_is_authoritative_for_provider_identity_and_removal_admission() {
        let path = std::env::temp_dir().join(format!(
            "relayer-provider-lifecycle-{}-{}.sqlite3",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let store = SqliteProductStore::open(&path).await.unwrap();
        let codex = store.load_provider_definitions().await.unwrap();
        assert!(codex.iter().any(|value| value.id.as_str() == "codex"
            && value.adapter_id == "codex-subscription"
            && value.access_contract == "managed-runtime@1"));

        let mut work = definition("work-openai");
        store
            .sync_provider_definitions(&[work.clone()])
            .await
            .unwrap();
        work.lifecycle_state = "removal_pending".into();
        store
            .sync_provider_definitions(&[work.clone()])
            .await
            .unwrap();
        assert_eq!(
            store
                .load_provider_definitions()
                .await
                .unwrap()
                .into_iter()
                .find(|value| value.id.as_str() == "work-openai")
                .unwrap()
                .lifecycle_state,
            "removal_pending"
        );

        let mut changed = work.clone();
        changed.endpoint = Some("https://proxy.example.test/v1".into());
        assert!(store.sync_provider_definitions(&[changed]).await.is_err());
        let mut default_codex = codex
            .into_iter()
            .find(|value| value.id.as_str() == "codex")
            .unwrap();
        default_codex.lifecycle_state = "removal_pending".into();
        assert!(
            store
                .sync_provider_definitions(&[default_codex])
                .await
                .is_err()
        );

        let mut staged = definition("atomic-provider");
        staged.label = "Atomic Provider".into();
        let snapshot = ProviderCatalogSnapshot {
            provider_id: staged.id.clone(),
            label: staged.label.clone(),
            connected: true,
            unavailable_reason: None,
            models: vec![crate::product::CatalogModelSnapshot {
                id: "model-one".into(),
                label: "Model One".into(),
                order: 0,
                visible: true,
                available: true,
                unavailable_reason: None,
                provider_default: false,
                replacement_model_id: None,
                metadata: serde_json::json!({}),
            }],
            system_family: None,
        };
        store
            .create_provider_with_catalog(&staged, &snapshot, None, "1")
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM provider_models WHERE provider_id='atomic-provider'",
            )
            .fetch_one(&store.pool)
            .await
            .unwrap(),
            1
        );
        staged.label = "Renamed Atomic Provider".into();
        store
            .sync_provider_definitions(&[staged.clone()])
            .await
            .unwrap();
        store
            .publish_provider_catalog(&snapshot, None, "2")
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT label FROM model_providers WHERE id='atomic-provider'",
            )
            .fetch_one(&store.pool)
            .await
            .unwrap(),
            "Renamed Atomic Provider"
        );
        let mut duplicate = definition("atomic-duplicate");
        duplicate.label = staged.label.clone();
        let mut duplicate_snapshot = snapshot.clone();
        duplicate_snapshot.provider_id = duplicate.id.clone();
        assert!(
            store
                .create_provider_with_catalog(&duplicate, &duplicate_snapshot, None, "2")
                .await
                .is_err()
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM model_providers WHERE id='atomic-duplicate'",
            )
            .fetch_one(&store.pool)
            .await
            .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn provider_removal_preserves_a_default_family_member_resolvable_by_default_harness() {
        let path = std::env::temp_dir().join(format!(
            "relayer-provider-default-guard-{}-{}.sqlite3",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let store = SqliteProductStore::open(&path).await.unwrap();
        let mut removed = definition("removed-provider");
        removed.label = "Removed Provider".into();
        let mut incompatible = definition("incompatible-provider");
        incompatible.label = "Incompatible Provider".into();
        store
            .sync_provider_definitions(&[removed.clone(), incompatible.clone()])
            .await
            .unwrap();
        for id in [removed.id.as_str(), incompatible.id.as_str()] {
            sqlx::query("UPDATE model_providers SET connected=1 WHERE id=?1")
                .bind(id)
                .execute(&store.pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO provider_models(provider_id,model_id,label,provider_order,visible,available,provider_default,metadata_json) VALUES (?1,'model-one','Model One',0,1,1,0,'{}')")
                .bind(id).execute(&store.pool).await.unwrap();
        }
        let family_id = sqlx::query("INSERT INTO model_families(name,kind,enabled,position,revision,lifecycle_state) VALUES ('Guarded','custom',1,1,1,'active')")
            .execute(&store.pool).await.unwrap().last_insert_rowid();
        for (position, id) in [removed.id.as_str(), incompatible.id.as_str()]
            .into_iter()
            .enumerate()
        {
            sqlx::query("INSERT INTO model_family_members(family_id,position,provider_id,model_id) VALUES (?1,?2,?3,'model-one')")
                .bind(family_id).bind(position as i64).bind(id).execute(&store.pool).await.unwrap();
        }
        sqlx::query("UPDATE product_model_preferences SET default_provider_id='codex',default_family_id=?1 WHERE singleton=1")
            .bind(family_id).execute(&store.pool).await.unwrap();

        removed.lifecycle_state = "removal_pending".into();
        let error = store
            .sync_provider_definitions(&[removed])
            .await
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("Change the default model family")
        );
    }

    #[tokio::test]
    async fn declarative_policy_retires_and_moves_a_legacy_system_default_atomically() {
        let path = std::env::temp_dir().join(format!(
            "relayer-legacy-managed-family-{}-{}.sqlite3",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let store = SqliteProductStore::open(&path).await.unwrap();
        sqlx::query("UPDATE model_providers SET connected=1 WHERE id='codex'")
            .execute(&store.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO provider_models(provider_id,model_id,label,provider_order,visible,available,provider_default,metadata_json) VALUES ('codex','legacy-default','Legacy Default',0,1,1,1,'{}')")
            .execute(&store.pool).await.unwrap();
        let legacy_id = sqlx::query("INSERT INTO model_families(name,kind,system_key,enabled,position) VALUES ('Legacy Codex','system','codex',1,0)")
            .execute(&store.pool).await.unwrap().last_insert_rowid();
        sqlx::query("INSERT INTO model_family_members(family_id,position,provider_id,model_id) VALUES (?1,0,'codex','legacy-default')")
            .bind(legacy_id).execute(&store.pool).await.unwrap();
        sqlx::query("UPDATE product_model_preferences SET default_provider_id='codex',default_family_id=?1 WHERE singleton=1")
            .bind(legacy_id).execute(&store.pool).await.unwrap();
        let snapshot = ProviderCatalogSnapshot {
            provider_id: ProviderId::parse("codex").unwrap(),
            label: "Codex".into(),
            connected: true,
            unavailable_reason: None,
            models: vec![crate::product::CatalogModelSnapshot {
                id: "legacy-default".into(),
                label: "Legacy Default".into(),
                order: 0,
                visible: true,
                available: true,
                unavailable_reason: None,
                provider_default: true,
                replacement_model_id: None,
                metadata: serde_json::json!({}),
            }],
            system_family: Some(SystemFamilySnapshot {
                key: "ignored".into(),
                name: "Codex defaults".into(),
                model_ids: vec!["legacy-default".into()],
            }),
        };
        store
            .publish_provider_catalog(
                &snapshot,
                Some(&FamilyPolicyReference {
                    id: "codex-default-family".into(),
                    version: 1,
                }),
                "2",
            )
            .await
            .unwrap();
        let (default_family, legacy_state): (i64, String) = sqlx::query_as(
            "SELECT pref.default_family_id,legacy.lifecycle_state FROM product_model_preferences pref JOIN model_families legacy ON legacy.id=?1 WHERE pref.singleton=1",
        )
        .bind(legacy_id)
        .fetch_one(&store.pool)
        .await
        .unwrap();
        assert_ne!(default_family, legacy_id);
        assert_eq!(legacy_state, "tombstoned");
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT policy_id FROM model_families WHERE id=?1")
                .bind(default_family)
                .fetch_one(&store.pool)
                .await
                .unwrap(),
            "codex-default-family"
        );
    }

    #[tokio::test]
    async fn user_edited_harness_rules_are_revision_guarded_and_survive_runtime_sync() {
        let path = std::env::temp_dir().join(format!(
            "relayer-harness-rules-{}-{}.sqlite3",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let store = SqliteProductStore::open(&path).await.unwrap();
        let shipped = RuntimeProductHarness {
            id: "codex-basic".into(),
            configuration_digest: "sha256:shipped-v1".into(),
            model_compatibility: Vec::new(),
            configuration_revision: 1,
            model_rules: Some(HarnessModelRules {
                allow: vec![HarnessModelRule {
                    adapter_id: "codex-subscription".into(),
                    model_id_exact: None,
                    model_id_regex: Some(".*".into()),
                }],
                deny: Vec::new(),
            }),
            execution_access_contracts: vec!["managed-runtime@1".into()],
            family_policy: None,
        };
        store
            .initialize_model_catalog("codex-basic", std::slice::from_ref(&shipped))
            .await
            .unwrap();
        let edited = HarnessModelRules {
            allow: vec![HarnessModelRule {
                adapter_id: "openai-api".into(),
                model_id_exact: Some("gpt-5.2".into()),
                model_id_regex: None,
            }],
            deny: vec![HarnessModelRule {
                adapter_id: "openai-api".into(),
                model_id_exact: None,
                model_id_regex: Some("-preview$".into()),
            }],
        };
        assert_eq!(
            store
                .update_harness_model_rules(&UpdateHarnessModelRulesCommand {
                    harness_id: "codex-basic".into(),
                    expected_revision: 1,
                    rules: edited.clone(),
                })
                .await
                .unwrap(),
            2
        );
        assert!(
            store
                .update_harness_model_rules(&UpdateHarnessModelRulesCommand {
                    harness_id: "codex-basic".into(),
                    expected_revision: 1,
                    rules: HarnessModelRules::default(),
                })
                .await
                .is_err()
        );

        store
            .initialize_model_catalog(
                "codex-basic",
                &[RuntimeProductHarness {
                    configuration_revision: 3,
                    configuration_digest: "sha256:shipped-v3".into(),
                    ..shipped
                }],
            )
            .await
            .unwrap();
        let harness = store
            .load_model_settings()
            .await
            .unwrap()
            .harnesses
            .into_iter()
            .find(|harness| harness.id == "codex-basic")
            .unwrap();
        assert_eq!(harness.configuration_revision, 2);
        assert_eq!(harness.model_rules, Some(edited));
    }
}
