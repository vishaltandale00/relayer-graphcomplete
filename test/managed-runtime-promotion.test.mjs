import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createManagedRuntimeInstaller } from "../desktop/main/managed-runtimes/installer.mjs";
import { createDefaultRuntimeProbes } from "../desktop/main/managed-runtimes/probes.mjs";

function codexFixture(root, options = {}) {
  const bytes = Buffer.from("reviewed native artifact");
  const identity = {
    schemaVersion: 1, recipeId: "codex-fixture@0.159.3", runtimeId: "codex", version: "0.159.3",
    target: "windows-x64", assembler: "npm-archives-v1", readinessContractVersion: 1,
    executableRelativePath: "native/codex.exe",
    artifacts: [{ role: "native", package: "@fixture/codex", version: "0.159.3", kind: "archive",
      tarball: "https://registry.npmjs.org/codex-fixture.tgz",
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` }],
  };
  const recipe = { ...identity, recipeDigest: createHash("sha256").update(JSON.stringify(identity)).digest("hex") };
  const installer = createManagedRuntimeInstaller({
    root, platform: "win32", architecture: "x64", resolveRecipe: () => recipe,
    fetch: async () => new Response(bytes),
    extract: async (_archive, destination) => {
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, "codex.exe"), bytes);
    },
    probes: { codex: async () => ({ version: recipe.version }) },
    ...options,
  });
  return { installer, recipe };
}

function promotionError(code, source, destination) {
  return Object.assign(new Error(`${code}: operation not permitted, rename '${source}' -> '${destination}'`),
    { code, syscall: "rename", path: source, dest: destination });
}

const modes = ["prepare", "update"];
async function promote(installer, recipe, mode) {
  if (mode === "prepare") return installer.prepare(recipe.recipeId);
  const result = await installer.stageForAppUpdate("0.2.99", [{ runtimeId: "codex", recipeId: recipe.recipeId }]);
  if (result.failures.length) throw result.failures[0].error;
  return result;
}

describe("Windows managed runtime promotion", () => {
  it.each(modes.flatMap((mode) => ["EPERM", "EACCES", "EBUSY"].map((code) => [mode, code])))("recovers a transient %s promotion denial (%s)", async (mode, code) => {
    const root = await mkdtemp(join(tmpdir(), "relayer-codex-promotion-"));
    const renameInstallation = vi.fn(async (source, destination) => {
      if (renameInstallation.mock.calls.length === 1) throw promotionError(code, source, destination);
      await rename(source, destination);
    });
    try {
      const { installer, recipe } = codexFixture(root, { renameInstallation });
      await promote(installer, recipe, mode);
      if (mode === "update") {
        const activated = await installer.activatePendingAppUpdate("0.2.99");
        expect(activated.failures).toEqual([]);
      }
      const runtime = await installer.validate(recipe.recipeId);
      expect(await readFile(runtime.executable)).toEqual(Buffer.from("reviewed native artifact"));
      expect(renameInstallation).toHaveBeenCalledTimes(2);
      expect(renameInstallation.mock.calls[1]).toEqual(renameInstallation.mock.calls[0]);
      expect(await readdir(join(root, ".staging"))).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(modes)("preserves prior receipts and user data when %s promotion stays denied", async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "relayer-codex-denied-"));
    try {
      const original = codexFixture(root);
      const active = await original.installer.prepare(original.recipe.recipeId);
      await writeFile(join(active.privateStateRoot, "session.json"), "saved session");
      if (mode === "update") await promote(original.installer, original.recipe, mode);
      const activePath = join(root, "codex", "windows-x64", "active.json");
      const pendingPath = join(root, ".pending-app-updates", "0.2.99", "codex-windows-x64.json");
      const activeBefore = await readFile(activePath, "utf8");
      const pendingBefore = mode === "update" ? await readFile(pendingPath, "utf8") : null;
      const error = promotionError("EPERM", "staging", "installation");
      const renameInstallation = vi.fn(async () => { throw error; });
      const replacement = codexFixture(root, { renameInstallation, probes: {
        codex: async ({ executable }) => {
          if (!executable.includes(".staging")) throw new Error("existing readiness failed");
          return { version: original.recipe.version };
        },
      } });
      await expect(promote(replacement.installer, replacement.recipe, mode)).rejects.toBe(error);
      expect(renameInstallation).toHaveBeenCalledTimes(7);
      expect(await readFile(activePath, "utf8")).toBe(activeBefore);
      if (mode === "update") expect(await readFile(pendingPath, "utf8")).toBe(pendingBefore);
      expect(await readFile(join(active.privateStateRoot, "session.json"), "utf8")).toBe("saved session");
      expect(await readdir(join(root, "codex", "windows-x64", "installations"))).toEqual([active.installation]);
      expect(await readdir(join(root, ".staging"))).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(modes)("drains cancellation during %s backoff without activating", async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "relayer-codex-cancel-"));
    let firstAttempt;
    const attempted = new Promise((resolve) => { firstAttempt = resolve; });
    const renameInstallation = vi.fn(async (source, destination) => {
      firstAttempt();
      throw promotionError("EPERM", source, destination);
    });
    try {
      const { installer, recipe } = codexFixture(root, { renameInstallation });
      const cancelled = new DOMException("test cancellation", "AbortError");
      const outcome = promote(installer, recipe, mode).catch((error) => error);
      await attempted;
      // Allow the rename rejection to enter the abortable delay.
      await new Promise((resolve) => setTimeout(resolve, 5));
      await installer.cancelAll(cancelled);
      expect(await outcome).toBe(cancelled);
      expect(renameInstallation).toHaveBeenCalledOnce();
      expect(await readdir(join(root, "codex", "windows-x64", "installations"))).toEqual([]);
      expect(await readdir(join(root, ".staging"))).toEqual([]);
      await expect(installer.validate(recipe.recipeId)).rejects.toMatchObject({ code: "managed_runtime_not_installed" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(modes)("rolls back %s when cancellation arrives during a successful rename", async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "relayer-codex-rename-cancel-"));
    let cancellation;
    let installer;
    const cancelled = new DOMException("cancel after rename", "AbortError");
    const renameInstallation = vi.fn(async (source, destination) => {
      await rename(source, destination);
      cancellation = installer.cancelAll(cancelled);
    });
    try {
      const fixture = codexFixture(root, { renameInstallation });
      installer = fixture.installer;
      await expect(promote(installer, fixture.recipe, mode)).rejects.toBe(cancelled);
      await cancellation;
      expect(await readdir(join(root, "codex", "windows-x64", "installations"))).toEqual([]);
      expect(await readdir(join(root, "codex", "windows-x64", "private-state"))).toEqual([]);
      expect(await readdir(join(root, ".staging"))).toEqual([]);
      await expect(installer.validate(fixture.recipe.recipeId)).rejects.toMatchObject({ code: "managed_runtime_not_installed" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([
    ["win32", "ENOSPC"], ["win32", "EXDEV"], ["win32", "EEXIST"], ["darwin", "EPERM"],
  ])("does not retry %s %s or widen rename into copying", async (platform, code) => {
    const root = await mkdtemp(join(tmpdir(), "relayer-codex-no-retry-"));
    const error = promotionError(code, "staging", "installation");
    const renameInstallation = vi.fn(async () => { throw error; });
    try {
      const fixture = codexFixture(root);
      const { recipeDigest: _oldDigest, ...identity } = fixture.recipe;
      identity.target = platform === "darwin" ? "macos-arm64" : "windows-x64";
      const recipe = { ...identity, recipeDigest: createHash("sha256").update(JSON.stringify(identity)).digest("hex") };
      const { installer } = codexFixture(root, {
        platform, architecture: platform === "darwin" ? "arm64" : "x64",
        resolveRecipe: () => recipe, renameInstallation,
      });
      await expect(installer.prepare(recipe.recipeId)).rejects.toBe(error);
      expect(renameInstallation).toHaveBeenCalledOnce();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

function probeChild() {
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null, signalCode: null, kill: vi.fn() });
  return child;
}

it("keeps Codex preparation from promoting until the probe closes after exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "relayer-codex-close-"));
  const versionChild = probeChild();
  const serverChild = probeChild();
  let releaseClose;
  let closed = false;
  const exited = new Promise((resolve) => {
    serverChild.stdin.on("finish", () => {
      serverChild.exitCode = 0;
      serverChild.emit("exit", 0, null);
      releaseClose = () => { closed = true; serverChild.emit("close", 0, null); };
      resolve();
    });
  });
  serverChild.stdin.on("data", (chunk) => {
    const message = JSON.parse(String(chunk));
    if (message.method === "initialize") serverChild.stdout.write('{"id":1,"result":{}}\n');
  });
  const spawnProcess = vi.fn().mockImplementationOnce(() => {
    queueMicrotask(() => {
      versionChild.stdout.end("codex-cli 0.159.3\n");
      versionChild.exitCode = 0;
      versionChild.emit("exit", 0, null);
      versionChild.emit("close", 0, null);
    });
    return versionChild;
  }).mockImplementationOnce(() => serverChild);
  const renameInstallation = vi.fn(async (source, destination) => {
    // Model a Windows handle retained until the owned child closes.
    if (!closed) throw promotionError("EPERM", source, destination);
    await rename(source, destination);
  });
  try {
    const { installer, recipe } = codexFixture(root, {
      probes: createDefaultRuntimeProbes({ spawnProcess }), renameInstallation,
    });
    const pending = installer.prepare(recipe.recipeId);
    const outcome = pending.then((value) => ({ value }), (error) => ({ error }));
    await exited;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(renameInstallation).not.toHaveBeenCalled();
    releaseClose();
    expect((await outcome).error).toBeUndefined();
    expect(renameInstallation).toHaveBeenCalledOnce();
  } finally {
    releaseClose?.();
    await rm(root, { recursive: true, force: true });
  }
});


it("waits for version output through close before validating the shared Claude probe", async () => {
  const child = probeChild();
  const probe = createDefaultRuntimeProbes({
    spawnProcess: () => {
      queueMicrotask(() => {
        child.exitCode = 0;
        child.emit("exit", 0, null);
        setTimeout(() => {
          child.stdout.end("claude 2.1.286\n");
          child.emit("close", 0, null);
        }, 5);
      });
      return child;
    },
    importModule: async () => ({ query() {}, tool() {}, createSdkMcpServer() {} }),
  });
  await expect(probe.claude({ executable: "/runtime/claude", modulePath: "/runtime/sdk.mjs" }))
    .resolves.toEqual({ version: "2.1.286" });
  expect(child.kill).not.toHaveBeenCalled();
});

it.each(["forced-close", "never-close", "cancelled"])("requires owned Codex shutdown before promotion: %s", async (behavior) => {
  const root = await mkdtemp(join(tmpdir(), "relayer-codex-shutdown-"));
  const versionChild = probeChild();
  const serverChild = probeChild();
  const controller = new AbortController();
  const cancelled = new DOMException("probe cancelled", "AbortError");
  const renameInstallation = vi.fn(rename);
  const spawnProcess = vi.fn().mockImplementationOnce(() => {
    queueMicrotask(() => {
      versionChild.stdout.end("codex-cli 0.159.3\n");
      versionChild.emit("exit", 0, null);
      versionChild.emit("close", 0, null);
    });
    return versionChild;
  }).mockImplementationOnce(() => serverChild);
  serverChild.stdin.on("data", (chunk) => {
    if (JSON.parse(String(chunk)).method === "initialize") serverChild.stdout.write('{"id":1,"result":{}}\n');
  });
  serverChild.stdin.on("finish", () => {
    if (behavior === "cancelled") controller.abort(cancelled);
  });
  serverChild.kill.mockImplementation((signal) => {
    if (signal === "SIGKILL" && behavior !== "never-close") {
      queueMicrotask(() => serverChild.emit("close", null, signal));
    }
    return true;
  });
  try {
    const defaultProbe = createDefaultRuntimeProbes({ spawnProcess, shutdownTimeoutMs: 5 });
    const { installer, recipe } = codexFixture(root, {
      renameInstallation,
      probes: { codex: (runtime) => defaultProbe.codex({ ...runtime, signal: controller.signal }) },
    });
    if (behavior === "forced-close") {
      await installer.prepare(recipe.recipeId);
      expect(renameInstallation).toHaveBeenCalledOnce();
    } else {
      const result = await installer.prepare(recipe.recipeId).catch((error) => error);
      if (behavior === "cancelled") expect(result).toBe(cancelled);
      else expect(result.message).toContain("probe did not close in time");
      expect(renameInstallation).not.toHaveBeenCalled();
    }
    expect(serverChild.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    expect(serverChild.listenerCount("exit")).toBe(0);
    expect(await readdir(join(root, ".staging"))).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
