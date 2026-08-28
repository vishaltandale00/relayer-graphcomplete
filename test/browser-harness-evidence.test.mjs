import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import * as tar from "tar";

const repositoryRoot = resolve(import.meta.dirname, "..");
const evidenceRoot = join(repositoryRoot, "docs", "evidence", "issue-257-browser-harnesses");
const manifestRelativePath = "docs/evidence/issue-257-browser-harnesses/manifest.json";
const execFileAsync = promisify(execFile);

function sourceSetSha256(fileSha256) {
  const digest = createHash("sha256");
  for (const path of Object.keys(fileSha256).sort()) {
    digest.update(path);
    digest.update("\0");
    digest.update(fileSha256[path]);
    digest.update("\n");
  }
  return digest.digest("hex");
}

async function sourceFileSha256(files, sourceRevision) {
  return Object.fromEntries(await Promise.all([...files].sort().map(async (path) => [
    path,
    createHash("sha256").update(await integratedHeadBytes(path, sourceRevision)).digest("hex"),
  ])));
}

async function integratedHeadBytes(path, sourceRevision) {
  if (!sourceRevision) {
    return readFile(join(repositoryRoot, path));
  }
  const { stdout } = await execFileAsync("git", ["show", `${sourceRevision}:${path}`], {
    cwd: repositoryRoot,
    encoding: "buffer",
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

async function changedSourceFiles(mergeBase, sourceRevision) {
  const comparison = sourceRevision ? `${mergeBase}...${sourceRevision}` : mergeBase;
  const { stdout } = await execFileAsync("git", ["diff", "--name-only", comparison, "--"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  return stdout
    .split("\n")
    .filter((path) => path && path !== manifestRelativePath)
    .sort();
}

async function sourceSnapshot(manifest) {
  if (process.env.RELAYER_VERIFY_ISSUE_257_DELIVERY === "1") {
    return { delivery: true, revision: undefined };
  }
  const baseRevision = process.env.GITHUB_EVENT_NAME === "pull_request" ? "HEAD^1" : "HEAD";
  let baseSnapshotId;
  try {
    const { stdout } = await execFileAsync("git", ["show", `${baseRevision}:${manifestRelativePath}`], {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    baseSnapshotId = JSON.parse(stdout).integratedSource?.snapshotId;
  } catch {
    // The delivery PR's base predates this evidence file. The exact head is
    // verified below; future PR bases carry the stable snapshot identifier.
  }
  if (baseSnapshotId !== manifest.integratedSource.snapshotId) {
    return {
      delivery: true,
      revision: process.env.GITHUB_EVENT_NAME === "pull_request" ? "HEAD^2" : undefined,
    };
  }

  const { stdout } = await execFileAsync("git", [
    "log",
    baseRevision,
    "--format=%H",
    "--fixed-strings",
    "-S",
    manifest.integratedSource.snapshotId,
    "--",
    manifestRelativePath,
  ], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  const revision = stdout.trim().split("\n").filter(Boolean).at(-1);
  if (!revision) throw new Error(`Cannot locate historical snapshot ${manifest.integratedSource.snapshotId}`);
  return { delivery: false, revision };
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
    expect(manifest.integratedSource.snapshotId).toMatch(/^issue-257-browser-harnesses-v\d+$/);
    expect(Object.keys(manifest.integratedSource.fileSha256).sort())
      .toEqual([...manifest.integratedSource.files].sort());
    expect(Object.values(manifest.integratedSource.fileSha256))
      .toEqual(expect.arrayContaining([expect.stringMatching(/^[a-f0-9]{64}$/)]));
    expect(Object.values(manifest.integratedSource.fileSha256).every((value) => /^[a-f0-9]{64}$/.test(value)))
      .toBe(true);
    expect(sourceSetSha256(manifest.integratedSource.fileSha256)).toBe(manifest.integratedSource.sha256);

    const { revision: sourceRevision } = await sourceSnapshot(manifest);
    const files = {
      ...manifest.harnesses.codex.configurationSha256,
      ...manifest.harnesses.claude.configurationSha256,
      ...manifest.harnesses.prime.configurationSha256,
    };
    await Promise.all(Object.entries(files).map(async ([name, expected]) => {
      expect(createHash("sha256").update(await integratedHeadBytes(`harnesses/${name}`, sourceRevision)).digest("hex"), name)
        .toBe(expected);
    }));
    expect(createHash("sha256").update(await integratedHeadBytes("desktop/main/services/codex-browser-mcp-runtime.mjs", sourceRevision)).digest("hex"))
      .toBe(manifest.harnesses.codex.browserRuntimeSourceSha256);
    expect(createHash("sha256").update(await integratedHeadBytes("packages/harness-host/src/implementations/claude-basic-browser.ts", sourceRevision)).digest("hex"))
      .toBe(manifest.harnesses.claude.browserRuntimeSourceSha256);
    expect(manifest.assemblyMergeBase).toBe("ead15b0791504da68a3588ad1fcf2ef15092df96");
    expect(await changedSourceFiles(manifest.assemblyMergeBase, sourceRevision))
      .toEqual([...manifest.integratedSource.files].sort());
    expect(await sourceFileSha256(manifest.integratedSource.files, sourceRevision))
      .toEqual(manifest.integratedSource.fileSha256);
  });

  it("matches the production Prime and Codex package contracts", async () => {
    const manifest = JSON.parse(await readFile(join(evidenceRoot, "manifest.json"), "utf8"));
    const { delivery } = await sourceSnapshot(manifest);
    if (!delivery) return;
    const {
      PRIME_AGENT_DEPENDENCY_CLOSURE_SHA256_BY_TARGET,
      PRIME_AGENT_PACKAGE_SHA256,
      PRIME_AGENT_PACKAGE_TREE_SHA256,
      PRIME_AGENT_SOURCE_COMMIT,
    } = await import("../desktop/main/services/prime-agent-runtime.mjs");
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

  it("records live observation and a restored reversible action for every delivered harness", async () => {
    const manifest = JSON.parse(await readFile(join(evidenceRoot, "manifest.json"), "utf8"));
    for (const [name, harness] of Object.entries(manifest.harnesses)) {
      expect(harness.predecessorLiveProof.preseededMarkerObserved, name).toBe(true);
      expect(harness.predecessorLiveProof.reversibleActionRestored, name).toBe(true);
    }
    const claudeProof = manifest.harnesses.claude.reversibleActionProof;
    expect(claudeProof).toMatchObject({
      commentUrl: "https://github.com/vishaltandale00/relayer-graphcomplete/issues/250#issuecomment-5453178329",
      commentBodyPlusLfSha256: "fbf74feacc426a979025b60963008722e9408c245dd1056ddedd4deaa68eaeda",
      receiptPath: "docs/evidence/issue-257-browser-harnesses/claude-live-reversible-action.md",
    });
    const receiptBody = await readFile(join(repositoryRoot, claudeProof.receiptPath), "utf8");
    expect(createHash("sha256").update(receiptBody).update("\n").digest("hex"))
      .toBe(claudeProof.commentBodyPlusLfSha256);
    const receiptMatch = receiptBody.match(/```json\n(?<json>[\s\S]+?)\n```/);
    expect(receiptMatch?.groups?.json).toBeDefined();
    const receipt = JSON.parse(receiptMatch.groups.json);
    expect(receipt).toMatchObject({
      preseededMarkerObserved: true,
      sdkMcpHandlerInvoked: true,
      reversibleActionObserved: true,
      reversibleActionRestored: true,
      chromeAliveAfterCleanup: true,
    });
    expect(receipt.initialValueSha256).toBe(receipt.restoredValueSha256);
    expect(receipt.changedValueSha256).not.toBe(receipt.initialValueSha256);
    expect(manifest.harnesses.claude.predecessorLiveProof).toMatchObject({
      preseededMarkerObserved: receipt.preseededMarkerObserved,
      sdkMcpHandlerInvoked: receipt.sdkMcpHandlerInvoked,
      reversibleActionObserved: receipt.reversibleActionObserved,
      reversibleActionRestored: receipt.reversibleActionRestored,
      chromeAliveAfterCleanup: receipt.chromeAliveAfterCleanup,
    });
  });
});
