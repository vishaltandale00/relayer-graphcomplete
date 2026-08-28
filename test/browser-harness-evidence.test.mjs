import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  PRIME_AGENT_DEPENDENCY_CLOSURE_SHA256_BY_TARGET,
  PRIME_AGENT_PACKAGE_SHA256,
  PRIME_AGENT_PACKAGE_TREE_SHA256,
  PRIME_AGENT_SOURCE_COMMIT,
} from "../desktop/main/services/prime-agent-runtime.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const evidenceRoot = join(repositoryRoot, "docs", "evidence", "issue-257-browser-harnesses");

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

describe("issue 257 browser harness evidence", () => {
  it("pins the exact independent configuration and implementation bytes", async () => {
    const manifest = JSON.parse(await readFile(join(evidenceRoot, "manifest.json"), "utf8"));
    const files = {
      ...manifest.harnesses.codex.configurationSha256,
      ...manifest.harnesses.claude.configurationSha256,
      ...manifest.harnesses.prime.configurationSha256,
    };
    await Promise.all(Object.entries(files).map(async ([name, expected]) => {
      expect(await sha256(join(repositoryRoot, "harnesses", name)), name).toBe(expected);
    }));
    expect(await sha256(join(repositoryRoot, "desktop", "main", "services", "codex-browser-mcp-runtime.mjs")))
      .toBe(manifest.harnesses.codex.browserRuntimeSourceSha256);
    expect(await sha256(join(repositoryRoot, "packages", "harness-host", "src", "implementations", "claude-basic-browser.ts")))
      .toBe(manifest.harnesses.claude.browserRuntimeSourceSha256);
  });

  it("matches the production Prime and Codex package contracts", async () => {
    const manifest = JSON.parse(await readFile(join(evidenceRoot, "manifest.json"), "utf8"));
    const desktopManifest = JSON.parse(await readFile(join(repositoryRoot, "desktop", "package.json"), "utf8"));
    const primeManifest = JSON.parse(await readFile(join(repositoryRoot, "vendor", "prime-agent", "manifest.json"), "utf8"));
    const codingAgent = primeManifest.packages.find(({ name }) => name === "@earendil-works/pi-coding-agent");

    expect(desktopManifest.dependencies[manifest.harnesses.codex.helper.package])
      .toBe(manifest.harnesses.codex.helper.version);
    expect(manifest.harnesses.prime).toMatchObject({
      sourceCommit: PRIME_AGENT_SOURCE_COMMIT,
      archiveSha256: PRIME_AGENT_PACKAGE_SHA256["@earendil-works/pi-coding-agent"],
      runtimeTreeSha256: PRIME_AGENT_PACKAGE_TREE_SHA256["@earendil-works/pi-coding-agent"],
      targetClosureSha256: PRIME_AGENT_DEPENDENCY_CLOSURE_SHA256_BY_TARGET,
    });
    expect(codingAgent).toMatchObject({
      sha256: manifest.harnesses.prime.archiveSha256,
      treeSha256: manifest.harnesses.prime.runtimeTreeSha256,
    });
  });

  it("records a sanitized harness-owned scope instead of a product browser contract", async () => {
    const manifest = JSON.parse(await readFile(join(evidenceRoot, "manifest.json"), "utf8"));
    expect(Object.values(manifest.privacy)).toEqual(expect.arrayContaining([false]));
    expect(Object.values(manifest.privacy).every((value) => value === false)).toBe(true);
    expect(Object.values(manifest.scope).every((value) => value === false)).toBe(true);
    expect(manifest.profileKind).toBe("dedicated-non-default");
    expect(manifest.endpointKind).toBe("explicit-loopback-cdp");
  });
});
