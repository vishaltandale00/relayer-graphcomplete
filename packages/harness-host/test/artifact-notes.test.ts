// PRD 6.6.8: the agent can open each artifact note's screenshot.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withArtifactNoteScreenshots } from "../src/artifact-notes.js";
import type { InteractionInput } from "@relayer/graph-client";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const cleanup: string[] = [];
afterEach(async () => { for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true }); });

const input = (annotations: string[]): InteractionInput => ({
  interaction: { id: 1, kind: "user-interaction", icon: "user", title: "Fix it", detail: "Fix it", state: "accepted" },
  contexts: [{ type: "node", targetNode: { id: 27, kind: "artifact", icon: "globe", title: "Landing page", detail: "", state: "accepted" }, annotations }],
} as unknown as InteractionInput);

describe("artifact note screenshots", () => {
  it("copy into the turn folder and replace each reference with the file", async () => {
    const notes = await mkdtemp(join(tmpdir(), "relayer-notes-"));
    const turn = await mkdtemp(join(tmpdir(), "relayer-turn-"));
    cleanup.push(notes, turn);
    const digest = "a".repeat(64);
    const missing = "b".repeat(64);
    await writeFile(join(notes, `${digest}.png`), PNG);
    const result = await withArtifactNoteScreenshots(input([
      `The price is wrong\n— at /#pricing · screenshot sha256:${digest}`,
      `Too dark\n— at 0:12 · screenshot sha256:${missing}`,
      "A plain annotation",
      `An ordinary note quoting screenshot sha256:${digest} mid-sentence.`,
    ]), notes, turn);
    const [first, second, plain, quoted] = result.contexts[0]!.annotations;
    // Only the suffix the viewer writes is rewritten.
    expect(quoted).toBe(`An ordinary note quoting screenshot sha256:${digest} mid-sentence.`);
    const file = join(turn, "artifact-notes", `${digest}.png`);
    expect(first).toBe(`The price is wrong\n— at /#pricing · screenshot ${file}`);
    expect(await readFile(file)).toEqual(PNG);
    expect(second).toBe("Too dark\n— at 0:12 · screenshot unavailable");
    expect(plain).toBe("A plain annotation");
  });

  it("leave input without notes untouched", async () => {
    const original = input(["Just text"]);
    expect(await withArtifactNoteScreenshots(original, "/nowhere", "/tmp")).toBe(original);
    expect(await withArtifactNoteScreenshots(original, undefined, "/tmp")).toBe(original);
  });
});
