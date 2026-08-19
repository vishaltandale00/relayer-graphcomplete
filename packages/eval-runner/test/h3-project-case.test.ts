import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
    expect(h3ProjectEvalCase.threads.map((thread) => [thread.id, thread.mutationPolicy, thread.prompts.length])).toEqual([
      ["architecture", "read-only", 2],
      ["diagnosis", "read-only", 2],
      ["implementation", "writable", 2],
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
      'sanitizeStatusCode("200.5")',
    ].join("\n"));
    const runCommand: CommandRunner = async (command, args) => {
      if (command === "node" || command === "corepack") return { exitCode: 0, stdout: "ok", stderr: "" };
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
      "workspace:implementation-hidden-decimal-check",
      "workspace:implementation-focused-files",
      "workspace:implementation-validation-boundary",
      "workspace:implementation-two-meaningful-commits",
      "workspace:implementation-clean",
    ]);
    expect(checks.every((check) => check.passed)).toBe(true);
  });
});
