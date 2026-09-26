import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, resolve, extname, sep } from "node:path";
import { tmpdir } from "node:os";

const bridge = new URL("../eval-renderer/web-bridge.js", import.meta.url);
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
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
      if (url.pathname.includes("%") || url.pathname.includes("//")) throw fail(400, "Invalid path.");
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

export async function createReviewSurface({ productSession, context, annotationToken, fetchImpl = fetch }) {
  if (!productSession.readOnlyCookie) throw new Error("Review requires read-only authority.");
  const cookie = productSession.readOnlyCookie;
  return serveEvalSurface(async ({ request, response, url }) => {
    if (url.pathname === "/eval-api/context" && request.method === "GET") return json(response, context);
    if (url.pathname.startsWith("/eval-api/")) throw fail(404, "Not found.");
    const isApi = url.pathname.startsWith("/api/");
    const annotation = /^\/api\/threads\/([1-9][0-9]*)\/annotations(?:\/[^/]+\/(?:revisions|retract))?$/.exec(url.pathname);
    const allowedThreads = new Set(context.cases.flatMap((item) => item.threadIds).map(String));
    if (request.method !== "GET" && !(request.method === "POST" && annotationToken && annotation && allowedThreads.has(annotation[1]))) {
      throw fail(403, "Review does not permit product writes.");
    }
    if (url.pathname.startsWith("/api/internal/")) throw fail(403, "Review does not permit internal operations.");
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
    if (!isApi && upstream.headers.get("content-type")?.includes("text/html")) {
      bytes = Buffer.from(bytes.toString().replace("<head>", '<head><script src="/eval-bridge.js"></script>'));
    }
    response.end(bytes);
  });
}

export async function createEvalDashboard({ service, rendererDirectory, refreshCatalog, openReview, loadScreenshot }) {
  const operations = {
    catalog: async () => { await refreshCatalog?.(); return service.catalog(); },
    listRuns: () => service.listRuns(),
    getRun: ([id]) => service.getRun(id),
    createRun: ([selection]) => service.createRun(selection),
    judgeImportedConversation: ([id, judge]) => service.judgeImportedConversation(id, judge),
    rejudgeExecution: ([id, judge]) => service.rejudgeExecution(id, judge),
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

// Snapshot a fresh roster on every opening; existing tabs keep their own scope.
export async function openHumanReview({ executionId, reviewContext, productSession,
  registerAnnotations, assertRunning }) {
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
  const surface = await createReviewSurface({ productSession: session, context, annotationToken });
  const url = new URL(surface.url);
  url.search = new URLSearchParams({ threadId: String(threadId), review: "1" });
  return { ...surface, url: url.href };
}
