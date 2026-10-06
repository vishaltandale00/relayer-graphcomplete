import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { GraphProgramEditError, applyGraphProgramEdits, graphProgramId } from "../src/index.js";

const execFileAsync = promisify(execFile);
const CLIENT = pathToFileURL(join(import.meta.dirname, "../dist/index.js")).href;
const ENVIRONMENT = { RELAYER_GRAPH_URL: "http://127.0.0.1:1", RELAYER_GRAPH_TOKEN: "token", RELAYER_NODE_ID: "1", RELAYER_GRAPH_AUTHORING_ERRORS: "1" };

const PROGRAM = `import { RelayerGraphClient } from "${CLIENT}";
const graph = RelayerGraphClient.fromEnv();
if (!graph.capability.authoringErrors) throw new Error("diagnostics opt-in lost");
const title = "Edge writes are serial";
console.log("ran:" + title);
`;
const PATCHED = PROGRAM.replace("are serial", "are batched");
const patch = (id: string, edits: string) => `import { rerunGraphProgram } from "${CLIENT}";
await rerunGraphProgram(${JSON.stringify(id)}, ${edits});
`;

/** Runs a program the way a harness does: node reading a heredoc from standard input. */
async function runStdinProgram(program: string, programDirectory: string | undefined) {
  const child = execFileAsync(process.execPath, ["--input-type=module"], {
    env: { ...process.env, ...ENVIRONMENT, ...(programDirectory === undefined ? {} : { RELAYER_GRAPH_PROGRAM_DIR: programDirectory }) },
  });
  child.child.stdin!.end(program);
  try {
    const { stdout } = await child;
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

describe("applyGraphProgramEdits", () => {
  it("applies edits in order and leaves the rest of the program alone", () => {
    const patched = applyGraphProgramEdits("a\nb\nc\n", [{ find: "b\n", replace: "B\n" }, { find: "B\nc", replace: "B\nC" }]);
    expect(patched).toBe("a\nB\nC\n");
  });

  it.each([
    ["no edits", [], "non-empty array"],
    ["a missing edit", new Array(1), "non-empty find string"],
    ["an empty find", [{ find: "", replace: "x" }], "non-empty find string"],
    ["a missing match", [{ find: "zzz", replace: "x" }], "was not found in that program"],
    ["an overlapping match", [{ find: "aa", replace: "x" }], "appears more than once"],
    ["an ambiguous match", [{ find: "a", replace: "x" }], "appears more than once"],
  ])("refuses %s with a clear error", (_case, edits, message) => {
    expect(() => applyGraphProgramEdits("aaa a\n", edits)).toThrow(GraphProgramEditError);
    expect(() => applyGraphProgramEdits("aaa a\n", edits)).toThrow(message);
  });
});

describe("rerunGraphProgram through node --input-type=module", () => {
  const folders: string[] = [];
  afterEach(async () => {
    for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
  });
  /** The host creates the per-turn parent; clients may only create children. */
  async function programFolder(): Promise<string> {
    const parent = await mkdtemp(join(tmpdir(), "relayer-client-program-"));
    folders.push(parent);
    const directory = join(parent, "programs-for-turn");
    await mkdir(directory, { mode: 0o700 });
    return directory;
  }

  it("cannot recreate a turn folder after host cleanup", async () => {
    const folder = await programFolder();
    await runStdinProgram(PROGRAM, folder);
    await rm(folder, { recursive: true });
    const late = await runStdinProgram(PROGRAM, folder);
    expect(late.stdout).toContain("unavailable (could not save)");
    await expect(stat(folder)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("saves each program under its own id, prints it, and runs a patch of exactly that program", async () => {
    const folder = await programFolder();
    const id = graphProgramId(PROGRAM);
    const first = await runStdinProgram(PROGRAM, folder);
    expect(first).toMatchObject({ code: 0, stdout: `graph program id: ${id}\nran:Edge writes are serial\n` });
    expect(await readFile(join(folder, "programs", `${id}.mjs`), "utf8")).toBe(PROGRAM);
    // A second, unrelated program (a read-only probe, or another subagent's) gets its own slot.
    const probe = `import { RelayerGraphClient } from "${CLIENT}";\nRelayerGraphClient.fromEnv();\nconsole.log("probe");\n`;
    expect((await runStdinProgram(probe, folder)).stdout).toBe(`graph program id: ${graphProgramId(probe)}\nprobe\n`);

    const second = await runStdinProgram(patch(id, '[{ find: \'const title = "Edge writes are serial";\', replace: \'const title = "Edge writes are batched";\' }]'), folder);
    const patchedId = graphProgramId(PATCHED);
    expect(second).toMatchObject({
      code: 0,
      stdout: `graph program ${id} edited -> running as ${patchedId}\ngraph program id: ${patchedId}\nran:Edge writes are batched\n`,
    });
    // The original stays patchable, the result is saved under its own id, and the patch itself is not saved.
    expect(await readFile(join(folder, "programs", `${id}.mjs`), "utf8")).toBe(PROGRAM);
    expect(await readFile(join(folder, "programs", `${patchedId}.mjs`), "utf8")).toBe(PATCHED);
    expect((await readdir(join(folder, "programs"))).sort()).toEqual([`${id}.mjs`, `${graphProgramId(probe)}.mjs`, `${patchedId}.mjs`].sort());
  });

  it("fails before running anything when the id is unknown or a find is missing", async () => {
    const folder = await programFolder();
    await runStdinProgram(PROGRAM, folder);
    const id = graphProgramId(PROGRAM);
    const missing = await runStdinProgram(patch(id, '[{ find: "not in the program", replace: "x" }]'), folder);
    expect(missing.code).not.toBe(0);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toContain("GraphProgramEditError");
    expect(missing.stderr).toContain("was not found in that program");
    const unknown = await runStdinProgram(patch("deadbeef", '[{ find: "a", replace: "b" }]'), folder);
    expect(unknown.code).not.toBe(0);
    expect(unknown.stderr).toContain("No saved program has id deadbeef");
    expect(unknown.stderr).toContain("crashed before printing one must be rerun in full");
    const malformed = await runStdinProgram(patch("program.mjs", '[{ find: "a", replace: "b" }]'), folder);
    expect(malformed.stderr).toContain('needs the id a program printed as "graph program id: ..."');
    expect((await readdir(join(folder, "programs"))).sort()).toEqual([`${id}.mjs`]);
  });

  it("runs the edited program on every call, even the same edit twice in one process", async () => {
    const folder = await programFolder();
    await runStdinProgram(PROGRAM, folder);
    const id = graphProgramId(PROGRAM);
    const twice = `import { rerunGraphProgram } from "${CLIENT}";
const edits = [{ find: 'are serial', replace: 'are batched' }];
await rerunGraphProgram(${JSON.stringify(id)}, edits);
await rerunGraphProgram(${JSON.stringify(id)}, edits);
`;
    const result = await runStdinProgram(twice, folder);
    expect(result.code).toBe(0);
    expect(result.stdout.match(/ran:Edge writes are batched/g)).toHaveLength(2);
  });

  it("keeps concurrent reruns associated with their own program after asynchronous work", async () => {
    const folder = await programFolder();
    const first = PROGRAM.replace('const graph =', 'await new Promise(resolve => setTimeout(resolve, 40));\nconst graph =');
    const second = PROGRAM.replace('const graph =', 'await new Promise(resolve => setTimeout(resolve, 120));\nconst graph =').replace('are serial', 'are parallel');
    await runStdinProgram(first, folder);
    await runStdinProgram(second, folder);
    const firstPatched = first.replace('are serial', 'are repaired');
    const secondPatched = second.replace('are parallel', 'are independent');
    const concurrent = `import { rerunGraphProgram } from "${CLIENT}";
await Promise.all([
  rerunGraphProgram("${graphProgramId(first)}", [{ find: "are serial", replace: "are repaired" }]),
  rerunGraphProgram("${graphProgramId(second)}", [{ find: "are parallel", replace: "are independent" }]),
]);
`;
    const result = await runStdinProgram(concurrent, folder);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`graph program id: ${graphProgramId(firstPatched)}\nran:Edge writes are repaired`);
    expect(result.stdout).toContain(`graph program id: ${graphProgramId(secondPatched)}\nran:Edge writes are independent`);
    expect(await readFile(join(folder, "programs", `${graphProgramId(firstPatched)}.mjs`), "utf8")).toBe(firstPatched);
    expect(await readFile(join(folder, "programs", `${graphProgramId(secondPatched)}.mjs`), "utf8")).toBe(secondPatched);
  });

  it("refuses a short-id collision without replacing the original program", async () => {
    const folder = await programFolder();
    const first = "// graph program 79916\n";
    const second = "// graph program 142722\n";
    const id = graphProgramId(first);
    expect(graphProgramId(second)).toBe(id);
    const remember = (source: string) => `import { RelayerGraphClient } from "${CLIENT}";
process._eval = ${JSON.stringify(source)};
RelayerGraphClient.fromEnv();
`;
    expect((await runStdinProgram(remember(first), folder)).stdout).toBe(`graph program id: ${id}\n`);
    expect((await runStdinProgram(remember(second), folder)).stdout).toContain("unavailable (could not save)");
    expect(await readFile(join(folder, "programs", `${id}.mjs`), "utf8")).toBe(first);
    expect(await readdir(join(folder, "programs"))).toEqual([`${id}.mjs`]);
  });

  it("refuses corrupted saved source before executing or publishing a patch", async () => {
    const folder = await programFolder();
    const id = graphProgramId(PROGRAM);
    await runStdinProgram(PROGRAM, folder);
    await writeFile(join(folder, "programs", `${id}.mjs`), PROGRAM.replace("are serial", "are corrupted"));
    const result = await runStdinProgram(patch(id, '[{ find: "are corrupted", replace: "are repaired" }]'), folder);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("no longer matches its id");
    expect(await readdir(join(folder, "programs"))).toEqual([`${id}.mjs`]);
  });

  it("runs a full program unchanged when the host granted no folder, and says why edits are off", async () => {
    const result = await runStdinProgram(PROGRAM, undefined);
    expect(result).toMatchObject({ code: 0, stdout: "ran:Edge writes are serial\n" });
    expect((await runStdinProgram(patch("deadbeef", '[{ find: "a", replace: "b" }]'), undefined)).stderr).toContain("not available in this run");
    await expect(stat(join(tmpdir(), "programs"))).rejects.toThrow();
  });

  it("tells the model when Node did not expose the program source", async () => {
    // --eval programs have no stdin source; Node sets process._eval to the eval text, so simulate the
    // missing case by clearing it inside the program before the client reads it.
    const folder = await programFolder();
    const program = `process._eval = undefined;\nconst { RelayerGraphClient } = await import("${CLIENT}");\nRelayerGraphClient.fromEnv();\n`;
    const result = await runStdinProgram(program, folder);
    expect(result).toMatchObject({ code: 0, stdout: "graph program id: unavailable (not a stdin program); rerun in full to change it\n" });
    await expect(stat(join(folder, "programs"))).rejects.toThrow();
  });

  it("fails if this Node stops exposing stdin programs on process._eval", async () => {
    const program = `console.log(typeof process._eval === "string" && process._eval.includes("process._eval") ? "eval-present" : "eval-missing");\n`;
    expect(await runStdinProgram(program, undefined)).toMatchObject({ code: 0, stdout: "eval-present\n" });
  });

  it("does not save a program that fails before fromEnv, so an older id stays the one to patch", async () => {
    const folder = await programFolder();
    await runStdinProgram(PROGRAM, folder);
    const broken = await runStdinProgram("throw new SyntaxError(\"broken before fromEnv\");\n", folder);
    expect(broken.code).not.toBe(0);
    expect(broken.stdout).toBe("");
    expect((await readdir(join(folder, "programs"))).sort()).toEqual([`${graphProgramId(PROGRAM)}.mjs`]);
  });

  it("still saves a full program that mentions rerunGraphProgram in a comment", async () => {
    const folder = await programFolder();
    const program = PROGRAM.replace("const title", "// later: rerunGraphProgram(\"id\", edits)\nconst title");
    const result = await runStdinProgram(program, folder);
    expect(result.stdout).toContain(`graph program id: ${graphProgramId(program)}\n`);
    expect(await readFile(join(folder, "programs", `${graphProgramId(program)}.mjs`), "utf8")).toBe(program);
  });
});
