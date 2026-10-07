// Artifact notes (PRD 6.6.8). A note the user wrote in the artifact viewer is a
// context annotation that names its screenshot by digest. Before a turn, the host
// copies each named screenshot into the turn's folder and rewrites the reference
// to that file, so the agent can open what the user saw.
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { InteractionInput } from "@relayer/graph-client";

const SCREENSHOT = /screenshot sha256:([0-9a-f]{64})/gu;
const NAMES_SCREENSHOT = /screenshot sha256:[0-9a-f]{64}/u;

export async function withArtifactNoteScreenshots(
  input: InteractionInput,
  notesDirectory: string | undefined,
  turnDirectory: string,
): Promise<InteractionInput> {
  if (notesDirectory === undefined || !input.contexts.some((context) => context.annotations.some((note) => NAMES_SCREENSHOT.test(note)))) return input;
  const folder = join(turnDirectory, "artifact-notes");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const copied = new Map<string, string | null>();
  const fileFor = async (digest: string): Promise<string | null> => {
    if (!copied.has(digest)) {
      const target = join(folder, `${digest}.png`);
      copied.set(digest, await copyFile(join(notesDirectory, `${digest}.png`), target).then(() => target, () => null));
    }
    return copied.get(digest) ?? null;
  };
  const contexts = await Promise.all(input.contexts.map(async (context) => ({
    ...context,
    annotations: await Promise.all(context.annotations.map(async (note) => {
      let rewritten = note;
      for (const [marker, digest] of note.matchAll(SCREENSHOT)) {
        const file = await fileFor(digest!);
        rewritten = rewritten.replace(marker, file === null ? "screenshot unavailable" : `screenshot ${file}`);
      }
      return rewritten;
    })),
  })));
  return { ...input, contexts };
}
