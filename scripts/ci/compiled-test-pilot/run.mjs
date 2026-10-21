import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [phase] = process.argv.slice(2);
if (!["compile", "test"].includes(phase)) throw new Error("expected compile or test");
const metadata = spawnSync("cargo", ["metadata", "--locked", "--no-deps", "--format-version", "1"], { encoding: "utf8" });
if (metadata.status !== 0) throw new Error(metadata.stderr);
const resolved = JSON.parse(metadata.stdout);
const rustPackages = resolved.packages.filter((p) => resolved.workspace_members.includes(p.id)).map((p) => p.name).sort();
const command = phase === "compile" ? "cargo" : "node";
// Compile only before packing: no test outputs enter the transport. The fresh
// test command remains the production chapter, including Cargo's doctests.
const args = phase === "compile"
  ? ["test", ...rustPackages.flatMap((p) => ["-p", p]), "--no-run"]
  : ["scripts/ci/run-chapter.mjs", "rust-tests"];
const start = performance.now();
const result = spawnSync(command, args, {
  stdio: "inherit",
  env: { ...process.env, CI_PLAN_JSON: JSON.stringify({ rustPackages }) },
});
const evidence = process.env.PILOT_EVIDENCE;
mkdirSync(evidence, { recursive: true });
writeFileSync(join(evidence, `${phase}.json`), JSON.stringify({
  command: [command, ...args], rustPackages, status: result.status,
  signal: result.signal, error: result.error?.message,
  elapsedSeconds: (performance.now() - start) / 1000,
}, null, 2) + "\n");
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
