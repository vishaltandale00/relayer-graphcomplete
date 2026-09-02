import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  gradeH3Workspace,
  H3_PACKAGE_MANAGER,
  H3_PROJECT_CASE_ID,
  H3_SEEDED_COMMIT,
  H3_SEEDED_TREE,
  H3_SEED_PATH,
  H3_TEST_PATH,
  H3_UPSTREAM_COMMIT,
  H3_UPSTREAM_TREE,
  h3ProjectEvalCase,
  materializeH3ProjectFixture,
  seedH3SanitizerSource,
  type CommandRunner,
} from "../src/project-cases/h3.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("pinned h3 project case", () => {
  it("defines, seeds, and materializes the pinned h3 project on the declared platform", async () => {
    expect(h3ProjectEvalCase, "one ordered shared-project workflow").toMatchObject({
      id: H3_PROJECT_CASE_ID,
      localOnly: true,
      supportedPlatform: "darwin",
      fixture: {
        upstreamCommit: H3_UPSTREAM_COMMIT,
        upstreamTree: H3_UPSTREAM_TREE,
        seededCommit: H3_SEEDED_COMMIT,
        seededTree: H3_SEEDED_TREE,
        packageManager: H3_PACKAGE_MANAGER,
        license: "MIT",
      },
    });
    expect(
      h3ProjectEvalCase.threads.map((thread) => [thread.id, thread.permissionProfileId, thread.mutationPolicy, thread.prompts.length]),
      "three two-turn threads in workflow order",
    ).toEqual([
      ["architecture", "auto", "read-only", 2],
      ["diagnosis", "auto", "read-only", 2],
      ["implementation", "auto", "writable", 2],
    ]);
    expect(h3ProjectEvalCase.threads.flatMap((thread) => thread.prompts), "six prompts total").toHaveLength(6);
    expect(h3ProjectEvalCase.threads[0]!.prompts[1], "the architecture deepening prompt").toContain("Think deeper");
    expect(h3ProjectEvalCase.threads[1]!.prompts[1], "the diagnosis deepening prompt").toContain("competing hypothesis");
    expect(h3ProjectEvalCase.threads[2]!.prompts[1], "the implementation deepening prompt").toContain("second meaningful local commit");

    const source = "before Number.isInteger(statusCode) after";
    expect(seedH3SanitizerSource(source), "the seed applies the intentional integer-to-finite change").toBe("before Number.isFinite(statusCode) after");
    expect(() => seedH3SanitizerSource("Number.isFinite(statusCode)"), "an already-seeded source is rejected").toThrow("does not match");
    expect(() => seedH3SanitizerSource(`${source} ${source}`), "an ambiguous source is rejected").toThrow("does not match");

    const root = await mkdtemp(join(tmpdir(), "relayer-h3-case-test-"));
    directories.push(root);
    const cacheDirectory = join(root, "cache");
    const workspaceDirectory = join(root, "execution", "workspace");
    await mkdir(join(cacheDirectory, "src", "utils"), { recursive: true });
    await writeFile(join(cacheDirectory, "package.json"), JSON.stringify({
      license: "MIT",
      packageManager: H3_PACKAGE_MANAGER,
      engines: { node: ">=20.11.1" },
    }));
    await writeFile(join(cacheDirectory, "LICENSE"), "MIT License\nfixture\n");
    await writeFile(join(cacheDirectory, H3_SEED_PATH), "if (!Number.isInteger(statusCode)) return 200;\n");
    let committed = false;
    const calls: string[] = [];
    const runCommand: CommandRunner = async (command, args, options) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "corepack") return { exitCode: 0, stdout: "installed", stderr: "" };
      if (command === "git" && args[0] === "clone") {
        await cp(cacheDirectory, workspaceDirectory, { recursive: true });
      }
      if (command === "git" && args[0] === "commit") committed = true;
      if (command === "git" && args[0] === "rev-parse") {
        const parent = args[1] === "HEAD^";
        const tree = args[1] === "HEAD^{tree}";
        return {
          exitCode: 0,
          stdout: `${parent ? H3_UPSTREAM_COMMIT : tree ? (committed ? H3_SEEDED_TREE : H3_UPSTREAM_TREE) : (committed ? H3_SEEDED_COMMIT : H3_UPSTREAM_COMMIT)}\n`,
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const receipt = await materializeH3ProjectFixture({
      cacheDirectory,
      workspaceDirectory,
      platform: "darwin",
      nodeVersion: "20.11.1",
      runCommand,
    });

    expect(receipt, "materialization produces a verified seeded receipt").toMatchObject({
      workspaceDirectory,
      seededCommit: H3_SEEDED_COMMIT,
      seededTree: H3_SEEDED_TREE,
      installedWithFrozenLockfile: true,
    });
    expect(calls, "dependencies install frozen through corepack").toContain(`corepack ${H3_PACKAGE_MANAGER} install --frozen-lockfile`);
    expect(calls, "the deterministic seed commit is made").toContain("git commit -m Seed status-code decimal validation bug");

    const unused: CommandRunner = async () => { throw new Error("must not run"); };
    await expect(materializeH3ProjectFixture({
      cacheDirectory: "/unused/cache",
      workspaceDirectory: "/unused/workspace",
      platform: "linux",
      runCommand: unused,
    }), "non-Mac materialization is rejected before touching a checkout").rejects.toThrow("local Mac only");
    await expect(materializeH3ProjectFixture({
      cacheDirectory: "/unused/cache",
      workspaceDirectory: "/unused/workspace",
      platform: "darwin",
      nodeVersion: "20.11.0",
      runCommand: unused,
    }), "unsupported Node materialization is rejected before touching a checkout").rejects.toThrow("requires Node");
  });
});

describe("h3 deterministic workspace grading", () => {
  it("grades implementation work against the seeded hidden failure", async () => {
    const zeroDiffRunner: CommandRunner = async (command, args) => {
      if (command === "git" && args[0] === "rev-parse") return { exitCode: 0, stdout: `${H3_SEEDED_COMMIT}\n`, stderr: "" };
      if (command === "git" && args[0] === "status") return { exitCode: 0, stdout: "", stderr: "" };
      if (command === "git" && args[0] === "diff") return { exitCode: 0, stdout: "", stderr: "" };
      if (command === "node") return { exitCode: 1, stdout: "", stderr: "decimal leaked" };
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    };
    expect(
      (await gradeH3Workspace({ workspaceDirectory: "/fixture", grade: "question", runCommand: zeroDiffRunner })).every((check) => check.passed),
      "the question grade requires a zero diff",
    ).toBe(true);
    const diagnosis = await gradeH3Workspace({ workspaceDirectory: "/fixture", grade: "diagnosis", runCommand: zeroDiffRunner });
    expect(diagnosis.every((check) => check.passed), "the diagnosis grade requires a zero diff").toBe(true);
    expect(diagnosis.at(-1)?.name, "the diagnosis grade expects the seeded hidden failure").toBe("workspace:diagnosis-reproduces-seeded-failure");

    const root = await mkdtemp(join(tmpdir(), "relayer-h3-grade-test-"));
    directories.push(root);
    await mkdir(join(root, "src", "utils"), { recursive: true });
    await mkdir(join(root, "test", "unit"), { recursive: true });
    await writeFile(join(root, H3_SEED_PATH), "if (!Number.isInteger(statusCode)) return 200;\n");
    await writeFile(join(root, H3_TEST_PATH), [
      "sanitizeStatusCode(100)",
      "sanitizeStatusCode(599)",
      'sanitizeStatusCode("599")',
      "sanitizeStatusCode(200.5)",
      'sanitizeStatusCode("404.1")',
      'sanitizeStatusCode("599.5", 418)',
    ].join("\n"));
    const verifierCommandDirectories: string[] = [];
    const runCommand: CommandRunner = async (command, args, options) => {
      if (command === "corepack") return { exitCode: 0, stdout: "installed", stderr: "" };
      if (command === "node" || command.includes("/node_modules/.bin/")) {
        verifierCommandDirectories.push(options.cwd);
        return { exitCode: 0, stdout: "ok", stderr: "" };
      }
      if (command === "git" && args[0] === "clone") {
        await cp(root, args.at(-1)!, { recursive: true });
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (command === "git" && (args[0] === "checkout" || args[0] === "apply")) return { exitCode: 0, stdout: "", stderr: "" };
      if (command === "git" && args[0] === "diff" && args[1] === "--binary") return { exitCode: 0, stdout: "", stderr: "" };
      if (command === "git" && args[0] === "status") return { exitCode: 0, stdout: "", stderr: "" };
      if (command === "git" && args[0] === "rev-list") return { exitCode: 0, stdout: "commit-one\ncommit-two\n", stderr: "" };
      if (command === "git" && args[0] === "diff" && args[1] === "--name-only") {
        return { exitCode: 0, stdout: `${H3_SEED_PATH}\n${H3_TEST_PATH}\n`, stderr: "" };
      }
      if (command === "git" && args[0] === "diff-tree") {
        return { exitCode: 0, stdout: `${args.at(-1) === "commit-one" ? H3_SEED_PATH : H3_TEST_PATH}\n`, stderr: "" };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    };

    const checks = await gradeH3Workspace({ workspaceDirectory: root, grade: "implementation", runCommand });
    expect(checks.map((check) => check.name), "the implementation grade runs the full deterministic checklist").toEqual([
      "workspace:implementation-build",
      "workspace:implementation-typecheck",
      "workspace:implementation-focused-tests",
      "workspace:behavior-lower-boundary",
      "workspace:behavior-upper-boundary",
      "workspace:behavior-decimal-number",
      "workspace:behavior-integer-numeric-string",
      "workspace:behavior-decimal-numeric-string",
      "workspace:behavior-custom-fallback",
      "workspace:implementation-focused-files",
      "workspace:implementation-two-meaningful-commits",
      "workspace:implementation-clean",
    ]);
    expect(checks.every((check) => check.passed), "a complete implementation passes every check").toBe(true);
    expect(verifierCommandDirectories, "verifier commands never run inside the candidate workspace").not.toContain(root);
    expect(new Set(verifierCommandDirectories), "verifier commands run in one isolated directory").toHaveLength(1);

    const autonomousRunCommand: CommandRunner = async (command, args) => {
      if (command === "corepack") return { exitCode: 0, stdout: "installed", stderr: "" };
      if (command === "node" || command.includes("/node_modules/.bin/")) return { exitCode: 0, stdout: "ok", stderr: "" };
      if (command === "git" && args[0] === "clone") {
        await cp(root, args.at(-1)!, { recursive: true });
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (command === "git" && (args[0] === "checkout" || args[0] === "apply")) return { exitCode: 0, stdout: "", stderr: "" };
      if (command === "git" && args[0] === "diff" && args[1] === "--binary") return { exitCode: 0, stdout: "", stderr: "" };
      if (command === "git" && args[0] === "status") return { exitCode: 0, stdout: "", stderr: "" };
      if (command === "git" && args[0] === "rev-list") return { exitCode: 0, stdout: "one-autonomous-commit\n", stderr: "" };
      if (command === "git" && args[0] === "diff" && args[1] === "--name-only") {
        return { exitCode: 0, stdout: `${H3_SEED_PATH}\n${H3_TEST_PATH}\n`, stderr: "" };
      }
      if (command === "git" && args[0] === "diff-tree") {
        return { exitCode: 0, stdout: `${H3_SEED_PATH}\n${H3_TEST_PATH}\n`, stderr: "" };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    };
    const autonomousChecks = await gradeH3Workspace({
      workspaceDirectory: root,
      grade: "autonomous-implementation",
      runCommand: autonomousRunCommand,
    });
    expect(
      autonomousChecks.find((check) => check.name === "workspace:implementation-meaningful-commit")?.passed,
      "the autonomous grade accepts a single meaningful commit",
    ).toBe(true);
    expect(autonomousChecks.every((check) => check.passed), "the autonomous grade passes a complete implementation").toBe(true);

    const validImplementations: readonly [label: string, source: string][] = [
      ["safe-integer range check", `export function sanitizeStatusCode(input?: string | number, fallback = 200) {
        const normalized = Number(input);
        return Number.isSafeInteger(normalized) && normalized >= 100 && normalized <= 599 ? normalized : fallback;
      }`],
      ["finite-plus-trunc whole check", `export function sanitizeStatusCode(input?: string | number, fallback = 200) {
        const normalized = Number(input);
        const whole = Number.isFinite(normalized) && Math.trunc(normalized) === normalized;
        return whole && normalized >= 100 && normalized <= 599 ? normalized : fallback;
      }`],
      ["digit-string guard", `export function sanitizeStatusCode(input?: string | number, fallback = 200) {
        if (!/^\\d+$/.test(String(input))) return fallback;
        const normalized = Number(input);
        return normalized >= 100 && normalized <= 599 ? normalized : fallback;
      }`],
    ];
    expect(validImplementations, "every accepted implementation shape is a named row").toHaveLength(3);
    for (const [label, source] of validImplementations) {
      const shapeRoot = await createBehaviorWorkspace(source, 'sanitizeStatusCode("404.1")\nsanitizeStatusCode("599.5", 418)\n');
      const verdicts: string[][] = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const shapeChecks = await gradeH3Workspace({
          workspaceDirectory: shapeRoot,
          grade: "autonomous-implementation",
          runCommand: behaviorWorkspaceRunner(shapeRoot),
        });
        expect.soft(
          shapeChecks.filter((check) => check.name.startsWith("workspace:behavior-")).every((check) => check.passed),
          `${label}: every behavior check passes`,
        ).toBe(true);
        expect.soft(
          shapeChecks.some((check) => check.name.includes("validation-boundary")),
          `${label}: no validation-boundary check appears`,
        ).toBe(false);
        verdicts.push(shapeChecks.map((check) => `${check.name}:${check.passed}`));
      }
      expect.soft(
        new Set(verdicts.map((verdict) => JSON.stringify(verdict))),
        `${label}: repeated grading is deterministic`,
      ).toHaveLength(1);
    }

    const nearMissRoot = await createBehaviorWorkspace(`
      export function sanitizeStatusCode(input?: string | number, fallback = 200) {
        const normalized = Number(input);
        if (typeof input === "number" && !Number.isInteger(normalized)) return fallback;
        return Number.isFinite(normalized) && normalized >= 100 && normalized <= 599 ? normalized : fallback;
      }
    `, "candidate tests are not verifier evidence\n");
    const nearMissChecks = await gradeH3Workspace({
      workspaceDirectory: nearMissRoot,
      grade: "autonomous-implementation",
      runCommand: behaviorWorkspaceRunner(nearMissRoot),
    });
    const nearMiss = Object.fromEntries(nearMissChecks.filter((check) => check.name.startsWith("workspace:behavior-")).map((check) => [check.name, check]));
    expect(nearMiss["workspace:behavior-decimal-number"]?.passed, "the near miss passes the decimal-number requirement").toBe(true);
    expect(nearMiss["workspace:behavior-decimal-numeric-string"]?.passed, "the near miss fails only the decimal-numeric-string requirement").toBe(false);
    expect(nearMiss["workspace:behavior-decimal-numeric-string"]?.detail, "the failure names the offending input").toContain('"404.1"');

    const seededRoot = await createBehaviorWorkspace(`
      export function sanitizeStatusCode(input?: string | number, fallback = 200) {
        const normalized = Number(input);
        return Number.isFinite(normalized) && normalized >= 100 && normalized <= 599 ? normalized : fallback;
      }
    `, "");
    const seededChecks = await gradeH3Workspace({
      workspaceDirectory: seededRoot,
      grade: "autonomous-implementation",
      runCommand: behaviorWorkspaceRunner(seededRoot),
    });
    const seeded = Object.fromEntries(seededChecks.filter((check) => check.name.startsWith("workspace:behavior-")).map((check) => [check.name, check.passed]));
    expect(seeded["workspace:behavior-decimal-number"], "the seeded finite-only validation stays red on decimal numbers").toBe(false);
    expect(seeded["workspace:behavior-decimal-numeric-string"], "the seeded finite-only validation stays red on decimal strings").toBe(false);
    expect(seeded["workspace:behavior-lower-boundary"], "the seeded validation keeps the lower boundary").toBe(true);
    expect(seeded["workspace:behavior-upper-boundary"], "the seeded validation keeps the upper boundary").toBe(true);
  }, 20_000);
});

async function createBehaviorWorkspace(source: string, tests: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "relayer-h3-behavior-test-"));
  directories.push(root);
  await mkdir(join(root, "src", "utils"), { recursive: true });
  await mkdir(join(root, "test", "unit"), { recursive: true });
  await writeFile(join(root, H3_SEED_PATH), source);
  await writeFile(join(root, H3_TEST_PATH), tests);
  return root;
}

function behaviorWorkspaceRunner(root: string): CommandRunner {
  return async (command, args, options) => {
    if (command === "corepack") return { exitCode: 0, stdout: "installed", stderr: "" };
    if (command === "node") return execute(command, args, options.cwd);
    if (command.includes("/node_modules/.bin/")) return { exitCode: 0, stdout: "ok", stderr: "" };
    if (command === "git" && args[0] === "clone") {
      await cp(root, args.at(-1)!, { recursive: true });
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (command === "git" && (args[0] === "checkout" || args[0] === "apply")) return { exitCode: 0, stdout: "", stderr: "" };
    if (command === "git" && args[0] === "diff" && args[1] === "--binary") return { exitCode: 0, stdout: "", stderr: "" };
    if (command === "git" && args[0] === "status") return { exitCode: 0, stdout: "", stderr: "" };
    if (command === "git" && args[0] === "rev-list") return { exitCode: 0, stdout: "candidate-commit\n", stderr: "" };
    if (command === "git" && args[0] === "diff" && args[1] === "--name-only") {
      return { exitCode: 0, stdout: `${H3_SEED_PATH}\n${H3_TEST_PATH}\n`, stderr: "" };
    }
    if (command === "git" && args[0] === "diff-tree") return { exitCode: 0, stdout: `${H3_SEED_PATH}\n${H3_TEST_PATH}\n`, stderr: "" };
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  };
}

function execute(command: string, args: readonly string[], cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });
}
