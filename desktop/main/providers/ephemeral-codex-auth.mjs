import { readdir, readFile, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

const PROVIDER_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

// Matches the ephemeral file written by codex.basic for secret adapters.
// Subscription sessions (legacy userData/codex-home and isolated Codex
// connections) use a different shape and must not be deleted.
export function isEphemeralCodexApiKeyAuth(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return value.auth_mode === "apikey" && typeof value.OPENAI_API_KEY === "string";
}

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
    const authPath = join(target, "codex-home", "auth.json");
    try {
      let parsed;
      try {
        parsed = JSON.parse(await readFile(authPath, "utf8"));
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        continue;
      }
      if (!isEphemeralCodexApiKeyAuth(parsed)) continue;
      await unlink(authPath);
      removed.push(entry.name);
    } catch (error) {
      failures.push({ providerId: entry.name, error });
    }
  }
  return { removed, failures };
}
