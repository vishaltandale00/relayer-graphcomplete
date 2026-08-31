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
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  GraphCompleteRuntimeService,
  RECURSIVE_TEMPORAL_FEATURES,
} from "../desktop/main/services/graphcomplete-runtime.mjs";
import { RelayerAppServerService } from "../desktop/main/services/relayer-app-server.mjs";
import { digestHarnessConfiguration, loadHarnessConfigurations } from "@relayer/harness-host";

import {
  RECURSIVE_LIVE_RUN_TASK,
  compareRuns,
  liveRunProfileNames,
  resolveRunProfile,
  summarizeRun,
} from "./recursive-live-run-model.mjs";
import {
  completionMetadata,
  productRequest,
  temporalFeatures,
  waitForSettledCompletionExecutionEvidence,
} from "./recursive-live-run-transport.mjs";
import {
  CHECK1_STATUS,
  CHECK1_VERIFICATION_LEVEL,
  assertExecutionIdentity,
  executionIdentity,
  liveRunProvenance,
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

/** Reads one named run profile, validated against the harness it selects. */
async function readProfile(path, name) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`The live run needs ${path}. Copy live-run.example.json to it and fill it in.`);
  }
  const document = JSON.parse(raw);
  if (!name) {
    const known = liveRunProfileNames(document);
    throw new Error(`Select a run profile with --profile. ${path} defines: ${known.join(", ") || "none"}.`);
  }
  const harness = String(document?.runs?.[name]?.harness ?? "").trim();
  if (!harness) throw new Error(`${path} run ${name} needs harness.`);
  const configurationPath = join(repositoryRoot, "harnesses", `${harness}.yaml`);
  const configurations = await loadHarnessConfigurations([configurationPath]);
  const configuration = configurations.get(harness);
  const implementation = configuration?.implementation;
  if (implementation === undefined) throw new Error(`${configurationPath} does not define harness ${harness}.`);
  return {
    profile: resolveRunProfile(document, name, { implementation, path }),
    configurationPath,
    harnessConfigurationDigest: digestHarnessConfiguration(configuration),
  };
}

/** Reads the provenance of the exact executable this run will spend money through. */
function codexVersion(executable) {
  try {
    return execFileSync(executable, ["--version"], { encoding: "utf8" }).trim();
  } catch (error) {
    throw new Error(`Could not read a version from ${executable}: ${error?.message ?? error}`);
  }
}

/**
 * Leases one real provider execution, over the two contracts the desktop supports.
 *
 * A subscription resolves to the managed runtime environment that isolates the provider
 * login. A key resolves to the secret contract. Only a Codex harness carries a runtime
 * descriptor: Prime reaches its provider directly and needs exactly the key field.
 */
function providerExecution(profile) {
  const secret = profile.contract === "secret@1";
  const runtime = profile.codexExecutable === undefined
    ? undefined
    : {
      runtimeId: "codex",
      version: codexVersion(profile.codexExecutable),
      executable: profile.codexExecutable,
      environment: {
        CODEX_HOME: profile.codexHome,
        RELAYER_CODEX_BINARY: profile.codexExecutable,
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
      },
    };
  const definition = {
    id: profile.providerId,
    adapterId: profile.adapterId,
    accessContract: profile.contract,
    ...(secret ? { endpoint: profile.endpoint } : {}),
  };
  return async () => ({
    definition,
    descriptor: {
      adapterId: definition.adapterId,
      accessContract: definition.accessContract,
      implementationVersion: "1",
    },
    runtime: {
      async executionAccess() {
        if (!secret) return { kind: "managed-runtime", ...runtime };
        return {
          kind: "secret",
          endpoint: profile.endpoint,
          fields: { "api-key": profile.apiKey },
          ...(runtime === undefined ? {} : { runtime }),
        };
      },
    },
    async release() {},
  });
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

async function runOnce({ recursionEnabled, profile, configurationPath, timeoutMs, outputDirectory, runId }) {
  const dataDirectory = mkdtempSync(join(tmpdir(), "relayer-recursive-live-"));
  const arm = recursionEnabled ? "enabled" : "disabled";
  const requestedTemporalFeatures = recursionEnabled ? RECURSIVE_TEMPORAL_FEATURES : {};
  const runtime = new GraphCompleteRuntimeService({
    userDataDirectory: dataDirectory,
    graphServerBinary: join(repositoryRoot, "target", "debug", "relayer-graph-server"),
    configurationPaths: [configurationPath],
    ...(profile.codexExecutable === undefined ? {} : { codexPathOverride: profile.codexExecutable }),
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
    const family = await productRequest(session, "/api/model-families", {
      method: "POST",
      body: JSON.stringify({
        name: "Live run models",
        enabled: true,
        members: [{ providerId, modelId }],
      }),
    });
    const requestStartedAtMs = Date.now();
    const thread = await productRequest(session, "/api/threads", {
      method: "POST",
      body: JSON.stringify({
        title: "Recursive Complete live run",
        initialMessage: RECURSIVE_LIVE_RUN_TASK,
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
  const { profile, configurationPath, harnessConfigurationDigest } = await readProfile(
    resolve(singleArgument("--credentials", "live-run.local.json")),
    singleArgument("--profile", ""),
  );
  const outputRoot = resolve(
    singleArgument("--output-dir", join(".relayer", "live", "recursive-complete", profile.name)),
  );
  const runId = randomUUID();
  const outputDirectory = join(outputRoot, runId);
  const options = {
    profile,
    configurationPath,
    timeoutMs: liveRunTimeoutMs(singleArgument("--timeout-ms", "900000")),
    outputDirectory,
    runId,
  };
  mkdirSync(outputDirectory, { recursive: true });
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
    },
    bundles: {
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
    task: RECURSIVE_LIVE_RUN_TASK,
    profile: profile.name,
    profileDigest: publicProfileDigest(profile),
    harnessConfiguration: profile.harness,
    implementation: profile.implementation,
    adapterId: profile.adapterId,
    modelId: profile.modelId,
    requestedRecursion: requested,
    verificationLevel: CHECK1_VERIFICATION_LEVEL,
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
    status: CHECK1_STATUS.running,
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
      status: passed ? CHECK1_STATUS.passed : CHECK1_STATUS.failed,
      finishedAt: new Date().toISOString(),
      identityCheckpoints,
      runs,
      ...(runs.enabled && runs.disabled ? { comparison: compareRuns(runs.enabled, runs.disabled) } : {}),
    };
    writeJsonAtomic(artifactPath, artifact);
    writeJsonAtomic(join(outputRoot, "latest.json"), {
      schemaVersion: 1,
      verificationLevel: CHECK1_VERIFICATION_LEVEL,
      runId,
      ref: `${runId}/run.json`,
    });
    console.log(JSON.stringify(artifact, null, 2));
    if (!passed) process.exitCode = 1;
  } catch (error) {
    const artifact = {
      ...baseArtifact,
      status: CHECK1_STATUS.failed,
      finishedAt: new Date().toISOString(),
      identityCheckpoints,
      runs,
      failure: { name: error instanceof Error ? error.name : "Error" },
    };
    writeJsonAtomic(artifactPath, artifact);
    writeJsonAtomic(join(outputRoot, "latest.json"), {
      schemaVersion: 1,
      verificationLevel: CHECK1_VERIFICATION_LEVEL,
      runId,
      ref: `${runId}/run.json`,
    });
    throw error;
  }
}

await main();
