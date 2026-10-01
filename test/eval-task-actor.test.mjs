import { taskActorPresentationReady } from "../desktop/eval-main/task-actor-browser.mjs";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { HumanTaskService } from "../desktop/eval-main/human-task-service.mjs";
import { TaskActorService } from "../desktop/eval-main/task-actor-service.mjs";
import { actorConfiguration, actorPrompt, createCodexTaskActor, validateActorAction } from "../desktop/eval-main/task-actor.mjs";
import { createHumanTaskSurface } from "../desktop/eval-main/web-host.mjs";

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const action = (kind, extra = {}) => ({ kind, ref: "visible", value: "", reason: "", satisfaction: null, comment: "", endpointStatus: "incomplete", remainingWork: "Route undecided", ...extra });
async function fixture({ decide, maxActions = 8, busy = false, failWrite = false, navigateOnly = false, retry = false, timeoutMs = 900000 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "task-actor-test-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const turns = [{ id: 1, completionStatus: busy ? "running" : retry ? "not_started" : "accepted", ...(retry ? { latestAttempt: { id: 91, outcome: "model_failed" } } : {}) }];
  const dispatches = [];
  const options = { stateFile: join(directory, "tasks.json"), productSession: { origin: "http://product.invalid", cookie: { name: "control", value: "secret" }, readOnlyCookie: { name: "read", value: "only" } },
    evalService: {
      prepareHumanTask: async () => ({ name: "Task", humanBrief: "PRIVATE BRIEF", humanRubric: "SECRET RUBRIC", execution: { harnessConfigurationName: "fixture", projectId: 1, modelResolution: {} }, plan: [{ name: "Task", prompts: ["Help me plan a trip"] }] }),
      createHumanTaskThread: async () => ({ id: 1, rootInteractionId: 1 }),
      gradeHumanTaskStep: async () => ({ passed: false }),
    },
    fetchImpl: async (url, init) => {
      if (init.method === "POST") {
        dispatches.push(url.pathname);
        if (failWrite) throw new Error("Ambiguous response");
        if (retry) turns[0] = { id: 1, completionStatus: "accepted", latestAttempt: { id: 92, outcome: "accepted" } };
        else turns.push({ id: turns.length + 1, completionStatus: "accepted" });
        return Response.json(turns.at(-1));
      }
      if (url.pathname.endsWith("/export")) return new Response("frozen conversation");
      return Response.json({ interactions: turns });
    },
  };
  const tasks = await new HumanTaskService(options).open();
  const seen = [];
  let id;
  let browserSignal;
  const browser = {
    observe: vi.fn(async () => ({ text: turns.length > 1 ? "A trip plan based on your reply" : "Where do you want to go?", controls: [{ ref: "visible", name: "Send" }] })),
    act: vi.fn(async () => { if (navigateOnly) return; await tasks.write(id, retry ? "/api/threads/1/interactions/1/retry" : "/api/threads/1/interactions", "POST", { text: "Somewhere warm", ...(retry ? { attemptId: 91 } : {}) }, { signal: browserSignal }); }),
    close: vi.fn(),
  };
  const actors = new TaskActorService({ tasks, pollMs: 1, deadlineMs: timeoutMs, resolveRuntime: async () => ({}), openBrowser: async (_id, signal) => { browserSignal = signal; return browser; },
    createActor: async ({ prompt }) => ({ decide: async (observation, signal) => {
      seen.push({ prompt, observation });
      return { action: decide ? await decide(observation, signal) : turns.length === 1 ? action("click") : action("finish", { reason: "satisfied", satisfaction: 3, comment: "Good enough" }), usage: { input_tokens: 10, output_tokens: 5 } };
    }, close: vi.fn() }),
  });
  cleanups.push(() => actors.close());
  const task = await actors.create({ maxCompletions: 2, endpoint: "A trip plan", actor: { maxActions } }); id = task.id;
  const done = actors.running.get(id).done;
  return { tasks, actors, id, done, seen, browser, dispatches, turns, options };
}

it("adapts to successive rendered states through session admission, then preserves independent actor and human evidence", async () => {
  const f = await fixture(); await f.done;
  const task = f.tasks.get(f.id);
  expect(f.dispatches).toEqual(["/api/threads/1/interactions"]);
  expect(task).toMatchObject({ mode: "simulated", status: "completed", completions: 2, satisfaction: null, actor: { model: "gpt-5.6-luna", modelReasoningEffort: "low" }, termination: { reason: "satisfied", success: null } });
  expect(f.seen.map((v) => v.observation.text)).toEqual(["Where do you want to go?", "A trip plan based on your reply"]);
  expect(f.seen[0].prompt).toContain("PRIVATE BRIEF");
  expect(JSON.stringify(f.seen)).not.toMatch(/SECRET RUBRIC|frozen conversation/);
  expect(JSON.stringify(f.seen.map(v => v.observation))).not.toContain("PRIVATE BRIEF");
  expect(task.events.find((v) => v.kind === "actor_satisfaction")).toMatchObject({ scale: "actor-1-4", value: 3 });
  const submission = task.events.findIndex((v) => v.kind === "submission" && !v.initial);
  expect(task.events[submission - 1].kind).toBe("actor_action");
  const reopened = await new HumanTaskService(f.options).open();
  await reopened.grade(f.id, { satisfaction: 1, comment: "Human disagrees" });
  const { bundle } = await reopened.export(f.id);
  expect(bundle.session.satisfaction.value).toBe(1);
  expect(bundle.session.events.find((v) => v.kind === "actor_satisfaction").value).toBe(3);
  expect(bundle.session.stepChecks[0].checks.passed).toBe(false);
  expect(f.browser.close).toHaveBeenCalledOnce();
});

it("waits for product settlement and cancellation does not execute a queued actor action", async () => {
  const f = await fixture({ busy: true });
  await new Promise((resolve) => setTimeout(resolve, 15));
  expect(f.browser.observe).not.toHaveBeenCalled();
  await f.actors.stop(f.id);
  expect(f.dispatches).toEqual([]);
  expect(f.tasks.get(f.id)).toMatchObject({ status: "interrupted", termination: { reason: "actor_cancelled", success: null } });
});

it("never replays uncertain product submissions and retains the reserved completion", async () => {
  const f = await fixture({ failWrite: true }); await f.done;
  expect(f.dispatches).toHaveLength(1);
  expect(f.tasks.get(f.id)).toMatchObject({ completions: 2, status: "interrupted", termination: { reason: "product_write_unknown" } });
  const reopened = await new HumanTaskService(f.options).open();
  expect(reopened.get(f.id).completions).toBe(2);
});

it("bounds navigation and interrupts invalid decisions without executing them", async () => {
  const f = await fixture({ decide: () => action("shell"), maxActions: 1 }); await f.done;
  expect(f.browser.act).not.toHaveBeenCalled();
  expect(f.tasks.get(f.id).status).toBe("interrupted");
});

it("actor capability omits all evaluator context and cannot grade, annotate or open other scopes", async () => {
  const f = await fixture({ busy: true });
  const surface = await createHumanTaskSurface({ tasks: f.tasks, sessionId: f.id, productSession: f.options.productSession, actor: true });
  cleanups.push(() => surface.close());
  const headers = { Authorization: `Bearer ${new URL(surface.url).hash.slice(1)}` };
  const get = await fetch(new URL("/eval-api/task", surface.url), { headers });
  expect(JSON.stringify(await get.json())).not.toMatch(/PRIVATE BRIEF|SECRET RUBRIC|endpoint|actor|events|annotation|grade/);
  expect((await fetch(new URL("/api/threads/1/annotations", surface.url), { headers })).status).toBe(403);
  for (const path of ["/eval-api/grade", "/eval-api/finish", "/eval-api/annotate", "/api/threads/2/interactions", "/api/threads/1/annotations", "/api/internal/annotation-sessions", "/eval-api/openSettings"]) {
    const result = await fetch(new URL(path, surface.url), { method: "POST", headers, body: "{}" });
    expect(result.status, path).toBe(403);
  }
});

it("pins the actor runtime with no filesystem, shell, network or MCP tools and keeps credentials out of the prompt", async () => {
  const config = actorConfiguration();
  const prompt = actorPrompt({ config, request: "Help", endpoint: "A plan" });
  let options; let threadOptions;
  const actor = await createCodexTaskActor({ runtime: { executable: "/managed/codex", environment: { CODEX_HOME: "/owned", OPENAI_API_KEY: "secret", PATH: "/bin" } }, config, prompt,
    createCodex: (value) => { options = value; return { startThread: (value) => { threadOptions = value; return { run: async () => ({ finalResponse: JSON.stringify(action("finish", { reason: "abandoned", satisfaction: 1 })), items: [], usage: null }) }; } }; },
  });
  cleanups.push(() => actor.close());
  await actor.decide({ text: "Visible" });
  expect(options.env).not.toHaveProperty("OPENAI_API_KEY");
  expect(options.config.features).toMatchObject({ shell_tool: false, unified_exec: false, browser_use: false, computer_use: false, multi_agent: false });
  expect(options.config.mcp_servers).toEqual({});
  expect(threadOptions).toMatchObject({ model: "gpt-5.6-luna", modelReasoningEffort: "low", networkAccessEnabled: false, webSearchMode: "disabled", additionalDirectories: [] });
});

it("ends bounded exploration without claiming endpoint success", async () => {
  const f = await fixture({ decide: () => action("click"), maxActions: 2, navigateOnly: true }); await f.done;
  expect(f.browser.act).toHaveBeenCalledTimes(2);
  expect(f.browser.observe).toHaveBeenCalledTimes(3);
  expect(f.seen).toHaveLength(2);
  expect(f.tasks.get(f.id)).toMatchObject({ status: "completed", completions: 1, termination: { reason: "abandoned", success: null } });
  expect(f.tasks.get(f.id).events.some((event) => event.kind === "actor_limit")).toBe(true);
});

it("cancels a decision durably queued before dispatch", async () => {
  const f = await fixture();
  const original = f.tasks.actorEvent.bind(f.tasks);
  let reached; const atIntent = new Promise((resolve) => { reached = resolve; });
  let release; const gate = new Promise((resolve) => { release = resolve; });
  f.tasks.actorEvent = async (...args) => { const result = await original(...args); if (args[1] === "actor_action") { reached(); await gate; } return result; };
  await atIntent;
  const stopped = f.actors.stop(f.id);
  release(); await stopped;
  expect(f.browser.act).not.toHaveBeenCalled();
  expect(f.dispatches).toEqual([]);
  expect(f.tasks.get(f.id).termination.reason).toBe("actor_cancelled");
});

it("deadline aborts native decisions and preserves partial evidence without replay", async () => {
  const f = await fixture({ timeoutMs: 1000, decide: (_observation, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })) });
  await f.done;
  expect(f.browser.act).not.toHaveBeenCalled();
  expect(f.tasks.get(f.id)).toMatchObject({ status: "interrupted", completions: 1, termination: { reason: "actor_timeout" } });
  expect(f.tasks.get(f.id).events.some((event) => event.kind === "actor_observation")).toBe(true);
});

it("Stop during satisfaction persistence cannot turn interruption into completion", async () => {
  const f = await fixture({ decide: () => action("finish", { reason: "satisfied", satisfaction: 3 }) });
  const original = f.tasks.actorEvent.bind(f.tasks);
  let reached; const pending = new Promise((resolve) => { reached = resolve; });
  let release; const gate = new Promise((resolve) => { release = resolve; });
  f.tasks.actorEvent = async (...args) => { const result = await original(...args); if (args[1] === "actor_satisfaction") { reached(); await gate; } return result; };
  await pending;
  const stopped = f.actors.stop(f.id); release(); await stopped;
  expect(f.tasks.get(f.id)).toMatchObject({ status: "interrupted", termination: { reason: "actor_cancelled" } });
});

it.each(["read", "write"])("Stop aborts a pending product %s and releases session admission", async (kind) => {
  const f = await fixture();
  const fetchImpl = f.tasks.fetchImpl;
  let reached; const pending = new Promise((resolve) => { reached = resolve; });
  f.tasks.fetchImpl = (url, options) => {
    if ((kind === "write") === (options.method === "POST")) {
      expect(options.signal).toBeDefined();
      reached();
      return new Promise((_resolve, reject) => {
        options.signal.throwIfAborted();
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      });
    }
    return fetchImpl(url, options);
  };
  await pending; await f.actors.stop(f.id);
  expect(f.tasks.get(f.id)).toMatchObject({ status: "interrupted", completions: kind === "write" ? 2 : 1, termination: { reason: kind === "write" ? "product_write_unknown" : "actor_cancelled" } });
  await expect(f.tasks.actorEvent(f.id, "forbidden", {})).rejects.toThrow("not active");
});


it("requires the settled retry attempt in the rendered presentation even with a newer paint timestamp", () => {
  const expected = { threadId: 1, turnId: 7, submittedAt: 1000, attemptId: 92 };
  const old = { threadId: 1, turnId: 7, observedAt: 1100, completionStatus: "not_started", attemptId: 91, attemptOutcome: "model_failed" };
  expect(taskActorPresentationReady({ expected, presentation: old })).toBe(false);
  expect(taskActorPresentationReady({ expected, presentation: { ...old, attemptId: 92, attemptOutcome: null } })).toBe(false);
  expect(taskActorPresentationReady({ expected, presentation: { ...old, attemptId: 92 } })).toBe(true);
  expect(taskActorPresentationReady({ expected, presentation: { ...old, attemptId: 92, attemptOutcome: "accepted", completionStatus: "accepted" } })).toBe(true);
});


it("supplies the actual settled retry attempt to the browser readiness gate", async () => {
  let decision = 0;
  const f = await fixture({ retry: true, decide: () => decision++ === 0 ? action("click") : action("finish", { reason: "satisfied", satisfaction: 3 }) });
  await f.done;
  expect(f.tasks.get(f.id).status).toBe("completed");
  expect(f.browser.observe.mock.calls.map(([expected]) => expected.attemptId)).toEqual([91, 92]);
  const [expected] = f.browser.observe.mock.calls[1];
  const stale = { threadId: 1, turnId: 1, attemptId: 91, attemptOutcome: "model_failed", completionStatus: "not_started", observedAt: expected.submittedAt + 100 };
  expect(taskActorPresentationReady({ expected, presentation: stale })).toBe(false);
  expect(taskActorPresentationReady({ expected, presentation: { ...stale, attemptId: 92, attemptOutcome: "accepted", completionStatus: "accepted" } })).toBe(true);
});

it("service close aborts a pending native decision and closes its browser without dispatch", async () => {
  const f = await fixture({ decide: (_observation, signal) => new Promise((_resolve, reject) => {
    signal.throwIfAborted();
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }) });
  await vi.waitFor(() => expect(f.seen).toHaveLength(1));
  await f.actors.close();
  expect(f.dispatches).toEqual([]);
  expect(f.browser.close).toHaveBeenCalledOnce();
  expect(f.actors.running.size).toBe(0);
  expect(f.tasks.get(f.id)).toMatchObject({ status: "interrupted", termination: { reason: "actor_cancelled" } });
});


it("keeps satisfaction separate from unfinished work and rejects contradictory endpoint claims", async () => {
  const f = await fixture({ navigateOnly: true, decide: () => action("finish", { reason: "satisfied", satisfaction: 3, endpointStatus: "incomplete", remainingWork: "The group has not agreed a route." }) });
  await f.done;
  const task = f.tasks.get(f.id);
  expect(task.termination).toMatchObject({ reason: "satisfied", success: null, endpointAttainment: "not_claimed" });
  expect(task.events.find(e => e.kind === "actor_satisfaction")).toMatchObject({ value: 3, endpointStatus: "incomplete", remainingWork: "The group has not agreed a route." });
  const event = task.events.find(e => e.kind === "actor_action");
  await f.tasks.annotate(f.id, { eventId: event.id, comment: "Stopped early: still no agreement." });
  const reopened = await new HumanTaskService(f.options).open();
  expect(reopened.get(f.id).annotations.at(-1)).toMatchObject({ eventId: event.id, comment: "Stopped early: still no agreement." });
  expect(() => validateActorAction(action("finish", { reason: "endpoint_reached", satisfaction: 3, endpointStatus: "incomplete" }))).toThrow("invalid action");
  expect(() => validateActorAction(action("finish", { reason: "endpoint_reached", satisfaction: 3, endpointStatus: "reached", remainingWork: "Pick route" }))).toThrow("invalid action");
  expect(() => validateActorAction(action("finish", { reason: "satisfied", satisfaction: 3, endpointStatus: "reached", remainingWork: "Pick route" }))).toThrow("invalid action");
  expect(validateActorAction(action("finish", { reason: "endpoint_reached", satisfaction: 3, endpointStatus: "reached", remainingWork: "" }))).toMatchObject({ endpointStatus: "reached" });
});


it("records endpoint attainment at the completion limit and links the successful finish intent", async () => {
  let decisions = 0;
  const f = await fixture({ decide: () => decisions++ === 0 ? action("click") : action("finish", { reason: "endpoint_reached", satisfaction: 4, endpointStatus: "reached", remainingWork: "" }) });
  await f.done;
  const task = f.tasks.get(f.id);
  expect(task.completions).toBe(task.maxCompletions);
  expect(task.termination).toMatchObject({ reason: "endpoint_reached", endpointAttainment: "actor_reported", success: null });
  const finish = task.events.find(event => event.kind === "actor_action" && event.action.kind === "finish");
  expect(task.events.filter(event => event.kind === "actor_action_completed" && event.actionEventId === finish.id)).toHaveLength(1);
  for (const reason of ["satisfied", "abandoned"]) expect(() => validateActorAction(action("finish", { reason, satisfaction: 3, endpointStatus: "reached", remainingWork: "" }))).toThrow("invalid action");
  expect(f.seen.every(({ observation }) => !["remainingCompletions", "step", "stepCount", "presentation"].some(key => key in observation))).toBe(true);
});

it.each(["cancel", "deadline"])("%s covers discovery before candidate creation", async (mode) => {
  const create = vi.fn(); const resolveRuntime = vi.fn(() => new Promise(() => {}));
  const actors = new TaskActorService({ tasks: { create }, resolveRuntime, deadlineMs: mode === "deadline" ? 25 : 900000 });
  cleanups.push(() => actors.close());
  const pending = actors.create({ startupId: "starting", actor: {} });
  const rejected = expect(pending).rejects.toMatchObject({ code: mode === "cancel" ? "cancelled" : "timeout" });
  await vi.waitFor(() => expect(resolveRuntime).toHaveBeenCalledOnce());
  if (mode === "cancel") await actors.stop("starting");
  await rejected;
  expect(create).not.toHaveBeenCalled();
  expect(actors.running.size).toBe(0);
  expect(() => actorConfiguration({ timeoutMs: 3600000 })).toThrow("Invalid");
});

it("stores screenshots outside hot session state and verifies them on reopen and immutable export", async () => {
  const f = await fixture({ busy: true });
  const screenshot = Buffer.from("fixture screenshot bytes").toString("base64");
  const event = await f.tasks.actorEvent(f.id, "actor_observation", { observation: { screenshot, text: "visible" } });
  expect(event.observation).not.toHaveProperty("screenshot");
  expect(await readFile(f.options.stateFile, "utf8")).not.toContain(screenshot);
  await f.actors.stop(f.id);
  const reopened = await new HumanTaskService(f.options).open();
  expect(await reopened.actorScreenshot(f.id, event.id)).toBe(`data:image/png;base64,${screenshot}`);
  const exported = await reopened.export(f.id);
  expect(exported.bundle.actorScreenshots).toEqual([expect.objectContaining({ eventId: event.id, dataUrl: `data:image/png;base64,${screenshot}` })]);
  const frozen = await readFile(exported.path, "utf8");
  await writeFile(join(f.options.stateFile, "..", "actor-screenshots", `${event.observation.screenshotArtifact.sha256}.png`), "corrupted");
  await expect(reopened.export(f.id)).rejects.toThrow("integrity");
  expect(await readFile(exported.path, "utf8")).toBe(frozen);
});

it("Stop during task preparation releases admission and cannot create a candidate later", async () => {
  const f = await fixture({ busy: true }); await f.actors.stop(f.id);
  let entered, release;
  const preparing = new Promise(resolve => { entered = resolve; });
  const prepare = f.tasks.evalService.prepareHumanTask;
  f.tasks.evalService.prepareHumanTask = () => { entered(); return new Promise(resolve => { release = async () => resolve(await prepare()); }); };
  const createThread = vi.spyOn(f.tasks.evalService, "createHumanTaskThread");
  const pending = f.actors.create({ startupId: "preparing", maxCompletions: 2, endpoint: "A plan" });
  const rejected = expect(pending).rejects.toMatchObject({ code: "cancelled" });
  await preparing; await f.actors.stop("preparing"); await rejected;
  await release(); await new Promise(resolve => setImmediate(resolve));
  expect(createThread).not.toHaveBeenCalled();
  expect(f.tasks.list()[0]).toMatchObject({ completions: 0, termination: { reason: "actor_cancelled" } });
  await f.tasks.grade(f.id, { satisfaction: 2, comment: "Queue released" });
});
