use super::{
    CatalogError, FamilyPolicyReference, ModelFamilyMember, ProductHarness, ProviderCatalogSnapshot,
};

pub(crate) const CODEX_DEFAULT_FAMILY_POLICY_ID: &str = "codex-default-family";
pub(crate) const CLAUDE_DEFAULT_FAMILY_POLICY_ID: &str = "claude-default-family";
pub(crate) fn applies_to_adapter(policy: &FamilyPolicyReference, adapter_id: &str) -> bool {
    matches!(
        (policy.id.as_str(), adapter_id),
        (CODEX_DEFAULT_FAMILY_POLICY_ID, "codex-subscription")
            | (CLAUDE_DEFAULT_FAMILY_POLICY_ID, "claude-subscription")
    )
}

fn supported_policy(policy: &FamilyPolicyReference) -> bool {
    matches!(
        (policy.id.as_str(), policy.version),
        (CODEX_DEFAULT_FAMILY_POLICY_ID, 1 | 2) | (CLAUDE_DEFAULT_FAMILY_POLICY_ID, 1)
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DefaultOnboardingPolicy {
    pub(crate) harness_id: String,
    pub(crate) policy: FamilyPolicyReference,
}

pub(crate) fn resolve_default_onboarding_policy(
    harnesses: &[ProductHarness],
    app_default_harness_id: &str,
    adapter_id: &str,
) -> Option<DefaultOnboardingPolicy> {
    let mut candidates = harnesses
        .iter()
        .filter(|harness| harness.available)
        .filter_map(|harness| {
            harness
                .family_policy
                .as_ref()
                .filter(|policy| applies_to_adapter(policy, adapter_id) && supported_policy(policy))
                .map(|policy| (harness, policy))
        })
        .collect::<Vec<_>>();
    let (_, policy) = *candidates.first()?;
    if candidates.iter().any(|(_, candidate)| *candidate != policy) {
        return None;
    }
    candidates.sort_by(|(left, _), (right, _)| left.id.cmp(&right.id));
    let (harness, policy) = candidates
        .iter()
        .copied()
        .find(|(harness, _)| harness.id == app_default_harness_id)
        .unwrap_or(candidates[0]);
    Some(DefaultOnboardingPolicy {
        harness_id: harness.id.clone(),
        policy: policy.clone(),
    })
}

/// Product-owned managed-family policy registry. Provider adapters normalize
/// metadata; they do not choose or persist model families.
pub(crate) fn derive_managed_family_members(
    policy: &FamilyPolicyReference,
    snapshot: &ProviderCatalogSnapshot,
) -> Result<Vec<ModelFamilyMember>, CatalogError> {
    match (policy.id.as_str(), policy.version) {
        (CODEX_DEFAULT_FAMILY_POLICY_ID, 1 | 2) | (CLAUDE_DEFAULT_FAMILY_POLICY_ID, 1) => {
            let include_all_visible = policy.id == CLAUDE_DEFAULT_FAMILY_POLICY_ID;
            let mut models = snapshot
                .models
                .iter()
                .filter(|model| model.visible && (include_all_visible || model.provider_default))
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
    fn claude_policy_applies_only_to_the_claude_subscription_adapter() {
        let policy = FamilyPolicyReference {
            id: CLAUDE_DEFAULT_FAMILY_POLICY_ID.into(),
            version: 1,
        };

        assert!(applies_to_adapter(&policy, "claude-subscription"));
        assert!(!applies_to_adapter(&policy, "anthropic-api"));
        assert!(!applies_to_adapter(&policy, "codex-subscription"));
        assert!(applies_to_adapter(
            &FamilyPolicyReference {
                id: CLAUDE_DEFAULT_FAMILY_POLICY_ID.into(),
                version: 2,
            },
            "claude-subscription"
        ));
        assert_eq!(
            derive_managed_family_members(
                &policy,
                &snapshot(vec![
                    model("opus", 1, true, false),
                    model("sonnet", 0, true, true),
                    model("fable", 2, true, false),
                    model("hidden", 3, false, true),
                ]),
            )
            .unwrap()
            .iter()
            .map(|member| member.model_id.as_str())
            .collect::<Vec<_>>(),
            vec!["sonnet", "opus", "fable"]
        );
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
