import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect } from "vitest";
import { completionArtifactEvidence } from "../desktop/eval-main/task-completion-artifacts.mjs";

it("reads bounded real task files without following links or exposing hidden files, and preserves omissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "completion-artifacts-"));
  try {
    const workspace = join(root, "workspace"); await mkdir(join(workspace, "plan"), { recursive: true });
    await writeFile(join(workspace, "plan", "deliverable.md"), "Desk fits; total $120.");
    await writeFile(join(workspace, ".env"), "HIDDEN_SECRET");
    await writeFile(join(root, "outside.txt"), "OUTSIDE_SECRET");
    await symlink(join(root, "outside.txt"), join(workspace, "link.txt"));
    await symlink(root, join(workspace, "linked-directory"));
    await writeFile(join(workspace, "large.txt"), "x".repeat(32001));
    await writeFile(join(workspace, "binary.dat"), Buffer.from([0, 255, 7]));
    await symlink(workspace, join(root, "alias"));
    expect(await completionArtifactEvidence(join(root, "alias"))).toMatchObject({ files: [], complete: false, unavailable: expect.any(String) });
    const result = await completionArtifactEvidence(workspace);
    expect(result.files).toEqual([{ path: join("plan", "deliverable.md"), text: "Desk fits; total $120.", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
    expect(result.complete).toBe(false);
    expect(result.omitted).toBe(5);
    expect(JSON.stringify(result)).not.toMatch(/HIDDEN_SECRET|OUTSIDE_SECRET|completion-artifacts-/);
    await expect(completionArtifactEvidence(workspace, { signal: AbortSignal.abort() })).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("bounds aggregate evidence and reports absent workspace without inventing content", async () => {
  const root = await mkdtemp(join(tmpdir(), "completion-artifact-limits-"));
  try {
    for (let i = 0; i < 8; i++) await writeFile(join(root, `${i}.txt`), "a".repeat(32000));
    const packet = await completionArtifactEvidence(root);
    expect(packet.files).toHaveLength(2);
    expect(packet.complete).toBe(false);
    expect(await completionArtifactEvidence()).toMatchObject({ files: [], complete: false, unavailable: expect.any(String) });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("v2 prioritizes a clean committed repair and its late regression over unrelated files, retaining a bounded large-file patch", async () => {
  const { execFileSync } = await import("node:child_process");
  const root = await mkdtemp(join(tmpdir(), "completion-repair-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  try {
    git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
    await mkdir(join(root, "benchmarks")); await mkdir(join(root, "test"));
    for (let i = 0; i < 40; i++) await writeFile(join(root, "benchmarks", `${i}.js`), "unrelated\n");
    await writeFile(join(root, "index.js"), "// original\n" + "unchanged();\n".repeat(4000));
    git("add", "."); git("commit", "-qm", "Baseline"); const baseline = git("rev-parse", "HEAD");
    await writeFile(join(root, "index.js"), "reserveBeforeWrite();\n" + "unchanged();\n".repeat(4000));
    await writeFile(join(root, "test", "command-queue-race.test.js"), "assertQueueSettlesAcrossTwoFailures();\n");
    git("add", "."); git("commit", "-qm", "Repair");
    const legacy = await completionArtifactEvidence(root);
    expect(legacy.files.some(f => f.path === "test/command-queue-race.test.js")).toBe(false);
    const packet = await completionArtifactEvidence(root, { contract: "completion-evidence-v2", baseline });
    expect(packet.repository).toMatchObject({ baseline, head: git("rev-parse", "HEAD"), commitCount: 1, status: "", stable: true });
    expect(packet.repository.diff.text).toContain("reserveBeforeWrite");
    expect(packet.files[0]).toMatchObject({ path: "index.js", truncated: true });
    expect(packet.files[1]).toMatchObject({ path: "test/command-queue-race.test.js", text: "assertQueueSettlesAcrossTwoFailures();\n" });
    expect(Buffer.byteLength(JSON.stringify(packet))).toBeLessThan(150000);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("v2 does not execute repository diff helpers or include linked and hidden changed contents", async () => {
  const { execFileSync } = await import("node:child_process");
  const root = await mkdtemp(join(tmpdir(), "completion-authority-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  try {
    const workspace = join(root, "workspace"); await mkdir(workspace);
    const run = (...args) => execFileSync("git", args, { cwd: workspace, encoding: "utf8" }).trim();
    run("init", "-q"); run("config", "user.name", "Fixture"); run("config", "user.email", "fixture@example.invalid");
    await writeFile(join(workspace, "source.js"), "old\n"); run("add", "."); run("commit", "-qm", "Baseline"); const baseline = run("rev-parse", "HEAD");
    await writeFile(join(root, "helper.sh"), `#!/bin/sh\ntouch '${join(root, "EXECUTED")}'\n`, { mode: 0o700 });
    run("config", "diff.external", join(root, "helper.sh"));
    run("config", "diff.hostile.textconv", join(root, "helper.sh"));
    await writeFile(join(workspace, ".gitattributes"), "source.js diff=hostile\n");
    await writeFile(join(workspace, "source.js"), "repaired\n");
    await writeFile(join(root, "outside"), "OUTSIDE_PRIVATE");
    await symlink(join(root, "outside"), join(workspace, "linked.txt"));
    await writeFile(join(workspace, ".env"), "HIDDEN_PRIVATE");
    const packet = await completionArtifactEvidence(workspace, { baseline, contract: "completion-evidence-v2" });
    expect(packet.repository.diff.text).toContain("repaired");
    expect(JSON.stringify(packet)).not.toMatch(/OUTSIDE_PRIVATE|HIDDEN_PRIVATE/);
    expect(packet.omissions).toContainEqual(expect.objectContaining({ path: "linked.txt" }));
    await expect(import("node:fs/promises").then(fs => fs.stat(join(root, "EXECUTED")))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(completionArtifactEvidence(workspace, { baseline, contract: "completion-evidence-v2", signal: AbortSignal.abort() })).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each(["clean", "process"])("v2 refuses repository %s filters before normalization can execute them", async filter => {
  const { execFileSync } = await import("node:child_process");
  const root = await mkdtemp(join(tmpdir(), "completion-filter-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  try {
    git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
    await writeFile(join(root, "source.js"), "old\n"); git("add", "."); git("commit", "-qm", "Baseline"); const baseline = git("rev-parse", "HEAD");
    const marker = join(root, "EXECUTED");
    await writeFile(join(root, "helper.sh"), `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o700 });
    git("config", `filter.hostile.${filter}`, join(root, "helper.sh"));
    await writeFile(join(root, ".gitattributes"), "source.js filter=hostile\n"); await writeFile(join(root, "source.js"), "new\n");
    const packet = await completionArtifactEvidence(root, { baseline, contract: "completion-evidence-v2" });
    expect(packet.repository).toMatchObject({ unavailable: expect.any(String) });
    const { stat } = await import("node:fs/promises"); await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("v2 marks dirty-content mutation incomplete even when HEAD and porcelain status stay the same", async () => {
  const { execFileSync } = await import("node:child_process");
  const { completionArtifactEvidenceV2 } = await import("../desktop/eval-main/task-completion-artifacts-v2.mjs");
  const root = await mkdtemp(join(tmpdir(), "completion-mutation-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  try {
    git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
    await writeFile(join(root, "source.js"), "original\n"); git("add", "."); git("commit", "-qm", "Baseline"); const baseline = git("rev-parse", "HEAD");
    await writeFile(join(root, "source.js"), "first dirty version\n"); const before = git("status", "--porcelain");
    const packet = await completionArtifactEvidenceV2(root, { baseline, generalEvidence: async () => { await writeFile(join(root, "source.js"), "later dirty version\n"); return { files: [], complete: true }; } });
    expect(git("status", "--porcelain")).toBe(before);
    expect(packet.repository.stable).toBe(false); expect(packet.complete).toBe(false);
    expect(packet.omissions).toContainEqual(expect.objectContaining({ reason: expect.stringContaining("changed during capture") }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("distinguishes missing expected repository metadata from a genuine non-Git task", async () => {
  const root = await mkdtemp(join(tmpdir(), "completion-missing-git-"));
  try {
    await writeFile(join(root, "plan.md"), "Conditional plan");
    const ordinary = await completionArtifactEvidence(root, { contract: "completion-evidence-v2" });
    expect(ordinary.complete).toBe(true);
    const expected = await completionArtifactEvidence(root, { contract: "completion-evidence-v2", baseline: "a".repeat(40) });
    expect(expected).toMatchObject({ complete: false, repository: { unavailable: expect.any(String) }, files: ordinary.files });
    expect(expected.omissions).toContainEqual(expect.objectContaining({ path: "repository" }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("resolves only absolute host Git paths outside the candidate workspace, including Windows git.exe", async () => {
  const { trustedGitExecutable } = await import("../desktop/eval-main/completion-git-view.mjs");
  const root = await mkdtemp(join(tmpdir(), "completion-git-path-"));
  try {
    const workspace = join(root, "workspace"), tools = join(root, "tools"); await mkdir(workspace); await mkdir(tools);
    await writeFile(join(workspace, "git.exe"), "candidate", { mode: 0o700 });
    await writeFile(join(tools, "git.exe"), "host", { mode: 0o700 });
    expect(await trustedGitExecutable(workspace, { platform: "win32", path: `.;${workspace};${tools}` })).toBe(await realpath(join(tools, "git.exe")));
    await expect(trustedGitExecutable(workspace, { platform: "win32", path: `.;${workspace}` })).rejects.toThrow("unavailable");
  } finally { await rm(root, { recursive: true, force: true }); }
});
