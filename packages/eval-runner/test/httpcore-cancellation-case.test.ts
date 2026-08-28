import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  gradeHTTPCoreCancellationWorkspace,
  HTTPCORE_CANCELLATION_CASE_ID,
  HTTPCORE_PYTHON_VERSION,
  HTTPCORE_UPSTREAM_COMMIT,
  HTTPCORE_UPSTREAM_TREE,
  httpcoreCancellationCase,
  httpcoreCancellationCases,
  materializeHTTPCoreCancellationFixture,
  type CommandRunner,
} from "../src/index.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("HTTPCore cancellation case contract", () => {
  it("publishes one sanitized immutable debugging case without prescribing a patch", () => {
    expect(httpcoreCancellationCases).toHaveLength(1);
    expect(httpcoreCancellationCase.definition).toMatchObject({
      id: HTTPCORE_CANCELLATION_CASE_ID,
      autonomous: true,
      category: "coding",
      taskType: "debugging",
      fixture: {
        upstreamCommit: HTTPCORE_UPSTREAM_COMMIT,
        upstreamTree: HTTPCORE_UPSTREAM_TREE,
        python: HTTPCORE_PYTHON_VERSION,
        license: "BSD-3-Clause",
      },
    });
    expect(httpcoreCancellationCase.snapshot.authoringStatus).toBe("candidate");
    expect(httpcoreCancellationCase.snapshot.artifacts.verifier.mandatoryGates.map(({ id }) => id)).toEqual([
      "cancellation-recovery",
      "resource-cleanup",
      "focused-regression-safety",
      "committed-delivery",
    ]);
    expect(httpcoreCancellationCase.snapshotDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(httpcoreCancellationCase.catalogSnapshot)).not.toContain("sealedPath");
    expect(httpcoreCancellationCase.definition.threads[0]?.prompts[0]).not.toMatch(/BaseException|_connect_failed|connection_pool\.py/);
  });

  it("materializes the exact source and hash-locked Python environment into separate directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-httpcore-materializer-test-"));
    directories.push(root);
    const cacheDirectory = join(root, "cache");
    const workspaceDirectory = join(root, "execution", "workspace");
    const environmentDirectory = join(root, "execution", "environment");
    await writeSourceIdentity(cacheDirectory);
    const calls: string[] = [];
    const runCommand: CommandRunner = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "git" && args[0] === "clone") await cp(cacheDirectory, workspaceDirectory, { recursive: true });
      if (command === "git" && args[0] === "rev-parse") {
        return { exitCode: 0, stdout: `${args[1] === "HEAD^{tree}" ? HTTPCORE_UPSTREAM_TREE : HTTPCORE_UPSTREAM_COMMIT}\n`, stderr: "" };
      }
      if (command === "git" && args[0] === "status") return { exitCode: 0, stdout: "", stderr: "" };
      if (command === "uv" && args[0] === "--version") return { exitCode: 0, stdout: "uv 0.12.0\n", stderr: "" };
      if (command === "uv" && args[0] === "venv") await mkdir(join(environmentDirectory, "bin"), { recursive: true });
      if (command.endsWith("/bin/python")) return { exitCode: 0, stdout: `${HTTPCORE_PYTHON_VERSION}\n`, stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const receipt = await materializeHTTPCoreCancellationFixture({
      cacheDirectory,
      workspaceDirectory,
      environmentDirectory,
      platform: "darwin",
      runCommand,
    });

    expect(receipt).toMatchObject({
      workspaceDirectory,
      environmentDirectory,
      sourceRevision: `git-tree:${HTTPCORE_UPSTREAM_TREE}`,
      pythonVersion: HTTPCORE_PYTHON_VERSION,
      uvVersion: "0.12.0",
      environmentDigest: httpcoreCancellationCase.snapshot.artifacts.workspace.environmentDigest,
      installedWithFrozenLockfile: true,
    });
    expect(calls.some((call) => call.startsWith(`uv venv --python ${HTTPCORE_PYTHON_VERSION} `))).toBe(true);
    expect(calls).toContain("uv --version");
    expect(calls.some((call) => call.includes("uv pip install") && call.includes("--require-hashes"))).toBe(true);
  });

  it("keeps the checked-in admission evidence bound to the active verifier and adversarial matrix", async () => {
    const receipt = JSON.parse(await readFile(new URL("../../../eval-cases/httpcore-cancellation-pool/admission/receipt.json", import.meta.url), "utf8")) as {
      verifierDigest: string;
      result: string;
      variants: { id: string; expected: string; actual: string; patchDigest: string | null; failedChecks: string[] }[];
    };
    expect(receipt.verifierDigest).toBe(httpcoreCancellationCase.snapshot.artifacts.verifier.contentDigest);
    expect(receipt.result).toBe("pass");
    expect(receipt.variants.map(({ id, expected, actual }) => ({ id, expected, actual }))).toEqual([
      { id: "untouched-baseline", expected: "red", actual: "red" },
      { id: "green-connection-state", expected: "green", actual: "green" },
      { id: "green-pool-removal", expected: "green", actual: "green" },
      { id: "mutant-root-hooks", expected: "red", actual: "red" },
      { id: "mutant-package-hooks", expected: "red", actual: "red" },
      { id: "mutant-mainmodule-exit", expected: "red", actual: "red" },
      { id: "mutant-repeat-once", expected: "red", actual: "red" },
      { id: "mutant-over-capacity", expected: "red", actual: "red" },
      { id: "mutant-skip-close", expected: "red", actual: "red" },
      { id: "mutant-hanging-cleanup", expected: "red", actual: "red" },
    ]);
    expect(receipt.variants.find(({ id }) => id === "mutant-over-capacity")?.failedChecks).toContain("connection-slot-release");
    expect(receipt.variants.find(({ id }) => id === "mutant-skip-close")?.failedChecks).toContain("cleanup");
    for (const variant of receipt.variants.filter(({ patchDigest }) => patchDigest !== null)) {
      const patch = await readFile(new URL(`../../../eval-cases/httpcore-cancellation-pool/admission/${variant.id}.patch`, import.meta.url));
      expect(variant.patchDigest).toBe(`sha256:${createHash("sha256").update(patch).digest("hex")}`);
    }
  });
});

describe("HTTPCore sealed workspace verifier", () => {
  it("records every public-seam predicate independently in a pristine candidate copy", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-httpcore-grader-test-"));
    directories.push(root);
    await writeFile(join(root, "candidate.py"), "committed candidate bytes\n");
    const verifierDirectories: string[] = [];
    const verifierFiles: string[][] = [];
    const verifierTimeouts: (number | undefined)[] = [];
    const runCommand = gradingRunner(verifierDirectories, {
      "deterministic-cancellation": true,
      "connection-slot-release": true,
      "subsequent-request-success": true,
      "repeated-cancellation": true,
      cleanup: false,
    }, verifierFiles, verifierTimeouts);

    const checks = await gradeHTTPCoreCancellationWorkspace({
      workspaceDirectory: root,
      pythonExecutable: "/fixture/python",
      runCommand,
    });

    expect(checks.map(({ name }) => name)).toEqual([
      "workspace:httpcore-deterministic-cancellation",
      "workspace:httpcore-connection-slot-release",
      "workspace:httpcore-subsequent-request-success",
      "workspace:httpcore-repeated-cancellation",
      "workspace:httpcore-cleanup",
      "workspace:httpcore-regression-safety",
      "workspace:httpcore-meaningful-commit",
      "workspace:httpcore-clean",
    ]);
    expect(checks.find(({ name }) => name.endsWith("cleanup"))?.passed).toBe(false);
    expect(checks.filter(({ name }) => name.includes("cancellation") || name.includes("slot-release") || name.includes("subsequent-request")).every(({ passed }) => passed)).toBe(true);
    expect(new Set(verifierDirectories)).toHaveLength(1);
    expect(verifierDirectories).not.toContain(root);
    expect(verifierFiles.every((files) => files.includes("committed-change.txt"))).toBe(true);
    expect(verifierFiles.every((files) => !files.includes("candidate.py"))).toBe(true);
    expect(verifierTimeouts).toEqual([20_000, 20_000]);
  });
});

async function writeSourceIdentity(directory: string): Promise<void> {
  await mkdir(join(directory, "httpcore"), { recursive: true });
  await writeFile(join(directory, "pyproject.toml"), '[project]\nlicense = "BSD-3-Clause"\nrequires-python = ">=3.8"\n');
  await writeFile(join(directory, "httpcore", "__init__.py"), '__version__ = "1.0.2"\n');
  await writeFile(join(directory, "LICENSE.md"), "Redistribution and use in source and binary forms are permitted.\nTHIS SOFTWARE IS PROVIDED AS IS.\n");
}

function gradingRunner(
  verifierDirectories: string[],
  predicates: Readonly<Record<string, boolean>>,
  verifierFiles: string[][] = [],
  verifierTimeouts: (number | undefined)[] = [],
): CommandRunner {
  return async (command, args, options) => {
    if (command === "git" && args[0] === "status") return { exitCode: 0, stdout: "", stderr: "" };
    if (command === "git" && args[0] === "rev-list") return { exitCode: 0, stdout: "candidate-commit\n", stderr: "" };
    if (command === "git" && args[0] === "diff") return {
      exitCode: 0,
      stdout: "diff --git a/committed-change.txt b/committed-change.txt\nnew file mode 100644\nindex 0000000..5ea2ed4\n--- /dev/null\n+++ b/committed-change.txt\n@@ -0,0 +1 @@\n+committed candidate bytes\n",
      stderr: "",
    };
    if (command === "git" && args[0] === "clone") {
      await mkdir(args.at(-1)!, { recursive: true });
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (command === "git" && args[0] === "checkout") return { exitCode: 0, stdout: "", stderr: "" };
    if (command === "git" && args[0] === "apply") {
      await writeFile(join(options.cwd, "committed-change.txt"), "committed candidate bytes\n");
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (command === "/fixture/python" && args[1]?.endsWith("verify.py")) {
      verifierTimeouts.push(options.timeoutMs);
      verifierDirectories.push(args[2]!);
      verifierFiles.push(await readdir(args[2]!));
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          schemaVersion: 1,
          predicates: Object.fromEntries(Object.entries(predicates).map(([id, passed]) => [id, { passed, detail: `${id}=${passed}` }])),
        }),
        stderr: "",
      };
    }
    if (command === "/fixture/python" && args[1]?.endsWith("regression.py")) {
      verifierTimeouts.push(options.timeoutMs);
      verifierDirectories.push(args[2]!);
      verifierFiles.push(await readdir(args[2]!));
      return { exitCode: 0, stdout: "51 passed", stderr: "" };
    }
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  };
}
