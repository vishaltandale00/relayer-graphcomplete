import { readdir, readFile, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

const PROVIDER_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

// codex.basic once wrote the API key to `.auth.json.<uuid>.tmp` and renamed it
// onto auth.json. It now writes neither: Codex reads the key from the turn's
// environment. This sweep stays as a cheap guard, because such a file would
// hold a plaintext key inside a provider's codex-home.
const CODEX_API_KEY_AUTH_TEMPORARY = /^\.auth\.json\..+\.tmp$/;

// Matches the ephemeral file codex.basic once wrote for secret adapters.
// Subscription sessions (legacy userData/codex-home and isolated Codex
// connections) use a different shape and must not be deleted.
export function isEphemeralCodexApiKeyAuth(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return value.auth_mode === "apikey" && typeof value.OPENAI_API_KEY === "string";
}

// Returns whether the leftover was removed. A missing, unreadable or
// non-API-key auth.json is left in place.
async function removeLeftoverAuthFile(authPath) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(authPath, "utf8"));
  } catch {
    return false;
  }
  if (!isEphemeralCodexApiKeyAuth(parsed)) return false;
  await unlink(authPath);
  return true;
}

// A temporary file that does not parse is a secret write a crash cut short, so
// it is removed too. One that parses to another shape is left in place.
async function removeLeftoverAuthTemporary(temporaryPath) {
  let text;
  try {
    text = await readFile(temporaryPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (parsed !== undefined && !isEphemeralCodexApiKeyAuth(parsed)) return false;
  try {
    await unlink(temporaryPath);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  return true;
}

async function leftoverAuthTemporaries(codexHome) {
  let entries;
  try {
    entries = await readdir(codexHome, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && CODEX_API_KEY_AUTH_TEMPORARY.test(entry.name))
    .map((entry) => join(codexHome, entry.name));
}

// A secret Codex turn killed by SIGKILL, in a build that wrote the key file,
// could leave the API key in plaintext, either in codex-home/auth.json or in a
// temporary file written before its rename.
// `removed` lists each provider with at least one removed leftover; `failures`
// lists each leftover that could not be checked or removed.
export async function removeLeftoverEphemeralCodexAuthFiles(runtimeRoot) {
  const root = resolve(runtimeRoot);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { removed: [], failures: [] };
    throw error;
  }

  const removed = [];
  const failures = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !PROVIDER_ID.test(entry.name)) continue;
    const target = resolve(root, entry.name);
    const child = relative(root, target);
    if (child !== entry.name || isAbsolute(child)) continue;
    const codexHome = join(target, "codex-home");
    let removedAny = false;
    const authPath = join(codexHome, "auth.json");
    try {
      if (await removeLeftoverAuthFile(authPath)) removedAny = true;
    } catch (error) {
      failures.push({ providerId: entry.name, path: authPath, error });
    }
    let temporaries = [];
    try {
      temporaries = await leftoverAuthTemporaries(codexHome);
    } catch (error) {
      failures.push({ providerId: entry.name, path: codexHome, error });
    }
    for (const temporaryPath of temporaries) {
      try {
        if (await removeLeftoverAuthTemporary(temporaryPath)) removedAny = true;
      } catch (error) {
        failures.push({ providerId: entry.name, path: temporaryPath, error });
      }
    }
    if (removedAny) removed.push(entry.name);
  }
  return { removed, failures };
}
