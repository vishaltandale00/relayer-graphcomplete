import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import type { HarnessConfiguration, HarnessModelCompatibility, JsonObject, JsonValue } from "./types.js";

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
  const { schemaVersion, name, implementation, implementationVersion, permissionBindings, modelCompatibility, settings } = value;
  if (schemaVersion !== 1) throw new Error(`Unsupported harness configuration schema version: ${String(schemaVersion)}`);
  if (!isIdentifier(name)) throw new Error("Harness configuration name must be a non-empty machine identifier");
  if (!isIdentifier(implementation)) throw new Error("Harness implementation must be a non-empty machine identifier");
  if (typeof implementationVersion !== "number" || !Number.isSafeInteger(implementationVersion) || implementationVersion < 1) {
    throw new Error("Harness implementation version must be a positive integer");
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
  if (!isJsonObject(settings)) throw new Error("Harness implementation settings must be a JSON object");
  return {
    schemaVersion,
    name,
    implementation,
    implementationVersion,
    permissionBindings: parsedBindings,
    ...(parsedModelCompatibility ? { modelCompatibility: parsedModelCompatibility } : {}),
    settings,
  };
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
      if (!Array.isArray(entry.modelIds) || entry.modelIds.length === 0 || !entry.modelIds.every(isIdentifier)) {
        throw new Error(`Harness modelCompatibility[${index}].modelIds must be a non-empty model ID array`);
      }
      modelIds = [...new Set(entry.modelIds as string[])];
      if (modelIds.length !== entry.modelIds.length) {
        throw new Error(`Harness modelCompatibility[${index}].modelIds contains a duplicate`);
      }
    }
    const preferredModelId = entry.preferredModelId;
    if (preferredModelId !== undefined && !isIdentifier(preferredModelId)) {
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
  return canonicalJson(left) === canonicalJson(right);
}

export function digestHarnessConfiguration(configuration: HarnessConfiguration): string {
  return `sha256:${createHash("sha256").update(canonicalJson(configuration)).digest("hex")}`;
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
