import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
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
