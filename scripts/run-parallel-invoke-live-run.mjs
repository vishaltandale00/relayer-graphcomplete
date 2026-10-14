/**
 * Opt-in live run for parallel invoke runs (issue #717).
 *
 * This entry point consumes paid inference and needs a real provider. It is deliberately
 * excluded from `npm run check`; nothing in the default suite may call it.
 *
 * It boots the same GraphComplete runtime and app server the desktop uses, asks for an answer
 * with invoke actions, then clicks two of them and sends a follow-up message at once. It records
 * whether all three were admitted, how long they ran side by side, whether each settled, and
 * whether only the invoked runs' prompts carried the fresh-session block pointing at the thread's history.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  preparePrimeEnvironment,
  prepareRoute,
  readProfile,
  startLiveProduct,
} from "./live-run-setup.mjs";
import { productRequest } from "./recursive-live-run-transport.mjs";
import { liveRunTimeoutMs, workspaceProvenance, writeJsonAtomic } from "./recursive-live-run-provenance.mjs";
import { exportTraceEvidence } from "./recursive-live-run-trace.mjs";

const OPT_IN = "RELAYER_PARALLEL_INVOKE_LIVE_RUN";
const repositoryRoot = resolve(import.meta.dirname, "..");
const ACTIVE = new Set(["not_started", "submitted", "running", "waiting_for_approval"]);
// Overlap counts only runs that started: a queued or still-starting run is not running beside
// the others, so it cannot satisfy the side-by-side check.
const RUNNING = new Set(["running", "waiting_for_approval"]);
const FRESH_MARKER = "This run starts a fresh session";

const ROOT_TASK = [
  "Compare three ways to learn a new programming language: building a small project, working",
  "through exercises, and reading other people's code. Present one node per approach. Give each",
  "node an invoke action labelled \"Plan a first week\" whose interaction text asks for a",
  "seven-day plan for that approach. Leave those invoke actions for me to click; do not run them",
  "yourself.",
].join(" ");
const FOLLOW_UP = "In one sentence, which approach suits someone with only twenty minutes a day?";

function singleArgument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

/** Every file below a trace export, read as text, to find what each run's prompt said. */
function exportedText(directory) {
  let text = "";
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    text += statSync(path).isDirectory() ? exportedText(path) : readFileSync(path, "utf8");
  }
  return text;
}

async function threadInteractions(session, threadId) {
  const state = await productRequest(session, `/api/state?threadId=${threadId}`);
  return {
    interactions: (state.interactions ?? []).filter((interaction) => interaction.threadId === threadId),
    actionInvocations: state.actionInvocations ?? [],
  };
}

/** Polls the product, as the desktop does, recording each interaction's status over time. */
async function sampleUntil(session, threadId, done, timeoutMs, samples) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const observed = await threadInteractions(session, threadId);
    samples.push({
      atMs: Date.now(),
      statuses: Object.fromEntries(observed.interactions.map(({ id, completionStatus }) => [id, completionStatus])),
    });
    if (done(observed)) return observed;
    if (Date.now() > deadline) throw new Error(`The live run did not settle within ${timeoutMs}ms.`);
    await new Promise((wait) => setTimeout(wait, 250));
  }
}

/** When each run was seen active, and the most runs seen active in one sample. */
function concurrency(samples, ids) {
  const windows = Object.fromEntries(ids.map((id) => {
    const active = samples.filter(({ statuses }) => RUNNING.has(statuses[id]));
    return [id, active.length === 0 ? null : { firstActiveAtMs: active[0].atMs, lastActiveAtMs: active.at(-1).atMs }];
  }));
  const maxActiveAtOnce = Math.max(0, ...samples.map(({ statuses }) => ids.filter((id) => RUNNING.has(statuses[id])).length));
  const overlapMs = samples.reduce((total, sample, index) => {
    const next = samples[index + 1];
    const allActive = ids.every((id) => RUNNING.has(sample.statuses[id]));
    return next && allActive ? total + (next.atMs - sample.atMs) : total;
  }, 0);
  return { windows, maxActiveAtOnce, allActiveTogetherMs: overlapMs };
}

async function main() {
  if (process.env[OPT_IN] !== "1") {
    throw new Error(`The parallel invoke live run is opt-in and spends real inference. Set ${OPT_IN}=1.`);
  }
  const timeoutMs = liveRunTimeoutMs(singleArgument("--timeout-ms", "1200000"));
  const { profile, configurationPath } = await readProfile(
    resolve(singleArgument("--credentials", "live-run.local.json")),
    singleArgument("--profile", ""),
  );
  if (profile.implementation === "prime.agent") await preparePrimeEnvironment();
  const runId = randomUUID();
  const outputDirectory = resolve(singleArgument("--output-dir", join(".relayer", "live", "parallel-invoke", runId)));
  mkdirSync(outputDirectory, { recursive: true });
  const dataDirectory = mkdtempSync(join(tmpdir(), "relayer-parallel-invoke-live-"));
  let runtime;
  let productServer;
  let executables;
  const samples = [];
  const artifact = {
    schemaVersion: 1,
    issue: 717,
    runId,
    profile: profile.name,
    harness: profile.harness,
    implementation: profile.implementation,
    modelId: profile.modelId,
    rootTask: ROOT_TASK,
    followUp: FOLLOW_UP,
    // The exact source this run executed: its commit and a digest of any uncommitted change.
    source: workspaceProvenance(repositoryRoot),
    startedAt: new Date().toISOString(),
  };
  try {
    let resolver;
    ({ runtime, productServer, resolver, executables } = await startLiveProduct({ profile, configurationPath, dataDirectory }));
    // The servers that ran, rebuilt from this source and named by hash.
    artifact.executables = executables;
    artifact.temporalFeatures = runtime.temporalFeatures;
    const session = await productServer.start();
    const family = await prepareRoute({ session, productServer, runtime, resolver, profile });
    const modelSelection = { familyId: family.id, providerId: profile.providerId, modelId: profile.modelId };
    const thread = await productRequest(session, "/api/threads", {
      method: "POST",
      body: JSON.stringify({
        title: "Parallel invoke live run",
        initialMessage: ROOT_TASK,
        harnessId: profile.harness,
        permissionProfileId: "auto",
        modelSelection,
      }),
    });
    const rootSettled = await sampleUntil(session, thread.id, ({ interactions }) => interactions.some((interaction) => (
      interaction.id === thread.rootInteractionId && !ACTIVE.has(interaction.completionStatus)
    )), timeoutMs, samples);
    const root = rootSettled.interactions.find(({ id }) => id === thread.rootInteractionId);
    artifact.root = { interactionId: root.id, graphNodeId: root.graphNodeId, completionStatus: root.completionStatus };
    if (root.completionStatus !== "accepted") throw new Error(`The first turn ended ${root.completionStatus}.`);
    const invokeActions = (root.completionOutput?.rootLayer?.actions ?? [])
      .filter((action) => action.kind === "invoke" && action.targetLayerId == null);
    artifact.root.invokeActions = invokeActions.map(({ id, label }) => ({ id, label }));
    if (invokeActions.length < 2) throw new Error(`The first turn authored ${invokeActions.length} invoke actions; two are needed.`);

    // Two invoke clicks and a follow-up message, all at once.
    const clickedAtMs = Date.now();
    const [first, second, message] = await Promise.all([
      ...invokeActions.slice(0, 2).map((action) => productRequest(
        session,
        `/api/threads/${thread.id}/interactions/${root.id}/actions/${action.id}/invoke`,
        { method: "POST" },
      )),
      productRequest(session, `/api/threads/${thread.id}/interactions`, {
        method: "POST",
        body: JSON.stringify({ text: FOLLOW_UP, inputId: randomUUID(), modelSelection }),
      }),
    ]);
    const runs = [
      { kind: "invoke", interactionId: first.interaction?.id ?? first.id },
      { kind: "invoke", interactionId: second.interaction?.id ?? second.id },
      { kind: "message", interactionId: message.interaction?.id ?? message.id },
    ];
    artifact.admission = { allAdmitted: true, admittedWithinMs: Date.now() - clickedAtMs };
    const ids = runs.map(({ interactionId }) => interactionId);
    const settled = await sampleUntil(session, thread.id, ({ interactions }) => ids.every((id) => {
      const interaction = interactions.find((candidate) => candidate.id === id);
      return interaction !== undefined && !ACTIVE.has(interaction.completionStatus);
    }), timeoutMs, samples);
    for (const run of runs) {
      const interaction = settled.interactions.find(({ id }) => id === run.interactionId);
      run.completionStatus = interaction?.completionStatus;
      run.graphNodeId = interaction?.graphNodeId;
    }
    artifact.runs = runs;
    artifact.concurrency = concurrency(samples.filter(({ atMs }) => atMs >= clickedAtMs), ids);

    // Each run's prompt, from its candidate trace: only the invoked runs start fresh.
    const traceDirectory = join(dataDirectory, "trace-export");
    const traces = await exportTraceEvidence({
      runtime,
      interactions: runs.map(({ interactionId, graphNodeId }) => ({ id: interactionId, graphNodeId })),
      directory: traceDirectory,
      refPrefix: "traces",
      correlation: { runId, arm: "parallel", harnessConfigurationName: profile.harness, model: profile.modelId },
    });
    for (const run of runs) {
      const text = exportedText(join(traceDirectory, String(run.interactionId)));
      run.freshSessionPrompt = text.includes(FRESH_MARKER);
      // History is graph pointers: the first turn appears as its interaction node, not its text.
      run.promptCarriesFirstTurn = root.graphNodeId != null && text.includes(`"interactionNodeId": ${root.graphNodeId}`);
    }
    artifact.traces = traces.map(({ productInteractionId, status, coverageComplete, truncated }) => ({
      productInteractionId, status, coverageComplete, truncated: truncated === true,
    }));
    // A prompt check proves something only on a complete trace: a truncated one may lack the
    // prompt, so a missing fresh-session marker would prove nothing.
    const tracesComplete = traces.every(({ status, coverage, truncated }) => (
      status === "complete" && coverage?.prompt === "full" && truncated !== true
    ));
    const checks = {
      allAdmitted: true,
      // The message and both invokes, all active in the same samples.
      ranSideBySide: artifact.concurrency.maxActiveAtOnce >= 3 && artifact.concurrency.allActiveTogetherMs > 0,
      tracesComplete,
      allAccepted: runs.every(({ completionStatus }) => completionStatus === "accepted"),
      // These read the prompt only: the run was told it starts fresh. Whether each provider
      // really opened a new native session is the deterministic provider tests' claim (PAR-003).
      invokedRunsGotFreshPrompt: runs.filter(({ kind }) => kind === "invoke").every(({ freshSessionPrompt }) => freshSessionPrompt),
      invokedRunsSawHistory: runs.filter(({ kind }) => kind === "invoke").every(({ promptCarriesFirstTurn }) => promptCarriesFirstTurn),
      messageGotResumePrompt: tracesComplete
        && runs.filter(({ kind }) => kind === "message").every(({ freshSessionPrompt }) => !freshSessionPrompt),
    };
    artifact.checks = checks;
    artifact.passed = Object.values(checks).every(Boolean);
  } catch (error) {
    artifact.passed = false;
    artifact.failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    artifact.finishedAt = new Date().toISOString();
    artifact.samples = samples.length;
    writeJsonAtomic(join(outputDirectory, "run.json"), artifact);
    console.log(JSON.stringify(artifact, null, 2));
    await productServer?.close().catch(() => {});
    await runtime?.close().catch(() => {});
    if (process.argv.includes("--keep-data")) console.error(`Kept live-run data in ${dataDirectory}`);
    else rmSync(dataDirectory, { recursive: true, force: true });
  }
  if (!artifact.passed) process.exitCode = 1;
}

await main();
