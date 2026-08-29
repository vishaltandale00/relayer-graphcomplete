/**
 * Opt-in live run for the recursive Complete seam (issue #310).
 *
 * This entry point consumes paid inference and needs a real provider. It is deliberately
 * excluded from `npm run check`; nothing in the default suite may call it.
 *
 * It boots the same GraphComplete runtime and app server the desktop uses, runs one fixed
 * synthetic task, and records what the seam actually did: whether the agent created a
 * semantic child by its own decision, the ordered sequence of current-pointer revisions,
 * and wall-clock timings with recursion enabled and disabled on the same build.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  GraphCompleteRuntimeService,
  RECURSIVE_TEMPORAL_FEATURES,
} from "../desktop/main/services/graphcomplete-runtime.mjs";
import { RelayerAppServerService } from "../desktop/main/services/relayer-app-server.mjs";
import {
  RECURSIVE_LIVE_RUN_TASK,
  compareRuns,
  summarizeRun,
} from "./recursive-live-run-model.mjs";

const OPT_IN = "RELAYER_RECURSIVE_LIVE_RUN";
const repositoryRoot = resolve(import.meta.dirname, "..");

function singleArgument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function requireEnvironment(name) {
  const value = String(process.env[name] ?? "").trim();
  if (!value) throw new Error(`The live run requires ${name}.`);
  return value;
}

async function productRequest(session, path, init = {}) {
  const response = await fetch(new URL(path, session.origin), {
    ...init,
    headers: {
      "content-type": "application/json",
      cookie: `${session.cookie.name}=${session.cookie.value}`,
      ...init.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} failed with ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function completionMetadata(runtimeSession, completionIds) {
  const metadata = [];
  for (const nodeId of completionIds) {
    const response = await fetch(
      new URL(`api/control/interactions/${nodeId}`, `${runtimeSession.graphUrl}/`),
      { headers: { authorization: `Bearer ${runtimeSession.graphControlToken}` } },
    );
    if (!response.ok) continue;
    metadata.push(await response.json());
  }
  return metadata;
}

/**
 * Drives one task to settlement while recording every current-pointer revision.
 *
 * Observation reads the same projection surface the desktop reads, so the recorded
 * sequence is what a watching product would have seen, not a private test channel.
 */
async function observeUntilSettled(session, threadId, rootInteractionId, timeoutMs) {
  const startedAtMs = Date.now();
  const deadline = startedAtMs + timeoutMs;
  const events = [];
  const observations = [];
  const completionIds = new Set();
  let cursor = 0;
  for (;;) {
    const state = await productRequest(session, `/api/state?currentProjectionAfter=${cursor}`);
    const observedAtMs = Date.now();
    for (const event of state.currentProjection?.events ?? []) {
      events.push(event);
      observations.push({ observedAtMs, currentLayerId: event.currentLayerId ?? null });
    }
    cursor = state.currentProjection?.cursor ?? cursor;
    for (const interaction of state.interactions ?? []) {
      if (interaction.threadId === threadId && interaction.graphNodeId) {
        completionIds.add(interaction.graphNodeId);
      }
    }
    const root = (state.interactions ?? []).find((interaction) => interaction.id === rootInteractionId);
    const status = root?.completionStatus ?? "unknown";
    if (status !== "running" && status !== "preparing" && status !== "draft") {
      return {
        startedAtMs,
        settledAtMs: Date.now(),
        completionStatus: status,
        rootCompletionId: root?.graphNodeId ?? null,
        completionIds: [...completionIds],
        events,
        observations,
      };
    }
    if (Date.now() > deadline) {
      throw new Error(`The live task did not settle within ${timeoutMs}ms (last status ${status}).`);
    }
    await new Promise((wait) => setTimeout(wait, 250));
  }
}

async function runOnce({ recursionEnabled, harnessConfiguration, codexBinary, providerId, modelId, timeoutMs }) {
  const dataDirectory = mkdtempSync(join(tmpdir(), "relayer-recursive-live-"));
  const runtime = new GraphCompleteRuntimeService({
    userDataDirectory: dataDirectory,
    graphServerBinary: join(repositoryRoot, "target", "debug", "relayer-graph-server"),
    configurationPaths: [join(repositoryRoot, "harnesses", `${harnessConfiguration}.yaml`)],
    codexPathOverride: codexBinary,
    temporalFeatures: recursionEnabled ? RECURSIVE_TEMPORAL_FEATURES : {},
  });
  const productServer = new RelayerAppServerService({
    userDataDirectory: dataDirectory,
    binaryPath: join(repositoryRoot, "target", "debug", "relayer-app-server"),
    webDirectory: join(repositoryRoot, "desktop", "renderer"),
    permissionCatalogPath: join(repositoryRoot, "permissions", "desktop.json"),
    runtimeSession: await runtime.start(),
    defaultHarnessConfiguration: harnessConfiguration,
    allowHarnessOverride: true,
  });
  try {
    const session = await productServer.start();
    await productServer.publishProviderCatalog({
      providerId,
      label: providerId,
      connected: true,
      models: [{
        id: modelId,
        label: modelId,
        order: 0,
        visible: true,
        available: true,
        providerDefault: true,
        metadata: {},
      }],
      systemFamily: { key: providerId, name: providerId, modelIds: [modelId] },
    });
    const settings = await productRequest(session, "/api/model-settings");
    const thread = await productRequest(session, "/api/threads", {
      method: "POST",
      body: JSON.stringify({
        title: "Recursive Complete live run",
        initialMessage: RECURSIVE_LIVE_RUN_TASK,
        harnessId: harnessConfiguration,
        modelSelection: { familyId: settings.families[0].id, providerId, modelId },
      }),
    });
    const observed = await observeUntilSettled(session, thread.id, thread.rootInteractionId, timeoutMs);
    return summarizeRun({
      recursionEnabled,
      ...observed,
      completionMetadata: await completionMetadata(runtime.session, observed.completionIds),
    });
  } finally {
    await productServer.close().catch(() => {});
    await runtime.close().catch(() => {});
    rmSync(dataDirectory, { recursive: true, force: true });
  }
}

async function main() {
  if (process.env[OPT_IN] !== "1") {
    throw new Error(`The recursive live run is opt-in and spends real inference. Set ${OPT_IN}=1.`);
  }
  const requested = singleArgument("--recursion", "both");
  if (!["on", "off", "both"].includes(requested)) {
    throw new Error("--recursion must be on, off, or both");
  }
  const outputDirectory = resolve(singleArgument("--output-dir", ".relayer/live/recursive-complete"));
  const options = {
    harnessConfiguration: singleArgument("--harness", "codex-basic"),
    codexBinary: resolve(requireEnvironment("RELAYER_CODEX_BINARY")),
    providerId: process.env.RELAYER_LIVE_PROVIDER_ID?.trim() || "codex",
    modelId: requireEnvironment("RELAYER_LIVE_MODEL_ID"),
    timeoutMs: Number(singleArgument("--timeout-ms", "900000")),
  };
  mkdirSync(outputDirectory, { recursive: true });

  const runs = {};
  if (requested !== "off") runs.enabled = await runOnce({ ...options, recursionEnabled: true });
  if (requested !== "on") runs.disabled = await runOnce({ ...options, recursionEnabled: false });
  const artifact = {
    task: RECURSIVE_LIVE_RUN_TASK,
    harnessConfiguration: options.harnessConfiguration,
    modelId: options.modelId,
    runs,
    ...(runs.enabled && runs.disabled ? { comparison: compareRuns(runs.enabled, runs.disabled) } : {}),
  };
  writeFileSync(join(outputDirectory, "run.json"), `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(JSON.stringify(artifact, null, 2));
  if (Object.values(runs).some((run) => !run.passed)) process.exitCode = 1;
}

await main();
