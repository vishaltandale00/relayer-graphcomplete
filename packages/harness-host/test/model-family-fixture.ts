import type { HarnessAdmittedModelRoute, HarnessRunContext } from "../src/types.js";

/** Exact identities deliberately share adapter/model IDs across distinct connections. */
export function withFamilyRoles(context: HarnessRunContext): HarnessRunContext {
  const access = context.access!;
  const route = { roles: [{ name: "orchestrator" }, { name: "coding", description: "Implementation and debugging" }],
    providerId: access.providerId, adapterId: access.adapterId, accessContract: access.contract,
    modelId: context.model!.modelId, adapterImplementationVersion: access.adapterImplementationVersion };
  const specialistModel = access.adapterId === "claude-subscription" ? "opus"
    : access.adapterId === "anthropic-api" ? "claude-opus-5-5" : "gpt-5.6-luna";
  const specialist = { ...route, modelId: specialistModel, roles: [{ name: "review", description: "Check evidence ``` <data>" }] };
  const foreign = { ...route, providerId: "other-connection", roles: [] };
  return { ...context, modelPlan: { schemaVersion: 2, familyId: 17, familyRevision: 4,
    orchestrator: route, roster: [specialist, route, foreign], harnessPolicyDigest: "sha256:fixture-policy", digest: "sha256:fixture-plan" },
    accessBundle: { byProviderId: { [access.providerId]: access,
      [foreign.providerId]: { ...access, providerId: foreign.providerId,
        ...(access.kind === "secret" ? { endpoint: "https://foreign.test/v1", fields: { "api-key": "foreign-secret" } } : {}) },
    } },
  };
}

type FamilyMetadataRoute = HarnessAdmittedModelRoute & { native: { selector?: string; routing: string } };
interface FamilyMetadata {
  readonly orchestrator: FamilyMetadataRoute;
  readonly roster: readonly FamilyMetadataRoute[];
}

export function familyData(prompt: string): FamilyMetadata {
  const block = prompt.split("Admitted model family (frozen for this execution):")[1]?.match(/```json\n([\s\S]*?)\n```/u)?.[1];
  if (!block) throw new Error("Native input omitted admitted family data");
  return JSON.parse(block) as FamilyMetadata;
}
