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
  it("defines one ordered shared-project workflow with three two-turn threads", () => {
    expect(h3ProjectEvalCase).toMatchObject({
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
    expect(h3ProjectEvalCase.threads.map((thread) => [thread.id, thread.permissionProfileId, thread.mutationPolicy, thread.prompts.length])).toEqual([
      ["architecture", "auto", "read-only", 2],
      ["diagnosis", "auto", "read-only", 2],
      ["implementation", "auto", "writable", 2],
    ]);
    expect(h3ProjectEvalCase.threads.flatMap((thread) => thread.prompts)).toHaveLength(6);
    expect(h3ProjectEvalCase.threads[0]!.prompts[1]).toContain("Think deeper");
    expect(h3ProjectEvalCase.threads[1]!.prompts[1]).toContain("competing hypothesis");
    expect(h3ProjectEvalCase.threads[2]!.prompts[1]).toContain("second meaningful local commit");
  });

  it("applies only the intentional integer-to-finite seeded change", () => {
    const source = "before Number.isInteger(statusCode) after";
    expect(seedH3SanitizerSource(source)).toBe("before Number.isFinite(statusCode) after");
    expect(() => seedH3SanitizerSource("Number.isFinite(statusCode)")).toThrow("does not match");
    expect(() => seedH3SanitizerSource(`${source} ${source}`)).toThrow("does not match");
  });

  it("materializes from a verified cache, makes the deterministic seed commit, and installs frozen", async () => {
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

    expect(receipt).toMatchObject({
      workspaceDirectory,
      seededCommit: H3_SEEDED_COMMIT,
      seededTree: H3_SEEDED_TREE,
      installedWithFrozenLockfile: true,
    });
    expect(calls).toContain(`corepack ${H3_PACKAGE_MANAGER} install --frozen-lockfile`);
    expect(calls).toContain("git commit -m Seed status-code decimal validation bug");
  });

  it("rejects non-Mac and unsupported Node materialization before touching a checkout", async () => {
    const unused: CommandRunner = async () => { throw new Error("must not run"); };
    await expect(materializeH3ProjectFixture({
      cacheDirectory: "/unused/cache",
      workspaceDirectory: "/unused/workspace",
      platform: "linux",
      runCommand: unused,
    })).rejects.toThrow("local Mac only");
    await expect(materializeH3ProjectFixture({
      cacheDirectory: "/unused/cache",
      workspaceDirectory: "/unused/workspace",
      platform: "darwin",
      nodeVersion: "20.11.0",
      runCommand: unused,
    })).rejects.toThrow("requires Node");
  });
});

describe("h3 deterministic workspace grading", () => {
  it("requires zero diff for question and diagnosis and expects the seeded hidden failure", async () => {
    const runCommand: CommandRunner = async (command, args) => {
      if (command === "git" && args[0] === "rev-parse") return { exitCode: 0, stdout: `${H3_SEEDED_COMMIT}\n`, stderr: "" };
      if (command === "git" && args[0] === "status") return { exitCode: 0, stdout: "", stderr: "" };
      if (command === "git" && args[0] === "diff") return { exitCode: 0, stdout: "", stderr: "" };
      if (command === "node") return { exitCode: 1, stdout: "", stderr: "decimal leaked" };
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    };
    expect((await gradeH3Workspace({ workspaceDirectory: "/fixture", grade: "question", runCommand })).every((check) => check.passed)).toBe(true);
    const diagnosis = await gradeH3Workspace({ workspaceDirectory: "/fixture", grade: "diagnosis", runCommand });
    expect(diagnosis.every((check) => check.passed)).toBe(true);
    expect(diagnosis.at(-1)?.name).toBe("workspace:diagnosis-reproduces-seeded-failure");
  });

  it("requires build, typecheck, hidden behavior, focused files, clean state, and two meaningful commits", async () => {
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
    expect(checks.map((check) => check.name)).toEqual([
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
    expect(checks.every((check) => check.passed)).toBe(true);
    expect(verifierCommandDirectories).not.toContain(root);
    expect(new Set(verifierCommandDirectories)).toHaveLength(1);

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
    expect(autonomousChecks.find((check) => check.name === "workspace:implementation-meaningful-commit")?.passed).toBe(true);
    expect(autonomousChecks.every((check) => check.passed)).toBe(true);
  });

  it("accepts different valid implementation shapes and is deterministic across repeated grading", async () => {
    const implementations = [
      `export function sanitizeStatusCode(input?: string | number, fallback = 200) {
        const normalized = Number(input);
        return Number.isSafeInteger(normalized) && normalized >= 100 && normalized <= 599 ? normalized : fallback;
      }`,
      `export function sanitizeStatusCode(input?: string | number, fallback = 200) {
        const normalized = Number(input);
        const whole = Number.isFinite(normalized) && Math.trunc(normalized) === normalized;
        return whole && normalized >= 100 && normalized <= 599 ? normalized : fallback;
      }`,
      `export function sanitizeStatusCode(input?: string | number, fallback = 200) {
        if (!/^\\d+$/.test(String(input))) return fallback;
        const normalized = Number(input);
        return normalized >= 100 && normalized <= 599 ? normalized : fallback;
      }`,
    ];
    for (const source of implementations) {
      const root = await createBehaviorWorkspace(source, 'sanitizeStatusCode("404.1")\nsanitizeStatusCode("599.5", 418)\n');
      const verdicts: string[][] = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const checks = await gradeH3Workspace({
          workspaceDirectory: root,
          grade: "autonomous-implementation",
          runCommand: behaviorWorkspaceRunner(root),
        });
        expect(checks.filter((check) => check.name.startsWith("workspace:behavior-")).every((check) => check.passed)).toBe(true);
        expect(checks.some((check) => check.name.includes("validation-boundary"))).toBe(false);
        verdicts.push(checks.map((check) => `${check.name}:${check.passed}`));
      }
      expect(new Set(verdicts.map((verdict) => JSON.stringify(verdict)))).toHaveLength(1);
    }
  });

  it("attributes a decimal-string-only near miss to the exact behavioral requirement", async () => {
    const root = await createBehaviorWorkspace(`
      export function sanitizeStatusCode(input?: string | number, fallback = 200) {
        const normalized = Number(input);
        if (typeof input === "number" && !Number.isInteger(normalized)) return fallback;
        return Number.isFinite(normalized) && normalized >= 100 && normalized <= 599 ? normalized : fallback;
      }
    `, "candidate tests are not verifier evidence\n");
    const checks = await gradeH3Workspace({
      workspaceDirectory: root,
      grade: "autonomous-implementation",
      runCommand: behaviorWorkspaceRunner(root),
    });
    const behavior = Object.fromEntries(checks.filter((check) => check.name.startsWith("workspace:behavior-")).map((check) => [check.name, check]));

    expect(behavior["workspace:behavior-decimal-number"]?.passed).toBe(true);
    expect(behavior["workspace:behavior-decimal-numeric-string"]?.passed).toBe(false);
    expect(behavior["workspace:behavior-decimal-numeric-string"]?.detail).toContain('"404.1"');
  });

  it("keeps the seeded finite-only validation red on both decimal requirements", async () => {
    const root = await createBehaviorWorkspace(`
      export function sanitizeStatusCode(input?: string | number, fallback = 200) {
        const normalized = Number(input);
        return Number.isFinite(normalized) && normalized >= 100 && normalized <= 599 ? normalized : fallback;
      }
    `, "");
    const checks = await gradeH3Workspace({
      workspaceDirectory: root,
      grade: "autonomous-implementation",
      runCommand: behaviorWorkspaceRunner(root),
    });
    const behavior = Object.fromEntries(checks.filter((check) => check.name.startsWith("workspace:behavior-")).map((check) => [check.name, check.passed]));

    expect(behavior["workspace:behavior-decimal-number"]).toBe(false);
    expect(behavior["workspace:behavior-decimal-numeric-string"]).toBe(false);
    expect(behavior["workspace:behavior-lower-boundary"]).toBe(true);
    expect(behavior["workspace:behavior-upper-boundary"]).toBe(true);
  });
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
