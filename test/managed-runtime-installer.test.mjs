import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { access, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { c as createTar } from "tar";
import { describe, expect, it, vi } from "vitest";

import { createManagedRuntimeInstaller as createExactManagedRuntimeInstaller } from "../desktop/main/managed-runtimes/installer.mjs";
import { createDefaultRuntimeProbes } from "../desktop/main/managed-runtimes/probes.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}

function integrity(content) {
  return `sha512-${createHash("sha512").update(content).digest("base64")}`;
}

function exactRecipe(value) {
  return Object.freeze({
    ...value,
    recipeDigest: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
  });
}

function createManagedRuntimeInstaller(options) {
  return createExactManagedRuntimeInstaller({ ...options, testOnlyLegacyMinimumVersionResolution: true });
}

function registryFixture(routes) {
  return vi.fn(async (url) => {
    const route = routes.get(String(url));
    if (!route) return new Response("missing", { status: 404 });
    return route instanceof Uint8Array || Buffer.isBuffer(route)
      ? new Response(route)
      : Response.json(route);
  });
}

function latestClaudeRoutes(version, label) {
  const sdkBytes = Buffer.from(`${label} sdk`);
  const nativeBytes = Buffer.from(`${label} native`);
  const sdkTarball = `https://registry.npmjs.org/${label}-sdk.tgz`;
  const nativeTarball = `https://registry.npmjs.org/${label}-native.tgz`;
  return new Map([
    ["https://registry.npmjs.org/@anthropic-ai%2fclaude-agent-sdk/latest", {
      name: "@anthropic-ai/claude-agent-sdk", version,
      optionalDependencies: { "@anthropic-ai/claude-agent-sdk-darwin-arm64": version },
      dist: { tarball: sdkTarball, integrity: integrity(sdkBytes) },
    }],
    [`https://registry.npmjs.org/@anthropic-ai%2fclaude-agent-sdk-darwin-arm64/${version}`, {
      name: "@anthropic-ai/claude-agent-sdk-darwin-arm64", version,
      dist: { tarball: nativeTarball, integrity: integrity(nativeBytes) },
    }],
    [sdkTarball, sdkBytes],
    [nativeTarball, nativeBytes],
  ]);
}

async function createInstalledClaude(root) {
  const sdkBytes = Buffer.from("installed sdk");
  const nativeBytes = Buffer.from("installed native");
  const sdkTarball = "https://registry.npmjs.org/installed-sdk.tgz";
  const nativeTarball = "https://registry.npmjs.org/installed-native.tgz";
  const fetch = registryFixture(new Map([
    ["https://registry.npmjs.org/@anthropic-ai%2fclaude-agent-sdk/latest", {
      name: "@anthropic-ai/claude-agent-sdk", version: "0.3.247",
      optionalDependencies: { "@anthropic-ai/claude-agent-sdk-darwin-arm64": "0.3.247" },
      dist: { tarball: sdkTarball, integrity: integrity(sdkBytes) },
    }],
    ["https://registry.npmjs.org/@anthropic-ai%2fclaude-agent-sdk-darwin-arm64/0.3.247", {
      name: "@anthropic-ai/claude-agent-sdk-darwin-arm64", version: "0.3.247",
      dist: { tarball: nativeTarball, integrity: integrity(nativeBytes) },
    }],
    [sdkTarball, sdkBytes],
    [nativeTarball, nativeBytes],
  ]));
  const probe = vi.fn(async ({ version }) => ({ version }));
  const installer = createManagedRuntimeInstaller({
    root, platform: "darwin", architecture: "arm64", fetch, probes: { claude: probe },
    extract: async (_tarball, destination, { artifact }) => {
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, artifact.role === "sdk" ? "sdk.mjs" : "claude"), "runtime", { mode: 0o755 });
    },
  });
  const result = await installer.ensure("claude", "0.3.200");
  return { installer, result, fetch, probe };
}

function exactClaudeFixture(label = "exact") {
  const sdkBytes = Buffer.from(`${label}-sdk`);
  const nativeBytes = Buffer.from(`${label}-native`);
  const recipe = exactRecipe({
    schemaVersion: 1, recipeId: "claude-fixture@0.3.250", runtimeId: "claude", version: "0.3.250",
    target: "macos-arm64", assembler: "npm-archives-v1", readinessContractVersion: 1,
    executableRelativePath: "native/claude", moduleRelativePath: "sdk/sdk.mjs",
    artifacts: [
      { role: "sdk", package: "@fixture/claude-sdk", version: "0.3.250", kind: "archive", tarball: `https://registry.npmjs.org/${label}-sdk.tgz`, integrity: integrity(sdkBytes) },
      { role: "native", package: "@fixture/claude-native", version: "0.3.250", kind: "archive", tarball: `https://registry.npmjs.org/${label}-native.tgz`, integrity: integrity(nativeBytes) },
    ],
  });
  return { recipe, routes: new Map([[recipe.artifacts[0].tarball, sdkBytes], [recipe.artifacts[1].tarball, nativeBytes]]) };
}

function exactClaudeInstaller(root, label = "exact", options = {}) {
  const { recipe, routes } = exactClaudeFixture(label);
  const fetch = registryFixture(routes);
  const installer = createManagedRuntimeInstaller({
    root, platform: "darwin", architecture: "arm64", fetch,
    resolveRecipe: () => recipe,
    probes: { claude: async ({ version }) => ({ version }) },
    extract: async (_tarball, destination, { artifact }) => {
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, artifact.role === "sdk" ? "sdk.mjs" : "claude"), "runtime", { mode: 0o755 });
    },
    ...options,
  });
  return { installer, fetch, recipe };
}

async function activeReceipt(root, runtimeId = "claude") {
  return JSON.parse(await readFile(join(root, runtimeId, "macos-arm64", "active.json"), "utf8"));
}

describe("managed runtime installer", () => {
  it("does not expose minimum-version or opportunistic preparation in the production interface", async () => {
    const installer = createExactManagedRuntimeInstaller({
      root: join(tmpdir(), "relayer-managed-runtime-exact-interface"),
      platform: "darwin", architecture: "arm64",
    });

    expect(installer.ensure).toBeUndefined();
    await expect(installer.stageForAppUpdate("0.2.26", [{
      runtimeId: "claude", minimumVersion: "0.3.250",
    }])).rejects.toThrow(/exact recipe identity/i);
  });

  it("prepares only the exact app-owned recipe without discovering vendor latest", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const requested = [];
    const installer = createManagedRuntimeInstaller({
      root, platform: "darwin", architecture: "arm64",
      fetch: vi.fn(async (url) => {
        requested.push(String(url));
        return new Response("not-the-reviewed-artifact");
      }),
    });
    try {
      await expect(installer.prepare("claude@0.3.250")).rejects.toThrow(/integrity verification failed/i);
      expect(requested).toEqual([
        "https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.250.tgz",
      ]);
      expect(requested.every((url) => !url.includes("/latest"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("validates an exact installed descriptor locally without running its readiness probe", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const probe = vi.fn(async ({ version }) => ({ version }));
    try {
      const { installer, fetch } = exactClaudeInstaller(root, "local-validation", { probes: { claude: probe } });
      const prepared = await installer.prepare("claude-fixture@0.3.250");
      expect(probe).toHaveBeenCalledOnce();
      const networkCallsAfterPreparation = fetch.mock.calls.length;

      await expect(installer.validate("claude-fixture@0.3.250")).resolves.toMatchObject({
        installation: prepared.installation,
        privateStateRoot: join(root, "claude", "macos-arm64", "private-state", prepared.installation),
      });
      expect(probe).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledTimes(networkCallsAfterPreparation);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects local validation when descriptor-owned private state is replaced by an escape symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const outside = await mkdtemp(join(tmpdir(), "relayer-private-state-outside-"));
    try {
      const { installer } = exactClaudeInstaller(root, "validate-private-state-symlink");
      const prepared = await installer.prepare("claude-fixture@0.3.250");
      await rm(prepared.privateStateRoot, { recursive: true, force: true });
      await symlink(outside, prepared.privateStateRoot, "dir");

      await expect(installer.validate("claude-fixture@0.3.250"))
        .rejects.toThrow(/private state.*owned directory/i);
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects local validation when a private-state ancestor redirects to another managed subtree", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    try {
      const { installer } = exactClaudeInstaller(root, "validate-private-state-parent-symlink");
      const prepared = await installer.prepare("claude-fixture@0.3.250");
      const privateStateParent = join(root, "claude", "macos-arm64", "private-state");
      const redirectedParent = join(root, "redirected-private-state");
      await rm(privateStateParent, { recursive: true, force: true });
      await mkdir(join(redirectedParent, prepared.installation), { recursive: true });
      await symlink(redirectedParent, privateStateParent, "dir");

      await expect(installer.validate("claude-fixture@0.3.250"))
        .rejects.toThrow(/private state escapes the managed runtime root/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects local validation when the installation ownership marker identity changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    try {
      const { installer } = exactClaudeInstaller(root, "validate-ownership-marker");
      const prepared = await installer.prepare("claude-fixture@0.3.250");
      await writeFile(join(prepared.installationRoot, ".relayer-managed-runtime.json"), JSON.stringify({
        schemaVersion: 1,
        runtimeId: "claude",
        target: "macos-arm64",
        installation: "22222222-2222-4222-8222-222222222222",
        ownedPath: "claude/macos-arm64/installations/22222222-2222-4222-8222-222222222222",
      }));

      await expect(installer.validate("claude-fixture@0.3.250"))
        .rejects.toThrow(/installation ownership marker is invalid/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects local validation when an executable or module symlink escapes its exact installation", async () => {
    for (const entrypoint of ["executable", "modulePath"]) {
      const root = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
      const outside = await mkdtemp(join(tmpdir(), "relayer-entrypoint-outside-"));
      const outsideFile = join(outside, `${entrypoint}.mjs`);
      try {
        const { installer } = exactClaudeInstaller(root, `validate-${entrypoint}-symlink`);
        const prepared = await installer.prepare("claude-fixture@0.3.250");
        await writeFile(outsideFile, "outside remains user-owned", { mode: 0o600 });
        await rm(prepared[entrypoint], { force: true });
        await symlink(outsideFile, prepared[entrypoint]);

        await expect(installer.validate("claude-fixture@0.3.250"))
          .rejects.toThrow(/entrypoint escapes its managed installation/i);
        expect(await readFile(outsideFile, "utf8")).toBe("outside remains user-owned");
      } finally {
        await rm(root, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
      }
    }
  });

  it("refuses to create descriptor-owned private state through a preexisting symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const outside = await mkdtemp(join(tmpdir(), "relayer-private-state-outside-"));
    const probe = vi.fn()
      .mockImplementationOnce(async ({ version }) => ({ version }))
      .mockRejectedValueOnce(new Error("active runtime needs repair"))
      .mockImplementation(async ({ version }) => ({ version }));
    try {
      const { installer } = exactClaudeInstaller(root, "private-state-symlink", { probes: { claude: probe } });
      await installer.prepare("claude-fixture@0.3.250");
      const privateStateParent = join(root, "claude", "macos-arm64", "private-state");
      await rm(privateStateParent, { recursive: true, force: true });
      await symlink(outside, privateStateParent, "dir");

      await expect(installer.prepare("claude-fixture@0.3.250"))
        .rejects.toThrow(/private-state root is not an owned directory/i);
      await expect(access(join(outside, "sentinel"))).rejects.toMatchObject({ code: "ENOENT" });
      expect((await readFile(join(root, "claude", "macos-arm64", "active.json"), "utf8"))).toContain("installation");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("prepares the exact reviewed artifact closure for every supported runtime target", async () => {
    const cases = [
      { platform: "darwin", architecture: "arm64", target: "macos-arm64", recipeId: "codex@0.147.0", nativeVersion: "0.147.0-darwin-arm64", nativeIntegrity: "sha512-BEUVkiOW7kLcRyrMLfAr/h9wF8sRVJyZDy6OHtVn6QGDXiv3BvAZVTY1Pu9xF7KdIdkYXbp4uayN0aDQQaAUJw==" },
      { platform: "darwin", architecture: "x64", target: "macos-x64", recipeId: "codex@0.147.0", nativeVersion: "0.147.0-darwin-x64", nativeIntegrity: "sha512-Tb8McE5SvJIH0Vs5R6sq7u+quiC931yan2KOOl6km1OdZ82+Wi7eF5XrSFPs5CF7xCgoIK4Vs+byMbT5hN+ZUw==" },
      { platform: "win32", architecture: "x64", target: "windows-x64", recipeId: "codex@0.147.0", nativeVersion: "0.147.0-win32-x64", nativeIntegrity: "sha512-oT7Ss5fAPf2fiWE9QNURqZcQGAAawSVxmIUdgPzckq4KFZAM+pRz9JbM4Rr498CjtbNgTOjWvDJ+DXvIBSfOPA==" },
      { platform: "darwin", architecture: "arm64", target: "macos-arm64", recipeId: "claude@0.3.250", nativePackage: "@anthropic-ai/claude-agent-sdk-darwin-arm64", nativeIntegrity: "sha512-tcekW4gR2UH0Q3COBaNPQIdud2lKEbs0HfG2yNKC18hXFPpgbuLCdjq0ndS1lcvC1q8ncPW3oQPUutQt3StICQ==" },
      { platform: "darwin", architecture: "x64", target: "macos-x64", recipeId: "claude@0.3.250", nativePackage: "@anthropic-ai/claude-agent-sdk-darwin-x64", nativeIntegrity: "sha512-8Yxmmi76oVEIam+oRgxcL2RtqEkKX9Gp4rh500HmMltjX3Tk/ryjCoJEHoaUdU/LU6vWvfQU5W+dB/SJCQQb2A==" },
      { platform: "win32", architecture: "x64", target: "windows-x64", recipeId: "claude@0.3.250", nativePackage: "@anthropic-ai/claude-agent-sdk-win32-x64", nativeIntegrity: "sha512-PjJRbJwDHccSUWls5gTiuXMgERit1WrrMQzzRqhhBHGzrlQueHVodrpg7HaN5gtirADJzfINcc7azq8j3qcEYw==" },
    ];
    for (const candidate of cases) {
      const root = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
      const artifacts = [];
      const installer = createManagedRuntimeInstaller({
        root, platform: candidate.platform, architecture: candidate.architecture,
        fetch: vi.fn(async () => { throw new Error("recipe download bypass was not used"); }),
        downloadArtifactFile: async (_fetch, artifact, destination) => {
          artifacts.push(artifact);
          await writeFile(destination, "reviewed archive", { mode: 0o600 });
        },
        extract: async (_tarball, destination, { runtimeId, artifact, target }) => {
          const executable = runtimeId === "codex"
            ? join(destination, "vendor", target.codexVendor, "bin", target.codexExecutable)
            : join(destination, artifact.role === "sdk" ? "sdk.mjs" : target.claudeExecutable);
          await mkdir(join(executable, ".."), { recursive: true });
          await writeFile(executable, runtimeId, { mode: 0o755 });
        },
        probes: {
          codex: async ({ version }) => ({ version }),
          claude: async ({ version }) => ({ version }),
        },
      });
      try {
        await expect(installer.prepare(candidate.recipeId)).resolves.toMatchObject({ target: candidate.target });
        if (candidate.recipeId.startsWith("codex")) {
          expect(artifacts).toEqual([expect.objectContaining({
            package: "@openai/codex", version: candidate.nativeVersion, integrity: candidate.nativeIntegrity,
          })]);
        } else {
          expect(artifacts).toEqual([
            expect.objectContaining({
              package: "@anthropic-ai/claude-agent-sdk", version: "0.3.250",
              integrity: "sha512-qT/1cBZs0+xPsQfqVOnwIk6pNW8XBkTpQS5RAXKHYb2XYCKqYc0UmOaeiYU2WeI6HEZKORa5iCaAZyKWGluShw==",
            }),
            expect.objectContaining({ package: candidate.nativePackage, version: "0.3.250", integrity: candidate.nativeIntegrity }),
          ]);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it("prepares a Prime-shaped recipe inside one isolated managed root", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const artifacts = ["uv", "python", "prime", "wheel", "python-client"].map((role) => {
      const bytes = Buffer.from(`${role}-bytes`);
      return {
        role, package: `fixture-${role}`, version: "1.0.0", kind: role === "wheel" ? "wheel" : "archive",
        tarball: `https://artifacts.example.test/${role}.tgz`, integrity: integrity(bytes), bytes,
      };
    });
    const recipe = exactRecipe({
      schemaVersion: 1, recipeId: "prime-fixture@1.0.0",
      runtimeId: "prime", version: "1.0.0", target: "macos-arm64",
      assembler: "prime-fixture-v1", readinessContractVersion: 1,
      runtimeContract: {
        primeSourceCommit: "1".repeat(40),
        javascript: {
          dependencyClosureSha256: "3".repeat(64),
          repositoryDependencyClosureSha256: "6".repeat(64),
          packages: [{
            name: "fixture-prime", version: "1.0.0",
            archiveSha256: "4".repeat(64), treeSha256: "5".repeat(64),
          }],
        },
        uv: { version: "0.8.15", artifactId: "uv", executableRelativePath: "uv/uv" },
        python: {
          version: "3.11.11", artifactId: "python", executableRelativePath: "python/bin/python3", onlyBinary: true,
          wheelArtifactIds: ["wheel"],
          client: { artifactId: "python-client", sha256: "2".repeat(64), installRule: "copy-package-v1" },
        },
      },
      executableRelativePath: join("prime", "bin", "prime"), moduleRelativePath: null,
      artifacts: artifacts.map(({ bytes: _bytes, ...artifact }) => artifact),
    });
    const assembleRecipe = vi.fn(async ({ installationRoot, environment, tools }) => {
      expect(environment).toMatchObject({ PATH: "", UV_NO_CONFIG: "1", UV_NO_MODIFY_PATH: "1" });
      expect(environment).not.toHaveProperty("HOME");
      expect(tools).toEqual({
        uv: join(installationRoot, "uv", "uv"),
        python: join(installationRoot, "python", "bin", "python3"),
      });
      for (const [name, value] of Object.entries(environment)) {
        if (["PATH", "UV_NO_CONFIG", "UV_NO_MODIFY_PATH"].includes(name)) continue;
        expect(value.startsWith(root), `${name} escaped the managed root`).toBe(true);
      }
      await mkdir(join(installationRoot, "prime", "bin"), { recursive: true });
      await writeFile(join(installationRoot, "prime", "bin", "prime"), "fixture", { mode: 0o755 });
    });
    const probe = vi.fn(async ({ version }) => ({ version }));
    const installer = createManagedRuntimeInstaller({
      root, platform: "darwin", architecture: "arm64",
      resolveRecipe: (recipeId, target) => {
        expect([recipeId, target]).toEqual(["prime-fixture@1.0.0", "macos-arm64"]);
        return recipe;
      },
      assembleRecipe,
      fetch: registryFixture(new Map(artifacts.map(({ tarball, bytes }) => [tarball, bytes]))),
      extract: async (_tarball, destination) => mkdir(destination, { recursive: true }),
      probes: { prime: probe },
    });
    try {
      const prepared = await installer.prepare("prime-fixture@1.0.0");
      expect(prepared).toMatchObject({
        runtimeId: "prime", recipeId: "prime-fixture@1.0.0", version: "1.0.0", target: "macos-arm64",
      });
      expect(prepared).not.toHaveProperty("receipt");
      expect(await activeReceipt(root, "prime")).toMatchObject({
        ownedPaths: [
          `prime/macos-arm64/installations/${prepared.installation}`,
          `prime/macos-arm64/private-state/${prepared.installation}`,
        ],
      });
      expect(prepared.executable.startsWith(root)).toBe(true);
      await expect(installer.installed("prime-fixture@1.0.0")).resolves.toMatchObject({
        recipeId: "prime-fixture@1.0.0",
      });
      expect(probe).toHaveBeenCalledOnce();
      expect(assembleRecipe).toHaveBeenCalledOnce();

      const legacy = { ...await activeReceipt(root, "prime"), schemaVersion: 1 };
      delete legacy.recipeId;
      delete legacy.recipeDigest;
      delete legacy.recipeSchemaVersion;
      delete legacy.assembler;
      delete legacy.readinessContractVersion;
      await writeFile(join(root, "prime", "macos-arm64", "active.json"), `${JSON.stringify(legacy, null, 2)}\n`);
      await expect(installer.installed("prime-fixture@1.0.0"))
        .rejects.toThrow(/does not match requested recipe/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects source distributions before downloading a managed recipe", async () => {
    const fetch = vi.fn();
    const installer = createManagedRuntimeInstaller({
      root: join(tmpdir(), "relayer-managed-runtime-source-rejection"),
      platform: "darwin", architecture: "arm64", fetch,
      resolveRecipe: () => exactRecipe({
        schemaVersion: 1, recipeId: "prime-fixture@1.0.0",
        runtimeId: "prime", version: "1.0.0", target: "macos-arm64",
        assembler: "prime-fixture-v1", readinessContractVersion: 1,
        executableRelativePath: "prime/bin/prime", moduleRelativePath: null,
        artifacts: [{
          role: "python-source", package: "prime-source", version: "1.0.0", kind: "sdist",
          tarball: "https://artifacts.example.test/prime.tar.gz", integrity: integrity("source"),
        }],
      }),
      probes: { prime: async () => ({ version: "1.0.0" }) },
    });

    await expect(installer.prepare("prime-fixture@1.0.0")).rejects.toThrow(/source distributions/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a Prime-shaped recipe without an exact Python runtime contract", async () => {
    const fetch = vi.fn();
    const installer = createManagedRuntimeInstaller({
      root: join(tmpdir(), "relayer-managed-runtime-prime-contract-rejection"),
      platform: "darwin", architecture: "arm64", fetch,
      resolveRecipe: () => exactRecipe({
        schemaVersion: 1, recipeId: "prime-fixture@1.0.0",
        runtimeId: "prime", version: "1.0.0", target: "macos-arm64",
        assembler: "prime-fixture-v1", readinessContractVersion: 1,
        executableRelativePath: "prime/bin/prime", moduleRelativePath: null,
        artifacts: [{
          role: "prime", package: "prime", version: "1.0.0", kind: "archive",
          tarball: "https://artifacts.example.test/prime.tgz", integrity: integrity("prime"),
        }],
      }),
      probes: { prime: async () => ({ version: "1.0.0" }) },
    });

    await expect(installer.prepare("prime-fixture@1.0.0")).rejects.toThrow(/Python runtime contract/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a recipe whose digest does not authenticate its exact lock", async () => {
    const fetch = vi.fn();
    const installer = createManagedRuntimeInstaller({
      root: join(tmpdir(), "relayer-managed-runtime-lock-rejection"),
      platform: "darwin", architecture: "arm64", fetch,
      resolveRecipe: () => ({
        schemaVersion: 1, recipeId: "fixture@1.0.0", recipeDigest: "c".repeat(64),
        runtimeId: "fixture", version: "1.0.0", target: "macos-arm64",
        assembler: "fixture-v1", readinessContractVersion: 1,
        executableRelativePath: "bin/fixture", moduleRelativePath: null,
        artifacts: [{
          role: "native", package: "fixture", version: "1.0.0", kind: "archive",
          tarball: "https://artifacts.example.test/fixture.tgz", integrity: integrity("fixture"),
        }],
      }),
      probes: { fixture: async () => ({ version: "1.0.0" }) },
    });

    await expect(installer.prepare("fixture@1.0.0")).rejects.toThrow(/recipe digest/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects recipe-controlled filesystem segments before creating managed paths", async () => {
    const fetch = vi.fn();
    const recipe = exactRecipe({
      schemaVersion: 1, recipeId: "fixture@1.0.0", runtimeId: "fixture", version: "1.0.0",
      target: "macos-arm64", assembler: "fixture-v1", readinessContractVersion: 1,
      executableRelativePath: "bin/fixture", moduleRelativePath: null,
      artifacts: [{
        role: "../../user-owned", package: "fixture", version: "1.0.0", kind: "archive",
        tarball: "https://artifacts.example.test/fixture.tgz", integrity: integrity("fixture"),
      }],
    });
    const installer = createManagedRuntimeInstaller({
      root: join(tmpdir(), "relayer-managed-runtime-path-rejection"),
      platform: "darwin", architecture: "arm64", fetch, resolveRecipe: () => recipe,
      probes: { fixture: async () => ({ version: "1.0.0" }) },
    });

    await expect(installer.prepare("fixture@1.0.0")).rejects.toThrow(/artifact role is invalid/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reuses a frozen schema-v1 receipt only when it exactly matches the requested recipe", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const { installer, fetch } = exactClaudeInstaller(root, "legacy-exact");
    try {
      const { recipe } = exactClaudeFixture("legacy-exact");
      const installation = "11111111-1111-4111-8111-111111111111";
      const base = join(root, "claude", "macos-arm64");
      const installationRoot = join(base, "installations", installation);
      await mkdir(join(installationRoot, "native"), { recursive: true });
      await mkdir(join(installationRoot, "sdk"), { recursive: true });
      await writeFile(join(installationRoot, recipe.executableRelativePath), "legacy executable", { mode: 0o755 });
      await writeFile(join(installationRoot, recipe.moduleRelativePath), "legacy module", { mode: 0o600 });
      await writeFile(join(base, "active.json"), `${JSON.stringify({
        schemaVersion: 1,
        runtimeId: recipe.runtimeId,
        version: recipe.version,
        runtimeVersion: recipe.version,
        target: recipe.target,
        installation,
        ownedPaths: [`claude/macos-arm64/installations/${installation}`],
        executableRelativePath: recipe.executableRelativePath,
        moduleRelativePath: recipe.moduleRelativePath,
        artifacts: recipe.artifacts,
      }, null, 2)}\n`, { mode: 0o600 });
      fetch.mockClear();

      await expect(installer.validate("claude-fixture@0.3.250")).resolves.toMatchObject({
        recipeId: "claude-fixture@0.3.250", version: "0.3.250",
      });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("repairs a nonmatching schema-v1 receipt to the exact requested recipe", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const { installer, fetch } = exactClaudeInstaller(root, "legacy-repair");
    try {
      const prepared = await installer.prepare("claude-fixture@0.3.250");
      const legacy = { ...await activeReceipt(root), schemaVersion: 1, version: "0.3.249" };
      delete legacy.recipeId;
      delete legacy.recipeDigest;
      delete legacy.recipeSchemaVersion;
      delete legacy.assembler;
      delete legacy.readinessContractVersion;
      await writeFile(join(root, "claude", "macos-arm64", "active.json"), `${JSON.stringify(legacy, null, 2)}\n`, { mode: 0o600 });
      fetch.mockClear();

      await expect(installer.installed("claude-fixture@0.3.250")).rejects.toThrow(/does not match requested recipe/i);
      await expect(installer.prepare("claude-fixture@0.3.250")).resolves.toMatchObject({
        recipeId: "claude-fixture@0.3.250", version: "0.3.250",
      });
      expect(await activeReceipt(root)).toMatchObject({ schemaVersion: 2 });
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an ownership receipt that could escape the managed root", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const { installer } = exactClaudeInstaller(root, "ownership-escape");
    try {
      const prepared = await installer.prepare("claude-fixture@0.3.250");
      await writeFile(join(root, "claude", "macos-arm64", "active.json"), `${JSON.stringify({
        ...await activeReceipt(root),
        ownedPaths: ["../../user-owned"],
      }, null, 2)}\n`, { mode: 0o600 });

      await expect(installer.installed("claude-fixture@0.3.250")).rejects.toThrow(/ownership receipt/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("repairs a schema-v2 receipt whose exact recipe identity is stale", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const { installer, fetch } = exactClaudeInstaller(root, "current-repair");
    try {
      await installer.prepare("claude-fixture@0.3.250");
      await writeFile(join(root, "claude", "macos-arm64", "active.json"), `${JSON.stringify({
        ...await activeReceipt(root), recipeDigest: "0".repeat(64),
      }, null, 2)}\n`, { mode: 0o600 });
      fetch.mockClear();

      await expect(installer.prepare("claude-fixture@0.3.250")).resolves.toMatchObject({
        recipeId: "claude-fixture@0.3.250",
      });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(await activeReceipt(root)).toMatchObject({ recipeDigest: exactClaudeFixture("current-repair").recipe.recipeDigest });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts Claude's exact SDK recipe with its separately versioned executable probe", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const fixture = exactClaudeFixture("claude-runtime-version");
    const installer = createManagedRuntimeInstaller({
      root, platform: "darwin", architecture: "arm64",
      fetch: registryFixture(fixture.routes), resolveRecipe: () => fixture.recipe,
      probes: { claude: async () => ({ version: "2.1.250" }) },
      extract: async (_tarball, destination, { artifact }) => {
        await mkdir(destination, { recursive: true });
        await writeFile(join(destination, artifact.role === "sdk" ? "sdk.mjs" : "claude"), "runtime", { mode: 0o755 });
      },
    });
    try {
      await installer.prepare("claude-fixture@0.3.250");
      await expect(installer.installed("claude-fixture@0.3.250")).resolves.toMatchObject({
        recipeId: "claude-fixture@0.3.250", version: "0.3.250",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prunes a managed generation without following its symlink into user-owned state", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const outside = await mkdtemp(join(tmpdir(), "relayer-user-owned-"));
    const { installer } = exactClaudeInstaller(root, "symlink-cleanup");
    try {
      await installer.prepare("claude-fixture@0.3.250");
      const retired = join(root, "claude", "macos-arm64", "installations", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
      await mkdir(retired, { recursive: true });
      await writeFile(join(retired, ".relayer-managed-runtime.json"), JSON.stringify({
        schemaVersion: 1,
        runtimeId: "claude",
        target: "macos-arm64",
        installation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        ownedPath: "claude/macos-arm64/installations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }));
      await writeFile(join(outside, "sentinel"), "user owned");
      await symlink(outside, join(retired, "external"));

      await expect(installer.pruneInactiveInstallations()).resolves.toMatchObject({
        failures: [], removed: [{ runtimeId: "claude", installation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }],
      });
      await expect(access(join(outside, "sentinel"))).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("stages and activates the exact incoming recipe while keeping version metadata external", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const { installer } = exactClaudeInstaller(root, "exact-update");
    try {
      const staged = await installer.stageForAppUpdate("0.2.26", [{
        runtimeId: "claude", recipeId: "claude-fixture@0.3.250",
      }]);
      expect(staged).toMatchObject({
        appVersion: "0.2.26",
        failures: [],
        staged: [{ recipeId: "claude-fixture@0.3.250" }],
      });
      expect(staged.staged[0]).not.toHaveProperty("receipt");
      await expect(installer.installed("claude-fixture@0.3.250")).rejects.toThrow("not installed");

      await expect(installer.activatePendingAppUpdate("0.2.26")).resolves.toMatchObject({
        failures: [], activated: [{ recipeId: "claude-fixture@0.3.250" }],
      });
      await expect(installer.installed("claude-fixture@0.3.250")).resolves.toMatchObject({
        recipeId: "claude-fixture@0.3.250",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stages an exact app update while the same recipe preparation is in flight", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const started = deferred();
    const release = deferred();
    const { installer } = exactClaudeInstaller(root, "concurrent-exact", {
      assembleRecipe: async () => {
        started.resolve();
        await release.promise;
      },
    });
    try {
      const preparing = installer.prepare("claude-fixture@0.3.250");
      await started.promise;
      const staging = installer.stageForAppUpdate("0.2.26", [{
        runtimeId: "claude", recipeId: "claude-fixture@0.3.250",
      }]);
      release.resolve();

      const [prepared, staged] = await Promise.all([preparing, staging]);
      expect(prepared).not.toHaveProperty("receipt");
      expect(staged).toMatchObject({ failures: [], staged: [{ recipeId: "claude-fixture@0.3.250" }] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a stale exact pending receipt before restart activation", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const { installer } = exactClaudeInstaller(root, "pending-authentication");
    try {
      await installer.stageForAppUpdate("0.2.26", [{
        runtimeId: "claude", recipeId: "claude-fixture@0.3.250",
      }]);
      const pendingPath = join(root, ".pending-app-updates", "0.2.26", "claude-macos-arm64.json");
      const pending = JSON.parse(await readFile(pendingPath, "utf8"));
      await writeFile(pendingPath, `${JSON.stringify({ ...pending, recipeDigest: "0".repeat(64) }, null, 2)}\n`);

      await expect(installer.activatePendingAppUpdate("0.2.26")).resolves.toMatchObject({
        activated: [], failures: [{ runtimeId: "claude", error: expect.any(Error) }],
      });
      await expect(installer.installed("claude-fixture@0.3.250")).rejects.toThrow(/not installed/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("completes the Codex initialize handshake and closes through stdin", async () => {
    const writes = [];
    const versionChild = new EventEmitter();
    versionChild.stdout = new PassThrough();
    versionChild.stderr = new PassThrough();
    versionChild.exitCode = null;
    versionChild.signalCode = null;
    versionChild.kill = vi.fn();

    const serverChild = new EventEmitter();
    serverChild.stdout = new PassThrough();
    serverChild.stderr = new PassThrough();
    serverChild.stdin = new PassThrough();
    serverChild.exitCode = null;
    serverChild.signalCode = null;
    serverChild.kill = vi.fn();
    serverChild.stdin.on("data", (chunk) => {
      const message = JSON.parse(String(chunk).trim());
      writes.push(message);
      if (message.method === "initialize") {
        serverChild.stdout.write(`${JSON.stringify({ id: message.id, result: { userAgent: "Codex" } })}\n`);
      }
    });
    serverChild.stdin.on("finish", () => {
      serverChild.exitCode = 0;
      queueMicrotask(() => serverChild.emit("exit", 0, null));
    });

    const spawnProcess = vi.fn()
      .mockImplementationOnce(() => {
        queueMicrotask(() => {
          versionChild.stdout.end("codex-cli 0.147.0\n");
          versionChild.exitCode = 0;
          versionChild.emit("exit", 0, null);
        });
        return versionChild;
      })
      .mockImplementationOnce(() => serverChild);

    await expect(createDefaultRuntimeProbes({ spawnProcess }).codex({ executable: "/runtime/codex" }))
      .resolves.toEqual({ version: "0.147.0" });

    expect(writes).toEqual([
      expect.objectContaining({ id: 1, method: "initialize" }),
      { method: "initialized", params: {} },
    ]);
    expect(serverChild.kill).not.toHaveBeenCalled();
    expect(serverChild.exitCode).toBe(0);
  });

  it("validates that the managed Claude SDK module exports query", async () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = vi.fn();
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.end("claude 0.3.250\n");
        child.exitCode = 0;
        child.emit("exit", 0, null);
      });
      return child;
    });
    const importModule = vi.fn(async () => ({
      query: () => {},
      tool: () => {},
      createSdkMcpServer: () => {},
    }));

    await expect(createDefaultRuntimeProbes({ spawnProcess, importModule }).claude({
      executable: "/runtime/claude",
      modulePath: "/runtime/sdk.mjs",
    })).resolves.toEqual({ version: "0.3.250" });

    expect(importModule).toHaveBeenCalledWith("file:///runtime/sdk.mjs");
  });

  it("rejects a managed Claude SDK module without the query boundary", async () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = vi.fn();
    const spawnProcess = () => {
      queueMicrotask(() => {
        child.stdout.end("claude 0.3.250\n");
        child.exitCode = 0;
        child.emit("exit", 0, null);
      });
      return child;
    };

    await expect(createDefaultRuntimeProbes({
      spawnProcess,
      importModule: async () => ({}),
    }).claude({ executable: "/runtime/claude", modulePath: "/runtime/sdk.mjs" }))
      .rejects.toThrow("does not export query");
  });

  it.each([
    ["tool", { query: () => {}, createSdkMcpServer: () => {} }],
    ["createSdkMcpServer", { query: () => {}, tool: () => {} }],
  ])("rejects a managed Claude SDK module without the %s browser boundary", async (_missing, loaded) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = vi.fn();
    const spawnProcess = () => {
      queueMicrotask(() => {
        child.stdout.end("claude 0.3.250\n");
        child.exitCode = 0;
        child.emit("exit", 0, null);
      });
      return child;
    };

    await expect(createDefaultRuntimeProbes({
      spawnProcess,
      importModule: async () => loaded,
    }).claude({ executable: "/runtime/claude", modulePath: "/runtime/sdk.mjs" }))
      .rejects.toThrow("does not export query(), tool(), and createSdkMcpServer()");
  });

  it("bounds a managed executable version probe and terminates a hung child", async () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = vi.fn(() => true);
    const probe = createDefaultRuntimeProbes({
      spawnProcess: () => child,
      importModule: async () => ({ query: () => {} }),
      timeoutMs: 5,
    });

    await expect(probe.claude({ executable: "/runtime/claude", modulePath: "/runtime/sdk.mjs" }))
      .rejects.toThrow("version probe timed out");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("installs and activates the latest matching Claude SDK runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const sdkBytes = Buffer.from("sdk archive");
    const nativeBytes = Buffer.from("native archive");
    const sdkTarball = "https://registry.npmjs.org/sdk.tgz";
    const nativeTarball = "https://registry.npmjs.org/claude-arm64.tgz";
    const fetch = registryFixture(new Map([
      ["https://registry.npmjs.org/@anthropic-ai%2fclaude-agent-sdk/latest", {
        name: "@anthropic-ai/claude-agent-sdk",
        version: "0.3.250",
        optionalDependencies: { "@anthropic-ai/claude-agent-sdk-darwin-arm64": "0.3.250" },
        dist: { tarball: sdkTarball, integrity: integrity(sdkBytes) },
      }],
      ["https://registry.npmjs.org/@anthropic-ai%2fclaude-agent-sdk-darwin-arm64/0.3.250", {
        name: "@anthropic-ai/claude-agent-sdk-darwin-arm64",
        version: "0.3.250",
        dist: { tarball: nativeTarball, integrity: integrity(nativeBytes) },
      }],
      [sdkTarball, sdkBytes],
      [nativeTarball, nativeBytes],
    ]));
    const probe = vi.fn(async ({ executable, version }) => {
      expect(await readFile(executable, "utf8")).toBe("managed claude");
      expect(version).toBe("0.3.250");
      return { version: "2.1.250" };
    });

    try {
      const installer = createManagedRuntimeInstaller({
        root,
        platform: "darwin",
        architecture: "arm64",
        fetch,
        probes: { claude: probe },
        extract: async (_tarball, destination, { artifact }) => {
          await mkdir(destination, { recursive: true });
          if (artifact.role === "sdk") await writeFile(join(destination, "sdk.mjs"), "export {};");
          else await writeFile(join(destination, "claude"), "managed claude", { mode: 0o755 });
        },
      });

      const installed = await installer.ensure("claude", "0.3.250");

      expect(installed).toMatchObject({ runtimeId: "claude", version: "0.3.250" });
      expect(installed.executable).toMatch(/installations[/\\][^/\\]+[/\\]native[/\\]claude$/);
      expect(installed.modulePath).toMatch(/installations[/\\][^/\\]+[/\\]sdk[/\\]sdk\.mjs$/);
      expect(probe).toHaveBeenCalledOnce();
      expect(installer.activeOperations()).toEqual([]);
      const receipt = JSON.parse(await readFile(join(root, "claude", "macos-arm64", "active.json"), "utf8"));
      expect(receipt).toMatchObject({
        schemaVersion: 1,
        runtimeId: "claude",
        version: "0.3.250",
        runtimeVersion: "2.1.250",
        target: "macos-arm64",
      });
      expect(receipt.artifacts).toHaveLength(2);
      await expect(installer.installed("claude", "0.3.250")).resolves.toMatchObject({ version: "0.3.250" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a Claude SDK older than the browser-proved managed runtime floor before probing", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const probe = vi.fn(async ({ version }) => ({ version }));
    try {
      const installer = createManagedRuntimeInstaller({
        root,
        platform: "darwin",
        architecture: "arm64",
        fetch: registryFixture(latestClaudeRoutes("0.3.248", "pre-browser-floor")),
        probes: { claude: probe },
      });

      await expect(installer.ensure("claude", "0.3.250"))
        .rejects.toThrow("claude latest 0.3.248 is below required 0.3.250");
      expect(probe).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an artifact containing a symbolic link instead of silently filtering it", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const fixture = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-archive-"));
    const sdkPackage = join(fixture, "sdk", "package");
    const nativePackage = join(fixture, "native", "package");
    const sdkTarballPath = join(fixture, "sdk.tgz");
    const nativeTarballPath = join(fixture, "native.tgz");
    await mkdir(sdkPackage, { recursive: true });
    await mkdir(nativePackage, { recursive: true });
    await writeFile(join(sdkPackage, "sdk.mjs"), "export {};");
    await symlink("sdk.mjs", join(sdkPackage, "linked-sdk.mjs"));
    await writeFile(join(nativePackage, "claude"), "managed claude", { mode: 0o755 });
    await createTar({ gzip: true, file: sdkTarballPath, cwd: join(fixture, "sdk") }, ["package"]);
    await createTar({ gzip: true, file: nativeTarballPath, cwd: join(fixture, "native") }, ["package"]);
    const sdkBytes = await readFile(sdkTarballPath);
    const nativeBytes = await readFile(nativeTarballPath);
    const sdkTarball = "https://registry.npmjs.org/unsafe-sdk.tgz";
    const nativeTarball = "https://registry.npmjs.org/safe-native.tgz";
    const fetch = registryFixture(new Map([
      ["https://registry.npmjs.org/@anthropic-ai%2fclaude-agent-sdk/latest", {
        name: "@anthropic-ai/claude-agent-sdk",
        version: "0.3.247",
        optionalDependencies: { "@anthropic-ai/claude-agent-sdk-darwin-arm64": "0.3.247" },
        dist: { tarball: sdkTarball, integrity: integrity(sdkBytes) },
      }],
      ["https://registry.npmjs.org/@anthropic-ai%2fclaude-agent-sdk-darwin-arm64/0.3.247", {
        name: "@anthropic-ai/claude-agent-sdk-darwin-arm64",
        version: "0.3.247",
        dist: { tarball: nativeTarball, integrity: integrity(nativeBytes) },
      }],
      [sdkTarball, sdkBytes],
      [nativeTarball, nativeBytes],
    ]));

    try {
      const installer = createManagedRuntimeInstaller({
        root,
        platform: "darwin",
        architecture: "arm64",
        fetch,
        probes: { claude: async ({ version }) => ({ version }) },
      });
      await expect(installer.ensure("claude", "0.3.200")).rejects.toThrow(/unsafe archive entry/i);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it("rejects a SHA-512 mismatch without exposing an active runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const sdkBytes = Buffer.from("sdk archive");
    const nativeBytes = Buffer.from("tampered native archive");
    const sdkTarball = "https://registry.npmjs.org/sdk-integrity.tgz";
    const nativeTarball = "https://registry.npmjs.org/native-integrity.tgz";
    const extract = vi.fn();
    const fetch = registryFixture(new Map([
      ["https://registry.npmjs.org/@anthropic-ai%2fclaude-agent-sdk/latest", {
        name: "@anthropic-ai/claude-agent-sdk", version: "0.3.247",
        optionalDependencies: { "@anthropic-ai/claude-agent-sdk-darwin-arm64": "0.3.247" },
        dist: { tarball: sdkTarball, integrity: integrity(sdkBytes) },
      }],
      ["https://registry.npmjs.org/@anthropic-ai%2fclaude-agent-sdk-darwin-arm64/0.3.247", {
        name: "@anthropic-ai/claude-agent-sdk-darwin-arm64", version: "0.3.247",
        dist: { tarball: nativeTarball, integrity: integrity(Buffer.from("expected native archive")) },
      }],
      [sdkTarball, sdkBytes],
      [nativeTarball, nativeBytes],
    ]));

    try {
      const installer = createManagedRuntimeInstaller({ root, platform: "darwin", architecture: "arm64", fetch, extract });
      await expect(installer.ensure("claude", "0.3.200")).rejects.toThrow(/integrity verification failed/i);
      await expect(access(join(root, "claude", "macos-arm64", "active.json"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(extract).toHaveBeenCalledOnce();
      expect(installer.activeOperations()).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("coalesces concurrent requests for one runtime and target", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const sdkBytes = Buffer.from("coalesced sdk");
    const nativeBytes = Buffer.from("coalesced native");
    const sdkTarball = "https://registry.npmjs.org/coalesced-sdk.tgz";
    const nativeTarball = "https://registry.npmjs.org/coalesced-native.tgz";
    const fetch = registryFixture(new Map([
      ["https://registry.npmjs.org/@anthropic-ai%2fclaude-agent-sdk/latest", {
        name: "@anthropic-ai/claude-agent-sdk", version: "0.3.247",
        optionalDependencies: { "@anthropic-ai/claude-agent-sdk-darwin-arm64": "0.3.247" },
        dist: { tarball: sdkTarball, integrity: integrity(sdkBytes) },
      }],
      ["https://registry.npmjs.org/@anthropic-ai%2fclaude-agent-sdk-darwin-arm64/0.3.247", {
        name: "@anthropic-ai/claude-agent-sdk-darwin-arm64", version: "0.3.247",
        dist: { tarball: nativeTarball, integrity: integrity(nativeBytes) },
      }],
      [sdkTarball, sdkBytes],
      [nativeTarball, nativeBytes],
    ]));
    const probe = vi.fn(async ({ version }) => ({ version }));
    const extract = async (_tarball, destination, { artifact }) => {
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, artifact.role === "sdk" ? "sdk.mjs" : "claude"), "runtime", { mode: 0o755 });
    };

    try {
      const installer = createManagedRuntimeInstaller({
        root, platform: "darwin", architecture: "arm64", fetch, extract, probes: { claude: probe },
      });
      const [first, second] = await Promise.all([
        installer.ensure("claude", "0.3.200"),
        installer.ensure("claude", "0.3.240"),
      ]);
      expect(first).toBe(second);
      expect(fetch).toHaveBeenCalledTimes(4);
      expect(probe).toHaveBeenCalledOnce();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves the Codex platform artifact through the root package alias", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const nativeBytes = Buffer.from("codex windows archive");
    const tarball = "https://registry.npmjs.org/codex-windows.tgz";
    const fetch = registryFixture(new Map([
      ["https://registry.npmjs.org/@openai%2fcodex/latest", {
        name: "@openai/codex", version: "0.150.1",
        optionalDependencies: { "@openai/codex-win32-x64": "npm:@openai/codex@0.150.1-win32-x64" },
        dist: { tarball: "https://registry.npmjs.org/unused-root.tgz", integrity: integrity(Buffer.from("unused")) },
      }],
      ["https://registry.npmjs.org/@openai%2fcodex/0.150.1-win32-x64", {
        name: "@openai/codex", version: "0.150.1-win32-x64",
        dist: { tarball, integrity: integrity(nativeBytes) },
      }],
      [tarball, nativeBytes],
    ]));

    try {
      const installer = createManagedRuntimeInstaller({
        root, platform: "win32", architecture: "x64", fetch,
        extract: async (_tarball, destination) => {
          const bin = join(destination, "vendor", "x86_64-pc-windows-msvc", "bin");
          await mkdir(bin, { recursive: true });
          await writeFile(join(bin, "codex.exe"), "managed codex");
        },
        probes: { codex: async ({ version }) => ({ version }) },
      });
      const result = await installer.ensure("codex", "0.147.0");
      expect(result).toMatchObject({ runtimeId: "codex", version: "0.150.1", target: "windows-x64" });
      expect(result.executable).toMatch(/vendor[/\\]x86_64-pc-windows-msvc[/\\]bin[/\\]codex\.exe$/);
      expect(fetch.mock.calls.map(([url]) => String(url))).toContain(
        "https://registry.npmjs.org/@openai%2fcodex/0.150.1-win32-x64",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects targets outside the desktop release matrix", () => {
    expect(() => createManagedRuntimeInstaller({ root: "/runtime", platform: "linux", architecture: "x64" }))
      .toThrow("Unsupported managed runtime target: linux-x64");
    expect(() => createManagedRuntimeInstaller({ root: "/runtime", platform: "win32", architecture: "arm64" }))
      .toThrow("Unsupported managed runtime target: win32-arm64");
  });

  it("cancels an active download and leaves no active receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const sdkBytes = Buffer.from("sdk");
    const sdkTarball = "https://registry.npmjs.org/hanging-sdk.tgz";
    const fetch = vi.fn(async (url, options = {}) => {
      if (String(url).endsWith("/latest")) return Response.json({
        name: "@anthropic-ai/claude-agent-sdk", version: "0.3.247",
        optionalDependencies: { "@anthropic-ai/claude-agent-sdk-darwin-arm64": "0.3.247" },
        dist: { tarball: sdkTarball, integrity: integrity(sdkBytes) },
      });
      if (String(url).includes("claude-agent-sdk-darwin-arm64/0.3.247")) return Response.json({
        name: "@anthropic-ai/claude-agent-sdk-darwin-arm64", version: "0.3.247",
        dist: { tarball: "https://registry.npmjs.org/native-unused.tgz", integrity: integrity(Buffer.from("native")) },
      });
      if (String(url) === sdkTarball) {
        const body = new ReadableStream({
          start(controller) {
            options.signal?.addEventListener("abort", () => controller.error(options.signal.reason), { once: true });
          },
        });
        return new Response(body);
      }
      return new Response("missing", { status: 404 });
    });

    try {
      const installer = createManagedRuntimeInstaller({ root, platform: "darwin", architecture: "arm64", fetch });
      const pending = installer.ensure("claude", "0.3.200");
      await vi.waitFor(() => expect(installer.activeOperations()).toEqual(["claude"]));
      await installer.cancelAll();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(installer.activeOperations()).toEqual([]);
      await expect(access(join(root, "claude", "macos-arm64", "active.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves the old active runtime when replacement probing fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    let latest = "0.3.247";
    const fetch = vi.fn(async (url) => {
      const value = String(url);
      const sdkBytes = Buffer.from(`sdk-${latest}`);
      const nativeBytes = Buffer.from(`native-${latest}`);
      if (value.endsWith("/sdk.tgz")) return new Response(sdkBytes);
      if (value.endsWith("/native.tgz")) return new Response(nativeBytes);
      if (value.endsWith("/@anthropic-ai%2fclaude-agent-sdk/latest")) return Response.json({
        name: "@anthropic-ai/claude-agent-sdk", version: latest,
        optionalDependencies: { "@anthropic-ai/claude-agent-sdk-darwin-arm64": latest },
        dist: { tarball: `${value}/sdk.tgz`, integrity: integrity(sdkBytes) },
      });
      if (value.includes(`/@anthropic-ai%2fclaude-agent-sdk-darwin-arm64/${latest}`)) return Response.json({
        name: "@anthropic-ai/claude-agent-sdk-darwin-arm64", version: latest,
        dist: { tarball: `${value}/native.tgz`, integrity: integrity(nativeBytes) },
      });
      return new Response("missing", { status: 404 });
    });
    const probe = vi.fn(async ({ version }) => {
      if (version === "0.3.248") throw new Error("replacement probe failed");
      return { version };
    });
    const extract = async (_tarball, destination, { artifact }) => {
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, artifact.role === "sdk" ? "sdk.mjs" : "claude"), artifact.version, { mode: 0o755 });
    };

    try {
      const installer = createManagedRuntimeInstaller({
        root, platform: "darwin", architecture: "arm64", fetch, extract, probes: { claude: probe },
      });
      const first = await installer.ensure("claude", "0.3.200");
      const activePath = join(root, "claude", "macos-arm64", "active.json");
      const priorReceipt = await readFile(activePath, "utf8");
      latest = "0.3.248";

      await expect(installer.ensure("claude", "0.3.200")).rejects.toThrow("replacement probe failed");

      expect(await readFile(activePath, "utf8")).toBe(priorReceipt);
      expect(await readFile(first.executable, "utf8")).toBe("0.3.247");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("loads and probes an installed runtime without accessing the registry", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    try {
      const fixture = await createInstalledClaude(root);
      fixture.fetch.mockClear();
      fixture.probe.mockClear();

      const installed = await fixture.installer.installed("claude", "0.3.200");

      expect(installed.executable).toBe(fixture.result.executable);
      expect(fixture.fetch).not.toHaveBeenCalled();
      expect(fixture.probe).toHaveBeenCalledOnce();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a missing or below-minimum local runtime without accessing the registry", async () => {
    const missingRoot = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const missingFetch = vi.fn(() => { throw new Error("network must not be used"); });
    try {
      const missing = createManagedRuntimeInstaller({
        root: missingRoot, platform: "darwin", architecture: "arm64", fetch: missingFetch,
        probes: { claude: async ({ version }) => ({ version }) },
      });
      await expect(missing.installed("claude", "0.3.200")).rejects.toThrow("not installed");
      expect(missingFetch).not.toHaveBeenCalled();

      const fixture = await createInstalledClaude(missingRoot);
      fixture.fetch.mockClear();
      await expect(fixture.installer.installed("claude", "0.4.0")).rejects.toThrow("below required 0.4.0");
      expect(fixture.fetch).not.toHaveBeenCalled();
    } finally {
      await rm(missingRoot, { recursive: true, force: true });
    }
  });

  it("rejects corrupt installed state without accessing the registry", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    try {
      const fixture = await createInstalledClaude(root);
      fixture.fetch.mockClear();
      await rm(fixture.result.executable, { force: true });

      await expect(fixture.installer.installed("claude", "0.3.200")).rejects.toThrow(/executable is missing/i);
      expect(fixture.fetch).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("repairs a latest Claude installation whose managed SDK module is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    try {
      const fixture = await createInstalledClaude(root);
      await rm(fixture.result.modulePath, { force: true });

      const repaired = await fixture.installer.ensure("claude", "0.3.200");

      await expect(access(repaired.modulePath)).resolves.toBeUndefined();
      expect(repaired.receipt.installation).not.toBe(fixture.result.receipt.installation);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stages an incoming app version without changing active runtime state", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const sdkBytes = Buffer.from("pending sdk");
    const nativeBytes = Buffer.from("pending native");
    const sdkTarball = "https://registry.npmjs.org/pending-sdk.tgz";
    const nativeTarball = "https://registry.npmjs.org/pending-native.tgz";
    const fetch = registryFixture(new Map([
      ["https://registry.npmjs.org/@anthropic-ai%2fclaude-agent-sdk/latest", {
        name: "@anthropic-ai/claude-agent-sdk", version: "0.3.247",
        optionalDependencies: { "@anthropic-ai/claude-agent-sdk-darwin-arm64": "0.3.247" },
        dist: { tarball: sdkTarball, integrity: integrity(sdkBytes) },
      }],
      ["https://registry.npmjs.org/@anthropic-ai%2fclaude-agent-sdk-darwin-arm64/0.3.247", {
        name: "@anthropic-ai/claude-agent-sdk-darwin-arm64", version: "0.3.247",
        dist: { tarball: nativeTarball, integrity: integrity(nativeBytes) },
      }],
      [sdkTarball, sdkBytes],
      [nativeTarball, nativeBytes],
    ]));
    const installer = createManagedRuntimeInstaller({
      root, platform: "darwin", architecture: "arm64", fetch,
      probes: { claude: async ({ version }) => ({ version }) },
      extract: async (_tarball, destination, { artifact }) => {
        await mkdir(destination, { recursive: true });
        await writeFile(join(destination, artifact.role === "sdk" ? "sdk.mjs" : "claude"), artifact.version, { mode: 0o755 });
      },
    });

    try {
      const staged = await installer.stageForAppUpdate("0.2.15", [
        { runtimeId: "claude", minimumVersion: "0.3.200" },
      ]);

      expect(staged.failures).toEqual([]);
      expect(staged.staged).toEqual([expect.objectContaining({ runtimeId: "claude", version: "0.3.247", appVersion: "0.2.15" })]);
      await expect(access(join(root, "claude", "macos-arm64", "active.json"))).rejects.toMatchObject({ code: "ENOENT" });
      const pending = JSON.parse(await readFile(
        join(root, ".pending-app-updates", "0.2.15", "claude-macos-arm64.json"),
        "utf8",
      ));
      expect(pending).toMatchObject({ appVersion: "0.2.15", runtimeId: "claude", version: "0.3.247" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("coalesces app-update staging and Connect for the same runtime and platform", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const routes = latestClaudeRoutes("0.3.247", "coalesced");
    const registry = registryFixture(routes);
    const gate = deferred();
    let held = false;
    const fetch = vi.fn(async (url) => {
      if (!held) {
        held = true;
        await gate.promise;
      }
      return registry(url);
    });
    const installer = createManagedRuntimeInstaller({
      root, platform: "darwin", architecture: "arm64", fetch,
      probes: { claude: async ({ version }) => ({ version }) },
      extract: async (_tarball, destination, { artifact }) => {
        await mkdir(destination, { recursive: true });
        await writeFile(join(destination, artifact.role === "sdk" ? "sdk.mjs" : "claude"), "runtime", { mode: 0o755 });
      },
    });
    try {
      const staging = installer.stageForAppUpdate("0.2.15", [
        { runtimeId: "claude", minimumVersion: "0.3.200" },
      ]);
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      const connecting = installer.ensure("claude", "0.3.200");
      gate.resolve();

      await expect(staging).resolves.toMatchObject({ failures: [] });
      await expect(connecting).resolves.toMatchObject({ runtimeId: "claude", version: "0.3.247" });
      expect(fetch).toHaveBeenCalledTimes(4);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("coalesces Connect followed by app-update staging for the same runtime and platform", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const registry = registryFixture(latestClaudeRoutes("0.3.247", "connect-first"));
    const gate = deferred();
    let held = false;
    const fetch = vi.fn(async (url) => {
      if (!held) {
        held = true;
        await gate.promise;
      }
      return registry(url);
    });
    const installer = createManagedRuntimeInstaller({
      root, platform: "darwin", architecture: "arm64", fetch,
      probes: { claude: async ({ version }) => ({ version }) },
      extract: async (_tarball, destination, { artifact }) => {
        await mkdir(destination, { recursive: true });
        await writeFile(join(destination, artifact.role === "sdk" ? "sdk.mjs" : "claude"), "runtime", { mode: 0o755 });
      },
    });
    try {
      const connecting = installer.ensure("claude", "0.3.200");
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      const staging = installer.stageForAppUpdate("0.2.15", [
        { runtimeId: "claude", minimumVersion: "0.3.200" },
      ]);
      gate.resolve();

      await expect(connecting).resolves.toMatchObject({ runtimeId: "claude" });
      await expect(staging).resolves.toMatchObject({ failures: [] });
      expect(fetch).toHaveBeenCalledTimes(4);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("activates only the exact pending app version locally after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const sdkBytes = Buffer.from("restart sdk");
    const nativeBytes = Buffer.from("restart native");
    const sdkTarball = "https://registry.npmjs.org/restart-sdk.tgz";
    const nativeTarball = "https://registry.npmjs.org/restart-native.tgz";
    const fetch = registryFixture(new Map([
      ["https://registry.npmjs.org/@anthropic-ai%2fclaude-agent-sdk/latest", {
        name: "@anthropic-ai/claude-agent-sdk", version: "0.3.247",
        optionalDependencies: { "@anthropic-ai/claude-agent-sdk-darwin-arm64": "0.3.247" },
        dist: { tarball: sdkTarball, integrity: integrity(sdkBytes) },
      }],
      ["https://registry.npmjs.org/@anthropic-ai%2fclaude-agent-sdk-darwin-arm64/0.3.247", {
        name: "@anthropic-ai/claude-agent-sdk-darwin-arm64", version: "0.3.247",
        dist: { tarball: nativeTarball, integrity: integrity(nativeBytes) },
      }],
      [sdkTarball, sdkBytes],
      [nativeTarball, nativeBytes],
    ]));
    const probe = vi.fn(async ({ version }) => ({ version }));
    const installer = createManagedRuntimeInstaller({
      root, platform: "darwin", architecture: "arm64", fetch, probes: { claude: probe },
      extract: async (_tarball, destination, { artifact }) => {
        await mkdir(destination, { recursive: true });
        await writeFile(join(destination, artifact.role === "sdk" ? "sdk.mjs" : "claude"), artifact.version, { mode: 0o755 });
      },
    });

    try {
      await installer.stageForAppUpdate("0.2.15", [{ runtimeId: "claude", minimumVersion: "0.3.200" }]);
      fetch.mockClear();
      const wrongVersion = await installer.activatePendingAppUpdate("0.2.16");
      expect(wrongVersion).toEqual({ appVersion: "0.2.16", activated: [], failures: [] });
      const activated = await installer.activatePendingAppUpdate("0.2.15");

      expect(activated.failures).toEqual([]);
      expect(activated.activated).toEqual([expect.objectContaining({ runtimeId: "claude", version: "0.3.247" })]);
      expect(fetch).not.toHaveBeenCalled();
      await expect(access(join(root, ".pending-app-updates", "0.2.15", "claude-macos-arm64.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(installer.installed("claude", "0.3.200")).resolves.toMatchObject({ version: "0.3.247" });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports an unreadable pending-update directory without blocking startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    try {
      const unreadable = Object.assign(new Error("unreadable pending update"), { code: "EACCES" });
      const installer = createManagedRuntimeInstaller({
        root,
        platform: "darwin",
        architecture: "arm64",
        readPendingUpdateDirectory: async () => { throw unreadable; },
      });

      await expect(installer.activatePendingAppUpdate("2.0.0")).resolves.toEqual({
        appVersion: "2.0.0",
        activated: [],
        failures: [{ runtimeId: null, error: unreadable }],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("tracks and safely cancels restart activation before the active pointer changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const fetch = registryFixture(latestClaudeRoutes("0.3.247", "activation-cancel"));
    let probeCalls = 0;
    const installer = createManagedRuntimeInstaller({
      root, platform: "darwin", architecture: "arm64", fetch,
      probes: { claude: async ({ version, signal }) => {
        probeCalls += 1;
        if (probeCalls === 1) return { version };
        await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
        return { version };
      } },
      extract: async (_tarball, destination, { artifact }) => {
        await mkdir(destination, { recursive: true });
        await writeFile(join(destination, artifact.role === "sdk" ? "sdk.mjs" : "claude"), "runtime", { mode: 0o755 });
      },
    });
    try {
      const staged = await installer.stageForAppUpdate("0.2.15", [{ runtimeId: "claude", minimumVersion: "0.3.200" }]);
      const activation = installer.activatePendingAppUpdate("0.2.15");
      await vi.waitFor(() => expect(installer.activeOperations()).toContain("claude"));

      await installer.cancelAll();
      await expect(activation).resolves.toMatchObject({ failures: [expect.objectContaining({ runtimeId: "claude" })] });
      await expect(access(join(root, "claude", "macos-arm64", "active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(join(root, ".pending-app-updates", "0.2.15", "claude-macos-arm64.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(staged.staged[0].executable)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cleans a failed automatic activation and recovers only through a fresh ensure", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    let probeCalls = 0;
    const installer = createManagedRuntimeInstaller({
      root,
      platform: "darwin",
      architecture: "arm64",
      fetch: registryFixture(latestClaudeRoutes("0.3.247", "retry-explicit")),
      probes: { claude: async ({ version }) => {
        probeCalls += 1;
        if (probeCalls === 2) throw new Error("transient activation failure");
        return { version };
      } },
      extract: async (_tarball, destination, { artifact }) => {
        await mkdir(destination, { recursive: true });
        await writeFile(join(destination, artifact.role === "sdk" ? "sdk.mjs" : "claude"), "runtime", { mode: 0o755 });
      },
    });
    try {
      const staged = await installer.stageForAppUpdate("2.0.0", [
        { runtimeId: "claude", minimumVersion: "0.3.200" },
      ]);

      await expect(installer.activatePendingAppUpdate("2.0.0")).resolves.toMatchObject({
        failures: [expect.objectContaining({ runtimeId: "claude" })],
      });
      expect(probeCalls).toBe(2);
      await expect(access(staged.staged[0].executable)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(installer.activatePendingAppUpdate("2.0.0")).resolves.toEqual({
        appVersion: "2.0.0",
        activated: [],
        failures: [],
      });
      expect(probeCalls).toBe(2);

      await expect(installer.ensure("claude", "0.3.200")).resolves.toMatchObject({
        runtimeId: "claude",
        version: "0.3.247",
      });
      expect(probeCalls).toBe(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to activate a pending runtime older than the active generation", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    try {
      const fixture = await createInstalledClaude(root);
      fixture.fetch.mockImplementation(registryFixture(latestClaudeRoutes("0.3.248", "active-newer")));
      const active = await fixture.installer.ensure("claude", "0.3.200");
      fixture.fetch.mockImplementation(registryFixture(latestClaudeRoutes("0.3.247", "pending-older")));
      const staged = await fixture.installer.stageForAppUpdate("2.0.0", [
        { runtimeId: "claude", minimumVersion: "0.3.200" },
      ]);

      const activation = await fixture.installer.activatePendingAppUpdate("2.0.0");

      expect(activation.activated).toEqual([]);
      expect(activation.failures).toEqual([
        expect.objectContaining({ runtimeId: "claude", error: expect.objectContaining({ message: expect.stringContaining("would downgrade") }) }),
      ]);
      await expect(fixture.installer.installed("claude", "0.3.200"))
        .resolves.toMatchObject({ version: "0.3.248", receipt: { installation: active.receipt.installation } });
      await expect(access(join(root, ".pending-app-updates", "2.0.0", "claude-macos-arm64.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(staged.staged[0].executable)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retains the prior active generation when Connect coalesces with an app-update activation", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    try {
      const fixture = await createInstalledClaude(root);
      const priorExecutable = fixture.result.executable;
      const registry = registryFixture(latestClaudeRoutes("0.3.248", "coalesced-upgrade"));
      const gate = deferred();
      let held = false;
      fixture.fetch.mockImplementation(async (url) => {
        if (!held) {
          held = true;
          await gate.promise;
        }
        return registry(url);
      });
      const staging = fixture.installer.stageForAppUpdate("2.0.0", [
        { runtimeId: "claude", minimumVersion: "0.3.200" },
      ]);
      await vi.waitFor(() => expect(fixture.fetch).toHaveBeenCalled());
      const connecting = fixture.installer.ensure("claude", "0.3.200");
      gate.resolve();

      await expect(staging).resolves.toMatchObject({ failures: [] });
      await expect(connecting).resolves.toMatchObject({ version: "0.3.248" });
      await expect(access(priorExecutable)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reclaims a superseded pending app-update generation when a newer update stages", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const installer = createManagedRuntimeInstaller({
      root, platform: "darwin", architecture: "arm64",
      fetch: registryFixture(latestClaudeRoutes("0.3.247", "superseded")),
      probes: { claude: async ({ version }) => ({ version }) },
      extract: async (_tarball, destination, { artifact }) => {
        await mkdir(destination, { recursive: true });
        await writeFile(join(destination, artifact.role === "sdk" ? "sdk.mjs" : "claude"), "runtime", { mode: 0o755 });
      },
    });
    try {
      const first = await installer.stageForAppUpdate("0.2.15", [{ runtimeId: "claude", minimumVersion: "0.3.200" }]);
      const supersededInstallation = first.staged[0].receipt.installation;
      await installer.stageForAppUpdate("0.2.16", [{ runtimeId: "claude", minimumVersion: "0.3.200" }]);

      await expect(access(join(root, ".pending-app-updates", "0.2.15"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(join(root, "claude", "macos-arm64", "installations", supersededInstallation)))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves the active runtime intact when app-update staging fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    try {
      const fixture = await createInstalledClaude(root);
      const previousInstallation = fixture.result.receipt.installation;
      fixture.fetch.mockImplementation(registryFixture(latestClaudeRoutes("0.3.248", "failed-update")));
      fixture.probe.mockImplementation(async ({ version }) => {
        if (version === "0.3.248") throw new Error("new runtime failed its probe");
        return { version };
      });

      const staged = await fixture.installer.stageForAppUpdate("0.2.15", [
        { runtimeId: "claude", minimumVersion: "0.3.200" },
      ]);

      expect(staged.staged).toEqual([]);
      expect(staged.failures).toEqual([
        expect.objectContaining({ runtimeId: "claude", error: expect.objectContaining({ message: "new runtime failed its probe" }) }),
      ]);
      await expect(fixture.installer.installed("claude", "0.3.200"))
        .resolves.toMatchObject({ version: "0.3.247", receipt: { installation: previousInstallation } });
      await expect(access(join(root, ".pending-app-updates", "0.2.15", "claude-macos-arm64.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a cached provider adapter executable usable after a later Connect upgrades the same runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    try {
      const fixture = await createInstalledClaude(root);
      const firstProvider = {
        execute: async () => readFile(fixture.result.executable, "utf8"),
      };
      fixture.fetch.mockImplementation(registryFixture(latestClaudeRoutes("0.3.248", "connect-upgrade")));

      const upgraded = await fixture.installer.ensure("claude", "0.3.200");

      expect(upgraded.version).toBe("0.3.248");
      expect(upgraded.receipt.installation).not.toBe(fixture.result.receipt.installation);
      await expect(firstProvider.execute()).resolves.toBe("runtime");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prunes retired Connect generations on restart while preserving active and pending installations", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    try {
      const fixture = await createInstalledClaude(root);
      fixture.fetch.mockImplementation(registryFixture(latestClaudeRoutes("0.3.248", "connect-prune")));
      const active = await fixture.installer.ensure("claude", "0.3.200");
      fixture.fetch.mockImplementation(registryFixture(latestClaudeRoutes("0.3.249", "pending-prune")));
      const pending = await fixture.installer.stageForAppUpdate("2.0.0", [
        { runtimeId: "claude", minimumVersion: "0.3.200" },
      ]);

      const removed = await fixture.installer.pruneInactiveInstallations();

      expect(removed).toEqual({
        removed: [{ runtimeId: "claude", installation: fixture.result.receipt.installation }],
        failures: [],
      });
      await expect(access(fixture.result.executable)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(active.executable)).resolves.toBeUndefined();
      await expect(access(pending.staged[0].executable)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves an unknown unretained installation directory without an ownership receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const unknown = "99999999-9999-4999-8999-999999999999";
    try {
      const fixture = await createInstalledClaude(root);
      const unknownPath = join(root, "claude", "macos-arm64", "installations", unknown);
      await mkdir(unknownPath, { recursive: true });
      await writeFile(join(unknownPath, "user-note"), "not owned by Relayer");

      await expect(fixture.installer.pruneInactiveInstallations()).resolves.toEqual({ removed: [], failures: [] });
      await expect(readFile(join(unknownPath, "user-note"), "utf8")).resolves.toBe("not owned by Relayer");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes only abandoned UUID staging directories with Windows-safe retries", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const abandoned = [
      "claude-11111111-1111-4111-8111-111111111111",
      "codex-update-22222222-2222-4222-8222-222222222222",
    ];
    const retained = ["notes", "claude-not-a-uuid", "other-33333333-3333-4333-8333-333333333333"];
    const removeDirectory = vi.fn((path, options) => rm(path, options));
    try {
      await Promise.all([...abandoned, ...retained].map((name) => (
        mkdir(join(root, ".staging", name), { recursive: true })
      )));
      const installer = createManagedRuntimeInstaller({
        root,
        platform: "darwin",
        architecture: "arm64",
        removeDirectory,
      });

      const pruning = await installer.pruneInactiveInstallations();

      expect(pruning.removed).toEqual([
        { runtimeId: "claude", staging: abandoned[0] },
        { runtimeId: "codex", staging: abandoned[1] },
      ]);
      for (const name of abandoned) await expect(access(join(root, ".staging", name))).rejects.toMatchObject({ code: "ENOENT" });
      for (const name of retained) await expect(access(join(root, ".staging", name))).resolves.toBeUndefined();
      expect(removeDirectory).toHaveBeenCalledTimes(2);
      for (const [, options] of removeDirectory.mock.calls) {
        expect(options).toMatchObject({ recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a locked retired generation without making startup cleanup fatal", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const activeInstallation = "11111111-1111-4111-8111-111111111111";
    const lockedInstallation = "22222222-2222-4222-8222-222222222222";
    try {
      const base = join(root, "claude", "macos-arm64");
      await mkdir(join(base, "installations", activeInstallation), { recursive: true });
      await mkdir(join(base, "installations", lockedInstallation), { recursive: true });
      await writeFile(join(base, "installations", lockedInstallation, ".relayer-managed-runtime.json"), JSON.stringify({
        schemaVersion: 1,
        runtimeId: "claude",
        target: "macos-arm64",
        installation: lockedInstallation,
        ownedPath: `claude/macos-arm64/installations/${lockedInstallation}`,
      }));
      await writeFile(join(base, "active.json"), JSON.stringify({
        schemaVersion: 1,
        runtimeId: "claude",
        target: "macos-arm64",
        installation: activeInstallation,
      }));
      const locked = Object.assign(new Error("locked"), { code: "EBUSY" });
      const installer = createManagedRuntimeInstaller({
        root,
        platform: "darwin",
        architecture: "arm64",
        removeInactiveInstallation: async (path) => {
          if (path.endsWith(lockedInstallation)) throw locked;
          await rm(path, { recursive: true, force: true });
        },
      });

      const pruning = await installer.pruneInactiveInstallations();

      expect(pruning.removed).toEqual([]);
      expect(pruning.failures).toEqual([{ runtimeId: "claude", installation: lockedInstallation, error: locked }]);
      await expect(access(join(base, "installations", lockedInstallation))).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves every generation when the active receipt is corrupt", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const installation = "33333333-3333-4333-8333-333333333333";
    try {
      const base = join(root, "claude", "macos-arm64");
      await mkdir(join(base, "installations", installation), { recursive: true });
      await writeFile(join(base, "active.json"), "{not-json");
      const installer = createManagedRuntimeInstaller({ root, platform: "darwin", architecture: "arm64" });

      const pruning = await installer.pruneInactiveInstallations();

      expect(pruning.removed).toEqual([]);
      expect(pruning.failures).toHaveLength(1);
      expect(pruning.failures[0]).toMatchObject({ runtimeId: "claude", installation: null });
      await expect(access(join(base, "installations", installation))).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves all generations when pending-update retention cannot be enumerated", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const installation = "44444444-4444-4444-8444-444444444444";
    try {
      const base = join(root, "claude", "macos-arm64");
      await mkdir(join(base, "installations", installation), { recursive: true });
      const unreadable = Object.assign(new Error("unreadable"), { code: "EACCES" });
      const installer = createManagedRuntimeInstaller({
        root,
        platform: "darwin",
        architecture: "arm64",
        readPruneDirectory: async (path) => {
          if (path === join(root, ".pending-app-updates")) throw unreadable;
          return [];
        },
      });

      const pruning = await installer.pruneInactiveInstallations();

      expect(pruning.removed).toEqual([]);
      expect(pruning.failures).toEqual([{ runtimeId: null, installation: null, error: unreadable }]);
      await expect(access(join(base, "installations", installation))).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("activates a staged update locally and removes the old active generation", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    try {
      const fixture = await createInstalledClaude(root);
      const previousInstallation = fixture.result.receipt.installation;
      const previousPath = join(root, "claude", "macos-arm64", "installations", previousInstallation);
      fixture.fetch.mockImplementation(registryFixture(latestClaudeRoutes("0.3.248", "successful-update")));

      const staged = await fixture.installer.stageForAppUpdate("0.2.15", [
        { runtimeId: "claude", minimumVersion: "0.3.200" },
      ]);
      expect(staged.failures).toEqual([]);
      expect(staged.staged[0].receipt.installation).not.toBe(previousInstallation);
      await expect(access(previousPath)).resolves.toBeUndefined();

      fixture.fetch.mockClear();
      const activated = await fixture.installer.activatePendingAppUpdate("0.2.15");

      expect(activated.failures).toEqual([]);
      expect(activated.activated).toEqual([expect.objectContaining({ version: "0.3.248" })]);
      expect(fixture.fetch).not.toHaveBeenCalled();
      await expect(access(previousPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fixture.installer.installed("claude", "0.3.200"))
        .resolves.toMatchObject({ version: "0.3.248" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
