import { readdir, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

const PROVIDER_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

function managedRuntimeEligibility(registry, definition) {
  try {
    const descriptor = registry.get(definition?.adapterId);
    return descriptor.accessContract === "managed-runtime@1"
      && definition?.accessContract === descriptor.accessContract;
  } catch {
    return null;
  }
}

export function providerRuntimeDirectory(runtimeRoot, definition, registry) {
  if (managedRuntimeEligibility(registry, definition) !== true) return null;
  if (typeof definition?.id !== "string" || !PROVIDER_ID.test(definition.id)) {
    throw new Error("Managed provider runtime cleanup requires a stable provider definition id.");
  }
  const root = resolve(runtimeRoot);
  const target = resolve(root, definition.id);
  const child = relative(root, target);
  if (child === "" || child.startsWith("..") || isAbsolute(child)) {
    throw new Error("Managed provider runtime directory must be an exact child of the runtime root.");
  }
  return target;
}

export function createProviderRuntimeStateRemover({ runtimeRoot, registry, remove = rm, list = readdir }) {
  if (!registry || typeof registry.get !== "function") {
    throw new Error("Managed provider runtime cleanup requires the authoritative provider adapter registry.");
  }
  const remover = async (definition) => {
    const target = providerRuntimeDirectory(runtimeRoot, definition, registry);
    if (target === null) return false;
    await remove(target, { recursive: true, force: true });
    return true;
  };
  remover.reconcile = async (definitions) => {
    const retained = new Set(definitions.flatMap((definition) => {
      if (definition.lifecycleState === "tombstoned") return [];
      const eligibility = managedRuntimeEligibility(registry, definition);
      // Preserve state owned by an adapter missing from this build. A later build may restore it.
      return eligibility === true || eligibility === null ? [definition.id] : [];
    }));
    let entries;
    try {
      entries = await list(resolve(runtimeRoot), { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const removed = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !PROVIDER_ID.test(entry.name) || retained.has(entry.name)) continue;
      const target = resolve(runtimeRoot, entry.name);
      const child = relative(resolve(runtimeRoot), target);
      if (child !== entry.name || isAbsolute(child)) continue;
      await remove(target, { recursive: true, force: true });
      removed.push(entry.name);
    }
    return removed;
  };
  return remover;
}
