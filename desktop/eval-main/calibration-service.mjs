import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setupDigest } from "./setup-registry.mjs";
const copy = (value) => structuredClone(value);
const fail = (message) => { throw Object.assign(new Error(message), { status: 400 }); };
// Persisted evidence uses JSON semantics, including omitted optional control fields.
const seal = (record) => { const snapshot = JSON.parse(JSON.stringify(record)); return { ...snapshot, digest: setupDigest(snapshot) }; };
const verify = ({ digest, ...record }) => { if (setupDigest(record) !== digest) fail("Calibration evidence integrity check failed."); };
// Older frozen sets retain catalog provenance in their sealed evidence.
const catalogIdentity = member => member.evidence.session?.prepared.execution.catalogIdentity ?? null;
const scaleFor = (dimension) => dimension === "actor-realism" ? "human-actor-realism-1-4" : "graph-presentation-v11-1-8";

// Frozen evidence and manual assessment only. No provider or actor execution
// capability exists here. Human target labels never enter an inference request.
export class CalibrationService {
  constructor({ stateFile, setups, tasks, evalService, author }) {
    Object.assign(this, { stateFile, setups, tasks, evalService, author });
    this.state = { schemaVersion: 1, sets: [], comparisons: [], observations: [] }; this.tail = Promise.resolve();
  }
  async open() {
    try {
      this.state = JSON.parse(await readFile(this.stateFile, "utf8"));
      if (this.state.schemaVersion !== 1 || !["sets", "comparisons", "observations"].every((key) => Array.isArray(this.state[key]))) fail("Unsupported calibration evidence.");
      for (const key of ["sets", "comparisons", "observations"]) this.state[key].forEach(verify);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    return this;
  }
  serial(work, setupBoundary = false) {
    const operation = async () => {
      const before = copy(this.state);
      try { const result = await work(); await this.persist(); return copy(result); }
      catch (error) { this.state = before; throw error; }
    };
    const next = this.tail.then(() => setupBoundary ? this.setups.withBoundary(operation) : operation());
    this.tail = next.catch(() => {}); return next;
  }
  async persist() {
    await mkdir(dirname(this.stateFile), { recursive: true });
    const temporary = `${this.stateFile}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(this.state), { mode: 0o600 }); await rename(temporary, this.stateFile);
  }
  catalog() { return copy(this.state); }
  set(id) { const set = this.state.sets.find((item) => item.id === id); if (!set) fail("Unknown calibration set."); return copy(set); }
  isHeldOutFeedback(ref) {
    return this.state.sets.some((set) => set.members.some((member) => member.membership === "held-out" && member.source.kind === "task" && member.source.id === ref.sessionId));
  }
  async source(ref) {
    if (ref?.kind === "task") {
      const { bundle } = await this.tasks.export(ref.id);
      if (bundle.conversationEvidence !== "frozen-at-finish") fail("Calibration requires a finished, frozen task trajectory.");
      return { source: { kind: "task", id: bundle.session.id }, evidence: bundle, evidenceDigest: setupDigest(bundle),
        caseIdentity: { endpoint: bundle.session.endpoint, maxCompletions: bundle.session.maxCompletions, testCaseId: bundle.session.prepared.execution.testCaseId, casePlanDigest: bundle.session.prepared.casePlanDigest,
          catalogIdentity: copy(bundle.session.prepared.execution.catalogIdentity ?? null), harnessConfigurationDigest: bundle.session.prepared.execution.harnessConfigurationDigest, selectedModel: bundle.session.prepared.execution.modelResolution?.selectedModel ?? null },
        subjects: bundle.session.events.map((event) => ({ kind: "event", id: event.id })) };
    }
    if (ref?.kind === "execution") return this.evalService.calibrationEvidence(ref.id);
    fail("Choose a recorded task or execution.");
  }
  freeze({ name, members }) {
    return this.serial(async () => {
      if (typeof name !== "string" || !name.trim() || name.length > 200 || !Array.isArray(members) || !members.length || members.length > 100) fail("Name a nonempty calibration set (maximum 100 members).");
      const seen = new Set(); const frozen = [];
      for (const member of members) {
        if (!["tuning", "held-out"].includes(member.membership)) fail("Record tuning or held-out membership.");
        const source = await this.source(member.source);
        const key = `${source.source.kind}:${source.source.id}`;
        if (seen.has(key)) fail("A trajectory cannot appear twice or in both partitions."); seen.add(key);
        if (this.state.sets.some((set) => set.members.some((prior) => prior.source.kind === source.source.kind && prior.source.id === source.source.id && prior.membership !== member.membership))) fail("A trajectory already belongs to the other calibration partition.");
        if (member.membership === "held-out" && this.setups.catalog().revisions.some((revision) => revision.feedback.some((ref) => ref.sessionId === source.source.id))) fail("Feedback already used for tuning cannot become held-out evaluation.");
        if (!Array.isArray(member.labels) || member.labels.length > 1000) fail("Supply explicit human labels, or an empty list for incomplete coverage.");
        const labels = []; const labeled = new Set();
        for (const label of member.labels) {
          if (!["actor-realism", "graph-presentation"].includes(label.dimension)) fail("Keep actor realism and graph-presentation agreement distinct.");
          const maximum = label.dimension === "actor-realism" ? 4 : 8;
          if (label.scale !== scaleFor(label.dimension) || !Number.isInteger(label.value) || label.value < 1 || label.value > maximum) fail("Use the label's native dimension and scale.");
          if (!source.subjects.some((subject) => subject.kind === label.subject?.kind && subject.id === String(label.subject?.id))) fail("Human label must reference captured evidence.");
          if (label.dimension === "actor-realism" && label.subject.kind !== "event" || label.dimension === "graph-presentation" && label.subject.kind !== "turn") fail("Label dimension does not match its evidence subject.");
          if (label.dimension === "graph-presentation" && !Object.hasOwn(this.setups.selected("judge").rubric.subjects.turn.criteria, label.criterion ?? "")) fail("Choose an existing graph rubric turn criterion.");
          if (typeof label.comment !== "string" || !label.comment.trim() || label.comment.length > 8000) fail("Explain the human label against its evidence.");
          const labelKey = `${label.dimension}:${label.subject.id}:${label.criterion ?? "realism"}`;
          if (labeled.has(labelKey)) fail("Duplicate human label for the same dimension and subject."); labeled.add(labelKey);
          labels.push({ ...copy(label), id: randomUUID(), author: copy(this.author), at: new Date().toISOString(), evidenceDigest: source.evidenceDigest });
        }
        frozen.push({ id: randomUUID(), membership: member.membership, ...source, labels });
      }
      const set = seal({ schemaVersion: 1, id: `calibration-${randomUUID()}`, name: name.trim(), frozenAt: new Date().toISOString(), author: copy(this.author), members: frozen });
      this.state.sets.push(set); return set;
    }, true);
  }
  compare({ baselineRevisionId, candidateRevisionId, calibrationSetId }) {
    return this.serial(async () => {
      const baseline = this.setups.get(baselineRevisionId); const candidate = this.setups.get(candidateRevisionId, baseline.kind);
      if (baseline.id === candidate.id) fail("Choose two distinct revisions.");
      const set = this.set(calibrationSetId);
      if (candidate.predecessorId !== baseline.id) fail("Compare a proposed revision with its predecessor.");
      // A previously tuned trajectory cannot be used to claim held-out evidence.
      for (const member of set.members.filter((item) => item.membership === "held-out")) {
        if ([baseline, candidate].some((revision) => revision.feedback.some((ref) => ref.sessionId === member.source.id))) fail("Held-out labels cannot be tuning examples.");
      }
      const comparison = seal({ schemaVersion: 1, id: `comparison-${randomUUID()}`, kind: baseline.kind, dimension: baseline.kind === "actor" ? "actor-realism" : "human-judge-agreement",
        baseline, candidate, calibrationSetId: set.id, calibrationSetDigest: set.digest, createdAt: new Date().toISOString(), author: copy(this.author) });
      this.state.comparisons.push(comparison); return this.report(comparison.id);
    });
  }
  report(id) {
    const comparison = this.state.comparisons.find((item) => item.id === id); if (!comparison) fail("Unknown calibration comparison.");
    const set = this.set(comparison.calibrationSetId);
    const dimension = comparison.kind === "actor" ? "actor-realism" : "graph-presentation";
    const rows = set.members.flatMap((member) => {
      const labels = member.labels.filter((label) => label.dimension === dimension);
      if (!labels.length) return [{ memberId: member.id, membership: member.membership, status: "incomplete", reason: "No compatible human label." }];
      return labels.map((label) => {
        const values = [comparison.baseline, comparison.candidate].map((revision) => this.state.observations.findLast((item) => item.comparisonId === id && item.memberId === member.id && item.labelId === label.id && item.revisionId === revision.id));
        const complete = values.every((item) => item?.status === "completed");
        return { memberId: member.id, membership: member.membership, labelId: label.id, subject: label.subject, criterion: label.criterion ?? null, scale: label.scale,
          status: complete ? "completed" : "incomplete", baseline: copy(values[0] ?? null), candidate: copy(values[1] ?? null),
          ...(comparison.kind === "judge" ? { humanTarget: label.value } : {}) };
      });
    });
    return copy({ comparison, status: rows.every((row) => row.status === "completed") ? "completed" : "incomplete", rows });
  }
  actorSelection({ comparisonId, memberId, revisionId }) {
    const { comparison } = this.report(comparisonId);
    if (comparison.kind !== "actor" || ![comparison.baseline.id, comparison.candidate.id].includes(revisionId)) fail("Choose an actor revision in this frozen comparison.");
    const member = this.set(comparison.calibrationSetId).members.find(item => item.id === memberId);
    if (member?.source.kind !== "task") fail("Actor execution requires a frozen task seed.");
    const original = member.evidence.session;
    return { mode: "simulated", testCaseId: original.prepared.execution.testCaseId,
      harnessConfigurationName: original.prepared.execution.harnessConfigurationName,
      endpoint: original.endpoint, maxCompletions: original.maxCompletions, actorSetupRevisionId: revisionId,
      calibrationCandidate: { identity: { ...copy(member.caseIdentity), catalogIdentity: copy(catalogIdentity(member)) }, modelResolution: copy(original.prepared.execution.modelResolution ?? { selectedModel: null, productModelSelection: false }) } };
  }
  observe(input) {
    return this.serial(async () => {
      const report = this.report(input.comparisonId); const comparison = report.comparison;
      const revision = [comparison.baseline, comparison.candidate].find((item) => item.id === input.revisionId); if (!revision) fail("Observation is outside the pinned revision pair.");
      const member = this.set(comparison.calibrationSetId).members.find((item) => item.id === input.memberId);
      const label = member?.labels.find((item) => item.id === input.labelId); if (!label) fail("Observation is outside frozen membership.");
      let result;
      if (comparison.kind === "actor") {
        if (label.dimension !== "actor-realism") fail("Actor realism is separate from judge agreement.");
        const task = this.tasks.get(input.taskId);
        if (task.status !== "completed" || task.actorSetup?.id !== revision.id || task.mode !== "simulated") fail("Choose a finished task pinned to this actor revision.");
        const expected = member.caseIdentity;
        if (!isDeepStrictEqual(catalogIdentity(member), task.prepared.execution.catalogIdentity ?? null) || expected.endpoint !== task.endpoint || expected.maxCompletions !== task.maxCompletions || JSON.stringify(expected.selectedModel) !== JSON.stringify(task.prepared.execution.modelResolution?.selectedModel ?? null) || expected.testCaseId !== task.prepared.execution.testCaseId || expected.casePlanDigest !== task.prepared.casePlanDigest || expected.harnessConfigurationDigest !== task.prepared.execution.harnessConfigurationDigest) fail("Actor comparison requires the pinned case, profile and candidate harness.");
        if (!Number.isInteger(input.value) || input.value < 1 || input.value > 4 || typeof input.comment !== "string" || !input.comment.trim() || input.comment.length > 8000) fail("Record a human realism rating and evidence-based comment on its native 1–4 scale.");
        const exported = await this.tasks.export(task.id);
        result = { status: "completed", score: input.value, scale: label.scale, comment: input.comment.trim(), author: copy(this.author),
          source: { kind: "task", id: task.id }, evidenceDigest: setupDigest(exported.bundle), evidence: exported.bundle };
      } else {
        if (label.dimension !== "graph-presentation" || member.source.kind !== "execution") fail("Judge agreement requires the original frozen graph execution.");
        const judgment = this.evalService.calibrationJudgment({ executionId: member.source.id, turnId: label.subject.id, judgeResultId: input.judgeResultId });
        if (judgment.result.judgeSetup?.id !== revision.id || judgment.result.judgeSetup.digest !== revision.digest) fail("Judge result does not pin this revision.");
        if (JSON.stringify(judgment.subject) !== JSON.stringify(member.subjects.find((subject) => subject.id === label.subject.id))) fail("Judge result does not reference the original frozen graph.");
        const score = judgment.result.review?.turn?.criterionJudgments?.[label.criterion]?.score;
        const complete = judgment.result.status === "completed" && judgment.result.coverage?.complete === true && Number.isInteger(score) && score >= 1 && score <= 8
          && judgment.result.rubricVersion === "graph-presentation-rubric-v11";
        result = { status: complete ? "completed" : "incomplete", score: complete ? score : null, scale: label.scale,
          agreesWithHuman: complete ? score === label.value : null, source: { kind: "judge-result", id: judgment.result.id }, evidence: judgment,
          evidenceDigest: setupDigest(judgment), reason: complete ? null : "Missing completed, compatible screenshot-grounded criterion evidence." };
      }
      const observation = seal({ id: randomUUID(), comparisonId: comparison.id, revisionId: revision.id, memberId: member.id, labelId: label.id, ...result, at: new Date().toISOString() });
      this.state.observations.push(observation); return this.report(comparison.id);
    });
  }
  export() {
    return this.serial(async () => {
      const bundle = seal({ kind: "relayer_calibration_bundle", ...this.catalog(), setups: this.setups.catalog(), exportedAt: new Date().toISOString() });
      const path = join(dirname(this.stateFile), "calibration-exports", `${bundle.digest.slice(7)}.json`);
      await mkdir(dirname(path), { recursive: true }); const bytes = JSON.stringify(bundle, null, 2);
      try { await writeFile(path, bytes, { flag: "wx", mode: 0o600 }); }
      catch (error) { if (error.code !== "EEXIST" || await readFile(path, "utf8") !== bytes) throw error; }
      return bundle;
    });
  }
}
