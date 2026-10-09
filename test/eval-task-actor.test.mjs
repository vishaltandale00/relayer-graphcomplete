import { Window } from "happy-dom";
import { taskActorControlIdentity, taskActorRebindControl, taskActorWorkingControlAllowed } from "../desktop/eval-main/task-actor-browser.mjs";
import { taskActorPresentationReady, taskActorCurrentIdentity } from "../desktop/eval-main/task-actor-browser.mjs";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { COMPLETION_JUDGE_SPEC } from "../desktop/eval-main/task-completion-judge.mjs";
import { defaultActorSetup } from "../desktop/eval-main/setup-registry.mjs";
import { HumanTaskService } from "../desktop/eval-main/human-task-service.mjs";
import { TaskActorService } from "../desktop/eval-main/task-actor-service.mjs";
import { actorConfiguration, actorPrompt, createCodexTaskActor, validateActorAction } from "../desktop/eval-main/task-actor.mjs";
import { createHumanTaskSurface } from "../desktop/eval-main/web-host.mjs";

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const action = (kind, extra = {}) => ({ kind, ref: "visible", value: "", reason: "", satisfaction: null, comment: "", endpointStatus: "incomplete", remainingWork: "Route undecided", ...extra });
async function fixture({ decide, observe, observeCurrent, promptVersion, maxActions = 8, busy = false, failWrite = false, navigateOnly = false, retry = false, timeoutMs = 900000, planCount = 1, maxCompletions = 2, controlErrors = [], completionJudge = null, judgeEvaluate = null, voluntaryStop = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "task-actor-test-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const turns = [{ id: 1, completionStatus: busy ? "running" : retry ? "not_started" : "accepted", ...(retry ? { latestAttempt: { id: 91, outcome: "model_failed" } } : {}) }];
  const dispatches = [];
  const behavior = { ...defaultActorSetup().behaviorContract, completionJudge };
  if (!voluntaryStop) { behavior.id = "task-actor-v4"; delete behavior.participantMayStopIncomplete; }
  const setupRegistry = completionJudge ? { selected: () => ({ ...defaultActorSetup(), id: "judge-gated-setup", settings: { ...defaultActorSetup().settings, maxActions }, behaviorContract: behavior }) } : null;
  const options = { setupRegistry, stateFile: join(directory, "tasks.json"), productSession: { origin: "http://product.invalid", cookie: { name: "control", value: "secret" }, readOnlyCookie: { name: "read", value: "only" } },
    evalService: {
      prepareHumanTask: async () => ({ name: "Task", humanBrief: "PRIVATE BRIEF", humanRubric: "SECRET RUBRIC", execution: { harnessConfigurationName: "fixture", projectId: 1, modelResolution: {} }, plan: Array.from({ length: planCount }, () => ({ name: "Task", prompts: ["Help me plan a trip"] })) }),
      createHumanTaskThread: async () => ({ id: 1, rootInteractionId: 1 }),
      gradeHumanTaskStep: async () => ({ passed: false }),
    },
    fetchImpl: async (url, init) => {
      if (init.method === "POST") {
        dispatches.push(url.pathname);
        if (url.pathname.endsWith("/live-answers")) { turns[0].completionStatus = "accepted"; return Response.json({ sequence: 1, attemptId: 10, operationKey: "answer-1" }); }
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
  const judge = { evaluate: vi.fn(judgeEvaluate ?? (async () => ({ verdict: "complete", evidenceExplanation: "Endpoint satisfied", continuationHint: "", usage: null }))), close: vi.fn() };
  if (completionJudge) tasks.completionJudgeEvidence = vi.fn(async () => ({ request: "Help me plan a trip", endpoint: "A trip plan", privateBrief: "PRIVATE BRIEF", trajectory: [], artifactEvidence: [] }));
  const seen = [];
  let id;
  let browserSignal;
  const browser = {
    observeCurrent: vi.fn(async (...args) => observeCurrent ? observeCurrent(...args, turns) : null),
    observe: vi.fn(async () => ({ text: turns.length > 1 ? "A trip plan based on your reply" : "Where do you want to go?", controls: [{ ref: "visible", name: "Send" }] })),
    act: vi.fn(async (chosen, correlation) => { if (correlation?.current) { if (chosen.kind === "click") await tasks.write(id, "/api/threads/1/interactions/1/live-answers", "POST", { attemptId: 10, operationKey: "answer-1" }, { signal: browserSignal }); return; } const controlError = controlErrors.shift(); if (controlError) throw controlError; if (navigateOnly) return; await tasks.write(id, retry ? "/api/threads/1/interactions/1/retry" : "/api/threads/1/interactions", "POST", { text: "Somewhere warm", ...(retry ? { attemptId: 91 } : {}) }, { signal: browserSignal }); }),
    nextStep: vi.fn(),
    close: vi.fn(),
  };
  const actors = new TaskActorService({ tasks, setupRegistry, resolveCompletionJudgeRuntime: async () => ({}), createCompletionJudge: async () => judge, pollMs: 1, deadlineMs: timeoutMs, resolveRuntime: async () => ({}), openBrowser: async (_id, signal) => { browserSignal = signal; return browser; },
    createActor: async ({ prompt }) => ({ decide: async (observation, signal, decisionOptions) => {
      seen.push({ prompt, observation });
      return { action: decide ? await decide(observation, signal, decisionOptions) : turns.length === 1 ? action("click") : action("finish", { reason: "satisfied", satisfaction: 3, comment: "Good enough" }), usage: { input_tokens: 10, output_tokens: 5 } };
    }, observe: vi.fn(async (observation, signal, options) => observe ? observe(observation, signal, turns, options) : { comment: "I understand what is being checked", usage: null }), close: vi.fn() }),
  });
  cleanups.push(() => actors.close());
  const task = await actors.create({ maxCompletions, endpoint: "A trip plan", actor: { maxActions, ...(promptVersion ? { promptVersion } : {}) } }); id = task.id;
  const done = actors.running.get(id).done;
  return { tasks, actors, id, done, seen, browser, dispatches, turns, options, judge };
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
  let options; let threadOptions; let runOptions;
  const actor = await createCodexTaskActor({ runtime: { executable: "/managed/codex", environment: { CODEX_HOME: "/owned", OPENAI_API_KEY: "secret", PATH: "/bin" } }, config, prompt,
    createCodex: (value) => { options = value; return { startThread: (value) => { threadOptions = value; return { run: async (_input, runInput) => { runOptions = runInput; return ({ finalResponse: JSON.stringify(action("finish", { reason: "abandoned", satisfaction: 1 })), items: [], usage: null }); } }; } }; },
  });
  cleanups.push(() => actor.close());
  await actor.decide({ text: "Visible" });
  expect(runOptions.outputSchema.properties.reason.enum).toEqual(["", "endpoint_reached", "satisfied", "abandoned"]);
  const narrowed = structuredClone(runOptions.outputSchema);
  narrowed.properties.kind.enum = narrowed.properties.kind.enum.filter(kind => kind !== "next_step");
  await actor.decide({ text: "Final step" }, undefined, { outputSchema: narrowed });
  expect(runOptions.outputSchema).toEqual(narrowed);
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
  expect(() => actorConfiguration({ timeoutMs: 3600001 })).toThrow("Invalid");
});

it("stores screenshots outside hot session state and verifies them on reopen and immutable export", async () => {
  const f = await fixture({ busy: true });
  const screenshot = Buffer.from("fixture screenshot bytes").toString("base64");
  const event = await f.tasks.actorEvent(f.id, "actor_observation", { observation: { screenshot, text: "visible" } });
  const { setupDigest } = await import("../desktop/eval-main/setup-registry.mjs");
  const input = { request: "Check delivery", screenshot, actorFinish: { kind: "finish" } };
  const packet = await f.tasks.actorEvent(f.id, "actor_completion_evidence", { observationEventId: event.id, input, inputDigest: setupDigest(input) });
  const repeated = await f.tasks.actorEvent(f.id, "actor_completion_evidence", { observationEventId: event.id, input, inputDigest: setupDigest(input) });
  const { readdir } = await import("node:fs/promises");
  expect(await readdir(join(f.options.stateFile, "..", "actor-screenshots"))).toEqual([`${packet.input.screenshot.sha256}.png`]);
  expect(await f.tasks.completionJudgeInput(f.id, repeated.id)).toEqual(input);
  expect(packet.inputEncoding).toBe("screenshot-reference-v1");
  expect(await f.tasks.completionJudgeInput(f.id, packet.id)).toEqual(input);
  await expect(f.tasks.actorEvent(f.id, "actor_completion_evidence", { observationEventId: event.id, input: { ...input, request: "changed" }, inputDigest: setupDigest(input) })).rejects.toThrow("binding");
  expect(event.observation).not.toHaveProperty("screenshot");
  expect(await readFile(f.options.stateFile, "utf8")).not.toContain(screenshot);
  await f.actors.stop(f.id);
  const reopened = await new HumanTaskService(f.options).open();
  expect(await reopened.completionJudgeInput(f.id, packet.id)).toEqual(input);
  expect(await reopened.actorScreenshot(f.id, event.id)).toBe(`data:image/png;base64,${screenshot}`);
  const exported = await reopened.export(f.id);
  expect(exported.bundle.actorScreenshots).toEqual([expect.objectContaining({ eventId: event.id, dataUrl: `data:image/png;base64,${screenshot}` })]);
  const stored = exported.bundle.session.events.find(e => e.id === packet.id);
  expect(stored.input.screenshot.sha256).toBe(exported.bundle.actorScreenshots[0].sha256);
  expect((await readFile(exported.path, "utf8")).split(screenshot).length - 1).toBe(1);
  const frozen = await readFile(exported.path, "utf8");
  await writeFile(join(f.options.stateFile, "..", "actor-screenshots", `${event.observation.screenshotArtifact.sha256}.png`), "corrupted");
  await expect(reopened.completionJudgeInput(f.id, packet.id)).rejects.toThrow("integrity");
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


it("pins the configured deadline across actor preflight and execution without extending it", async () => {
  const timeout = vi.spyOn(AbortSignal, "timeout");
  const task = { id: "configured-deadline" };
  const actors = new TaskActorService({ tasks: { create: async () => task }, resolveRuntime: async () => ({}) });
  actors.run = vi.fn(async (_id, _runtime, _cancel, signal) => { expect(signal.aborted).toBe(false); });
  try {
    expect(actorConfiguration().timeoutMs).toBe(900000);
    expect(() => actorConfiguration({ timeoutMs: 59999 })).toThrow("Invalid");
    await actors.create({ actor: { timeoutMs: 3600000 } });
    expect(timeout).toHaveBeenCalledWith(3600000);
    expect(timeout).toHaveBeenCalledTimes(1);
    await actors.close();
  } finally { timeout.mockRestore(); }
});


it.each([[1, 2], [2, 2], [2, 1]])("offers next_step only while another case step is admitted (steps: %s, budget: %s)", async (planCount, maxCompletions) => {
  const offered = [];
  const f = await fixture({ planCount, maxCompletions, decide: (observation, _signal, options) => {
    const kinds = options.outputSchema.properties.kind.enum;
    expect(observation.availableActions).toEqual(kinds);
    const canAdvance = kinds.includes("next_step"); offered.push(canAdvance);
    return canAdvance ? action("next_step") : action("finish", { reason: "abandoned", satisfaction: 2 });
  } });
  await f.done;
  expect(offered).toEqual(planCount === 2 && maxCompletions > 1 ? [true, false] : [false]);
  expect(f.tasks.get(f.id).status).toBe("completed");
  expect(f.browser.nextStep).toHaveBeenCalledTimes(Math.min(planCount, maxCompletions) - 1);
});


it("rejects a decision outside the narrowed native schema before action intent or dispatch", async () => {
  const f = await fixture({ decide: () => action("next_step") }); await f.done;
  const task = f.tasks.get(f.id);
  expect(task.events.find(event => event.kind === "actor_error")).toMatchObject({ category: "invalid_action", phase: "validate" });
  expect(task.events.filter(event => event.kind === "actor_action")).toEqual([]);
  expect(task.completions).toBe(1);
  expect(task.step).toBe(0);
  expect(f.dispatches).toEqual([]);
  expect(f.browser.nextStep).not.toHaveBeenCalled();
});


it.each([false, true])("asks AI to reconsider one contradictory finish without executing or rewriting it (repeats: %s)", async repeats => {
  let decisions = 0;
  const f = await fixture({ decide: observation => {
    decisions++;
    if (decisions === 2) expect(observation.previousActionError).toContain("remainingWork");
    return decisions === 1 || repeats
      ? action("finish", { reason: "endpoint_reached", endpointStatus: "reached", satisfaction: 4, remainingWork: "Stock still unconfirmed" })
      : action("finish", { reason: "abandoned", endpointStatus: "incomplete", satisfaction: 2, remainingWork: "Stock still unconfirmed" });
  } });
  await f.done;
  const task = f.tasks.get(f.id);
  expect(decisions).toBe(2);
  expect(task.events.filter(event => event.kind === "actor_action_rejected").map(event => event.retryAllowed)).toEqual(repeats ? [true, false] : [true]);
  expect(task.events.filter(event => event.kind === "actor_action")).toHaveLength(repeats ? 0 : 1);
  expect(task.status).toBe(repeats ? "interrupted" : "completed");
  expect(f.dispatches).toEqual([]);
  expect(f.browser.act).not.toHaveBeenCalled();
  if (!repeats) expect(task.termination.reason).toBe("abandoned");
});


it("preserves a contradictory finish at the last action slot without extending its budget", async () => {
  const f = await fixture({ maxActions: 1, decide: () => action("finish", { reason: "endpoint_reached", endpointStatus: "reached", satisfaction: 4, remainingWork: "Unconfirmed stock" }) });
  await f.done;
  const task = f.tasks.get(f.id);
  expect(f.seen).toHaveLength(1);
  expect(task.status).toBe("interrupted");
  expect(task.events.find(event => event.kind === "actor_action_rejected")).toMatchObject({ retryAllowed: false, action: { remainingWork: "Unconfirmed stock" }, usage: { input_tokens: 10 } });
  expect(f.dispatches).toEqual([]);
});


it.each(["actor_control_unavailable", "actor_control_stale"])("recaptures the workspace after confirmed pre-dispatch %s without replaying the intent", async code => {
  let decisions = 0;
  const f = await fixture({ controlErrors: [Object.assign(new Error("private browser details"), { code, actionDispatched: false })], decide: observation => {
    decisions++;
    if (decisions === 1) return action("click", { ref: "expired-runbook" });
    expect(observation.previousActionError).toContain("not executed");
    expect(observation.previousActionError).not.toContain("private browser details");
    return action("finish", { reason: "abandoned", satisfaction: 2 });
  } });
  await f.done;
  const task = f.tasks.get(f.id);
  expect(task.status).toBe("completed");
  expect(f.browser.observe).toHaveBeenCalledTimes(2);
  expect(f.browser.act).toHaveBeenCalledTimes(1);
  const intent = task.events.find(event => event.kind === "actor_action");
  expect(task.events.find(event => event.kind === "actor_action_failed")).toMatchObject({ actionEventId: intent.id, actionDispatched: false, retryAllowed: true });
  expect(task.events.some(event => event.kind === "actor_action_completed" && event.actionEventId === intent.id)).toBe(false);
  expect(f.dispatches).toEqual([]);
});

it.each(["repeated", "last-slot", "unconfirmed"])("fails closed on %s control failure without extra decisions or product dispatch", async scenario => {
  const error = () => Object.assign(new Error("private browser details"), { code: "actor_control_unavailable", ...(scenario === "unconfirmed" ? {} : { actionDispatched: false }) });
  const f = await fixture({ maxActions: scenario === "last-slot" ? 1 : 8, controlErrors: [error(), error()], decide: () => action("click") });
  await f.done;
  const task = f.tasks.get(f.id);
  expect(task.status).toBe("interrupted");
  expect(f.seen).toHaveLength(scenario === "repeated" ? 2 : 1);
  expect(task.events.filter(event => event.kind === "actor_action_failed").map(event => event.retryAllowed)).toEqual(scenario === "unconfirmed" ? [] : scenario === "repeated" ? [true, false] : [false]);
  expect(task.events.filter(event => event.kind === "actor_action_completed")).toEqual([]);
  expect(f.dispatches).toEqual([]);
});


it.each(["action", "breadcrumb"])("resolves only the same production %s after DOM replacement", kind => {
  const window = new Window();
  const document = window.document;
  window.__taskActorPresentation = { threadId: 1, turnId: 2, layerId: 4, attemptId: 5, selectedNodeId: 6,
    navigationPath: [{ layerId: 3, viaActionId: null }, { layerId: 4, viaActionId: 7 }] };
  document.body.innerHTML = `<div class="workspace-layout"><div id="detailActions"><button class="action-control" data-action-id="8" data-review-ref="action-8" data-review-kind="navigate-action" data-review-action-id="8" data-review-target-layer-id="9">Customize with our dates</button></div><div id="workspaceBreadcrumb"><button class="breadcrumb-segment" data-review-ref="breadcrumb-layer:0:3" data-review-kind="layer-navigation" data-review-path-index="0" aria-label="Go to Response">Response</button></div></div>`;
  const original = document.querySelector(kind === "action" ? ".action-control" : ".breadcrumb-segment");
  const identity = taskActorControlIdentity(original);
  expect(identity).not.toBeNull();
  if (kind === "breadcrumb") {
    const path = window.__taskActorPresentation.navigationPath;
    for (const malformed of [undefined, null, {}, "invalid"]) {
      window.__taskActorPresentation.navigationPath = malformed;
      expect(taskActorControlIdentity(original)).toBeNull();
    }
    window.__taskActorPresentation.navigationPath = path;
  }
  const replacement = original.cloneNode(true); original.replaceWith(replacement);
  expect(original.isConnected).toBe(false);
  expect(taskActorRebindControl(identity, document)).toBe(replacement);
  const clone = replacement.cloneNode(true); replacement.after(clone);
  expect(taskActorRebindControl(identity, document)).toBeNull(); clone.remove();
  for (const attribute of Object.keys(identity.attributes)) {
    const prior = replacement.getAttribute(attribute); replacement.setAttribute(attribute, "changed");
    expect(taskActorRebindControl(identity, document)).toBeNull();
    if (prior === null) replacement.removeAttribute(attribute); else replacement.setAttribute(attribute, prior);
  }
  replacement.textContent += "changed"; expect(taskActorRebindControl(identity, document)).toBeNull(); replacement.textContent = identity.text;
  for (const field of ["threadId", "turnId", "layerId", "attemptId", "selectedNodeId", "navigationPath"]) {
    const prior = window.__taskActorPresentation[field]; window.__taskActorPresentation[field] = "changed";
    expect(taskActorRebindControl(identity, document)).toBeNull(); window.__taskActorPresentation[field] = prior;
  }
  const unknown = document.createElement("button"); unknown.textContent = replacement.textContent; replacement.after(unknown);
  expect(taskActorControlIdentity(unknown)).toBeNull();
  window.happyDOM.abort();
});


it("stronger completion gate preserves proposals and requires interaction before reconsidering finish", async () => {
  const spec = structuredClone(COMPLETION_JUDGE_SPEC);
  const choices = [action("finish", { reason: "satisfied", satisfaction: 4 }), action("click"), action("click"), action("finish", { reason: "satisfied", satisfaction: 3 })];
  let evaluations = 0;
  const f = await fixture({ completionJudge: spec, controlErrors: [Object.assign(new Error("stale"), { code: "actor_control_stale", actionDispatched: false })], decide: () => choices.shift(), judgeEvaluate: async () => ++evaluations === 1
    ? { verdict: "incomplete", evidenceExplanation: "Only an initial suggestion exists", continuationHint: "Ask for a concrete trip plan.", usage: null }
    : { verdict: "complete", evidenceExplanation: "Concrete plan delivered", continuationHint: "", usage: null } });
  await f.done;
  const task = f.tasks.get(f.id);
  expect(f.browser.act).toHaveBeenCalledTimes(2);
  expect(task.events.filter(event => event.kind === "actor_satisfaction").map(event => event.value)).toEqual([4, 3]);
  expect(task.events.filter(event => event.kind === "actor_completion_judgment").map(event => event.verdict)).toEqual(["incomplete", "complete"]);
  expect(f.seen[1].observation.availableActions).not.toContain("finish");
  expect(f.seen[2].observation.availableActions).not.toContain("finish");
  expect(f.seen[3].observation.availableActions).toContain("finish");
  expect(f.seen[1].observation.completionJudgeFeedback).toBe("Ask for a concrete trip plan.");
  expect(JSON.stringify(f.seen)).not.toContain("Only an initial suggestion exists");
  expect(task.termination).toMatchObject({ reason: "endpoint_reached", endpointAttainment: "judge_reported" });
  expect(f.judge.close).toHaveBeenCalledOnce();
});

it("preflights the pinned completion judge before candidate task creation", async () => {
  const create = vi.fn();
  const spec = structuredClone(COMPLETION_JUDGE_SPEC);
  const setup = { ...defaultActorSetup(), id: "pinned", behaviorContract: { ...defaultActorSetup().behaviorContract, completionJudge: spec } };
  const resolveCompletionJudgeRuntime = vi.fn(async () => { throw new Error("model not supported private-token"); });
  const actors = new TaskActorService({ tasks: { create }, setupRegistry: { selected: () => setup }, resolveRuntime: async () => ({}), resolveCompletionJudgeRuntime });
  await expect(actors.create({})).rejects.toThrow(/model available/);
  expect(create).not.toHaveBeenCalled();
  expect(resolveCompletionJudgeRuntime).toHaveBeenCalledWith(spec, { signal: expect.any(AbortSignal) });
});


it.each(["incomplete", "uncertain"])("completion judge %s consumes the same action budget without accepting a finish loop", async (verdict) => {
  let decision = 0;
  const f = await fixture({ completionJudge: COMPLETION_JUDGE_SPEC, maxActions: 2, navigateOnly: true,
    decide: () => ++decision === 1 ? action("finish", { reason: "satisfied", satisfaction: 4 }) : action("click"),
    judgeEvaluate: async () => ({ verdict, evidenceExplanation: "Endpoint evidence missing", continuationHint: "Ask for the remaining detail.", usage: null }) });
  await f.done;
  expect(f.judge.evaluate).toHaveBeenCalledOnce();
  expect(f.browser.act).toHaveBeenCalledOnce();
  expect(f.tasks.get(f.id).termination).toMatchObject({ reason: "budget_exhausted", success: null });
});

it("judge failure preserves proposed satisfaction and supplied evidence, then interrupts with a typed phase", async () => {
  const f = await fixture({ completionJudge: COMPLETION_JUDGE_SPEC, decide: () => action("finish", { reason: "satisfied", satisfaction: 4 }),
    judgeEvaluate: async () => { throw new Error("private provider token sk-secret"); } });
  await f.done;
  const task = f.tasks.get(f.id);
  expect(task.status).toBe("interrupted");
  expect(task.events.find(event => event.kind === "actor_error")).toMatchObject({ phase: "completion_judge", category: "runtime_failure" });
  expect(task.events.some(event => event.kind === "actor_completion_evidence")).toBe(true);
  expect(task.events.some(event => event.kind === "actor_satisfaction")).toBe(true);
  expect(JSON.stringify(task.events)).not.toContain("sk-secret");
  expect(f.judge.close).toHaveBeenCalledOnce();
});

it("manual stop cancels a pending completion judgment without allowing late completion", async () => {
  let started; const pending = new Promise(resolve => { started = resolve; });
  let release; const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture({ completionJudge: COMPLETION_JUDGE_SPEC, decide: () => action("finish", { reason: "satisfied", satisfaction: 4 }),
    judgeEvaluate: async () => { started(); await gate; return { verdict: "complete", evidenceExplanation: "Late response", continuationHint: "", usage: null }; } });
  await pending;
  await f.actors.stop(f.id);
  release(); await f.done;
  expect(f.tasks.get(f.id).termination.reason).toBe("actor_cancelled");
  expect(f.tasks.get(f.id).events.some(event => event.kind === "actor_completion_judgment")).toBe(false);
});

it("another finish without an intervening interaction never calls the judge twice", async () => {
  const f = await fixture({ completionJudge: COMPLETION_JUDGE_SPEC, decide: () => action("finish", { reason: "satisfied", satisfaction: 4 }),
    judgeEvaluate: async () => ({ verdict: "incomplete", evidenceExplanation: "Not delivered", continuationHint: "Ask for a deliverable.", usage: null }) });
  await f.done;
  expect(f.judge.evaluate).toHaveBeenCalledOnce();
  expect(f.tasks.get(f.id).status).toBe("interrupted");
  expect(f.tasks.get(f.id).events.find(event => event.kind === "actor_error")).toMatchObject({ category: "invalid_action" });
});


it("stops at the completion budget after recording a rejected final-turn judgment", async () => {
  const f = await fixture({ completionJudge: COMPLETION_JUDGE_SPEC, maxCompletions: 1,
    decide: () => action("finish", { reason: "satisfied", satisfaction: 4 }),
    judgeEvaluate: async () => ({ verdict: "uncertain", evidenceExplanation: "The final turn does not establish completion", continuationHint: "Ask for the missing plan.", usage: null }) });
  await f.done;
  const task = f.tasks.get(f.id);
  expect(task.termination).toMatchObject({ reason: "budget_exhausted", success: null });
  expect(task.events.filter(event => event.kind === "actor_completion_judgment")).toHaveLength(1);
  expect(task.events.some(event => event.kind === "actor_error")).toBe(false);
  expect(f.browser.act).not.toHaveBeenCalled();
  expect(f.seen).toHaveLength(1);
});

it.each(["incomplete", "uncertain", "complete"])("new actor contract preserves an unfinished participant stop despite judge verdict %s", async verdict => {
  const f = await fixture({ voluntaryStop: true, completionJudge: COMPLETION_JUDGE_SPEC,
    decide: () => action("finish", { reason: "satisfied", satisfaction: 3, endpointStatus: "uncertain", remainingWork: "I cannot supply my monitor measurements yet." }),
    judgeEvaluate: async () => ({ verdict, evidenceExplanation: "Fit still depends on unavailable measurements.", continuationHint: verdict === "complete" ? "" : "Please check the fit.", usage: null }) });
  await f.done;
  expect(f.judge.evaluate).toHaveBeenCalledOnce();
  expect(f.browser.act).not.toHaveBeenCalled();
  const task = f.tasks.get(f.id);
  expect(task.termination).toMatchObject({ reason: "satisfied", success: null, endpointAttainment: "not_claimed", actorClaim: { endpointStatus: "uncertain", remainingWork: expect.stringContaining("measurements") } });
  expect(task.events.find(e => e.kind === "actor_completion_judgment").verdict).toBe(verdict);
});

it("reads historical inline completion screenshots with their original digest after reopen", async () => {
  const f = await fixture({ busy: true });
  const { setupDigest } = await import("../desktop/eval-main/setup-registry.mjs");
  const screenshot = Buffer.from("legacy screenshot").toString("base64");
  const observation = await f.tasks.actorEvent(f.id, "actor_observation", { observation: { screenshot } });
  const input = { request: "Legacy", screenshot, actorFinish: { kind: "finish" } };
  const packet = await f.tasks.actorEvent(f.id, "actor_completion_evidence", { observationEventId: observation.id, input, inputDigest: setupDigest(input) });
  const historical = f.tasks.find(f.id).events.find(e => e.id === packet.id);
  historical.input = input; delete historical.inputEncoding;
  await f.tasks.persist(); await f.actors.stop(f.id);
  const reopened = await new HumanTaskService(f.options).open();
  expect(await reopened.completionJudgeInput(f.id, packet.id)).toEqual(input);
  expect((await reopened.export(f.id)).bundle.session.events.find(e => e.id === packet.id).input).toEqual(input);
});

const currentCapture = revision => ({ kind: "observation", pointer: { threadId: 1, turnId: 1, attemptId: 10, revision, layerId: 100 + revision, observedAt: Date.now(), completionStatus: "running" },
  observation: { screenshot: Buffer.from(`visible update ${revision}`).toString("base64"), text: `Working update ${revision}`, availableActions: [] } });

it("perceives current updates in order without actions, records missed revisions, then uses a fresh settled view and exports evidence", async () => {
  const reactions = [];
  const revisions = [1, 3];
  const f = await fixture({ busy: true,
    observeCurrent: async () => currentCapture(revisions.shift()),
    observe: async (observation, _signal, turns) => {
      reactions.push(observation.text);
      if (reactions.length === 2) turns[0].completionStatus = "accepted";
      return { comment: `Now I know: ${observation.text}`, usage: null };
    },
    decide: async observation => {
      expect(reactions).toEqual(["Working update 1", "Working update 3"]);
      expect(observation.text).toBe("Where do you want to go?");
      return action("finish", { reason: "satisfied", satisfaction: 3 });
    },
  });
  await f.done;
  expect(f.browser.act).not.toHaveBeenCalled();
  const events = f.tasks.get(f.id).events;
  expect(events.filter(event => event.kind === "actor_current_reaction")).toHaveLength(2);
  expect(events.find(event => event.kind === "actor_current_gap")).toMatchObject({ reason: "revisions_not_observed", missingRevisions: 1, pointer: { revision: 3 } });
  const working = events.filter(event => event.kind === "actor_observation" && event.phase === "current");
  expect(working.map(event => event.pointer.revision)).toEqual([1, 3]);
  expect(working.every(event => event.actionSchema === null && event.observation.availableActions.length === 0)).toBe(true);
  expect(events.find(event => event.kind === "actor_action").sequence).toBeGreaterThan(events.findLast(event => event.kind === "actor_current_reaction").sequence);
  const reopened = await new HumanTaskService(f.options).open();
  const { bundle } = await reopened.export(f.id);
  expect(bundle.actorScreenshots.filter(image => working.some(event => event.id === image.eventId))).toHaveLength(2);
  expect(await reopened.actorScreenshot(f.id, working[0].id)).toBe(`data:image/png;base64,${currentCapture(1).observation.screenshot}`);
});

it("answers a working question before settlement and shares the ordinary action budget", async () => {
  let observed = 0;
  const f = await fixture({ busy: true, maxActions: 2,
    observeCurrent: async () => ({ ...currentCapture(1), observation: { ...currentCapture(1).observation, availableActions: ["fill", "click"] } }),
    observe: async (_observation, _signal, turns) => {
      observed++;
      expect(turns[0].completionStatus).toBe("running");
      return { comment: "I am answering the question", action: action(observed === 1 ? "fill" : "click", { ref: "visible", value: observed === 1 ? "Boston" : "" }) };
    },
  });
  await f.done;
  expect(f.browser.act).toHaveBeenCalledTimes(2);
  expect(f.seen).toHaveLength(0);
  const events = f.tasks.get(f.id).events;
  expect(events.filter(event => event.kind === "actor_action" && event.phase === "current")).toHaveLength(2);
  expect(events.find(event => event.kind === "actor_limit")).toMatchObject({ reason: "action_limit" });
  expect(f.tasks.get(f.id).completions).toBe(1);
});

it("retains a capture race and bounds current perception independently of ordinary actions", async () => {
  let captures = 0;
  const f = await fixture({ busy: true, maxActions: 2,
    observeCurrent: async () => ++captures === 1 ? { kind: "gap", pointer: currentCapture(1).pointer, reason: "presentation_changed_during_capture" } : currentCapture(2),
  });
  await vi.waitFor(() => expect(f.tasks.get(f.id).events.some(event => event.kind === "actor_current_limit")).toBe(true));
  expect(f.browser.observeCurrent).toHaveBeenCalledTimes(5);
  expect(f.seen).toHaveLength(0);
  f.turns[0].completionStatus = "accepted";
  await f.done;
  expect(f.tasks.get(f.id).events.find(event => event.kind === "actor_current_gap")).toMatchObject({ reason: "presentation_changed_during_capture" });
  expect(f.seen.length).toBeGreaterThan(0);
});

it.each(["Stop", "deadline"])("%s aborts pending perception and preserves its screenshot without dispatching an action", async kind => {
  let reached;
  const started = new Promise(resolve => { reached = resolve; });
  const f = await fixture({ busy: true, timeoutMs: kind === "deadline" ? 200 : 900000, observeCurrent: async () => currentCapture(1),
    observe: async (_observation, signal) => { reached(); return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); },
  });
  await started;
  if (kind === "Stop") await f.actors.stop(f.id); else await f.done;
  expect(f.browser.act).not.toHaveBeenCalled();
  expect(f.seen).toHaveLength(0);
  expect(f.tasks.get(f.id)).toMatchObject({ status: "interrupted", termination: { reason: kind === "Stop" ? "actor_cancelled" : "actor_timeout" } });
  expect(f.tasks.get(f.id).events.find(event => event.kind === "actor_observation")).toMatchObject({ phase: "current", observation: { screenshotArtifact: { mediaType: "image/png" } } });
  expect(f.tasks.get(f.id).events.some(event => event.kind === "actor_current_reaction")).toBe(false);
});

it("current capture excludes stale attempts, pinned navigation and layers different from the displayed current", () => {
  const expected = { threadId: 1, turnId: 2, submittedAt: 100, attemptId: 10 };
  const presentation = { ...expected, graphVisible: true, layerId: 5, attemptId: 10, observedAt: 120, currentPointer: { mode: "following", revision: 2, layerId: 5 }, navigationPath: [] };
  expect(taskActorCurrentIdentity({ expected, presentation })).toMatchObject({ revision: 2, layerId: 5 });
  for (const changed of [{ graphVisible: false }, { attemptId: 9 }, { observedAt: 90 }, { observedAt: undefined }, { currentPointer: { ...presentation.currentPointer, mode: "pinned" } }, { layerId: 6 }]) {
    expect(taskActorCurrentIdentity({ expected, presentation: { ...presentation, ...changed } })).toBeNull();
  }
});

it("native perception and actions share one restricted session but separate output schemas", async () => {
  const inputs = []; let starts = 0;
  const actor = await createCodexTaskActor({ runtime: { executable: "/managed/codex", environment: {} }, config: actorConfiguration(), prompt: "Ordinary user",
    createCodex: () => ({ startThread: () => { starts++; return { run: async (input, options) => {
      inputs.push({ input, options });
      return { items: [], finalResponse: JSON.stringify(options.outputSchema.properties.comment && !options.outputSchema.properties.kind ? { comment: "The plan changed; I can follow why" } : action("finish", { reason: "satisfied", satisfaction: 3 })) };
    } }; } }),
  });
  cleanups.push(() => actor.close());
  expect(await actor.observe(currentCapture(1).observation)).toMatchObject({ comment: "The plan changed; I can follow why" });
  await actor.decide({ text: "Settled response" });
  expect(starts).toBe(1);
  expect(inputs[0].options.outputSchema.properties).not.toHaveProperty("kind");
  expect(inputs[0].input[0].text).toContain("remembering only earlier observations");
  expect(inputs[1].options.outputSchema.properties.kind.enum).toContain("finish");
  expect(inputs[1].input[0].text).not.toContain("Ordinary user");
});

it("historical direct actor configurations still wait for settlement without current perception", async () => {
  const f = await fixture({ busy: true, promptVersion: "task-actor-v8", observeCurrent: async () => { throw new Error("Historical actor must not perceive Current"); } });
  await vi.waitFor(() => expect(f.tasks.get(f.id).events.some(event => event.kind === "actor_started")).toBe(true));
  f.turns[0].completionStatus = "accepted";
  await f.done;
  expect(f.browser.observeCurrent).not.toHaveBeenCalled();
  expect(f.tasks.get(f.id).events.some(event => event.kind === "actor_current_reaction")).toBe(false);
});

it("cancels a pending browser capture even if the injected capture ignores its signal", async () => {
  let reached;
  const started = new Promise(resolve => { reached = resolve; });
  const f = await fixture({ busy: true, observeCurrent: async () => { reached(); return new Promise(() => {}); } });
  await started;
  await f.actors.stop(f.id);
  expect(f.browser.act).not.toHaveBeenCalled();
  expect(f.tasks.get(f.id)).toMatchObject({ status: "interrupted", termination: { reason: "actor_cancelled" } });
  expect(f.tasks.get(f.id).events.find(event => event.kind === "actor_error")).toMatchObject({ phase: "observe_current", category: "cancelled" });
});

it("working controls permit exact live questions and navigation but refuse Send, Invoke, Stop and unrelated edits", () => {
  const document = new Window().document;
  document.body.innerHTML = `<div class="workspace-layout"><div id="nodeLayer"><button class="graph-node" data-node="4"></button></div><div id="detailActions"><button data-review-kind="invoke-action"></button><button data-review-kind="navigate-action"></button></div><fieldset data-live-answer-scope="question"><textarea></textarea><button data-input-control-role="answer"></button><button data-input-control-role="commit"></button></fieldset><button id="send">Send</button><button id="stop">Stop</button><textarea id="composer"></textarea></div>`;
  for (const selector of ["#send", "#stop", "#composer", "[data-review-kind=invoke-action]", "[data-input-control-role=commit]"]) expect(taskActorWorkingControlAllowed(document.querySelector(selector), "click")).toBe(false);
  for (const selector of [".graph-node", "[data-review-kind=navigate-action]", "[data-input-control-role=answer]"]) expect(taskActorWorkingControlAllowed(document.querySelector(selector), "click")).toBe(true);
  expect(taskActorWorkingControlAllowed(document.querySelector("fieldset textarea"), "fill")).toBe(true);
});

it("action exhaustion leaves a stage undelivered and records the limit without another admission", async () => {
  const f = await fixture({ busy: true, maxActions: 1,
    observeCurrent: async () => ({ ...currentCapture(1), observation: { ...currentCapture(1).observation, availableActions: ["fill", "click"] } }),
    observe: async (observation, _signal, turns) => {
      if (!observation.availableActions.length) { turns[0].completionStatus = "accepted"; return { comment: "I staged a value but could not Answer", action: null }; }
      return { comment: "I am editing", action: action("fill", { value: "Boston" }) };
    },
  });
  await f.done;
  expect(f.browser.act).toHaveBeenCalledTimes(1);
  expect(f.dispatches).toEqual([]);
  expect(f.tasks.get(f.id).completions).toBe(1);
  expect(f.tasks.get(f.id).events.some(event => event.kind === "actor_limit")).toBe(true);
  expect(f.tasks.get(f.id).events.some(event => event.liveAnswerReceipt)).toBe(false);
});
