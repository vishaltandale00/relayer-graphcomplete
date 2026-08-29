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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  GraphCompleteRuntimeService,
  RECURSIVE_TEMPORAL_FEATURES,
} from "../desktop/main/services/graphcomplete-runtime.mjs";
import { RelayerAppServerService } from "../desktop/main/services/relayer-app-server.mjs";
import { loadHarnessConfigurations } from "@relayer/harness-host";

import {
  RECURSIVE_LIVE_RUN_TASK,
  compareRuns,
  liveRunProfileNames,
  resolveRunProfile,
  summarizeRun,
} from "./recursive-live-run-model.mjs";

const OPT_IN = "RELAYER_RECURSIVE_LIVE_RUN";
const repositoryRoot = resolve(import.meta.dirname, "..");

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
  const implementation = configurations.get(harness)?.implementation;
  if (implementation === undefined) throw new Error(`${configurationPath} does not define harness ${harness}.`);
  return { profile: resolveRunProfile(document, name, { implementation, path }), configurationPath };
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

async function runOnce({ recursionEnabled, profile, configurationPath, timeoutMs }) {
  const dataDirectory = mkdtempSync(join(tmpdir(), "relayer-recursive-live-"));
  const runtime = new GraphCompleteRuntimeService({
    userDataDirectory: dataDirectory,
    graphServerBinary: join(repositoryRoot, "target", "debug", "relayer-graph-server"),
    configurationPaths: [configurationPath],
    ...(profile.codexExecutable === undefined ? {} : { codexPathOverride: profile.codexExecutable }),
    temporalFeatures: recursionEnabled ? RECURSIVE_TEMPORAL_FEATURES : {},
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
  const { profile, configurationPath } = await readProfile(
    resolve(singleArgument("--credentials", "live-run.local.json")),
    singleArgument("--profile", ""),
  );
  const outputDirectory = resolve(
    singleArgument("--output-dir", join(".relayer", "live", "recursive-complete", profile.name)),
  );
  const options = {
    profile,
    configurationPath,
    timeoutMs: Number(singleArgument("--timeout-ms", "900000")),
  };
  mkdirSync(outputDirectory, { recursive: true });

  const runs = {};
  if (requested !== "off") runs.enabled = await runOnce({ ...options, recursionEnabled: true });
  if (requested !== "on") runs.disabled = await runOnce({ ...options, recursionEnabled: false });
  // The artifact records what ran, never how it authenticated.
  const artifact = {
    task: RECURSIVE_LIVE_RUN_TASK,
    profile: profile.name,
    harnessConfiguration: profile.harness,
    implementation: profile.implementation,
    adapterId: profile.adapterId,
    modelId: profile.modelId,
    runs,
    ...(runs.enabled && runs.disabled ? { comparison: compareRuns(runs.enabled, runs.disabled) } : {}),
  };
  writeFileSync(join(outputDirectory, "run.json"), `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(JSON.stringify(artifact, null, 2));
  if (Object.values(runs).some((run) => !run.passed)) process.exitCode = 1;
}

await main();
