#!/usr/bin/env node

// Runs the TLA+ models in models/tla against their recorded expectations.
//
// A check expects either "pass" or a named violation. A known bug is recorded
// as an expected violation. The runner reads only the models: a fix PR mirrors
// its change in the model (a preset constant or a spec action), which flips
// that check's outcome and so requires its expectation to flip too. A new
// counterexample also fails the run.
//
// The TLA+ tools are never downloaded. Point TLA2TOOLS_JAR at the pinned jar,
// or place it at ~/.cache/tlaplus/tla2tools-<version>.jar.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const modelDirectory = join(repository, "models", "tla");
const manifest = JSON.parse(readFileSync(join(modelDirectory, "checks.json"), "utf8"));

function fail(message) {
  console.error(message);
  process.exit(2);
}

function toolsJar() {
  const { version, url, sha256 } = manifest.tlaTools;
  const jar = process.env.TLA2TOOLS_JAR
    ?? join(homedir(), ".cache", "tlaplus", `tla2tools-${version}.jar`);
  if (!existsSync(jar)) {
    fail(`TLA+ tools ${version} not found at ${jar}.\nFetch ${url}\nand verify sha256 ${sha256}, or set TLA2TOOLS_JAR.`);
  }
  const digest = createHash("sha256").update(readFileSync(jar)).digest("hex");
  if (digest !== sha256) fail(`${jar} has sha256 ${digest}; expected ${sha256}.`);
  return jar;
}

function javaExecutable() {
  const candidates = [
    process.env.JAVA_HOME && join(process.env.JAVA_HOME, "bin", "java"),
    "/opt/homebrew/opt/openjdk@21/bin/java",
    "/usr/local/opt/openjdk@21/bin/java",
    "java",
  ].filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["-version"], { encoding: "utf8" });
    if (probe.status === 0) return candidate;
  }
  fail("No working Java runtime (11 or newer) found. Set JAVA_HOME.");
}

function configFor(check) {
  const constants = { ...manifest.presets[check.preset], ...(check.constants ?? {}) };
  const lines = ["CONSTANTS", ...Object.entries(constants).map(([name, value]) => `  ${name} = ${value}`)];
  lines.push(`SPECIFICATION ${check.fair ? "FairSpec" : "Spec"}`);
  if (check.invariants?.length) lines.push("INVARIANTS", ...check.invariants.map((name) => `  ${name}`));
  if (check.properties?.length) lines.push("PROPERTIES", ...check.properties.map((name) => `  ${name}`));
  lines.push("CHECK_DEADLOCK FALSE", "");
  return lines.join("\n");
}

// The violated invariant or property, or null when TLC finished clean.
function outcomeOf(output) {
  if (/Model checking completed\. No error has been found\./.test(output)) return { violated: null };
  const violated = /Error: (?:Invariant|Temporal property|Action property) (\w+) (?:is|was) violated/.exec(output)
    ?? /Error: Action property (\w+)/.exec(output);
  if (violated) return { violated: violated[1] };
  return { error: output.split("\n").filter((line) => /error|exception/i.test(line)).slice(0, 5).join("\n") || "TLC did not finish" };
}

function traceOf(output) {
  const steps = [...output.matchAll(/^State \d+: <(\w+(?:\([^)]*\))?)/gm)].map((match) => match[1]);
  if (/^State \d+: Stuttering/m.test(output)) steps.push("(stutters forever)");
  const back = /^Back to state (\d+)/m.exec(output);
  if (back) steps.push(`(loops back to state ${back[1]})`);
  return steps.join(" -> ");
}

function runTlc(java, jar, workspace, name, module, config, { workers = "auto", tlaLibrary = null, dumpTrace = null } = {}) {
  const configPath = join(workspace, `${name}.cfg`);
  writeFileSync(configPath, config);
  const args = [
    "-XX:+UseParallelGC",
    ...(tlaLibrary ? [`-DTLA-Library=${tlaLibrary}`] : []),
    "-cp", jar, "tlc2.TLC",
    "-noGenerateSpecTE", "-cleanup", "-workers", workers,
    "-metadir", join(workspace, `${name}.states`),
    ...(dumpTrace ? ["-dumpTrace", "json", dumpTrace] : []),
    "-config", configPath,
    module,
  ];
  const run = spawnSync(java, args, { cwd: dirname(module), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return `${run.stdout}\n${run.stderr}`;
}

// TLC writes a function over 1..n as a JSON array; key it like a record so
// every variable reads the same way in the adapters.
function normalize(value) {
  if (Array.isArray(value)) return Object.fromEntries(value.map((item, index) => [String(index + 1), normalize(item)]));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]));
  }
  return value;
}

const tlaValue = (value) => (typeof value === "string" ? JSON.stringify(value) : String(value));

// A scenario is a sequence of named actions. The model renders it into the
// full expected state after every step, which the trace adapters replay
// against the real code. A step the model does not enable is an error: the
// scenario no longer describes a behavior of the model.
function renderScenario(java, jar, workspace, scenario) {
  const moduleName = `Scenario_${scenario.id.replace(/[^A-Za-z0-9]/g, "_")}`;
  const steps = scenario.steps.map((step) => `<<${step.map(tlaValue).join(", ")}>>`).join(",\n  ");
  writeFileSync(join(workspace, `${moduleName}.tla`), [
    `---- MODULE ${moduleName} ----`,
    `EXTENDS ${scenario.module}, Sequences`,
    "VARIABLE step",
    `Steps == <<\n  ${steps}\n>>`,
    `SInit == Init /\\ ${scenario.init ?? "TRUE"} /\\ step = 0`,
    "SNext == step < Len(Steps) /\\ Act(Steps[step + 1]) /\\ step' = step + 1",
    "SSpec == SInit /\\ [][SNext]_<<vars, step>>",
    "Unfinished == step < Len(Steps)",
    "====",
    "",
  ].join("\n"));
  const constants = manifest.presets[scenario.preset];
  const config = [
    "CONSTANTS", ...Object.entries(constants).map(([name, value]) => `  ${name} = ${value}`),
    "SPECIFICATION SSpec", "INVARIANT Unfinished", "CHECK_DEADLOCK FALSE", "",
  ].join("\n");
  const dump = join(workspace, `${moduleName}.json`);
  const output = runTlc(java, jar, workspace, moduleName, join(workspace, `${moduleName}.tla`), config, {
    workers: "1", tlaLibrary: modelDirectory, dumpTrace: dump,
  });
  if (!/Invariant Unfinished is violated/.test(output) || !existsSync(dump)) {
    const reached = [...output.matchAll(/^State (\d+):/gm)].length;
    throw new Error(`scenario ${scenario.id} is not a behavior of ${scenario.module}${reached ? ` (stops after ${reached - 1} steps)` : ""}:\n${outcomeOf(output).error ?? "an action is not enabled"}`);
  }
  const states = JSON.parse(readFileSync(dump, "utf8")).counterexample.state.map(([, state]) => {
    const { step: _step, ...rest } = state;
    return normalize(rest);
  });
  return {
    scenario: scenario.id,
    module: scenario.module,
    summary: scenario.summary,
    promises: scenario.promises,
    ...(scenario.finalPromises ? { finalPromises: scenario.finalPromises } : {}),
    generatedBy: "models/tla/scenarios.json via `node scripts/models/check-tla.mjs --render`",
    steps: states.map((state, index) => ({ action: index === 0 ? null : scenario.steps[index - 1], state })),
  };
}

const flags = new Set(process.argv.slice(2).filter((arg) => arg.startsWith("--")));
const selected = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const render = flags.has("--render");
const scenarioManifest = JSON.parse(readFileSync(join(modelDirectory, "scenarios.json"), "utf8"));
const traceDirectory = join(modelDirectory, "traces");
const known = new Set([...manifest.checks, ...scenarioManifest.scenarios].map(({ id }) => id));
const unknown = selected.filter((id) => !known.has(id));
if (unknown.length) fail(`Unknown check or scenario id: ${unknown.join(", ")}`);
const checks = render ? [] : manifest.checks.filter((check) => !selected.length || selected.includes(check.id));
const scenarios = scenarioManifest.scenarios.filter((scenario) => !selected.length || selected.includes(scenario.id));

const jar = toolsJar();
const java = javaExecutable();
const workspace = mkdtempSync(join(tmpdir(), "relayer-tla-"));
let failures = 0;
try {
  for (const check of checks) {
    const started = Date.now();
    const output = runTlc(java, jar, workspace, check.id, join(modelDirectory, `${check.module}.tla`), configFor(check), {
      // One worker keeps the reported counterexample the same run to run.
      workers: check.expect === "pass" ? "auto" : "1",
    });
    const outcome = outcomeOf(output);
    const expected = check.expect === "pass" ? null : check.expect.violated;
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const ok = outcome.error === undefined && outcome.violated === expected;
    if (!ok) failures += 1;
    const observed = outcome.error ? `error` : outcome.violated ? `violates ${outcome.violated}` : "passes";
    console.log(`${ok ? "ok  " : "FAIL"} ${check.id} (${observed}, ${seconds}s)`);
    console.log(`     ${check.finding}`);
    if (outcome.violated) console.log(`     trace: ${traceOf(output)}`);
    if (!ok) {
      console.log(`     expected: ${expected ? `violates ${expected}` : "passes"}`);
      if (outcome.error) console.log(outcome.error.replace(/^/gm, "     "));
    }
  }
  // Committed traces are fixtures for the adapters, which run without Java.
  // Outside --render, a trace that no longer matches the model fails the run.
  for (const scenario of scenarios) {
    const path = join(traceDirectory, `${scenario.id}.json`);
    let ok = true;
    let note;
    try {
      const rendered = `${JSON.stringify(renderScenario(java, jar, workspace, scenario), null, 2)}\n`;
      if (render) {
        mkdirSync(traceDirectory, { recursive: true });
        writeFileSync(path, rendered);
        note = "rendered";
      } else if (!existsSync(path) || readFileSync(path, "utf8") !== rendered) {
        ok = false;
        note = "trace fixture is stale; run `node scripts/models/check-tla.mjs --render`";
      } else {
        note = "trace fixture matches the model";
      }
    } catch (error) {
      ok = false;
      note = error.message;
    }
    if (!ok) failures += 1;
    console.log(`${ok ? "ok  " : "FAIL"} scenario ${scenario.id} (${note})`);
  }
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
const total = checks.length + scenarios.length;
if (failures) {
  console.error(`${failures} of ${total} model checks and scenarios did not match.`);
  process.exit(1);
}
console.log(`${total} model checks and scenarios matched.`);
