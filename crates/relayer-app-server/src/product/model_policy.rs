use super::{CatalogError, FamilyPolicyReference, ModelFamilyMember, ProviderCatalogSnapshot};

pub(crate) const CODEX_DEFAULT_FAMILY_POLICY_ID: &str = "codex-default-family";
pub(crate) fn applies_to_adapter(policy: &FamilyPolicyReference, adapter_id: &str) -> bool {
    policy.id == CODEX_DEFAULT_FAMILY_POLICY_ID && adapter_id == "codex-subscription"
}

/// Product-owned managed-family policy registry. Provider adapters normalize
/// metadata; they do not choose or persist model families.
pub(crate) fn derive_managed_family_members(
    policy: &FamilyPolicyReference,
    snapshot: &ProviderCatalogSnapshot,
) -> Result<Vec<ModelFamilyMember>, CatalogError> {
    match (policy.id.as_str(), policy.version) {
        (CODEX_DEFAULT_FAMILY_POLICY_ID, 1 | 2) => {
            let mut models = snapshot
                .models
                .iter()
                .filter(|model| model.visible && model.provider_default)
                .collect::<Vec<_>>();
            models.sort_by_key(|model| model.order);
            Ok(models
                .into_iter()
                .take(super::catalog::MAX_MODELS_PER_FAMILY)
                .enumerate()
                .map(|(position, model)| ModelFamilyMember {
                    provider_id: snapshot.provider_id.clone(),
                    model_id: model.id.clone(),
                    position,
                })
                .collect())
        }
        _ => Err(CatalogError::invalid(
            "family_policy_unknown",
            format!(
                "Unknown model-family policy {}@{}.",
                policy.id, policy.version
            ),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::product::{ProviderId, catalog::CatalogModelSnapshot};

    fn snapshot(models: Vec<CatalogModelSnapshot>) -> ProviderCatalogSnapshot {
        ProviderCatalogSnapshot {
            provider_id: ProviderId::parse("codex").unwrap(),
            label: "Codex".into(),
            connected: true,
            unavailable_reason: None,
            models,
            system_family: None,
        }
    }

    fn model(
        id: &str,
        order: usize,
        visible: bool,
        provider_default: bool,
    ) -> CatalogModelSnapshot {
        CatalogModelSnapshot {
            id: id.into(),
            label: id.into(),
            order,
            visible,
            available: true,
            unavailable_reason: None,
            provider_default,
            replacement_model_id: None,
            metadata: serde_json::json!({}),
        }
    }

    #[test]
    fn codex_policy_uses_all_visible_default_metadata_in_provider_order() {
        let members = derive_managed_family_members(
            &FamilyPolicyReference {
                id: CODEX_DEFAULT_FAMILY_POLICY_ID.into(),
                version: 1,
            },
            &snapshot(vec![
                model("later", 2, true, true),
                model("hidden", 0, false, true),
                model("first", 1, true, true),
                model("not-default", 3, true, false),
            ]),
        )
        .unwrap();

        assert_eq!(
            members
                .iter()
                .map(|member| member.model_id.as_str())
                .collect::<Vec<_>>(),
            vec!["first", "later"]
        );
        assert_eq!(members[0].position, 0);
        assert_eq!(members[1].position, 1);
    }

    #[test]
    fn managed_policy_is_bounded_and_unknown_versions_fail_closed() {
        let models = (0..8)
            .map(|index| model(&format!("model-{index}"), index, true, true))
            .collect();
        let snapshot = snapshot(models);
        assert_eq!(
            derive_managed_family_members(
                &FamilyPolicyReference {
                    id: CODEX_DEFAULT_FAMILY_POLICY_ID.into(),
                    version: 1,
                },
                &snapshot,
            )
            .unwrap()
            .len(),
            5
        );
        assert_eq!(
            derive_managed_family_members(
                &FamilyPolicyReference {
                    id: CODEX_DEFAULT_FAMILY_POLICY_ID.into(),
                    version: 99,
                },
                &snapshot,
            )
            .unwrap_err()
            .code(),
            "family_policy_unknown"
        );
    }
}
