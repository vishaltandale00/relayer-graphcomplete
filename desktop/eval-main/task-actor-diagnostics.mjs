import { mkdir, appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

const require = createRequire(import.meta.url);
// Traces can contain capability URLs even without network snapshots. Persist only
// an allowlisted projection, never params, results, DOM, console arguments or bodies.
export function sanitizeActorDiagnostic(value, secrets = []) {
  let text = String(value ?? "");
  for (const secret of secrets.filter(Boolean)) text = text.split(secret).join("[redacted]");
  return text.replace(/https?:\/\/[^\s<>"']+/g, "[url]")
    .replace(/((?:authorization|cookie|password|api[_-]?key|access[_-]?token|secret)["']?\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*')/gi, "$1[redacted]")
    .replace(/\b(?:sk-[a-zA-Z0-9_-]{12,}|AIza[a-zA-Z0-9_-]{20,})\b/g, "[redacted]")
    .replace(/\b(?:Bearer\s+)[^\s,"']+/gi, "Bearer [redacted]")
    .replace(/((?:authorization|cookie|password|api[_-]?key|access[_-]?token|secret)["']?\s*[=:]\s*)[^\s,"']+/gi, "$1[redacted]")
    .replace(/\b[a-f0-9]{48,}\b/gi, "[redacted]").slice(0, 12000);
}
export function projectActorTrace(event, clean = sanitizeActorDiagnostic) {
  const result = {};
  for (const key of ["type", "version", "origin", "browserName", "platform", "wallTime", "monotonicTime", "callId", "parentId", "pageId", "startTime", "endTime", "method", "class", "apiName"]) {
    if (["string", "number", "boolean"].includes(typeof event[key])) result[key] = typeof event[key] === "string" ? clean(event[key]) : event[key];
  }
  if (event.type === "before") result.params = {};
  if (event.type === "context-options") { result.sdkLanguage = "javascript"; result.options = {}; }
  if (event.error) result.error = { message: clean(event.error.message), name: clean(event.error.name) };
  // Keep only code-owned API operations. Runtime console/event payloads are not diagnostics.
  return ["context-options", "before", "after", "input"].includes(event.type) ? result : null;
}
async function sanitizeTrace(source, destination, clean) {
  const { yauzl, yazl } = require(join(dirname(require.resolve("playwright-core/package.json")), "lib/zipBundle.js"));
  const input = await new Promise((resolve, reject) => yauzl.fromBuffer(Buffer.from(source), { lazyEntries: true }, (error, zip) => error ? reject(error) : resolve(zip)));
  const output = new yazl.ZipFile();
  const chunks = [];
  const completed = new Promise((resolve, reject) => { output.outputStream.on("data", chunk => chunks.push(chunk)); output.outputStream.on("end", resolve); output.outputStream.on("error", reject); });
  await new Promise((resolve, reject) => {
    input.on("error", reject); input.on("end", resolve);
    input.on("entry", entry => {
      if (!entry.fileName.endsWith(".trace")) { input.readEntry(); return; }
      input.openReadStream(entry, (error, stream) => {
        if (error) { reject(error); return; }
        const parts = []; stream.on("data", part => parts.push(part)); stream.on("error", reject);
        stream.on("end", () => {
          try {
            const lines = Buffer.concat(parts).toString("utf8").split("\n").filter(Boolean).map(line => projectActorTrace(JSON.parse(line), clean)).filter(Boolean);
            output.addBuffer(Buffer.from(lines.map(line => JSON.stringify(line)).join("\n") + "\n"), "trace.trace"); input.readEntry();
          } catch (failure) { reject(failure); }
        });
      });
    }); input.readEntry();
  });
  output.addBuffer(Buffer.alloc(0), "trace.network"); output.end(); await completed;
  await writeFile(destination, Buffer.concat(chunks), { mode: 0o600 });
}
export async function createActorDiagnostics({ directory, context, surfaceUrl, sessionId }) {
  if (!directory) return null;
  const attemptId = randomUUID();
  const root = join(directory, attemptId);
  const secret = new URL(surfaceUrl).hash.slice(1);
  const clean = value => sanitizeActorDiagnostic(value, [secret, surfaceUrl]);
  let queue = Promise.resolve(); let traced = false; let closing;
  const manifest = { version: 1, sessionId, attemptId, status: "capturing", trace: "not_started", writeFailures: 0, droppedEvents: 0,
    omitted: ["network", "DOM snapshots", "sources", "API params/results", "console payloads", "URL values", "input values"], captureFailures: [] };
  const saveManifest = () => writeFile(join(root, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 }).catch(() => {});
  await mkdir(root, { recursive: true, mode: 0o700 });
  let eventCount = 0;
  function record(type, data = {}) {
    if (eventCount++ >= 2000) { manifest.droppedEvents++; return queue; }
    queue = queue.then(() => appendFile(join(root, "events.jsonl"), JSON.stringify({ at: new Date().toISOString(), sessionId, attemptId, type, ...data }) + "\n", { mode: 0o600 })).catch(() => { manifest.writeFailures++; });
    return queue;
  }
  const errorInfo = error => ({ name: clean(error?.name), code: clean(error?.code), message: clean(error?.message), stack: clean(error?.stack) });
  await saveManifest();
  await record("diagnostics_started", { tracePolicy: "api-timing-only; no params/results/network/DOM/sources; local-only" });
  try { await context.tracing.start({ screenshots: false, snapshots: false, sources: false }); traced = true; manifest.trace = "capturing"; }
  catch (error) { manifest.trace = "failed"; manifest.captureFailures.push("trace_start"); await record("diagnostic_error", { operation: "trace_start", error: errorInfo(error) }); }
  return {
    record, errorInfo,
    async operationError(stage, error) { await record("operation_error", { stage, error: errorInfo(error) }); },
    async targetState(target) {
      if (!target) return null;
      return boundedDiagnostic(() => target.evaluate(element => { const rect = element.getBoundingClientRect(); return { tag: element.tagName, connected: element.isConnected, disabled: Boolean(element.disabled), rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }; }), 1000);
    },
    attach(page) {
      page.on("pageerror", error => { void record("page_error", { error: errorInfo(error) }); });
      page.on("crash", () => { void record("page_crash"); });
      page.on("close", () => { void record("page_close"); });
      page.on("framenavigated", frame => { void record("navigation", { mainFrame: frame === page.mainFrame() }); });
      page.on("requestfailed", request => { void record("request_failed", { method: request.method(), failure: clean(request.failure()?.errorText) }); });
    },
    async failure(page, { actionId, stage, error, target }) {
      await record("action_error", { actionId, stage, error: errorInfo(error), actionDispatched: error?.actionDispatched === false ? false : "unknown" });
      try {
        const state = await this.targetState(target);
        await record("failure_target", { actionId, state });
        // The task viewport already forms actor evidence. Exclude browser chrome
        // and mask fields; authored visible task content remains private evidence.
        await boundedDiagnostic(() => page.locator(".workspace-layout").screenshot({ path: join(root, `${actionId}.png`), timeout: 1500, mask: [page.locator("input,textarea")] }), 1800);
      } catch (failure) { manifest.captureFailures.push("failure_capture"); await record("diagnostic_error", { actionId, operation: "failure_capture", error: errorInfo(failure) }); }
    },
    close() {
      if (closing) return closing;
      closing = (async () => {
      if (traced) {
        let temporary;
        try {
          temporary = await mkdtemp(join(root, ".trace-"));
          const raw = join(temporary, "raw.zip");
          await context.tracing.stop({ path: raw });
          await sanitizeTrace(await readFile(raw), join(root, "trace.zip"), clean);
          manifest.trace = "saved"; await record("trace_saved", { file: "trace.zip" });
        } catch (error) { manifest.trace = "failed"; manifest.captureFailures.push("trace_stop"); await record("diagnostic_error", { operation: "trace_stop", error: errorInfo(error) }); }
        finally { if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => { manifest.captureFailures.push("temporary_trace_cleanup"); }); }
      }
      await record("diagnostics_closed"); await queue; manifest.status = "closed"; await saveManifest();
      })();
      return closing;
    },
  };
}

export async function boundedDiagnostic(operation, timeoutMs = 2000) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Diagnostic capture timed out.")), timeoutMs); timer.unref?.(); })]); }
  finally { clearTimeout(timer); }
}
