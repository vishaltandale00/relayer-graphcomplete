import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, resolve, extname, sep } from "node:path";
import { tmpdir, homedir } from "node:os";
import { createSettingsStore } from "../main/services/settings-store.mjs";
import { validWorkspaceRatio } from "../renderer/src/product-workspace/workspace-layout.js";

const reviewPresentationSettings = createSettingsStore(resolve(process.env.RELAYER_EVAL_USER_DATA_DIR || join(homedir(), ".relayer", "eval-web")));

const bridge = new URL("../eval-renderer/web-bridge.js", import.meta.url);
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
const detailAssetPath = /^\/api\/threads\/([1-9][0-9]*)\/interactions\/[1-9][0-9]*\/nodes\/[1-9][0-9]*\/detail-assets\/[^/]+$/;
const fail = (status, message) => Object.assign(new Error(message), { status });

async function body(request, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw fail(413, "Request is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function json(response, value) {
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(value ?? null));
}
async function asset(response, directory, pathname) {
  const path = resolve(directory, `.${decodeURIComponent(pathname === "/" ? "/index.html" : pathname)}`);
  if (!path.startsWith(`${resolve(directory)}${sep}`)) throw fail(404, "Not found.");
  let bytes;
  try { bytes = await readFile(path); } catch { throw fail(404, "Not found."); }
  if (extname(path) === ".html") bytes = Buffer.from(bytes.toString().replace("<head>", '<head><script src="/eval-bridge.js"></script>'));
  response.setHeader("Content-Type", types[extname(path)] || "application/octet-stream");
  response.end(bytes);
}

// A capability belongs to one origin. Rust credentials never enter the browser.
export async function serveEvalSurface(handle) {
  const token = randomBytes(32).toString("hex");
  let origin;
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self' blob:; frame-ancestors 'none'");
    try {
      if (request.headers.host !== new URL(origin).host) throw fail(403, "Unexpected host.");
      if (request.headers.origin && request.headers.origin !== origin) throw fail(403, "Unexpected origin.");
      if (request.headers["sec-fetch-site"] === "cross-site") throw fail(403, "Cross-site request rejected.");
      const url = new URL(request.url, origin);
      // Only the final opaque asset identifier may contain encoded characters.
      // Keep it encoded when forwarding: decoding a slash would change the route.
      if (url.pathname.includes("//") || (url.pathname.includes("%") && !detailAssetPath.test(url.pathname))) throw fail(400, "Invalid path.");
      if (detailAssetPath.test(url.pathname)) decodeURIComponent(url.pathname.split("/").at(-1));
      if (url.origin !== origin) throw fail(403, "Unexpected origin.");
      if (url.pathname === "/eval-bridge.js" && request.method === "GET") {
        response.setHeader("Content-Type", "text/javascript");
        response.end(await readFile(bridge));
        return;
      }
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/eval-api/")) {
        if (request.headers.authorization !== `Bearer ${token}`) throw fail(401, "Open the authenticated URL printed by Eval.");
      } else if (request.method !== "GET") throw fail(405, "Method not allowed.");
      await handle({ request, response, url });
    } catch (error) {
      response.statusCode = error.status || 400;
      json(response, { error: error.message });
    }
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    url: `${origin}/#${token}`,
    close: () => new Promise((resolvePromise, reject) => {
      server.close((error) => error ? reject(error) : resolvePromise());
      server.closeAllConnections();
    }),
  };
}

async function workspaceLayoutPreference(request, response, presentationSettings) {
  if (request.method === "GET") {
    const ratio = (await presentationSettings.read()).workspaceSplitRatio;
    return json(response, validWorkspaceRatio(ratio) ? ratio : 0.5);
  }
  if (request.method === "POST") {
    const ratio = JSON.parse((await body(request, 64)).toString());
    if (!validWorkspaceRatio(ratio)) throw fail(400, "Invalid workspace split ratio.");
    await presentationSettings.update((current) => ({ ...current, workspaceSplitRatio: ratio }));
    return json(response, ratio);
  }
  throw fail(405, "Method not allowed.");
}

export async function createReviewSurface({ productSession, context, annotationToken, humanGrading, refreshContext, fetchImpl = fetch, presentationSettings = reviewPresentationSettings }) {
  if (!productSession.readOnlyCookie) throw new Error("Review requires read-only authority.");
  const cookie = productSession.readOnlyCookie;
  let allowedThreads = new Set(context.cases.flatMap((item) => item.threadIds).map(String));
  let refreshTail = Promise.resolve();
  let allowedProjects = new Set();
  return serveEvalSurface(async ({ request, response, url }) => {
    if (refreshContext && (url.pathname.startsWith("/api/") || url.pathname.startsWith("/eval-api/"))) {
      refreshTail = refreshTail.catch(() => {}).then(async () => {
        context = await refreshContext();
        allowedThreads = new Set(context.cases.flatMap(item => item.threadIds).map(String));
      });
      await refreshTail;
    }
    if (url.pathname === "/eval-api/workspace-layout") return workspaceLayoutPreference(request, response, presentationSettings);
    if (url.pathname === "/eval-api/context" && request.method === "GET") return json(response, context);
    if (humanGrading && url.pathname === "/eval-api/task" && request.method === "GET") return json(response, { ...humanGrading.task(), workspaceGrading: 2 });
    if (humanGrading && url.pathname === "/eval-api/grade" && request.method === "POST") return json(response, await humanGrading.grade(JSON.parse((await body(request)).toString())));
    if (humanGrading && url.pathname === "/eval-api/annotate" && request.method === "POST") return json(response, await humanGrading.annotate(JSON.parse((await body(request)).toString())));
    if (url.pathname.startsWith("/eval-api/")) throw fail(404, "Not found.");
    const isApi = url.pathname.startsWith("/api/");
    const annotation = /^\/api\/threads\/([1-9][0-9]*)\/annotations(?:\/[^/]+\/(?:revisions|retract))?$/.exec(url.pathname);
    if (request.method !== "GET" && !(request.method === "POST" && annotationToken && annotation && allowedThreads.has(annotation[1]))) {
      throw fail(403, "Review does not permit product writes.");
    }
    const stateRead = url.pathname === "/api/state";
    const stateThread = url.searchParams.get("threadId");
    if (request.method === "GET" && isApi) {
      const threadRead = /^\/api\/threads\/([1-9][0-9]*)(?:\/annotations|\/interactions\/[1-9][0-9]*\/(?:layers\/[1-9][0-9]*|actions\/[^/%]+\/destination))?$/.exec(url.pathname) || detailAssetPath.exec(url.pathname);
      const environment = /^\/api\/projects\/([1-9][0-9]*)\/environment$/.exec(url.pathname);
      const bootstrap = ["/api/model-settings", "/api/permission-profiles"].includes(url.pathname);
      const permitted = stateRead
        ? url.searchParams.getAll("threadId").length === 1 && allowedThreads.has(stateThread)
        : threadRead ? allowedThreads.has(threadRead[1])
          : environment ? allowedProjects.has(environment[1]) : bootstrap;
      if (!permitted) throw fail(403, "Read is outside this review session.");
    }
    const upstream = await fetchImpl(new URL(`${url.pathname}${url.search}`, productSession.origin), {
      method: request.method,
      redirect: "error",
      headers: {
        Cookie: `${cookie.name}=${cookie.value}${annotationToken ? `; relayer_annotation=${annotationToken}` : ""}`,
        ...(request.method === "POST" ? { "Content-Type": "application/json" } : {}),
      },
      ...(request.method === "POST" ? { body: await body(request) } : {}),
    });
    response.statusCode = upstream.status;
    response.setHeader("Content-Type", upstream.headers.get("content-type") || "application/octet-stream");
    let bytes = Buffer.from(await upstream.arrayBuffer());
    if (upstream.ok && stateRead) {
      const state = JSON.parse(bytes.toString());
      // Rust falls back to another thread when a requested thread has disappeared.
      // Never return that fallback's interaction/projection payload.
      if (!state.threads.some((thread) => String(thread.id) === stateThread && thread.active)) {
        throw fail(404, "The selected review thread is unavailable.");
      }
      state.threads = state.threads.filter((thread) => allowedThreads.has(String(thread.id)));
      allowedProjects = new Set(state.threads.map((thread) => String(thread.projectId)));
      state.projects = state.projects.filter((project) => allowedProjects.has(String(project.id)));
      bytes = Buffer.from(JSON.stringify(state));
    }
    if (upstream.ok && url.pathname.endsWith("/destination")) {
      const destination = JSON.parse(bytes.toString());
      if (!allowedThreads.has(String(destination.threadId))) throw fail(403, "Destination is outside this review session.");
    }
    if (!isApi && upstream.headers.get("content-type")?.includes("text/html")) {
      bytes = Buffer.from(bytes.toString().replace("<head>", '<head><script src="/eval-bridge.js"></script>'));
    }
    response.end(bytes);
  });
}

export async function createEvalDashboard({ service, rendererDirectory, refreshCatalog, openReview, loadScreenshot, humanTasks, taskActors, setupRegistry, calibration, openHumanTask, reviewHumanTask, openSettings }) {
  const operations = {
    calibrationCatalog: () => calibration.catalog(),
    freezeCalibrationSet: ([input]) => calibration.freeze(input),
    compareSetupRevisions: ([input]) => calibration.compare(input),
    recordCalibrationObservation: ([input]) => calibration.observe(input),
    calibrationReport: ([id]) => calibration.report(id),
    exportCalibration: () => calibration.export(),
    calibrationSource: ([ref]) => calibration.source(ref),
    setupRevisions: () => setupRegistry.catalog(),
    publishSetup: ([input]) => input?.configFile ? setupRegistry.publishConfig(input) : input?.kind === "judge" ? Promise.reject(Object.assign(new Error("Select a judge config file."), { status: 400 })) : setupRegistry.publish(input),
    promoteSetup: ([input]) => setupRegistry.promote(input, humanTasks.annotator),
    openSettings: () => openSettings(),
    humanTasks: () => humanTasks.list(),
    humanTask: ([id]) => humanTasks.get(id),
    actorScreenshot: ([id, eventId]) => humanTasks.actorScreenshot(id, eventId),
    createHumanTask: ([selection]) => {
      if (selection?.calibrationRef) selection = { ...calibration.actorSelection(selection.calibrationRef), startupId: selection.startupId, liveAuthorization: selection.liveAuthorization };
      else if (selection?.calibrationCandidate) throw fail(400, "Choose a frozen calibration comparison.");
      return selection?.mode === "simulated" ? taskActors.create(selection) : humanTasks.create(selection);
    },
    stopTaskActor: ([id]) => taskActors.stop(id),
    nextHumanTaskStep: ([id]) => humanTasks.nextStep(id),
    finishHumanTask: ([id, input]) => humanTasks.finish(id, input),
    gradeHumanTask: ([id, input]) => humanTasks.grade(id, input),
    annotateHumanTask: ([id, input]) => humanTasks.annotate(id, input),
    exportHumanTask: ([id]) => humanTasks.export(id),
    openHumanTask: ([id]) => openHumanTask(id),
    reviewHumanTask: ([id]) => reviewHumanTask(id),
    catalog: async () => { await refreshCatalog?.(); return service.catalog(); },
    listRuns: () => service.listRuns(),
    getRun: ([id]) => service.getRun(id),
    createRun: ([selection]) => service.createRun(selection),
    judgeImportedConversation: ([id, judge, revision]) => service.judgeImportedConversation(id, judge, revision),
    rejudgeExecution: ([id, judge, authorization, revision]) => service.rejudgeExecution(id, judge, authorization, revision),
    openReview: ([id]) => openReview(id),
    exportAnnotations: ([id]) => service.exportAnnotatedExecution(id),
    loadCandidateTrace: ([id, turn]) => service.candidateTraceContext(id, turn),
    loadJudgeScreenshot: ([input]) => loadScreenshot(input),
  };
  return serveEvalSurface(async ({ request, response, url }) => {
    if (url.pathname === "/eval-api/import" && request.method === "POST") {
      const directory = await mkdtemp(join(tmpdir(), "relayer-eval-import-"));
      try {
        const path = join(directory, "conversation.jsonl");
        await writeFile(path, await body(request, 256 * 1024 * 1024), { mode: 0o600 });
        json(response, await service.importConversation(path));
      } finally { await rm(directory, { recursive: true, force: true }); }
      return;
    }
    if (url.pathname.startsWith("/eval-api/") && request.method === "POST") {
      const operation = url.pathname.slice("/eval-api/".length);
      if (!Object.hasOwn(operations, operation)) throw fail(404, "Unknown Eval operation.");
      const args = JSON.parse((await body(request)).toString());
      if (!Array.isArray(args)) throw fail(400, "Expected operation arguments.");
      return json(response, await operations[operation](args));
    }
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/eval-api/")) throw fail(404, "Not found.");
    await asset(response, rendererDirectory, url.pathname);
  });
}

// Settings gets an independent capability. It never forwards general product
// control authority, even though it reuses the production settings components.
export async function createSettingsSurface({ productSession, providerSetup, isBusy = () => false, fetchImpl = fetch }) {
  const operations = {
    status: () => providerSetup.status(),
    connect: ([input]) => providerSetup.connect(input),
    completeConnection: ([id]) => providerSetup.completeConnection(id),
    cancelConnection: ([id]) => providerSetup.cancelConnection(id),
    rename: ([id, label]) => providerSetup.rename(id, label),
    logout: ([id]) => providerSetup.logout(id),
    reconnect: ([id]) => providerSetup.reconnect(id),
    remove: ([id]) => providerSetup.remove(id),
    refresh: ([id]) => providerSetup.refresh(id),
    settingsOpened: () => providerSetup.settingsOpened(),
  };
  const reads = new Set(["/api/model-settings", "/api/permission-profiles", "/api/model-selection/default", "/api/provider-onboarding/projection", "/api/provider-onboarding/status"]);
  const writes = [
    ["PUT", /^\/api\/model-settings\/defaults$/],
    ["POST", /^\/api\/model-families$/],
    ["PUT", /^\/api\/model-families\/(?:order|[1-9][0-9]*)$/],
    ["DELETE", /^\/api\/model-families\/[1-9][0-9]*$/],
    ["PUT", /^\/api\/harness-configurations\/[a-zA-Z0-9_.-]+\/model-rules$/],
    ["POST", /^\/api\/provider-onboarding\/(?:complete|default)$/],
  ];
  const surface = await serveEvalSurface(async ({ request, response, url }) => {
    if (url.pathname === "/eval-settings-main.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end(await readFile(new URL("../eval-renderer/product-settings.js", import.meta.url)));
      return;
    }
    if (url.pathname.startsWith("/eval-api/") && request.method === "POST") {
      const operation = url.pathname.slice("/eval-api/".length);
      if (!Object.hasOwn(operations, operation)) throw fail(403, "Operation is outside Eval settings.");
      const args = JSON.parse((await body(request)).toString());
      if (!Array.isArray(args)) throw fail(400, "Expected operation arguments.");
      return json(response, await operations[operation](args));
    }
    const isApi = url.pathname.startsWith("/api/");
    if (url.pathname.startsWith("/eval-api/")) throw fail(403, "Operation is outside Eval settings.");
    const validates = request.method === "POST" && url.pathname === "/api/model-selection/validate";
    const mutates = writes.some(([method, pattern]) => request.method === method && pattern.test(url.pathname));
    if (isApi && !(request.method === "GET" && reads.has(url.pathname)) && !validates && !mutates) throw fail(403, "Product operation is outside Eval settings.");
    if (mutates && isBusy()) throw fail(409, "Finish active Eval sessions and runs before changing model settings.");
    const headers = isApi ? { Cookie: `${productSession.cookie.name}=${productSession.cookie.value}`, "Content-Type": "application/json" } : {};
    const upstream = await fetchImpl(new URL(url.pathname + url.search, productSession.origin), {
      method: request.method, headers, redirect: "manual",
      ...(["POST", "PUT", "DELETE"].includes(request.method) ? { body: await body(request) } : {}),
    });
    response.statusCode = upstream.status;
    response.setHeader("Content-Type", upstream.headers.get("content-type") || "application/octet-stream");
    let bytes = Buffer.from(await upstream.arrayBuffer());
    if (!isApi && upstream.headers.get("content-type")?.includes("text/html")) {
      bytes = Buffer.from(bytes.toString().replace("<head>", '<head><script src="/eval-bridge.js"></script>')
        .replace('src="./src/main.js"', 'src="/eval-settings-main.js"'));
    }
    response.end(bytes);
  });
  const url = new URL(surface.url); url.searchParams.set("evalSettings", "1");
  return { ...surface, url: url.href };
}

// Matrix reviews keep a snapshot; active human reviews refresh their owned roster.
export async function openHumanReview({ executionId, reviewContext, productSession,
  registerAnnotations, assertRunning, humanGrading }) {
  assertRunning();
  const context = reviewContext(executionId);
  const threadId = context.cases.find((item) => item.executionId === executionId)?.threadIds?.[0];
  if (!threadId) throw new Error("This execution has no product thread to review.");
  const session = await productSession();
  const annotationToken = randomBytes(32).toString("hex");
  await registerAnnotations(session, {
    token: annotationToken,
    threadIds: [...new Set(context.cases.flatMap((item) => item.threadIds || []))],
  });
  assertRunning();
  let registered = [...new Set(context.cases.flatMap(item => item.threadIds || []))].sort().join(",");
  const refreshContext = humanGrading ? async () => {
    assertRunning();
    const next = reviewContext(executionId);
    const threadIds = [...new Set(next.cases.flatMap(item => item.threadIds || []))];
    const identity = [...threadIds].sort().join(",");
    if (identity !== registered) {
      await registerAnnotations(session, { token: annotationToken, threadIds });
      registered = identity;
    }
    return next;
  } : undefined;
  const surface = await createReviewSurface({ productSession: session, context, annotationToken, humanGrading, refreshContext });
  const url = new URL(surface.url);
  url.search = new URLSearchParams({ threadId: String(threadId), review: "1", ...(humanGrading ? { humanGrading: "1" } : {}) });
  return { ...surface, url: url.href };
}

// Live task authority is intentionally separate from immutable review authority.
export async function createHumanTaskSurface({ tasks, sessionId, productSession, registerAnnotations, actor = false, signal, assertRunning = () => {}, fetchImpl = fetch, presentationSettings = reviewPresentationSettings }) {
  assertRunning();
  const annotationThreads = new Set((tasks.get(sessionId).threadIds || []).map(String));
  const annotationToken = registerAnnotations ? randomBytes(32).toString("hex") : null;
  if (annotationToken) {
    if (!productSession.readOnlyCookie) throw new Error("Task annotations require read-only product authority.");
    await registerAnnotations(productSession, { token: annotationToken, threadIds: [...annotationThreads].map(Number) });
    assertRunning();
  }
  const annotationUpstream = (path, options = {}) => fetchImpl(new URL(path, productSession.origin), {
    ...options, redirect: "error", headers: {
      Cookie: `${productSession.readOnlyCookie.name}=${productSession.readOnlyCookie.value}; relayer_annotation=${annotationToken}`,
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
  });
  const surface = await serveEvalSurface(async ({ request, response, url }) => {
    const session = tasks.get(sessionId);
    if (url.pathname === "/eval-api/workspace-layout") return workspaceLayoutPreference(request, response, presentationSettings);
    if (actor && url.pathname.startsWith("/eval-api/") && !["/eval-api/observe", "/eval-api/task", "/eval-api/workspace-layout"].includes(url.pathname)) throw fail(403, "Actor has no grading authority.");
    if (url.pathname === "/eval-api/task" && request.method === "GET") return json(response, actor
      ? { id: session.id, status: session.status, currentThreadId: session.currentThreadId, threadIds: session.threadIds, prepared: { name: session.prepared.name, plan: [], execution: { harnessConfigurationName: session.prepared.execution.harnessConfigurationName } }, workspaceGrading: 0 }
      : { ...session, workspaceGrading: 2 });
    if (url.pathname === "/eval-api/observe" && request.method === "POST") return json(response, await tasks.observe(sessionId, JSON.parse((await body(request)).toString()), { signal }));
    if (url.pathname === "/eval-api/grade" && request.method === "POST") return json(response, await tasks.grade(sessionId, JSON.parse((await body(request)).toString())));
    if (url.pathname === "/eval-api/finish" && request.method === "POST") return json(response, await tasks.finish(sessionId, JSON.parse((await body(request)).toString())));
    if (url.pathname === "/eval-api/annotate" && request.method === "POST") return json(response, await tasks.annotate(sessionId, JSON.parse((await body(request)).toString())));
    if (url.pathname.startsWith("/eval-api/")) throw fail(404, "Not found.");
    if (url.pathname.startsWith("/api/")) {
      if (actor && /\/annotations(?:\/|$)/.test(url.pathname)) throw fail(403, "Actor has no annotation authority.");
      const annotation = /^\/api\/threads\/([1-9][0-9]*)\/annotations(?:\/[1-9][0-9]*\/(?:revisions|retract))?$/.exec(url.pathname);
      if (request.method === "POST" && annotation) {
        if (!annotationToken || !annotationThreads.has(annotation[1]) || !session.threadIds.map(String).includes(annotation[1])) throw fail(403, "Annotation is outside this task workspace.");
        const upstream = await annotationUpstream(url.pathname, { method: "POST", body: await body(request) });
        response.statusCode = upstream.status;
        response.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
        return response.end(Buffer.from(await upstream.arrayBuffer()));
      }
      if (request.method !== "GET") {
        const result = await tasks.write(sessionId, `${url.pathname}${url.search}`, request.method, JSON.parse((await body(request)).toString() || "null"), ...(signal ? [{ signal }] : []));
        response.statusCode = result.status;
        response.setHeader("Content-Type", result.contentType || "application/json");
        return response.end(result.bytes);
      }
      const threads = new Set(session.threadIds.map(String));
      const stateRead = url.pathname === "/api/state";
      const threadId = url.searchParams.get("threadId");
      const threadRead = /^\/api\/threads\/([1-9][0-9]*)(?:\/(?:input-draft|context-drafts|interactions|annotations)|\/interactions\/[1-9][0-9]*\/(?:layers\/[1-9][0-9]*|actions\/[^/%]+\/destination|input-children))?$/.exec(url.pathname) || detailAssetPath.exec(url.pathname);
      const environment = /^\/api\/projects\/([1-9][0-9]*)\/environment$/.exec(url.pathname);
      const bootstrap = ["/api/capabilities", "/api/model-settings", "/api/permission-profiles", "/api/provider-onboarding/projection", "/api/provider-onboarding/status", "/api/model-selection/default"].includes(url.pathname);
      if (!(stateRead ? url.searchParams.getAll("threadId").length === 1 && threads.has(threadId)
        : threadRead ? threads.has(threadRead[1]) : environment ? String(session.prepared.execution.projectId) === environment[1] : bootstrap)) {
        throw fail(403, "Read is outside this task session.");
      }
      const draftRead = /^\/api\/threads\/[1-9][0-9]*\/(?:context-drafts|input-draft)$/.test(url.pathname);
      const upstream = annotationToken && !draftRead
        ? await annotationUpstream(`${url.pathname}${url.search}`)
        : await tasks.upstream(`${url.pathname}${url.search}`, {}, draftRead);
      let bytes = Buffer.from(await upstream.arrayBuffer());
      if (actor && upstream.ok && url.pathname === "/api/capabilities") {
        bytes = Buffer.from(JSON.stringify({ ...JSON.parse(bytes.toString()), annotations: false }));
      }
      if (upstream.ok && stateRead) {
        const state = JSON.parse(bytes.toString());
        if (actor) state.capabilities = { ...state.capabilities, annotations: false };
        if (!state.threads.some((thread) => String(thread.id) === threadId && thread.active)) throw fail(404, "Task thread is unavailable.");
        state.threads = state.threads.filter((thread) => threads.has(String(thread.id)));
        const projects = new Set(state.threads.map((thread) => String(thread.projectId)));
        state.projects = state.projects.filter((project) => projects.has(String(project.id)));
        bytes = Buffer.from(JSON.stringify(state));
      }
      if (upstream.ok && url.pathname.endsWith("/destination") && !threads.has(String(JSON.parse(bytes.toString()).threadId))) throw fail(403, "Destination is outside this task session.");
      response.statusCode = upstream.status;
      response.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
      return response.end(bytes);
    }
    const upstream = await fetchImpl(new URL(url.pathname, productSession.origin), { redirect: "error" });
    let bytes = Buffer.from(await upstream.arrayBuffer());
    if (upstream.headers.get("content-type")?.includes("text/html")) bytes = Buffer.from(bytes.toString().replace("<head>", '<head><script src="/eval-bridge.js"></script>'));
    response.statusCode = upstream.status;
    response.setHeader("Content-Type", upstream.headers.get("content-type") || "application/octet-stream");
    response.end(bytes);
  });
  const url = new URL(surface.url);
  url.search = new URLSearchParams({ threadId: String(tasks.get(sessionId).currentThreadId), humanTask: "1", ...(actor ? { taskActor: "1" } : {}) });
  return { ...surface, url: url.href };
}
