import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  isEphemeralCodexApiKeyAuth,
  removeLeftoverEphemeralCodexAuthFiles,
} from "../desktop/main/providers/ephemeral-codex-auth.mjs";

const directories = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("leftover ephemeral Codex API-key auth", () => {
  it("recognizes the secret-turn auth shape and removes only isolated provider-home leftovers", async () => {
    expect(isEphemeralCodexApiKeyAuth({ auth_mode: "apikey", OPENAI_API_KEY: "sk-test" }), "secret-turn shape").toBe(true);
    expect(isEphemeralCodexApiKeyAuth({ tokens: { access_token: "session" } }), "subscription tokens").toBe(false);
    expect(isEphemeralCodexApiKeyAuth({ auth_mode: "chatgpt", OPENAI_API_KEY: "sk-test" }), "chatgpt mode").toBe(false);
    expect(isEphemeralCodexApiKeyAuth("legacy-session"), "legacy string session").toBe(false);

    const profile = await mkdtemp(join(tmpdir(), "relayer-ephemeral-auth-"));
    directories.push(profile);
    const runtimeRoot = join(profile, "provider-runtimes");
    const legacyHome = join(profile, "codex-home");
    const openaiHome = join(runtimeRoot, "openai-api", "codex-home");
    const openrouterHome = join(runtimeRoot, "openrouter", "codex-home");
    const subscriptionHome = join(runtimeRoot, "new-codex-connection", "codex-home");
    await mkdir(legacyHome, { recursive: true });
    await mkdir(openaiHome, { recursive: true });
    await mkdir(openrouterHome, { recursive: true });
    await mkdir(subscriptionHome, { recursive: true });
    await writeFile(join(legacyHome, "auth.json"), JSON.stringify({
      auth_mode: "apikey",
      OPENAI_API_KEY: "must-not-touch-legacy",
    }));
    await writeFile(join(openaiHome, "auth.json"), `${JSON.stringify({
      auth_mode: "apikey",
      OPENAI_API_KEY: "openai-leftover",
    })}\n`);
    await writeFile(join(openrouterHome, "auth.json"), JSON.stringify({
      auth_mode: "apikey",
      OPENAI_API_KEY: "openrouter-leftover",
    }));
    await writeFile(join(subscriptionHome, "auth.json"), JSON.stringify({
      tokens: { access_token: "isolated-subscription" },
    }));
    await writeFile(join(runtimeRoot, "openai-api", "unrelated.json"), "keep");

    const result = await removeLeftoverEphemeralCodexAuthFiles(runtimeRoot);
    expect(result.failures, "no removal failures").toEqual([]);
    expect([...result.removed].sort(), "removed isolated provider homes").toEqual(["openai-api", "openrouter"]);

    await expect(readFile(join(openaiHome, "auth.json"), "utf8"), "openai leftover removed").rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(openrouterHome, "auth.json"), "utf8"), "openrouter leftover removed").rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(legacyHome, "auth.json"), "utf8"), "legacy home untouched").resolves.toContain("must-not-touch-legacy");
    await expect(readFile(join(subscriptionHome, "auth.json"), "utf8"), "subscription session untouched").resolves.toContain("isolated-subscription");
    await expect(readFile(join(runtimeRoot, "openai-api", "unrelated.json"), "utf8"), "unrelated files untouched").resolves.toBe("keep");

    await expect(
      removeLeftoverEphemeralCodexAuthFiles(join(tmpdir(), "relayer-missing-provider-runtimes")),
      "missing provider-runtime root is already clean",
    ).resolves.toEqual({ removed: [], failures: [] });
  });
});
