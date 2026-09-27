import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { evalRuntimeBinaries, prepareEval, requireEvalArtifacts } from "../desktop/eval-main/runtime-artifacts.mjs";
import { nativeBinaryName } from "../desktop/shared/target.mjs";

const required = ["dist/index.js", ...["graph-client", "visual-assets", "harness-host", "eval-runner"].map((name) => `packages/${name}/dist/index.js`), "packages/graph-client/agent-resource/index.js", "desktop/renderer/vendor/marked.umd.js", "desktop/renderer/vendor/lucide.min.js"];
const roots = [];
function checkout() {
  const root = mkdtempSync(join(tmpdir(), "eval-artifacts-"));
  roots.push(root);
  return root;
}
function file(root, path, content = "") {
  const output = join(root, path);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, content);
  chmodSync(output, 0o755);
  return output;
}
function buildResult(root) {
  return { status: 0, stdout: ["relayer-app-server", "relayer-graph-server"].map((name) => JSON.stringify({ reason: "compiler-artifact", executable: join(root, "target/debug", nativeBinaryName(name)) })).join("\n") };
}
function binaries(root, version) {
  for (const name of ["relayer-app-server", "relayer-graph-server"]) {
    file(root, `target/debug/${nativeBinaryName(name)}`, `process.stdout.write(${JSON.stringify(version)});`);
  }
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("prepares and launches divergent checkouts through the same private target convention", () => {
  const first = checkout();
  const second = checkout();
  function prepare(root, version) {
    prepareEval(root, {}, (_command, args, options) => {
      if (_command !== "cargo") expect(args).toEqual(["run", "build"]); // retain full shared compilation
      else expect(args).toContain("--message-format=json");
      expect(options.cwd).toBe(root);
      expect(options.env.CARGO_TARGET_DIR).toBe(join(root, "target"));
      binaries(root, version);
      for (const artifact of required) file(root, artifact);
      return buildResult(root);
    });
  }
  prepare(first, "first");
  prepare(second, "second");
  const selected = evalRuntimeBinaries(first, {});
  prepare(second, "second-edited");
  for (const path of Object.values(selected)) expect(execFileSync(process.execPath, [path], { encoding: "utf8" })).toBe("first");
  for (const path of Object.values(evalRuntimeBinaries(second, {}))) expect(execFileSync(process.execPath, [path], { encoding: "utf8" })).toBe("second-edited");
});

it("migrates only the checkout target link, preserving the shared destination", () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const root = checkout();
  const shared = checkout();
  file(shared, "sentinel", "unchanged");
  symlinkSync(shared, join(root, "target"), "junction");
  expect(() => evalRuntimeBinaries(root, {})).toThrow("symlink");
  prepareEval(root, {}, () => { binaries(root, "private"); for (const artifact of required) file(root, artifact); return buildResult(root); });
  expect(readFileSync(join(shared, "sentinel"), "utf8")).toBe("unchanged");
  expect(evalRuntimeBinaries(root, {}).appServerBinary).toContain(join(root, "target"));
});

it("rejects external Cargo output and escaping debug paths before building or launching", () => {
  const root = checkout();
  const other = checkout();
  const run = vi.fn();
  expect(() => prepareEval(root, { CARGO_BUILD_TARGET: "other-triple" }, run)).toThrow("Unset CARGO_BUILD_TARGET");
  expect(() => prepareEval(root, { CARGO_BUILD_TARGET_DIR: other }, run)).toThrow("CARGO_BUILD_TARGET_DIR");
  expect(() => prepareEval(root, { CARGO_TARGET_DIR: other }, run)).toThrow("Unset CARGO_TARGET_DIR");
  expect(() => evalRuntimeBinaries(root, { CARGO_TARGET_DIR: other })).toThrow("Unset CARGO_TARGET_DIR");
  binaries(other, "other");
  mkdirSync(join(root, "target"));
  symlinkSync(join(other, "target/debug"), join(root, "target/debug"), "junction");
  expect(() => prepareEval(root, {}, run)).toThrow("private directory");
  expect(() => evalRuntimeBinaries(root, {})).toThrow("private directory");
  expect(run).not.toHaveBeenCalled();
});

it("rejects a binary link escaping the checkout", () => {
  const root = checkout();
  const other = checkout();
  binaries(root, "local");
  binaries(other, "other");
  const name = `target/debug/${nativeBinaryName("relayer-app-server")}`;
  rmSync(join(root, name));
  symlinkSync(join(other, name), join(root, name));
  expect(() => evalRuntimeBinaries(root, {})).toThrow("outside this checkout");
  expect(() => prepareEval(root, {}, vi.fn())).toThrow("outside this checkout");
});

it("keeps explicit binary overrides outside the guarantee without exempting the other default", () => {
  const root = checkout();
  const override = file(checkout(), "fixture-server", "");
  const environment = { RELAYER_GRAPH_SERVER_BIN: override };
  expect(() => evalRuntimeBinaries(root, environment)).toThrow("eval-app:prepare");
  binaries(root, "local");
  expect(evalRuntimeBinaries(root, environment).graphServerBinary).toBe(override);
  expect(evalRuntimeBinaries(root, { ...environment, RELAYER_APP_SERVER_BINARY: override, CARGO_TARGET_DIR: "/irrelevant" }).appServerBinary).toBe(override);
});

it("fails preparation on build failure and reports missing recursive/runtime artifacts", () => {
  const root = checkout();
  expect(() => prepareEval(root, {}, () => ({ status: 9 }))).toThrow("preparation failed (9)");
  expect(() => prepareEval(root, {}, () => ({ error: new Error("spawn failed") }))).toThrow("spawn failed");
  expect(() => prepareEval(root, {}, () => ({ status: 0 }))).toThrow("eval-app:prepare");
  binaries(root, "local");
  expect(() => requireEvalArtifacts(root, {})).toThrow("dist/index.js");
  for (const artifact of required) {
    expect(() => requireEvalArtifacts(root, {})).toThrow(artifact);
    file(root, artifact);
  }
  expect(requireEvalArtifacts(root, {})).toEqual(evalRuntimeBinaries(root, {}));
});

it("wires preparation and non-building preflight into normal and live Eval launch", () => {
  const { scripts } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  expect(scripts["eval-app:prepare"]).toBe("node desktop/eval-main/runtime-artifacts.mjs prepare");
  for (const name of ["preeval-app:dev", "preeval:input-roundtrip:live", "pretest:eval-web"]) expect(scripts[name]).toBe("node desktop/eval-main/runtime-artifacts.mjs");
  expect(scripts["eval-app:dev"]).toBe("node desktop/eval-main/index.mjs");
});

it("rechecks the actual default output tree after building", () => {
  const root = checkout();
  expect(() => prepareEval(root, {}, () => {
    for (const artifact of required) file(root, artifact);
    for (const name of ["relayer-app-server", "relayer-graph-server"]) file(root, `elsewhere/${nativeBinaryName(name)}`);
    symlinkSync(join(root, "elsewhere"), join(root, "target/debug"), "junction");
    return { status: 0 };
  })).toThrow("private directory");
});

it("does not accept older default binaries when Cargo actually emits a configured target layout", () => {
  const root = checkout();
  binaries(root, "old");
  for (const artifact of required) file(root, artifact);
  expect(() => prepareEval(root, {}, (command) => command === "cargo"
    ? { status: 0, stdout: JSON.stringify({ reason: "compiler-artifact", executable: join(root, "target/other/debug/relayer-app-server") }) }
    : { status: 0 })).toThrow("Remove Cargo build.target");
});
