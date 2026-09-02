use super::SqliteProductStore;
use crate::product::{
    CatalogError, CompleteProviderOnboardingCommand, CreateModelFamilyCommand,
    ExecutionHarnessPolicy, ExecutionModelPlan, ExecutionModelRoute, FamilyPolicyReference,
    HarnessModelCompatibility, HarnessModelRule, HarnessModelRules,
    HarnessRuntimeAvailabilityUpdate, ManagedFamilyPolicy, ModelFamily, ModelFamilyId,
    ModelFamilyKind, ModelFamilyMember, ModelSettings, ModelSettingsDefaults, ProductHarness,
    Provider, ProviderCatalogSnapshot, ProviderDefinition, ProviderId, ProviderModel,
    ProviderOnboardingCompletion, ProviderOnboardingFamily, ProviderOnboardingFamilyIntent,
    ProviderOnboardingHarness, ProviderOnboardingManagedFamily, ProviderOnboardingModel,
    ProviderOnboardingProjection, ProviderOnboardingProvider, ProviderOnboardingResolution,
    ProviderOnboardingStatus, ReorderModelFamiliesCommand, RuntimeProductHarness,
    SystemFamilySnapshot, UnavailableReason, UpdateHarnessModelRulesCommand,
    UpdateModelFamilyCommand, UpdateModelSettingsDefaultsCommand, ValidateModelSelectionCommand,
    validate_family,
};
use crate::storage::StorageError;
use sha2::{Digest, Sha256};
use sqlx::{Row, SqliteConnection, SqlitePool, sqlite::SqliteRow};
use std::collections::{HashMap, HashSet};

impl SqliteProductStore {
    pub(crate) async fn update_harness_runtime_availability(
        &self,
        updates: &[HarnessRuntimeAvailabilityUpdate],
    ) -> Result<(), StorageError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let mut seen = HashSet::new();
        for update in updates {
            if !seen.insert(&update.harness_id) || update.generation == 0 {
                return Err(StorageError::Catalog(CatalogError::invalid(
                    "harness_readiness_invalid",
                    "Harness readiness updates require unique harnesses and a positive generation.",
                )));
            }
            let reason = match (update.available, update.unavailable_reason.as_ref()) {
                (true, None) => None,
                (false, Some(reason))
                    if !reason.code.trim().is_empty() && !reason.message.trim().is_empty() =>
                {
                    Some(reason)
                }
                _ => {
                    return Err(StorageError::Catalog(CatalogError::invalid(
                        "harness_readiness_invalid",
                        "Harness readiness availability and unavailable reason do not agree.",
                    )));
                }
            };
            let result = sqlx::query(
                "UPDATE product_harnesses SET available=?1,unavailable_reason_code=?2,unavailable_reason_message=?3 WHERE configuration_name=?4 AND product_visible=1 AND runtime_configuration_digest=?5",
            )
            .bind(update.available)
            .bind(reason.map(|value| value.code.as_str()))
            .bind(reason.map(|value| value.message.as_str()))
            .bind(&update.harness_id)
            .bind(&update.configuration_digest)
            .execute(&mut *transaction)
            .await?;
            if result.rows_affected() != 1 {
                return Err(StorageError::Catalog(CatalogError::invalid(
                    "harness_readiness_stale",
                    "Harness readiness was measured for a stale runtime configuration.",
                )));
            }
        }
        transaction.commit().await?;
        Ok(())
    }

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
                    tombstone_managed_provider_families(&mut transaction, definition.id.as_str())
                        .await?;
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
            replace_system_family(
                &mut transaction,
                snapshot,
                system_family,
                managed_policy,
                false,
            )
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
        for harness in runtime_harnesses {
            if let Some(rules) = &harness.model_rules {
                crate::product::validate_harness_model_rules(rules)
                    .map_err(StorageError::Catalog)?;
            }
        }
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        sqlx::query(
            "UPDATE product_harnesses SET available=0,unavailable_reason_code='harness_unavailable',unavailable_reason_message='The harness runtime is unavailable.',runtime_configuration_digest='sha256:not-loaded'",
        )
        .execute(&mut *transaction)
        .await?;
        let runtime_configuration_ids = runtime_harnesses
            .iter()
            .map(|harness| harness.id.as_str())
            .collect::<HashSet<_>>();
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
                runtime_available: false,
                unavailable_reason: Some(UnavailableReason {
                    code: "harness_unavailable".into(),
                    message: "The harness runtime is unavailable.".into(),
                }),
            });
        }
        harnesses.sort_by(|left, right| left.id.cmp(&right.id));
        harnesses.dedup_by(|left, right| left.id == right.id);
        for harness in harnesses {
            let runtime_present = harness.runtime_available;
            let model_selecting =
                harness.model_rules.is_some() || !harness.model_compatibility.is_empty();
            let available = runtime_present
                && (!model_selecting || !harness.execution_access_contracts.is_empty());
            let existing_overlay: Option<(bool, String, i64)> = sqlx::query_as(
                "SELECT model_rules_modified,runtime_configuration_digest,configuration_revision FROM product_harnesses WHERE configuration_name=?1",
            )
            .bind(&harness.id)
            .fetch_optional(&mut *transaction)
            .await?;
            let (effective_revision, effective_digest) = match existing_overlay {
                Some((true, base_digest, current_revision))
                    if base_digest != harness.configuration_digest =>
                {
                    let rules = load_harness_rules(&mut transaction, &harness.id).await?;
                    let next_revision = current_revision + 1;
                    (
                        next_revision as u32,
                        overlay_digest(&harness.configuration_digest, &rules, next_revision)?,
                    )
                }
                Some((true, _, current_revision)) => {
                    let digest: String = sqlx::query_scalar(
                        "SELECT configuration_digest FROM product_harnesses WHERE configuration_name=?1",
                    )
                    .bind(&harness.id)
                    .fetch_one(&mut *transaction)
                    .await?;
                    (current_revision as u32, digest)
                }
                _ => (
                    harness.configuration_revision,
                    harness.configuration_digest.clone(),
                ),
            };
            sqlx::query(
                "INSERT INTO product_harnesses(configuration_name,label,product_visible,available,unavailable_reason_code,unavailable_reason_message,configuration_revision,configuration_digest,model_rules_present,execution_access_contracts_json,family_policy_id,family_policy_version,runtime_configuration_revision,runtime_configuration_digest) VALUES (?1,?2,1,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13) ON CONFLICT(configuration_name) DO UPDATE SET label=excluded.label,product_visible=1,available=excluded.available,unavailable_reason_code=excluded.unavailable_reason_code,unavailable_reason_message=excluded.unavailable_reason_message,configuration_revision=excluded.configuration_revision,configuration_digest=excluded.configuration_digest,model_rules_present=CASE WHEN product_harnesses.model_rules_modified=1 THEN product_harnesses.model_rules_present ELSE excluded.model_rules_present END,execution_access_contracts_json=excluded.execution_access_contracts_json,family_policy_id=excluded.family_policy_id,family_policy_version=excluded.family_policy_version,runtime_configuration_revision=excluded.runtime_configuration_revision,runtime_configuration_digest=excluded.runtime_configuration_digest",
            )
            .bind(&harness.id)
            .bind(harness_label(&harness.id))
            .bind(available)
            .bind((!available).then_some(if runtime_present { "harness_access_contract_missing" } else { harness.unavailable_reason.as_ref().map_or("harness_unavailable", |reason| reason.code.as_str()) }))
            .bind((!available).then_some(if runtime_present { "The model-selecting harness has no execution access contract." } else { harness.unavailable_reason.as_ref().map_or("The harness runtime is unavailable.", |reason| reason.message.as_str()) }))
            .bind(effective_revision)
            .bind(&effective_digest)
            .bind(harness.model_rules.is_some())
            .bind(serde_json::to_string(&harness.execution_access_contracts).map_err(|error| StorageError::Serialization(error.to_string()))?)
            .bind(harness.family_policy.as_ref().map(|policy| policy.id.as_str()))
            .bind(harness.family_policy.as_ref().map(|policy| policy.version))
            .bind(harness.configuration_revision)
            .bind(&harness.configuration_digest)
            .execute(&mut *transaction)
            .await?;
            let model_rules_modified: bool = sqlx::query_scalar(
                "SELECT model_rules_modified FROM product_harnesses WHERE configuration_name=?1",
            )
            .bind(&harness.id)
            .fetch_one(&mut *transaction)
            .await?;
            if runtime_configuration_ids.contains(harness.id.as_str()) && !model_rules_modified {
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
        retire_absent_product_harness(
            &mut transaction,
            runtime_harnesses,
            "codex-basic-high",
            "codex-basic",
        )
        .await?;
        retire_absent_product_harness(
            &mut transaction,
            runtime_harnesses,
            "prime-agent-deep",
            "prime-agent-basic",
        )
        .await?;
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
        let mut harnesses = load_harnesses(&mut transaction).await?;
        let mut providers = load_providers(&mut transaction).await?;
        let families = load_families(&mut transaction).await?;
        project_harness_usability_on(&mut transaction, &mut harnesses).await?;
        for provider in &mut providers {
            if !provider.connected
                || provider.unavailable_reason.as_ref().is_some_and(|reason| {
                    reason.code != "provider_no_available_execution_configurations"
                })
            {
                continue;
            }
            let access_contract: String =
                sqlx::query_scalar("SELECT access_contract FROM model_providers WHERE id=?1")
                    .bind(provider.id.as_str())
                    .fetch_one(&mut *transaction)
                    .await?;
            let mut has_route = false;
            'routes: for harness in harnesses.iter().filter(|harness| harness.available) {
                for model in provider
                    .models
                    .iter()
                    .filter(|model| model.visible && model.available)
                {
                    if harness_route_is_usable(
                        harness,
                        &provider.id,
                        &provider.adapter_id,
                        &access_contract,
                        &model.id,
                    )? {
                        has_route = true;
                        break 'routes;
                    }
                }
            }
            if !has_route {
                provider.unavailable_reason = Some(UnavailableReason {
                    code: "provider_no_available_execution_configurations".into(),
                    message: "This provider currently has no available execution configurations."
                        .into(),
                });
            } else if provider.unavailable_reason.as_ref().is_some_and(|reason| {
                reason.code == "provider_no_available_execution_configurations"
            }) {
                provider.unavailable_reason = None;
            }
        }
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
        let (revision, digest, rules_present, access_contracts_json):
            (i64, String, bool, String) = sqlx::query_as(
            "SELECT configuration_revision,configuration_digest,model_rules_present,execution_access_contracts_json FROM product_harnesses WHERE configuration_name=?1 AND product_visible=1 AND available=1",
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
            execution_access_contracts: serde_json::from_str(&access_contracts_json)
                .map_err(|error| StorageError::Serialization(error.to_string()))?,
        })
    }

    pub(crate) async fn resolve_execution_model_plan(
        &self,
        harness_id: &str,
        selection: &crate::product::InteractionModelSelection,
    ) -> Result<(ExecutionModelPlan, crate::product::ExecutionModelSelection), StorageError> {
        let mut transaction = self.pool.begin().await?;
        let resolved =
            resolve_execution_model_plan_on(&mut transaction, harness_id, selection).await?;
        transaction.commit().await?;
        Ok(resolved)
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
        let stored_defaults = load_defaults(&mut transaction).await?;
        if command.harness_id.is_some() || command.family_id.is_some() {
            let family_id = command.family_id.or(stored_defaults.family_id);
            let harness_id = command
                .harness_id
                .clone()
                .unwrap_or(stored_defaults.harness_id);
            let configuration_owned =
                harness_uses_configuration_model_on(&mut transaction, &harness_id).await?;
            if let Some(family_id) = family_id.filter(|_| !configuration_owned) {
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
            replace_system_family(
                &mut transaction,
                snapshot,
                system_family,
                managed_policy,
                true,
            )
            .await?;
        } else if managed_policy.is_some()
            && snapshot
                .unavailable_reason
                .as_ref()
                .is_some_and(|reason| reason.code == "provider_no_eligible_execution_models")
        {
            tombstone_managed_provider_families(&mut transaction, snapshot.provider_id.as_str())
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
        compact_family_positions(&mut transaction).await?;
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
        if !command.enabled {
            let is_default: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM product_model_preferences WHERE singleton=1 AND default_family_id=?1)",
            )
            .bind(command.id.value())
            .fetch_one(&mut *transaction)
            .await?;
            if is_default {
                return Err(StorageError::Catalog(CatalogError::invalid(
                    "default_family_disable_blocked",
                    "Change the default model family before disabling it.",
                )));
            }
        }
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
        rewrite_family_positions(&mut transaction, &command.family_ids).await?;
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
    ) -> Result<crate::product::ExecutionModelSelection, StorageError> {
        let mut connection = self.pool.acquire().await?;
        validate_execution_model_selection_on(&mut connection, harness_id, selection).await
    }

    pub(crate) async fn provider_onboarding_projection(
        &self,
        provider_id: &ProviderId,
        app_default_harness_id: &str,
        permission_available_harnesses: &HashSet<String>,
    ) -> Result<ProviderOnboardingProjection, StorageError> {
        let mut transaction = self.pool.begin().await?;
        let projection = provider_onboarding_projection_on(
            &mut transaction,
            provider_id,
            app_default_harness_id,
            permission_available_harnesses,
        )
        .await?;
        transaction.commit().await?;
        Ok(projection)
    }

    pub(crate) async fn complete_provider_onboarding(
        &self,
        command: &CompleteProviderOnboardingCommand,
        app_default_harness_id: &str,
        permission_available_harnesses: &HashSet<String>,
    ) -> Result<ProviderOnboardingCompletion, StorageError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let projection = provider_onboarding_projection_on(
            &mut transaction,
            &command.provider_id,
            app_default_harness_id,
            permission_available_harnesses,
        )
        .await?;
        if projection.projection_revision != command.expected_projection_revision {
            return Err(StorageError::Catalog(CatalogError::invalid(
                "onboarding_projection_conflict",
                "Provider, harness, or model-family settings changed. Review the current choices before finishing setup.",
            )));
        }
        let harness = projection
            .harnesses
            .iter()
            .find(|harness| harness.id == command.harness_id)
            .filter(|harness| harness.selectable)
            .ok_or_else(|| {
                StorageError::Catalog(CatalogError::invalid(
                    "onboarding_harness_incompatible",
                    "The selected harness is not currently compatible with this provider.",
                ))
            })?;
        let family_id = match &command.family {
            ProviderOnboardingFamilyIntent::Existing { family_id } => harness
                .existing_custom_families
                .iter()
                .chain(&harness.existing_managed_families)
                .find(|family| family.id == *family_id)
                .map(|family| family.id)
                .ok_or_else(|| {
                    StorageError::Catalog(CatalogError::invalid(
                        "onboarding_family_incompatible",
                        "The selected family is no longer resolvable by this harness and provider.",
                    ))
                })?,
            ProviderOnboardingFamilyIntent::Managed {
                policy_id,
                policy_version,
            } => {
                let candidate = harness
                    .managed_family_candidate
                    .as_ref()
                    .filter(|candidate| {
                        candidate.policy_id == *policy_id
                            && candidate.policy_version == *policy_version
                    })
                    .ok_or_else(|| {
                        StorageError::Catalog(CatalogError::invalid(
                            "onboarding_managed_family_changed",
                            "The managed family preview changed. Review it before finishing setup.",
                        ))
                    })?;
                let mut snapshot =
                    provider_catalog_snapshot_on(&mut transaction, &command.provider_id).await?;
                snapshot.system_family = Some(SystemFamilySnapshot {
                    key: format!("{}@{}", candidate.policy_id, candidate.policy_version),
                    name: candidate.name.clone(),
                    model_ids: candidate
                        .members
                        .iter()
                        .map(|member| member.model_id.clone())
                        .collect(),
                });
                replace_system_family(
                    &mut transaction,
                    &snapshot,
                    snapshot
                        .system_family
                        .as_ref()
                        .expect("managed onboarding candidate supplies a family"),
                    &FamilyPolicyReference {
                        id: policy_id.clone(),
                        version: *policy_version,
                    },
                    false,
                )
                .await?
            }
            ProviderOnboardingFamilyIntent::Create { name, members } => {
                let normalized_name = validate_family(name, members)?;
                let eligible = harness
                    .eligible_models
                    .iter()
                    .map(|model| (model.provider_id.as_str(), model.model_id.as_str()))
                    .collect::<HashSet<_>>();
                if members.iter().any(|member| {
                    member.provider_id != command.provider_id
                        || !eligible
                            .contains(&(member.provider_id.as_str(), member.model_id.as_str()))
                }) {
                    return Err(StorageError::Catalog(CatalogError::invalid(
                        "onboarding_family_member_incompatible",
                        "Every new-family member must be an explicitly selected eligible model from this provider.",
                    )));
                }
                let duplicate: bool = sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM model_families WHERE lifecycle_state='active' AND lower(name)=lower(?1))",
                )
                .bind(&normalized_name)
                .fetch_one(&mut *transaction)
                .await?;
                if duplicate {
                    return Err(StorageError::Catalog(CatalogError::invalid(
                        "model_family_name_duplicate",
                        "A model family with this name already exists.",
                    )));
                }
                let position: i64 =
                    sqlx::query_scalar("SELECT COALESCE(MAX(position),-1)+1 FROM model_families")
                        .fetch_one(&mut *transaction)
                        .await?;
                let id = ModelFamilyId::from_database(
                    sqlx::query("INSERT INTO model_families(name,kind,system_key,enabled,position,revision,lifecycle_state) VALUES (?1,'custom',NULL,1,?2,1,'active')")
                        .bind(normalized_name)
                        .bind(position)
                        .execute(&mut *transaction)
                        .await?
                        .last_insert_rowid(),
                );
                replace_family_members(&mut transaction, id, members).await?;
                id
            }
        };
        let resolution = onboarding_resolution_on(
            &mut transaction,
            &command.harness_id,
            &command.provider_id,
            family_id,
        )
        .await?;
        sqlx::query("UPDATE product_model_preferences SET default_harness_configuration_name=?1,default_provider_id=?2,default_family_id=?3,defaults_modified=1 WHERE singleton=1")
            .bind(&command.harness_id)
            .bind(command.provider_id.as_str())
            .bind(family_id.value())
            .execute(&mut *transaction)
            .await?;
        let defaults = load_defaults(&mut transaction).await?;
        transaction.commit().await?;
        Ok(ProviderOnboardingCompletion {
            defaults,
            resolution,
        })
    }

    pub(crate) async fn provider_onboarding_status(
        &self,
        permission_available_harnesses: &HashSet<String>,
    ) -> Result<ProviderOnboardingStatus, StorageError> {
        let mut transaction = self.pool.begin().await?;
        let defaults = load_defaults(&mut transaction).await?;
        let blocking = |code: &str, message: &str| ProviderOnboardingStatus {
            complete: false,
            defaults: defaults.clone(),
            resolution: None,
            blocking_reason: Some(UnavailableReason {
                code: code.into(),
                message: message.into(),
            }),
        };
        if !permission_available_harnesses.contains(&defaults.harness_id) {
            transaction.commit().await?;
            return Ok(blocking(
                "onboarding_harness_permission_unavailable",
                "The saved harness has no enabled permission profile.",
            ));
        }
        let provider_ready: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM model_providers WHERE id=?1 AND connected=1 AND lifecycle_state='active')",
        )
        .bind(defaults.provider_id.as_str())
        .fetch_one(&mut *transaction)
        .await?;
        if !provider_ready {
            transaction.commit().await?;
            return Ok(blocking(
                "onboarding_provider_unavailable",
                "The saved default provider is not connected.",
            ));
        }
        let Some(family_id) = defaults.family_id else {
            transaction.commit().await?;
            return Ok(blocking(
                "onboarding_family_required",
                "Choose a default model family to finish setup.",
            ));
        };
        match onboarding_resolution_on(
            &mut transaction,
            &defaults.harness_id,
            &defaults.provider_id,
            family_id,
        )
        .await
        {
            Ok(resolution) => {
                transaction.commit().await?;
                Ok(ProviderOnboardingStatus {
                    complete: true,
                    defaults,
                    resolution: Some(resolution),
                    blocking_reason: None,
                })
            }
            Err(StorageError::Catalog(_)) => {
                transaction.commit().await?;
                Ok(blocking(
                    "onboarding_defaults_unresolvable",
                    "The saved provider, harness, and family defaults do not currently resolve.",
                ))
            }
            Err(error) => Err(error),
        }
    }
}

async fn project_harness_usability_on(
    connection: &mut SqliteConnection,
    harnesses: &mut [ProductHarness],
) -> Result<(), StorageError> {
    let routes = sqlx::query(
        "SELECT f.id,p.id,p.adapter_id,p.access_contract,m.model_id FROM model_families f JOIN model_family_members fm ON fm.family_id=f.id JOIN model_providers p ON p.id=fm.provider_id JOIN provider_models m ON m.provider_id=p.id AND m.model_id=fm.model_id WHERE f.lifecycle_state='active' AND f.enabled=1 AND p.lifecycle_state='active' AND p.connected=1 AND m.visible=1 AND m.available=1 ORDER BY f.position,f.id,fm.position",
    )
    .fetch_all(&mut *connection)
    .await?;
    for harness in harnesses {
        let mut provider_ids = Vec::new();
        let mut family_ids = Vec::new();
        if harness.available {
            for route in &routes {
                let family_id = ModelFamilyId::from_database(route.try_get(0)?);
                let provider_id = ProviderId::from_database(route.try_get(1)?);
                let adapter_id: String = route.try_get(2)?;
                let access_contract: String = route.try_get(3)?;
                let model_id: String = route.try_get(4)?;
                if !harness_route_is_usable(
                    harness,
                    &provider_id,
                    &adapter_id,
                    &access_contract,
                    &model_id,
                )? {
                    continue;
                }
                if !provider_ids.contains(&provider_id) {
                    provider_ids.push(provider_id);
                }
                if !family_ids.contains(&family_id) {
                    family_ids.push(family_id);
                }
            }
        }
        harness.usable_now = !family_ids.is_empty();
        harness.usable_provider_ids = provider_ids;
        harness.usable_family_ids = family_ids;
    }
    Ok(())
}

fn harness_route_is_usable(
    harness: &ProductHarness,
    provider_id: &ProviderId,
    adapter_id: &str,
    access_contract: &str,
    model_id: &str,
) -> Result<bool, StorageError> {
    if !harness.execution_access_contracts.is_empty()
        && !harness
            .execution_access_contracts
            .iter()
            .any(|accepted| accepted == access_contract)
    {
        return Ok(false);
    }
    let Some(rules) = &harness.model_rules else {
        return Ok(harness.model_compatibility.iter().any(|compatibility| {
            compatibility.provider_id == *provider_id
                && compatibility
                    .model_ids
                    .as_ref()
                    .is_none_or(|models| models.iter().any(|candidate| candidate == model_id))
        }));
    };
    let rule_matches = |rule: &HarnessModelRule| -> Result<bool, StorageError> {
        if rule.adapter_id != adapter_id {
            return Ok(false);
        }
        match (&rule.model_id_exact, &rule.model_id_regex) {
            (Some(exact), None) => Ok(exact == model_id),
            (None, Some(pattern)) => regex::Regex::new(pattern)
                .map(|regex| regex.is_match(model_id))
                .map_err(|error| {
                    StorageError::IncompatibleSchema(format!(
                        "invalid stored harness regex: {error}"
                    ))
                }),
            _ => Err(StorageError::IncompatibleSchema(
                "unknown harness model matcher".into(),
            )),
        }
    };
    for rule in &rules.deny {
        if rule_matches(rule)? {
            return Ok(false);
        }
    }
    if rules.allow.is_empty() {
        return Ok(true);
    }
    for rule in &rules.allow {
        if rule_matches(rule)? {
            return Ok(true);
        }
    }
    Ok(false)
}

async fn provider_onboarding_projection_on(
    connection: &mut SqliteConnection,
    provider_id: &ProviderId,
    app_default_harness_id: &str,
    permission_available_harnesses: &HashSet<String>,
) -> Result<ProviderOnboardingProjection, StorageError> {
    let snapshot = provider_catalog_snapshot_on(connection, provider_id).await?;
    if !snapshot.connected {
        return Err(StorageError::Catalog(CatalogError::invalid(
            "onboarding_provider_disconnected",
            "The provider must be connected before onboarding can continue.",
        )));
    }
    let (adapter_id, access_contract): (String, String) = sqlx::query_as(
        "SELECT adapter_id,access_contract FROM model_providers WHERE id=?1 AND lifecycle_state='active'",
    )
    .bind(provider_id.as_str())
    .fetch_optional(&mut *connection)
    .await?
    .ok_or_else(|| {
        StorageError::Catalog(CatalogError::invalid(
            "onboarding_provider_unavailable",
            "The provider is not available for onboarding.",
        ))
    })?;
    let provider = ProviderOnboardingProvider {
        id: provider_id.clone(),
        label: snapshot.label.clone(),
        adapter_id: adapter_id.clone(),
        access_contract: access_contract.clone(),
    };
    let families = load_families(connection).await?;
    let product_harnesses = load_harnesses(connection).await?;
    let mut harnesses = Vec::with_capacity(product_harnesses.len() + 1);
    for harness in product_harnesses {
        if !harness.available {
            continue;
        }
        let matching_access_contract = harness
            .execution_access_contracts
            .contains(&access_contract)
            .then_some(access_contract.clone());
        let mut eligible_models = Vec::new();
        for model in &snapshot.models {
            if validate_onboarding_model_on(connection, &harness.id, provider_id, &model.id)
                .await
                .is_ok()
            {
                eligible_models.push(ProviderOnboardingModel {
                    provider_id: provider_id.clone(),
                    model_id: model.id.clone(),
                    label: model.label.clone(),
                });
            }
        }
        let mut existing_custom_families = Vec::new();
        let mut existing_managed_families = Vec::new();
        for family in &families {
            let mut exact_provider_member_resolves = false;
            for member in family
                .members
                .iter()
                .filter(|member| member.provider_id == *provider_id)
            {
                let validation = ValidateModelSelectionCommand {
                    harness_id: harness.id.clone(),
                    family_id: family.id,
                    provider_id: member.provider_id.clone(),
                    model_id: member.model_id.clone(),
                };
                if validate_model_selection_on(connection, &validation)
                    .await
                    .is_ok()
                {
                    exact_provider_member_resolves = true;
                    break;
                }
            }
            if exact_provider_member_resolves {
                let choice = ProviderOnboardingFamily {
                    id: family.id,
                    name: family.name.clone(),
                    revision: family.revision,
                    members: family.members.clone(),
                };
                match family.kind {
                    ModelFamilyKind::Custom => existing_custom_families.push(choice),
                    ModelFamilyKind::System => existing_managed_families.push(choice),
                }
            }
        }
        let managed_family_policy = harness
            .family_policy
            .as_ref()
            .filter(|policy| crate::product::applies_to_adapter(policy, &adapter_id))
            .cloned()
            .or_else(|| crate::product::fallback_for_adapter(&adapter_id));
        let managed_family_candidate = managed_family_policy
            .as_ref()
            .and_then(|policy| {
                crate::product::derive_managed_family_members(policy, &snapshot)
                    .ok()
                    .filter(|members| !members.is_empty())
                    .map(|members| ProviderOnboardingManagedFamily {
                        provider_id: provider_id.clone(),
                        policy_id: policy.id.clone(),
                        policy_version: policy.version,
                        name: format!("{} defaults", snapshot.label),
                        members,
                    })
            })
            .filter(|candidate| {
                candidate.members.iter().any(|member| {
                    eligible_models.iter().any(|model| {
                        model.provider_id == member.provider_id && model.model_id == member.model_id
                    })
                })
            });
        let incompatibility_reason = if !permission_available_harnesses.contains(&harness.id) {
            Some(UnavailableReason {
                code: "harness_permission_unavailable".into(),
                message: "The harness has no enabled permission profile.".into(),
            })
        } else if matching_access_contract.is_none() {
            Some(UnavailableReason {
                code: "harness_access_contract_incompatible".into(),
                message: "The harness does not support this provider access mode.".into(),
            })
        } else if eligible_models.is_empty() {
            Some(UnavailableReason {
                code: "harness_model_incompatible".into(),
                message: "The harness has no eligible models from this provider.".into(),
            })
        } else {
            None
        };
        let selectable = incompatibility_reason.is_none();
        harnesses.push(ProviderOnboardingHarness {
            id: harness.id,
            label: harness.label,
            configuration_revision: harness.configuration_revision,
            selectable,
            selected_initially: false,
            matching_access_contract,
            incompatibility_reason,
            existing_custom_families,
            existing_managed_families,
            managed_family_candidate,
            eligible_models,
        });
    }
    let app_default_index = harnesses
        .iter()
        .position(|harness| harness.id == app_default_harness_id);
    let initial_harness_id = app_default_index
        .filter(|index| harnesses[*index].selectable)
        .map(|_| app_default_harness_id.to_owned());
    if let Some(index) = app_default_index {
        harnesses[index].selected_initially = initial_harness_id.is_some();
    }
    let app_default_reason = app_default_index
        .and_then(|index| harnesses[index].incompatibility_reason.clone())
        .or_else(|| {
            Some(UnavailableReason {
                code: "provider_no_available_execution_configurations".into(),
                message: "This provider currently has no available execution configurations."
                    .into(),
            })
        });
    harnesses.sort_by(|left, right| {
        (left.id != app_default_harness_id, &left.label, &left.id).cmp(&(
            right.id != app_default_harness_id,
            &right.label,
            &right.id,
        ))
    });
    let blocking_reason = if snapshot
        .unavailable_reason
        .as_ref()
        .is_some_and(|reason| reason.code == "provider_no_eligible_execution_models")
    {
        snapshot.unavailable_reason.clone()
    } else if !harnesses.iter().any(|harness| harness.selectable) {
        Some(UnavailableReason {
            code: "provider_no_available_execution_configurations".into(),
            message: "This provider currently has no available execution configurations.".into(),
        })
    } else {
        None
    };
    let mut projection = ProviderOnboardingProjection {
        provider,
        app_default_harness_id: app_default_harness_id.into(),
        initial_harness_id,
        app_default_reason,
        harnesses,
        projection_revision: String::new(),
        blocking_reason,
    };
    let mut digest = Sha256::new();
    digest.update(b"relayer.provider-onboarding-projection.v1\0");
    digest.update(
        serde_json::to_vec(&projection)
            .map_err(|error| StorageError::Serialization(error.to_string()))?,
    );
    projection.projection_revision = format!("sha256:{:x}", digest.finalize());
    Ok(projection)
}

async fn provider_catalog_snapshot_on(
    connection: &mut SqliteConnection,
    provider_id: &ProviderId,
) -> Result<ProviderCatalogSnapshot, StorageError> {
    let (label, connected, unavailable_code, unavailable_message): (
        String,
        bool,
        Option<String>,
        Option<String>,
    ) = sqlx::query_as(
        "SELECT label,connected,unavailable_reason_code,unavailable_reason_message FROM model_providers WHERE id=?1 AND lifecycle_state='active'",
    )
    .bind(provider_id.as_str())
    .fetch_optional(&mut *connection)
    .await?
    .ok_or_else(|| {
        StorageError::Catalog(CatalogError::invalid(
            "provider_unknown",
            "Unknown active provider definition.",
        ))
    })?;
    let rows = sqlx::query("SELECT model_id,label,provider_order,visible,available,unavailable_reason_code,unavailable_reason_message,provider_default,replacement_model_id,metadata_json FROM provider_models WHERE provider_id=?1 ORDER BY provider_order,model_id")
        .bind(provider_id.as_str()).fetch_all(&mut *connection).await?;
    let mut models = Vec::with_capacity(rows.len());
    for row in rows {
        models.push(crate::product::CatalogModelSnapshot {
            id: row.try_get(0)?,
            label: row.try_get(1)?,
            order: row.try_get::<i64, _>(2)? as usize,
            visible: row.try_get(3)?,
            available: row.try_get(4)?,
            unavailable_reason: reason_from_row(&row, 5, 6)?,
            provider_default: row.try_get(7)?,
            replacement_model_id: row.try_get(8)?,
            metadata: serde_json::from_str(&row.try_get::<String, _>(9)?)
                .map_err(|error| StorageError::Serialization(error.to_string()))?,
        });
    }
    Ok(ProviderCatalogSnapshot {
        provider_id: provider_id.clone(),
        label,
        connected,
        unavailable_reason: match (unavailable_code, unavailable_message) {
            (Some(code), Some(message)) => Some(UnavailableReason { code, message }),
            (None, None) => None,
            _ => {
                return Err(StorageError::IncompatibleSchema(
                    "provider unavailable reason is partially populated".into(),
                ));
            }
        },
        models,
        system_family: None,
    })
}

async fn validate_onboarding_model_on(
    connection: &mut SqliteConnection,
    harness_id: &str,
    provider_id: &ProviderId,
    model_id: &str,
) -> Result<(), StorageError> {
    let command = ValidateModelSelectionCommand {
        harness_id: harness_id.into(),
        family_id: ModelFamilyId::from_database(1),
        provider_id: provider_id.clone(),
        model_id: model_id.into(),
    };
    let row = sqlx::query("SELECT h.product_visible AS harness_visible,h.available AS harness_available,h.model_rules_present,h.execution_access_contracts_json,p.connected AS provider_connected,p.lifecycle_state='active' AS provider_active,p.adapter_id,p.access_contract,m.visible AS model_visible,m.available AS model_available,EXISTS(SELECT 1 FROM harness_provider_compatibility c WHERE c.harness_configuration_name=h.configuration_name AND c.provider_id=p.id AND (c.all_models=1 OR EXISTS(SELECT 1 FROM harness_model_compatibility cm WHERE cm.harness_configuration_name=c.harness_configuration_name AND cm.provider_id=c.provider_id AND cm.model_id=m.model_id))) AS compatible FROM product_harnesses h JOIN model_providers p ON p.id=?2 JOIN provider_models m ON m.provider_id=p.id AND m.model_id=?3 WHERE h.configuration_name=?1")
        .bind(harness_id).bind(provider_id.as_str()).bind(model_id).fetch_optional(&mut *connection).await?;
    let Some(row) = row else {
        return Err(StorageError::Catalog(CatalogError::invalid(
            "onboarding_model_unknown",
            "The provider model or harness is unknown.",
        )));
    };
    for (valid, code, message) in [
        (
            row.get::<bool, _>("harness_visible"),
            "harness_not_product_visible",
            "The harness is not product-visible.",
        ),
        (
            row.get::<bool, _>("harness_available"),
            "harness_unavailable",
            "The harness is unavailable.",
        ),
        (
            row.get::<bool, _>("provider_connected"),
            "provider_disconnected",
            "The provider is disconnected.",
        ),
        (
            row.get::<bool, _>("provider_active"),
            "provider_removal_pending",
            "The provider is unavailable for new interactions.",
        ),
        (
            row.get::<bool, _>("model_visible"),
            "model_hidden",
            "The model is hidden.",
        ),
        (
            row.get::<bool, _>("model_available"),
            "model_unavailable",
            "The model is unavailable.",
        ),
    ] {
        if !valid {
            return Err(StorageError::Catalog(CatalogError::invalid(code, message)));
        }
    }
    validate_harness_route(connection, harness_id, model_id, &row, &command).await
}

async fn onboarding_resolution_on(
    connection: &mut SqliteConnection,
    harness_id: &str,
    onboarding_provider_id: &ProviderId,
    family_id: ModelFamilyId,
) -> Result<ProviderOnboardingResolution, StorageError> {
    let family_revision: i64 = sqlx::query_scalar(
        "SELECT revision FROM model_families WHERE id=?1 AND enabled=1 AND lifecycle_state='active'",
    )
    .bind(family_id.value())
    .fetch_optional(&mut *connection)
    .await?
    .ok_or_else(|| {
        StorageError::Catalog(CatalogError::invalid(
            "onboarding_family_unavailable",
            "The selected family is unavailable.",
        ))
    })?;
    let members: Vec<(String, String, i64)> = sqlx::query_as(
        "SELECT provider_id,model_id,position FROM model_family_members WHERE family_id=?1 ORDER BY position",
    )
    .bind(family_id.value())
    .fetch_all(&mut *connection)
    .await?;
    let mut resolvable_members = Vec::new();
    let mut onboarding_provider_resolves = false;
    for (provider_id, model_id, position) in members {
        let provider_id = ProviderId::from_database(provider_id);
        let validation = ValidateModelSelectionCommand {
            harness_id: harness_id.into(),
            family_id,
            provider_id: provider_id.clone(),
            model_id: model_id.clone(),
        };
        if validate_model_selection_on(connection, &validation)
            .await
            .is_ok()
        {
            onboarding_provider_resolves |= provider_id == *onboarding_provider_id;
            resolvable_members.push(ModelFamilyMember {
                provider_id,
                model_id,
                position: position as usize,
            });
        }
    }
    if resolvable_members.is_empty() || !onboarding_provider_resolves {
        return Err(StorageError::Catalog(CatalogError::invalid(
            "onboarding_family_unresolvable",
            "The family must contain a currently resolvable model from the connected provider.",
        )));
    }
    Ok(ProviderOnboardingResolution {
        family_id,
        family_revision: family_revision as u32,
        resolvable_members,
    })
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

pub(super) async fn resolve_execution_model_plan_on(
    connection: &mut SqliteConnection,
    harness_id: &str,
    selection: &crate::product::InteractionModelSelection,
) -> Result<(ExecutionModelPlan, crate::product::ExecutionModelSelection), StorageError> {
    let orchestrator =
        validate_execution_model_selection_on(connection, harness_id, selection).await?;
    let family_revision: i64 = sqlx::query_scalar(
        "SELECT revision FROM model_families WHERE id=?1 AND enabled=1 AND lifecycle_state='active'",
    )
    .bind(selection.family_id.value())
    .fetch_optional(&mut *connection)
    .await?
    .ok_or_else(|| {
        StorageError::Catalog(CatalogError::selection(
            "model_family_unresolvable",
            "The selected model family is unavailable for execution.",
            &ValidateModelSelectionCommand {
                harness_id: harness_id.to_owned(),
                family_id: selection.family_id,
                provider_id: selection.provider_id.clone(),
                model_id: selection.model_id.clone(),
            },
        ))
    })?;
    let members: Vec<(String, String)> = sqlx::query_as(
        "SELECT provider_id,model_id FROM model_family_members WHERE family_id=?1 ORDER BY position",
    )
    .bind(selection.family_id.value())
    .fetch_all(&mut *connection)
    .await?;
    let mut roster = Vec::with_capacity(members.len());
    for (provider_id, model_id) in members {
        let member = crate::product::InteractionModelSelection {
            family_id: selection.family_id,
            provider_id: ProviderId::from_database(provider_id),
            model_id,
        };
        match validate_execution_model_selection_on(connection, harness_id, &member).await {
            Ok(route) => roster.push(ExecutionModelRoute {
                provider_id: route.provider_id,
                adapter_id: route.adapter_id,
                access_contract: route.access_contract,
                model_id: route.model_id,
            }),
            Err(StorageError::Catalog(_)) => {}
            Err(error) => return Err(error),
        }
    }
    let orchestrator_route = ExecutionModelRoute {
        provider_id: orchestrator.provider_id.clone(),
        adapter_id: orchestrator.adapter_id.clone(),
        access_contract: orchestrator.access_contract.clone(),
        model_id: orchestrator.model_id.clone(),
    };
    if roster.is_empty() || !roster.contains(&orchestrator_route) {
        return Err(StorageError::Catalog(CatalogError::selection(
            "orchestrator_not_in_resolved_family",
            "The selected orchestrator is not in the executable family roster.",
            &ValidateModelSelectionCommand {
                harness_id: harness_id.to_owned(),
                family_id: selection.family_id,
                provider_id: selection.provider_id.clone(),
                model_id: selection.model_id.clone(),
            },
        )));
    }
    Ok((
        ExecutionModelPlan {
            family_id: selection.family_id,
            family_revision,
            orchestrator: orchestrator_route,
            roster,
        },
        orchestrator,
    ))
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

async fn load_harness_rules(
    connection: &mut SqliteConnection,
    harness_id: &str,
) -> Result<HarnessModelRules, StorageError> {
    let rows = sqlx::query(
        "SELECT effect,adapter_id,match_kind,model_pattern FROM harness_model_rules WHERE harness_configuration_name=?1 ORDER BY effect,position",
    )
    .bind(harness_id)
    .fetch_all(&mut *connection)
    .await?;
    let mut rules = HarnessModelRules::default();
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
    Ok(rules)
}

async fn harness_uses_configuration_model_on(
    connection: &mut SqliteConnection,
    harness_id: &str,
) -> Result<bool, StorageError> {
    Ok(sqlx::query_scalar::<_, bool>(
        "SELECT available AND model_rules_present=0 AND NOT EXISTS(SELECT 1 FROM harness_provider_compatibility WHERE harness_configuration_name=product_harnesses.configuration_name) AND NOT EXISTS(SELECT 1 FROM harness_model_compatibility WHERE harness_configuration_name=product_harnesses.configuration_name) FROM product_harnesses WHERE configuration_name=?1 AND product_visible=1",
    )
    .bind(harness_id)
    .fetch_optional(connection)
    .await?
    .unwrap_or(false))
}

fn overlay_digest(
    base_digest: &str,
    rules: &HarnessModelRules,
    revision: i64,
) -> Result<String, StorageError> {
    let mut digest = Sha256::new();
    digest.update(base_digest.as_bytes());
    digest.update([0]);
    digest.update(
        serde_json::to_vec(rules)
            .map_err(|error| StorageError::Serialization(error.to_string()))?,
    );
    digest.update([0]);
    digest.update(revision.to_le_bytes());
    Ok(format!("sha256:{:x}", digest.finalize()))
}

async fn load_defaults(
    connection: &mut SqliteConnection,
) -> Result<ModelSettingsDefaults, StorageError> {
    let row = sqlx::query(
        "SELECT default_harness_configuration_name,default_provider_id,default_family_id,defaults_modified FROM product_model_preferences WHERE singleton=1",
    )
    .fetch_one(connection)
    .await?;
    Ok(ModelSettingsDefaults {
        harness_id: row.try_get(0)?,
        provider_id: ProviderId::from_database(row.try_get(1)?),
        family_id: row
            .try_get::<Option<i64>, _>(2)?
            .map(ModelFamilyId::from_database),
        modified: row.try_get(3)?,
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
                usable_now: false,
                usable_provider_ids: Vec::new(),
                usable_family_ids: Vec::new(),
            })
        })
        .collect()
}

async fn load_providers(connection: &mut SqliteConnection) -> Result<Vec<Provider>, StorageError> {
    let rows = sqlx::query(
        "SELECT id,adapter_id,label,connected,unavailable_reason_code,unavailable_reason_message FROM model_providers WHERE lifecycle_state='active' ORDER BY label,id",
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
                adapter_id: row.try_get(1)?,
                label: row.try_get(2)?,
                connected: row.try_get(3)?,
                unavailable_reason: reason_from_row(row, 4, 5)?,
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
    reconcile_managed_default: bool,
) -> Result<ModelFamilyId, StorageError> {
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
    sqlx::query("UPDATE model_families SET lifecycle_state='tombstoned',enabled=0,removed_at=CAST(strftime('%s','now') AS TEXT) WHERE kind='system' AND managed_provider_id IS NULL AND lifecycle_state='active' AND EXISTS(SELECT 1 FROM model_family_members member WHERE member.family_id=model_families.id AND member.provider_id=?1) AND NOT EXISTS(SELECT 1 FROM model_family_members member WHERE member.family_id=model_families.id AND member.provider_id!=?1)")
        .bind(snapshot.provider_id.as_str())
        .execute(&mut *connection)
        .await?;
    // Retire obsolete policy identities before inserting the replacement so the user-facing
    // name remains stable. This is inside the catalog transaction, so any later failure restores
    // the prior family and default unchanged.
    sqlx::query("UPDATE model_families SET lifecycle_state='tombstoned',enabled=0,removed_at=CAST(strftime('%s','now') AS TEXT) WHERE managed_provider_id=?1 AND (policy_id!=?2 OR policy_version!=?3) AND lifecycle_state='active'")
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
    let family_name = collision_free_managed_family_name(
        connection,
        &system_family.name,
        family_id.map(ModelFamilyId::from_database),
    )
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
            sqlx::query("UPDATE model_families SET name=?1,revision=revision+?2,system_key=?3,enabled=1,lifecycle_state='active',removed_at=NULL WHERE id=?4")
                .bind(&family_name)
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
            .bind(&family_name)
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
    compact_family_positions(connection).await?;
    // Move only an unset or managed default. A user-owned custom family is never replaced by
    // reconciliation. The entire catalog/family/default transition commits atomically.
    if reconcile_managed_default {
        sqlx::query("UPDATE product_model_preferences SET default_family_id=CASE WHEN ?3 OR EXISTS(SELECT 1 FROM model_families current WHERE current.id=default_family_id AND current.kind='system' AND current.managed_provider_id=?2) OR (default_family_id IS NULL AND (default_provider_id IS NULL OR default_provider_id=?2 OR NOT EXISTS(SELECT 1 FROM model_providers chosen WHERE chosen.id=default_provider_id AND chosen.lifecycle_state='active' AND chosen.connected=1))) THEN ?1 ELSE default_family_id END,default_provider_id=CASE WHEN ?3 OR EXISTS(SELECT 1 FROM model_families current WHERE current.id=default_family_id AND current.kind='system' AND current.managed_provider_id=?2) OR (default_family_id IS NULL AND (default_provider_id IS NULL OR default_provider_id=?2 OR NOT EXISTS(SELECT 1 FROM model_providers chosen WHERE chosen.id=default_provider_id AND chosen.lifecycle_state='active' AND chosen.connected=1))) THEN ?2 ELSE default_provider_id END WHERE singleton=1")
            .bind(id.value())
            .bind(snapshot.provider_id.as_str())
            .bind(legacy_default)
            .execute(&mut *connection)
            .await?;
    }
    Ok(id)
}

async fn collision_free_managed_family_name(
    connection: &mut SqliteConnection,
    preferred: &str,
    except_id: Option<ModelFamilyId>,
) -> Result<String, StorageError> {
    let mut ordinal = 1usize;
    loop {
        let candidate = if ordinal == 1 {
            preferred.to_owned()
        } else {
            let suffix = format!(" ({ordinal})");
            let stem = preferred
                .chars()
                .take(80usize.saturating_sub(suffix.chars().count()))
                .collect::<String>();
            format!("{}{suffix}", stem.trim_end())
        };
        let duplicate: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM model_families WHERE lifecycle_state='active' AND name=?1 COLLATE NOCASE AND (?2 IS NULL OR id!=?2))",
        )
        .bind(&candidate)
        .bind(except_id.map(ModelFamilyId::value))
        .fetch_one(&mut *connection)
        .await?;
        if !duplicate {
            return Ok(candidate);
        }
        ordinal = ordinal.checked_add(1).ok_or_else(|| {
            StorageError::Catalog(CatalogError::invalid(
                "model_family_name_exhausted",
                "No unique managed model-family name is available.",
            ))
        })?;
    }
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
    let ids = sqlx::query_scalar::<_, i64>(
        "SELECT id FROM model_families WHERE lifecycle_state='active' ORDER BY position,id",
    )
    .fetch_all(&mut *connection)
    .await?;
    let ids = ids
        .into_iter()
        .map(ModelFamilyId::from_database)
        .collect::<Vec<_>>();
    rewrite_family_positions(connection, &ids).await
}

async fn rewrite_family_positions(
    connection: &mut SqliteConnection,
    active_ids: &[ModelFamilyId],
) -> Result<(), StorageError> {
    let tombstone_ids = sqlx::query_scalar::<_, i64>(
        "SELECT id FROM model_families WHERE lifecycle_state='tombstoned' ORDER BY position,id",
    )
    .fetch_all(&mut *connection)
    .await?;
    let offset: i64 =
        sqlx::query_scalar("SELECT COALESCE(MAX(position),-1)+COUNT(*)+1 FROM model_families")
            .fetch_one(&mut *connection)
            .await?;
    sqlx::query("UPDATE model_families SET position=position+?1")
        .bind(offset)
        .execute(&mut *connection)
        .await?;
    for (position, id) in active_ids.iter().enumerate() {
        sqlx::query("UPDATE model_families SET position=?1 WHERE id=?2")
            .bind(position as i64)
            .bind(id.value())
            .execute(&mut *connection)
            .await?;
    }
    for (index, id) in tombstone_ids.into_iter().enumerate() {
        sqlx::query("UPDATE model_families SET position=?1 WHERE id=?2")
            .bind((active_ids.len() + index) as i64)
            .bind(id)
            .execute(&mut *connection)
            .await?;
    }
    Ok(())
}

async fn tombstone_managed_provider_families(
    connection: &mut SqliteConnection,
    provider_id: &str,
) -> Result<(), StorageError> {
    sqlx::query("UPDATE model_families SET lifecycle_state='tombstoned',enabled=0,removed_at=CAST(strftime('%s','now') AS TEXT) WHERE managed_provider_id=?1 AND lifecycle_state='active'")
        .bind(provider_id)
        .execute(&mut *connection)
        .await?;
    compact_family_positions(connection).await
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

/// Move product selections off a configuration this runtime no longer offers and onto
/// its replacement. A catalog that still carries the retired configuration keeps every
/// existing selection, and a catalog missing the replacement changes nothing rather than
/// stranding rows on a name that is also absent.
async fn retire_absent_product_harness(
    connection: &mut SqliteConnection,
    runtime_harnesses: &[RuntimeProductHarness],
    retired: &str,
    replacement: &str,
) -> Result<(), StorageError> {
    let has_replacement = runtime_harnesses
        .iter()
        .any(|harness| harness.id == replacement);
    let has_retired = runtime_harnesses
        .iter()
        .any(|harness| harness.id == retired);
    if !has_replacement || has_retired {
        return Ok(());
    }

    sqlx::query(
        "UPDATE threads SET harness_configuration_name=?1 WHERE harness_configuration_name=?2",
    )
    .bind(replacement)
    .bind(retired)
    .execute(&mut *connection)
    .await?;
    // Identified sends and authoritative invoke results have durable replay identities. An
    // interrupted preparation may therefore be rebound to the same graph interaction under the
    // replacement product harness. Clear only that unfinished mutable binding; accepted rows and
    // immutable attempt receipts continue to describe the harness that actually executed.
    sqlx::query(
        "UPDATE interactions
         SET graph_node_id=NULL,completion_status='submitted',
             harness_configuration_name=?1,harness_configuration_digest=NULL,
             effective_execution_digest=NULL,effective_permission_receipt_json=NULL,
             completion_output_json=NULL,completion_error=NULL
         WHERE harness_configuration_name=?2
           AND completion_status IN ('not_started','running','submitted','waiting_for_approval')
           AND graph_node_id IS NOT NULL
           AND (input_identity IS NOT NULL OR EXISTS (
               SELECT 1 FROM action_invocations
               WHERE result_interaction_id=interactions.id AND authoritative=1
           ))",
    )
    .bind(replacement)
    .bind(retired)
    .execute(&mut *connection)
    .await?;
    sqlx::query(
        "UPDATE product_model_preferences SET default_harness_configuration_name=?1 WHERE singleton=1 AND default_harness_configuration_name=?2",
    )
    .bind(replacement)
    .bind(retired)
    .execute(&mut *connection)
    .await?;
    sqlx::query(
        "UPDATE product_harnesses SET product_visible=0,available=0,unavailable_reason_code='harness_retired',unavailable_reason_message='This product harness has been retired.' WHERE configuration_name=?1",
    )
    .bind(retired)
    .execute(&mut *connection)
    .await?;
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

    fn runtime_harness(id: &str) -> RuntimeProductHarness {
        RuntimeProductHarness {
            id: id.into(),
            configuration_digest: format!("sha256:{id}"),
            model_compatibility: Vec::new(),
            configuration_revision: 1,
            model_rules: None,
            execution_access_contracts: Vec::new(),
            family_policy: None,
            runtime_available: true,
            unavailable_reason: None,
        }
    }

    #[tokio::test]
    async fn harness_readiness_batch_is_digest_guarded_and_atomic() {
        let path = std::env::temp_dir().join(format!(
            "relayer-harness-readiness-{}-{}.sqlite3",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let store = SqliteProductStore::open(&path).await.unwrap();
        let harnesses = [
            runtime_harness("codex-basic"),
            runtime_harness("claude-basic"),
        ];
        store
            .initialize_model_catalog("codex-basic", &harnesses)
            .await
            .unwrap();

        store
            .update_harness_runtime_availability(&[
                HarnessRuntimeAvailabilityUpdate {
                    harness_id: "codex-basic".into(),
                    configuration_digest: "sha256:codex-basic".into(),
                    generation: 1,
                    available: true,
                    unavailable_reason: None,
                },
                HarnessRuntimeAvailabilityUpdate {
                    harness_id: "claude-basic".into(),
                    configuration_digest: "sha256:claude-basic".into(),
                    generation: 1,
                    available: false,
                    unavailable_reason: Some(UnavailableReason {
                        code: "harness_readiness_failed".into(),
                        message: "This execution configuration is currently unavailable.".into(),
                    }),
                },
            ])
            .await
            .unwrap();
        let states: Vec<(String, bool)> = sqlx::query_as(
            "SELECT configuration_name,available FROM product_harnesses WHERE configuration_name IN ('codex-basic','claude-basic') ORDER BY configuration_name",
        ).fetch_all(&store.pool).await.unwrap();
        assert_eq!(
            states,
            vec![("claude-basic".into(), false), ("codex-basic".into(), true)]
        );

        let stale = store
            .update_harness_runtime_availability(&[
                HarnessRuntimeAvailabilityUpdate {
                    harness_id: "codex-basic".into(),
                    configuration_digest: "sha256:codex-basic".into(),
                    generation: 2,
                    available: false,
                    unavailable_reason: Some(UnavailableReason {
                        code: "failed".into(),
                        message: "Unavailable.".into(),
                    }),
                },
                HarnessRuntimeAvailabilityUpdate {
                    harness_id: "claude-basic".into(),
                    configuration_digest: "sha256:stale".into(),
                    generation: 2,
                    available: true,
                    unavailable_reason: None,
                },
            ])
            .await
            .unwrap_err();
        assert!(stale.to_string().contains("stale runtime configuration"));
        let codex_available: bool = sqlx::query_scalar(
            "SELECT available FROM product_harnesses WHERE configuration_name='codex-basic'",
        )
        .fetch_one(&store.pool)
        .await
        .unwrap();
        assert!(
            codex_available,
            "the stale batch must roll back its earlier row"
        );
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn desktop_catalog_retires_product_codex_high_without_rewriting_history() {
        let path = std::env::temp_dir().join(format!(
            "relayer-product-codex-retirement-{}-{}.sqlite3",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let store = SqliteProductStore::open(&path).await.unwrap();
        sqlx::query("INSERT INTO product_harnesses(configuration_name,label,product_visible,available,unavailable_reason_code,unavailable_reason_message) VALUES ('codex-basic-high','Codex Basic High',1,1,NULL,NULL)")
            .execute(&store.pool).await.unwrap();
        sqlx::query("UPDATE product_model_preferences SET default_harness_configuration_name='codex-basic-high',defaults_modified=1 WHERE singleton=1")
            .execute(&store.pool).await.unwrap();
        sqlx::query("INSERT INTO threads(id,title,created_at,updated_at,harness_configuration_name,permission_profile_id) VALUES (1,'Legacy high','1','1','codex-basic-high','auto')")
            .execute(&store.pool).await.unwrap();
        sqlx::query("INSERT INTO interactions(id,thread_id,sequence,text,created_at,completion_status,harness_configuration_name) VALUES (1,1,1,'Historical','1','accepted','codex-basic-high')")
            .execute(&store.pool).await.unwrap();
        sqlx::query("INSERT INTO interactions(id,thread_id,sequence,text,created_at,graph_node_id,completion_status,harness_configuration_name,harness_configuration_digest,effective_execution_digest,effective_permission_receipt_json,input_identity,input_digest) VALUES (2,1,2,'Recoverable','1',22,'running','codex-basic-high','sha256:high','sha256:execution','{}','send-2','sha256:input')")
            .execute(&store.pool).await.unwrap();
        sqlx::query("INSERT INTO interaction_attempts(interaction_id,attempt_number,started_at,family_id,family_revision,harness_configuration_name,harness_configuration_revision,harness_configuration_digest,provider_id,adapter_id,adapter_implementation_version,model_id,access_contract,outcome,effect_boundary) VALUES (2,1,'1',1,1,'codex-basic-high',1,'sha256:high','codex','codex-subscription',1,'test','managed-runtime@1','running','unknown')")
            .execute(&store.pool).await.unwrap();
        sqlx::query("INSERT INTO interactions(id,thread_id,sequence,text,created_at,graph_node_id,completion_status,harness_configuration_name) VALUES (3,1,3,'Source','1',33,'accepted','codex-basic-high')")
            .execute(&store.pool).await.unwrap();
        sqlx::query("INSERT INTO interactions(id,thread_id,sequence,text,created_at,graph_node_id,completion_status,harness_configuration_name,harness_configuration_digest,effective_execution_digest,effective_permission_receipt_json) VALUES (4,1,4,'Leased invoke','1',44,'waiting_for_approval','codex-basic-high','sha256:high','sha256:execution','{}')")
            .execute(&store.pool).await.unwrap();
        sqlx::query("INSERT INTO action_invocations(source_interaction_id,action_id,result_interaction_id,created_at,graph_lease_required,authoritative) VALUES (3,41,4,'1',1,1)")
            .execute(&store.pool).await.unwrap();

        store
            .initialize_model_catalog("codex-basic", &[runtime_harness("codex-basic")])
            .await
            .unwrap();

        let thread_harness: String =
            sqlx::query_scalar("SELECT harness_configuration_name FROM threads WHERE id=1")
                .fetch_one(&store.pool)
                .await
                .unwrap();
        let default_harness: String = sqlx::query_scalar(
            "SELECT default_harness_configuration_name FROM product_model_preferences WHERE singleton=1",
        )
        .fetch_one(&store.pool)
        .await
        .unwrap();
        let retired: (bool, bool, Option<String>) = sqlx::query_as(
            "SELECT product_visible,available,unavailable_reason_code FROM product_harnesses WHERE configuration_name='codex-basic-high'",
        )
        .fetch_one(&store.pool)
        .await
        .unwrap();
        let historical_harness: String =
            sqlx::query_scalar("SELECT harness_configuration_name FROM interactions WHERE id=1")
                .fetch_one(&store.pool)
                .await
                .unwrap();
        type RecoverableBinding = (Option<i64>, String, String, Option<String>, Option<String>);
        let recoverable_bindings: Vec<RecoverableBinding> = sqlx::query_as("SELECT graph_node_id,completion_status,harness_configuration_name,harness_configuration_digest,effective_execution_digest FROM interactions WHERE id IN (2,4) ORDER BY id")
                .fetch_all(&store.pool)
                .await
                .unwrap();
        let attempt_history: (String, String) = sqlx::query_as(
            "SELECT harness_configuration_name,harness_configuration_digest FROM interaction_attempts WHERE interaction_id=2",
        )
        .fetch_one(&store.pool)
        .await
        .unwrap();

        assert_eq!(thread_harness, "codex-basic");
        assert_eq!(default_harness, "codex-basic");
        assert_eq!(retired, (false, false, Some("harness_retired".into())));
        assert_eq!(historical_harness, "codex-basic-high");
        assert_eq!(
            recoverable_bindings,
            vec![
                (None, "submitted".into(), "codex-basic".into(), None, None),
                (None, "submitted".into(), "codex-basic".into(), None, None),
            ]
        );
        assert_eq!(
            attempt_history,
            ("codex-basic-high".into(), "sha256:high".into())
        );
        drop(store);
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn eval_catalog_preserves_codex_basic_high_threads_and_preferences() {
        let path = std::env::temp_dir().join(format!(
            "relayer-eval-codex-high-{}-{}.sqlite3",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let store = SqliteProductStore::open(&path).await.unwrap();
        sqlx::query("INSERT INTO product_harnesses(configuration_name,label,product_visible,available,unavailable_reason_code,unavailable_reason_message) VALUES ('codex-basic-high','Codex Basic High',1,1,NULL,NULL)")
            .execute(&store.pool).await.unwrap();
        sqlx::query("UPDATE product_model_preferences SET default_harness_configuration_name='codex-basic-high',defaults_modified=1 WHERE singleton=1")
            .execute(&store.pool).await.unwrap();
        sqlx::query("INSERT INTO threads(id,title,created_at,updated_at,harness_configuration_name,permission_profile_id) VALUES (1,'Eval high','1','1','codex-basic-high','auto')")
            .execute(&store.pool).await.unwrap();

        store
            .initialize_model_catalog(
                "codex-basic",
                &[
                    runtime_harness("codex-basic"),
                    runtime_harness("codex-basic-high"),
                ],
            )
            .await
            .unwrap();

        let thread_harness: String =
            sqlx::query_scalar("SELECT harness_configuration_name FROM threads WHERE id=1")
                .fetch_one(&store.pool)
                .await
                .unwrap();
        let default_harness: String = sqlx::query_scalar(
            "SELECT default_harness_configuration_name FROM product_model_preferences WHERE singleton=1",
        )
        .fetch_one(&store.pool)
        .await
        .unwrap();
        let high: (bool, bool) = sqlx::query_as(
            "SELECT product_visible,available FROM product_harnesses WHERE configuration_name='codex-basic-high'",
        )
        .fetch_one(&store.pool)
        .await
        .unwrap();

        assert_eq!(thread_harness, "codex-basic-high");
        assert_eq!(default_harness, "codex-basic-high");
        assert_eq!(high, (true, true));
        drop(store);
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn product_catalog_retires_prime_agent_deep_onto_prime_agent_basic() {
        let path = std::env::temp_dir().join(format!(
            "relayer-prime-deep-{}-{}.sqlite3",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let store = SqliteProductStore::open(&path).await.unwrap();
        sqlx::query("INSERT INTO product_harnesses(configuration_name,label,product_visible,available,unavailable_reason_code,unavailable_reason_message) VALUES ('prime-agent-deep','Prime Agent Deep',1,1,NULL,NULL)")
            .execute(&store.pool).await.unwrap();
        sqlx::query("UPDATE product_model_preferences SET default_harness_configuration_name='prime-agent-deep',defaults_modified=1 WHERE singleton=1")
            .execute(&store.pool).await.unwrap();
        sqlx::query("INSERT INTO threads(id,title,created_at,updated_at,harness_configuration_name,permission_profile_id) VALUES (1,'Deep','1','1','prime-agent-deep','auto')")
            .execute(&store.pool).await.unwrap();
        sqlx::query("INSERT INTO interactions(id,thread_id,sequence,text,created_at,completion_status,harness_configuration_name) VALUES (1,1,1,'Historical','1','accepted','prime-agent-deep')")
            .execute(&store.pool).await.unwrap();

        store
            .initialize_model_catalog("prime-agent-basic", &[runtime_harness("prime-agent-basic")])
            .await
            .unwrap();

        let thread_harness: String =
            sqlx::query_scalar("SELECT harness_configuration_name FROM threads WHERE id=1")
                .fetch_one(&store.pool)
                .await
                .unwrap();
        let default_harness: String = sqlx::query_scalar(
            "SELECT default_harness_configuration_name FROM product_model_preferences WHERE singleton=1",
        )
        .fetch_one(&store.pool)
        .await
        .unwrap();
        let retired: (bool, bool, Option<String>) = sqlx::query_as(
            "SELECT product_visible,available,unavailable_reason_code FROM product_harnesses WHERE configuration_name='prime-agent-deep'",
        )
        .fetch_one(&store.pool)
        .await
        .unwrap();
        let historical_harness: String =
            sqlx::query_scalar("SELECT harness_configuration_name FROM interactions WHERE id=1")
                .fetch_one(&store.pool)
                .await
                .unwrap();

        assert_eq!(thread_harness, "prime-agent-basic");
        assert_eq!(default_harness, "prime-agent-basic");
        assert_eq!(retired, (false, false, Some("harness_retired".into())));
        // Accepted history keeps the identity of the harness that actually executed.
        assert_eq!(historical_harness, "prime-agent-deep");
        drop(store);
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn absent_prime_replacement_leaves_deep_threads_untouched() {
        let path = std::env::temp_dir().join(format!(
            "relayer-prime-deep-absent-{}-{}.sqlite3",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let store = SqliteProductStore::open(&path).await.unwrap();
        sqlx::query("INSERT INTO threads(id,title,created_at,updated_at,harness_configuration_name,permission_profile_id) VALUES (1,'Deep','1','1','prime-agent-deep','auto')")
            .execute(&store.pool).await.unwrap();

        // Prime is unavailable entirely, so there is no replacement to move onto.
        store
            .initialize_model_catalog("codex-basic", &[runtime_harness("codex-basic")])
            .await
            .unwrap();

        let thread_harness: String =
            sqlx::query_scalar("SELECT harness_configuration_name FROM threads WHERE id=1")
                .fetch_one(&store.pool)
                .await
                .unwrap();

        assert_eq!(thread_harness, "prime-agent-deep");
        drop(store);
        let _ = std::fs::remove_file(path);
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
    async fn provider_removal_waits_for_restart_to_finalize_a_durable_running_attempt() {
        let path = std::env::temp_dir().join(format!(
            "relayer-provider-removal-drain-{}-{}.sqlite3",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let store = SqliteProductStore::open(&path).await.unwrap();
        let mut provider = definition("draining-provider");
        store
            .sync_provider_definitions(std::slice::from_ref(&provider))
            .await
            .unwrap();
        let family_id = sqlx::query("INSERT INTO model_families(name,kind,enabled,position,revision,lifecycle_state) VALUES ('Drain receipt','custom',1,1,1,'active')")
            .execute(&store.pool).await.unwrap().last_insert_rowid();
        let thread_id = sqlx::query(
            "INSERT INTO threads(title,created_at,updated_at) VALUES ('Drain','1','1')",
        )
        .execute(&store.pool)
        .await
        .unwrap()
        .last_insert_rowid();
        let interaction_id = sqlx::query("INSERT INTO interactions(thread_id,sequence,text,created_at,completion_status,model_provider_id,provider_model_id,model_family_id) VALUES (?1,0,'in flight','1','running',?2,'gpt-work',?3)")
            .bind(thread_id).bind(provider.id.as_str()).bind(family_id)
            .execute(&store.pool).await.unwrap().last_insert_rowid();
        sqlx::query("INSERT INTO interaction_attempts(interaction_id,attempt_number,started_at,family_id,family_revision,harness_configuration_name,harness_configuration_revision,harness_configuration_digest,provider_id,adapter_id,adapter_implementation_version,model_id,access_contract,outcome,effect_boundary,attempt_admission_id,admitted_plan_json,admitted_plan_digest) VALUES (?1,1,'1',?2,1,'codex-basic',1,'sha256:test',?3,'openai-api',7,'gpt-work','secret@1','running','unknown','admission-drain','{}','sha256:plan')")
            .bind(interaction_id).bind(family_id).bind(provider.id.as_str())
            .execute(&store.pool).await.unwrap();

        provider.lifecycle_state = "removal_pending".into();
        store
            .sync_provider_definitions(std::slice::from_ref(&provider))
            .await
            .unwrap();
        let mut tombstone = provider.clone();
        tombstone.lifecycle_state = "tombstoned".into();
        tombstone.credential_reference = None;
        tombstone.removed_at = Some("2".into());
        let blocked = store
            .sync_provider_definitions(std::slice::from_ref(&tombstone))
            .await
            .unwrap_err();
        assert!(blocked.to_string().contains("attempt is running"));

        assert_eq!(
            store
                .recover_interrupted_interactions("restart", false)
                .await
                .unwrap(),
            1
        );
        store
            .sync_provider_definitions(std::slice::from_ref(&tombstone))
            .await
            .unwrap();
        let state: (String, String, String) = sqlx::query_as(
            "SELECT p.lifecycle_state,a.outcome,a.effect_boundary FROM model_providers p JOIN interaction_attempts a ON a.provider_id=p.id WHERE p.id=?1",
        )
        .bind(provider.id.as_str())
        .fetch_one(&store.pool)
        .await
        .unwrap();
        assert_eq!(
            state,
            (
                "tombstoned".into(),
                "execution_failed".into(),
                "unknown".into()
            )
        );
        std::fs::remove_file(path).unwrap();
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
            runtime_available: true,
            unavailable_reason: None,
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
                    ..shipped.clone()
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
        assert_eq!(harness.configuration_revision, 3);
        assert_eq!(harness.model_rules, Some(edited));
        store
            .initialize_model_catalog(
                "codex-basic",
                &[RuntimeProductHarness {
                    runtime_available: false,
                    unavailable_reason: Some(UnavailableReason {
                        code: "prime_agent_boundary_unsupported".into(),
                        message: "Choose another available harness on this device.".into(),
                    }),
                    ..shipped
                }],
            )
            .await
            .unwrap();
        let unavailable = store
            .load_model_settings()
            .await
            .unwrap()
            .harnesses
            .into_iter()
            .find(|item| item.id == "codex-basic")
            .unwrap();
        assert!(!unavailable.available);
        assert_eq!(
            unavailable.unavailable_reason.unwrap().code,
            "prime_agent_boundary_unsupported"
        );
    }

    #[tokio::test]
    async fn onboarding_projection_uses_exact_rules_access_and_app_default_without_fallback() {
        let (store, path, provider_id) = onboarding_store().await;
        let allowed = HashSet::from(["codex-basic".to_owned(), "claude-basic".to_owned()]);
        let projection = store
            .provider_onboarding_projection(&provider_id, "codex-basic", &allowed)
            .await
            .unwrap();
        assert_eq!(
            projection.initial_harness_id.as_deref(),
            Some("codex-basic")
        );
        let codex = projection
            .harnesses
            .iter()
            .find(|harness| harness.id == "codex-basic")
            .unwrap();
        assert!(codex.selectable);
        assert!(codex.selected_initially);
        assert_eq!(codex.matching_access_contract.as_deref(), Some("secret@1"));
        assert_eq!(codex.eligible_models.len(), 1);
        let claude = projection
            .harnesses
            .iter()
            .find(|harness| harness.id == "claude-basic")
            .unwrap();
        assert!(!claude.selectable);
        assert_eq!(
            claude.incompatibility_reason.as_ref().unwrap().code,
            "harness_access_contract_incompatible"
        );

        store
            .update_harness_model_rules(&UpdateHarnessModelRulesCommand {
                harness_id: "codex-basic".into(),
                expected_revision: 1,
                rules: HarnessModelRules {
                    allow: vec![HarnessModelRule {
                        adapter_id: "openai-api".into(),
                        model_id_exact: None,
                        model_id_regex: Some("^gpt-".into()),
                    }],
                    deny: vec![HarnessModelRule {
                        adapter_id: "openai-api".into(),
                        model_id_exact: Some("gpt-work".into()),
                        model_id_regex: None,
                    }],
                },
            })
            .await
            .unwrap();
        let denied = store
            .provider_onboarding_projection(&provider_id, "codex-basic", &allowed)
            .await
            .unwrap();
        assert!(denied.initial_harness_id.is_none());
        assert_eq!(
            denied
                .harnesses
                .iter()
                .find(|harness| harness.id == "codex-basic")
                .unwrap()
                .incompatibility_reason
                .as_ref()
                .unwrap()
                .code,
            "harness_model_incompatible"
        );
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn unavailable_execution_configurations_are_hidden_behind_provider_recovery_state() {
        let (store, path, provider_id) = onboarding_store().await;
        sqlx::query("UPDATE product_harnesses SET available=0,unavailable_reason_code='harness_readiness_failed',unavailable_reason_message='This execution configuration is currently unavailable.' WHERE configuration_name IN ('codex-basic','codex-alternate')")
            .execute(&store.pool).await.unwrap();
        let allowed = HashSet::from(["codex-basic".to_owned(), "codex-alternate".to_owned()]);
        let projection = store
            .provider_onboarding_projection(&provider_id, "codex-basic", &allowed)
            .await
            .unwrap();
        assert!(
            projection
                .harnesses
                .iter()
                .all(|harness| { harness.id != "codex-basic" && harness.id != "codex-alternate" })
        );
        assert_eq!(
            projection.blocking_reason.unwrap().code,
            "provider_no_available_execution_configurations"
        );
        let settings = store.load_model_settings().await.unwrap();
        assert_eq!(
            settings
                .providers
                .into_iter()
                .find(|provider| provider.id == provider_id)
                .unwrap()
                .unavailable_reason
                .unwrap()
                .code,
            "provider_no_available_execution_configurations"
        );
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn onboarding_create_and_defaults_commit_together_and_status_uses_saved_harness() {
        let (store, path, provider_id) = onboarding_store().await;
        let allowed = HashSet::from(["codex-basic".to_owned(), "codex-alternate".to_owned()]);
        let projection = store
            .provider_onboarding_projection(&provider_id, "codex-basic", &allowed)
            .await
            .unwrap();
        let completion = store
            .complete_provider_onboarding(
                &CompleteProviderOnboardingCommand {
                    provider_id: provider_id.clone(),
                    harness_id: "codex-alternate".into(),
                    expected_projection_revision: projection.projection_revision,
                    family: ProviderOnboardingFamilyIntent::Create {
                        name: "Work default".into(),
                        members: vec![ModelFamilyMember {
                            provider_id: provider_id.clone(),
                            model_id: "gpt-work".into(),
                            position: 0,
                        }],
                    },
                },
                "codex-basic",
                &allowed,
            )
            .await
            .unwrap();
        assert_eq!(completion.defaults.provider_id, provider_id);
        assert_eq!(completion.defaults.harness_id, "codex-alternate");
        assert_eq!(
            completion.defaults.family_id,
            Some(completion.resolution.family_id)
        );
        assert_eq!(completion.resolution.resolvable_members.len(), 1);
        let status = store.provider_onboarding_status(&allowed).await.unwrap();
        assert!(status.complete);
        assert_eq!(status.defaults.harness_id, "codex-alternate");
        assert_eq!(status.resolution.unwrap(), completion.resolution);
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn onboarding_revision_conflict_rolls_back_family_and_defaults() {
        let (store, path, provider_id) = onboarding_store().await;
        let allowed = HashSet::from(["codex-basic".to_owned()]);
        let projection = store
            .provider_onboarding_projection(&provider_id, "codex-basic", &allowed)
            .await
            .unwrap();
        sqlx::query(
            "UPDATE provider_models SET available=0 WHERE provider_id=?1 AND model_id='gpt-work'",
        )
        .bind(provider_id.as_str())
        .execute(&store.pool)
        .await
        .unwrap();
        let before = store.load_model_settings().await.unwrap().defaults;
        let error = store
            .complete_provider_onboarding(
                &CompleteProviderOnboardingCommand {
                    provider_id,
                    harness_id: "codex-basic".into(),
                    expected_projection_revision: projection.projection_revision,
                    family: ProviderOnboardingFamilyIntent::Create {
                        name: "Must not persist".into(),
                        members: vec![ModelFamilyMember {
                            provider_id: ProviderId::parse("work-openai").unwrap(),
                            model_id: "gpt-work".into(),
                            position: 0,
                        }],
                    },
                },
                "codex-basic",
                &allowed,
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("changed"));
        assert_eq!(store.load_model_settings().await.unwrap().defaults, before);
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM model_families WHERE name='Must not persist'",
            )
            .fetch_one(&store.pool)
            .await
            .unwrap(),
            0
        );
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn onboarding_managed_preview_uses_policy_and_avoids_custom_name_collision() {
        let path = std::env::temp_dir().join(format!(
            "relayer-managed-onboarding-{}-{}.sqlite3",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let store = SqliteProductStore::open(&path).await.unwrap();
        let rules = HarnessModelRules {
            allow: vec![HarnessModelRule {
                adapter_id: "codex-subscription".into(),
                model_id_exact: Some("default".into()),
                model_id_regex: None,
            }],
            deny: Vec::new(),
        };
        store
            .initialize_model_catalog(
                "plain-basic",
                &[
                    RuntimeProductHarness {
                        id: "plain-basic".into(),
                        configuration_digest: "sha256:plain".into(),
                        model_compatibility: Vec::new(),
                        configuration_revision: 1,
                        model_rules: Some(rules.clone()),
                        execution_access_contracts: vec!["managed-runtime@1".into()],
                        family_policy: None,
                        runtime_available: true,
                        unavailable_reason: None,
                    },
                    RuntimeProductHarness {
                        id: "managed-codex".into(),
                        configuration_digest: "sha256:managed".into(),
                        model_compatibility: Vec::new(),
                        configuration_revision: 1,
                        model_rules: Some(rules),
                        execution_access_contracts: vec!["managed-runtime@1".into()],
                        family_policy: Some(FamilyPolicyReference {
                            id: "codex-default-family".into(),
                            version: 1,
                        }),
                        runtime_available: true,
                        unavailable_reason: None,
                    },
                ],
            )
            .await
            .unwrap();
        sqlx::query(
            "UPDATE model_providers SET connected=1,lifecycle_state='active' WHERE id='codex'",
        )
        .execute(&store.pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO provider_models(provider_id,model_id,label,provider_order,visible,available,provider_default,metadata_json) VALUES ('codex','default','Default',0,1,1,1,'{}')")
            .execute(&store.pool).await.unwrap();
        let custom_name = "CODEX DEFAULTS";
        let custom_family = sqlx::query(
            "INSERT INTO model_families(name,kind,system_key,enabled,position) VALUES (?1,'custom',NULL,1,0)",
        )
        .bind(custom_name)
        .execute(&store.pool)
        .await
        .unwrap()
        .last_insert_rowid();
        sqlx::query(
            "INSERT INTO model_family_members(family_id,position,provider_id,model_id) VALUES (?1,0,'codex','default')",
        )
        .bind(custom_family)
        .execute(&store.pool)
        .await
        .unwrap();
        let allowed = HashSet::from(["plain-basic".into(), "managed-codex".into()]);
        let projection = store
            .provider_onboarding_projection(
                &ProviderId::parse("codex").unwrap(),
                "plain-basic",
                &allowed,
            )
            .await
            .unwrap();
        assert!(
            projection
                .harnesses
                .iter()
                .find(|harness| harness.id == "plain-basic")
                .unwrap()
                .managed_family_candidate
                .is_none()
        );
        let candidate = projection
            .harnesses
            .iter()
            .find(|harness| harness.id == "managed-codex")
            .unwrap()
            .managed_family_candidate
            .clone()
            .unwrap();
        let preferred_name = candidate.name.clone();
        assert!(preferred_name.eq_ignore_ascii_case(custom_name));
        let completion = store
            .complete_provider_onboarding(
                &CompleteProviderOnboardingCommand {
                    provider_id: ProviderId::parse("codex").unwrap(),
                    harness_id: "managed-codex".into(),
                    expected_projection_revision: projection.projection_revision,
                    family: ProviderOnboardingFamilyIntent::Managed {
                        policy_id: candidate.policy_id,
                        policy_version: candidate.policy_version,
                    },
                },
                "plain-basic",
                &allowed,
            )
            .await
            .unwrap();
        assert_eq!(completion.defaults.harness_id, "managed-codex");
        assert_eq!(
            completion.resolution.resolvable_members[0].model_id,
            "default"
        );
        let managed_name: String =
            sqlx::query_scalar("SELECT name FROM model_families WHERE id=?1")
                .bind(completion.resolution.family_id.value())
                .fetch_one(&store.pool)
                .await
                .unwrap();
        assert_eq!(managed_name, format!("{preferred_name} (2)"));
        let retained_custom_name: String =
            sqlx::query_scalar("SELECT name FROM model_families WHERE id=?1")
                .bind(custom_family)
                .fetch_one(&store.pool)
                .await
                .unwrap();
        assert_eq!(retained_custom_name, custom_name);
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn model_settings_project_only_exactly_executable_harnesses_as_usable_now() {
        let (store, path, provider_id) = onboarding_store().await;
        let allowed = HashSet::from(["codex-basic".to_owned(), "claude-basic".to_owned()]);
        let projection = store
            .provider_onboarding_projection(&provider_id, "codex-basic", &allowed)
            .await
            .unwrap();
        let completion = store
            .complete_provider_onboarding(
                &CompleteProviderOnboardingCommand {
                    provider_id: provider_id.clone(),
                    harness_id: "codex-basic".into(),
                    expected_projection_revision: projection.projection_revision,
                    family: ProviderOnboardingFamilyIntent::Create {
                        name: "Work models".into(),
                        members: vec![ModelFamilyMember {
                            provider_id: provider_id.clone(),
                            model_id: "gpt-work".into(),
                            position: 0,
                        }],
                    },
                },
                "codex-basic",
                &allowed,
            )
            .await
            .unwrap();

        let settings = store.load_model_settings().await.unwrap();
        let codex = settings
            .harnesses
            .iter()
            .find(|harness| harness.id == "codex-basic")
            .unwrap();
        assert!(codex.usable_now);
        assert_eq!(codex.usable_provider_ids, vec![provider_id]);
        assert_eq!(
            codex.usable_family_ids,
            vec![completion.resolution.family_id]
        );
        let claude = settings
            .harnesses
            .iter()
            .find(|harness| harness.id == "claude-basic")
            .unwrap();
        assert!(claude.available);
        assert!(!claude.usable_now);
        assert!(claude.usable_provider_ids.is_empty());
        assert!(claude.usable_family_ids.is_empty());
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn configuration_owned_harness_can_become_default_with_a_saved_family() {
        let (store, path, provider_id) = onboarding_store().await;
        let allowed = HashSet::from(["codex-basic".to_owned()]);
        let projection = store
            .provider_onboarding_projection(&provider_id, "codex-basic", &allowed)
            .await
            .unwrap();
        let completion = store
            .complete_provider_onboarding(
                &CompleteProviderOnboardingCommand {
                    provider_id: provider_id.clone(),
                    harness_id: "codex-basic".into(),
                    expected_projection_revision: projection.projection_revision,
                    family: ProviderOnboardingFamilyIntent::Create {
                        name: "Work models".into(),
                        members: vec![ModelFamilyMember {
                            provider_id,
                            model_id: "gpt-work".into(),
                            position: 0,
                        }],
                    },
                },
                "codex-basic",
                &allowed,
            )
            .await
            .unwrap();
        store
            .initialize_model_catalog(
                "configuration-owned",
                &[RuntimeProductHarness {
                    id: "configuration-owned".into(),
                    configuration_digest: "sha256:configuration-owned".into(),
                    model_compatibility: Vec::new(),
                    configuration_revision: 1,
                    model_rules: None,
                    execution_access_contracts: Vec::new(),
                    family_policy: None,
                    runtime_available: true,
                    unavailable_reason: None,
                }],
            )
            .await
            .unwrap();

        let defaults = store
            .update_model_settings_defaults(&UpdateModelSettingsDefaultsCommand {
                harness_id: Some("configuration-owned".into()),
                provider_id: None,
                family_id: None,
            })
            .await
            .unwrap();

        assert_eq!(defaults.harness_id, "configuration-owned");
        assert_eq!(defaults.family_id, Some(completion.resolution.family_id));
        std::fs::remove_file(path).unwrap();
    }

    async fn onboarding_store() -> (SqliteProductStore, std::path::PathBuf, ProviderId) {
        let path = std::env::temp_dir().join(format!(
            "relayer-provider-onboarding-{}-{}.sqlite3",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let store = SqliteProductStore::open(&path).await.unwrap();
        let allow = HarnessModelRules {
            allow: vec![HarnessModelRule {
                adapter_id: "openai-api".into(),
                model_id_exact: None,
                model_id_regex: Some("^gpt-".into()),
            }],
            deny: Vec::new(),
        };
        store
            .initialize_model_catalog(
                "codex-basic",
                &[
                    RuntimeProductHarness {
                        id: "codex-basic".into(),
                        configuration_digest: "sha256:onboarding-codex".into(),
                        model_compatibility: Vec::new(),
                        configuration_revision: 1,
                        model_rules: Some(allow.clone()),
                        execution_access_contracts: vec!["secret@1".into()],
                        family_policy: None,
                        runtime_available: true,
                        unavailable_reason: None,
                    },
                    RuntimeProductHarness {
                        id: "claude-basic".into(),
                        configuration_digest: "sha256:onboarding-claude".into(),
                        model_compatibility: Vec::new(),
                        configuration_revision: 1,
                        model_rules: Some(allow),
                        execution_access_contracts: vec!["managed-runtime@1".into()],
                        family_policy: None,
                        runtime_available: true,
                        unavailable_reason: None,
                    },
                    RuntimeProductHarness {
                        id: "codex-alternate".into(),
                        configuration_digest: "sha256:onboarding-codex-alternate".into(),
                        model_compatibility: Vec::new(),
                        configuration_revision: 1,
                        model_rules: Some(HarnessModelRules {
                            allow: vec![HarnessModelRule {
                                adapter_id: "openai-api".into(),
                                model_id_exact: None,
                                model_id_regex: Some("^gpt-".into()),
                            }],
                            deny: Vec::new(),
                        }),
                        execution_access_contracts: vec!["secret@1".into()],
                        family_policy: None,
                        runtime_available: true,
                        unavailable_reason: None,
                    },
                ],
            )
            .await
            .unwrap();
        let provider_id = ProviderId::parse("work-openai").unwrap();
        let definition = ProviderDefinition {
            id: provider_id.clone(),
            adapter_id: "openai-api".into(),
            label: "Work OpenAI".into(),
            endpoint: Some("https://api.openai.com/v1".into()),
            access_contract: "secret@1".into(),
            credential_reference: Some("provider:work-openai".into()),
            lifecycle_state: "active".into(),
            removed_at: None,
        };
        let snapshot = ProviderCatalogSnapshot {
            provider_id: provider_id.clone(),
            label: definition.label.clone(),
            connected: true,
            unavailable_reason: None,
            models: vec![crate::product::CatalogModelSnapshot {
                id: "gpt-work".into(),
                label: "GPT Work".into(),
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
            .create_provider_with_catalog(&definition, &snapshot, None, "1")
            .await
            .unwrap();
        (store, path, provider_id)
    }
}
