use super::{CatalogError, FamilyPolicyReference, ModelFamilyMember, ProviderCatalogSnapshot};

pub(crate) const CODEX_DEFAULT_FAMILY_POLICY_ID: &str = "codex-default-family";
pub(crate) const CLAUDE_DEFAULT_FAMILY_POLICY_ID: &str = "claude-default-family";
pub(crate) const PROVIDER_DEFAULT_FAMILY_POLICY_ID: &str = "provider-default-family";
pub(crate) const OPENROUTER_DEFAULT_FAMILY_POLICY_ID: &str = "openrouter-default-family";
pub(crate) const VERCEL_AI_ROUTER_DEFAULT_FAMILY_POLICY_ID: &str =
    "vercel-ai-router-default-family";
pub(crate) const PRIME_DEFAULT_FAMILY_POLICY_ID: &str = "prime-default-family";
const CODEX_DEFAULT_FAMILY_V4_MODELS: [&str; 3] = ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"];
const CODEX_DEFAULT_FAMILY_V3_MODELS: [&str; 3] = ["gpt-6-sol", "gpt-6-astra", "gpt-6-luna"];
const PRIME_DEFAULT_FAMILY_V1_MODELS: [&str; 5] = [
    "qwen/qwen3.8-max",
    "alibaba/qwen3.8-max",
    "deepseek/deepseek-v4-pro-0813",
    "z-ai/glm-5.3",
    "zai/glm-5.3",
];
const CODEX_DEFAULT_FAMILY_V2_MODELS: [&str; 3] = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
const OPENAI_API_DEFAULT_FAMILY_V1_MODELS: [&str; 5] = [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.4",
];
const OPENROUTER_DEFAULT_FAMILY_V1_MODELS: [&str; 3] = [
    "deepseek/deepseek-v4-pro-0813",
    "qwen/qwen3.8-max",
    "z-ai/glm-5.3",
];
const VERCEL_AI_ROUTER_DEFAULT_FAMILY_V1_MODELS: [&str; 3] = [
    "deepseek/deepseek-v4-pro-0813",
    "alibaba/qwen3.8-max",
    "zai/glm-5.3",
];

pub(crate) fn applies_to_adapter(policy: &FamilyPolicyReference, adapter_id: &str) -> bool {
    matches!(
        (policy.id.as_str(), adapter_id),
        (CODEX_DEFAULT_FAMILY_POLICY_ID, "codex-subscription")
            | (CLAUDE_DEFAULT_FAMILY_POLICY_ID, "claude-subscription")
            | (
                PROVIDER_DEFAULT_FAMILY_POLICY_ID,
                "openai-api" | "anthropic-api"
            )
            | (
                PRIME_DEFAULT_FAMILY_POLICY_ID,
                "openrouter" | "vercel-ai-router"
            )
            | (OPENROUTER_DEFAULT_FAMILY_POLICY_ID, "openrouter")
            | (
                VERCEL_AI_ROUTER_DEFAULT_FAMILY_POLICY_ID,
                "vercel-ai-router"
            )
    )
}

pub(crate) fn fallback_for_adapter(adapter_id: &str) -> Option<FamilyPolicyReference> {
    match adapter_id {
        "openrouter" => Some(FamilyPolicyReference {
            id: PRIME_DEFAULT_FAMILY_POLICY_ID.into(),
            version: 1,
        }),
        "vercel-ai-router" => Some(FamilyPolicyReference {
            id: PRIME_DEFAULT_FAMILY_POLICY_ID.into(),
            version: 1,
        }),
        "openai-api" | "anthropic-api" => Some(FamilyPolicyReference {
            id: PROVIDER_DEFAULT_FAMILY_POLICY_ID.into(),
            version: 1,
        }),
        _ => None,
    }
}

/// Product-owned managed-family policy registry. Provider adapters normalize
/// metadata; they do not choose or persist model families.
pub(crate) fn derive_managed_family_members(
    policy: &FamilyPolicyReference,
    snapshot: &ProviderCatalogSnapshot,
) -> Result<Vec<ModelFamilyMember>, CatalogError> {
    let mut members = derive_managed_family_members_unassigned(policy, snapshot)?;
    assign_managed_orchestrator(&mut members);
    Ok(members)
}

pub(crate) fn assign_managed_orchestrator(members: &mut [ModelFamilyMember]) {
    // Family order already encodes the managed policy's model preference.
    // Availability filters execution, never chooses a replacement orchestrator.
    let selected = 0;
    for (index, member) in members.iter_mut().enumerate() {
        member.roles = if index == selected {
            vec![super::ModelFamilyRole::orchestrator()]
        } else {
            Vec::new()
        };
    }
}

fn derive_managed_family_members_unassigned(
    policy: &FamilyPolicyReference,
    snapshot: &ProviderCatalogSnapshot,
) -> Result<Vec<ModelFamilyMember>, CatalogError> {
    match (policy.id.as_str(), policy.version) {
        (CODEX_DEFAULT_FAMILY_POLICY_ID, 1) => {
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
                    roles: Vec::new(),
                    provider_id: snapshot.provider_id.clone(),
                    model_id: model.id.clone(),
                    position,
                })
                .collect())
        }
        (CODEX_DEFAULT_FAMILY_POLICY_ID, 2..=4) => {
            let preferences = match policy.version {
                4 => CODEX_DEFAULT_FAMILY_V4_MODELS,
                3 => CODEX_DEFAULT_FAMILY_V3_MODELS,
                _ => CODEX_DEFAULT_FAMILY_V2_MODELS,
            };
            let mut models = preferences
                .iter()
                .filter_map(|model_id| {
                    snapshot
                        .models
                        .iter()
                        .find(|model| model.visible && model.id == *model_id)
                })
                .collect::<Vec<_>>();
            let mut provider_defaults = snapshot
                .models
                .iter()
                .filter(|model| {
                    model.visible
                        && model.provider_default
                        && !models.iter().any(|selected| selected.id == model.id)
                })
                .collect::<Vec<_>>();
            provider_defaults.sort_by_key(|model| model.order);
            models.extend(provider_defaults);
            Ok(models
                .into_iter()
                .take(super::catalog::MAX_MODELS_PER_FAMILY)
                .enumerate()
                .map(|(position, model)| ModelFamilyMember {
                    roles: Vec::new(),
                    provider_id: snapshot.provider_id.clone(),
                    model_id: model.id.clone(),
                    position,
                })
                .collect())
        }
        (CLAUDE_DEFAULT_FAMILY_POLICY_ID, 1) => {
            let mut models = snapshot
                .models
                .iter()
                .filter(|model| model.visible && model.available)
                .collect::<Vec<_>>();
            models.sort_by_key(|model| model.order);
            Ok(models
                .into_iter()
                .take(super::catalog::MAX_MODELS_PER_FAMILY)
                .enumerate()
                .map(|(position, model)| ModelFamilyMember {
                    roles: Vec::new(),
                    provider_id: snapshot.provider_id.clone(),
                    model_id: model.id.clone(),
                    position,
                })
                .collect())
        }
        (PROVIDER_DEFAULT_FAMILY_POLICY_ID, 1) => {
            let mut models = OPENAI_API_DEFAULT_FAMILY_V1_MODELS
                .iter()
                .filter_map(|model_id| {
                    snapshot
                        .models
                        .iter()
                        .find(|model| model.visible && model.available && model.id == *model_id)
                })
                .collect::<Vec<_>>();
            let mut remaining = snapshot
                .models
                .iter()
                .filter(|model| {
                    model.visible
                        && model.available
                        && !models.iter().any(|selected| selected.id == model.id)
                })
                .collect::<Vec<_>>();
            remaining.sort_by_key(|model| (!model.provider_default, model.order));
            models.extend(remaining);
            Ok(models
                .into_iter()
                .take(super::catalog::MAX_MODELS_PER_FAMILY)
                .enumerate()
                .map(|(position, model)| ModelFamilyMember {
                    roles: Vec::new(),
                    provider_id: snapshot.provider_id.clone(),
                    model_id: model.id.clone(),
                    position,
                })
                .collect())
        }
        (OPENROUTER_DEFAULT_FAMILY_POLICY_ID, 1) => Ok(OPENROUTER_DEFAULT_FAMILY_V1_MODELS
            .iter()
            .filter_map(|model_id| {
                snapshot
                    .models
                    .iter()
                    .find(|model| model.visible && model.available && model.id == *model_id)
            })
            .enumerate()
            .map(|(position, model)| ModelFamilyMember {
                roles: Vec::new(),
                provider_id: snapshot.provider_id.clone(),
                model_id: model.id.clone(),
                position,
            })
            .collect()),
        (PRIME_DEFAULT_FAMILY_POLICY_ID, 1) => Ok(PRIME_DEFAULT_FAMILY_V1_MODELS
            .iter()
            .filter_map(|model_id| {
                snapshot
                    .models
                    .iter()
                    .find(|model| model.visible && model.available && model.id == *model_id)
            })
            .enumerate()
            .map(|(position, model)| ModelFamilyMember {
                roles: Vec::new(),
                provider_id: snapshot.provider_id.clone(),
                model_id: model.id.clone(),
                position,
            })
            .collect()),
        (VERCEL_AI_ROUTER_DEFAULT_FAMILY_POLICY_ID, 1) => {
            Ok(VERCEL_AI_ROUTER_DEFAULT_FAMILY_V1_MODELS
                .iter()
                .filter_map(|model_id| {
                    snapshot
                        .models
                        .iter()
                        .find(|model| model.visible && model.available && model.id == *model_id)
                })
                .enumerate()
                .map(|(position, model)| ModelFamilyMember {
                    roles: Vec::new(),
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
    fn production_policies_prefer_sol_and_each_router_qwen_identity() {
        let codex = FamilyPolicyReference {
            id: CODEX_DEFAULT_FAMILY_POLICY_ID.into(),
            version: 3,
        };
        let members = derive_managed_family_members(
            &codex,
            &snapshot(vec![
                model("gpt-6-luna", 0, true, false),
                model("gpt-6-astra", 1, true, true),
                model("gpt-6-sol", 2, true, false),
            ]),
        )
        .unwrap();
        assert_eq!(
            members
                .iter()
                .map(|m| m.model_id.as_str())
                .collect::<Vec<_>>(),
            vec!["gpt-6-sol", "gpt-6-astra", "gpt-6-luna"]
        );
        let prime = FamilyPolicyReference {
            id: PRIME_DEFAULT_FAMILY_POLICY_ID.into(),
            version: 1,
        };
        for (adapter, qwen, glm) in [
            ("openrouter", "qwen/qwen3.8-max", "z-ai/glm-5.3"),
            ("vercel-ai-router", "alibaba/qwen3.8-max", "zai/glm-5.3"),
        ] {
            assert!(applies_to_adapter(&prime, adapter));
            let mut catalog = snapshot(vec![
                model("deepseek/deepseek-v4-pro-0813", 0, true, true),
                model(qwen, 2, true, false),
                model(glm, 1, true, false),
                model("arbitrary", 3, true, true),
            ]);
            let members = derive_managed_family_members(&prime, &catalog).unwrap();
            assert_eq!(
                members
                    .iter()
                    .map(|m| m.model_id.as_str())
                    .collect::<Vec<_>>(),
                vec![qwen, "deepseek/deepseek-v4-pro-0813", glm]
            );
            catalog.models[1].available = false;
            assert_eq!(
                derive_managed_family_members(&prime, &catalog).unwrap()[0].model_id,
                "deepseek/deepseek-v4-pro-0813"
            );
        }
        assert!(!applies_to_adapter(&prime, "openai-api"));
        assert!(!applies_to_adapter(&prime, "codex-subscription"));
    }

    #[test]
    fn codex_policy_v4_prefers_6_1_sol_without_inventing_catalog_members() {
        let policy = FamilyPolicyReference {
            id: CODEX_DEFAULT_FAMILY_POLICY_ID.into(),
            version: 4,
        };
        for (sol_visible, expected) in [
            (
                true,
                vec!["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna", "gpt-6-sol"],
            ),
            (false, vec!["gpt-6-astra", "gpt-6-luna", "gpt-6-sol"]),
        ] {
            let members = derive_managed_family_members(
                &policy,
                &snapshot(vec![
                    model("gpt-6-sol", 0, true, true),
                    model("gpt-6-astra", 1, true, true),
                    model("gpt-6-luna", 2, true, false),
                    model("gpt-6.1-sol", 3, sol_visible, false),
                ]),
            )
            .unwrap();
            assert_eq!(
                members
                    .iter()
                    .map(|m| m.model_id.as_str())
                    .collect::<Vec<_>>(),
                expected
            );
            assert_eq!(
                members.iter().map(|m| m.position).collect::<Vec<_>>(),
                (0..members.len()).collect::<Vec<_>>()
            );
        }
        let members = derive_managed_family_members(
            &policy,
            &snapshot(vec![model("gpt-6-astra", 0, true, true)]),
        )
        .unwrap();
        assert_eq!(
            members
                .iter()
                .map(|m| m.model_id.as_str())
                .collect::<Vec<_>>(),
            vec!["gpt-6-astra"]
        );
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
    fn codex_policy_v2_leads_with_the_5_6_family_then_keeps_provider_defaults() {
        let members = derive_managed_family_members(
            &FamilyPolicyReference {
                id: CODEX_DEFAULT_FAMILY_POLICY_ID.into(),
                version: 2,
            },
            &snapshot(vec![
                model("gpt-5.6-luna", 0, true, false),
                model("gpt-5.5", 1, true, true),
                model("gpt-5.6-sol", 2, true, false),
                model("gpt-5.6-terra", 3, true, false),
                model("gpt-5.4", 4, true, true),
            ]),
        )
        .unwrap();

        assert_eq!(
            members
                .iter()
                .map(|member| member.model_id.as_str())
                .collect::<Vec<_>>(),
            vec![
                "gpt-5.6-sol",
                "gpt-5.6-terra",
                "gpt-5.6-luna",
                "gpt-5.5",
                "gpt-5.4"
            ]
        );
        assert_eq!(
            members
                .iter()
                .map(|member| member.position)
                .collect::<Vec<_>>(),
            vec![0, 1, 2, 3, 4]
        );
    }

    #[test]
    fn codex_policy_v2_omits_hidden_or_missing_family_members() {
        let members = derive_managed_family_members(
            &FamilyPolicyReference {
                id: CODEX_DEFAULT_FAMILY_POLICY_ID.into(),
                version: 2,
            },
            &snapshot(vec![
                model("gpt-5.6-sol", 0, true, false),
                model("gpt-5.6-terra", 1, false, false),
            ]),
        )
        .unwrap();

        assert_eq!(
            members
                .iter()
                .map(|member| member.model_id.as_str())
                .collect::<Vec<_>>(),
            vec!["gpt-5.6-sol"]
        );
    }

    #[test]
    fn provider_policy_prefers_the_reviewed_openai_agent_family_over_legacy_catalog_order() {
        let members = derive_managed_family_members(
            &FamilyPolicyReference {
                id: PROVIDER_DEFAULT_FAMILY_POLICY_ID.into(),
                version: 1,
            },
            &snapshot(vec![
                model("gpt-3.5-turbo", 0, true, false),
                model("gpt-5.4", 110, true, false),
                model("gpt-5.6-luna", 127, true, false),
                model("gpt-5.5", 117, true, false),
                model("gpt-5.6-sol", 125, true, false),
                model("gpt-5.6-terra", 126, true, false),
            ]),
        )
        .unwrap();

        assert_eq!(
            members
                .iter()
                .map(|member| member.model_id.as_str())
                .collect::<Vec<_>>(),
            vec![
                "gpt-5.6-sol",
                "gpt-5.6-terra",
                "gpt-5.6-luna",
                "gpt-5.5",
                "gpt-5.4"
            ]
        );
    }

    #[test]
    fn openrouter_policy_uses_only_the_reviewed_latest_general_models() {
        let members = derive_managed_family_members(
            &FamilyPolicyReference {
                id: OPENROUTER_DEFAULT_FAMILY_POLICY_ID.into(),
                version: 1,
            },
            &snapshot(vec![
                model("tencent/hy4-preview", 0, true, true),
                model("qwen/qwen3.8-flash", 1, true, true),
                model("deepseek/deepseek-v4-pro-0813", 2, true, false),
                model("z-ai/glm-5.3", 3, true, false),
                model("qwen/qwen3.8-max", 4, true, false),
                model("z-ai/glm-5.3-flash", 5, true, true),
                model("deepseek/deepseek-v4-flash-vision-exp", 6, true, true),
            ]),
        )
        .unwrap();

        assert_eq!(
            members
                .iter()
                .map(|member| member.model_id.as_str())
                .collect::<Vec<_>>(),
            vec![
                "deepseek/deepseek-v4-pro-0813",
                "qwen/qwen3.8-max",
                "z-ai/glm-5.3"
            ]
        );
    }

    #[test]
    fn vercel_router_policy_uses_equivalent_reviewed_latest_general_models() {
        let members = derive_managed_family_members(
            &FamilyPolicyReference {
                id: VERCEL_AI_ROUTER_DEFAULT_FAMILY_POLICY_ID.into(),
                version: 1,
            },
            &snapshot(vec![
                model("openai/gpt-5.4", 0, true, true),
                model("alibaba/qwen3.8-flash", 1, true, true),
                model("deepseek/deepseek-v4-pro-0813", 2, true, false),
                model("zai/glm-5.3", 3, true, false),
                model("alibaba/qwen3.8-max", 4, true, false),
                model("zai/glm-5.3-flash", 5, true, true),
            ]),
        )
        .unwrap();

        assert_eq!(
            members
                .iter()
                .map(|member| member.model_id.as_str())
                .collect::<Vec<_>>(),
            vec![
                "deepseek/deepseek-v4-pro-0813",
                "alibaba/qwen3.8-max",
                "zai/glm-5.3"
            ]
        );
    }

    #[test]
    fn every_api_adapter_has_a_versioned_fail_closed_fallback_policy() {
        for adapter_id in ["openai-api", "anthropic-api"] {
            let policy = fallback_for_adapter(adapter_id).expect("API adapter fallback policy");
            assert_eq!(policy.id, PROVIDER_DEFAULT_FAMILY_POLICY_ID);
            assert_eq!(policy.version, 1);
            assert!(applies_to_adapter(&policy, adapter_id));
        }
        let openrouter = fallback_for_adapter("openrouter").expect("OpenRouter fallback policy");
        assert_eq!(openrouter.id, PRIME_DEFAULT_FAMILY_POLICY_ID);
        assert_eq!(openrouter.version, 1);
        assert!(applies_to_adapter(&openrouter, "openrouter"));
        let vercel = fallback_for_adapter("vercel-ai-router").expect("Vercel fallback policy");
        assert_eq!(vercel.id, PRIME_DEFAULT_FAMILY_POLICY_ID);
        assert_eq!(vercel.version, 1);
        assert!(applies_to_adapter(&vercel, "vercel-ai-router"));
        assert!(!applies_to_adapter(
            &FamilyPolicyReference {
                id: PROVIDER_DEFAULT_FAMILY_POLICY_ID.into(),
                version: 1,
            },
            "openrouter"
        ));
        assert!(fallback_for_adapter("codex-subscription").is_none());
        assert!(fallback_for_adapter("claude-subscription").is_none());
    }

    #[test]
    fn claude_policy_uses_all_visible_aliases_in_provider_order() {
        let policy = FamilyPolicyReference {
            id: CLAUDE_DEFAULT_FAMILY_POLICY_ID.into(),
            version: 1,
        };
        assert!(applies_to_adapter(&policy, "claude-subscription"));
        assert!(!applies_to_adapter(&policy, "anthropic-api"));

        let mut unavailable = model("unavailable", 0, true, true);
        unavailable.available = false;

        let members = derive_managed_family_members(
            &policy,
            &snapshot(vec![
                model("opus", 1, true, false),
                model("sonnet", 0, true, true),
                model("fable", 3, true, false),
                model("hidden", 4, false, true),
                unavailable,
            ]),
        )
        .unwrap();

        assert_eq!(
            members
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
