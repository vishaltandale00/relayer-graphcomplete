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

async function rejectionOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return null;
}

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

function claudeExtract() {
  return async (_tarball, destination, { artifact }) => {
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, artifact.role === "sdk" ? "sdk.mjs" : "claude"), "runtime", { mode: 0o755 });
  };
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
    extract: claudeExtract(),
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
    extract: claudeExtract(),
    ...options,
  });
  return { installer, fetch, recipe };
}

async function activeReceipt(root, runtimeId = "claude") {
  return JSON.parse(await readFile(join(root, runtimeId, "macos-arm64", "active.json"), "utf8"));
}

function legacyReceipt(receipt) {
  const legacy = { ...receipt, schemaVersion: 1 };
  delete legacy.recipeId;
  delete legacy.recipeDigest;
  delete legacy.recipeSchemaVersion;
  delete legacy.assembler;
  delete legacy.readinessContractVersion;
  return legacy;
}

function probeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn();
  return child;
}

describe("managed runtime installer", () => {
  it("prepares, validates, repairs, and reuses the exact recipe lifecycle", { timeout: 30_000 }, async () => {
    const exactInterface = createExactManagedRuntimeInstaller({
      root: join(tmpdir(), "relayer-managed-runtime-exact-interface"),
      platform: "darwin", architecture: "arm64",
    });
    expect(exactInterface.ensure, "the production interface exposes no minimum-version ensure").toBeUndefined();
    expect((await rejectionOf(exactInterface.stageForAppUpdate("0.2.26", [{
      runtimeId: "claude", minimumVersion: "0.3.250",
    }])))?.message ?? "promise resolved instead of rejecting", "the production interface rejects minimum-version staging").toMatch(/exact recipe identity/i);

    const exactOnlyRoot = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const requested = [];
    try {
      const exactOnlyInstaller = createManagedRuntimeInstaller({
        root: exactOnlyRoot, platform: "darwin", architecture: "arm64",
        fetch: vi.fn(async (url) => {
          requested.push(String(url));
          return new Response("not-the-reviewed-artifact");
        }),
      });
      expect((await rejectionOf(exactOnlyInstaller.prepare("claude@0.3.250")))?.message ?? "promise resolved instead of rejecting", "the app-owned recipe still fails closed on unreviewed bytes").toMatch(/integrity verification failed/i);
      expect(requested, "only the exact pinned tarball is requested").toEqual([
        "https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.250.tgz",
      ]);
      expect(requested.every((url) => !url.includes("/latest")), "vendor latest is never discovered").toBe(true);
    } finally {
      await rm(exactOnlyRoot, { recursive: true, force: true });
    }

    const validationRoot = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const validationProbe = vi.fn(async ({ version }) => ({ version }));
    try {
      const { installer, fetch } = exactClaudeInstaller(validationRoot, "local-validation", { probes: { claude: validationProbe } });
      const prepared = await installer.prepare("claude-fixture@0.3.250");
      expect(validationProbe, "preparation probes readiness once").toHaveBeenCalledOnce();
      const networkCallsAfterPreparation = fetch.mock.calls.length;

      await expect(installer.validate("claude-fixture@0.3.250"),
        "local validation reuses the installed descriptor").resolves.toMatchObject({
        installation: prepared.installation,
        privateStateRoot: join(validationRoot, "claude", "macos-arm64", "private-state", prepared.installation),
      });
      expect(validationProbe, "validation never re-runs the readiness probe").toHaveBeenCalledOnce();
      expect(fetch, "validation never touches the network").toHaveBeenCalledTimes(networkCallsAfterPreparation);
    } finally {
      await rm(validationRoot, { recursive: true, force: true });
    }

    for (const [label, mutate, message, observe] of [
      ["a private-state escape symlink", async (prepared, { root, outside }) => {
        await rm(prepared.privateStateRoot, { recursive: true, force: true });
        await symlink(outside, prepared.privateStateRoot, "dir");
      }, /private state.*owned directory/i, async ({ outside }) => {
        expect(await readdir(outside), "the escape target stays empty").toEqual([]);
      }],
      ["a private-state ancestor redirect", async (prepared, { root }) => {
        const privateStateParent = join(root, "claude", "macos-arm64", "private-state");
        const redirectedParent = join(root, "redirected-private-state");
        await rm(privateStateParent, { recursive: true, force: true });
        await mkdir(join(redirectedParent, prepared.installation), { recursive: true });
        await symlink(redirectedParent, privateStateParent, "dir");
      }, /private state escapes the managed runtime root/i, null],
      ["a changed ownership marker", async (prepared) => {
        await writeFile(join(prepared.installationRoot, ".relayer-managed-runtime.json"), JSON.stringify({
          schemaVersion: 1,
          runtimeId: "claude",
          target: "macos-arm64",
          installation: "22222222-2222-4222-8222-222222222222",
          ownedPath: "claude/macos-arm64/installations/22222222-2222-4222-8222-222222222222",
        }));
      }, /installation ownership marker is invalid/i, null],
    ]) {
      const root = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
      const outside = await mkdtemp(join(tmpdir(), "relayer-private-state-outside-"));
      try {
        const { installer } = exactClaudeInstaller(root, `validate-${label}`);
        const prepared = await installer.prepare("claude-fixture@0.3.250");
        await mutate(prepared, { root, outside });
        expect((await rejectionOf(installer.validate("claude-fixture@0.3.250")))?.message ?? "promise resolved instead of rejecting", label).toMatch(message);
        if (observe) await observe({ root, outside });
      } finally {
        await rm(root, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
      }
    }

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

        expect((await rejectionOf(installer.validate("claude-fixture@0.3.250")))?.message ?? "promise resolved instead of rejecting", `a ${entrypoint} symlink escaping its installation`).toMatch(/entrypoint escapes its managed installation/i);
        expect(await readFile(outsideFile, "utf8"), "the user-owned escape target is never modified")
          .toBe("outside remains user-owned");
      } finally {
        await rm(root, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
      }
    }

    const privateStateRoot = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const privateStateOutside = await mkdtemp(join(tmpdir(), "relayer-private-state-outside-"));
    const privateStateProbe = vi.fn()
      .mockImplementationOnce(async ({ version }) => ({ version }))
      .mockRejectedValueOnce(new Error("active runtime needs repair"))
      .mockImplementation(async ({ version }) => ({ version }));
    try {
      const { installer } = exactClaudeInstaller(privateStateRoot, "private-state-symlink", { probes: { claude: privateStateProbe } });
      await installer.prepare("claude-fixture@0.3.250");
      const privateStateParent = join(privateStateRoot, "claude", "macos-arm64", "private-state");
      await rm(privateStateParent, { recursive: true, force: true });
      await symlink(privateStateOutside, privateStateParent, "dir");

      expect((await rejectionOf(installer.prepare("claude-fixture@0.3.250")))?.message ?? "promise resolved instead of rejecting", "repair never creates descriptor-owned private state through a preexisting symlink").toMatch(/private-state root is not an owned directory/i);
      expect(await rejectionOf(access(join(privateStateOutside, "sentinel"))), "no sentinel is written outside the managed root").toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(privateStateRoot, "claude", "macos-arm64", "active.json"), "utf8"),
        "the prior installation receipt survives the refused repair").toContain("installation");
    } finally {
      await rm(privateStateRoot, { recursive: true, force: true });
      await rm(privateStateOutside, { recursive: true, force: true });
    }

    const primeRoot = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const primeArtifacts = ["uv", "python", "prime", "wheel", "python-client"].map((role) => {
      const bytes = Buffer.from(`${role}-bytes`);
      return {
        role, package: `fixture-${role}`, version: "1.0.0", kind: role === "wheel" ? "wheel" : "archive",
        tarball: `https://artifacts.example.test/${role}.tgz`, integrity: integrity(bytes), bytes,
      };
    });
    const primeRecipe = exactRecipe({
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
      artifacts: primeArtifacts.map(({ bytes: _bytes, ...artifact }) => artifact),
    });
    const assembleRecipe = vi.fn(async ({ installationRoot, environment, tools }) => {
      expect(environment, "assembly sees a scrubbed environment").toMatchObject({ PATH: "", UV_NO_CONFIG: "1", UV_NO_MODIFY_PATH: "1" });
      expect(environment, "assembly never sees HOME").not.toHaveProperty("HOME");
      expect(tools, "assembly receives the managed uv and python tools").toEqual({
        uv: join(installationRoot, "uv", "uv"),
        python: join(installationRoot, "python", "bin", "python3"),
      });
      for (const [name, value] of Object.entries(environment)) {
        if (["PATH", "UV_NO_CONFIG", "UV_NO_MODIFY_PATH"].includes(name)) continue;
        expect(value.startsWith(primeRoot), `${name} escaped the managed root`).toBe(true);
      }
      await mkdir(join(installationRoot, "prime", "bin"), { recursive: true });
      await writeFile(join(installationRoot, "prime", "bin", "prime"), "fixture", { mode: 0o755 });
    });
    const primeProbe = vi.fn(async ({ version }) => ({ version }));
    const primeInstaller = createManagedRuntimeInstaller({
      root: primeRoot, platform: "darwin", architecture: "arm64",
      resolveRecipe: (recipeId, target) => {
        expect([recipeId, target], "recipe resolution receives the exact request").toEqual(["prime-fixture@1.0.0", "macos-arm64"]);
        return primeRecipe;
      },
      assembleRecipe,
      fetch: registryFixture(new Map(primeArtifacts.map(({ tarball, bytes }) => [tarball, bytes]))),
      extract: async (_tarball, destination) => mkdir(destination, { recursive: true }),
      probes: { prime: primeProbe },
    });
    try {
      const prepared = await primeInstaller.prepare("prime-fixture@1.0.0");
      expect(prepared, "the Prime-shaped recipe prepares inside one isolated managed root").toMatchObject({
        runtimeId: "prime", recipeId: "prime-fixture@1.0.0", version: "1.0.0", target: "macos-arm64",
      });
      expect(prepared, "preparation never exposes a receipt").not.toHaveProperty("receipt");
      expect(await activeReceipt(primeRoot, "prime"), "the active receipt owns installation and private state").toMatchObject({
        ownedPaths: [
          `prime/macos-arm64/installations/${prepared.installation}`,
          `prime/macos-arm64/private-state/${prepared.installation}`,
        ],
      });
      expect(prepared.executable.startsWith(primeRoot), "the executable stays inside the managed root").toBe(true);
      await expect(primeInstaller.installed("prime-fixture@1.0.0"), "installed resolves the prepared recipe")
        .resolves.toMatchObject({ recipeId: "prime-fixture@1.0.0" });
      expect(primeProbe, "the readiness probe ran once").toHaveBeenCalledOnce();
      expect(assembleRecipe, "the assembler ran once").toHaveBeenCalledOnce();

      await writeFile(join(primeRoot, "prime", "macos-arm64", "active.json"), `${JSON.stringify(legacyReceipt(await activeReceipt(primeRoot, "prime")), null, 2)}\n`);
      expect((await rejectionOf(primeInstaller.installed("prime-fixture@1.0.0")))?.message ?? "promise resolved instead of rejecting", "a legacy receipt without recipe identity is rejected").toMatch(/does not match requested recipe/i);
    } finally {
      await rm(primeRoot, { recursive: true, force: true });
    }

    const rejectionCases = [
      ["a source distribution", "prime-fixture@1.0.0", () => exactRecipe({
        schemaVersion: 1, recipeId: "prime-fixture@1.0.0",
        runtimeId: "prime", version: "1.0.0", target: "macos-arm64",
        assembler: "prime-fixture-v1", readinessContractVersion: 1,
        executableRelativePath: "prime/bin/prime", moduleRelativePath: null,
        artifacts: [{
          role: "python-source", package: "prime-source", version: "1.0.0", kind: "sdist",
          tarball: "https://artifacts.example.test/prime.tar.gz", integrity: integrity("source"),
        }],
      }), "prime", /source distributions/i],
      ["a Prime recipe without a Python runtime contract", "prime-fixture@1.0.0", () => exactRecipe({
        schemaVersion: 1, recipeId: "prime-fixture@1.0.0",
        runtimeId: "prime", version: "1.0.0", target: "macos-arm64",
        assembler: "prime-fixture-v1", readinessContractVersion: 1,
        executableRelativePath: "prime/bin/prime", moduleRelativePath: null,
        artifacts: [{
          role: "prime", package: "prime", version: "1.0.0", kind: "archive",
          tarball: "https://artifacts.example.test/prime.tgz", integrity: integrity("prime"),
        }],
      }), "prime", /Python runtime contract/i],
      ["a digest that does not authenticate the lock", "fixture@1.0.0", () => ({
        schemaVersion: 1, recipeId: "fixture@1.0.0", recipeDigest: "c".repeat(64),
        runtimeId: "fixture", version: "1.0.0", target: "macos-arm64",
        assembler: "fixture-v1", readinessContractVersion: 1,
        executableRelativePath: "bin/fixture", moduleRelativePath: null,
        artifacts: [{
          role: "native", package: "fixture", version: "1.0.0", kind: "archive",
          tarball: "https://artifacts.example.test/fixture.tgz", integrity: integrity("fixture"),
        }],
      }), "fixture", /recipe digest/i],
      ["a recipe-controlled filesystem segment", "fixture@1.0.0", () => exactRecipe({
        schemaVersion: 1, recipeId: "fixture@1.0.0", runtimeId: "fixture", version: "1.0.0",
        target: "macos-arm64", assembler: "fixture-v1", readinessContractVersion: 1,
        executableRelativePath: "bin/fixture", moduleRelativePath: null,
        artifacts: [{
          role: "../../user-owned", package: "fixture", version: "1.0.0", kind: "archive",
          tarball: "https://artifacts.example.test/fixture.tgz", integrity: integrity("fixture"),
        }],
      }), "fixture", /artifact role is invalid/i],
    ];
    expect(rejectionCases, "prepare rejection inventory").toHaveLength(4);
    for (const [label, recipeId, buildRecipe, runtimeId, message] of rejectionCases) {
      const fetch = vi.fn();
      const installer = createManagedRuntimeInstaller({
        root: join(tmpdir(), `relayer-managed-runtime-rejection-${runtimeId}`),
        platform: "darwin", architecture: "arm64", fetch,
        resolveRecipe: buildRecipe,
        probes: { [runtimeId]: async () => ({ version: "1.0.0" }) },
      });
      expect.soft((await rejectionOf(installer.prepare(recipeId)))?.message ?? "promise resolved instead of rejecting", `${label} fails closed before download`).toMatch(message);
      expect(fetch, `${label} never downloads`).not.toHaveBeenCalled();
    }

    const reuseRoot = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const { installer: reuseInstaller, fetch: reuseFetch } = exactClaudeInstaller(reuseRoot, "legacy-exact");
    try {
      const { recipe } = exactClaudeFixture("legacy-exact");
      const installation = "11111111-1111-4111-8111-111111111111";
      const base = join(reuseRoot, "claude", "macos-arm64");
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
      reuseFetch.mockClear();

      await expect(reuseInstaller.validate("claude-fixture@0.3.250"),
        "a frozen schema-v1 receipt matching the exact recipe is reused").resolves.toMatchObject({
        recipeId: "claude-fixture@0.3.250", version: "0.3.250",
      });
      expect(reuseFetch, "receipt reuse never touches the network").not.toHaveBeenCalled();
    } finally {
      await rm(reuseRoot, { recursive: true, force: true });
    }

    const repairRoot = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const { installer: repairInstaller, fetch: repairFetch } = exactClaudeInstaller(repairRoot, "legacy-repair");
    try {
      await repairInstaller.prepare("claude-fixture@0.3.250");
      const legacy = legacyReceipt(await activeReceipt(repairRoot));
      legacy.version = "0.3.249";
      await writeFile(join(repairRoot, "claude", "macos-arm64", "active.json"), `${JSON.stringify(legacy, null, 2)}\n`, { mode: 0o600 });
      repairFetch.mockClear();

      expect((await rejectionOf(repairInstaller.installed("claude-fixture@0.3.250")))?.message ?? "promise resolved instead of rejecting", "a nonmatching schema-v1 receipt is not served as installed").toMatch(/does not match requested recipe/i);
      await expect(repairInstaller.prepare("claude-fixture@0.3.250"),
        "prepare repairs the nonmatching receipt").resolves.toMatchObject({
        recipeId: "claude-fixture@0.3.250", version: "0.3.250",
      });
      expect(await activeReceipt(repairRoot), "the repaired receipt is schema v2").toMatchObject({ schemaVersion: 2 });
      expect(repairFetch, "repair re-downloads the exact artifact closure").toHaveBeenCalledTimes(2);
    } finally {
      await rm(repairRoot, { recursive: true, force: true });
    }

    const ownershipRoot = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const { installer: ownershipInstaller } = exactClaudeInstaller(ownershipRoot, "ownership-escape");
    try {
      await ownershipInstaller.prepare("claude-fixture@0.3.250");
      await writeFile(join(ownershipRoot, "claude", "macos-arm64", "active.json"), `${JSON.stringify({
        ...await activeReceipt(ownershipRoot),
        ownedPaths: ["../../user-owned"],
      }, null, 2)}\n`, { mode: 0o600 });

      expect((await rejectionOf(ownershipInstaller.installed("claude-fixture@0.3.250")))?.message ?? "promise resolved instead of rejecting", "an ownership receipt escaping the managed root is rejected").toMatch(/ownership receipt/i);
    } finally {
      await rm(ownershipRoot, { recursive: true, force: true });
    }

    const staleRoot = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const { installer: staleInstaller, fetch: staleFetch } = exactClaudeInstaller(staleRoot, "current-repair");
    try {
      await staleInstaller.prepare("claude-fixture@0.3.250");
      await writeFile(join(staleRoot, "claude", "macos-arm64", "active.json"), `${JSON.stringify({
        ...await activeReceipt(staleRoot), recipeDigest: "0".repeat(64),
      }, null, 2)}\n`, { mode: 0o600 });
      staleFetch.mockClear();

      await expect(staleInstaller.prepare("claude-fixture@0.3.250"),
        "a schema-v2 receipt with stale recipe identity is repaired").resolves.toMatchObject({
        recipeId: "claude-fixture@0.3.250",
      });
      expect(staleFetch, "stale-identity repair re-downloads the closure").toHaveBeenCalledTimes(2);
      expect(await activeReceipt(staleRoot), "the repaired receipt carries the exact digest").toMatchObject({
        recipeDigest: exactClaudeFixture("current-repair").recipe.recipeDigest,
      });
    } finally {
      await rm(staleRoot, { recursive: true, force: true });
    }

    const probeVersionRoot = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const probeVersionFixture = exactClaudeFixture("claude-runtime-version");
    const probeVersionInstaller = createManagedRuntimeInstaller({
      root: probeVersionRoot, platform: "darwin", architecture: "arm64",
      fetch: registryFixture(probeVersionFixture.routes), resolveRecipe: () => probeVersionFixture.recipe,
      probes: { claude: async () => ({ version: "2.1.250" }) },
      extract: claudeExtract(),
    });
    try {
      await probeVersionInstaller.prepare("claude-fixture@0.3.250");
      await expect(probeVersionInstaller.installed("claude-fixture@0.3.250"),
        "the exact SDK recipe is accepted with its separately versioned executable probe").resolves.toMatchObject({
        recipeId: "claude-fixture@0.3.250", version: "0.3.250",
      });
    } finally {
      await rm(probeVersionRoot, { recursive: true, force: true });
    }
  });

  it("prepares the reviewed artifact closure for every supported target and rejects the rest", { timeout: 30_000 }, async () => {
    const closureCases = [
      { label: "codex macos-arm64", platform: "darwin", architecture: "arm64", target: "macos-arm64", recipeId: "codex@0.147.0", nativeVersion: "0.147.0-darwin-arm64", nativeIntegrity: "sha512-BEUVkiOW7kLcRyrMLfAr/h9wF8sRVJyZDy6OHtVn6QGDXiv3BvAZVTY1Pu9xF7KdIdkYXbp4uayN0aDQQaAUJw==" },
      { label: "codex macos-x64", platform: "darwin", architecture: "x64", target: "macos-x64", recipeId: "codex@0.147.0", nativeVersion: "0.147.0-darwin-x64", nativeIntegrity: "sha512-Tb8McE5SvJIH0Vs5R6sq7u+quiC931yan2KOOl6km1OdZ82+Wi7eF5XrSFPs5CF7xCgoIK4Vs+byMbT5hN+ZUw==" },
      { label: "codex windows-x64", platform: "win32", architecture: "x64", target: "windows-x64", recipeId: "codex@0.147.0", nativeVersion: "0.147.0-win32-x64", nativeIntegrity: "sha512-oT7Ss5fAPf2fiWE9QNURqZcQGAAawSVxmIUdgPzckq4KFZAM+pRz9JbM4Rr498CjtbNgTOjWvDJ+DXvIBSfOPA==" },
      { label: "claude macos-arm64", platform: "darwin", architecture: "arm64", target: "macos-arm64", recipeId: "claude@0.3.250", nativePackage: "@anthropic-ai/claude-agent-sdk-darwin-arm64", nativeIntegrity: "sha512-tcekW4gR2UH0Q3COBaNPQIdud2lKEbs0HfG2yNKC18hXFPpgbuLCdjq0ndS1lcvC1q8ncPW3oQPUutQt3StICQ==" },
      { label: "claude macos-x64", platform: "darwin", architecture: "x64", target: "macos-x64", recipeId: "claude@0.3.250", nativePackage: "@anthropic-ai/claude-agent-sdk-darwin-x64", nativeIntegrity: "sha512-8Yxmmi76oVEIam+oRgxcL2RtqEkKX9Gp4rh500HmMltjX3Tk/ryjCoJEHoaUdU/LU6vWvfQU5W+dB/SJCQQb2A==" },
      { label: "claude windows-x64", platform: "win32", architecture: "x64", target: "windows-x64", recipeId: "claude@0.3.250", nativePackage: "@anthropic-ai/claude-agent-sdk-win32-x64", nativeIntegrity: "sha512-PjJRbJwDHccSUWls5gTiuXMgERit1WrrMQzzRqhhBHGzrlQueHVodrpg7HaN5gtirADJzfINcc7azq8j3qcEYw==" },
    ];
    expect(closureCases, "supported target inventory").toHaveLength(6);
    for (const candidate of closureCases) {
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
        await expect(installer.prepare(candidate.recipeId), candidate.label)
          .resolves.toMatchObject({ target: candidate.target });
        if (candidate.recipeId.startsWith("codex")) {
          expect(artifacts, `${candidate.label} downloads one pinned native artifact`).toEqual([expect.objectContaining({
            package: "@openai/codex", version: candidate.nativeVersion, integrity: candidate.nativeIntegrity,
          })]);
        } else {
          expect(artifacts, `${candidate.label} downloads the pinned sdk and native artifacts`).toEqual([
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

    for (const [label, platform, target, vendor, executable] of [
      ["the Codex Windows artifact resolves through the root package alias", "win32", "windows-x64", "x86_64-pc-windows-msvc", "codex.exe"],
      ["the Codex Linux development artifact resolves through the root package alias", "linux", "linux-x64", "x86_64-unknown-linux-musl", "codex"],
    ]) {
      const root = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
      const nativeBytes = Buffer.from(`codex ${platform} archive`);
      const tarball = `https://registry.npmjs.org/codex-${platform}.tgz`;
      const aliasVersion = platform === "win32" ? "0.150.1-win32-x64" : "0.150.1-linux-x64";
      const optionalPackage = platform === "win32" ? "@openai/codex-win32-x64" : "@openai/codex-linux-x64";
      const fetch = registryFixture(new Map([
        ["https://registry.npmjs.org/@openai%2fcodex/latest", {
          name: "@openai/codex", version: "0.150.1",
          optionalDependencies: { [optionalPackage]: `npm:@openai/codex@${aliasVersion}` },
          dist: { tarball: "https://registry.npmjs.org/unused-root.tgz", integrity: integrity(Buffer.from("unused")) },
        }],
        [`https://registry.npmjs.org/@openai%2fcodex/${aliasVersion}`, {
          name: "@openai/codex", version: aliasVersion,
          dist: { tarball, integrity: integrity(nativeBytes) },
        }],
        [tarball, nativeBytes],
      ]));

      try {
        const installer = createManagedRuntimeInstaller({
          root, platform, architecture: "x64", fetch,
          extract: async (_tarball, destination) => {
            const bin = join(destination, "vendor", vendor, "bin");
            await mkdir(bin, { recursive: true });
            await writeFile(join(bin, executable), "managed codex");
          },
          probes: { codex: async ({ version }) => ({ version }) },
        });
        const result = await installer.ensure("codex", "0.147.0");
        expect(result, label).toMatchObject({ runtimeId: "codex", version: "0.150.1", target });
        expect(result.executable, `${label} exposes the vendor executable`)
          .toMatch(new RegExp(`vendor[/\\\\]${vendor}[/\\\\]bin[/\\\\]${executable.replace(".", "\\.")}$`));
        expect(fetch.mock.calls.map(([url]) => String(url)), `${label} requests the aliased package`)
          .toContain(`https://registry.npmjs.org/@openai%2fcodex/${aliasVersion}`);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }

    for (const [platform, architecture] of [["linux", "arm64"], ["win32", "arm64"]]) {
      expect(() => createManagedRuntimeInstaller({ root: "/runtime", platform, architecture }),
        `${platform}-${architecture} is outside the supported host matrix`)
        .toThrow(`Unsupported managed runtime target: ${platform}-${architecture}`);
    }
  });

  it("walks the legacy latest-generation install, verify, repair, and probe lifecycle", { timeout: 30_000 }, async () => {
    const codexWrites = [];
    const codexVersionChild = probeChild();
    const codexServerChild = probeChild();
    codexServerChild.stdin = new PassThrough();
    codexServerChild.stdin.on("data", (chunk) => {
      const message = JSON.parse(String(chunk).trim());
      codexWrites.push(message);
      if (message.method === "initialize") {
        codexServerChild.stdout.write(`${JSON.stringify({ id: message.id, result: { userAgent: "Codex" } })}\n`);
      }
    });
    codexServerChild.stdin.on("finish", () => {
      codexServerChild.exitCode = 0;
      queueMicrotask(() => codexServerChild.emit("exit", 0, null));
    });
    const codexSpawn = vi.fn()
      .mockImplementationOnce(() => {
        queueMicrotask(() => {
          codexVersionChild.stdout.end("codex-cli 0.147.0\n");
          codexVersionChild.exitCode = 0;
          codexVersionChild.emit("exit", 0, null);
        });
        return codexVersionChild;
      })
      .mockImplementationOnce(() => codexServerChild);
    await expect(createDefaultRuntimeProbes({ spawnProcess: codexSpawn }).codex({ executable: "/runtime/codex" }),
      "the Codex probe completes the initialize handshake").resolves.toEqual({ version: "0.147.0" });
    expect(codexWrites, "the handshake sends initialize then initialized").toEqual([
      expect.objectContaining({ id: 1, method: "initialize" }),
      { method: "initialized", params: {} },
    ]);
    expect(codexServerChild.kill, "the server exits through stdin, never a kill").not.toHaveBeenCalled();
    expect(codexServerChild.exitCode, "the server exits cleanly").toBe(0);

    const spawnClaudeVersion = () => {
      const child = probeChild();
      queueMicrotask(() => {
        child.stdout.end("claude 0.3.250\n");
        child.exitCode = 0;
        child.emit("exit", 0, null);
      });
      return child;
    };
    const claudeModuleCases = [
      ["a complete module exports the query boundary", { query: () => {}, tool: () => {}, createSdkMcpServer: () => {} }, null],
      ["a module without query", {}, "does not export query"],
      ["a module without the tool browser boundary", { query: () => {}, createSdkMcpServer: () => {} }, "does not export query(), tool(), and createSdkMcpServer()"],
      ["a module without the createSdkMcpServer browser boundary", { query: () => {}, tool: () => {} }, "does not export query(), tool(), and createSdkMcpServer()"],
    ];
    for (const [label, loaded, message] of claudeModuleCases) {
      const importModule = vi.fn(async () => loaded);
      const probe = createDefaultRuntimeProbes({ spawnProcess: spawnClaudeVersion, importModule });
      if (message === null) {
        await expect(probe.claude({ executable: "/runtime/claude", modulePath: "/runtime/sdk.mjs" }), label)
          .resolves.toEqual({ version: "0.3.250" });
        expect(importModule, `${label} imports the managed SDK module`).toHaveBeenCalledWith("file:///runtime/sdk.mjs");
      } else {
        expect((await rejectionOf(probe.claude({ executable: "/runtime/claude", modulePath: "/runtime/sdk.mjs" })))?.message ?? "promise resolved instead of rejecting", label)
          .toMatch(message);
      }
    }

    const hungChild = probeChild();
    hungChild.kill = vi.fn(() => true);
    const hungProbe = createDefaultRuntimeProbes({
      spawnProcess: () => hungChild,
      importModule: async () => ({ query: () => {} }),
      timeoutMs: 5,
    });
    expect((await rejectionOf(hungProbe.claude({ executable: "/runtime/claude", modulePath: "/runtime/sdk.mjs" })))?.message ?? "promise resolved instead of rejecting", "a hung version probe is bounded").toMatch("version probe timed out");
    expect(hungChild.kill, "the hung probe child is terminated").toHaveBeenCalledWith("SIGTERM");

    const installRoot = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const installProbe = vi.fn(async ({ executable, version }) => {
      expect(await readFile(executable, "utf8"), "the probe sees the extracted executable").toBe("managed claude");
      expect(version, "the probe receives the requested version").toBe("0.3.250");
      return { version: "2.1.250" };
    });
    try {
      const installer = createManagedRuntimeInstaller({
        root: installRoot,
        platform: "darwin",
        architecture: "arm64",
        fetch: registryFixture(new Map([
          ["https://registry.npmjs.org/@anthropic-ai%2fclaude-agent-sdk/latest", {
            name: "@anthropic-ai/claude-agent-sdk",
            version: "0.3.250",
            optionalDependencies: { "@anthropic-ai/claude-agent-sdk-darwin-arm64": "0.3.250" },
            dist: { tarball: "https://registry.npmjs.org/sdk.tgz", integrity: integrity(Buffer.from("sdk archive")) },
          }],
          ["https://registry.npmjs.org/@anthropic-ai%2fclaude-agent-sdk-darwin-arm64/0.3.250", {
            name: "@anthropic-ai/claude-agent-sdk-darwin-arm64",
            version: "0.3.250",
            dist: { tarball: "https://registry.npmjs.org/claude-arm64.tgz", integrity: integrity(Buffer.from("native archive")) },
          }],
          ["https://registry.npmjs.org/sdk.tgz", Buffer.from("sdk archive")],
          ["https://registry.npmjs.org/claude-arm64.tgz", Buffer.from("native archive")],
        ])),
        probes: { claude: installProbe },
        extract: async (_tarball, destination, { artifact }) => {
          await mkdir(destination, { recursive: true });
          if (artifact.role === "sdk") await writeFile(join(destination, "sdk.mjs"), "export {};");
          else await writeFile(join(destination, "claude"), "managed claude", { mode: 0o755 });
        },
      });

      const installed = await installer.ensure("claude", "0.3.250");
      expect(installed, "the latest matching Claude SDK runtime installs").toMatchObject({ runtimeId: "claude", version: "0.3.250" });
      expect(installed.executable, "the executable lands in the installation's native path")
        .toMatch(/installations[/\\][^/\\]+[/\\]native[/\\]claude$/);
      expect(installed.modulePath, "the module lands in the installation's sdk path")
        .toMatch(/installations[/\\][^/\\]+[/\\]sdk[/\\]sdk\.mjs$/);
      expect(installProbe, "readiness is probed once").toHaveBeenCalledOnce();
      expect(installer.activeOperations(), "no operation remains after install").toEqual([]);
      const receipt = JSON.parse(await readFile(join(installRoot, "claude", "macos-arm64", "active.json"), "utf8"));
      expect(receipt, "the active receipt records request and probe versions").toMatchObject({
        schemaVersion: 1,
        runtimeId: "claude",
        version: "0.3.250",
        runtimeVersion: "2.1.250",
        target: "macos-arm64",
      });
      expect(receipt.artifacts, "the receipt pins both artifacts").toHaveLength(2);
      await expect(installer.installed("claude", "0.3.250"), "installed resolves the fresh generation")
        .resolves.toMatchObject({ version: "0.3.250" });
    } finally {
      await rm(installRoot, { recursive: true, force: true });
    }

    const coalesceRoot = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const coalesceProbe = vi.fn(async ({ version }) => ({ version }));
    const coalesceFetch = registryFixture(latestClaudeRoutes("0.3.247", "coalesced"));
    try {
      const installer = createManagedRuntimeInstaller({
        root: coalesceRoot, platform: "darwin", architecture: "arm64",
        fetch: coalesceFetch,
        extract: claudeExtract(),
        probes: { claude: coalesceProbe },
      });
      const [first, second] = await Promise.all([
        installer.ensure("claude", "0.3.200"),
        installer.ensure("claude", "0.3.240"),
      ]);
      expect(first, "concurrent requests for one runtime coalesce to one result").toBe(second);
      expect(coalesceFetch, "coalesced requests share one artifact closure download").toHaveBeenCalledTimes(4);
      expect(coalesceProbe, "coalesced requests probe once").toHaveBeenCalledOnce();
    } finally {
      await rm(coalesceRoot, { recursive: true, force: true });
    }

    const localRoot = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    try {
      const fixture = await createInstalledClaude(localRoot);
      fixture.fetch.mockClear();
      fixture.probe.mockClear();
      const installed = await fixture.installer.installed("claude", "0.3.200");
      expect(installed.executable, "installed reuses the recorded executable").toBe(fixture.result.executable);
      expect(fixture.fetch, "installed never touches the registry").not.toHaveBeenCalled();
      expect(fixture.probe, "installed probes the local runtime").toHaveBeenCalledOnce();

      const missingFetch = vi.fn(() => { throw new Error("network must not be used"); });
      const missing = createManagedRuntimeInstaller({
        root: await mkdtemp(join(tmpdir(), "relayer-managed-runtime-")),
        platform: "darwin", architecture: "arm64", fetch: missingFetch,
        probes: { claude: async ({ version }) => ({ version }) },
      });
      expect((await rejectionOf(missing.installed("claude", "0.3.200")))?.message ?? "promise resolved instead of rejecting", "a missing local runtime fails without the registry").toMatch("not installed");
      expect(missingFetch, "missing runtime checks never use the network").not.toHaveBeenCalled();

      fixture.fetch.mockClear();
      expect((await rejectionOf(fixture.installer.installed("claude", "0.4.0")))?.message ?? "promise resolved instead of rejecting", "a below-minimum local runtime fails without the registry").toMatch("below required 0.4.0");
      expect(fixture.fetch, "below-minimum checks never use the network").not.toHaveBeenCalled();

      fixture.fetch.mockClear();
      await rm(fixture.result.executable, { force: true });
      expect((await rejectionOf(fixture.installer.installed("claude", "0.3.200")))?.message ?? "promise resolved instead of rejecting", "a corrupt installation fails without the registry").toMatch(/executable is missing/i);
      expect(fixture.fetch, "corrupt-state checks never use the network").not.toHaveBeenCalled();

      const repaired = await fixture.installer.ensure("claude", "0.3.200");
      await expect(access(repaired.modulePath), "repair restores the missing SDK module").resolves.toBeUndefined();
      expect(repaired.receipt.installation, "repair installs a fresh generation")
        .not.toBe(fixture.result.receipt.installation);
    } finally {
      await rm(localRoot, { recursive: true, force: true });
    }

    const failoverRoot = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    let failoverLatest = "0.3.247";
    const failoverFetch = vi.fn(async (url) => {
      const value = String(url);
      const sdkBytes = Buffer.from(`sdk-${failoverLatest}`);
      const nativeBytes = Buffer.from(`native-${failoverLatest}`);
      if (value.endsWith("/sdk.tgz")) return new Response(sdkBytes);
      if (value.endsWith("/native.tgz")) return new Response(nativeBytes);
      if (value.endsWith("/@anthropic-ai%2fclaude-agent-sdk/latest")) return Response.json({
        name: "@anthropic-ai/claude-agent-sdk", version: failoverLatest,
        optionalDependencies: { "@anthropic-ai/claude-agent-sdk-darwin-arm64": failoverLatest },
        dist: { tarball: `${value}/sdk.tgz`, integrity: integrity(sdkBytes) },
      });
      if (value.includes(`/@anthropic-ai%2fclaude-agent-sdk-darwin-arm64/${failoverLatest}`)) return Response.json({
        name: "@anthropic-ai/claude-agent-sdk-darwin-arm64", version: failoverLatest,
        dist: { tarball: `${value}/native.tgz`, integrity: integrity(nativeBytes) },
      });
      return new Response("missing", { status: 404 });
    });
    const failoverProbe = vi.fn(async ({ version }) => {
      if (version === "0.3.248") throw new Error("replacement probe failed");
      return { version };
    });
    try {
      const installer = createManagedRuntimeInstaller({
        root: failoverRoot, platform: "darwin", architecture: "arm64", fetch: failoverFetch,
        extract: async (_tarball, destination, { artifact }) => {
          await mkdir(destination, { recursive: true });
          await writeFile(join(destination, artifact.role === "sdk" ? "sdk.mjs" : "claude"), artifact.version, { mode: 0o755 });
        },
        probes: { claude: failoverProbe },
      });
      const first = await installer.ensure("claude", "0.3.200");
      const activePath = join(failoverRoot, "claude", "macos-arm64", "active.json");
      const priorReceipt = await readFile(activePath, "utf8");
      failoverLatest = "0.3.248";

      expect((await rejectionOf(installer.ensure("claude", "0.3.200")))?.message ?? "promise resolved instead of rejecting", "a failing replacement probe surfaces").toMatch("replacement probe failed");
      expect(await readFile(activePath, "utf8"), "the old active receipt survives a failed replacement")
        .toBe(priorReceipt);
      expect(await readFile(first.executable, "utf8"), "the old executable remains active").toBe("0.3.247");
    } finally {
      await rm(failoverRoot, { recursive: true, force: true });
    }

    const floorRoot = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const floorProbe = vi.fn(async ({ version }) => ({ version }));
    try {
      const installer = createManagedRuntimeInstaller({
        root: floorRoot, platform: "darwin", architecture: "arm64",
        fetch: registryFixture(latestClaudeRoutes("0.3.248", "pre-browser-floor")),
        probes: { claude: floorProbe },
      });
      expect((await rejectionOf(installer.ensure("claude", "0.3.250")))?.message ?? "promise resolved instead of rejecting", "a vendor latest below the browser-proved floor fails before probing").toMatch("claude latest 0.3.248 is below required 0.3.250");
      expect(floorProbe, "the floor rejection never runs the readiness probe").not.toHaveBeenCalled();
    } finally {
      await rm(floorRoot, { recursive: true, force: true });
    }

    const archiveFixtureRoot = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-archive-"));
    const archiveRoot = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const sdkPackage = join(archiveFixtureRoot, "sdk", "package");
    const nativePackage = join(archiveFixtureRoot, "native", "package");
    const sdkTarballPath = join(archiveFixtureRoot, "sdk.tgz");
    const nativeTarballPath = join(archiveFixtureRoot, "native.tgz");
    await mkdir(sdkPackage, { recursive: true });
    await mkdir(nativePackage, { recursive: true });
    await writeFile(join(sdkPackage, "sdk.mjs"), "export {};");
    await symlink("sdk.mjs", join(sdkPackage, "linked-sdk.mjs"));
    await writeFile(join(nativePackage, "claude"), "managed claude", { mode: 0o755 });
    await createTar({ gzip: true, file: sdkTarballPath, cwd: join(archiveFixtureRoot, "sdk") }, ["package"]);
    await createTar({ gzip: true, file: nativeTarballPath, cwd: join(archiveFixtureRoot, "native") }, ["package"]);
    const archiveSdkBytes = await readFile(sdkTarballPath);
    const archiveNativeBytes = await readFile(nativeTarballPath);
    try {
      const installer = createManagedRuntimeInstaller({
        root: archiveRoot,
        platform: "darwin",
        architecture: "arm64",
        fetch: registryFixture(new Map([
          ["https://registry.npmjs.org/@anthropic-ai%2fclaude-agent-sdk/latest", {
            name: "@anthropic-ai/claude-agent-sdk",
            version: "0.3.247",
            optionalDependencies: { "@anthropic-ai/claude-agent-sdk-darwin-arm64": "0.3.247" },
            dist: { tarball: "https://registry.npmjs.org/unsafe-sdk.tgz", integrity: integrity(archiveSdkBytes) },
          }],
          ["https://registry.npmjs.org/@anthropic-ai%2fclaude-agent-sdk-darwin-arm64/0.3.247", {
            name: "@anthropic-ai/claude-agent-sdk-darwin-arm64", version: "0.3.247",
            dist: { tarball: "https://registry.npmjs.org/safe-native.tgz", integrity: integrity(archiveNativeBytes) },
          }],
          ["https://registry.npmjs.org/unsafe-sdk.tgz", archiveSdkBytes],
          ["https://registry.npmjs.org/safe-native.tgz", archiveNativeBytes],
        ])),
        probes: { claude: async ({ version }) => ({ version }) },
      });
      expect((await rejectionOf(installer.ensure("claude", "0.3.200")))?.message ?? "promise resolved instead of rejecting", "an artifact containing a symbolic link fails closed instead of filtering it").toMatch(/unsafe archive entry/i);
    } finally {
      await rm(archiveRoot, { recursive: true, force: true });
      await rm(archiveFixtureRoot, { recursive: true, force: true });
    }

    const integrityRoot = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const integrityExtract = vi.fn();
    try {
      const installer = createManagedRuntimeInstaller({
        root: integrityRoot, platform: "darwin", architecture: "arm64",
        fetch: registryFixture(new Map([
          ["https://registry.npmjs.org/@anthropic-ai%2fclaude-agent-sdk/latest", {
            name: "@anthropic-ai/claude-agent-sdk", version: "0.3.247",
            optionalDependencies: { "@anthropic-ai/claude-agent-sdk-darwin-arm64": "0.3.247" },
            dist: { tarball: "https://registry.npmjs.org/sdk-integrity.tgz", integrity: integrity(Buffer.from("sdk archive")) },
          }],
          ["https://registry.npmjs.org/@anthropic-ai%2fclaude-agent-sdk-darwin-arm64/0.3.247", {
            name: "@anthropic-ai/claude-agent-sdk-darwin-arm64", version: "0.3.247",
            dist: { tarball: "https://registry.npmjs.org/native-integrity.tgz", integrity: integrity(Buffer.from("expected native archive")) },
          }],
          ["https://registry.npmjs.org/sdk-integrity.tgz", Buffer.from("sdk archive")],
          ["https://registry.npmjs.org/native-integrity.tgz", Buffer.from("tampered native archive")],
        ])),
        extract: integrityExtract,
      });
      expect((await rejectionOf(installer.ensure("claude", "0.3.200")))?.message ?? "promise resolved instead of rejecting", "a SHA-512 mismatch fails closed").toMatch(/integrity verification failed/i);
      expect(await rejectionOf(access(join(integrityRoot, "claude", "macos-arm64", "active.json"))), "the mismatch never exposes an active runtime").toMatchObject({ code: "ENOENT" });
      expect(integrityExtract, "only the passing artifact is extracted").toHaveBeenCalledOnce();
      expect(installer.activeOperations(), "the failed install leaves no active operation").toEqual([]);
    } finally {
      await rm(integrityRoot, { recursive: true, force: true });
    }

    const cancelRoot = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const cancelSdkBytes = Buffer.from("sdk");
    const cancelFetch = vi.fn(async (url, options = {}) => {
      if (String(url).endsWith("/latest")) return Response.json({
        name: "@anthropic-ai/claude-agent-sdk", version: "0.3.247",
        optionalDependencies: { "@anthropic-ai/claude-agent-sdk-darwin-arm64": "0.3.247" },
        dist: { tarball: "https://registry.npmjs.org/hanging-sdk.tgz", integrity: integrity(cancelSdkBytes) },
      });
      if (String(url).includes("claude-agent-sdk-darwin-arm64/0.3.247")) return Response.json({
        name: "@anthropic-ai/claude-agent-sdk-darwin-arm64", version: "0.3.247",
        dist: { tarball: "https://registry.npmjs.org/native-unused.tgz", integrity: integrity(Buffer.from("native")) },
      });
      if (String(url) === "https://registry.npmjs.org/hanging-sdk.tgz") {
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
      const installer = createManagedRuntimeInstaller({ root: cancelRoot, platform: "darwin", architecture: "arm64", fetch: cancelFetch });
      const pending = installer.ensure("claude", "0.3.200");
      await vi.waitFor(() => expect(installer.activeOperations(), "the download registers as an active operation").toEqual(["claude"]));
      await installer.cancelAll();
      expect(await rejectionOf(pending), "cancelling aborts the active download").toMatchObject({ name: "AbortError" });
      expect(installer.activeOperations(), "no operation remains after cancellation").toEqual([]);
      expect(await rejectionOf(access(join(cancelRoot, "claude", "macos-arm64", "active.json"))), "a cancelled download leaves no active receipt").toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(cancelRoot, { recursive: true, force: true });
    }
  });

  it("stages and activates app updates without disturbing the active runtime", { timeout: 30_000 }, async () => {
    const exactUpdateRoot = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const { installer: exactUpdateInstaller } = exactClaudeInstaller(exactUpdateRoot, "exact-update");
    try {
      const staged = await exactUpdateInstaller.stageForAppUpdate("0.2.26", [{
        runtimeId: "claude", recipeId: "claude-fixture@0.3.250",
      }]);
      expect(staged, "the exact incoming recipe stages").toMatchObject({
        appVersion: "0.2.26",
        failures: [],
        staged: [{ recipeId: "claude-fixture@0.3.250" }],
      });
      expect(staged.staged[0], "staging keeps version metadata external").not.toHaveProperty("receipt");
      expect((await rejectionOf(exactUpdateInstaller.installed("claude-fixture@0.3.250")))?.message ?? "promise resolved instead of rejecting", "a staged recipe is not installed before activation").toMatch("not installed");

      await expect(exactUpdateInstaller.activatePendingAppUpdate("0.2.26"),
        "activation admits the staged recipe").resolves.toMatchObject({
        failures: [], activated: [{ recipeId: "claude-fixture@0.3.250" }],
      });
      await expect(exactUpdateInstaller.installed("claude-fixture@0.3.250"),
        "the activated recipe becomes installed").resolves.toMatchObject({ recipeId: "claude-fixture@0.3.250" });
    } finally {
      await rm(exactUpdateRoot, { recursive: true, force: true });
    }

    const staleRoot = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const { installer: stalePendingInstaller } = exactClaudeInstaller(staleRoot, "pending-authentication");
    try {
      await stalePendingInstaller.stageForAppUpdate("0.2.26", [{
        runtimeId: "claude", recipeId: "claude-fixture@0.3.250",
      }]);
      const pendingPath = join(staleRoot, ".pending-app-updates", "0.2.26", "claude-macos-arm64.json");
      const pending = JSON.parse(await readFile(pendingPath, "utf8"));
      await writeFile(pendingPath, `${JSON.stringify({ ...pending, recipeDigest: "0".repeat(64) }, null, 2)}\n`);

      await expect(stalePendingInstaller.activatePendingAppUpdate("0.2.26"),
        "a stale pending receipt fails closed before restart activation").resolves.toMatchObject({
        activated: [], failures: [{ runtimeId: "claude", error: expect.any(Error) }],
      });
      expect((await rejectionOf(stalePendingInstaller.installed("claude-fixture@0.3.250")))?.message ?? "promise resolved instead of rejecting", "the stale pending recipe never becomes installed").toMatch(/not installed/i);
    } finally {
      await rm(staleRoot, { recursive: true, force: true });
    }

    const stageRoot = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const stageFetch = registryFixture(latestClaudeRoutes("0.3.247", "pending"));
    const stageInstaller = createManagedRuntimeInstaller({
      root: stageRoot, platform: "darwin", architecture: "arm64",
      fetch: stageFetch,
      probes: { claude: async ({ version }) => ({ version }) },
      extract: claudeExtract(),
    });
    try {
      const staged = await stageInstaller.stageForAppUpdate("0.2.15", [
        { runtimeId: "claude", minimumVersion: "0.3.200" },
      ]);
      expect(staged.failures, "legacy staging reports no failures").toEqual([]);
      expect(staged.staged, "legacy staging resolves the latest matching runtime")
        .toEqual([expect.objectContaining({ runtimeId: "claude", version: "0.3.247", appVersion: "0.2.15" })]);
      expect(await rejectionOf(access(join(stageRoot, "claude", "macos-arm64", "active.json"))), "staging never changes the active runtime state").toMatchObject({ code: "ENOENT" });
      const pending = JSON.parse(await readFile(
        join(stageRoot, ".pending-app-updates", "0.2.15", "claude-macos-arm64.json"),
        "utf8",
      ));
      expect(pending, "the pending receipt carries app version and runtime").toMatchObject({
        appVersion: "0.2.15", runtimeId: "claude", version: "0.3.247",
      });

      stageFetch.mockClear();
      const wrongVersion = await stageInstaller.activatePendingAppUpdate("0.2.16");
      expect(wrongVersion, "a different app version activates nothing").toEqual({
        appVersion: "0.2.16", activated: [], failures: [],
      });
      const activated = await stageInstaller.activatePendingAppUpdate("0.2.15");
      expect(activated.failures, "the exact pending version activates").toEqual([]);
      expect(activated.activated, "activation reports the activated runtime")
        .toEqual([expect.objectContaining({ runtimeId: "claude", version: "0.3.247" })]);
      expect(await rejectionOf(access(join(stageRoot, ".pending-app-updates", "0.2.15", "claude-macos-arm64.json"))), "the pending receipt is consumed by activation").toMatchObject({ code: "ENOENT" });
      expect(stageFetch, "activation resolves locally without the network").not.toHaveBeenCalled();
      await expect(stageInstaller.installed("claude", "0.3.200"),
        "the activated runtime is installed locally").resolves.toMatchObject({ version: "0.3.247" });
      expect(stageFetch, "installed verification after activation stays local").not.toHaveBeenCalled();
    } finally {
      await rm(stageRoot, { recursive: true, force: true });
    }

    const unreadableRoot = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    try {
      const unreadable = Object.assign(new Error("unreadable pending update"), { code: "EACCES" });
      const installer = createManagedRuntimeInstaller({
        root: unreadableRoot,
        platform: "darwin",
        architecture: "arm64",
        readPendingUpdateDirectory: async () => { throw unreadable; },
      });
      await expect(installer.activatePendingAppUpdate("2.0.0"),
        "an unreadable pending-update directory is reported without blocking startup").resolves.toEqual({
        appVersion: "2.0.0",
        activated: [],
        failures: [{ runtimeId: null, error: unreadable }],
      });
    } finally {
      await rm(unreadableRoot, { recursive: true, force: true });
    }

    const retryRoot = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    let retryProbeCalls = 0;
    const retryInstaller = createManagedRuntimeInstaller({
      root: retryRoot,
      platform: "darwin",
      architecture: "arm64",
      fetch: registryFixture(latestClaudeRoutes("0.3.247", "retry-explicit")),
      probes: { claude: async ({ version }) => {
        retryProbeCalls += 1;
        if (retryProbeCalls === 2) throw new Error("transient activation failure");
        return { version };
      } },
      extract: claudeExtract(),
    });
    try {
      const staged = await retryInstaller.stageForAppUpdate("2.0.0", [
        { runtimeId: "claude", minimumVersion: "0.3.200" },
      ]);
      await expect(retryInstaller.activatePendingAppUpdate("2.0.0"),
        "a transient activation failure is reported").resolves.toMatchObject({
        failures: [expect.objectContaining({ runtimeId: "claude" })],
      });
      expect(retryProbeCalls, "the failed activation probed the staged runtime").toBe(2);
      expect(await rejectionOf(access(staged.staged[0].executable)), "the failed activation cleans the staged generation").toMatchObject({ code: "ENOENT" });
      await expect(retryInstaller.activatePendingAppUpdate("2.0.0"),
        "a failed activation never retries itself").resolves.toEqual({
        appVersion: "2.0.0",
        activated: [],
        failures: [],
      });
      expect(retryProbeCalls, "no automatic retry probes again").toBe(2);
      await expect(retryInstaller.ensure("claude", "0.3.200"),
        "recovery happens only through a fresh ensure").resolves.toMatchObject({
        runtimeId: "claude",
        version: "0.3.247",
      });
      expect(retryProbeCalls, "the explicit ensure probes the fresh generation").toBe(3);
    } finally {
      await rm(retryRoot, { recursive: true, force: true });
    }

    const downgradeRoot = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    try {
      const fixture = await createInstalledClaude(downgradeRoot);
      fixture.fetch.mockImplementation(registryFixture(latestClaudeRoutes("0.3.248", "active-newer")));
      const active = await fixture.installer.ensure("claude", "0.3.200");
      fixture.fetch.mockImplementation(registryFixture(latestClaudeRoutes("0.3.247", "pending-older")));
      const staged = await fixture.installer.stageForAppUpdate("2.0.0", [
        { runtimeId: "claude", minimumVersion: "0.3.200" },
      ]);

      const activation = await fixture.installer.activatePendingAppUpdate("2.0.0");
      expect(activation.activated, "an older pending runtime activates nothing").toEqual([]);
      expect(activation.failures, "the downgrade is refused with a stable reason").toEqual([
        expect.objectContaining({ runtimeId: "claude", error: expect.objectContaining({ message: expect.stringContaining("would downgrade") }) }),
      ]);
      await expect(fixture.installer.installed("claude", "0.3.200"),
        "the newer active generation survives the refused downgrade")
        .resolves.toMatchObject({ version: "0.3.248", receipt: { installation: active.receipt.installation } });
      expect(await rejectionOf(access(join(downgradeRoot, ".pending-app-updates", "2.0.0", "claude-macos-arm64.json"))), "the refused pending receipt is removed").toMatchObject({ code: "ENOENT" });
      expect(await rejectionOf(access(staged.staged[0].executable)), "the refused staged generation is cleaned").toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(downgradeRoot, { recursive: true, force: true });
    }

    const supersededRoot = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const supersededInstaller = createManagedRuntimeInstaller({
      root: supersededRoot, platform: "darwin", architecture: "arm64",
      fetch: registryFixture(latestClaudeRoutes("0.3.247", "superseded")),
      probes: { claude: async ({ version }) => ({ version }) },
      extract: claudeExtract(),
    });
    try {
      const first = await supersededInstaller.stageForAppUpdate("0.2.15", [{ runtimeId: "claude", minimumVersion: "0.3.200" }]);
      const supersededInstallation = first.staged[0].receipt.installation;
      await supersededInstaller.stageForAppUpdate("0.2.16", [{ runtimeId: "claude", minimumVersion: "0.3.200" }]);

      expect(await rejectionOf(access(join(supersededRoot, ".pending-app-updates", "0.2.15"))), "a newer update reclaims the superseded pending directory").toMatchObject({ code: "ENOENT" });
      expect(await rejectionOf(access(join(supersededRoot, "claude", "macos-arm64", "installations", supersededInstallation))), "a newer update reclaims the superseded installation").toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(supersededRoot, { recursive: true, force: true });
    }

    const stagingFailureRoot = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    try {
      const fixture = await createInstalledClaude(stagingFailureRoot);
      const previousInstallation = fixture.result.receipt.installation;
      fixture.fetch.mockImplementation(registryFixture(latestClaudeRoutes("0.3.248", "failed-update")));
      fixture.probe.mockImplementation(async ({ version }) => {
        if (version === "0.3.248") throw new Error("new runtime failed its probe");
        return { version };
      });

      const staged = await fixture.installer.stageForAppUpdate("0.2.15", [
        { runtimeId: "claude", minimumVersion: "0.3.200" },
      ]);
      expect(staged.staged, "a failing stage publishes nothing").toEqual([]);
      expect(staged.failures, "the staging failure names the runtime and reason").toEqual([
        expect.objectContaining({ runtimeId: "claude", error: expect.objectContaining({ message: "new runtime failed its probe" }) }),
      ]);
      await expect(fixture.installer.installed("claude", "0.3.200"),
        "the active runtime survives a failed stage")
        .resolves.toMatchObject({ version: "0.3.247", receipt: { installation: previousInstallation } });
      expect(await rejectionOf(access(join(stagingFailureRoot, ".pending-app-updates", "0.2.15", "claude-macos-arm64.json"))), "a failed stage leaves no pending receipt").toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(stagingFailureRoot, { recursive: true, force: true });
    }

    const successfulUpdateRoot = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    try {
      const fixture = await createInstalledClaude(successfulUpdateRoot);
      const previousInstallation = fixture.result.receipt.installation;
      const previousPath = join(successfulUpdateRoot, "claude", "macos-arm64", "installations", previousInstallation);
      fixture.fetch.mockImplementation(registryFixture(latestClaudeRoutes("0.3.248", "successful-update")));

      const staged = await fixture.installer.stageForAppUpdate("0.2.15", [
        { runtimeId: "claude", minimumVersion: "0.3.200" },
      ]);
      expect(staged.failures, "the update stages cleanly").toEqual([]);
      expect(staged.staged[0].receipt.installation, "staging installs a fresh generation")
        .not.toBe(previousInstallation);
      await expect(access(previousPath), "the old generation stays on disk until activation").resolves.toBeUndefined();

      fixture.fetch.mockClear();
      const activated = await fixture.installer.activatePendingAppUpdate("0.2.15");
      expect(activated.failures, "activation reports no failures").toEqual([]);
      expect(activated.activated, "activation activates the staged version")
        .toEqual([expect.objectContaining({ version: "0.3.248" })]);
      expect(fixture.fetch, "activation never touches the network").not.toHaveBeenCalled();
      expect(await rejectionOf(access(previousPath)), "activation removes the old active generation").toMatchObject({ code: "ENOENT" });
      await expect(fixture.installer.installed("claude", "0.3.200"),
        "the activated generation becomes installed").resolves.toMatchObject({ version: "0.3.248" });
    } finally {
      await rm(successfulUpdateRoot, { recursive: true, force: true });
    }

    const cachedExecutableRoot = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    try {
      const fixture = await createInstalledClaude(cachedExecutableRoot);
      const firstProvider = {
        execute: async () => readFile(fixture.result.executable, "utf8"),
      };
      fixture.fetch.mockImplementation(registryFixture(latestClaudeRoutes("0.3.248", "connect-upgrade")));

      const upgraded = await fixture.installer.ensure("claude", "0.3.200");
      expect(upgraded.version, "Connect upgrades to the new generation").toBe("0.3.248");
      expect(upgraded.receipt.installation, "the upgrade installs a fresh generation")
        .not.toBe(fixture.result.receipt.installation);
      await expect(firstProvider.execute(),
        "a cached provider adapter executable stays usable after the upgrade").resolves.toBe("runtime");
    } finally {
      await rm(cachedExecutableRoot, { recursive: true, force: true });
    }
  });

  it("coalesces and cancels concurrent preparation, staging, and activation", { timeout: 30_000 }, async () => {
    const inFlightRoot = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const started = deferred();
    const release = deferred();
    const { installer: inFlightInstaller } = exactClaudeInstaller(inFlightRoot, "concurrent-exact", {
      assembleRecipe: async () => {
        started.resolve();
        await release.promise;
      },
    });
    try {
      const preparing = inFlightInstaller.prepare("claude-fixture@0.3.250");
      await started.promise;
      const staging = inFlightInstaller.stageForAppUpdate("0.2.26", [{
        runtimeId: "claude", recipeId: "claude-fixture@0.3.250",
      }]);
      release.resolve();

      const [prepared, staged] = await Promise.all([preparing, staging]);
      expect(prepared, "the in-flight preparation completes").not.toHaveProperty("receipt");
      expect(staged, "staging succeeds alongside an in-flight preparation of the same recipe")
        .toMatchObject({ failures: [], staged: [{ recipeId: "claude-fixture@0.3.250" }] });
    } finally {
      await rm(inFlightRoot, { recursive: true, force: true });
    }

    const stagingFirstRoot = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const stagingFirstRegistry = registryFixture(latestClaudeRoutes("0.3.247", "coalesced"));
    const stagingFirstGate = deferred();
    let stagingFirstHeld = false;
    const stagingFirstFetch = vi.fn(async (url) => {
      if (!stagingFirstHeld) {
        stagingFirstHeld = true;
        await stagingFirstGate.promise;
      }
      return stagingFirstRegistry(url);
    });
    const stagingFirstInstaller = createManagedRuntimeInstaller({
      root: stagingFirstRoot, platform: "darwin", architecture: "arm64",
      fetch: stagingFirstFetch,
      probes: { claude: async ({ version }) => ({ version }) },
      extract: claudeExtract(),
    });
    try {
      const staging = stagingFirstInstaller.stageForAppUpdate("0.2.15", [
        { runtimeId: "claude", minimumVersion: "0.3.200" },
      ]);
      await vi.waitFor(() => expect(stagingFirstFetch, "staging starts downloading").toHaveBeenCalledOnce());
      const connecting = stagingFirstInstaller.ensure("claude", "0.3.200");
      stagingFirstGate.resolve();

      await expect(staging, "staging completes").resolves.toMatchObject({ failures: [] });
      await expect(connecting, "a Connect during staging coalesces into the same work")
        .resolves.toMatchObject({ runtimeId: "claude", version: "0.3.247" });
      expect(stagingFirstFetch, "both callers share one artifact closure download").toHaveBeenCalledTimes(4);
    } finally {
      await rm(stagingFirstRoot, { recursive: true, force: true });
    }

    const connectFirstRoot = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const connectFirstRegistry = registryFixture(latestClaudeRoutes("0.3.247", "connect-first"));
    const connectFirstGate = deferred();
    let connectFirstHeld = false;
    const connectFirstFetch = vi.fn(async (url) => {
      if (!connectFirstHeld) {
        connectFirstHeld = true;
        await connectFirstGate.promise;
      }
      return connectFirstRegistry(url);
    });
    const connectFirstInstaller = createManagedRuntimeInstaller({
      root: connectFirstRoot, platform: "darwin", architecture: "arm64",
      fetch: connectFirstFetch,
      probes: { claude: async ({ version }) => ({ version }) },
      extract: claudeExtract(),
    });
    try {
      const connecting = connectFirstInstaller.ensure("claude", "0.3.200");
      await vi.waitFor(() => expect(connectFirstFetch, "Connect starts downloading").toHaveBeenCalledOnce());
      const staging = connectFirstInstaller.stageForAppUpdate("0.2.15", [
        { runtimeId: "claude", minimumVersion: "0.3.200" },
      ]);
      connectFirstGate.resolve();

      await expect(connecting, "Connect completes").resolves.toMatchObject({ runtimeId: "claude" });
      await expect(staging, "staging after Connect coalesces into the same work")
        .resolves.toMatchObject({ failures: [] });
      expect(connectFirstFetch, "both callers share one artifact closure download").toHaveBeenCalledTimes(4);
    } finally {
      await rm(connectFirstRoot, { recursive: true, force: true });
    }

    const activationCancelRoot = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const activationCancelFetch = registryFixture(latestClaudeRoutes("0.3.247", "activation-cancel"));
    let activationCancelProbeCalls = 0;
    const activationCancelInstaller = createManagedRuntimeInstaller({
      root: activationCancelRoot, platform: "darwin", architecture: "arm64", fetch: activationCancelFetch,
      probes: { claude: async ({ version, signal }) => {
        activationCancelProbeCalls += 1;
        if (activationCancelProbeCalls === 1) return { version };
        await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
        return { version };
      } },
      extract: claudeExtract(),
    });
    try {
      const staged = await activationCancelInstaller.stageForAppUpdate("0.2.15", [{ runtimeId: "claude", minimumVersion: "0.3.200" }]);
      const activation = activationCancelInstaller.activatePendingAppUpdate("0.2.15");
      await vi.waitFor(() => expect(activationCancelInstaller.activeOperations(),
        "restart activation registers as an active operation").toContain("claude"));

      await activationCancelInstaller.cancelAll();
      await expect(activation, "cancelling reports the failed activation")
        .resolves.toMatchObject({ failures: [expect.objectContaining({ runtimeId: "claude" })] });
      expect(await rejectionOf(access(join(activationCancelRoot, "claude", "macos-arm64", "active.json"))), "cancellation happens before the active pointer changes").toMatchObject({ code: "ENOENT" });
      expect(await rejectionOf(access(join(activationCancelRoot, ".pending-app-updates", "0.2.15", "claude-macos-arm64.json"))), "the pending receipt is removed by the cancelled activation").toMatchObject({ code: "ENOENT" });
      expect(await rejectionOf(access(staged.staged[0].executable)), "the staged generation is cleaned by the cancelled activation").toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(activationCancelRoot, { recursive: true, force: true });
    }

    const retainedRoot = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    try {
      const fixture = await createInstalledClaude(retainedRoot);
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
      await vi.waitFor(() => expect(fixture.fetch, "staging starts downloading").toHaveBeenCalled());
      const connecting = fixture.installer.ensure("claude", "0.3.200");
      gate.resolve();

      await expect(staging, "staging completes").resolves.toMatchObject({ failures: [] });
      await expect(connecting, "Connect coalesces with the app-update activation")
        .resolves.toMatchObject({ version: "0.3.248" });
      await expect(access(priorExecutable), "the prior active generation is retained").resolves.toBeUndefined();
    } finally {
      await rm(retainedRoot, { recursive: true, force: true });
    }
  });

  it("prunes retired generations safely and preserves everything when state is ambiguous", { timeout: 30_000 }, async () => {
    const symlinkPruneRoot = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const symlinkPruneOutside = await mkdtemp(join(tmpdir(), "relayer-user-owned-"));
    const { installer: symlinkPruneInstaller } = exactClaudeInstaller(symlinkPruneRoot, "symlink-cleanup");
    try {
      await symlinkPruneInstaller.prepare("claude-fixture@0.3.250");
      const retired = join(symlinkPruneRoot, "claude", "macos-arm64", "installations", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
      await mkdir(retired, { recursive: true });
      await writeFile(join(retired, ".relayer-managed-runtime.json"), JSON.stringify({
        schemaVersion: 1,
        runtimeId: "claude",
        target: "macos-arm64",
        installation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        ownedPath: "claude/macos-arm64/installations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }));
      await writeFile(join(symlinkPruneOutside, "sentinel"), "user owned");
      await symlink(symlinkPruneOutside, join(retired, "external"));

      await expect(symlinkPruneInstaller.pruneInactiveInstallations(),
        "pruning removes the retired managed generation").resolves.toMatchObject({
        failures: [], removed: [{ runtimeId: "claude", installation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }],
      });
      await expect(access(join(symlinkPruneOutside, "sentinel")),
        "pruning never follows a symlink into user-owned state").resolves.toBeUndefined();
    } finally {
      await rm(symlinkPruneRoot, { recursive: true, force: true });
      await rm(symlinkPruneOutside, { recursive: true, force: true });
    }

    const generationsRoot = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    try {
      const fixture = await createInstalledClaude(generationsRoot);
      fixture.fetch.mockImplementation(registryFixture(latestClaudeRoutes("0.3.248", "connect-prune")));
      const active = await fixture.installer.ensure("claude", "0.3.200");
      fixture.fetch.mockImplementation(registryFixture(latestClaudeRoutes("0.3.249", "pending-prune")));
      const pending = await fixture.installer.stageForAppUpdate("2.0.0", [
        { runtimeId: "claude", minimumVersion: "0.3.200" },
      ]);

      const removed = await fixture.installer.pruneInactiveInstallations();
      expect(removed, "restart pruning removes only the retired Connect generation").toEqual({
        removed: [{ runtimeId: "claude", installation: fixture.result.receipt.installation }],
        failures: [],
      });
      expect(await rejectionOf(access(fixture.result.executable)), "the retired generation is gone").toMatchObject({ code: "ENOENT" });
      await expect(access(active.executable), "the active generation survives").resolves.toBeUndefined();
      await expect(access(pending.staged[0].executable), "the pending generation survives").resolves.toBeUndefined();
    } finally {
      await rm(generationsRoot, { recursive: true, force: true });
    }

    const unknownRoot = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const unknownInstallation = "99999999-9999-4999-8999-999999999999";
    try {
      const fixture = await createInstalledClaude(unknownRoot);
      const unknownPath = join(unknownRoot, "claude", "macos-arm64", "installations", unknownInstallation);
      await mkdir(unknownPath, { recursive: true });
      await writeFile(join(unknownPath, "user-note"), "not owned by Relayer");

      await expect(fixture.installer.pruneInactiveInstallations(),
        "an unretained directory without an ownership receipt is preserved").resolves.toEqual({ removed: [], failures: [] });
      await expect(readFile(join(unknownPath, "user-note"), "utf8"),
        "user-owned content inside an unknown directory survives").resolves.toBe("not owned by Relayer");
    } finally {
      await rm(unknownRoot, { recursive: true, force: true });
    }

    const stagingDirsRoot = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const abandoned = [
      "claude-11111111-1111-4111-8111-111111111111",
      "codex-update-22222222-2222-4222-8222-222222222222",
    ];
    const retained = ["notes", "claude-not-a-uuid", "other-33333333-3333-4333-8333-333333333333"];
    const removeDirectory = vi.fn((path, options) => rm(path, options));
    try {
      await Promise.all([...abandoned, ...retained].map((name) => (
        mkdir(join(stagingDirsRoot, ".staging", name), { recursive: true })
      )));
      const installer = createManagedRuntimeInstaller({
        root: stagingDirsRoot,
        platform: "darwin",
        architecture: "arm64",
        removeDirectory,
      });

      const pruning = await installer.pruneInactiveInstallations();
      expect(pruning.removed, "only abandoned UUID staging directories are removed").toEqual([
        { runtimeId: "claude", staging: abandoned[0] },
        { runtimeId: "codex", staging: abandoned[1] },
      ]);
      for (const name of abandoned) {
        expect(await rejectionOf(access(join(stagingDirsRoot, ".staging", name))), `${name} is removed`).toMatchObject({ code: "ENOENT" });
      }
      for (const name of retained) {
        await expect(access(join(stagingDirsRoot, ".staging", name)), `${name} is retained`)
          .resolves.toBeUndefined();
      }
      expect(removeDirectory, "each removal uses the Windows-safe retry options").toHaveBeenCalledTimes(2);
      for (const [, options] of removeDirectory.mock.calls) {
        expect(options, "removal retries are bounded and recursive").toMatchObject({
          recursive: true, force: true, maxRetries: 3, retryDelay: 100,
        });
      }
    } finally {
      await rm(stagingDirsRoot, { recursive: true, force: true });
    }

    const lockedRoot = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const lockedActiveInstallation = "11111111-1111-4111-8111-111111111111";
    const lockedInstallation = "22222222-2222-4222-8222-222222222222";
    try {
      const base = join(lockedRoot, "claude", "macos-arm64");
      await mkdir(join(base, "installations", lockedActiveInstallation), { recursive: true });
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
        installation: lockedActiveInstallation,
      }));
      const locked = Object.assign(new Error("locked"), { code: "EBUSY" });
      const installer = createManagedRuntimeInstaller({
        root: lockedRoot,
        platform: "darwin",
        architecture: "arm64",
        removeInactiveInstallation: async (path) => {
          if (path.endsWith(lockedInstallation)) throw locked;
          await rm(path, { recursive: true, force: true });
        },
      });

      const pruning = await installer.pruneInactiveInstallations();
      expect(pruning.removed, "a locked generation removes nothing").toEqual([]);
      expect(pruning.failures, "the locked generation is reported without failing startup")
        .toEqual([{ runtimeId: "claude", installation: lockedInstallation, error: locked }]);
      await expect(access(join(base, "installations", lockedInstallation)),
        "the locked directory stays on disk").resolves.toBeUndefined();
    } finally {
      await rm(lockedRoot, { recursive: true, force: true });
    }

    const corruptReceiptRoot = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const corruptInstallation = "33333333-3333-4333-8333-333333333333";
    try {
      const base = join(corruptReceiptRoot, "claude", "macos-arm64");
      await mkdir(join(base, "installations", corruptInstallation), { recursive: true });
      await writeFile(join(base, "active.json"), "{not-json");
      const installer = createManagedRuntimeInstaller({ root: corruptReceiptRoot, platform: "darwin", architecture: "arm64" });

      const pruning = await installer.pruneInactiveInstallations();
      expect(pruning.removed, "a corrupt active receipt preserves every generation").toEqual([]);
      expect(pruning.failures, "the corrupt receipt is reported").toHaveLength(1);
      expect(pruning.failures[0], "the failure names the runtime").toMatchObject({ runtimeId: "claude", installation: null });
      await expect(access(join(base, "installations", corruptInstallation)),
        "the generation survives the corrupt receipt").resolves.toBeUndefined();
    } finally {
      await rm(corruptReceiptRoot, { recursive: true, force: true });
    }

    const unreadablePendingRoot = await mkdtemp(join(tmpdir(), "relayer-managed-runtime-"));
    const retainedInstallation = "44444444-4444-4444-8444-444444444444";
    try {
      const base = join(unreadablePendingRoot, "claude", "macos-arm64");
      await mkdir(join(base, "installations", retainedInstallation), { recursive: true });
      const unreadable = Object.assign(new Error("unreadable"), { code: "EACCES" });
      const installer = createManagedRuntimeInstaller({
        root: unreadablePendingRoot,
        platform: "darwin",
        architecture: "arm64",
        readPruneDirectory: async (path) => {
          if (path === join(unreadablePendingRoot, ".pending-app-updates")) throw unreadable;
          return [];
        },
      });

      const pruning = await installer.pruneInactiveInstallations();
      expect(pruning.removed, "unreadable pending-update retention preserves every generation").toEqual([]);
      expect(pruning.failures, "the unreadable enumeration is reported")
        .toEqual([{ runtimeId: null, installation: null, error: unreadable }]);
      await expect(access(join(base, "installations", retainedInstallation)),
        "the generation survives the unreadable enumeration").resolves.toBeUndefined();
    } finally {
      await rm(unreadablePendingRoot, { recursive: true, force: true });
    }
  });
});
