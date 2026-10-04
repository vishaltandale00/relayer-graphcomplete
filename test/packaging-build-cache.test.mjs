import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cachedBuild, inventory, packagingIdentity, timedStage } from "../desktop/packaging/build-cache.mjs";
import { packagingRuntimeReady } from "../scripts/ci/packaging-cache-ready.mjs";
import { buildDevelopmentDesktop } from "../desktop/packaging/build-development.mjs";

const directories = [];
async function temporary() { const path = await mkdtemp(join(tmpdir(), "packaging-cache-test-")); directories.push(path); return path; }
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

test("seals a fresh build, reuses verified bytes, and rebuilds corrupted or incomplete entries", async () => {
  const cacheRoot = await temporary();
  const build = vi.fn(async (path) => writeFile(join(path, "binary"), "fresh"));
  const fallback = vi.fn();
  const options = { cacheRoot, kind: "runtime", identity: "a".repeat(64), build, fallback, report: () => {} };
  const path = await cachedBuild(options);
  await cachedBuild(options);
  expect(build).toHaveBeenCalledTimes(1);
  await writeFile(join(path, "binary"), "tampered");
  await cachedBuild(options);
  expect(await readFile(join(path, "binary"), "utf8")).toBe("fresh");
  await writeFile(join(path, "unlisted"), "unexpected");
  await cachedBuild(options);
  await rm(join(path, "binary"));
  await cachedBuild(options);
  expect(build).toHaveBeenCalledTimes(4);
  expect(fallback).not.toHaveBeenCalled();
});

test("a busy cache falls back; a fresh compiler failure is neither retried nor sealed", async () => {
  const cacheRoot = await temporary();
  await mkdir(join(cacheRoot, "runtime"));
  await writeFile(join(cacheRoot, "runtime", "identity.lock"), "busy");
  const fallback = vi.fn(async () => "fresh fallback");
  expect(await cachedBuild({ cacheRoot, kind: "runtime", identity: "identity", build: () => { throw Error("must not run"); }, fallback })).toBe("fresh fallback");
  const failure = Error("compiler failed");
  const build = vi.fn(async () => { throw failure; });
  await expect(cachedBuild({ cacheRoot, kind: "runtime", identity: "another", build, fallback })).rejects.toBe(failure);
  expect(build).toHaveBeenCalledTimes(1);
  await expect(readFile(join(cacheRoot, "runtime", "another", "manifest.json"))).rejects.toThrow();
});

test("rejects linked inputs and makes telemetry failure non-gating", async () => {
  const root = await temporary();
  await symlink("/etc/hosts", join(root, "escape"));
  await expect(inventory(root)).rejects.toThrow("symlink");
  expect(await timedStage("fixture", async () => 42, { GITHUB_STEP_SUMMARY: join(root, "absent", "summary") })).toBe(42);
  const failure = Error("actual failure");
  await expect(timedStage("fixture", async () => { throw failure; }, {})).rejects.toBe(failure);
});

test("identity binds native/toolchain and all local Rust bytes but permits renderer-only reuse", async () => {
  const root = await temporary();
  for (const path of ["vendor/ladybug", "scripts/ci", "desktop/packaging", "desktop/shared", "crates/core", ".cargo", "docs", "fixtures/graph-query-v1", "desktop/renderer"]) await mkdir(join(root, path), { recursive: true });
  for (const path of ["scripts/prepare-ladybug-source.mjs", "scripts/verify-ladybug-native-receipts.mjs", "desktop/shared/target.mjs", "Cargo.toml", "Cargo.lock", "docs/graph-query-v1.md", "crates/core/lib.rs"]) await writeFile(join(root, path), path);
  await writeFile(join(root, "scripts/ci/packaging-input-contract.json"), JSON.stringify({ version: 1, reviewedBuildConfiguration: {} }));
  const options = { repositoryRoot: root, cacheRoot: join(root, "cache"), target: { rustTarget: "aarch64-apple-darwin" }, environment: { HOME: root }, command: (name, args) => args[0] === "metadata" ? JSON.stringify({ packages: [] }) : name };
  const initial = await packagingIdentity(options);
  const barePath = "/usr/bin:/opt/homebrew/bin";
  expect(await packagingIdentity({ ...options, environment: { ...options.environment, PATH: `/repo/node_modules/.bin:/npm/node-gyp-bin:/usr/bin:${barePath}` } })).toEqual(await packagingIdentity({ ...options, environment: { ...options.environment, PATH: barePath } }));
  await expect(packagingIdentity({ ...options, environment: { C_INCLUDE_PATH: "/external" } })).rejects.toThrow("custom build inputs");
  await expect(packagingIdentity({ ...options, command: (name, args) => args[0] === "metadata" ? JSON.stringify({ packages: [{ manifest_path: join(root, "crates/core/Cargo.toml"), targets: [{ kind: ["custom-build"], src_path: join(root, "crates/core/custom.rs") }] }] }) : name })).rejects.toThrow("custom build script");
  await writeFile(join(root, "desktop/renderer/style.css"), "new style");
  expect(await packagingIdentity(options)).toEqual(initial);
  await writeFile(join(root, "crates/core/local-untracked.rs"), "new input");
  const rustChanged = await packagingIdentity(options);
  expect(rustChanged.native).toBe(initial.native);
  expect(rustChanged.runtime).not.toBe(initial.runtime);
  expect((await packagingIdentity({ ...options, command: (name, args) => args[0] === "metadata" ? JSON.stringify({ packages: [] }) : `${name}-updated` })).native).not.toBe(initial.native);
  await writeFile(join(root, "vendor/ladybug/pin.json"), "new native input");
  expect((await packagingIdentity(options)).native).not.toBe(initial.native);
  await expect(packagingIdentity({ ...options, environment: { CARGO_TARGET_DIR: root } })).rejects.toThrow("custom build inputs");
});

test("a release hit still licenses, assembles and inspects the current app; corruption rebuilds", async () => {
  const repositoryRoot = await temporary();
  const license = vi.fn(async () => {});
  const prepare = vi.fn(async () => ({ environment: { OPENSSL_DIR: "/fixture/ssl", LBUG_SOURCE_DIR: "/fixture/lbug", OPENSSL_STATIC: "1", LBUG_BUILD_FROM_SOURCE: "1", CARGO_NET_OFFLINE: "true" } }));
  const commands = [];
  const execute = vi.fn(async (command) => {
    commands.push(command);
    if (command === "cargo") {
      const output = join(repositoryRoot, "target/aarch64-apple-darwin/release");
      await mkdir(output, { recursive: true });
      for (const name of ["relayer-app-server", "relayer-graph-server"]) await writeFile(join(output, name), "compiled", { mode: 0o755 });
    }
  });
  const options = { repositoryRoot, environment: { RELAYER_DESKTOP_TARGET: "macos-arm64" }, execute, prepareLadybug: prepare, requireLicense: license, identify: async () => ({ native: "a".repeat(64), runtime: "b".repeat(64) }) };
  await buildDevelopmentDesktop(options);
  const root = join(repositoryRoot, ".relayer/packaging-cache-v1");
  expect(await packagingRuntimeReady(root, "b".repeat(64))).toBe(true);
  await buildDevelopmentDesktop({ ...options, environment: { ...options.environment, RELAYER_PACKAGING_FETCH_ON_MISS: "1" } });
  expect(commands.filter((command) => command === "cargo")).toHaveLength(1);
  expect(commands.filter((command) => command === process.execPath)).toHaveLength(2);
  expect(license).toHaveBeenCalledTimes(2);
  expect(prepare).toHaveBeenCalledTimes(1);
  await expect(buildDevelopmentDesktop({ ...options, execute: async (command, args) => {
    expect(command).toBe(process.execPath);
    expect(args).toContain("desktop/packaging/electron-builder.mjs");
    expect(args).toContain("--arm64");
    throw Error("afterPack rejected current package");
  } })).rejects.toThrow("afterPack rejected current package");
  await writeFile(join(repositoryRoot, ".relayer/packaging-cache-v1/runtime", "b".repeat(64), "payload/relayer-graph-server"), "broken");
  expect(await packagingRuntimeReady(root, "b".repeat(64))).toBe(false);
  const fallbackCalls = [];
  await buildDevelopmentDesktop({ ...options, environment: { ...options.environment, RELAYER_PACKAGING_FETCH_ON_MISS: "1" }, execute: async (command, args, settings) => {
    fallbackCalls.push([command, args[0]]);
    if (command === "cargo" && args[0] === "fetch") return;
    return execute(command, args, settings);
  } });
  expect(fallbackCalls.slice(0, 2)).toEqual([["cargo", "fetch"], ["cargo", "build"]]);
  expect(commands.filter((command) => command === "cargo")).toHaveLength(2);

  // Publishing into an unwritable/broken cache must not rerun successful Cargo.
  const isolatedRoot = await temporary();
  let successfulCompiles = 0;
  await buildDevelopmentDesktop({ ...options, repositoryRoot: isolatedRoot, execute: async (command) => {
    if (command !== "cargo") return;
    successfulCompiles++;
    const output = join(isolatedRoot, "target/aarch64-apple-darwin/release");
    await mkdir(output, { recursive: true });
    for (const name of ["relayer-app-server", "relayer-graph-server"]) await writeFile(join(output, name), "compiled");
    const payload = join(isolatedRoot, ".relayer/packaging-cache-v1/runtime", "b".repeat(64), "payload");
    await rm(payload, { recursive: true });
    await writeFile(payload, "simulate cache storage failure");
  } });
  expect(successfulCompiles).toBe(1);
  const failing = { ...options, environment: { ...options.environment, RELAYER_PACKAGING_CACHE: "off" }, execute: async () => { throw Error("compile rejected"); } };
  await expect(buildDevelopmentDesktop(failing)).rejects.toThrow("compile rejected");
});

test("Intel macOS development packaging preserves its native tool environment", async () => {
  const environment = { RELAYER_DESKTOP_TARGET: "macos-x64", PATH: "/fixture/tools" };
  const execute = vi.fn(async (_command, _args, options) => expect(options.env).toEqual(environment));
  await buildDevelopmentDesktop({ environment, execute });
  expect(execute).toHaveBeenCalledTimes(2);
});

test("Windows development packaging licenses and compiles the pinned static source offline before assembly", async () => {
  const environment = { RELAYER_DESKTOP_TARGET: "windows-x64", PATH: "C:\\tools;D:\\tools", OPENSSL_DIR: "/ambient/ssl" };
  const pinned = { OPENSSL_DIR: "/fixture/ssl", LBUG_SOURCE_DIR: "/fixture/lbug", OPENSSL_STATIC: "1", LBUG_BUILD_FROM_SOURCE: "1", CARGO_NET_OFFLINE: "true" };
  const license = vi.fn(async () => {});
  const dispose = vi.fn();
  const prepare = vi.fn(async ({ target }) => {
    expect(target.rustTarget).toBe("x86_64-pc-windows-msvc");
    return { environment: pinned, dispose };
  });
  const execute = vi.fn(async () => {});
  await buildDevelopmentDesktop({ environment, execute, prepareLadybug: prepare, requireLicense: license });
  expect(license).toHaveBeenCalledOnce();
  expect(prepare).toHaveBeenCalledOnce();
  expect(dispose).toHaveBeenCalledOnce();
  expect(execute.mock.calls[0]).toEqual(["cargo", ["build", "--release", "-p", "relayer-app-server", "-p", "relayer-graph-server", "--target", "x86_64-pc-windows-msvc", "--locked", "--offline"], expect.objectContaining({ env: { ...environment, ...pinned } })]);
  expect(execute.mock.calls[1][1]).toEqual(expect.arrayContaining(["--dir", "--win", "--x64"]));
  expect(execute.mock.calls[1][2].env).toEqual(environment);
});

test("Windows development packaging refuses unlicensed distribution before native preparation or assembly", async () => {
  const prepare = vi.fn();
  const execute = vi.fn();
  await expect(buildDevelopmentDesktop({
    environment: { RELAYER_DESKTOP_TARGET: "windows-x64" },
    prepareLadybug: prepare,
    execute,
    requireLicense: async () => { throw Error("distribution license incomplete"); },
  })).rejects.toThrow("distribution license incomplete");
  expect(prepare).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
});


test("production identity reads locked workspace metadata with an empty Cargo home", async () => {
  const emptyHome = await temporary();
  const repositoryRoot = resolve(import.meta.dirname, "..");
  const identity = await packagingIdentity({
    repositoryRoot, cacheRoot: join(emptyHome, "cache"), target: { rustTarget: "aarch64-apple-darwin" },
    environment: { HOME: emptyHome, CARGO_HOME: emptyHome },
    command: (name, args) => name === "cargo" && args[0] === "metadata"
      ? execFileSync(name, args, { env: { ...process.env, CARGO_HOME: emptyHome }, encoding: "utf8" }).trim()
      : name,
  });
  expect(identity.runtime).toMatch(/^[a-f0-9]{64}$/);
});
