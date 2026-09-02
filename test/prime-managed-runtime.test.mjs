import { join } from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import { resolveManagedRuntimeRecipe } from "../desktop/main/managed-runtimes/recipes.mjs";
import { createManagedRuntimeInstaller } from "../desktop/main/managed-runtimes/installer.mjs";
import {
  PRIME_AGENT_PACKAGED_DEPENDENCY_CLOSURE_SHA256_BY_TARGET,
  PRIME_AGENT_REPOSITORY_DEPENDENCY_CLOSURE_SHA256,
  PRIME_AGENT_PACKAGE_SHA256,
  PRIME_AGENT_PACKAGE_TREE_SHA256,
  selectPrimeAgentDependencyClosureSha256,
} from "../desktop/main/services/prime-agent-runtime.mjs";
import {
  PRIME_MANAGED_KERNEL_IMPORTS,
  assemblePrimeManagedRuntime,
  checkPrimeManagedRuntime,
} from "../desktop/main/services/prime-managed-runtime.mjs";

describe("Prime managed runtime", () => {
  const execFileAsync = promisify(execFile);

  it("locks, selects, assembles, installs, and probes the reviewed Prime runtime contract", { timeout: 30_000 }, async () => {
    const recipe = resolveManagedRuntimeRecipe("prime@0.8.1", "macos-arm64");
    expect(recipe.runtimeContract, "macOS arm64 recipe locks the reviewed interpreter and wheel-only closure").toMatchObject({
      primeSourceCommit: "f6130839ad3043f1cd3d5294fe03023035bfcd5c",
      primeBridgeCommit: "8f33cfc30a3ce5f52f158122f34d523418aeca3e",
      javascript: {
        dependencyClosureSha256: PRIME_AGENT_PACKAGED_DEPENDENCY_CLOSURE_SHA256_BY_TARGET["darwin-arm64"],
        repositoryDependencyClosureSha256: PRIME_AGENT_REPOSITORY_DEPENDENCY_CLOSURE_SHA256,
        packages: Object.keys(PRIME_AGENT_PACKAGE_SHA256).sort().map((name) => ({
          name,
          version: "0.8.1",
          archiveSha256: PRIME_AGENT_PACKAGE_SHA256[name],
          treeSha256: PRIME_AGENT_PACKAGE_TREE_SHA256[name],
        })),
      },
      uv: { version: "0.12.0" },
      python: { version: "3.11.16+20260825", onlyBinary: true },
    });
    expect(recipe.runtimeContract.javascript.dependencyClosureSha256,
      "packaged and repository closure identities stay distinct")
      .not.toBe(recipe.runtimeContract.javascript.repositoryDependencyClosureSha256);
    expect(recipe.artifacts.filter(({ kind }) => kind === "wheel"), "wheel closure count").toHaveLength(78);
    expect(recipe.artifacts.every(({ sha256, size }) => /^[a-f0-9]{64}$/.test(sha256) && size > 0),
      "every artifact pins a real hash and size").toBe(true);
    expect(recipe.artifacts.some(({ kind }) => kind === "sdist"), "no source distributions ship").toBe(false);

    const javascriptContract = recipe.runtimeContract.javascript;
    expect(selectPrimeAgentDependencyClosureSha256({ isPackaged: true, javascriptContract }),
      "packaged builds select the packaged closure").toBe(PRIME_AGENT_PACKAGED_DEPENDENCY_CLOSURE_SHA256_BY_TARGET["darwin-arm64"]);
    expect(selectPrimeAgentDependencyClosureSha256({ isPackaged: false, javascriptContract }),
      "development builds select the repository closure").toBe(PRIME_AGENT_REPOSITORY_DEPENDENCY_CLOSURE_SHA256);
    for (const [label, contract] of [
      ["packaged build with only the repository closure", { repositoryDependencyClosureSha256: PRIME_AGENT_REPOSITORY_DEPENDENCY_CLOSURE_SHA256 }],
      ["development build with only the packaged closure", { dependencyClosureSha256: PRIME_AGENT_PACKAGED_DEPENDENCY_CLOSURE_SHA256_BY_TARGET["darwin-arm64"] }],
    ]) {
      expect(() => selectPrimeAgentDependencyClosureSha256({
        isPackaged: label.startsWith("packaged"),
        javascriptContract: contract,
      }), label).toThrow("invalid for this environment");
    }

    const root = await mkdtemp(join(tmpdir(), "relayer-prime-recipe-"));
    try {
      const installer = createManagedRuntimeInstaller({
        root,
        platform: "darwin",
        architecture: "arm64",
        fetch: vi.fn(),
        downloadArtifactFile: async (_fetch, _artifact, destination) => writeFile(destination, "reviewed"),
        extract: async (_archive, destination) => mkdir(destination, { recursive: true }),
        assembleRecipe: async (context) => assemblePrimeManagedRuntime(context, {
          run: async (_command, args) => {
            if (args[0] !== "venv") return;
            const venvPython = join(args[1], "bin", "python");
            const sourcePython = args[3];
            await mkdir(join(sourcePython, ".."), { recursive: true });
            await writeFile(sourcePython, "#!/bin/sh\nprintf 'Python 3.11.16\\n'\n", { mode: 0o700 });
            await mkdir(join(venvPython, ".."), { recursive: true });
            await (await import("node:fs/promises")).symlink(sourcePython, venvPython);
          },
          copyWheel: async () => {},
          copyReviewedTrees: async ({ installationRoot }) => {
            const modulePath = join(installationRoot, "js", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js");
            await mkdir(join(modulePath, ".."), { recursive: true });
            await writeFile(modulePath, "export const fixture = true;\n");
          },
        }),
        probes: { prime: async ({ executable }) => {
          const { stdout } = await execFileAsync(executable, ["--version"]);
          expect(stdout, "the assembled interpreter answers --version").toBe("Python 3.11.16\n");
          return { version: "0.8.1" };
        } },
      });
      await expect(installer.prepare("prime@0.8.1"), "the real SHA-256 recipe passes the public installer seam")
        .resolves.toMatchObject({ runtimeId: "prime", recipeId: "prime@0.8.1" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }

    const run = vi.fn(async () => {});
    const copyReviewedTrees = vi.fn(async () => {});
    const artifactRoots = Object.fromEntries(recipe.artifacts.map((artifact) => (
      [artifact.artifactId, `/managed/artifacts/${artifact.artifactId.replaceAll("/", "-")}`]
    )));
    await assemblePrimeManagedRuntime({
      recipe,
      installationRoot: "/managed/install",
      artifactRoots,
      tools: { uv: "/managed/install/uv/uv", python: "/managed/install/python/bin/python3" },
      environment: { PATH: "", UV_NO_CONFIG: "1", TMPDIR: "/managed/tmp" },
      signal: undefined,
    }, {
      run,
      copyReviewedTrees,
      copyWheel: vi.fn(async () => {}),
      makeWheelDirectory: vi.fn(async () => {}),
      relocateVenvPython: vi.fn(async () => {}),
      writeIsolatedLauncher: vi.fn(async () => {}),
      wheelDirectory: "/managed/wheels",
    });
    expect(run.mock.calls, "assembly runs exactly one offline venv command and one offline wheel install").toEqual([
      ["/managed/install/uv/uv", ["venv", "/managed/install/venv", "--python", "/managed/install/python/bin/python3", "--relocatable", "--no-config", "--offline"], expect.objectContaining({ env: expect.objectContaining({ UV_OFFLINE: "1" }) })],
      ["/managed/install/uv/uv", expect.arrayContaining(["pip", "install", "--python", "/managed/install/venv/bin/python", "--no-config", "--no-index", "--no-deps", "--only-binary", ":all:", "--find-links", "/managed/wheels", "--offline"]), expect.objectContaining({ env: expect.objectContaining({ PYTHONNOUSERSITE: "1", UV_OFFLINE: "1" }) })],
    ]);
    expect(copyReviewedTrees, "assembly copies the reviewed trees once").toHaveBeenCalledOnce();

    const probeManagedKernel = vi.fn(async () => ({ pythonExecutable: "/managed/venv/bin/python" }));
    await expect(checkPrimeManagedRuntime({
      runtime: { runtimeId: "prime", executable: "/managed/venv/bin/python", modulePath: "/managed/js/node_modules/@earendil-works/pi-coding-agent/dist/index.js" },
      importPrimeAgent: async () => ({ MANAGED_KERNEL_VERSION: 1, probeManagedKernel }),
    }), "the managed bridge probes without a provider").resolves.toEqual({ available: true });
    expect(probeManagedKernel, "the kernel probe carries every first-party import").toHaveBeenCalledWith({
      pythonExecutable: "/managed/venv/bin/python",
      imports: PRIME_MANAGED_KERNEL_IMPORTS,
    });
    expect(PRIME_MANAGED_KERNEL_IMPORTS, "first-party import inventory").toHaveLength(14);
    expect(PRIME_MANAGED_KERNEL_IMPORTS, "first-party imports include the kernel surface")
      .toEqual(expect.arrayContaining(["rlm", "relayer_graph", "attach_image", "browser"]));
  });
});
