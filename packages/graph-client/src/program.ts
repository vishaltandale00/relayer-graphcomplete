import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** One exact-match edit to a saved graph program. `find` must match exactly one place. */
export interface GraphProgramEdit {
  readonly find: string;
  readonly replace: string;
}

export class GraphProgramEditError extends Error {
  override readonly name = "GraphProgramEditError";
}

const ID_PATTERN = /^[0-9a-f]{8}$/;

/**
 * The program this process is running, once it is known. A stdin program is
 * known from `process._eval`; a patched program carries execution-local context
 * through its import, so asynchronous and nested reruns retain their own identity.
 */
type SavedProgram = { readonly id: string; readonly source: string };
const runningProgram = new AsyncLocalStorage<SavedProgram>();
let importGeneration = 0;

/** A short content hash. The same text always has the same id, so a repeat is harmless. */
export function graphProgramId(source: string): string {
  return createHash("sha256").update(source).digest("hex").slice(0, 8);
}

function stdinProgramSource(): string | undefined {
  const source = (process as { _eval?: unknown })._eval;
  return typeof source === "string" && source.length > 0 ? source : undefined;
}

function programPath(directory: string, id: string): string {
  return join(directory, "programs", `${id}.mjs`);
}

function saveProgram(directory: string, id: string, source: string): void {
  try {
    // The host owns the parent lifetime. Never recreate a removed turn folder.
    mkdirSync(join(directory, "programs"), { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const destination = programPath(directory, id);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  writeFileSync(temporary, source, { mode: 0o600, flag: "wx" });
  try {
    try {
      // Publish complete bytes without replacing an existing named program.
      linkSync(temporary, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (readFileSync(destination, "utf8") !== source) {
        throw new GraphProgramEditError(`Saved program id ${id} already names different bytes. Rerun the full program.`);
      }
    }
  } finally {
    unlinkSync(temporary);
  }
}

/**
 * Saves the running program under its own id in the host's per-turn folder and
 * prints that id, so a retry can send edits to exactly this program. Every
 * program that reaches this point gets its own id; nothing is overwritten.
 * Without a folder, or when Node did not expose the stdin source, nothing is
 * saved and the printed line says so, so the model knows not to patch it.
 */
export function rememberGraphProgram(directory: string | undefined): void {
  if (directory === undefined) return;
  let activeProgram = runningProgram.getStore();
  if (activeProgram === undefined) {
    const source = stdinProgramSource();
    if (source === undefined) {
      console.log("graph program id: unavailable (not a stdin program); rerun in full to change it");
      return;
    }
    activeProgram = { id: graphProgramId(source), source };
  }
  try {
    saveProgram(directory, activeProgram.id, activeProgram.source);
    console.log(`graph program id: ${activeProgram.id}`);
  } catch {
    console.log("graph program id: unavailable (could not save); rerun in full to change it");
  }
}

/** Applies edits in order. Each `find` must match exactly once in the program as edited so far. */
export function applyGraphProgramEdits(program: string, edits: readonly GraphProgramEdit[]): string {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new GraphProgramEditError("rerunGraphProgram needs a non-empty array of { find, replace } edits.");
  }
  let patched = program;
  for (const [index, edit] of edits.entries()) {
    const label = `Edit ${index + 1}`;
    if (typeof edit?.find !== "string" || edit.find === "" || typeof edit.replace !== "string") {
      throw new GraphProgramEditError(`${label} needs a non-empty find string and a replace string.`);
    }
    const first = patched.indexOf(edit.find);
    if (first === -1) {
      throw new GraphProgramEditError(`${label}: find text was not found in that program. Copy it exactly from the program with this id, or rerun the full program.`);
    }
    if (patched.indexOf(edit.find, first + 1) !== -1) {
      throw new GraphProgramEditError(`${label}: find text appears more than once in that program. Include more surrounding lines so it matches one place.`);
    }
    patched = patched.slice(0, first) + edit.replace + patched.slice(first + edit.find.length);
  }
  return patched;
}

/**
 * Edits the saved program with this id and runs the result. The edited program
 * is saved under its own new id, which it prints when it starts. A missing id
 * or a missing or ambiguous match throws before anything runs. Each call runs
 * its program, even for the same edit twice.
 */
export async function rerunGraphProgram(
  id: string,
  edits: readonly GraphProgramEdit[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const directory = environment.RELAYER_GRAPH_PROGRAM_DIR;
  if (!directory) throw new GraphProgramEditError("Program edits are not available in this run. Rerun the full program.");
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    throw new GraphProgramEditError("rerunGraphProgram needs the id a program printed as \"graph program id: ...\" as its first argument.");
  }
  let previous: string;
  try {
    previous = readFileSync(programPath(directory, id), "utf8");
  } catch {
    throw new GraphProgramEditError(`No saved program has id ${id} in this run. Use the id printed by the program you want to edit; a program that crashed before printing one must be rerun in full.`);
  }
  if (graphProgramId(previous) !== id) {
    throw new GraphProgramEditError(`Saved program ${id} no longer matches its id. Rerun the full program.`);
  }
  const patched = applyGraphProgramEdits(previous, edits);
  const patchedId = graphProgramId(patched);
  saveProgram(directory, patchedId, patched);
  console.log(`graph program ${id} edited -> running as ${patchedId}`);
  // Context follows each import independently, including concurrent and nested reruns.
  // A query keeps import() from returning a cached module when the same text runs twice.
  await runningProgram.run({ id: patchedId, source: patched }, async () => {
    await import(`${pathToFileURL(programPath(directory, patchedId)).href}?run=${++importGeneration}`);
  });
}
