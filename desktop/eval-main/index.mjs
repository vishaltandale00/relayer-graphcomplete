import { CalibrationService } from "./calibration-service.mjs";
import { SetupRegistry } from "./setup-registry.mjs";
import { createEvalProviderSetup } from "./provider-setup.mjs";
import { createEvalCredentialStore } from "./credential-store.mjs";
import { createManagedRuntimeInstaller } from "../main/managed-runtimes/installer.mjs";
import { managedRuntimeRequirementForHarness } from "../shared/managed-runtime-requirements.mjs";
import { HumanTaskService } from "./human-task-service.mjs";
import { TaskActorService } from "./task-actor-service.mjs";
import { openTaskActorBrowser } from "./task-actor-browser.mjs";
import { homedir } from "node:os";
import { createEvalDashboard, openHumanReview, createHumanTaskSurface, createSettingsSurface } from "./web-host.mjs";
import { createJudgeBrowser, openBrowserReview } from "./browser-review.mjs";
import { createPlaywrightDraftPreviewRenderer } from "./draft-preview-renderer.mjs";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, mkdir, open, unlink } from "node:fs/promises";
import { userInfo } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeBinaryName } from "../shared/target.mjs";

import {
  graphMemoryFixtureFactory,
  graphPreviewFixtureFactory,
  nodeDetailFixtureFactory,
  gradeInputRoundTripSet,
  gradeInputRoundTripControlSet,
  InputOperatorController,
  runInputGroundingJudge,
  taskSystemFixtureFactory,
} from "@relayer/eval-runner";
import { evalHarnessConfigurationPaths, evalRuntimeTarget } from "./configuration-paths.mjs";
import { EvalService } from "./eval-service.mjs";
import { loadExternalEvalCatalog } from "./external-catalog.mjs";
import { loadAtomicAnnotationSnapshots } from "./annotation-snapshot-loader.mjs";
import { loadJudgeScreenshotArtifact } from "./judge-screenshot-loader.mjs";
import { createLiveCredentialValidator, createLiveModelRouteResolver } from "./live-credentials.mjs";
import {
  LOCAL_SIMULATED_USER_JUDGE_CONFIGURATION as LOCAL_INPUT_GROUNDING_JUDGE_CONFIGURATION,
  buildInputGroundingTopology,
  captureGroundingTargets,
  createInputOperatorLease,
  createLocalSimulatedUserJudgeRunner,
  groundingCaptureTargets,
  incompleteInputRoundTripEvidence,
  operatorInteractionIsTerminal,
  parseProductWriteResponse,
  releaseInputOperatorLease,
  resolveLocalSimulatedUserAutorun,
} from "./simulated-user-judge.mjs";
import {
  GraphCompleteRuntimeService,
  RECURSIVE_TEMPORAL_FEATURES,
} from "../main/services/graphcomplete-runtime.mjs";
import { inspectCodexBrowserMcpRuntime } from "../main/services/codex-browser-mcp-runtime.mjs";
import { RelayerAppServerService } from "../main/services/relayer-app-server.mjs";
import { loadEvalPrimeProfile } from "./prime-provider.mjs";

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(desktopDirectory, "..");
const metadata = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
const desktopVersion = metadata.version;
const userDataDirectory = resolve(process.env.RELAYER_EVAL_USER_DATA_DIR || join(homedir(), ".relayer", "eval-web"));
const targetDirectory = resolve(process.env.CARGO_TARGET_DIR || join(repositoryRoot, "target"));
const graphServerBinary = resolve(process.env.RELAYER_GRAPH_SERVER_BIN || join(targetDirectory, "debug", nativeBinaryName("relayer-graph-server")));
const appServerBinary = resolve(process.env.RELAYER_APP_SERVER_BINARY || join(targetDirectory, "debug", nativeBinaryName("relayer-app-server")));
const harnessDirectory = join(repositoryRoot, "harnesses");
const evalTarget = evalRuntimeTarget({ environment: process.env });
const permissionCatalogPath = join(repositoryRoot, "permissions", "desktop.json");
const productRendererDirectory = join(desktopDirectory, "renderer");
const evalRendererDirectory = join(desktopDirectory, "eval-renderer");
const configurationPaths = evalHarnessConfigurationPaths({ harnessDirectory, targetKey: evalTarget.key, currentCommunicationAblation: process.env.RELAYER_EVAL_CURRENT_COMMUNICATION_ABLATION === "1" });
// Only explicitly selected, commit-pinned developer catalogs execute here.
const externalCatalog = process.env.RELAYER_EVAL_CATALOG_ROOT
  ? await loadExternalEvalCatalog({
    repositoryDirectory: resolve(process.env.RELAYER_EVAL_CATALOG_ROOT),
    lock: JSON.parse(await readFile(join(repositoryRoot, "eval-catalog.lock.json"), "utf8")),
  })
  : null;
process.env.PYTHONPATH = [join(repositoryRoot, "python", "relayer-graph", "src"), process.env.PYTHONPATH].filter(Boolean).join(delimiter);
const codexBrowserMcpInspection = await inspectCodexBrowserMcpRuntime({ executable: process.execPath, packageRoot: join(repositoryRoot, "node_modules", "chrome-devtools-mcp") });
let providerSetup;
const primeProfile = await loadEvalPrimeProfile();
const primePythonClientRoot = join(repositoryRoot, "python", "relayer-graph", "src");
process.env.RELAYER_PRIME_PYTHON_CLIENT_ROOT = primePythonClientRoot;
let dashboard;
const reviewSurfaces = new Set();
const judgeBrowser = createJudgeBrowser();
const evalStateFile = join(userDataDirectory, "eval-data", "test-runs.json");
// Validation only: startup checks local bytes, never prepares or probes runtimes.
const runtimeFileValidator = createManagedRuntimeInstaller({ root: join(userDataDirectory, "managed-runtimes") });
const draftPreviewRenderer = createPlaywrightDraftPreviewRenderer({ rendererDirectory: productRendererDirectory });
const graphRuntime = new GraphCompleteRuntimeService({
  userDataDirectory,
  graphServerBinary,
  configurationPaths,
  draftPreviewRenderer,
  retainDraftPreviews: true,
  additionalImplementations: {
    "fixture.task-system": taskSystemFixtureFactory,
    "fixture.node-detail": nodeDetailFixtureFactory,
    "fixture.graph-memory": graphMemoryFixtureFactory,
    "fixture.graph-preview": graphPreviewFixtureFactory,
  },
  ...(codexBrowserMcpInspection.available ? { codexBrowserMcpRuntime: codexBrowserMcpInspection } : {}),
  resolveCodexRuntime: () => providerSetup.resolveCodexRuntime(),
  resolveClaudeRuntime: () => providerSetup.resolveClaudeRuntime(),
  resolvePrimeRuntime: () => providerSetup.resolvePrimeRuntime(),
  acquireProviderExecution: (providerId) => providerSetup.acquireExecution(providerId),
  coordinateHarnessReadiness: ({ implementation }) => ["codex.basic", "claude.basic", "prime.agent"].includes(implementation),
  validateHarnessRuntime: async ({ implementation }) => {
    await runtimeFileValidator.validate(managedRuntimeRequirementForHarness(implementation).recipeId);
    return true;
  },
  // The app server compares the required recipe with the one it last loaded (PROV-009).
  harnessRuntimeRecipe: ({ implementation }) => runtimeFileValidator.recipeIdentity(
    managedRuntimeRequirementForHarness(implementation).recipeId,
  ),
  // Eval keeps the temporal substrate coherent for every matrix cell. The selected
  // harness configuration independently controls whether agent-authored Complete is
  // exposed, so control and treatment can share one production-faithful runtime.
  temporalFeatures: RECURSIVE_TEMPORAL_FEATURES,
  candidateTrace: {
    directory: join(userDataDirectory, "eval-data", "candidate-trace-spool"),
    policy: {
      mode: "required",
      requiredFeatures: {},
      includeNativeArtifacts: false,
      maxBytesPerTurn: 10 * 1024 * 1024,
      maxEventsPerTurn: 50_000,
    },
  },
  onUnexpectedStop: () => shutdown(1),
});
let productServer;
let evalService;
let humanTasks;
let taskActors;
let stopPromise;
let stopping = false;
function requireRunning() { if (stopping) throw new Error("Eval is stopping."); }
function evalIsBusy() {
  return (humanTasks?.list() || []).some((task) => ["active", "preparing", "finishing"].includes(task.status))
    || Boolean(taskActors?.running.size)
    || Boolean(evalService?.running.size)
    || (evalService?.listRuns() || []).some((run) => ["queued", "running"].includes(run.status));
}
let ownsProfileLock = false;
const profileLock = join(userDataDirectory, "eval-web.lock");
let localAutorunStarted = false;

async function createReview(executionId) {
  const pending = openHumanReview({
    executionId,
    reviewContext: (id) => evalService.reviewContext(id),
    productSession: () => productServer.start(),
    assertRunning: requireRunning,
    registerAnnotations: (session, scope) => controlProductRequest(session, "/api/internal/annotation-sessions", {
      method: "POST", body: {
        ...scope,
        authorId: `local:${userInfo().username}`,
        authorDisplayName: String(process.env.RELAYER_EVAL_ANNOTATOR_NAME || userInfo().username).trim(),
      },
    }),
  });
  reviewSurfaces.add(pending);
  pending.catch(() => reviewSurfaces.delete(pending));
  return (await pending).url;
}

async function openAutomatedReviewSession(input) {
  return openBrowserReview({ ...input, productSession: await productServer.start(),
    context: evalService.reviewContext(input.executionId), browser: await judgeBrowser.get() });
}

async function start() {
  await mkdir(userDataDirectory, { recursive: true, mode: 0o700 });
  requireRunning();
  let lock;
  try { lock = await open(profileLock, "wx", 0o600); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error(`Eval profile is locked. Stop its owning process first. After an unclean exit, verify no Eval process uses this profile before removing ${profileLock}.`);
    throw error;
  }
  ownsProfileLock = true;
  if (stopping) { await lock.close(); await unlink(profileLock); ownsProfileLock = false; requireRunning(); }
  try { await lock.writeFile(String(process.pid)); } finally { await lock.close(); }
  requireRunning();
  const runtimeSession = await graphRuntime.start();

  requireRunning();
  productServer = new RelayerAppServerService({
    userDataDirectory,
    binaryPath: appServerBinary,
    webDirectory: productRendererDirectory,
    permissionCatalogPath,
    runtimeSession,
    defaultHarnessConfiguration: "fixture-task-system",
    allowHarnessOverride: true,
    evalMode: true,
    allowConversationImport: true,
    enableReadOnlySession: true,
    exportProducer: {
      desktopVersion,
      buildCommit: "development",
      platform: process.platform,
      architecture: process.arch,
    },
    onUnexpectedStop: () => shutdown(1),
  });
  const productSession = await productServer.start();
  requireRunning();
  providerSetup = createEvalProviderSetup({
    userDataDirectory, productServer, productSession, runtimeSession, graphRuntime,
    appRoot: repositoryRoot, pythonClientRoot: primePythonClientRoot, isBusy: evalIsBusy,
    credentialStore: createEvalCredentialStore({ userDataDirectory }),
    secretsPersisted: process.platform === "darwin",
  });
  try { await providerSetup.start(primeProfile); }
  finally { if (primeProfile) primeProfile.apiKey = undefined; }
  requireRunning();
  const resolveLiveModelRoute = createLiveModelRouteResolver({
    readModelSettings: () => productRequest(productSession, "/api/model-settings"),
    readDefaultModelSelection: (harnessId) => productRequest(productSession,
      `/api/model-selection/default?harnessId=${encodeURIComponent(harnessId)}`),
    ensureCodexModelCatalog: () => providerSetup.settingsOpened(),
    selectPrimeModel: (harnessId) => providerSetup.select(harnessId),
  });
  const simulatedUserJudgeRunner = createLocalSimulatedUserJudgeRunner({
    resolveCodexRuntime: (config) => providerSetup.resolveCodexJudgeRuntime(config),
    loadLayer: ({ threadId, turnId, layerId }) => productRequest(productSession, (
      `/api/threads/${encodeURIComponent(threadId)}`
      + `/interactions/${encodeURIComponent(turnId)}`
      + `/layers/${encodeURIComponent(layerId)}`
    )),
    openReviewSession: openAutomatedReviewSession,
    createInputOperator: (input) => createScopedInputOperator(productSession, input),
    captureInputRoundTrip: (input) => captureInputRoundTripEvidence(productSession, input),
  });
  let calibration;
  const setupRegistry = await new SetupRegistry({ stateFile: join(dirname(evalStateFile), "setup-revisions.json"),
    feedbackLoader: (ref) => { if (calibration?.isHeldOutFeedback(ref)) throw new Error("Held-out labels cannot motivate setup tuning."); return humanTasks.feedbackReference(ref); } }).open();
  evalService = await new EvalService({
    setupRegistry,
    stateFile: evalStateFile,
    productSession,
    configurationPaths,
    externalCatalog,
    simulatedUserJudgeRunner,
    candidateTraceExporter: (productInteractionId, targetDirectory, correlation) => (
      graphRuntime.exportCandidateTrace(productInteractionId, targetDirectory, correlation)
    ),
    candidateTraceAttributionLoader: (productInteractionId) => (
      graphRuntime.candidateTracePersonalPresentationVersionId(productInteractionId)
    ),
    candidateTraceRequired: true,
    selectModel: (harnessId) => providerSetup.select(harnessId),
    selectPrimeModel: (harnessId) => providerSetup.select(harnessId),
    primeModelAvailability: (harnessId) => providerSetup.availability(harnessId),
    validateLiveCredential: async (configuration, credentialReference) => {
      let selectedRoute;
      let lease;
      const validate = createLiveCredentialValidator({
        resolveModelRoute: async (candidate) => {
          selectedRoute = await resolveLiveModelRoute(candidate);
          return selectedRoute;
        },
        resolveCodexRuntime: async () => {
          if (!selectedRoute.selectedModel) return providerSetup.resolveCodexJudgeRuntime();
          lease = await providerSetup.acquireExecution(selectedRoute.provider.id);
          const access = await lease.runtime.executionAccess();
          if (access.kind !== "managed-runtime" || access.runtimeId !== "codex") throw new Error("Selected provider has no Codex execution access.");
          return { ...await providerSetup.resolveCodexRuntime(), environment: access.environment };
        },
      });
      try { return await validate(configuration, credentialReference); }
      finally { await lease?.release(); }
    },
    conversationImportEnabled: true,
    annotationSnapshotLoader: (threadIds) => loadAnnotationSnapshots(productSession, threadIds),
    targetKey: evalTarget.key,

  }).open();
  requireRunning();
  humanTasks = await new HumanTaskService({
    stateFile: join(dirname(evalStateFile), "human-tasks.json"), evalService, productSession, setupRegistry,
    annotator: { id: `local:${userInfo().username}`, displayName: userInfo().username },
    annotationSnapshotLoader: (threadIds) => loadAnnotationSnapshots(productSession, threadIds),
  }).open();
  taskActors = new TaskActorService({ tasks: humanTasks, setupRegistry,
    resolveRuntime: (config, options) => providerSetup.resolveCodexJudgeRuntime(config, options),
    resolveCompletionJudgeRuntime: (config, options) => providerSetup.resolveCodexJudgeRuntime(config, options),
    openBrowser: async (sessionId, signal, observationContract) => openTaskActorBrowser({ tasks: humanTasks, sessionId, productSession, signal, observationContract, diagnosticDirectory: process.env.RELAYER_EVAL_ACTOR_DIAGNOSTICS === "1" ? join(dirname(evalStateFile), "actor-diagnostics", sessionId) : undefined, browser: await judgeBrowser.get() }),
  });
  calibration = await new CalibrationService({ stateFile: join(dirname(evalStateFile), "calibration.json"), setups: setupRegistry,
    tasks: humanTasks, evalService, author: humanTasks.annotator }).open();
  dashboard = await createEvalDashboard({
    service: evalService, rendererDirectory: evalRendererDirectory, humanTasks, taskActors, setupRegistry, calibration,
    openSettings: async () => {
      requireRunning();
      const pending = createSettingsSurface({ productSession, providerSetup, isBusy: evalIsBusy });
      reviewSurfaces.add(pending);
      pending.catch(() => reviewSurfaces.delete(pending));
      return (await pending).url;
    },
    openHumanTask: async (sessionId) => {
      requireRunning();
      if (humanTasks.get(sessionId).mode === "simulated") throw new Error("Open graph review to watch a simulated session.");
      if (humanTasks.get(sessionId).status !== "active") throw new Error("This task has ended. Open its review instead.");
      const pending = createHumanTaskSurface({ tasks: humanTasks, sessionId, productSession, assertRunning: requireRunning,
        registerAnnotations: (session, scope) => controlProductRequest(session, "/api/internal/annotation-sessions", {
          method: "POST", body: { ...scope, authorId: `local:${userInfo().username}`, authorDisplayName: userInfo().username },
        }),
      });
      reviewSurfaces.add(pending);
      return (await pending).url;
    },
    reviewHumanTask: async (sessionId) => {
      const task = humanTasks.get(sessionId);
      if (task.status === "active" && task.mode !== "simulated") throw new Error("Finish the task before reviewing it.");
      const pending = openHumanReview({
        executionId: sessionId, assertRunning: requireRunning, productSession: async () => productSession,
        humanGrading: {
          task: () => humanTasks.get(sessionId),
          grade: (input) => humanTasks.grade(sessionId, input),
          annotate: (input) => humanTasks.annotate(sessionId, input),
        },
        reviewContext: () => { const task = humanTasks.get(sessionId); return { readOnly: true, selectedExecutionId: sessionId, harnessConfigurationName: task.prepared.execution.harnessConfigurationName, cases: [{ executionId: sessionId, name: task.prepared.name, status: task.status, threadIds: task.threadIds, threads: task.threadIds.map((id, index) => ({ id, name: task.prepared.plan[index]?.name || `Step ${index + 1}` })) }] }; },
        registerAnnotations: (session, scope) => controlProductRequest(session, "/api/internal/annotation-sessions", {
          method: "POST", body: { ...scope, authorId: `local:${userInfo().username}`, authorDisplayName: userInfo().username },
        }),
      });
      reviewSurfaces.add(pending);
      return (await pending).url;
    },
    refreshCatalog: () => providerSetup.refreshAvailability(), openReview: createReview,
    loadScreenshot: (input) => loadJudgeScreenshotArtifact({ ...input, stateFile: evalStateFile }),
  });
  if (stopping) { await dashboard.close(); requireRunning(); }
  console.log(`Relayer Eval: ${dashboard.url}\nKeep this terminal open. Ctrl-C stops Eval; closing a tab does not.`);
  const localAutorun = resolveLocalSimulatedUserAutorun({
    availableHarnessConfigurationNames: evalService.catalog().harnessConfigurations
      .map((configuration) => configuration.name),
  });
  if (localAutorun && !localAutorunStarted) {
    localAutorunStarted = true;
    await evalService.createRun(localAutorun);
  }
}

async function productRequest(session, path) {
  const cookie = session.readOnlyCookie;
  if (!cookie) throw new Error("Relayer Eval read-only product session is unavailable.");
  const response = await fetch(new URL(path, session.origin), {
    headers: {
      Accept: "application/json",
      Cookie: `${cookie.name}=${cookie.value}`,
    },
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value?.error || `Product request failed (${response.status}).`);
  return value;
}

async function createScopedInputOperator(session, { context, inputBindings }) {
  const occurrences = [...new Map([...inputBindings.values()].map((binding) => [
    JSON.stringify(binding.occurrence),
    binding.occurrence,
  ])).values()];
  if (occurrences.length === 0) return undefined;
  const authorityId = `eval-input-operator:${context.execution.id}:${context.turn.id}`;
  const token = randomBytes(32).toString("hex");
  const operator = new InputOperatorController({
    authority: {
      kind: "scoped_product_write",
      threadId: context.thread.id,
      authorityId,
    },
    transport: {
      request: (path, request) => operatorProductRequest(session, token, path, request),
    },
  });
  const lease = createInputOperatorLease({
    operator,
    revoke: () => controlProductRequest(session, "/api/internal/input-operator-sessions", {
      method: "DELETE",
      body: { token },
    }),
  });
  try {
    await controlProductRequest(session, "/api/internal/input-operator-sessions", {
      method: "POST",
      body: {
        token,
        threadId: Number(context.thread.id),
        occurrences,
      },
    });
  } catch (registrationError) {
    try {
      await releaseInputOperatorLease(lease);
    } catch (revocationError) {
      throw new AggregateError(
        [registrationError, revocationError],
        "Input operator session registration failed and its credential could not be revoked.",
      );
    }
    throw registrationError;
  }
  return lease;
}

async function controlProductRequest(session, path, request) {
  const cookie = session.cookie;
  if (!cookie) throw new Error("Relayer Eval product control authority is unavailable.");
  return productWriteRequest(session, path, request, `${cookie.name}=${cookie.value}`, { requireJson: false });
}

async function operatorProductRequest(session, token, path, request) {
  const cookie = session.readOnlyCookie;
  if (!cookie) throw new Error("Relayer Eval read-only input operator authority is unavailable.");
  return productWriteRequest(
    session,
    path,
    request,
    `${cookie.name}=${cookie.value}; relayer_input_operator=${token}`,
    {
      requireJson: true,
      requirePositiveInteractionId: request.method === "POST" && path.endsWith("/interactions"),
    },
  );
}

async function productWriteRequest(session, path, request, cookieHeader, responseOptions) {
  const response = await fetch(new URL(path, session.origin), {
    method: request.method,
    headers: {
      Accept: "application/json",
      Cookie: cookieHeader,
      ...(request.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
  });
  return parseProductWriteResponse(response, responseOptions);
}

async function captureInputRoundTripEvidence(session, { context, topology, operatorTrace, artifactDirectory }) {
  const commits = operatorTrace.filter((event) => event.operation === "input_commit");
  const incompleteEvidence = incompleteInputRoundTripEvidence(operatorTrace);
  if (incompleteEvidence) return incompleteEvidence;
  const send = operatorTrace.findLast((event) => event.operation === "send");
  const interactionId = Number(send.response?.id);
  if (!Number.isSafeInteger(interactionId) || interactionId < 1) {
    throw new Error("Input operator Send returned no product interaction identity.");
  }
  const interaction = await waitForOperatorInteraction(session, context.thread.id, interactionId);
  const traceDirectory = join(artifactDirectory, "candidate-trace");
  const descriptor = await graphRuntime.exportCandidateTrace(interactionId, traceDirectory, {
    runId: context.execution.testRunId,
    executionId: context.execution.id,
    interactionId: String(interactionId),
    harnessConfigurationName: context.execution.harnessConfigurationName,
  });
  const traceEvents = (await readFile(join(traceDirectory, "events.jsonl"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const childrenResponse = await productRequest(
    session,
    `/api/threads/${encodeURIComponent(context.thread.id)}`
      + `/interactions/${encodeURIComponent(interactionId)}/input-children`,
  );
  const authoredInputs = topology.layers.flatMap((layer) => layer.actions
    .filter((action) => action.kind === "input")
    .map((action) => ({
      presentingInteractionNodeId: Number(action.occurrence?.presentingInteractionNodeId),
      presentingLayerId: Number(layer.id),
      sourceNodeId: Number(action.sourceNodeId),
      actionId: Number(action.id),
      control: action.control,
      prompt: action.prompt,
      options: action.options ?? [],
      ...(action.minimumSelections === undefined ? {} : { minimumSelections: action.minimumSelections }),
    })));
  const controlSet = gradeInputRoundTripControlSet(authoredInputs, commits.map((commit) => ({
    presentingInteractionNodeId: Number(commit.occurrence.presentingInteractionNodeId),
    presentingLayerId: Number(commit.occurrence.presentingLayerId),
    sourceNodeId: Number(commit.sourceNodeId),
    actionId: Number(commit.occurrence.actionId),
    control: commit.action.control,
    prompt: commit.action.prompt,
    options: commit.action.options ?? [],
    ...(commit.action.minimumSelections === undefined ? {} : { minimumSelections: commit.action.minimumSelections }),
  })));
  const authoredAccepted = commits.every((commit) => topology.layers.some((layer) => layer.actions.some((action) => (
      action.kind === "input"
      && String(action.id) === String(commit.occurrence.actionId)
      && String(layer.id) === String(commit.occurrence.presentingLayerId)
      && action.occurrence?.presentingInteractionNodeId === commit.occurrence.presentingInteractionNodeId
    ))));
  const roundTripSet = gradeInputRoundTripSet(commits.map((commit) => ({
      occurrence: commit.occurrence,
      sourceNodeId: commit.sourceNodeId,
      action: commit.action,
      value: commit.value,
    })), {
    authoredAccepted,
    interaction: {
      id: interaction.id,
      graphNodeId: interaction.graphNodeId,
      submittedInputs: interaction.submittedInputs ?? [],
    },
    inputChildren: childrenResponse.children ?? [],
    harnessTraceEvents: traceEvents,
  });
  const structuralPassed = controlSet.passed && roundTripSet.passed;
  const groundingRating = structuralPassed
    ? await captureInputGroundingRating({ session, context, interaction, commits, artifactDirectory })
    : null;
  const groundingPassed = groundingRating?.status === "completed"
    && groundingRating.verdict === "grounded";
  const groundingCheck = {
    name: "input-roundtrip:visible-follow-up-use",
    passed: groundingPassed,
    detail: groundingPassed
      ? "The rendered follow-up visibly uses every submitted matrix value."
      : "The rendered follow-up does not visibly use every submitted matrix value.",
  };
  return {
    schemaVersion: 1,
    status: interaction.completionStatus,
    interactionId,
    candidateTrace: descriptor,
    operatorTrace,
    passed: structuralPassed && groundingPassed,
    checks: [...controlSet.checks, ...roundTripSet.checks, groundingCheck],
    ...(groundingRating === null ? {} : { groundingRating }),
  };
}

async function captureInputGroundingRating({ session, context, interaction, commits, artifactDirectory }) {
  const rootLayerId = interaction.completionOutput?.rootLayer?.layer?.id;
  if (!rootLayerId) {
    return { schemaVersion: 1, status: "indeterminate", error: "Accepted input response has no visible root layer." };
  }
  let opened;
  try {
    const topology = await buildInputGroundingTopology({
      threadId: context.thread.id,
      interaction,
      loadLayer: ({ threadId, turnId, layerId }) => productRequest(session, (
        `/api/threads/${encodeURIComponent(threadId)}`
        + `/interactions/${encodeURIComponent(turnId)}`
        + `/layers/${encodeURIComponent(layerId)}`
      )),
    });
    const screenshotDirectory = join(artifactDirectory, "grounding-screenshot");
    opened = await openAutomatedReviewSession({
      executionId: context.execution.id,
      threadId: context.thread.id,
      turnId: interaction.id,
      rootLayerId,
      artifactDirectory: screenshotDirectory,
    });
    const targets = groundingCaptureTargets(topology);
    const captures = await captureGroundingTargets(opened.session, targets);
    if (captures.length === 0) {
      captures.push(await opened.session.screenshot({
        target: { kind: "viewport" },
        mode: "visible",
        label: "Input round-trip response",
      }));
    }
    if (captures.some((capture) => !capture?.ok || !capture.screenshot?.screenshotId)) {
      throw new Error("Production review workspace did not capture every input response root.");
    }
    const screenshots = captures.map(({ screenshot }) => screenshot);
    if (new Set(screenshots.map(({ threadRevision }) => threadRevision)).size !== 1) {
      throw new Error("Input grounding captures do not share one stable response revision.");
    }
    const groundingImages = screenshots.flatMap((screenshot) => {
      const directory = opened.session.artifactDirectoryFor(screenshot.screenshotId);
      if (!directory) throw new Error("Input grounding screenshot artifact directory is missing.");
      return [...screenshot.tiles]
        .sort((left, right) => left.index - right.index)
        .map((tile) => ({
          screenshotId: screenshot.screenshotId,
          path: join(
            directory,
            `${screenshot.screenshotId}-${String(tile.index + 1).padStart(3, "0")}.png`,
          ),
        }));
    });
    const imagePaths = groundingImages.map(({ path }) => path);
    const runtime = await providerSetup.resolveCodexJudgeRuntime();
    return await runInputGroundingJudge({
      submittedInput: commits.length === 1
        ? commits[0].value
        : { values: commits.map((commit) => commit.value) },
      screenshot: {
        screenshotId: screenshots.map(({ screenshotId }) => screenshotId).join("+"),
        threadRevision: screenshots[0].threadRevision,
        imagePaths,
        imageRefs: groundingImages.map(({ path, screenshotId }) => [
          "input-roundtrip",
          "grounding-screenshot",
          screenshotId,
          path.split(/[\\/]/).at(-1),
        ].join("/")),
      },
      codexPathOverride: runtime.executable,
      environment: runtime.environment,
      workingDirectory: context.artifact?.workingDirectory || context.artifactDirectory,
      model: LOCAL_INPUT_GROUNDING_JUDGE_CONFIGURATION.model,
      modelReasoningEffort: LOCAL_INPUT_GROUNDING_JUDGE_CONFIGURATION.modelReasoningEffort,
    });
  } catch (error) {
    return {
      schemaVersion: 1,
      status: "indeterminate",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (opened) await opened.release({ close: true });
  }
}

async function waitForOperatorInteraction(session, threadId, interactionId) {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const detail = await productRequest(session, `/api/threads/${encodeURIComponent(threadId)}`);
    const interaction = detail.interactions?.find((candidate) => Number(candidate.id) === interactionId);
    if (!interaction) throw new Error(`Input operator interaction ${interactionId} disappeared.`);
    if (operatorInteractionIsTerminal(interaction.completionStatus)) return interaction;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for input operator interaction ${interactionId}.`);
}

async function loadAnnotationSnapshots(session, threadIds) {
  const token = randomBytes(32).toString("hex");
  const username = userInfo().username;
  return loadAtomicAnnotationSnapshots({
    session,
    threadIds,
    token,
    authorId: `local:${username}`,
    authorDisplayName: String(process.env.RELAYER_EVAL_ANNOTATOR_NAME || username).trim(),
  });
}

function stop() {
  stopPromise ??= (async () => {
    const errors = [];
    const attempt = async (operation) => { try { await operation(); } catch (error) { errors.push(error); } };
    await attempt(() => dashboard?.close());
    await attempt(() => taskActors?.close());
    await attempt(() => productServer?.close());
    for (const pending of reviewSurfaces) {
      const surface = await pending.catch(() => null);
      if (surface) await attempt(() => surface.close());
    }
    await attempt(() => judgeBrowser.close());
    await attempt(() => graphRuntime.close());
    await attempt(() => draftPreviewRenderer.close());
    await attempt(() => providerSetup?.close());
    if (ownsProfileLock) await attempt(() => unlink(profileLock));
    if (errors.length) throw new AggregateError(errors, "Relayer Eval services did not stop cleanly.");
  })();
  return stopPromise;
}
async function shutdown(code = 0) {
  stopping = true;
  try { await stop(); } catch (error) { console.error(error); code = 1; }
  process.exit(code);
}
process.once("SIGINT", () => shutdown());
process.once("SIGTERM", () => shutdown());
const startup = start();
startup.catch(async (error) => { if (!stopping) { console.error("Relayer Eval startup failed:", error); await shutdown(1); } });
