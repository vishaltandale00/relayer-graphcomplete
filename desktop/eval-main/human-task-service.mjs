import { abortable } from "./abortable.mjs";
import { interactionReturnsToUnsent } from "../renderer/src/interaction-failure-model.js";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { actorConfiguration } from "./task-actor.mjs";

const clone = (value) => structuredClone(value);
const digest = (value) => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
const terminal = new Set(["accepted", "failed", "stopped"]);
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const completionRoute = /\/interactions(?:\/[1-9][0-9]*(?:\/actions\/[1-9][0-9]*\/invoke|\/retry))?$/;

// Eval owns the session and evidence, never graph execution or acceptance.
// One serial admission queue also covers multiple tabs and finish/export races.
export class HumanTaskService {
  constructor({ stateFile, evalService, productSession, annotationSnapshotLoader, annotator = { id: "local-human", displayName: "Local human" }, fetchImpl = fetch }) {
    Object.assign(this, { stateFile, evalService, productSession, annotationSnapshotLoader, annotator, fetchImpl });
    this.sessions = [];
    this.tail = Promise.resolve();
  }
  async open() {
    try { this.sessions = JSON.parse(await readFile(this.stateFile, "utf8")).sessions; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    for (const session of this.sessions) {
      if (["active", "preparing", "finishing"].includes(session.status)) {
        session.status = "interrupted";
        session.termination = { reason: "host_interrupted", at: new Date().toISOString(), success: null };
        this.event(session, "interrupted", { reason: "Host restarted; no task success inferred." });
      }
    }
    await this.persist();
    return this;
  }
  serial(operation) {
    const next = this.tail.then(operation);
    this.tail = next.catch(() => {});
    return next;
  }
  async persist() {
    await mkdir(dirname(this.stateFile), { recursive: true });
    const temporary = `${this.stateFile}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ schemaVersion: 1, sessions: this.sessions }), { mode: 0o600 });
    await rename(temporary, this.stateFile);
  }
  event(session, kind, data) {
    const event = { id: `${session.id}:${session.events.length + 1}`, sequence: session.events.length + 1, at: new Date().toISOString(), kind, ...data };
    session.events.push(event);
    return event;
  }
  find(id) {
    const session = this.sessions.find((item) => item.id === id);
    if (!session) throw failure("Unknown human task session.", 404);
    return session;
  }
  list() { return this.sessions.map(({ prepared, events, conversations, stepChecks, annotations, grades, responseTimings, ...session }) => ({ ...clone(session), name: prepared?.name, eventCount: events.length })); }
  get(id) { return clone(this.find(id)); }
  actorEvent(id, kind, data) {
    return this.serial(async () => {
      const session = this.find(id);
      if (session.mode !== "simulated" || session.status !== "active") throw failure("Actor session is not active.", 409);
      const before = session.events.length;
      const recorded = clone(data);
      if (kind === "actor_observation" && recorded.observation?.screenshot) {
        const bytes = Buffer.from(recorded.observation.screenshot, "base64");
        if (bytes.length > 10 * 1024 * 1024 || bytes.toString("base64") !== recorded.observation.screenshot) throw failure("Invalid actor screenshot.");
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const folder = join(dirname(this.stateFile), "actor-screenshots");
        await mkdir(folder, { recursive: true });
        try { await writeFile(join(folder, `${sha256}.png`), bytes, { flag: "wx", mode: 0o600 }); }
        catch (error) { if (error.code !== "EEXIST") throw error; }
        delete recorded.observation.screenshot;
        recorded.observation.screenshotArtifact = { sha256, mediaType: "image/png" };
      }
      const event = this.event(session, kind, recorded);
      try { await this.persist(); } catch (error) { session.events.length = before; throw error; }
      return clone(event);
    });
  }
  async actorScreenshot(id, eventId) {
    const event = this.find(id).events.find(item => item.id === eventId && item.kind === "actor_observation");
    if (!event) throw failure("Unknown actor observation.", 404);
    if (event.observation.screenshot) return `data:image/png;base64,${event.observation.screenshot}`;
    const hash = event.observation.screenshotArtifact?.sha256;
    if (!/^[a-f0-9]{64}$/.test(hash || "")) throw failure("Missing actor screenshot.", 404);
    const bytes = await readFile(join(dirname(this.stateFile), "actor-screenshots", `${hash}.png`));
    if (createHash("sha256").update(bytes).digest("hex") !== hash) throw failure("Actor screenshot integrity failure.");
    return `data:image/png;base64,${bytes.toString("base64")}`;
  }
  interruptActor(id, reason) {
    return this.serial(async () => {
      const session = this.find(id);
      if (session.mode !== "simulated" || session.status !== "active") return;
      session.status = "interrupted";
      session.termination = { reason, at: new Date().toISOString(), success: null };
      this.event(session, "actor_interrupted", { reason });
      await this.persist();
    });
  }
  async upstream(path, { method = "GET", body, signal } = {}, write = false) {
    const cookie = write ? this.productSession.cookie : this.productSession.readOnlyCookie;
    const response = await this.fetchImpl(new URL(path, this.productSession.origin), {
      method, signal, redirect: "error", headers: { Cookie: `${cookie.name}=${cookie.value}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return response;
  }
  async detail(threadId, { signal } = {}) {
    const response = await this.upstream(`/api/threads/${threadId}`, { signal });
    if (!response.ok) throw failure("Could not read the task thread.", 502);
    return response.json();
  }
  async settled(session, { signal } = {}) {
    for (const threadId of session.threadIds) {
      const detail = await this.detail(threadId, { signal });
      if ((detail.interactions || []).some((turn) => !terminal.has(turn.completionStatus) && !interactionReturnsToUnsent(turn))) {
        throw failure("Wait for the current response, or stop it in the workspace, before continuing.", 409);
      }
    }
  }
  create(selection, { signal } = {}) {
    return this.serial(async () => {
      signal?.throwIfAborted();
      if (!Number.isSafeInteger(selection?.maxCompletions) || selection.maxCompletions < 1 || selection.maxCompletions > 1000) throw failure("Choose a completion limit from 1 to 1000.");
      if (typeof selection.endpoint !== "string" || !selection.endpoint.trim() || selection.endpoint.length > 8000) throw failure("Describe the task artifact or endpoint.");
      const session = { schemaVersion: 1, id: `human-${randomUUID()}`, mode: "human", status: "preparing", createdAt: new Date().toISOString(), maxCompletions: selection.maxCompletions, completions: 0, endpoint: selection.endpoint.trim(), step: 0, threadIds: [], events: [], annotations: [], stepChecks: [], satisfaction: null, termination: null };
      if (selection.mode !== undefined && !["human", "simulated"].includes(selection.mode)) throw failure("Unknown task mode.");
      if (selection.mode === "simulated") { session.mode = "simulated"; session.actor = actorConfiguration(selection.actor); }
      this.sessions.unshift(session);
      await this.persist();
      try {
        session.prepared = await abortable(signal, () => this.evalService.prepareHumanTask({ ...selection, sessionId: session.id }, { signal }));
        signal?.throwIfAborted();
        session.status = "active";
        await this.startThread(session, { signal });
      } catch (error) {
        const unknown = session.completions > 0;
        const cancelled = signal?.aborted && !unknown;
        session.status = unknown ? "interrupted" : "failed";
        session.termination = { reason: unknown ? "product_write_unknown" : cancelled ? (signal.reason?.name === "TimeoutError" ? "actor_timeout" : "actor_cancelled") : "preparation_failed", at: new Date().toISOString(), success: null };
        this.event(session, "error", { message: error.message });
        await this.persist();
        throw error;
      }
      return this.get(session.id);
    });
  }
  async startThread(session, { signal } = {}) {
    if (session.completions >= session.maxCompletions) throw failure("Completion limit reached.", 409);
    // Reserve durably before calling a product API; an ambiguous transport failure
    // never refunds authority or silently replays a possibly started completion.
    session.completions++;
    const submission = this.event(session, "submission", { step: session.step, initial: true, text: session.prepared.plan[session.step].prompts[0] });
    await this.persist();
    if (signal?.aborted) {
      session.completions--; submission.outcome = "cancelled_before_dispatch";
      await this.persist(); signal.throwIfAborted();
    }
    const thread = await this.evalService.createHumanTaskThread(session.prepared, session.step, { signal });
    submission.interactionId = thread.rootInteractionId;
    submission.threadId = thread.id;
    session.threadIds.push(thread.id);
    session.currentThreadId = thread.id;
    this.event(session, "thread_started", { threadId: thread.id, interactionId: thread.rootInteractionId });
    await this.persist();
  }
  nextStep(id, { signal } = {}) {
    return this.serial(async () => {
      signal?.throwIfAborted();
      const session = this.find(id);
      if (session.status !== "active") throw failure("Task session is not active.", 409);
      if (session.step + 1 >= session.prepared.plan.length) throw failure("No further case step.");
      await this.settled(session, { signal });
      if (session.completions >= session.maxCompletions) throw failure("Completion limit reached.", 409);
      const checks = await abortable(signal, () => this.evalService.gradeHumanTaskStep(session.prepared, session.step, { signal }));
      signal?.throwIfAborted();
      const previousStep = session.step;
      const previousChecks = session.stepChecks.length;
      session.stepChecks.push({ step: session.step, checks });
      session.step++;
      try { await this.startThread(session, { signal }); }
      catch (error) {
        if (session.events.at(-1)?.outcome === "cancelled_before_dispatch") {
          session.step = previousStep; session.stepChecks.length = previousChecks;
          await this.persist(); throw error;
        }
        session.status = "interrupted";
        session.termination = { reason: "product_write_unknown", at: new Date().toISOString(), success: null };
        this.event(session, "error", { message: "Initial dispatch outcome unknown; session locked against replay." });
        await this.persist(); throw error;
      }
      return this.get(id);
    });
  }
  write(id, path, method, body, { signal } = {}) {
    return this.serial(async () => {
      signal?.throwIfAborted();
      const session = this.find(id);
      if (session.status !== "active") throw failure("Task session is read-only.", 403);
      const pathname = new URL(path, "http://task.invalid").pathname;
      if (method === "POST" && pathname === "/api/model-selection/validate") {
        const selected = session.prepared.execution.modelResolution?.selectedModel;
        if (body?.harnessId && body.harnessId !== session.prepared.execution.harnessConfigurationName) throw failure("This task uses its starting harness.", 403);
        if (selected && ["familyId", "providerId", "modelId"].some((key) => body?.[key] !== undefined && body[key] !== selected[key])) throw failure("This task uses its starting model.", 403);
        const response = await this.upstream(path, { method, body, signal }, true);
        return { status: response.status, contentType: response.headers.get("content-type"), bytes: await response.text() };
      }
      const prefix = `/api/threads/${session.currentThreadId}`;
      const route = pathname.startsWith(`${prefix}/`) ? pathname.slice(prefix.length) : "";
      const retries = method === "POST" && /^\/interactions\/[1-9][0-9]*\/retry$/.test(route);
      const starts = method === "POST" && completionRoute.test(pathname);
      const allowed = (starts && (route === "/interactions" || retries || /^\/interactions\/[1-9][0-9]*\/actions\/[1-9][0-9]*\/invoke$/.test(route)))
        || (method === "POST" && /^\/interactions\/[1-9][0-9]*\/(?:stop|approvals\/[^/%]+\/decision)$/.test(route))
        || (method === "PUT" && route === "/input-draft/attachments")
        || (method === "DELETE" && /^\/input-draft\/attachments\/[1-9][0-9]*\/[1-9][0-9]*\/[1-9][0-9]*$/.test(route))
        || (["PUT", "DELETE"].includes(method) && /^\/(?:context-drafts|context-confirmations)\/[^/%]+$/.test(route))
        || (method === "POST" && /^\/context-drafts\/[^/%]+\/confirm$/.test(route));
      if (!allowed) throw failure("Write is outside this task session.", 403);
      const controlDuringRun = method === "POST" && /^\/interactions\/[1-9][0-9]*\/(?:stop|approvals\/[^/%]+\/decision)$/.test(route);
      if (!controlDuringRun) await this.settled(session, { signal });
      const previousCompletions = session.completions;
      const previousEventCount = session.events.length;
      if (starts) {
        if (session.completions >= session.maxCompletions) throw failure("Completion limit reached. Finish this task session.", 409);
        if (route === "/interactions" || retries) {
          const selection = session.prepared.execution.modelResolution;
          body = { ...body };
          const pinned = selection.productModelSelection && selection.selectedModel
            ? Object.fromEntries(["familyId", "providerId", "modelId"].map((key) => [key, selection.selectedModel[key]])) : null;
          if (body.modelSelection && JSON.stringify(body.modelSelection) !== JSON.stringify(pinned)) {
            if (!pinned || ["familyId", "providerId", "modelId"].some((key) => body.modelSelection[key] !== pinned[key])) throw failure("This task uses its starting model. Start another session to change models.");
          }
          delete body.modelSelection;
          if (pinned) body.modelSelection = pinned;
        }
        session.completions++;
      }
      const event = this.event(session, starts ? "submission" : "product_action", { threadId: session.currentThreadId, path, method, request: body, outcome: "pending" });
      try { await this.persist(); }
      catch (error) {
        // Nothing has reached product execution: a failed reservation grants no
        // authority and leaves no phantom attempt in the active session.
        session.completions = previousCompletions;
        session.events.length = previousEventCount;
        throw error;
      }
      let dispatched = false;
      try {
        signal?.throwIfAborted();
        dispatched = true;
        const response = await this.upstream(path, { method, body, signal }, true);
        const bytes = await response.text();
        event.status = response.status;
        event.outcome = response.ok ? "accepted" : "rejected";
        if (starts && !response.ok && response.status < 500) session.completions--;
        if (response.status >= 500) {
          event.outcome = "unknown";
          session.status = "interrupted";
          session.termination = { reason: "product_write_unknown", at: new Date().toISOString(), success: null };
        }
        if (response.ok && bytes) {
          try {
            const result = JSON.parse(bytes);
            event.interactionId = result.interaction?.id ?? (starts ? result.id : undefined);
            // Retry admits a new attempt on the same interaction. Only replaying
            // the same expected attempt may refund that reservation.
            const priorSubmission = session.events.some((prior) => prior !== event
              && prior.kind === "submission" && prior.interactionId != null
              && prior.interactionId === event.interactionId
              && (!retries || (prior.path === path && prior.request?.attemptId === body?.attemptId && prior.outcome === "accepted")));
            if (starts && (result.created === false || priorSubmission)) {
              session.completions--;
              event.outcome = "replayed";
            }
          } catch { /* Response bytes remain upstream-owned. */ }
        }
        await this.persist();
        return { status: response.status, contentType: response.headers.get("content-type"), bytes };
      } catch (error) {
        if (!dispatched) {
          session.completions = previousCompletions;
          event.outcome = "cancelled_before_dispatch";
          await this.persist(); throw error;
        }
        event.outcome = "unknown";
        session.status = "interrupted";
        session.termination = { reason: "product_write_unknown", at: new Date().toISOString(), success: null };
        this.event(session, "error", { message: "Product write outcome unknown; session locked against replay." });
        await this.persist();
        throw error;
      }
    });
  }
  observe(id, observation, { signal } = {}) {
    return this.serial(async () => {
      const session = this.find(id);
      if (session.status !== "active") return null;
      if (!session.threadIds.some((thread) => String(thread) === String(observation?.threadId))) throw failure("Observation is outside this task.", 403);
      if (!Number.isFinite(observation.observedAt) || typeof observation.content !== "string" || observation.content.length > 200000) throw failure("Invalid presentation observation.");
      const detail = await this.detail(observation.threadId, { signal });
      signal?.throwIfAborted();
      if (observation.turnId != null && !detail.interactions.some((turn) => String(turn.id) === String(observation.turnId))) throw failure("Unknown observed interaction.");
      const snapshot = {
        threadId: observation.threadId, turnId: observation.turnId ?? null, layerId: observation.layerId ?? null,
        selectedNodeId: observation.selectedNodeId ?? null, navigationPath: observation.navigationPath ?? [],
        observedAt: observation.observedAt, content: observation.content,
        graphVisible: observation.graphVisible === true, completionStatus: observation.completionStatus ?? null, captureFailures: observation.captureFailures ?? 0, source: "renderer-after-paint",
      };
      const key = digest({ ...snapshot, observedAt: null });
      if (session.lastObservationDigest === key) return null;
      session.lastObservationDigest = key;
      const event = this.event(session, "presentation", { snapshot, contentDigest: key });
      session.viewerAttachedAt ??= snapshot.observedAt;
      session.viewerAttachedAtByThread ??= {};
      session.viewerAttachedAtByThread[String(snapshot.threadId)] ??= snapshot.observedAt;
      const threadViewerAttachedAt = session.viewerAttachedAtByThread[String(snapshot.threadId)];
      const submission = session.events.findLast((item) => item.kind === "submission"
        && String(item.threadId) === String(snapshot.threadId)
        && String(item.interactionId) === String(snapshot.turnId)
        && (item.outcome == null || item.outcome === "accepted"));
      if (snapshot.graphVisible && submission) {
        session.responseTimings ??= [];
        if (!session.responseTimings.some((item) => item.submissionEventId === submission.id)) session.responseTimings.push({
          interactionId: snapshot.turnId, submissionEventId: submission.id, eventId: event.id,
          latencyMs: Math.max(0, snapshot.observedAt - Date.parse(submission.at)),
          observerPresentBeforeSubmission: threadViewerAttachedAt <= Date.parse(submission.at),
          usefulness: "not_assessed",
        });
      }
      if (snapshot.graphVisible && submission && !session.firstVisibleGraph) {
        const firstSubmission = submission;
        session.firstVisibleGraph = { eventId: event.id, submissionEventId: submission.id, observedAt: snapshot.observedAt, latencyMs: Math.max(0, snapshot.observedAt - Date.parse(firstSubmission.at)), usefulness: "not_assessed", observerPresentBeforeSubmission: threadViewerAttachedAt <= Date.parse(firstSubmission.at) };
      }
      await this.persist();
      return event.id;
    });
  }
  grade(id, input) {
    return this.serial(async () => {
      const session = this.find(id);
      if (!["active", "completed", "failed", "interrupted"].includes(session.status)) throw failure("Wait for the session to settle.", 409);
      if (![1, 2, 3, 4].includes(input?.satisfaction) || typeof input.comment !== "string" || input.comment.length > 8000) throw failure("Choose a satisfaction rating from 1 to 4 and valid feedback.");
      const grade = { scale: "human-1-4", value: input.satisfaction, comment: input.comment.trim(), at: new Date().toISOString(), author: clone(this.annotator) };
      const previousSatisfaction = session.satisfaction;
      const previousGradeCount = session.grades?.length ?? 0;
      (session.grades ??= []).push(grade);
      session.satisfaction = grade;
      try { await this.persist(); }
      catch (error) {
        session.satisfaction = previousSatisfaction;
        session.grades.length = previousGradeCount;
        throw error;
      }
      return this.get(id);
    });
  }
  finish(id, input, { signal } = {}) {
    return this.serial(async () => {
      signal?.throwIfAborted();
      const session = this.find(id);
      if (session.status !== "active") throw failure("Task session is not active.", 409);
      if (!["endpoint_reached", "satisfied", "abandoned", "budget_exhausted"].includes(input?.reason)) throw failure("Choose a termination reason.");
      if (input.satisfaction !== undefined && ![1, 2, 3, 4].includes(input.satisfaction)) throw failure("Choose a satisfaction rating from 1 to 4.");
      if (input.reason === "budget_exhausted" && session.completions < session.maxCompletions) throw failure("The completion budget is not exhausted.");
      if (input.reason === "endpoint_reached" && session.step + 1 < session.prepared.plan.length) throw failure("Complete the remaining case steps first.");
      await this.settled(session, { signal });
      const previousSatisfaction = session.satisfaction;
      const previousGradeCount = session.grades?.length ?? 0;
      const previousCheckCount = session.stepChecks.length;
      const previousEventCount = session.events.length;
      if (input.actorActionEventId !== undefined && (session.mode !== "simulated" || !session.events.some(event => event.id === input.actorActionEventId && event.kind === "actor_action" && event.action.kind === "finish"))) throw failure("Unknown actor finish intent.");
      session.status = "finishing";
      try { await this.persist(); }
      catch (error) { session.status = "active"; throw error; }
      try {
        session.stepChecks.push({ step: session.step, checks: await abortable(signal, () => this.evalService.gradeHumanTaskStep(session.prepared, session.step, { signal })) });
      } catch (error) { session.stepChecks.push({ step: session.step, checks: { status: "error", reason: error.message } }); }
      try {
        signal?.throwIfAborted();
        const conversations = [];
        for (const threadId of session.threadIds) {
          const response = await this.upstream(`/api/threads/${threadId}/export`, { signal }, true);
          if (!response.ok) throw failure("Could not freeze the task conversation.", 502);
          conversations.push({ threadId, jsonl: await response.text() });
        }
        signal?.throwIfAborted();
        session.conversations = conversations;
        if (input.satisfaction !== undefined) {
          session.satisfaction = { scale: "human-1-4", value: input.satisfaction, comment: String(input.comment || "").slice(0, 8000), at: new Date().toISOString(), author: clone(this.annotator) };
          (session.grades ??= []).push(session.satisfaction);
        }
        session.termination = { reason: input.reason, at: new Date().toISOString(), success: null, endpointAttainment: input.reason === "endpoint_reached" ? (session.mode === "simulated" ? "actor_reported" : "human_reported") : "not_claimed" };
        if (input.actorActionEventId) this.event(session, "actor_action_completed", { actionEventId: input.actorActionEventId });
        this.event(session, "finished", { termination: session.termination, satisfaction: session.satisfaction });
        session.status = "completed";
        session.evidenceDigest = digest({ events: session.events, conversations: session.conversations, stepChecks: session.stepChecks });
        await this.persist();
      } catch (error) {
        delete session.conversations;
        delete session.evidenceDigest;
        session.satisfaction = previousSatisfaction;
        if (session.grades) session.grades.length = previousGradeCount;
        session.stepChecks.length = previousCheckCount;
        session.termination = null;
        session.status = "active";
        session.events.length = previousEventCount;
        this.event(session, "finish_failed", { message: error.message });
        await this.persist(); throw error;
      }
      return this.get(id);
    });
  }
  annotate(id, { eventId, comment, rating = null }) {
    return this.serial(async () => {
      const session = this.find(id);
      if (!["active", "completed", "failed", "interrupted"].includes(session.status) || !session.events.some((item) => item.id === eventId)) throw failure("Choose a recorded moment in this session.");
      if (typeof comment !== "string" || !comment.trim() || comment.length > 8000 || (rating !== null && ![1, 2, 3, 4].includes(rating))) throw failure("Invalid annotation.");
      session.annotations.push({ id: randomUUID(), eventId, comment: comment.trim(), rating, at: new Date().toISOString(), author: clone(this.annotator) });
      try { await this.persist(); }
      catch (error) { session.annotations.pop(); throw error; }
      return this.get(id);
    });
  }
  export(id) {
    return this.serial(async () => {
      const session = this.find(id);
      if (!["completed", "failed", "interrupted"].includes(session.status)) throw failure("Finish the session before exporting immutable evidence.");
      if (session.status === "completed") await this.settled(session);
      const graphAnnotations = this.annotationSnapshotLoader && session.threadIds.length ? await this.annotationSnapshotLoader(session.threadIds) : null;
      const actorScreenshots = [];
      for (const event of session.events) {
        if (event.kind === "actor_observation" && event.observation?.screenshotArtifact) actorScreenshots.push({ eventId: event.id, ...event.observation.screenshotArtifact, dataUrl: await this.actorScreenshot(id, event.id) });
      }
      const bundle = { ...(actorScreenshots.length ? { actorScreenshots } : {}), schemaVersion: 1, kind: "relayer_human_task_bundle", exportedAt: new Date().toISOString(), session: clone(session), graphAnnotations, conversationEvidence: session.status === "completed" && session.conversations?.length === session.threadIds.length ? "frozen-at-finish" : "unavailable-after-interruption" };
      const sha256 = digest(bundle);
      const path = join(dirname(this.stateFile), "human-task-exports", `${session.id}-${sha256.slice(7)}.json`);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify({ ...bundle, sha256 }, null, 2), { flag: "wx", mode: 0o600 });
      return { path, sha256, bundle: { ...bundle, sha256 } };
    });
  }
}
