/**
 * PREV-005: opt-in live proof that a real model received a draft-preview image.
 *
 * This spends paid inference and needs the Eval profile's connected provider
 * for the chosen harness. It is excluded from `npm run check`. It runs one
 * harness (`--harness codex-basic`, the default, `claude-basic` or
 * `prime-agent-basic`) on one layout-heavy built-in case through the real Eval
 * host. It passes only when the turn was accepted and, before the successful
 * graph.submit, the model received a `submitLayer` preview image:
 * - Codex opened it with its image viewer (`imageView`);
 * - Claude's `view_graph_preview` tool returned it;
 * - Prime's `attach_image` skill attached it to the ipython result.
 * It makes no claim that previews improve quality.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { PREVIEW_VIEWERS } from "./agent-preview-viewers.mjs";

const OPT_IN = "RELAYER_AGENT_PREVIEW_LIVE";
if (process.env[OPT_IN] !== "1") {
  throw new Error(`The agent-preview live run spends real inference. Set ${OPT_IN}=1 to run it.`);
}
const { values: options } = parseArgs({ options: { harness: { type: "string", default: "codex-basic" } } });
const harness = options.harness;
if (!Object.hasOwn(PREVIEW_VIEWERS, harness)) {
  throw new Error(`--harness must be one of ${Object.keys(PREVIEW_VIEWERS).join(", ")}.`);
}
const root = resolve(import.meta.dirname, "..");
const userData = resolve(process.env.RELAYER_EVAL_USER_DATA_DIR || join(homedir(), ".relayer", "eval-web"));
const output = resolve(root, ".relayer/evidence/agent-preview-live", harness);
const selection = {
  testCaseIds: ["empty-project.hierarchical-overview.single-turn"],
  harnessConfigurationNames: [harness],
  judgeConfigurationName: "deterministic-graph-contract",
};

async function until(check, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
  }
  throw new Error(`Timed out: ${label}`);
}

const scratch = await mkdtemp(join(tmpdir(), "relayer-agent-preview-live-"));
const shutdownShim = join(scratch, "shutdown-shim.mjs");
await writeFile(shutdownShim, 'process.on("message", (message) => { if (message === "shutdown") process.emit("SIGINT"); });\n');
const child = spawn(process.execPath, ["--import", pathToFileURL(shutdownShim).href, "desktop/eval-main/index.mjs"], {
  cwd: root,
  env: {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("RELAYER_EVAL_AUTORUN"))),
    RELAYER_EVAL_USER_DATA_DIR: userData,
    // The authored layout-heavy answer can take longer than Eval's 10-minute default.
    RELAYER_EVAL_TURN_TIMEOUT_MS: process.env.RELAYER_EVAL_TURN_TIMEOUT_MS || String(30 * 60_000),
  },
  stdio: ["ignore", "pipe", "pipe", "ipc"],
});
let log = "";
child.stdout.on("data", (bytes) => { log += bytes; });
child.stderr.on("data", (bytes) => { log += bytes; });
const exited = once(child, "exit");
try {
  const url = await until(() => {
    if (child.exitCode !== null) throw new Error(`The Eval host exited:\n${log}`);
    return log.match(/Relayer Eval: (http:\/\/\S+)/)?.[1];
  }, "Eval host ready", 120_000);
  const rpc = async (operation, args = []) => {
    const response = await fetch(new URL(`/eval-api/${operation}`, url), {
      method: "POST",
      headers: { Authorization: `Bearer ${new URL(url).hash.slice(1)}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    const value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    return value;
  };
  // A fresh host publishes provider readiness asynchronously. A run created
  // before that fails at once with no model and spends no inference; retry it.
  let run;
  for (let attempt = 1; ; attempt += 1) {
    const created = await rpc("createRun", [selection]);
    console.log(`Started live run ${created.id}`);
    run = await until(async () => {
      const value = await rpc("getRun", [created.id]);
      return ["passed", "failed", "error", "interrupted"].includes(value.status) ? value : null;
    }, "live run", 60 * 60_000);
    const noModel = /No available model/.test(run.executions[0]?.error ?? "");
    if (!noModel || attempt === 12) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10_000));
  }
  const execution = run.executions[0];
  const turn = execution.turns[0];
  if (turn === undefined) {
    throw new Error(`Live run ${run.id} executed no turn (${run.status}): ${execution.error ?? "no error recorded"}`);
  }
  const turnDirectory = join(userData, "eval-data", "runs", encodeURIComponent(run.id), "executions",
    encodeURIComponent(execution.id), "turns", encodeURIComponent(String(turn.interactionId)));
  const events = (await readFile(join(turnDirectory, "candidate-trace", "events.jsonl"), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line));
  const renderedLayers = events
    .filter((event) => event.type === "graph.preview" && event.data.outcome === "rendered" && event.data.target.kind === "layer")
    .map((event) => event.data.fingerprint.slice("sha256:".length, "sha256:".length + 16));
  const viewed = PREVIEW_VIEWERS[harness](events);
  // The model must see the image while it can still act on it: before the
  // successful graph.submit that ends graph access.
  const operations = (await readFile(join(turnDirectory, "candidate-trace", "graph-operations.jsonl"), "utf8").catch(() => ""))
    .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const submittedAt = operations.find((operation) => operation.path === "/api/graph/submit"
    && operation.status >= 200 && operation.status < 300)?.observedAt;
  const viewedLayerPreviews = viewed
    .filter((view) => submittedAt === undefined || view.observedAt < submittedAt)
    .map((view) => view.file)
    .filter((file) => {
      const match = /^layer-\d+-([0-9a-f]{16})\.png$/.exec(file);
      return match !== null && renderedLayers.includes(match[1]);
    });
  const accepted = turn.status === "accepted";
  const receipt = {
    runId: run.id,
    runStatus: run.status,
    case: selection.testCaseIds[0],
    harness: selection.harnessConfigurationNames[0],
    turnAccepted: accepted,
    renderedLayerPreviews: renderedLayers.length,
    previewEvents: events.filter((event) => event.type === "graph.preview").map((event) => event.data),
    imageViews: viewed.map((view) => view.file),
    submittedAt: submittedAt ?? null,
    viewedLayerPreviews,
    passed: accepted && viewedLayerPreviews.length > 0,
    qualityClaim: "none",
  };
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  const artifacts = join(turnDirectory, "candidate-trace", "draft-previews");
  for (const name of await readdir(artifacts).catch(() => [])) await cp(join(artifacts, name), join(output, name));
  console.log(JSON.stringify(receipt, null, 2));
  assert.ok(accepted, "The live turn was not accepted.");
  assert.ok(viewedLayerPreviews.length > 0, "No submitLayer preview image reached the model as image input before submit.");
  console.log(`PASS PREV-005 ${harness} ${run.id}`);
} finally {
  if (child.exitCode === null) {
    child.send("shutdown");
    // A host that finishes a live turn can take longer to close; a forced kill
    // would leave the Eval profile lock behind.
    const timeout = setTimeout(() => child.kill("SIGKILL"), 120_000);
    await exited;
    clearTimeout(timeout);
  }
  await rm(scratch, { recursive: true, force: true });
}
