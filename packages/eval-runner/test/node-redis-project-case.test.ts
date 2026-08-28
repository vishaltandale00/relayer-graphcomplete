import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  NODE_REDIS_COMMAND_QUEUE_RACE_CASE_ID,
  NODE_REDIS_REPOSITORY_URL,
  NODE_REDIS_UPSTREAM_COMMIT,
  NODE_REDIS_UPSTREAM_TAG_OBJECT,
  NODE_REDIS_UPSTREAM_TREE,
  NODE_REDIS_VERIFIER_PREDICATE_IDS,
  gradeNodeRedisWorkspace,
  materializeNodeRedisProjectFixture,
  nodeRedisCommandQueueRaceCase,
  nodeRedisVerifierDigest,
  type CommandRunner,
} from "../src/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const directories: string[] = [];
const dependencies = [
  ["denque", "1.5.1", "Apache-2.0"],
  ["redis-commands", "1.7.0", "MIT"],
  ["redis-errors", "1.2.0", "MIT"],
  ["redis-parser", "3.0.0", "MIT"],
] as const;

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("Node Redis command-queue race case", () => {
  it("pins the historical upstream identity and exposes only the safe immutable snapshot", async () => {
    expect(nodeRedisCommandQueueRaceCase.definition).toMatchObject({
      id: NODE_REDIS_COMMAND_QUEUE_RACE_CASE_ID,
      fixture: {
        repositoryUrl: NODE_REDIS_REPOSITORY_URL,
        upstreamTagObject: NODE_REDIS_UPSTREAM_TAG_OBJECT,
        upstreamCommit: NODE_REDIS_UPSTREAM_COMMIT,
        upstreamTree: NODE_REDIS_UPSTREAM_TREE,
        node: "22.23.2",
        packageManager: "npm@10.9.8",
        license: "MIT",
      },
    });
    expect(nodeRedisCommandQueueRaceCase.snapshot.authoringStatus).toBe("candidate");
    expect(nodeRedisCommandQueueRaceCase.snapshot.artifacts.verifier.mandatoryGates.map(({ id }) => id)).toEqual([
      "queue-cleanup",
      "reconnect-integrity",
      "repeated-failure-safety",
      "reply-mode-regression",
      "node-redis-scoped-clean-commit",
    ]);
    expect(nodeRedisCommandQueueRaceCase.snapshot.artifacts.task.text).toContain("retired Node/libuv timing");
    expect(nodeRedisCommandQueueRaceCase.catalogSnapshot.artifacts.reference).not.toHaveProperty("sealedPath");
    expect(nodeRedisCommandQueueRaceCase.catalogSnapshot.artifacts.verifier).not.toHaveProperty("sealedPath");
    expect(JSON.stringify(nodeRedisCommandQueueRaceCase.catalogSnapshot)).not.toContain("reference.patch");
    expect(JSON.stringify(nodeRedisCommandQueueRaceCase.definition)).not.toContain("d8116963d4707ca38165a177259fd65809e3a83b");
    expect(nodeRedisCommandQueueRaceCase.snapshotDigest).toMatch(/^sha256:[a-f0-9]{64}$/);

    const reference = nodeRedisCommandQueueRaceCase.snapshot.artifacts.reference;
    const bytes = await readFile(resolve(repositoryRoot, reference.sealedPath));
    expect(`sha256:${createHash("sha256").update(bytes).digest("hex")}`).toBe(reference.contentDigest);
    expect(nodeRedisCommandQueueRaceCase.snapshot.artifacts.verifier.contentDigest).toBe(nodeRedisVerifierDigest());
  });

  it("materializes a clean pinned checkout with exact production-only dependencies", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-node-redis-materializer-test-"));
    directories.push(root);
    const cacheDirectory = join(root, "cache");
    const workspaceDirectory = join(root, "execution", "workspace");
    await createFixtureFiles(cacheDirectory);
    const calls: string[] = [];
    const runCommand: CommandRunner = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "git" && args[0] === "clone") await cp(cacheDirectory, workspaceDirectory, { recursive: true });
      if (command === "git" && args[0] === "rev-parse") {
        return { exitCode: 0, stdout: `${args[1] === "HEAD^{tree}" ? NODE_REDIS_UPSTREAM_TREE : NODE_REDIS_UPSTREAM_COMMIT}\n`, stderr: "" };
      }
      if (command === "npm" && args[0] === "--version") return { exitCode: 0, stdout: "10.9.8\n", stderr: "" };
      if (command === "npm") await createInstalledDependencies(workspaceDirectory);
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const receipt = await materializeNodeRedisProjectFixture({
      cacheDirectory,
      workspaceDirectory,
      platform: "darwin",
      architecture: "arm64",
      nodeVersion: "22.23.2",
      npmVersion: "10.9.8",
      runCommand,
    });

    expect(receipt).toMatchObject({
      fixtureId: NODE_REDIS_COMMAND_QUEUE_RACE_CASE_ID,
      upstreamCommit: NODE_REDIS_UPSTREAM_COMMIT,
      upstreamTree: NODE_REDIS_UPSTREAM_TREE,
      sourceRevision: `git-tree:${NODE_REDIS_UPSTREAM_TREE}`,
      nodeVersion: "22.23.2",
      npmVersion: "10.9.8",
      architecture: "arm64",
      installedExactRuntimeDependencies: true,
    });
    const install = calls.find((call) => call.startsWith("npm install"));
    expect(install).toContain("--ignore-scripts");
    expect(install).toContain("--package-lock=false");
    expect(install).toContain("--omit=dev");
    for (const [name, version] of dependencies) expect(install).toContain(`${name}@${version}`);
  });

  it("fails closed on unsupported platforms and maintained-runtime drift", async () => {
    const unused: CommandRunner = async () => { throw new Error("must not run"); };
    await expect(materializeNodeRedisProjectFixture({
      cacheDirectory: "/unused/cache",
      workspaceDirectory: "/unused/workspace",
      platform: "linux",
      runCommand: unused,
    })).rejects.toThrow("local Mac only");
    await expect(materializeNodeRedisProjectFixture({
      cacheDirectory: "/unused/cache",
      workspaceDirectory: "/unused/workspace",
      platform: "darwin",
      architecture: "arm64",
      nodeVersion: "20.19.0",
      runCommand: unused,
    })).rejects.toThrow("Node 22.23.2");
  });

  it("records sealed public-seam predicates independently in a pristine verifier clone", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-node-redis-grader-test-"));
    directories.push(root);
    await mkdir(join(root, "test"), { recursive: true });
    await writeFile(join(root, "index.js"), "module.exports = {};\n");
    await writeFile(join(root, "test", "command-queue-race.test.js"), "// focused candidate regression\n");
    const predicateIds = NODE_REDIS_VERIFIER_PREDICATE_IDS;
    const verifierDirectories: string[] = [];
    const runCommand: CommandRunner = async (command, args, options) => {
      if (command === "git" && args[0] === "status") return { exitCode: 0, stdout: "", stderr: "" };
      if (command === "git" && args[0] === "rev-list") return { exitCode: 0, stdout: "candidate-commit\n", stderr: "" };
      if (command === "git" && args[0] === "diff" && args[1] === "--name-status") {
        return { exitCode: 0, stdout: "M\tindex.js\nA\ttest/command-queue-race.test.js\n", stderr: "" };
      }
      if (command === "git" && args[0] === "diff" && args[1] === "--binary") return { exitCode: 0, stdout: "", stderr: "" };
      if (command === "git" && args[0] === "ls-tree") return { exitCode: 0, stdout: "100644 blob test-blob\ttest/command-queue-race.test.js\n", stderr: "" };
      if (command === "git" && args[0] === "show") return { exitCode: 0, stdout: "// focused candidate regression\n", stderr: "" };
      if (command === "git" && args[0] === "clone") {
        await cp(root, args.at(-1)!, { recursive: true });
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (command === "git" && args[0] === "checkout") return { exitCode: 0, stdout: "", stderr: "" };
      if (command === "npm") {
        if (args[0] === "--version") return { exitCode: 0, stdout: "10.9.8\n", stderr: "" };
        await createInstalledDependencies(options.cwd);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (command === process.execPath) {
        verifierDirectories.push(options.cwd);
        if (args[0] === "test/command-queue-race.test.js") return { exitCode: options.cwd.includes("baseline-regression") ? 1 : 0, stdout: "", stderr: "" };
        return {
          exitCode: 0,
          stdout: `${JSON.stringify({ schemaVersion: 1, predicates: predicateIds.map((id) => ({ id, passed: true, detail: `${id} passed` })) })}\n`,
          stderr: "",
        };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    };

    const checks = await gradeNodeRedisWorkspace({ workspaceDirectory: root, runCommand });
    expect(checks.every(({ passed }) => passed)).toBe(true);
    expect(checks.filter(({ name }) => name.startsWith("workspace:node-redis:")).map(({ name }) => name)).toEqual([
      "workspace:node-redis:candidate-regression-passes",
      ...predicateIds.map((id) => `workspace:node-redis:${id}`),
      "workspace:node-redis:focused-source-and-tests",
      "workspace:node-redis:dependency-safe-scope",
      "workspace:node-redis:meaningful-commit",
      "workspace:node-redis:implementation-clean",
    ]);
    expect(verifierDirectories).toHaveLength(3);
    expect(verifierDirectories[0]).not.toBe(root);
  });

  it("keeps qualification behavioral and rejects protected dependency mutations", async () => {
    const verifierSource = await readFile(resolve(repositoryRoot, "eval-cases/node-redis-command-queue-race/verifier/deterministic-socket-race.cjs"), "utf8");
    expect(verifierSource).not.toContain("reference.patch");
    expect(verifierSource).not.toContain("index.js");
    expect(verifierSource).not.toContain("require(path.resolve(workspace))");

    const root = await mkdtemp(join(tmpdir(), "relayer-node-redis-protected-test-"));
    directories.push(root);
    const runCommand: CommandRunner = async (command, args) => {
      if (command === "git" && args[0] === "status") return { exitCode: 0, stdout: "", stderr: "" };
      if (command === "git" && args[0] === "rev-list") return { exitCode: 0, stdout: "commit\n", stderr: "" };
      if (command === "git" && args[0] === "diff" && args[1] === "--name-status") {
        return { exitCode: 0, stdout: "M\tindex.js\nA\ttest/command-queue-race.test.js\nR100\tpackage.json\tpackage-renamed.json\n", stderr: "" };
      }
      if (command === "git" && args[0] === "diff" && args[1] === "--binary") throw new Error("candidate patch rejected for test");
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    };
    const checks = await gradeNodeRedisWorkspace({ workspaceDirectory: root, runCommand });
    expect(checks.find(({ name }) => name.endsWith("dependency-safe-scope"))?.passed).toBe(false);
    expect(checks.find(({ name }) => name.endsWith("pristine-verifier-workspace"))?.passed).toBe(false);
  });
});

async function createFixtureFiles(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({
    name: "redis",
    version: "3.1.2",
    license: "MIT",
    engines: { node: ">=10" },
  }));
  await writeFile(join(directory, "LICENSE"), "MIT License\n\nCopyright (c) 2016-present Node Redis contributors.\n");
}

async function createInstalledDependencies(directory: string): Promise<void> {
  const packages: Record<string, unknown> = { "": {} };
  for (const [name, version, license] of dependencies) {
    const dependencyDirectory = join(directory, "node_modules", name);
    await mkdir(dependencyDirectory, { recursive: true });
    await writeFile(join(dependencyDirectory, "package.json"), JSON.stringify({ name, version, license }));
    const integrity = {
      denque: "sha512-XwE+iZ4D6ZUB7mfYRMb5wByE8L74HCn30FBN7sWnXksWc1LO1bPDl67pBR9o/kC4z/xSNAwkMYcGgqDV3BE3Hw==",
      "redis-commands": "sha512-nJWqw3bTFy21hX/CPKHth6sfhZbdiHP6bTawSgQBlKOVRG7EZkfHbbHwQJnrE4vsQf0CMNE+3gJ4Fmm16vdVlQ==",
      "redis-errors": "sha512-1qny3OExCf0UvUV/5wpYKf2YwPcOqXzkwKKSmKHiE6ZMQs5heeE/c8eXK+PNllPvmjgAbfnsbpkGZWy8cBpn9w==",
      "redis-parser": "sha512-DJnGAeenTdpMEH6uAJRK/uiyEIH9WVsUmoLwzudwGJUwZPp80PDBWPHXSAGNPwNvIXAbe7MSUB1zQFugFml66A==",
    }[name];
    packages[`node_modules/${name}`] = {
      version,
      resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
      integrity,
    };
  }
  await writeFile(join(directory, "node_modules", ".package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages }));
}
