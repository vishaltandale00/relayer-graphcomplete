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
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { productionHarnessRuntimeDescriptor } from "../desktop/main/providers/provider-adapter-registry.mjs";
import {
  GraphCompleteRuntimeService,
  RECURSIVE_TEMPORAL_FEATURES,
} from "../desktop/main/services/graphcomplete-runtime.mjs";
import { RelayerAppServerService } from "../desktop/main/services/relayer-app-server.mjs";
import { managedRuntimeRequirementForHarness } from "../desktop/shared/managed-runtime-requirements.mjs";

import {
  codexVersion,
  managedRuntimeResolver,
  preparePrimeEnvironment,
  prepareRoute,
  providerExecution,
  readProfile,
} from "./live-run-setup.mjs";
import {
  liveRunTask,
  compareRuns,
  summarizeRun,
} from "./recursive-live-run-model.mjs";
import {
  completionMetadata,
  productRequest,
  temporalFeatures,
  waitForSettledCompletionExecutionEvidence,
} from "./recursive-live-run-transport.mjs";
import {
  assertExecutionIdentity,
  executionIdentity,
  liveRunProvenance,
  liveRunStatus,
  liveRunTimeoutMs,
  publicProfileDigest,
  writeJsonAtomic,
} from "./recursive-live-run-provenance.mjs";
import { exportTraceEvidence } from "./recursive-live-run-trace.mjs";

const OPT_IN = "RELAYER_RECURSIVE_LIVE_RUN";
const repositoryRoot = resolve(import.meta.dirname, "..");
const IN_PROGRESS_COMPLETION_STATUSES = new Set([
  "not_started", "running", "submitted", "preparing", "draft", "waiting_for_approval",
]);

function singleArgument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
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
  const eventsBySequence = new Map();
  const observations = [];
  const completionIds = new Set();
  const interactionsById = new Map();
  let cursor = 0;
  let pollSequence = 0;
  for (;;) {
    pollSequence += 1;
    const state = await productRequest(session, `/api/state?currentProjectionAfter=${cursor}`);
    const observedAtMs = Date.now();
    const rootAtPoll = (state.interactions ?? []).find((interaction) => interaction.id === rootInteractionId);
    const rootStatusAtPoll = rootAtPoll?.completionStatus ?? "unknown";
    const recordEvents = (projectedEvents, source) => {
      for (const event of projectedEvents) {
        if (eventsBySequence.has(event.sequence)) continue;
        eventsBySequence.set(event.sequence, event);
        observations.push({
          observedAtMs,
          pollSequence,
          source,
          rootStatus: rootStatusAtPoll,
          sequence: event.sequence,
          completionId: event.completionId,
          revision: event.revision,
          lifecycle: event.lifecycle,
          currentLayerId: event.currentLayerId ?? null,
        });
      }
    };
    recordEvents(state.currentProjection?.events ?? [], "live");
    cursor = state.currentProjection?.cursor ?? cursor;
    for (const interaction of state.interactions ?? []) {
      if (interaction.threadId !== threadId || !interaction.graphNodeId) continue;
      interactionsById.set(interaction.id, interaction);
      if (!completionIds.has(interaction.graphNodeId)) {
        completionIds.add(interaction.graphNodeId);
        const backfill = await productRequest(
          session,
          `/api/state?currentProjectionCompletionId=${interaction.graphNodeId}&currentProjectionAfter=0`,
        );
        recordEvents(backfill.currentProjection?.events ?? [], "backfill");
      }
    }
    const root = interactionsById.get(rootInteractionId);
    const status = root?.completionStatus ?? "unknown";
    const allSettled = [...interactionsById.values()].every((interaction) => (
      !IN_PROGRESS_COMPLETION_STATUSES.has(interaction.completionStatus)
    ));
    if (allSettled && status !== "unknown" && !IN_PROGRESS_COMPLETION_STATUSES.has(status)) {
      return {
        startedAtMs,
        settledAtMs: Date.now(),
        completionStatus: status,
        rootCompletionId: root?.graphNodeId ?? null,
        completionIds: [...completionIds],
        interactions: [...interactionsById.values()].map((interaction) => ({
          id: interaction.id,
          graphNodeId: interaction.graphNodeId,
          completionStatus: interaction.completionStatus,
        })),
        events: [...eventsBySequence.values()],
        observations,
      };
    }
    if (Date.now() > deadline) {
      throw new Error(`The live task did not settle within ${timeoutMs}ms (last status ${status}).`);
    }
    await new Promise((wait) => setTimeout(wait, 250));
  }
}

async function runOnce({
  recursionEnabled, task, profile, configurationPath, timeoutMs, outputDirectory, runId, setupOnly = false,
}) {
  const dataDirectory = mkdtempSync(join(tmpdir(), "relayer-recursive-live-"));
  const arm = recursionEnabled ? "enabled" : "disabled";
  const resolver = managedRuntimeResolver();
  const requestedTemporalFeatures = recursionEnabled ? RECURSIVE_TEMPORAL_FEATURES : {};
  const runtime = new GraphCompleteRuntimeService({
    userDataDirectory: dataDirectory,
    graphServerBinary: join(repositoryRoot, "target", "debug", "relayer-graph-server"),
    configurationPaths: [configurationPath],
    ...(profile.codexExecutable === undefined ? {} : { codexPathOverride: profile.codexExecutable }),
    ...(profile.implementation === "prime.agent" ? {
      resolvePrimeRuntime: async () => productionHarnessRuntimeDescriptor(await resolver.get(
        managedRuntimeRequirementForHarness("prime.agent").recipeId,
      )),
    } : {}),
    temporalFeatures: requestedTemporalFeatures,
    candidateTrace: {
      directory: join(dataDirectory, "candidate-trace-spool"),
      policy: {
        mode: "required",
        requiredFeatures: {},
        includeNativeArtifacts: false,
        maxBytesPerTurn: 10 * 1024 * 1024,
        maxEventsPerTurn: 50_000,
      },
    },
    acquireProviderExecution: providerExecution(profile),
  });
  const productServer = new RelayerAppServerService({
    userDataDirectory: dataDirectory,
    binaryPath: join(repositoryRoot, "target", "debug", "relayer-app-server"),
    webDirectory: join(repositoryRoot, "desktop", "renderer"),
    permissionCatalogPath: join(repositoryRoot, "permissions", "desktop.json"),
    runtimeSession: await runtime.start(),
    defaultHarnessConfiguration: profile.harness,
    allowHarnessOverride: true,
  });
  try {
    const actualTemporalFeatures = await temporalFeatures(runtime.session);
    const session = await productServer.start();
    const { providerId, modelId } = profile;
    const family = await prepareRoute({ session, productServer, runtime, resolver, profile });
    if (setupOnly) return null;
    const requestStartedAtMs = Date.now();
    const thread = await productRequest(session, "/api/threads", {
      method: "POST",
      body: JSON.stringify({
        title: "Recursive Complete live run",
        initialMessage: task.text,
        harnessId: profile.harness,
        permissionProfileId: "auto",
        modelSelection: { familyId: family.id, providerId, modelId },
      }),
    });
    const observed = await observeUntilSettled(session, thread.id, thread.rootInteractionId, timeoutMs);
    const metadata = await completionMetadata(runtime.session, observed.completionIds);
    const invokedCompletionIds = metadata
      .filter((completion) => completion.invocation !== null && completion.invocation !== undefined)
      .map((completion) => completion.nodeId);
    const traces = await exportTraceEvidence({
      runtime,
      interactions: observed.interactions,
      directory: join(outputDirectory, "traces", arm),
      refPrefix: `traces/${arm}`,
      correlation: { runId, arm, harnessConfigurationName: profile.harness, model: profile.modelId },
    });
    return summarizeRun({
      recursionEnabled,
      ...observed,
      startedAtMs: requestStartedAtMs,
      requestedTemporalFeatures,
      actualTemporalFeatures,
      expectedAttachmentProvider: profile.implementation === "codex.basic" ? "codex" : undefined,
      verificationLevel: task.verificationLevel,
      expectedChildren: task.expectedChildren,
      completionMetadata: metadata,
      completionExecutions: await waitForSettledCompletionExecutionEvidence(
        join(dataDirectory, "product-data", "product.sqlite3"),
        invokedCompletionIds,
      ),
      traces,
    });
  } finally {
    await productServer.close().catch(() => {});
    await runtime.close().catch(() => {});
    // --keep-data preserves the product and graph databases for diagnosis.
    if (process.argv.includes("--keep-data")) console.error(`Kept live-run data in ${dataDirectory}`);
    else rmSync(dataDirectory, { recursive: true, force: true });
  }
}

async function main() {
  if (process.env[OPT_IN] !== "1") {
    throw new Error(`The recursive live run is opt-in and spends real inference. Set ${OPT_IN}=1.`);
  }
  const requested = singleArgument("--recursion", "both");
  // Proves the provider, harness readiness, and model route, then stops before a
  // thread starts, so it spends no inference.
  const setupOnly = process.argv.includes("--setup-only");
  // `delegate` asks for semantic children; its runs can never claim Check 1.
  const task = liveRunTask(singleArgument("--task", "natural"));
  if (!["on", "off", "both"].includes(requested)) {
    throw new Error("--recursion must be on, off, or both");
  }
  const { profile, configurationPath, harnessConfigurationDigest } = await readProfile(
    resolve(singleArgument("--credentials", "live-run.local.json")),
    singleArgument("--profile", ""),
  );
  if (profile.implementation === "prime.agent") await preparePrimeEnvironment();
  if (setupOnly) {
    await runOnce({
      profile,
      configurationPath,
      timeoutMs: liveRunTimeoutMs(singleArgument("--timeout-ms", "900000")),
      outputDirectory: mkdtempSync(join(tmpdir(), "relayer-recursive-live-setup-")),
      runId: randomUUID(),
      recursionEnabled: requested !== "off",
      setupOnly: true,
    });
    console.log(`Setup verified for ${profile.name}: ${profile.harness} can route ${profile.providerId}/${profile.modelId}.`);
    return;
  }
  const outputRoot = resolve(
    singleArgument("--output-dir", join(
      ".relayer", "live", task.name === "natural" ? "recursive-complete" : `recursive-complete-${task.name}`, profile.name,
    )),
  );
  const runId = randomUUID();
  const outputDirectory = join(outputRoot, runId);
  const options = {
    task,
    profile,
    configurationPath,
    timeoutMs: liveRunTimeoutMs(singleArgument("--timeout-ms", "900000")),
    outputDirectory,
    runId,
  };
  mkdirSync(outputDirectory, { recursive: true });
  // Prime runs from the managed runtime's cached installation, so its installed bytes and
  // receipt are part of what the run executes and are bound like any other executable.
  const primeRuntime = profile.implementation === "prime.agent"
    ? await managedRuntimeResolver().prepare(managedRuntimeRequirementForHarness("prime.agent").recipeId)
    : undefined;
  const graphServerBinary = join(repositoryRoot, "target", "debug", "relayer-graph-server");
  const appServerBinary = join(repositoryRoot, "target", "debug", "relayer-app-server");
  const identityInputs = {
    repositoryRoot,
    executables: {
      node: { path: process.execPath, version: process.version },
      graphServer: { path: graphServerBinary },
      appServer: { path: appServerBinary },
      ...(profile.codexExecutable === undefined ? {} : {
        providerRuntime: { path: profile.codexExecutable, version: codexVersion(profile.codexExecutable) },
      }),
      ...(primeRuntime === undefined ? {} : {
        primeRuntimeReceipt: {
          path: join(dirname(dirname(primeRuntime.installationRoot)), "active.json"),
          version: primeRuntime.version,
        },
      }),
    },
    bundles: {
      ...(primeRuntime === undefined ? {} : { primeRuntime: primeRuntime.installationRoot }),
      rootDist: join(repositoryRoot, "dist"),
      graphClientDist: join(repositoryRoot, "packages", "graph-client", "dist"),
      harnessHostDist: join(repositoryRoot, "packages", "harness-host", "dist"),
    },
  };
  const initialIdentity = executionIdentity(identityInputs);
  const provenance = liveRunProvenance({
    harnessConfigurationDigest,
    temporalFeatureSchemaVersion: 1,
    runId,
    identity: initialIdentity,
  });
  const baseArtifact = {
    ...provenance,
    task: task.text,
    taskName: task.name,
    profile: profile.name,
    profileDigest: publicProfileDigest(profile),
    harnessConfiguration: profile.harness,
    implementation: profile.implementation,
    adapterId: profile.adapterId,
    modelId: profile.modelId,
    requestedRecursion: requested,
    verificationLevel: task.verificationLevel,
  };
  const artifactPath = join(outputDirectory, "run.json");
  const identityCheckpoints = [];
  const verifyIdentity = (checkpoint) => {
    const observed = executionIdentity(identityInputs);
    try {
      assertExecutionIdentity(initialIdentity, observed, checkpoint);
      identityCheckpoints.push({ checkpoint, matched: true });
    } catch (error) {
      identityCheckpoints.push({ checkpoint, matched: false });
      throw error;
    }
  };
  const executeArm = async (arm, recursionEnabled) => {
    verifyIdentity(`before-${arm}`);
    try {
      return await runOnce({ ...options, recursionEnabled });
    } finally {
      verifyIdentity(`after-${arm}`);
    }
  };
  writeJsonAtomic(artifactPath, {
    ...baseArtifact,
    status: liveRunStatus(task.verificationLevel).running,
    identityCheckpoints,
    runs: {},
  });
  const runs = {};
  try {
    if (requested !== "off") runs.enabled = await executeArm("enabled", true);
    if (requested !== "on") runs.disabled = await executeArm("disabled", false);
    const passed = Object.values(runs).every((run) => run.passed);
    const artifact = {
      ...baseArtifact,
      status: passed ? liveRunStatus(task.verificationLevel).passed : liveRunStatus(task.verificationLevel).failed,
      finishedAt: new Date().toISOString(),
      identityCheckpoints,
      runs,
      ...(runs.enabled && runs.disabled ? { comparison: compareRuns(runs.enabled, runs.disabled) } : {}),
    };
    writeJsonAtomic(artifactPath, artifact);
    writeJsonAtomic(join(outputRoot, "latest.json"), {
      schemaVersion: 1,
      verificationLevel: task.verificationLevel,
      runId,
      ref: `${runId}/run.json`,
    });
    console.log(JSON.stringify(artifact, null, 2));
    if (!passed) process.exitCode = 1;
  } catch (error) {
    const artifact = {
      ...baseArtifact,
      status: liveRunStatus(task.verificationLevel).failed,
      finishedAt: new Date().toISOString(),
      identityCheckpoints,
      runs,
      failure: { name: error instanceof Error ? error.name : "Error" },
    };
    writeJsonAtomic(artifactPath, artifact);
    writeJsonAtomic(join(outputRoot, "latest.json"), {
      schemaVersion: 1,
      verificationLevel: task.verificationLevel,
      runId,
      ref: `${runId}/run.json`,
    });
    throw error;
  }
}

await main();
