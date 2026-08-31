import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import type {
  HarnessConfiguration,
  GraphCapabilityProfile,
  HarnessModelCompatibility,
  HarnessModelRule,
  HarnessModelRules,
  InteractionModelSelection,
  JsonObject,
  JsonValue,
} from "./types.js";

export async function loadHarnessConfiguration(path: string): Promise<HarnessConfiguration> {
  return parseHarnessConfiguration(parse(await readFile(path, "utf8")));
}

export async function loadHarnessConfigurations(paths: readonly string[]): Promise<ReadonlyMap<string, HarnessConfiguration>> {
  const configurations = await Promise.all(paths.map(loadHarnessConfiguration));
  const catalog = new Map<string, HarnessConfiguration>();
  for (const configuration of configurations) {
    if (catalog.has(configuration.name)) throw new Error(`Duplicate harness configuration name: ${configuration.name}`);
    catalog.set(configuration.name, configuration);
  }
  return catalog;
}

export function parseHarnessConfiguration(value: unknown): HarnessConfiguration {
  if (!isRecord(value)) throw new Error("Harness configuration must be an object");
  const {
    schemaVersion,
    name,
    implementation,
    implementationVersion,
    revision,
    permissionBindings,
    modelCompatibility,
    modelRules,
    executionAccessContracts,
    modelDefaults,
    complete,
    graphCapabilityProfile,
    settings,
  } = value;
  if (schemaVersion !== 1) throw new Error(`Unsupported harness configuration schema version: ${String(schemaVersion)}`);
  if (!isIdentifier(name)) throw new Error("Harness configuration name must be a non-empty machine identifier");
  if (!isIdentifier(implementation)) throw new Error("Harness implementation must be a non-empty machine identifier");
  if (typeof implementationVersion !== "number" || !Number.isSafeInteger(implementationVersion) || implementationVersion < 1) {
    throw new Error("Harness implementation version must be a positive integer");
  }
  if (revision !== undefined && (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1)) {
    throw new Error("Harness configuration revision must be a positive integer");
  }
  if (!isRecord(permissionBindings) || Object.keys(permissionBindings).length === 0) {
    throw new Error("Harness permissionBindings must be a non-empty object");
  }
  const parsedBindings = Object.fromEntries(Object.entries(permissionBindings).map(([profileId, binding]) => {
    if (!isIdentifier(profileId)) throw new Error(`Invalid harness permission profile ID: ${profileId}`);
    if (!isJsonObject(binding)) throw new Error(`Harness permission binding ${profileId} must be a JSON object`);
    return [profileId, binding];
  }));
  const parsedModelCompatibility = parseModelCompatibility(modelCompatibility);
  const parsedModelRules = parseModelRules(modelRules);
  const parsedAccessContracts = parseAccessContracts(executionAccessContracts);
  if ((parsedModelRules !== undefined || parsedModelCompatibility !== undefined)
    && parsedAccessContracts === undefined) {
    throw new Error("Model-selecting harness configurations require executionAccessContracts so a selected provider cannot fall back to ambient credentials");
  }
  const parsedModelDefaults = parseModelDefaults(modelDefaults);
  const parsedComplete = parseCompleteConfiguration(complete);
  const parsedGraphCapabilityProfile = parseGraphCapabilityProfile(graphCapabilityProfile);
  if (!isJsonObject(settings)) throw new Error("Harness implementation settings must be a JSON object");
  return {
    schemaVersion,
    name,
    implementation,
    implementationVersion,
    ...(revision === undefined ? {} : { revision }),
    permissionBindings: parsedBindings,
    ...(parsedModelCompatibility ? { modelCompatibility: parsedModelCompatibility } : {}),
    ...(parsedModelRules ? { modelRules: parsedModelRules } : {}),
    ...(parsedAccessContracts ? { executionAccessContracts: parsedAccessContracts } : {}),
    ...(parsedModelDefaults ? { modelDefaults: parsedModelDefaults } : {}),
    ...(parsedComplete ? { complete: parsedComplete } : {}),
    ...(parsedGraphCapabilityProfile ? { graphCapabilityProfile: parsedGraphCapabilityProfile } : {}),
    settings,
  };
}

function parseCompleteConfiguration(value: unknown): HarnessConfiguration["complete"] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)
    || Object.keys(value).length !== 1
    || Object.keys(value)[0] !== "agentAuthored"
    || typeof value.agentAuthored !== "boolean") {
    throw new Error("Harness complete must contain only a boolean agentAuthored field");
  }
  return { agentAuthored: value.agentAuthored };
}

function parseGraphCapabilityProfile(value: unknown): GraphCapabilityProfile | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("Harness graphCapabilityProfile must be an object");
  for (const key of Object.keys(value)) {
    if (key !== "search") throw new Error(`Unknown graphCapabilityProfile field: ${key}`);
  }
  if (value.search !== "disabled" && value.search !== "query-v1") {
    throw new Error("Harness graphCapabilityProfile.search must be disabled or query-v1");
  }
  return { search: value.search };
}

export function resolveGraphCapabilityProfile(configuration: HarnessConfiguration): GraphCapabilityProfile {
  return configuration.graphCapabilityProfile ?? { search: "disabled" };
}

function parseModelRules(value: unknown): HarnessModelRules | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("Harness modelRules must be an object");
  for (const key of Object.keys(value)) {
    if (key !== "allow" && key !== "deny") throw new Error(`Unknown harness modelRules field: ${key}`);
  }
  return {
    allow: parseRuleList(value.allow, "allow"),
    deny: parseRuleList(value.deny, "deny"),
  };
}

function parseRuleList(value: unknown, list: "allow" | "deny"): readonly HarnessModelRule[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`Harness modelRules.${list} must be an array`);
  return value.map((entry, index) => {
    const path = `Harness modelRules.${list}[${index}]`;
    if (!isRecord(entry) || !isIdentifier(entry.adapterId)) {
      throw new Error(`${path}.adapterId must be a machine identifier`);
    }
    for (const key of Object.keys(entry)) {
      if (key !== "adapterId" && key !== "modelIdExact" && key !== "modelIdRegex") {
        throw new Error(`Unknown ${path} field: ${key}`);
      }
    }
    const hasExact = entry.modelIdExact !== undefined;
    const hasRegex = entry.modelIdRegex !== undefined;
    if (hasExact === hasRegex) {
      throw new Error(`${path} must contain exactly one of modelIdExact or modelIdRegex`);
    }
    if (hasExact && !isStableModelId(entry.modelIdExact)) {
      throw new Error(`${path}.modelIdExact must be a model ID`);
    }
    if (hasRegex) validateModelIdRegex(entry.modelIdRegex, path);
    return {
      adapterId: entry.adapterId,
      ...(hasExact ? { modelIdExact: entry.modelIdExact as string } : {}),
      ...(hasRegex ? { modelIdRegex: entry.modelIdRegex as string } : {}),
    };
  });
}

function validateModelIdRegex(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 500) {
    throw new Error(`${path}.modelIdRegex must be a non-empty regex of at most 500 characters`);
  }
  // Harness rules are evaluated independently by the trusted Rust product and the
  // JavaScript host. Keep the accepted syntax to their common, deterministic subset.
  // In particular, JavaScript lookarounds/named groups and engine-specific escapes
  // must never be admitted by only one boundary.
  if (value.includes("(?") || /\\\\(?:[1-9]|k|A|z|Z|G)/u.test(value)) {
    throw new Error(`${path}.modelIdRegex uses syntax outside the supported cross-runtime subset`);
  }
  try {
    new RegExp(value, "u");
  } catch (error) {
    throw new Error(`${path}.modelIdRegex is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseAccessContracts(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || !value.every((entry) => (
    typeof entry === "string" && /^[a-z0-9][a-z0-9._-]*@[1-9][0-9]*$/i.test(entry)
  ))) {
    throw new Error("Harness executionAccessContracts must be versioned identifiers such as secret@1");
  }
  if (new Set(value).size !== value.length) throw new Error("Harness executionAccessContracts contains a duplicate");
  return [...value] as string[];
}

function parseModelDefaults(value: unknown): HarnessConfiguration["modelDefaults"] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !isRecord(value.familyPolicy)) {
    throw new Error("Harness modelDefaults.familyPolicy must be an object");
  }
  const { id, version } = value.familyPolicy;
  if (!isIdentifier(id) || typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
    throw new Error("Harness modelDefaults.familyPolicy requires an identifier and positive integer version");
  }
  return { familyPolicy: { id, version } };
}

export function harnessAllowsModel(
  rules: HarnessModelRules | undefined,
  selection: Pick<InteractionModelSelection, "adapterId" | "modelId">,
): boolean {
  if (rules === undefined) return true;
  if (selection.adapterId === undefined) return false;
  if (rules.deny.some((rule) => ruleMatches(rule, selection.adapterId!, selection.modelId))) return false;
  return rules.allow.length === 0
    || rules.allow.some((rule) => ruleMatches(rule, selection.adapterId!, selection.modelId));
}

/** Common, pinned authority for exposing agent-authored complete(inputGraph). */
export function harnessAllowsAgentAuthoredComplete(configuration: HarnessConfiguration): boolean {
  return configuration.complete?.agentAuthored === true;
}

function ruleMatches(rule: HarnessModelRule, adapterId: string, modelId: string): boolean {
  if (rule.adapterId !== adapterId) return false;
  if (rule.modelIdExact !== undefined) return rule.modelIdExact === modelId;
  return new RegExp(rule.modelIdRegex!, "u").test(modelId);
}

function parseModelCompatibility(value: unknown): readonly HarnessModelCompatibility[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Harness modelCompatibility must be a non-empty array");
  }
  const providers = new Set<string>();
  return value.map((entry, index) => {
    if (!isRecord(entry) || !isIdentifier(entry.providerId)) {
      throw new Error(`Harness modelCompatibility[${index}].providerId must be a machine identifier`);
    }
    if (providers.has(entry.providerId)) throw new Error(`Duplicate harness model provider: ${entry.providerId}`);
    providers.add(entry.providerId);
    let modelIds: readonly string[] | undefined;
    if (entry.modelIds !== undefined) {
      if (!Array.isArray(entry.modelIds) || entry.modelIds.length === 0 || !entry.modelIds.every(isStableModelId)) {
        throw new Error(`Harness modelCompatibility[${index}].modelIds must be a non-empty model ID array`);
      }
      modelIds = [...new Set(entry.modelIds as string[])];
      if (modelIds.length !== entry.modelIds.length) {
        throw new Error(`Harness modelCompatibility[${index}].modelIds contains a duplicate`);
      }
    }
    const preferredModelId = entry.preferredModelId;
    if (preferredModelId !== undefined && !isStableModelId(preferredModelId)) {
      throw new Error(`Harness modelCompatibility[${index}].preferredModelId must be a model ID`);
    }
    if (preferredModelId !== undefined && modelIds && !modelIds.includes(preferredModelId)) {
      throw new Error(`Harness modelCompatibility[${index}].preferredModelId must be allowed`);
    }
    return {
      providerId: entry.providerId,
      ...(modelIds ? { modelIds } : {}),
      ...(preferredModelId ? { preferredModelId } : {}),
    };
  });
}

export function sameHarnessConfiguration(left: HarnessConfiguration, right: HarnessConfiguration): boolean {
  return canonicalHarnessJson(left) === canonicalHarnessJson(right);
}

/**
 * Compares the configuration that owns provider session execution. Catalog-only
 * model compatibility may be added or refreshed without invalidating a saved
 * provider session; the current descriptor is persisted after it is resumed.
 */
export function sameHarnessExecutionConfiguration(
  left: HarnessConfiguration,
  right: HarnessConfiguration,
): boolean {
  const {
    revision: _leftRevision,
    modelCompatibility: _leftModelCompatibility,
    modelRules: _leftModelRules,
    modelDefaults: _leftModelDefaults,
    ...leftExecution
  } = left;
  const {
    revision: _rightRevision,
    modelCompatibility: _rightModelCompatibility,
    modelRules: _rightModelRules,
    modelDefaults: _rightModelDefaults,
    ...rightExecution
  } = right;
  return canonicalJson({
    ...leftExecution,
    graphCapabilityProfile: resolveGraphCapabilityProfile(left),
  }) === canonicalJson({
    ...rightExecution,
    graphCapabilityProfile: resolveGraphCapabilityProfile(right),
  });
}

export function digestHarnessConfiguration(configuration: HarnessConfiguration): string {
  return `sha256:${createHash("sha256").update(canonicalHarnessJson(configuration)).digest("hex")}`;
}

function canonicalHarnessJson(configuration: HarnessConfiguration): string {
  return canonicalJson({
    ...configuration,
    graphCapabilityProfile: resolveGraphCapabilityProfile(configuration),
  });
}

function canonicalJson(value: JsonValue | HarnessConfiguration): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: JsonValue | HarnessConfiguration): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key] as JsonValue)]));
  }
  return value as JsonValue;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]*$/i.test(value);
}

function isStableModelId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const characters = [...value];
  return characters.length > 0
    && characters.length <= 200
    && !/\p{White_Space}/u.test(characters[0]!)
    && !/\p{White_Space}/u.test(characters.at(-1)!)
    && !characters.some((character) => character.length === 1 && /[\uD800-\uDFFF]/u.test(character))
    && !characters.some((character) => /\p{Cc}/u.test(character));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value);
}
