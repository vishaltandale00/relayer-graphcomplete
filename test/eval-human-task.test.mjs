import { mkdir, mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createSettingsStore } from "../desktop/main/services/settings-store.mjs";
import { afterEach, expect, it, vi } from "vitest";
import { HumanTaskService } from "../desktop/eval-main/human-task-service.mjs";
import { createHumanTaskSurface } from "../desktop/eval-main/web-host.mjs";

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture({ steps = 1 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "human-eval-")); cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const threads = new Map();
  const calls = [];
  let reject = false;
  let transportFailure = false;
  let serverFailure = false;
  let replayInvoke = false;
  let exportFailure = false;
  const options = {
    stateFile: join(dir, "sessions.json"),
    productSession: { origin: "http://product.invalid", cookie: { name: "control", value: "secret" }, readOnlyCookie: { name: "read", value: "only" } },
    evalService: {
      prepareHumanTask: async () => ({ name: "Task", execution: { testCaseId: "case", harnessConfigurationName: "fixture", modelResolution: { productModelSelection: true, selectedModel: { familyId: 1, providerId: "pinned", modelId: "model" } } }, plan: Array.from({ length: steps }, (_, i) => ({ name: `Step ${i}`, prompts: ["Build the thing"], permissionProfileId: "auto" })) }),
      createHumanTaskThread: async () => {
        const id = threads.size + 1; threads.set(id, [{ id: 10 * id, completionStatus: "accepted" }]);
        return { id, rootInteractionId: id * 10 };
      },
      gradeHumanTaskStep: async () => ({ status: "recorded", result: { passed: false } }),
    },
    fetchImpl: async (url, init) => {
      calls.push({ path: url.pathname + url.search, ...init });
      const id = Number(url.pathname.match(/threads\/(\d+)/)?.[1]);
      if (init.method !== "GET") {
        if (transportFailure) throw new Error("Connection lost");
        if (serverFailure) return Response.json({ error: "Handoff failed after durable admission" }, { status: 500 });
        if (replayInvoke && url.pathname.endsWith("/invoke")) return Response.json({ created: false, interaction: threads.get(id)[0] });
        if (reject) return Response.json({ error: "Invalid input" }, { status: 400 });
        if (url.pathname.endsWith("/interactions") || url.pathname.endsWith("/invoke")) {
          const interaction = { id: threads.get(id).at(-1).id + 1, completionStatus: "accepted" };
          threads.get(id).push(interaction);
          return Response.json(interaction, { status: 201 });
        }
        return Response.json({ committed: true });
      }
      if (exportFailure && id === 2 && url.pathname.endsWith("/export")) return Response.json({ error: "Export failed" }, { status: 500 });
      if (url.pathname.endsWith("/export")) return new Response(JSON.stringify({ threadId: id, interactions: threads.get(id) }) + "\n");
      if (url.pathname === "/api/state") return Response.json({ threads: [{ id: 1, active: true, projectId: 1 }, { id: 999, projectId: 999 }], projects: [{ id: 1 }, { id: 999 }], interactions: threads.get(1) });
      return Response.json({ thread: { id }, interactions: threads.get(id) });
    },
    annotationSnapshotLoader: async (threadIds) => ({ threadIds, annotations: [] }),
  };
  const tasks = await new HumanTaskService(options).open();
  const session = await tasks.create({ testCaseId: "case", harnessConfigurationName: "fixture", maxCompletions: 2, endpoint: "A working artifact" });
  return { tasks, session, threads, calls, options, reject: () => { reject = true; }, failTransport: () => { transportFailure = true; }, failServer: () => { serverFailure = true; }, replayInvoke: () => { replayInvoke = true; }, failExport: () => { exportFailure = true; } };
}

it("preserves a multi-step human trajectory through reopen, anchored annotations and immutable export", async () => {
  const { tasks, session, options } = await fixture({ steps: 2 });
  const id = session.id;
  expect(tasks.list()[0].testCaseId).toBe("case");
  const eventId = await tasks.observe(id, { threadId: 1, turnId: 10, layerId: 5, selectedNodeId: 6, navigationPath: [{ layerId: 5 }], graphVisible: true, observedAt: Date.now(), content: "A useful option" });
  await tasks.write(id, "/api/threads/1/input-draft/attachments", "PUT", { value: { text: "Warm colors" } });
  expect(tasks.get(id).completions).toBe(1);
  await tasks.nextStep(id);
  expect(tasks.get(id).threadIds).toEqual([1, 2]);
  await expect(tasks.write(id, "/api/threads/1/interactions", "POST", { text: "wrong step" })).rejects.toThrow("outside");
  const finished = await tasks.finish(id, { reason: "endpoint_reached", satisfaction: 4, comment: "Fits my needs" });
  expect(finished.termination).toMatchObject({ success: null, endpointAttainment: "human_reported" });
  expect(finished.stepChecks[0].checks.result.passed).toBe(false);
  expect(finished.firstVisibleGraph.eventId).toBe(eventId);
  const reopened = await new HumanTaskService(options).open();
  await reopened.annotate(id, { eventId, comment: "This option helped." });
  const first = await reopened.export(id);
  const frozen = await readFile(first.path, "utf8");
  await reopened.annotate(id, { eventId, comment: "A later review." });
  const second = await reopened.export(id);
  expect(first.sha256).not.toBe(second.sha256);
  expect(await readFile(first.path, "utf8")).toBe(frozen);
  expect(second.bundle.session.conversations).toHaveLength(2);
  expect(second.bundle.session.events.map((event) => event.sequence)).toEqual(second.bundle.session.events.map((_, i) => i + 1));
  await expect(reopened.write(id, "/api/threads/2/interactions", "POST", {})).rejects.toThrow("read-only");
});

it("serializes Send and invoke against the final budget slot and does not count drafting", async () => {
  const { tasks, session, calls } = await fixture();
  await expect(tasks.write(session.id, "/api/threads/1/interactions", "POST", { text: "Refine", modelSelection: { providerId: "forged" } })).rejects.toThrow("starting model");
  const results = await Promise.allSettled([
    tasks.write(session.id, "/api/threads/1/interactions", "POST", { text: "Refine" }),
    tasks.write(session.id, "/api/threads/1/interactions/10/actions/22/invoke", "POST", {}),
  ]);
  expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
  expect(tasks.get(session.id).completions).toBe(2);
  const sent = calls.find((call) => call.method === "POST");
  expect(JSON.parse(sent.body).modelSelection.providerId).toBe("pinned");
  expect(sent.headers.Cookie).toBe("control=secret");
});

it("refuses finishing or another completion during active work, and distinguishes rejected and unknown writes", async () => {
  const { tasks, session, threads, reject } = await fixture();
  threads.get(1)[0].completionStatus = "running";
  await expect(tasks.finish(session.id, { reason: "satisfied", satisfaction: 3 })).rejects.toThrow("Wait");
  await expect(tasks.write(session.id, "/api/threads/1/interactions", "POST", {})).rejects.toThrow("Wait");
  await expect(tasks.write(session.id, "/api/threads/1/input-draft/attachments", "PUT", {})).rejects.toThrow("Wait");
  threads.get(1)[0].completionStatus = "accepted";
  reject();
  expect((await tasks.write(session.id, "/api/threads/1/interactions", "POST", {})).status).toBe(400);
  expect(tasks.get(session.id).completions).toBe(1);
  const uncertain = await fixture(); uncertain.failTransport();
  await expect(uncertain.tasks.write(uncertain.session.id, "/api/threads/1/interactions", "POST", {})).rejects.toThrow("Connection lost");
  expect(uncertain.tasks.get(uncertain.session.id)).toMatchObject({ status: "interrupted", completions: 2 });
  await expect(uncertain.tasks.write(uncertain.session.id, "/api/threads/1/interactions", "POST", {})).rejects.toThrow("read-only");
});

it("restart interrupts active sessions without resetting their budget or claiming success", async () => {
  const { tasks, session, options } = await fixture();
  const reopened = await new HumanTaskService(options).open();
  expect(reopened.get(session.id)).toMatchObject({ status: "interrupted", completions: 1, termination: { success: null, reason: "host_interrupted" } });
  expect(tasks.get(session.id).status).toBe("active");
});

it("live HTTP authority stays in one task and never forwards browser credentials or unscoped writes", async () => {
  const { tasks, session, options, calls } = await fixture();
  const surface = await createHumanTaskSurface({ tasks, sessionId: session.id, productSession: options.productSession });
  cleanups.push(() => surface.close());
  const token = new URL(surface.url).hash.slice(1);
  const request = (path, method = "GET", value, extra = {}) => fetch(surface.origin + path, { method, headers: { Authorization: `Bearer ${token}`, Cookie: "control=forged", ...extra }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  expect((await request("/api/threads/999")).status).toBe(403);
  expect((await request("/api/internal/input-operator-sessions", "POST", {})).status).toBe(403);
  expect((await request("/api/threads", "POST", {})).status).toBe(403);
  expect((await request("/api/threads/1/interactions", "POST", {}, { Origin: "https://foreign.invalid" })).status).toBe(403);
  const state = await (await request("/api/state?threadId=1")).json();
  expect(state.threads.map((thread) => thread.id)).toEqual([1]);
  expect(state.projects.map((project) => project.id)).toEqual([1]);
  expect((await request("/api/threads/1/interactions", "POST", { text: "Follow up" })).status).toBe(201);
  expect(calls.at(-1).headers.Cookie).toBe("control=secret");
  await tasks.finish(session.id, { reason: "budget_exhausted", satisfaction: 2 });
  expect((await request("/api/threads/1/input-draft/attachments", "PUT", {})).status).toBe(403);
});


it("preserves revision queries, counts idempotent invokes once, and locks a post-admission server failure", async () => {
  const f = await fixture();
  await f.tasks.write(f.session.id, "/api/threads/1/context-drafts/context-a/confirm?expectedRevision=7", "POST", null);
  expect(f.calls.at(-1).path).toBe("/api/threads/1/context-drafts/context-a/confirm?expectedRevision=7");
  await f.tasks.write(f.session.id, "/api/threads/1/input-draft/attachments/10/20/30?expectedRevision=8", "DELETE", null);
  expect(f.calls.at(-1).path).toContain("?expectedRevision=8");
  f.replayInvoke();
  await f.tasks.write(f.session.id, "/api/threads/1/interactions/10/actions/22/invoke", "POST", {});
  expect(f.tasks.get(f.session.id).completions).toBe(1);
  f.failServer();
  expect((await f.tasks.write(f.session.id, "/api/threads/1/interactions", "POST", {})).status).toBe(500);
  expect(f.tasks.get(f.session.id)).toMatchObject({ completions: 2, status: "interrupted", termination: { reason: "product_write_unknown" } });
  const exported = await f.tasks.export(f.session.id);
  expect(exported.bundle.conversationEvidence).toBe("unavailable-after-interruption");
});

it("prepares a real catalog project case with its fixture, separate thread steps and pinned permissions", async () => {
  const { createServer } = await import("node:http");
  const { EvalService } = await import("../desktop/eval-main/eval-service.mjs");
  const { H3_PROJECT_CASE_ID, H3_REPOSITORY_URL, H3_UPSTREAM_COMMIT, H3_UPSTREAM_TREE, H3_SEEDED_COMMIT, H3_SEEDED_TREE, H3_PACKAGE_MANAGER } = await import("@relayer/eval-runner");
  const directory = await mkdtemp(join(tmpdir(), "human-project-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const received = [];
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    received.push({ path: request.url, input });
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(request.url === "/api/projects" ? { id: 7, path: input.path }
      : request.url === "/api/model-settings" ? { defaults: { harnessId: "fixture-human-task" }, harnesses: [{ id: "fixture-human-task", available: true }], providers: [], families: [] }
        : { id: received.length, rootInteractionId: 100 + received.length }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  let materialized;
  const service = await new EvalService({
    stateFile: join(directory, "runs.json"), platform: "darwin",
    configurationPaths: ["harnesses/fixture-human-task.yaml"],
    productSession: { origin: `http://127.0.0.1:${server.address().port}`, cookie: { name: "control", value: "test" } },
    projectFixtureMaterializer: async ({ workspaceDirectory }) => {
      materialized = workspaceDirectory;
      await mkdir(workspaceDirectory, { recursive: true });
      return { schemaVersion: 1, fixtureId: H3_PROJECT_CASE_ID, workspaceDirectory, repositoryUrl: H3_REPOSITORY_URL, upstreamCommit: H3_UPSTREAM_COMMIT, upstreamTree: H3_UPSTREAM_TREE, seededCommit: H3_SEEDED_COMMIT, seededTree: H3_SEEDED_TREE, packageManager: H3_PACKAGE_MANAGER, installedWithFrozenLockfile: true };
    },
  }).open();
  const prepared = await service.prepareHumanTask({ testCaseId: H3_PROJECT_CASE_ID, harnessConfigurationName: "fixture-human-task", sessionId: "human-project" });
  expect(prepared.plan).toHaveLength(3);
  expect(prepared.execution.projectId).toBe(7);
  expect(received[0].input.path).toBe(materialized);
  for (let step = 0; step < 3; step++) await service.createHumanTaskThread(prepared, step);
  const creates = received.filter((request) => request.path === "/api/threads");
  expect(creates.map(({ input }) => input.initialMessage)).toEqual(prepared.plan.map((step) => step.prompts[0]));
  expect(creates.every(({ input }) => input.projectId === 7 && input.permissionProfileId === "auto")).toBe(true);
  const interactive = await service.prepareHumanTask({ testCaseId: "interactive.planning.group-europe-trip", harnessConfigurationName: "fixture-human-task", sessionId: "human-interactive" });
  expect(interactive.humanBrief).toContain("$4,500");
  expect(interactive.humanRubric).toContain("graph");
  await service.createHumanTaskThread(interactive, 0);
  const sent = received.filter((request) => request.path === "/api/threads").at(-1).input;
  expect(sent.initialMessage).toBe("Help me plan a Europe trip with some friends. Can we figure it out together?");
  expect(JSON.stringify(sent)).not.toContain("$4,500");
  expect(JSON.stringify(sent)).not.toContain("September 5");
  expect(interactive.execution.fixture).toBeUndefined();

});


it("does not label a partial multi-thread export as a frozen completed session after restart", async () => {
  const f = await fixture({ steps: 2 });
  await f.tasks.nextStep(f.session.id);
  await f.tasks.grade(f.session.id, { satisfaction: 4, comment: "Saved before finish" });
  f.failExport();
  await expect(f.tasks.finish(f.session.id, { reason: "endpoint_reached", satisfaction: 3 })).rejects.toThrow("freeze");
  expect(f.tasks.get(f.session.id)).toMatchObject({ status: "active", satisfaction: { value: 4, comment: "Saved before finish" }, termination: null });
  expect(f.tasks.get(f.session.id).grades).toHaveLength(1);
  expect(f.tasks.get(f.session.id).conversations).toBeUndefined();
  const reopened = await new HumanTaskService(f.options).open();
  const exported = await reopened.export(f.session.id);
  expect(exported.bundle.conversationEvidence).toBe("unavailable-after-interruption");
  expect(exported.bundle.session.events.at(-2).kind).toBe("finish_failed");
});

it("saves live grades and graph moments without ending interaction, and finishes without a rating", async () => {
  const { tasks, session, calls } = await fixture();
  const id = session.id;
  const eventId = await tasks.observe(id, { threadId: 1, turnId: 10, layerId: 5, selectedNodeId: 6, graphVisible: true, observedAt: Date.now(), content: "Graph" });
  const before = calls.length;
  await tasks.grade(id, { satisfaction: 2, comment: "Too generic" });
  await tasks.annotate(id, { eventId, comment: "This node should ask about mobility" });
  expect(calls).toHaveLength(before); // Feedback never goes to the product/model.
  expect(tasks.get(id)).toMatchObject({ status: "active", completions: 1, satisfaction: { value: 2 } });
  await expect(tasks.annotate(id, { eventId: "foreign", comment: "No" })).rejects.toThrow("recorded moment");
  expect((await tasks.write(id, "/api/threads/1/interactions", "POST", { text: "We need accessible transport" })).status).toBe(201);
  await tasks.grade(id, { satisfaction: 4, comment: "Better" });
  const finished = await tasks.finish(id, { reason: "satisfied" });
  expect(finished.satisfaction.value).toBe(4);
  expect(finished.grades.map(grade => grade.value)).toEqual([2, 4]);
  const first = await tasks.export(id);
  await tasks.grade(id, { satisfaction: 3, comment: "After reviewing" });
  expect((await tasks.export(id)).sha256).not.toBe(first.sha256);
  expect(JSON.parse(await readFile(first.path, "utf8")).session.satisfaction.value).toBe(4);
  const unrated = await fixture();
  expect((await unrated.tasks.finish(unrated.session.id, { reason: "satisfied" })).satisfaction).toBeNull();
});

it("does not qualify a late-opened second thread using an earlier thread's observer", async () => {
  const { tasks, session } = await fixture({ steps: 2 });
  const observe = (threadId, turnId, observedAt) => tasks.observe(session.id, { threadId, turnId, layerId: 1, graphVisible: true, content: "Graph", observedAt });
  await observe(1, 10, Date.now() - 1000);
  await tasks.nextStep(session.id);
  await observe(2, 20, Date.now() + 1000);
  expect(tasks.get(session.id).responseTimings.find(timing => timing.interactionId === 20).observerPresentBeforeSubmission).toBe(false);
  await tasks.grade(session.id, { satisfaction: 2, comment: "Early grade" });
  const final = await tasks.finish(session.id, { reason: "satisfied", satisfaction: 4, comment: "Legacy finish grade" });
  expect(final.grades.map(grade => grade.value)).toEqual([2, 4]);
  expect(final.grades[1]).toMatchObject({ at: expect.any(String), author: expect.any(Object) });
});


it("persists a live workspace split across scoped origins without granting settings authority", async () => {
  const { tasks, session, options } = await fixture();
  const start = async () => {
    const surface = await createHumanTaskSurface({ tasks, sessionId: session.id, productSession: options.productSession,
      presentationSettings: createSettingsStore(dirname(options.stateFile)) });
    cleanups.push(() => surface.close());
    return surface;
  };
  const first = await start();
  const send = (surface, path, method = "GET", value, authenticated = true) => fetch(surface.origin + path, {
    method, headers: authenticated ? { Authorization: `Bearer ${new URL(surface.url).hash.slice(1)}` } : {},
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
  expect((await send(first, "/eval-api/workspace-layout", "POST", 0.64, false)).status).toBe(401);
  expect((await send(first, "/eval-api/workspace-layout", "POST", { workspaceSplitRatio: 0.64, providerId: "forged" })).status).toBe(400);
  expect((await send(first, "/eval-api/workspace-layout", "POST", 0.64)).status).toBe(200);
  const reopened = await start();
  expect(reopened.origin).not.toBe(first.origin);
  expect(await (await send(reopened, "/eval-api/workspace-layout")).json()).toBe(0.64);
  expect((await send(reopened, "/api/model-settings/defaults", "PUT", { providerId: "forged" })).status).toBe(403);
  expect(tasks.get(session.id).completions).toBe(1);
});


it("records an ambiguous opening dispatch as interrupted with its reserved budget", async () => {
  const f = await fixture();
  f.options.evalService.createHumanTaskThread = async () => { throw new Error("Response lost after dispatch"); };
  await expect(f.tasks.create({ maxCompletions: 2, endpoint: "A result" })).rejects.toThrow("Response lost");
  expect(f.tasks.list()[0]).toMatchObject({ status: "interrupted", completions: 1, termination: { reason: "product_write_unknown", success: null } });
});

it("admits scoped retries of failed unsent attempts with a pinned model and spent budget", async () => {
  const f = await fixture();
  f.threads.get(1)[0] = { id: 10, completionStatus: "not_started", latestAttempt: { id: 91, outcome: "model_failed" } };
  const fetchImpl = f.tasks.fetchImpl;
  f.tasks.fetchImpl = (url, init) => {
    if (!url.pathname.endsWith("/retry")) return fetchImpl(url, init);
    const interaction = { id: 10, completionStatus: "running", latestAttempt: { id: 92 } };
    f.threads.get(1)[0] = interaction;
    return Promise.resolve(Response.json(interaction));
  };
  await expect(f.tasks.write(f.session.id, "/api/threads/2/interactions/10/retry", "POST", { attemptId: 91 })).rejects.toThrow("outside");
  await expect(f.tasks.write(f.session.id, "/api/threads/1/interactions/10/retry", "POST", { attemptId: 91, modelSelection: { providerId: "other" } })).rejects.toThrow("starting model");
  expect((await f.tasks.write(f.session.id, "/api/threads/1/interactions/10/retry", "POST", { attemptId: 91 })).status).toBe(200);
  expect(f.tasks.get(f.session.id).completions).toBe(2);
  expect(f.tasks.get(f.session.id).events.at(-1).request.modelSelection.providerId).toBe("pinned");
  f.tasks.find(f.session.id).events[0].at = new Date(1000).toISOString();
  const submission = f.tasks.get(f.session.id).events.at(-1);
  await f.tasks.observe(f.session.id, { threadId: 1, turnId: 10, graphVisible: true, content: "Retried graph", observedAt: Date.parse(submission.at) + 100 });
  expect(f.tasks.get(f.session.id).firstVisibleGraph).toMatchObject({ submissionEventId: submission.id, latencyMs: 100 });
  expect(f.tasks.get(f.session.id).responseTimings[0]).toMatchObject({ submissionEventId: submission.id, latencyMs: 100 });
  await expect(f.tasks.finish(f.session.id, { reason: "budget_exhausted" })).rejects.toThrow("Wait");
  f.threads.get(1)[0] = { id: 10, completionStatus: "not_started", latestAttempt: { id: 92, outcome: "model_failed" } };
  await expect(f.tasks.write(f.session.id, "/api/threads/1/interactions/10/retry", "POST", { attemptId: 92 })).rejects.toThrow("limit");
  await f.tasks.finish(f.session.id, { reason: "budget_exhausted" });
});

it("rolls back failed grade and annotation persistence before retry", async () => {
  const f = await fixture();
  await f.tasks.grade(f.session.id, { satisfaction: 2, comment: "Saved" });
  const persist = vi.spyOn(f.tasks, "persist").mockRejectedValueOnce(new Error("Disk full"));
  await expect(f.tasks.grade(f.session.id, { satisfaction: 4, comment: "Not saved" })).rejects.toThrow("Disk full");
  expect(f.tasks.get(f.session.id).grades).toHaveLength(1);
  expect(f.tasks.get(f.session.id).satisfaction.value).toBe(2);
  persist.mockRejectedValueOnce(new Error("Disk full"));
  await expect(f.tasks.annotate(f.session.id, { eventId: f.session.events[0].id, comment: "Not saved" })).rejects.toThrow("Disk full");
  expect(f.tasks.get(f.session.id).annotations).toHaveLength(0);
  persist.mockRestore();
  await f.tasks.grade(f.session.id, { satisfaction: 4, comment: "Retry saved" });
  expect(f.tasks.get(f.session.id).grades).toHaveLength(2);
});

it("exports interrupted evidence even when the possibly dispatched completion remains running", async () => {
  const f = await fixture();
  f.failTransport();
  await expect(f.tasks.write(f.session.id, "/api/threads/1/interactions", "POST", {})).rejects.toThrow();
  f.threads.get(1)[0].completionStatus = "running";
  expect((await f.tasks.export(f.session.id)).bundle.conversationEvidence).toBe("unavailable-after-interruption");
});

it("attributes first visible graph to its matching later submission", async () => {
  const f = await fixture({ steps: 2 });
  f.tasks.find(f.session.id).events[0].at = new Date(1000).toISOString();
  await f.tasks.nextStep(f.session.id);
  const submission = f.tasks.get(f.session.id).events.find(event => event.kind === "submission" && event.threadId === 2);
  await f.tasks.observe(f.session.id, { threadId: 2, turnId: 20, graphVisible: true, content: "Later graph", observedAt: Date.parse(submission.at) + 100 });
  expect(f.tasks.get(f.session.id).firstVisibleGraph.latencyMs).toBe(100);
});

it("removes a final step check when export fails", async () => {
  const f = await fixture({ steps: 2 }); await f.tasks.nextStep(f.session.id); f.failExport();
  await expect(f.tasks.finish(f.session.id, { reason: "endpoint_reached" })).rejects.toThrow("freeze");
  expect(f.tasks.get(f.session.id).stepChecks).toHaveLength(1);
});
it("does not include frozen evidence in list summaries", async () => {
  const f = await fixture(); await f.tasks.finish(f.session.id, { reason: "satisfied" });
  expect(f.tasks.list()[0]).not.toHaveProperty("conversations");
  expect(f.tasks.list()[0]).not.toHaveProperty("stepChecks");
});


it("validates only the task model using semantic write authority without spending a completion", async () => {
  const f = await fixture();
  const model = { harnessId: "fixture", familyId: 1, providerId: "pinned", modelId: "model" };
  expect((await f.tasks.write(f.session.id, "/api/model-selection/validate", "POST", model)).status).toBe(200);
  expect(f.calls.at(-1).headers.Cookie).toBe("control=secret");
  expect(f.tasks.get(f.session.id).completions).toBe(1);
  await expect(f.tasks.write(f.session.id, "/api/model-selection/validate", "POST", { ...model, providerId: "other" })).rejects.toThrow("starting model");
  await expect(f.tasks.write(f.session.id, "/api/model-selection/validate", "POST", { ...model, harnessId: "other" })).rejects.toThrow("starting harness");
});


it("leaves finish retryable when persisting its initial transition fails", async () => {
  const f = await fixture();
  const persist = vi.spyOn(f.tasks, "persist").mockRejectedValueOnce(new Error("Disk full"));
  await expect(f.tasks.finish(f.session.id, { reason: "satisfied" })).rejects.toThrow("Disk full");
  expect(f.tasks.get(f.session.id)).toMatchObject({ status: "active", stepChecks: [] });
  persist.mockRestore();
  expect((await f.tasks.finish(f.session.id, { reason: "satisfied" })).status).toBe("completed");
});


it("rolls back an unpersisted write reservation before any product dispatch", async () => {
  const f = await fixture();
  const before = f.tasks.get(f.session.id);
  const persist = vi.spyOn(f.tasks, "persist").mockRejectedValueOnce(new Error("Disk full"));
  await expect(f.tasks.write(f.session.id, "/api/threads/1/interactions", "POST", { text: "Refine" })).rejects.toThrow("Disk full");
  expect(f.tasks.get(f.session.id)).toMatchObject({ status: "active", completions: before.completions, events: before.events });
  expect(f.calls.filter(call => call.method === "POST")).toHaveLength(0);
  persist.mockRestore();
  expect((await f.tasks.write(f.session.id, "/api/threads/1/interactions", "POST", { text: "Refine" })).status).toBe(201);
  expect(f.tasks.get(f.session.id).completions).toBe(2);
  expect(f.tasks.get(f.session.id).events).toHaveLength(before.events.length + 1);
});

it.each(["write", "nextStep"])("cancellation during %s reservation refunds only proven undispatched work", async (kind) => {
  const f = await fixture({ steps: 2 });
  const controller = new AbortController();
  const persist = f.tasks.persist.bind(f.tasks);
  f.tasks.persist = async () => { await persist(); if (f.tasks.find(f.session.id).events.at(-1)?.outcome === "pending" || f.tasks.find(f.session.id).events.at(-1)?.initial) controller.abort(); };
  const request = kind === "write" ? f.tasks.write(f.session.id, "/api/threads/1/interactions", "POST", { text: "Refine" }, { signal: controller.signal }) : f.tasks.nextStep(f.session.id, { signal: controller.signal });
  await expect(request).rejects.toMatchObject({ name: "AbortError" });
  expect(f.threads.size).toBe(1);
  expect(f.calls.some(call => call.method === "POST")).toBe(false);
  expect(f.tasks.get(f.session.id)).toMatchObject({ status: "active", completions: 1, step: 0, stepChecks: [], termination: null });
  expect(f.tasks.get(f.session.id).events.at(-1).outcome).toBe("cancelled_before_dispatch");
});

it.each(["nextStep", "finish"])("Stop releases a noncooperative %s grading callback without later dispatch", async (method) => {
  const f = await fixture({ steps: 2 });
  let started, release;
  const entered = new Promise(resolve => { started = resolve; });
  f.tasks.evalService.gradeHumanTaskStep = () => { started(); return new Promise(resolve => { release = resolve; }); };
  const controller = new AbortController();
  const pending = method === "nextStep" ? f.tasks.nextStep(f.session.id, { signal: controller.signal }) : f.tasks.finish(f.session.id, { reason: "satisfied" }, { signal: controller.signal });
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await entered; controller.abort(); await rejected;
  await f.tasks.grade(f.session.id, { satisfaction: 2, comment: "Queue remains usable" });
  release({ passed: true }); await new Promise(resolve => setImmediate(resolve));
  expect(f.threads.size).toBe(1);
  expect(f.tasks.get(f.session.id)).toMatchObject({ status: "active", completions: 1, stepChecks: [] });
  expect(f.calls.some(call => call.path.endsWith("/export"))).toBe(false);
});

it("Stop aborts presentation capture and releases session admission", async () => {
  const f = await fixture();
  let started; const entered = new Promise(resolve => { started = resolve; });
  f.tasks.fetchImpl = (_url, { signal }) => { started(); return new Promise((_resolve, reject) => { signal.addEventListener("abort", () => reject(signal.reason), { once: true }); }); };
  const controller = new AbortController();
  const pending = f.tasks.observe(f.session.id, { threadId: 1, turnId: 10, observedAt: Date.now(), content: "visible" }, { signal: controller.signal });
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await entered; controller.abort(); await rejected;
  await f.tasks.grade(f.session.id, { satisfaction: 1, comment: "No captured moment" });
  expect(f.tasks.get(f.session.id).events.some(event => event.kind === "presentation")).toBe(false);
});

it("rejects external catalog drift before admitting a follow-up completion", async () => {
  const { tasks, session, calls, options } = await fixture();
  options.evalService.assertHumanTaskCatalog = async () => { throw new Error("External catalog changed"); };
  const before = tasks.get(session.id).completions;
  await expect(tasks.write(session.id, "/api/threads/1/interactions", "POST", { text: "Refine" })).rejects.toThrow("External catalog changed");
  expect(tasks.get(session.id).completions).toBe(before);
  expect(calls.some(call => call.method === "POST" && call.path.endsWith("/interactions"))).toBe(false);
});

it("Stop releases a stalled external catalog check before follow-up admission", async () => {
  const f = await fixture();
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  f.tasks.evalService.assertHumanTaskCatalog = () => { entered(); return new Promise(resolve => { release = resolve; }); };
  const controller = new AbortController();
  const before = f.tasks.get(f.session.id).completions;
  const pending = f.tasks.write(f.session.id, "/api/threads/1/interactions", "POST", { text: "Refine" }, { signal: controller.signal });
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await started; controller.abort(); await rejected;
  await f.tasks.grade(f.session.id, { satisfaction: 2, comment: "Queue released" });
  release(); await new Promise(resolve => setImmediate(resolve));
  expect(f.tasks.get(f.session.id).completions).toBe(before);
  expect(f.calls.some(call => call.method === "POST")).toBe(false);
});

async function gatedTask() {
  const f = await fixture();
  const session = f.tasks.find(f.session.id);
  session.mode = "simulated";
  session.actor = { maxActions: 5 };
  session.actorSetup = { behaviorContract: { completionJudge: { version: "completion-judge-v1", model: "strong", modelReasoningEffort: "high" } } };
  return f;
}
async function judgedFinish(f, verdict = "complete") {
  const action = await f.tasks.actorEvent(f.session.id, "actor_action", { observationEventId: "visible", action: { kind: "finish", reason: "satisfied", endpointStatus: "incomplete", remainingWork: "User thinks work remains", satisfaction: 3 } });
  const evidence = await f.tasks.actorEvent(f.session.id, "actor_completion_evidence", { actorActionEventId: action.id, observationEventId: "visible", judge: f.tasks.get(f.session.id).actorSetup.behaviorContract.completionJudge, evidence: { artifactEvidence: {} } });
  const judgment = await f.tasks.actorEvent(f.session.id, "actor_completion_judgment", { actorActionEventId: action.id, observationEventId: "visible", judge: f.tasks.get(f.session.id).actorSetup.behaviorContract.completionJudge, evidenceEventId: evidence.id, verdict });
  return { reason: "endpoint_reached", actorActionEventId: action.id, completionJudgeEventId: judgment.id };
}

it("gates normal finishes on the latest exact completion judgment and freezes the original claim", async () => {
  const f = await gatedTask(); const id = f.session.id;
  for (const reason of ["satisfied", "abandoned", "endpoint_reached", "budget_exhausted"]) await expect(f.tasks.finish(id, { reason })).rejects.toThrow();
  await expect(f.tasks.finish(id, await judgedFinish(f, "incomplete"))).rejects.toThrow("completion judgment");
  const stale = await judgedFinish(f);
  await f.tasks.actorEvent(id, "actor_action", { action: { kind: "click", ref: "visible" } });
  await expect(f.tasks.finish(id, stale)).rejects.toThrow("completion judgment");
  const superseded = await judgedFinish(f);
  await f.tasks.actorEvent(id, "actor_completion_judgment", { actorActionEventId: superseded.actorActionEventId, verdict: "uncertain" });
  await expect(f.tasks.finish(id, superseded)).rejects.toThrow("completion judgment");
  const accepted = await judgedFinish(f);
  const judgment = f.tasks.find(id).events.find(event => event.id === accepted.completionJudgeEventId);
  const evidenceId = judgment.evidenceEventId; judgment.evidenceEventId = "missing";
  await expect(f.tasks.finish(id, accepted)).rejects.toThrow("completion judgment");
  judgment.evidenceEventId = evidenceId;
  const result = await f.tasks.finish(id, accepted);
  expect(result.termination).toMatchObject({ endpointAttainment: "judge_reported", success: null, completionJudgeEventId: accepted.completionJudgeEventId, actorClaim: { reason: "satisfied", endpointStatus: "incomplete", satisfaction: 3 } });
  const reopened = await new HumanTaskService(f.options).open();
  expect((await reopened.export(id)).bundle.session.termination).toEqual(result.termination);
});

it("does not reuse judgment after submission or accept another judge identity", async () => {
  const f = await gatedTask(); const id = f.session.id;
  const prior = await judgedFinish(f);
  await f.tasks.write(id, "/api/threads/1/interactions", "POST", { text: "More work" });
  await expect(f.tasks.finish(id, prior)).rejects.toThrow("completion judgment");
  const latest = await judgedFinish(f);
  f.tasks.find(id).events.find(event => event.id === latest.completionJudgeEventId).judge.model = "other";
  await expect(f.tasks.finish(id, latest)).rejects.toThrow("completion judgment");
  expect((await f.tasks.finish(id, { reason: "budget_exhausted" })).termination.endpointAttainment).toBe("not_claimed");
});

it("builds bounded completion evidence without grades and rechecks settled state after artifact reads", async () => {
  const f = await gatedTask(); const id = f.session.id;
  Object.assign(f.tasks.find(id).prepared, { humanBrief: "Private taste", humanRubric: "HIDDEN_RUBRIC" });
  await f.tasks.grade(id, { satisfaction: 1, comment: "HIDDEN_GRADE" });
  await f.tasks.actorEvent(id, "actor_action", { action: { kind: "fill", value: "x".repeat(10000), secret: "HIDDEN_ACTION_FIELD" }, usage: { hidden: "HIDDEN_USAGE" } });
  f.options.evalService.completionJudgeArtifactEvidence = vi.fn(async () => ({ files: [{ path: "deliverable.md", content: "Bounded output" }] }));
  f.options.evalService.gradeHumanTaskStep = vi.fn();
  const packet = await f.tasks.completionJudgeEvidence(id);
  expect(packet).toMatchObject({ request: "Build the thing", endpoint: "A working artifact", privateBrief: "Private taste", artifactEvidence: { files: [{ path: "deliverable.md", content: "Bounded output" }] } });
  expect(packet.trajectory[0]).toMatchObject({ kind: "task_progress", currentStep: 1, totalSteps: 1, remainingSteps: 0, completions: 1, maxCompletions: 2 });
  expect(JSON.stringify(packet)).not.toContain("HIDDEN_");
  expect(packet.trajectory.at(-1).action.value.length).toBeLessThan(10000);
  expect(packet.trajectory.at(-1).action.value).toContain("[truncated:");
  for (let i = 0; i < 90; i++) f.tasks.event(f.tasks.find(id), "actor_action", { action: { kind: "fill", value: "界".repeat(5000) } });
  const bounded = await f.tasks.completionJudgeEvidence(id);
  expect(Buffer.byteLength(JSON.stringify(bounded.trajectory))).toBeLessThan(21000);
  expect(bounded.trajectory.at(-1)).toMatchObject({ kind: "evidence_omitted" });
  expect(f.options.evalService.gradeHumanTaskStep).not.toHaveBeenCalled();
  f.options.evalService.completionJudgeArtifactEvidence.mockImplementation(async () => { f.threads.get(1)[0].completionStatus = "running"; return {}; });
  await expect(f.tasks.completionJudgeEvidence(id)).rejects.toThrow("Wait for the current response");
});

it("cancels completion evidence collection without holding the task queue", async () => {
  const f = await gatedTask(); let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  f.options.evalService.completionJudgeArtifactEvidence = () => { enter(); return new Promise(resolve => { release = resolve; }); };
  const controller = new AbortController();
  const pending = f.tasks.completionJudgeEvidence(f.session.id, { signal: controller.signal });
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await entered; controller.abort(); await rejected;
  await f.tasks.interruptActor(f.session.id, "actor_cancelled"); release({});
  expect(f.tasks.get(f.session.id).status).toBe("interrupted");
});

it("v2 judge evidence binds structured participant approval to the committed submission and excludes drafts", async () => {
  const f = await gatedTask(); const session = f.tasks.find(f.session.id);
  session.actorSetup.behaviorContract.completionJudge.evidenceContract = { id: "completion-evidence-v2" };
  f.options.evalService.completionJudgeArtifactEvidence = async () => ({ files: [] });
  await f.tasks.write(session.id, "/api/threads/1/interactions", "POST", { text: "" });
  Object.assign(f.threads.get(1).at(-1), { createdAt: "2026-10-05T15:29:25.591Z", submittedInputs: [{ value: { text: "Garden Table works for us; please proceed." }, action: { prompt: "Choose a restaurant" } }], inputDraft: "UNSENT_DRAFT" });
  const packet = await f.tasks.completionJudgeEvidence(session.id);
  expect(packet.trajectory.find(item => item.kind === "submission" && item.interactionId === 11)).toMatchObject({ participant: "simulated_user", committedAt: "2026-10-05T15:29:25.591Z", submittedInputs: [{ prompt: "Choose a restaurant", value: { text: "Garden Table works for us; please proceed." } }] });
  expect(JSON.stringify(packet)).not.toContain("UNSENT_DRAFT");
  delete session.actorSetup.behaviorContract.completionJudge.evidenceContract;
  expect((await f.tasks.completionJudgeEvidence(session.id)).trajectory.some(item => item.submittedInputs)).toBe(false);
});

it("only the versioned participant-stop contract permits a judged unfinished stop without claiming attainment", async () => {
  const f = await gatedTask(); const id = f.session.id;
  const approved = await judgedFinish(f, "uncertain");
  const input = { ...approved, reason: "satisfied" };
  await expect(f.tasks.finish(id, input)).rejects.toThrow("completion judgment");
  Object.assign(f.tasks.find(id).actorSetup.behaviorContract, { id: "task-actor-v5", participantMayStopIncomplete: true });
  await expect(f.tasks.finish(id, { ...input, reason: "endpoint_reached" })).rejects.toThrow("completion judgment");
  const finished = await f.tasks.finish(id, input);
  expect(finished.termination).toMatchObject({ reason: "satisfied", endpointAttainment: "not_claimed", success: null, completionJudgeEventId: input.completionJudgeEventId, actorClaim: { endpointStatus: "incomplete", remainingWork: "User thinks work remains" } });
});

it("current-native stopping evidence separates live delivery receipts from intents, ambiguity and incorporation", async () => {
  const f = await gatedTask(); const id = f.session.id;
  const session = f.tasks.find(id);
  session.actorSetup.behaviorContract.observationContract = { id: "task-actor-observation-v3" };
  f.options.evalService.completionJudgeArtifactEvidence = async () => ({ files: [] });
  await f.tasks.actorEvent(id, "actor_action", { phase: "current", action: { kind: "fill", value: "Private stage" } });
  await f.tasks.actorEvent(id, "product_action", { path: "/api/threads/1/interactions/10/live-answers", outcome: "accepted", liveAnswerReceipt: {
    sequence: 1, completionId: 7, attemptId: 8, authorityEpoch: 1, currentRevision: 2,
    occurrence: { presentingInteractionNodeId: 7, presentingLayerId: 9, actionId: 11 }, question: { prompt: "Which city?" }, value: { text: "Boston" }, operationKey: "answer-1" } });
  await f.tasks.actorEvent(id, "product_action", { path: "/api/threads/1/interactions/10/live-answers", outcome: "unknown", request: { value: { text: "UNCONFIRMED_VALUE" } } });
  const trajectory = (await f.tasks.completionJudgeEvidence(id)).trajectory;
  expect(trajectory.find(item => item.phase === "current")).toMatchObject({ delivery: "intent_only" });
  expect(trajectory.find(item => item.kind === "live_answer" && item.delivery === "accepted")).toMatchObject({ incorporation: "not_established", attemptId: 8, value: { text: "Boston" }, prompt: "Which city?" });
  expect(trajectory.find(item => item.kind === "live_answer" && item.delivery === "unavailable")).toMatchObject({ outcome: "unknown" });
  expect(JSON.stringify(trajectory)).not.toContain("UNCONFIRMED_VALUE");
  session.actorSetup.behaviorContract.observationContract = { id: "task-actor-observation-v2" };
  expect((await f.tasks.completionJudgeEvidence(id)).trajectory.some(item => item.kind === "live_answer")).toBe(false);
});

it("live-answer gateway transport uncertainty is retry-ambiguous HTTP 503 rather than a known refusal", async () => {
  const f = await fixture(); f.threads.get(1)[0].completionStatus = "running";
  const surface = await createHumanTaskSurface({ tasks: f.tasks, sessionId: f.session.id, productSession: f.options.productSession });
  cleanups.push(() => surface.close());
  f.failTransport();
  const response = await fetch(new URL("/api/threads/1/interactions/10/live-answers", surface.url), {
    method: "POST", headers: { Authorization: `Bearer ${new URL(surface.url).hash.slice(1)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ operationKey: "answer-1", value: { text: "Boston" } }),
  });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: expect.stringContaining("unconfirmed") });
  expect(f.tasks.get(f.session.id)).toMatchObject({ completions: 1, status: "interrupted", termination: { reason: "product_write_unknown" } });
  expect(f.tasks.get(f.session.id).events.find(event => event.kind === "product_action")).toMatchObject({ outcome: "unknown", request: { operationKey: "answer-1" } });
});
