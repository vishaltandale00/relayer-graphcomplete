// PRD 6.6.8: the agent can open each artifact note's screenshot.
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withArtifactNoteScreenshots } from "../src/artifact-notes.js";
import { validateCompletionContract } from "../src/completion-contract.js";
import { renderInteractionInput } from "../src/interaction-input.js";
import type { InteractionInput } from "@relayer/graph-client";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const cleanup: string[] = [];
afterEach(async () => { for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true }); });

const input = (annotations: string[]): InteractionInput => ({
  interaction: { id: 1, kind: "user-interaction", icon: "user", title: "Fix it", detail: "Fix it", state: "accepted" },
  contexts: [{ type: "node", targetNode: { id: 27, kind: "artifact", icon: "globe", title: "Landing page", detail: "", state: "accepted" }, annotations }],
} as unknown as InteractionInput);

describe("artifact note screenshots", () => {
  it.each([false, true])("copies verified screenshot files while preserving sealed input (sealed=%s)", async (sealed) => {
    const notes = await mkdtemp(join(tmpdir(), "relayer-notes-"));
    const turn = await mkdtemp(join(tmpdir(), "relayer-turn-"));
    cleanup.push(notes, turn);
    const digest = createHash("sha256").update(PNG).digest("hex");
    const missing = "b".repeat(64);
    const tampered = "c".repeat(64);
    await writeFile(join(notes, `${digest}.png`), PNG);
    // Bytes that do not match the digest the note names are not that screenshot.
    await writeFile(join(notes, `${tampered}.png`), PNG);
    const original = input([
      `The price is wrong\n— at /#pricing · screenshot sha256:${digest}`,
      `Too dark\n— at 0:12 · screenshot sha256:${missing}`,
      "A plain annotation",
      `Swapped\n— at /#menu · screenshot sha256:${tampered}`,
      `An ordinary note quoting screenshot sha256:${digest} mid-sentence.`,
    ]);
    if (sealed) {
      // Keys are in canonical sorted order, including the nested contract input.
      const contract = {
        authorities: [{ kind: "navigate.add" as const, nodeId: 27 }],
        input: { answers: [], context: [{ annotations: original.contexts[0]!.annotations, nodeId: 27 }], invocationReferences: [], text: "Fix it" },
        interactionNodeId: 1, returnRequirements: [{ kind: "navigate.response" as const, nodeId: 27 }], schemaVersion: 1 as const,
      };
      Object.assign(original, { completionContractStatus: "sealed", completionContract: {
        ...contract, digest: `sha256:v1:${createHash("sha256").update(JSON.stringify(contract)).digest("hex")}`,
      } });
      validateCompletionContract(original, 1);
    }
    const canonicalBefore = JSON.stringify(original);
    const result = await withArtifactNoteScreenshots(original, notes, turn);
    const file = join(turn, "artifact-notes", `${digest}.png`);
    expect(await readFile(file)).toEqual(PNG);
    expect(JSON.stringify(original)).toBe(canonicalBefore);
    if (sealed) {
      expect(result.contexts).toBe(original.contexts);
      expect(result.completionContract).toBe(original.completionContract);
      validateCompletionContract(result, 1);
      expect(result.artifactNoteScreenshots).toEqual([
        { targetNodeId: 27, annotationIndex: 0, digestSha256: digest, path: file },
        { targetNodeId: 27, annotationIndex: 1, digestSha256: missing, path: null },
        { targetNodeId: 27, annotationIndex: 3, digestSha256: tampered, path: null },
      ]);
      const rendered = JSON.parse(renderInteractionInput(result));
      expect(rendered.contexts[0].annotations).toEqual(original.contexts[0]!.annotations);
      expect(rendered.completionContract).toEqual(original.completionContract);
      expect(rendered.artifactNoteScreenshots).toEqual(result.artifactNoteScreenshots);
      return;
    }
    const [first, second, plain, swapped, quoted] = result.contexts[0]!.annotations;
    expect(swapped).toBe("Swapped\n— at /#menu · screenshot unavailable");
    // Only the suffix the viewer writes is rewritten.
    expect(quoted).toBe(`An ordinary note quoting screenshot sha256:${digest} mid-sentence.`);
    expect(first).toBe(`The price is wrong\n— at /#pricing · screenshot ${file}`);
    expect(second).toBe("Too dark\n— at 0:12 · screenshot unavailable");
    expect(plain).toBe("A plain annotation");
  });

  it("leave input without notes untouched", async () => {
    const original = input(["Just text"]);
    expect(await withArtifactNoteScreenshots(original, "/nowhere", "/tmp")).toBe(original);
    expect(await withArtifactNoteScreenshots(original, undefined, "/tmp")).toBe(original);
  });
});
