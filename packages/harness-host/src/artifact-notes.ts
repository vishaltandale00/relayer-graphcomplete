// Artifact notes (PRD 6.6.8). A note the user wrote in the artifact viewer is a
// context annotation that names its screenshot by digest. Before a turn, the host
// copies each named screenshot into the turn's folder and rewrites the reference
// to that file, so the agent can open what the user saw.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { InteractionInput } from "@relayer/graph-client";

// Only the suffix the viewer writes: "\n— <where> · screenshot sha256:<digest>" at the end.
const SCREENSHOT = /(\n— [^\n]* · )screenshot sha256:([0-9a-f]{64})$/u;

/** Host-local file materialization; it is advisory and carries no graph authority. */
export interface ArtifactNoteScreenshot {
  readonly targetNodeId: number;
  readonly annotationIndex: number;
  readonly digestSha256: string;
  readonly path: string | null;
}

export interface ArtifactNoteInteractionInput extends InteractionInput {
  readonly artifactNoteScreenshots?: readonly ArtifactNoteScreenshot[];
}

export async function withArtifactNoteScreenshots(
  input: InteractionInput,
  notesDirectory: string | undefined,
  turnDirectory: string,
): Promise<ArtifactNoteInteractionInput> {
  if (notesDirectory === undefined || !input.contexts.some((context) => context.annotations.some((note) => SCREENSHOT.test(note)))) return input;
  const folder = join(turnDirectory, "artifact-notes");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const copied = new Map<string, string | null>();
  const fileFor = async (digest: string): Promise<string | null> => {
    if (!copied.has(digest)) {
      // The note names its screenshot by digest; anything else in that file is not it.
      const bytes = await readFile(join(notesDirectory, `${digest}.png`)).catch(() => null);
      const target = join(folder, `${digest}.png`);
      const matches = bytes !== null && createHash("sha256").update(bytes).digest("hex") === digest;
      copied.set(digest, matches ? await writeFile(target, bytes, { mode: 0o600 }).then(() => target, () => null) : null);
    }
    return copied.get(digest) ?? null;
  };
  if (input.completionContract !== undefined) {
    const screenshots = await Promise.all(input.contexts.flatMap(context => context.annotations.flatMap((note, annotationIndex) => {
      const match = SCREENSHOT.exec(note);
      return match ? [fileFor(match[2]!).then(path => ({ targetNodeId: context.targetNode.id, annotationIndex, digestSha256: match[2]!, path }))] : [];
    })));
    // The normalized contexts and their sealed digest are canonical. Materialized
    // filenames must never replace any part of that immutable semantic input.
    return { ...input, artifactNoteScreenshots: screenshots };
  }
  const contexts = await Promise.all(input.contexts.map(async (context) => ({
    ...context,
    annotations: await Promise.all(context.annotations.map(async (note) => {
      const match = SCREENSHOT.exec(note);
      if (!match) return note;
      const file = await fileFor(match[2]!);
      return note.replace(SCREENSHOT, `$1${file === null ? "screenshot unavailable" : `screenshot ${file}`}`);
    })),
  })));
  return { ...input, contexts };
}
