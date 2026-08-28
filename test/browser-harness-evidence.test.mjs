import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import * as tar from "tar";

import {
  PRIME_AGENT_DEPENDENCY_CLOSURE_SHA256_BY_TARGET,
  PRIME_AGENT_PACKAGE_SHA256,
  PRIME_AGENT_PACKAGE_TREE_SHA256,
  PRIME_AGENT_SOURCE_COMMIT,
} from "../desktop/main/services/prime-agent-runtime.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const evidenceRoot = join(repositoryRoot, "docs", "evidence", "issue-257-browser-harnesses");
const execFileAsync = promisify(execFile);

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function sourceSetSha256(files) {
  const digest = createHash("sha256");
  for (const path of [...files].sort()) {
    const bytes = await integratedHeadBytes(path);
    digest.update(path);
    digest.update("\0");
    digest.update(createHash("sha256").update(bytes).digest("hex"));
    digest.update("\n");
  }
  return digest.digest("hex");
}

async function integratedHeadBytes(path) {
  if (process.env.GITHUB_EVENT_NAME !== "pull_request") {
    return readFile(join(repositoryRoot, path));
  }
  const { stdout } = await execFileAsync("git", ["show", `HEAD^2:${path}`], {
    cwd: repositoryRoot,
    encoding: "buffer",
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

async function archiveEntrySha256(archivePath, targetPath) {
  let digest;
  await tar.t({
    file: archivePath,
    onentry(entry) {
      if (entry.path !== targetPath) {
        entry.resume();
        return;
      }
      const hash = createHash("sha256");
      entry.on("data", (chunk) => hash.update(chunk));
      entry.on("end", () => { digest = hash.digest("hex"); });
    },
  });
  if (!digest) throw new Error(`Missing archive evidence entry: ${targetPath}`);
  return digest;
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
    expect(manifest.assemblyMergeBase).toBe("9188a8123b7c40436f0100d124c24103a768d32d");
    expect(await sourceSetSha256(manifest.integratedSource.files)).toBe(manifest.integratedSource.sha256);
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
    const archivePath = join(repositoryRoot, "vendor", "prime-agent", codingAgent.file);
    await expect(Promise.all([
      archiveEntrySha256(archivePath, "package/skills/browser/src/browser/__init__.py"),
      archiveEntrySha256(archivePath, "package/dist/skills/browser/src/browser/__init__.py"),
    ])).resolves.toEqual([
      manifest.harnesses.prime.browserHelperSha256,
      manifest.harnesses.prime.browserHelperSha256,
    ]);
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
