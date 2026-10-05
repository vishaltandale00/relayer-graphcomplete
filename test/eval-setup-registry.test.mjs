import { CalibrationService } from "../desktop/eval-main/calibration-service.mjs";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { stringify, parse } from "yaml";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SetupRegistry, defaultActorSetup, setupDigest } from "../desktop/eval-main/setup-registry.mjs";
import { HumanTaskService } from "../desktop/eval-main/human-task-service.mjs";
import { TaskActorService } from "../desktop/eval-main/task-actor-service.mjs";
import { createEvalDashboard, createHumanTaskSurface } from "../desktop/eval-main/web-host.mjs";

const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture({ initialActor } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "setup-revisions-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  let tasks; let calibration;
  const stateFile = join(directory, "setups.json");
  const registry = new SetupRegistry({ stateFile, feedbackLoader: (ref) => { if (calibration?.isHeldOutFeedback(ref)) throw new Error("Held-out labels cannot motivate setup tuning."); return tasks.feedbackReference(ref); } });
  if (initialActor) await registry.publish({ ...initialActor, predecessorId: null, feedback: [] });
  await registry.open();
  const options = { stateFile: join(directory, "tasks.json"), setupRegistry: registry,
    productSession: { origin: "http://product.invalid", cookie: { name: "control", value: "secret" }, readOnlyCookie: { name: "read", value: "only" } },
    evalService: { prepareHumanTask: async () => ({ name: "Trip", humanBrief: "PRIVATE BRIEF", humanRubric: "SECRET RUBRIC",
      casePlanDigest: "sha256:profile", execution: { testCaseId: "trip", harnessConfigurationName: "fixture", harnessConfigurationDigest: "sha256:harness" }, plan: [{ prompts: ["Plan {{endpoint}} literally"], name: "Trip" }] }),
      completionJudgeArtifactEvidence: async () => ({ files: [], complete: false }),
      createHumanTaskThread: async () => ({ id: 1, rootInteractionId: 10 }), gradeHumanTaskStep: async () => ({ passed: true }) },
    fetchImpl: async (url) => url.pathname.endsWith("/export") ? new Response("frozen conversation\n") : Response.json({ interactions: [{ id: 10, completionStatus: "accepted" }] }),
  };
  tasks = await new HumanTaskService(options).open();
  const calls = [];
  const runtime = vi.fn(async (config) => { calls.push({ config, beforeDispatch: tasks.list().length }); return {}; });
  const actors = new TaskActorService({ tasks, setupRegistry: registry, resolveRuntime: runtime, resolveCompletionJudgeRuntime: async () => ({}), createCompletionJudge: async () => ({ evaluate: async () => ({ verdict: "complete", evidenceExplanation: "Fixture endpoint verified", continuationHint: "", usage: null }), close: async () => {} }), openBrowser: async (id, signal, observationContract) => { calls.push({ browserObservationContract: observationContract }); return ({ observe: async () => ({ controls: [{ name: "visible", options: undefined }], text: "visible" }), close: async () => {} }); },
    createActor: async ({ prompt, config, outputSchema }) => ({ close: async () => {}, decide: async (observation) => {
      calls.push({ prompt, config, outputSchema, observation });
      return { action: { kind: "finish", ref: "", value: "", reason: "satisfied", satisfaction: 3, comment: "Enough", endpointStatus: "incomplete", remainingWork: "Bookings" }, usage: null };
    } }),
  });
  cleanup.push(() => actors.close());
  calibration = await new CalibrationService({ stateFile: join(directory, "calibration.json"), setups: registry, tasks, evalService: options.evalService, author: tasks.annotator }).open();
  const selection = { mode: "simulated", maxCompletions: 1, endpoint: "Agreement" };
  const start = async (actorSetupRevisionId) => { const task = await actors.create({ ...selection, actorSetupRevisionId }); await actors.running.get(task.id).done; return tasks.get(task.id); };
  return { directory, stateFile, registry, tasks, actors, calls, runtime, start, options, calibration };
}

it("publishes from exact human feedback and executes a selected immutable revision across export/reopen/promotion", async () => {
  const f = await fixture();
  const original = await f.start();
  await f.tasks.annotate(original.id, { eventId: original.events.find((event) => event.kind === "actor_action").id, comment: "Use shorter replies", rating: 2 });
  await f.tasks.grade(original.id, { satisfaction: 1, comment: "Human satisfaction is separate" });
  const oldSetup = f.registry.selected("actor");
  const updated = await f.registry.publish({ ...oldSetup, predecessorId: oldSetup.id, name: "Brief user", promptVersion: "manual-brief-1",
    promptTemplate: oldSetup.promptTemplate + "\nKeep this revised instruction.", settings: { ...oldSetup.settings, model: "gpt-test", exploration: "high" },
    feedback: [{ sessionId: original.id, annotationId: f.tasks.get(original.id).annotations[0].id }, { sessionId: original.id, gradeIndex: 0 }] });
  await f.tasks.grade(original.id, { satisfaction: 4, comment: "Later feedback" });
  const revised = await f.start(updated.id);
  expect(f.calls[0]).toMatchObject({ beforeDispatch: 0, config: { model: "gpt-5.6-luna" } });
  expect(f.calls.at(-1)).toMatchObject({ config: { model: "gpt-test", exploration: "high", promptVersion: "manual-brief-1" } });
  expect(f.calls.at(-1).prompt).toContain("Keep this revised instruction.");
  expect(f.calls.at(-1).prompt).toContain("Plan {{endpoint}} literally");
  expect(JSON.stringify(f.calls)).not.toMatch(/Use shorter replies|Human satisfaction is separate|Later feedback|SECRET RUBRIC/);
  expect(revised.actorSetup).toEqual(updated);
  expect(f.tasks.get(original.id).actorSetup).toEqual(oldSetup);
  expect(updated.feedback[1].feedback.value).toBe(1);
  expect(f.registry.selected("actor").id).toBe(oldSetup.id);
  await f.registry.promote({ revisionId: updated.id, comment: "Reviewed the shorter behavior manually" }, f.tasks.annotator);
  expect(f.registry.selected("actor").id).toBe(updated.id);
  expect(f.registry.selected("judge").id).toBe(f.registry.catalog().revisions.find((item) => item.kind === "judge").id);
  updated.settings.model = "mutated";
  const reopened = await new SetupRegistry({ stateFile: f.stateFile }).open();
  const taskStore = await new HumanTaskService(f.options).open();
  const exported = await taskStore.export(revised.id);
  expect(exported.bundle.session.actorSetup).toEqual(reopened.get(revised.actorSetup.id));
  expect(exported.bundle.session.actorSetup.feedback[1].feedback.value).toBe(1);
  expect(f.tasks.get(original.id).actorSetup).toEqual(oldSetup);
});

it("rejects invalid selections before any runtime or candidate spending and rejects cross-kind predecessors/authority changes", async () => {
  const f = await fixture();
  const actor = f.registry.selected("actor"); const judge = f.registry.selected("judge");
  await expect(f.start("missing")).rejects.toThrow("Unknown setup");
  await expect(f.start(judge.id)).rejects.toThrow("Unknown setup");
  expect(f.runtime).not.toHaveBeenCalled(); expect(f.tasks.list()).toEqual([]);
  await expect(f.registry.publish({ ...actor, predecessorId: judge.id })).rejects.toThrow("Unknown setup");
  await expect(f.registry.publish({ ...actor, predecessorId: actor.id, feedback: [], behaviorContract: { id: "shell-enabled" } })).rejects.toThrow("authority");
  await expect(f.registry.publish({ ...actor, predecessorId: actor.id, feedback: [], promptTemplate: "omitted private context" })).rejects.toThrow("runtime evidence");
  await expect(f.registry.publish({ ...judge, predecessorId: judge.id, feedback: [], scoringRules: { scale: "human-1-4" } })).rejects.toThrow("scoring contract");
});

it("rolls back a failed publication and rejects modified persisted revision bytes on reopen", async () => {
  const f = await fixture(); const before = f.registry.catalog();
  const task = await f.start(); await f.tasks.grade(task.id, { satisfaction: 2, comment: "Motivation" });
  const persist = vi.spyOn(f.registry, "persist").mockRejectedValueOnce(new Error("disk full"));
  await expect(f.registry.publish({ ...f.registry.selected("actor"), predecessorId: f.registry.selected("actor").id, feedback: [{ sessionId: task.id, gradeIndex: 0 }], name: "Lost" })).rejects.toThrow("disk full");
  expect(f.registry.catalog()).toEqual(before); persist.mockRestore();
  const saved = JSON.parse(await readFile(f.stateFile, "utf8")); saved.revisions[0].settings.model = "rewritten";
  await writeFile(f.stateFile, JSON.stringify(saved));
  await expect(new SetupRegistry({ stateFile: f.stateFile }).open()).rejects.toThrow("integrity");
});

it("restricts revision publication/promotion to the dashboard while actor observations hide pinned feedback", async () => {
  const f = await fixture(); const task = await f.start();
  const dashboard = await createEvalDashboard({ setupRegistry: f.registry, humanTasks: f.tasks, calibration: f.calibration });
  const actor = await createHumanTaskSurface({ tasks: f.tasks, sessionId: task.id, productSession: f.options.productSession, actor: true });
  cleanup.push(() => dashboard.close(), () => actor.close());
  const request = (surface, operation, args) => fetch(new URL(`/eval-api/${operation}`, surface.url), { method: "POST",
    headers: { Authorization: `Bearer ${new URL(surface.url).hash.slice(1)}`, "Content-Type": "application/json" }, body: JSON.stringify(args) });
  expect((await request(dashboard, "setupRevisions", [])).status).toBe(200);
  expect((await request(dashboard, "promoteSetup", [{ revisionId: f.registry.selected("actor").id, comment: "Human choice" }])).status).toBe(200);
  expect((await request(dashboard, "publishSetup", [{ kind: "judge", promptVersion: "forged" }])).status).toBe(400);
  for (const operation of ["setupRevisions", "publishSetup", "publishEvaluatorRelease", "promoteSetup", "calibrationCatalog", "calibrationSource", "freezeCalibrationSet", "compareSetupRevisions", "recordCalibrationObservation", "exportCalibration"]) expect((await request(actor, operation, [])).status).toBe(403);
  const projection = await fetch(new URL("/eval-api/task", actor.url), { headers: { Authorization: `Bearer ${new URL(actor.url).hash.slice(1)}` } });
  expect(JSON.stringify(await projection.json())).not.toMatch(/setup|feedback|rubric|grade|prompt|calibration/);
});


it("freezes tuning and held-out evidence/labels, rejects contamination and retains exact membership after later feedback and reopen", async () => {
  const f = await fixture(); const tuning = await f.start(); const heldOut = await f.start();
  const member = (task, membership) => ({ source: { kind: "task", id: task.id }, membership, labels: [{ dimension: "actor-realism", scale: "human-actor-realism-1-4", value: 2,
    subject: { kind: "event", id: task.events.find((event) => event.kind === "actor_action").id }, comment: "Human observes over-explaining" }] });
  const setupPersist = vi.spyOn(f.registry, "persist").mockRejectedValueOnce(new Error("unchanged setup store unavailable"));
  const set = await f.calibration.freeze({ name: "Frozen trip calibration", members: [member(tuning, "tuning"), member(heldOut, "held-out")] });
  expect(setupPersist).not.toHaveBeenCalled(); setupPersist.mockRestore();
  await f.tasks.grade(heldOut.id, { satisfaction: 4, comment: "Later satisfaction is independent" });
  await f.tasks.annotate(heldOut.id, { eventId: heldOut.events[0].id, comment: "LATER HELD-OUT LABEL", rating: 1 });
  expect(f.calibration.set(set.id)).toEqual(set);
  const exported = await f.calibration.export();
  const baseline = f.registry.selected("actor");
  await expect(f.registry.publish({ ...baseline, predecessorId: baseline.id, feedback: [{ sessionId: heldOut.id, gradeIndex: 0 }] })).rejects.toThrow("Held-out");
  await expect(f.calibration.freeze({ name: "Duplicate", members: [member(tuning, "tuning"), member(tuning, "held-out")] })).rejects.toThrow("twice");
  await expect(f.calibration.freeze({ name: "Leaked partition", members: [member(heldOut, "tuning")] })).rejects.toThrow("other calibration partition");
  await f.tasks.grade(tuning.id, { satisfaction: 2, comment: "Tuning motivation" });
  const candidate = await f.registry.publish({ ...baseline, predecessorId: baseline.id, promptVersion: "calibrated-candidate", feedback: [{ sessionId: tuning.id, gradeIndex: 0 }] });
  expect(candidate.feedback[0].feedback.comment).toBe("Tuning motivation");
  const reopened = await new CalibrationService({ stateFile: join(f.directory, "calibration.json"), setups: f.registry, tasks: f.tasks, evalService: f.options.evalService, author: f.tasks.annotator }).open();
  expect(reopened.set(set.id)).toEqual(set);
  expect(exported.sets[0]).toEqual(set);
  expect(JSON.stringify(exported.sets)).not.toContain("LATER HELD-OUT LABEL");
  expect(exported.setups.revisions[0]).toEqual(baseline);
});

it("compares actor realism with separate human scores bound to pinned task revisions and cases; missing evidence stays incomplete", async () => {
  const f = await fixture(); const original = await f.start();
  await f.tasks.grade(original.id, { satisfaction: 1, comment: "Improve brevity" });
  const baseline = f.registry.selected("actor");
  const candidate = await f.registry.publish({ ...baseline, predecessorId: baseline.id, name: "Candidate", feedback: [{ sessionId: original.id, gradeIndex: 0 }] });
  const set = await f.calibration.freeze({ name: "Realism", members: [{ source: { kind: "task", id: original.id }, membership: "tuning", labels: [{ dimension: "actor-realism", scale: "human-actor-realism-1-4", value: 2,
    subject: { kind: "event", id: original.events.find((event) => event.kind === "actor_action").id }, comment: "Baseline conversation realism" }] }] });
  const report = await f.calibration.compare({ baselineRevisionId: baseline.id, candidateRevisionId: candidate.id, calibrationSetId: set.id });
  expect(report).toMatchObject({ status: "incomplete", comparison: { dimension: "actor-realism", calibrationSetDigest: set.digest } });
  expect(report.rows[0]).not.toHaveProperty("humanTarget");
  const revised = await f.start(candidate.id);
  const originalEndpoint = f.tasks.find(revised.id).endpoint;
  f.tasks.find(revised.id).endpoint = "Easier endpoint";
  const mismatch = { comparisonId: report.comparison.id, memberId: set.members[0].id, labelId: set.members[0].labels[0].id, revisionId: candidate.id, taskId: revised.id, value: 4, comment: "A weaker endpoint" };
  await expect(f.calibration.observe(mismatch)).rejects.toThrow("pinned case");
  f.tasks.find(revised.id).endpoint = originalEndpoint;
  f.tasks.find(revised.id).maxCompletions++;
  await expect(f.calibration.observe(mismatch)).rejects.toThrow("pinned case");
  f.tasks.find(revised.id).maxCompletions--;
  f.tasks.find(revised.id).prepared.execution.catalogIdentity = { commit: "different-catalog", tree: "different-tree" };
  await expect(f.calibration.observe(mismatch)).rejects.toThrow("pinned case");
  delete f.tasks.find(revised.id).prepared.execution.catalogIdentity;
  const observation = { comparisonId: report.comparison.id, memberId: set.members[0].id, labelId: set.members[0].labels[0].id, comment: "Human independently reviewed the recorded actor" };
  await expect(f.calibration.observe({ ...observation, revisionId: candidate.id, taskId: original.id, value: 4 })).rejects.toThrow("pinned to this actor revision");
  await f.calibration.observe({ ...observation, revisionId: baseline.id, taskId: original.id, value: 2 });
  const completed = await f.calibration.observe({ ...observation, revisionId: candidate.id, taskId: revised.id, value: 3 });
  expect(completed).toMatchObject({ status: "completed", rows: [{ baseline: { score: 2 }, candidate: { score: 3 } }] });
  expect(JSON.stringify(f.calls)).not.toMatch(/Improve brevity|Baseline conversation realism|Human independently reviewed/);
  const exported = await f.calibration.export();
  expect(exported.observations).toHaveLength(2);
  expect(exported.comparisons[0].baseline.id).toBe(baseline.id);
  expect(f.registry.selected("actor").id).toBe(baseline.id);
  await f.registry.promote({ revisionId: candidate.id, comment: "Human compared realism evidence" }, f.tasks.annotator);
  expect(f.calibration.report(report.comparison.id)).toEqual(completed);
});

it("preserves incomplete calibration coverage and rejects label-scale or evidence fabrication", async () => {
  const f = await fixture(); const task = await f.start();
  const member = { source: { kind: "task", id: task.id }, membership: "tuning", labels: [] };
  const baseline = f.registry.selected("actor");
  await f.tasks.grade(task.id, { satisfaction: 2, comment: "Feedback" });
  const candidate = await f.registry.publish({ ...baseline, predecessorId: baseline.id, feedback: [{ sessionId: task.id, gradeIndex: 0 }] });
  const incomplete = await f.calibration.freeze({ name: "Unlabeled", members: [member] });
  const report = await f.calibration.compare({ baselineRevisionId: baseline.id, candidateRevisionId: candidate.id, calibrationSetId: incomplete.id });
  expect(report.rows[0]).toMatchObject({ status: "incomplete", reason: "No compatible human label." });
  const label = { dimension: "actor-realism", scale: "human-actor-realism-1-4", value: 2, subject: { kind: "event", id: task.events[0].id }, comment: "Human label" };
  await expect(f.calibration.freeze({ name: "Forged", members: [{ ...member, labels: [{ ...label, subject: { kind: "event", id: "unseen" } }] }] })).rejects.toThrow("captured evidence");
  await expect(f.calibration.freeze({ name: "Wrong scale", members: [{ ...member, labels: [{ ...label, scale: "human-1-4" }] }] })).rejects.toThrow("native dimension and scale");
  const before = f.calibration.catalog(); vi.spyOn(f.calibration, "persist").mockRejectedValueOnce(new Error("disk full"));
  await expect(f.calibration.freeze({ name: "Unsaved", members: [member] })).rejects.toThrow("disk full");
  expect(f.calibration.catalog()).toEqual(before);
});


it("reuses byte-identical same-instant exports and never overwrites an existing conflicting evidence file", async () => {
  const f = await fixture(); const task = await f.start();
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const first = await f.tasks.export(task.id); const second = await f.tasks.export(task.id);
    expect(second.path).toBe(first.path); expect(second.bundle).toEqual(first.bundle);
    await writeFile(first.path, "corrupt export");
    await expect(f.tasks.export(task.id)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(first.path, "utf8")).toBe("corrupt export");
  } finally { vi.useRealTimers(); }
});


it("publishes exact judge config files, rejects stale or unsafe files, and retains historical pins across edits/reopen", async () => {
  const f = await fixture(); const task = await f.start();
  await f.tasks.grade(task.id, { satisfaction: 2, comment: "Human feedback motivating judge tuning" });
  const directory = join(f.directory, "judge-configs"); await mkdir(directory);
  const original = f.registry.judgeConfigs()[0];
  const data = parse(original.definition.configSource.contents);
  data.settings = { shellAccess: false, modelReasoningEffort: "low", model: "gpt-test" };
  const file = "human-tuned-graph.yaml"; const path = join(directory, file);
  await writeFile(path, stringify(data, { lineWidth: 0 }));
  const registry = await new SetupRegistry({ stateFile: f.stateFile, judgeConfigDirectory: directory, feedbackLoader: f.registry.feedbackLoader }).open();
  const config = registry.judgeConfigs()[0];
  const input = { configFile: file, configDigest: config.digest, predecessorId: registry.selected("judge").id, feedback: [{ sessionId: task.id, gradeIndex: 0 }] };
  await expect(registry.publishConfig({ ...input, configFile: "../private.yaml" })).rejects.toThrow("unavailable");
  const published = await registry.publishConfig({ ...input, settings: { model: "forged" }, promptTemplate: "forged" });
  expect(published).toMatchObject({ promptVersion: "human-tuned-graph", settings: { model: "gpt-test", modelReasoningEffort: "low", shellAccess: false }, configSource: { file, path, digest: config.digest } });
  expect(published.configSource.contents).toBe(await readFile(path, "utf8"));
  data.settings.model = "gpt-other";
  await writeFile(path, stringify(data, { lineWidth: 0 }));
  await expect(registry.publishConfig(input)).rejects.toThrow("changed");
  const refreshed = registry.judgeConfigs()[0];
  const next = await registry.publishConfig({ ...input, predecessorId: published.id, configDigest: refreshed.digest });
  expect(next.settings.model).toBe("gpt-other");
  const reopened = await new SetupRegistry({ stateFile: f.stateFile, judgeConfigDirectory: directory }).open();
  expect(reopened.get(published.id)).toEqual(published);
  expect(reopened.get(next.id)).toEqual(next);
  data.settings.shellAccess = true;
  await writeFile(path, stringify(data));
  expect(() => registry.judgeConfigs()).toThrow("Unsupported judge config contract");
  await writeFile(path, "schemaVersion: 1\nschemaVersion: 1\n");
  expect(() => registry.judgeConfigs()).toThrow("Invalid judge config");
});


it("recovers an interrupted first-open registry without rewriting the saved actor revision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "setup-bootstrap-")); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const stateFile = join(directory, "setups.json"); const registry = new SetupRegistry({ stateFile });
  const persist = registry.persist.bind(registry); let writes = 0;
  registry.persist = async () => { if (++writes === 2) throw new Error("disk full"); await persist(); };
  await expect(registry.open()).rejects.toThrow("disk full");
  const actor = JSON.parse(await readFile(stateFile, "utf8")).revisions[0];
  const reopened = await new SetupRegistry({ stateFile }).open();
  expect(reopened.selected("actor")).toEqual(actor);
  expect(reopened.selected("judge").kind).toBe("judge");
  expect((await new SetupRegistry({ stateFile }).open()).catalog().revisions).toEqual(reopened.catalog().revisions);
});

it("pins historical v2 through a promotion during discovery, while explicit v8 executes its own template", async () => {
  const legacy = { ...defaultActorSetup(), promptVersion: "task-actor-v2", promptTemplate: defaultActorSetup().promptTemplate.replace("a visibly displayed option label", "an option value") };
  const f = await fixture({ initialActor: legacy });
  // Reopen a sealed pre-v4 record, rather than publishing an obsolete contract today.
  const persisted = JSON.parse(await readFile(f.stateFile, "utf8"));
  const historical = persisted.revisions.find(item => item.kind === "actor");
  historical.behaviorContract.id = "task-actor-v2";
  delete historical.behaviorContract.observationContract;
  delete historical.behaviorContract.completionJudge;
  delete historical.behaviorContract.participantMayStopIncomplete;
  historical.behaviorContract.actionSchema.properties.reason = { type: "string" };
  const { digest: previousDigest, ...historicalRecord } = historical;
  historical.digest = setupDigest(historicalRecord);
  await writeFile(f.stateFile, JSON.stringify(persisted));
  await f.registry.open();
  const original = await f.start(); await f.tasks.grade(original.id, { satisfaction: 2, comment: "Use visible option labels" });
  const old = f.registry.selected("actor");
  const legacyEdit = await f.registry.publish({ ...old, name: "Historical prompt edit", predecessorId: old.id, feedback: [{ sessionId: original.id, gradeIndex: 0 }] });
  expect(legacyEdit.behaviorContract).toEqual(old.behaviorContract);
  const next = await f.registry.publish({ ...old, name: "Edited historical actor", promptVersion: defaultActorSetup().promptVersion, promptTemplate: defaultActorSetup().promptTemplate, predecessorId: old.id, feedback: [{ sessionId: original.id, gradeIndex: 0 }] });
  const reopened = await new SetupRegistry({ stateFile: f.stateFile }).open();
  f.actors.setupRegistry = reopened; f.tasks.setupRegistry = reopened;
  let entered, release; const discovering = new Promise(resolve => { entered = resolve; });
  f.actors.resolveRuntime = async () => { entered(); await new Promise(resolve => { release = resolve; }); return {}; };
  const pending = f.actors.create({ mode: "simulated", maxCompletions: 1, endpoint: "Agreement" });
  await discovering;
  await reopened.promote({ revisionId: next.id, comment: "Human explicitly promotes v8" }, f.tasks.annotator);
  release(); const task = await pending; await f.actors.running.get(task.id).done;
  expect(f.tasks.get(task.id).actorSetup).toEqual(old);
  expect(f.calls.at(-1).config.promptVersion).toBe("task-actor-v2");
  expect(f.calls.filter(call => "browserObservationContract" in call).at(-1).browserObservationContract).toBeNull();
  expect(f.calls.at(-1).outputSchema).toEqual(old.behaviorContract.actionSchema);
  expect(f.calls.at(-1).prompt).toContain("select uses an option value");
  f.actors.resolveRuntime = f.runtime;
  const revised = await f.start(next.id);
  expect(revised.actorSetup).toEqual(next);
  expect(old.behaviorContract.actionSchema).not.toEqual(next.behaviorContract.actionSchema);
  expect(f.calls.at(-1).config.promptVersion).toBe("task-actor-v8");
  expect(next.behaviorContract.observationContract).toEqual({ id: "task-actor-observation-v2", optionObservation: "opened-native-select-accessibility" });
  expect(f.calls.filter(call => "browserObservationContract" in call).at(-1).browserObservationContract).toEqual(next.behaviorContract.observationContract);
  expect(f.calls.at(-1).prompt).toContain("Never guess an option or use a hidden value");
  expect(f.calls.at(-1).outputSchema).toEqual(next.behaviorContract.actionSchema);
  expect(f.calls.at(-1).prompt).toContain("select uses a visibly displayed option label");
  expect(reopened.get(old.id)).toEqual(old);
});


it("preflights frozen calibration identity and pins its candidate route before dispatch", async () => {
  const f = await fixture(); const original = await f.start();
  const route = { selectedModel: { providerId: "original", familyId: 1, modelId: "frozen" }, productModelSelection: true };
  f.tasks.find(original.id).prepared.execution.modelResolution = route;
  await f.tasks.grade(original.id, { satisfaction: 2, comment: "Calibrate brevity" });
  const baseline = f.registry.selected("actor");
  const candidate = await f.registry.publish({ ...baseline, predecessorId: baseline.id, feedback: [{ sessionId: original.id, gradeIndex: 0 }] });
  const set = await f.calibration.freeze({ name: "Pinned candidate", members: [{ source: { kind: "task", id: original.id }, membership: "tuning", labels: [] }] });
  const { comparison } = await f.calibration.compare({ baselineRevisionId: baseline.id, candidateRevisionId: candidate.id, calibrationSetId: set.id });
  const ref = { comparisonId: comparison.id, memberId: set.members[0].id, revisionId: candidate.id };
  const selection = f.calibration.actorSelection(ref);
  expect(JSON.stringify(selection)).not.toMatch(/feedback|labels|Calibrate brevity/);
  const create = vi.spyOn(f.options.evalService, "createHumanTaskThread");
  const prepare = f.options.evalService.prepareHumanTask;
  f.options.evalService.prepareHumanTask = async () => {
    const prepared = await prepare(); prepared.execution.pinnedModelResolution = { ...route, providerAdapterId: "codex-subscription" }; return prepared;
  };
  const task = await f.actors.create(selection); await f.actors.running.get(task.id).done;
  expect(create.mock.calls[0][0].execution.pinnedModelResolution).toEqual({ ...route, providerAdapterId: "codex-subscription" });
  for (const alteration of ["case", "authorized-route", "catalog"]) {
    create.mockClear();
    f.options.evalService.prepareHumanTask = async () => {
      const prepared = await prepare();
      if (alteration === "case") prepared.casePlanDigest = "changed";
      else if (alteration === "catalog") prepared.execution.catalogIdentity = { commit: "changed", tree: "changed" };
      else prepared.execution.pinnedModelResolution = { ...route, selectedModel: { ...route.selectedModel, modelId: "other" } };
      return prepared;
    };
    await expect(f.actors.create(selection)).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
    expect(f.tasks.list()[0].completions).toBe(0);
  }
  const dashboard = await createEvalDashboard({ setupRegistry: f.registry, humanTasks: f.tasks, calibration: f.calibration, taskActors: { create: async value => value } });
  cleanup.push(() => dashboard.close());
  const post = value => fetch(new URL("/eval-api/createHumanTask", dashboard.url), { method: "POST", headers: { Authorization: `Bearer ${new URL(dashboard.url).hash.slice(1)}` }, body: JSON.stringify([value]) });
  expect((await post({ calibrationCandidate: selection.calibrationCandidate })).status).toBe(400);
  const response = await post({ calibrationRef: ref, endpoint: "easier", maxCompletions: 100 });
  expect(await response.json()).toMatchObject({ endpoint: "Agreement", maxCompletions: 1, calibrationCandidate: { modelResolution: route } });
});


it.each([false, true])("retains frozen external catalog provenance after reopen (legacy set: %s)", async legacy => {
  const f = await fixture(); const original = await f.start();
  const identity = { commit: "a".repeat(40), tree: "b".repeat(40), entrypointSha256: "c".repeat(64) };
  f.tasks.find(original.id).prepared.execution.catalogIdentity = identity;
  await f.tasks.grade(original.id, { satisfaction: 2, comment: "Review catalog-bound actor" });
  const baseline = f.registry.selected("actor");
  const candidate = await f.registry.publish({ ...baseline, predecessorId: baseline.id, feedback: [{ sessionId: original.id, gradeIndex: 0 }] });
  const set = await f.calibration.freeze({ name: "Catalog identity", members: [{ source: { kind: "task", id: original.id }, membership: "tuning", labels: [{ dimension: "actor-realism", scale: "human-actor-realism-1-4", value: 2, subject: { kind: "event", id: original.events.find(event => event.kind === "actor_action").id }, comment: "Frozen actor trajectory" }] }] });
  const stateFile = join(f.directory, "calibration.json");
  if (legacy) {
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    const saved = state.sets.find(item => item.id === set.id);
    delete saved.members[0].caseIdentity.catalogIdentity;
    const { digest, ...record } = saved; saved.digest = setupDigest(record);
    await writeFile(stateFile, JSON.stringify(state));
  }
  const reopened = await new CalibrationService({ stateFile, setups: f.registry, tasks: f.tasks, evalService: f.options.evalService, author: f.tasks.annotator }).open();
  const { comparison } = await reopened.compare({ baselineRevisionId: baseline.id, candidateRevisionId: candidate.id, calibrationSetId: set.id });
  const selection = reopened.actorSelection({ comparisonId: comparison.id, memberId: set.members[0].id, revisionId: candidate.id });
  expect(selection.calibrationCandidate.identity.catalogIdentity).toEqual(identity);
  const prepare = f.options.evalService.prepareHumanTask;
  f.options.evalService.prepareHumanTask = async () => { const prepared = await prepare(); prepared.execution.catalogIdentity = { ...identity, commit: "d".repeat(40) }; return prepared; };
  const create = vi.spyOn(f.options.evalService, "createHumanTaskThread");
  await expect(f.tasks.create(selection)).rejects.toThrow("Calibration case or harness changed");
  expect(create).not.toHaveBeenCalled();
  expect(f.tasks.list()[0].completions).toBe(0);
  const revised = await f.start(candidate.id);
  await expect(reopened.observe({ comparisonId: comparison.id, memberId: set.members[0].id, labelId: set.members[0].labels[0].id, revisionId: candidate.id, taskId: revised.id, value: 3, comment: "Different catalog despite same case descriptor" })).rejects.toThrow("pinned case");
});


it("executes an explicit evaluator release independently of the actor and preserves exact stopping evidence after reopen", async () => {
  const f = await fixture();
  const historical = await f.start();
  const actor = f.registry.selected("actor");
  const judge = f.registry.selected("judge");
  const completion = f.registry.selected("completion-judge");
  const release = await f.registry.publishRelease({ name: "Frozen evaluator", actorRevisionId: actor.id, completionJudgeRevisionId: completion.id, judgeRevisionId: judge.id });
  const evaluate = vi.fn(async () => ({ verdict: "complete", evidenceExplanation: "Fixture artifact checked", continuationHint: "", usage: null }));
  f.actors.createCompletionJudge = async ({ config }) => { expect(config).toEqual(completion.spec); return { evaluate, close: async () => {} }; };
  const task = await f.actors.create({ mode: "simulated", maxCompletions: 1, endpoint: "Agreement", evaluatorReleaseId: release.id });
  await f.actors.running.get(task.id).done;
  const finished = f.tasks.get(task.id);
  expect(finished.actorSetup).toEqual(actor);
  expect(finished.completionJudgeSetup).toEqual(completion);
  expect(finished.evaluatorRelease).toEqual(release);
  expect(f.tasks.get(historical.id).completionJudgeSetup).toBeUndefined();
  expect(f.tasks.get(historical.id).actorSetup).toEqual(actor);
  const evidence = finished.events.find(event => event.kind === "actor_completion_evidence");
  expect(evidence.input).toEqual(evaluate.mock.calls[0][0]);
  expect(evidence.inputDigest).toBe(setupDigest(evidence.input));
  expect(evidence.evidenceContract).toBe("completion-evidence-v1");
  expect(JSON.stringify(evidence.input)).not.toMatch(/SECRET RUBRIC|feedback|humanTarget/);
  const reopened = await new HumanTaskService(f.options).open();
  expect((await reopened.export(task.id)).bundle.session.evaluatorRelease).toEqual(release);
  expect(reopened.get(task.id).events.find(event => event.id === evidence.id)).toEqual(evidence);
  expect(finished.termination).toMatchObject({ success: null, reason: "satisfied", endpointAttainment: "not_claimed" });
});

it("rejects conflicting release pins and completion preflight failures before candidate dispatch", async () => {
  const f = await fixture();
  const actor = f.registry.selected("actor"); const completion = f.registry.selected("completion-judge"); const judge = f.registry.selected("judge");
  const release = await f.registry.publishRelease({ name: "Preflight evaluator", actorRevisionId: actor.id, completionJudgeRevisionId: completion.id, judgeRevisionId: judge.id });
  const selection = { mode: "simulated", maxCompletions: 1, endpoint: "Agreement", evaluatorReleaseId: release.id };
  for (const field of ["actorSetupRevisionId", "completionJudgeRevisionId", "judgeSetupRevisionId"]) {
    await expect(f.actors.create({ ...selection, [field]: "other" })).rejects.toThrow("conflicts");
  }
  expect(f.runtime).not.toHaveBeenCalled();
  expect(f.tasks.list()).toEqual([]);
  f.actors.resolveCompletionJudgeRuntime = async () => { throw new Error("unavailable"); };
  const dispatch = vi.spyOn(f.options.evalService, "createHumanTaskThread");
  await expect(f.actors.create(selection)).rejects.toThrow();
  expect(dispatch).not.toHaveBeenCalled();
  expect(f.tasks.list()).toEqual([]);
});


it("keeps the independent completion revision fixed across actor calibration, including identical-spec revisions", async () => {
  const f = await fixture();
  const completion = f.registry.selected("completion-judge");
  const first = await f.actors.create({ mode: "simulated", maxCompletions: 1, endpoint: "Agreement", completionJudgeRevisionId: completion.id });
  await f.actors.running.get(first.id).done;
  const original = f.tasks.get(first.id);
  await f.tasks.grade(original.id, { satisfaction: 2, comment: "Shorter user responses would be more credible" });
  const baseline = f.registry.selected("actor");
  const candidate = await f.registry.publish({ ...baseline, predecessorId: baseline.id, feedback: [{ sessionId: original.id, gradeIndex: 0 }], name: "Revised actor" });
  const set = await f.calibration.freeze({ name: "Fixed completion reviewer", members: [{ source: { kind: "task", id: original.id }, membership: "tuning", labels: [{ dimension: "actor-realism", scale: "human-actor-realism-1-4", value: 2, subject: { kind: "event", id: original.events.find(event => event.kind === "actor_action").id }, comment: "Response realism" }] }] });
  const { comparison } = await f.calibration.compare({ baselineRevisionId: baseline.id, candidateRevisionId: candidate.id, calibrationSetId: set.id });
  const ref = { comparisonId: comparison.id, memberId: set.members[0].id, revisionId: candidate.id };
  const selection = f.calibration.actorSelection(ref);
  expect(selection.completionJudgeRevisionId).toBe(completion.id);
  const config = f.registry.completionJudgeConfigs()[0];
  const other = await f.registry.publishCompletionJudgeConfig({ configFile: config.file, configDigest: config.digest, predecessorId: completion.id, feedback: [{ sessionId: original.id, gradeIndex: 0 }] });
  expect(other.spec).toEqual(completion.spec);
  const changed = await f.actors.create({ ...selection, completionJudgeRevisionId: other.id });
  await f.actors.running.get(changed.id).done;
  await expect(f.calibration.observe({ ...ref, labelId: set.members[0].labels[0].id, taskId: changed.id, value: 3, comment: "Changed immutable evaluator" })).rejects.toThrow("pinned completion judge");
  await expect(f.calibration.compare({ baselineRevisionId: completion.id, candidateRevisionId: other.id, calibrationSetId: set.id })).rejects.toThrow("stopping-point contract");
});

it("selects v2 evidence through a real release and preserves the actual changed-file packet after export and reopen", async () => {
  const { execFileSync } = await import("node:child_process");
  const { EvalService } = await import("../desktop/eval-main/eval-service.mjs");
  const f = await fixture(); const workspace = join(f.directory, "repair"); await mkdir(join(workspace, "test"), { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd: workspace, encoding: "utf8" }).trim();
  git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  await writeFile(join(workspace, "index.js"), "old();\n" + "unchanged();\n".repeat(4000)); git("add", "."); git("commit", "-qm", "Baseline"); const baseline = git("rev-parse", "HEAD");
  await writeFile(join(workspace, "index.js"), "reserveBeforeWrite();\n" + "unchanged();\n".repeat(4000));
  await writeFile(join(workspace, "test", "command-queue-race.test.js"), "assertQueueSettles();\n"); git("add", "."); git("commit", "-qm", "Repair");
  const config = f.registry.completionJudgeConfigs().find(c => c.file === "completion-judge-v2.yaml");
  const prior = await f.start(); await f.tasks.grade(prior.id, { satisfaction: 2, comment: "Completion evidence omitted the changed regression." });
  const completion = await f.registry.publishCompletionJudgeConfig({ configFile: config.file, configDigest: config.digest, predecessorId: f.registry.selected("completion-judge").id, feedback: [{ sessionId: prior.id, gradeIndex: 0 }] });
  const release = await f.registry.publishRelease({ name: "Evidence v2", actorRevisionId: f.registry.selected("actor").id, completionJudgeRevisionId: completion.id, judgeRevisionId: f.registry.selected("judge").id });
  const prepare = f.options.evalService.prepareHumanTask;
  f.options.evalService.prepareHumanTask = async () => { const prepared = await prepare(); prepared.execution.fixture = { workspaceDirectory: workspace, sourceRevision: baseline }; return prepared; };
  f.options.evalService.assertHumanTaskCatalog = async () => {};
  f.options.evalService.completionJudgeArtifactEvidence = (...args) => EvalService.prototype.completionJudgeArtifactEvidence.apply(f.options.evalService, args);
  const evaluate = vi.fn(async evidence => {
    expect(evidence.artifactEvidence.repository).toMatchObject({ baseline, head: git("rev-parse", "HEAD"), stable: true, commitCount: 1 });
    expect(evidence.artifactEvidence.repository.diff.text).toContain("reserveBeforeWrite");
    expect(evidence.artifactEvidence.files.some(file => file.path === "test/command-queue-race.test.js")).toBe(true);
    return { verdict: "uncertain", evidenceExplanation: "Draft retained; physical fit not confirmed.", continuationHint: "Check the missing measurements when available.", usage: null };
  });
  f.actors.createCompletionJudge = async ({ config }) => { expect(config).toEqual(completion.spec); return { evaluate, close: async () => {} }; };
  const task = await f.actors.create({ mode: "simulated", maxCompletions: 2, endpoint: "Agreement", evaluatorReleaseId: release.id }); await f.actors.running.get(task.id).done;
  const result = f.tasks.get(task.id), evidence = result.events.find(e => e.kind === "actor_completion_evidence");
  expect(evaluate).toHaveBeenCalledOnce(); expect(evidence.evidenceContract).toBe("completion-evidence-v2");
  expect(evidence.inputDigest).toBe(setupDigest(evaluate.mock.calls[0][0])); expect(result.termination).toMatchObject({ reason: "satisfied", endpointAttainment: "not_claimed", success: null });
  const reopened = await new HumanTaskService(f.options).open(); const exported = await reopened.export(task.id);
  expect(exported.bundle.session.events.find(e => e.id === evidence.id)).toEqual(evidence); expect(exported.bundle.session.evaluatorRelease).toEqual(release);
  expect(f.registry.selected("completion-judge").spec.evidenceContract.id).toBe("completion-evidence-v1");
});
