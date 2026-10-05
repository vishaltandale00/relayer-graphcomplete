import { COMPLETION_JUDGE_SPEC, COMPLETION_JUDGE_SCHEMA, COMPLETION_JUDGE_EVIDENCE_CONTRACT, completionEvidenceContract, validateCompletionJudgeSpec } from "./task-completion-judge.mjs";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join, basename } from "node:path";
import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { GRAPH_PRESENTATION_RUBRIC_V11 } from "@relayer/eval-runner";
import { actorConfiguration, ACTOR_PROMPT_TEMPLATE, ACTOR_PROMPT_V8_GUIDANCE, ACTOR_ACTION_SCHEMA, ACTOR_OBSERVATION_CONTRACT, ACTOR_PROMPT_VERSION } from "./task-actor.mjs";

const copy = (value) => structuredClone(value);
const fail = (message) => { throw Object.assign(new Error(message), { status: 400 }); };
export const setupDigest = (value) => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
function sealed(value) { return { ...value, digest: setupDigest(value) }; }
function verify(value) {
  const { digest, ...record } = value;
  if (setupDigest(record) !== digest) fail("Setup registry integrity check failed.");
}
function template(value, variables) {
  if (typeof value !== "string" || !value.trim() || value.length > 100000) fail("Invalid setup prompt template.");
  const keys = [...value.matchAll(/\{\{([a-zA-Z]+)\}\}/g)].map((match) => match[1]);
  if (keys.some((key) => !variables.includes(key)) || variables.some((key) => !keys.includes(key))) fail("Setup prompt must retain its runtime evidence variables.");
  return value;
}
const defaultJudgeDirectory = fileURLToPath(new URL("../../eval-configs/judges/", import.meta.url));
const defaultCompletionJudgeDirectory = fileURLToPath(new URL("../../eval-configs/completion-judges/", import.meta.url));
const judgeScoringRules = { contractId: "recursive-presentation-judge-v6", dimension: "graph-presentation", scale: "ordered-1-8" };
function judgeConfigurations(directory) {
  const files = readdirSync(directory).filter((file) => /^[a-zA-Z0-9._-]+\.yaml$/.test(file)).sort();
  if (!files.length) fail("No judge config files are available.");
  return files.map((file) => {
    const path = join(directory, file);
    if (!lstatSync(path).isFile()) fail("Judge config must be an ordinary file.");
    const contents = readFileSync(path, "utf8");
    if (contents.length > 250000) fail("Judge config file is too large.");
    const document = parseDocument(contents, { uniqueKeys: true });
    if (document.errors.length) fail(`Invalid judge config ${file}: ${document.errors[0].message}`);
    const input = document.toJS();
    const keys = ["schemaVersion", "kind", "name", "settings", "rubric", "scoringRules", "promptTemplate", "inputPromptTemplate"];
    if (!input || Object.keys(input).some((key) => !keys.includes(key)) || input.schemaVersion !== 1 || input.kind !== "judge"
      || input.rubric !== GRAPH_PRESENTATION_RUBRIC_V11.rubricVersion || input.scoringRules !== judgeScoringRules.contractId
      || Object.keys(input.settings ?? {}).some((key) => !["model", "modelReasoningEffort", "shellAccess"].includes(key)) || input.settings?.shellAccess !== false) fail(`Unsupported judge config contract: ${file}`);
    const configSource = { file, path, digest: setupDigest(contents), contents };
    const definition = normalize({ ...input, promptVersion: basename(file, ".yaml"), rubric: GRAPH_PRESENTATION_RUBRIC_V11, scoringRules: judgeScoringRules, configSource });
    if (!definition.configSource) fail(`Judge config snapshot does not match its definition: ${file}`);
    return { file, path, digest: configSource.digest, definition };
  });
}
function completionJudgeConfigurations(directory) {
  const files = readdirSync(directory).filter(file => /^[a-zA-Z0-9._-]+\.yaml$/.test(file)).sort();
  if (!files.length) fail("No completion judge config files are available.");
  return files.map(file => {
    const path = join(directory, file);
    if (!lstatSync(path).isFile()) fail("Completion judge config must be an ordinary file.");
    const contents = readFileSync(path, "utf8");
    if (contents.length > 250000) fail("Completion judge config file is too large.");
    const document = parseDocument(contents, { uniqueKeys: true });
    if (document.errors.length) fail(`Invalid completion judge config ${file}: ${document.errors[0].message}`);
    const input = document.toJS();
    if (!input || Array.isArray(input) || Object.keys(input).some(key => !["schemaVersion", "kind", "name", "settings", "evidenceContract", "outputSchema", "promptTemplate"].includes(key))
      || input.schemaVersion !== 1 || input.kind !== "completion-judge"
      || !completionEvidenceContract(input.evidenceContract) || input.outputSchema !== "completion-assessment-v1"
      || !input.settings || Object.keys(input.settings).some(key => !["model", "modelReasoningEffort", "shellAccess"].includes(key))
      || input.settings.shellAccess !== false) fail(`Unsupported completion judge config contract: ${file}`);
    const configSource = { file, path, digest: setupDigest(contents), contents };
    const spec = { version: basename(file, ".yaml"), model: input.settings.model, modelReasoningEffort: input.settings.modelReasoningEffort,
      promptTemplate: input.promptTemplate, outputSchema: copy(COMPLETION_JUDGE_SCHEMA), evidenceContract: copy(completionEvidenceContract(input.evidenceContract)) };
    const definition = normalize({ kind: input.kind, name: input.name, promptVersion: spec.version, spec, configSource });
    return { file, path, digest: configSource.digest, definition };
  });
}
export function defaultCompletionJudgeSetup() { return completionJudgeConfigurations(defaultCompletionJudgeDirectory)[0].definition; }
export function defaultActorSetup() {
  return { kind: "actor", name: "Low-effort user", promptVersion: ACTOR_PROMPT_VERSION, promptTemplate: ACTOR_PROMPT_TEMPLATE + "\n" + ACTOR_PROMPT_V8_GUIDANCE,
    settings: actorConfiguration(), behaviorContract: { id: "task-actor-v5", participantMayStopIncomplete: true, actionSchema: copy(ACTOR_ACTION_SCHEMA), observationContract: copy(ACTOR_OBSERVATION_CONTRACT), completionJudge: copy(COMPLETION_JUDGE_SPEC) } };
}
export function defaultJudgeSetup() {
  const config = judgeConfigurations(defaultJudgeDirectory)[0];
  if (!config) fail("No judge config files are available.");
  return config.definition;
}
function normalize(input) {
  if (!["actor", "judge", "completion-judge"].includes(input?.kind)) fail("Choose actor, completion judge or graph judge setup.");
  if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 200) fail("Name the setup revision.");
  if (typeof input.promptVersion !== "string" || !input.promptVersion.trim() || input.promptVersion.length > 100) fail("Name the prompt version.");
  if (input.kind === "completion-judge") {
    try { validateCompletionJudgeSpec(input.spec); } catch { fail("Unsupported completion judge specification."); }
    if (input.spec.version !== input.promptVersion || JSON.stringify(input.spec.evidenceContract) !== JSON.stringify(completionEvidenceContract(input.spec.evidenceContract?.id))) fail("Completion judge evidence contract is not editable.");
    // Definitions must retain the exact repository source; dashboard edits are not configs.
    const source = input.configSource;
    if (!source || typeof source.contents !== "string" || source.contents.length > 250000
      || !/^[a-zA-Z0-9._-]+\.yaml$/.test(source.file ?? "") || source.digest !== setupDigest(source.contents)
      || input.promptVersion !== basename(source.file, ".yaml")) fail("Completion judge requires an exact config snapshot.");
    const document = parseDocument(source.contents, { uniqueKeys: true });
    const file = document.toJS();
    if (document.errors.length || !file || Object.keys(file).some(key => !["schemaVersion", "kind", "name", "settings", "evidenceContract", "outputSchema", "promptTemplate"].includes(key))
      || file.schemaVersion !== 1 || file.kind !== input.kind || file.name !== input.name || file.promptTemplate !== input.spec.promptTemplate
      || file.outputSchema !== "completion-assessment-v1" || file.evidenceContract !== input.spec.evidenceContract.id
      || Object.keys(file.settings ?? {}).some(key => !["model", "modelReasoningEffort", "shellAccess"].includes(key))
      || file.settings?.shellAccess !== false || file.settings?.model !== input.spec.model || file.settings?.modelReasoningEffort !== input.spec.modelReasoningEffort) fail("Completion judge config snapshot does not match its definition.");
    return { kind: input.kind, name: input.name.trim(), promptVersion: input.promptVersion, spec: copy(input.spec), configSource: copy(source) };
  }
  if (input.kind === "actor") {
    const behaviorContract = defaultActorSetup().behaviorContract;
    const guidedContract = { ...copy(behaviorContract), id: "task-actor-v4" }; delete guidedContract.participantMayStopIncomplete;
    const nativeMenuContract = { id: "task-actor-v3", actionSchema: copy(ACTOR_ACTION_SCHEMA), observationContract: copy(ACTOR_OBSERVATION_CONTRACT) };
    const priorContract = { id: "task-actor-v2", actionSchema: copy(ACTOR_ACTION_SCHEMA) };
    const legacyContract = copy(priorContract);
    legacyContract.actionSchema.properties.reason = { type: "string" };
    // Publication may upgrade a known historical contract; stored revisions stay immutable.
    if (![behaviorContract, guidedContract, nativeMenuContract, priorContract, legacyContract].some(contract => JSON.stringify(input.behaviorContract) === JSON.stringify(contract))) fail("Actor behavior authority contract is not editable.");
    return { kind: input.kind, name: input.name.trim(), promptVersion: input.promptVersion,
      promptTemplate: template(input.promptTemplate, ["request", "endpoint", "privateBrief", "exploration", "meticulousness"]),
      settings: actorConfiguration(input.settings), behaviorContract: input.promptVersion === ACTOR_PROMPT_VERSION ? behaviorContract : copy(input.behaviorContract) };
  }
  const settings = { model: input.settings?.model, modelReasoningEffort: input.settings?.modelReasoningEffort, shellAccess: false };
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(settings.model ?? "") || !["low", "medium", "high"].includes(settings.modelReasoningEffort)) fail("Invalid judge model/settings.");
  // V11 scoring has code-owned integrity rules. Versions can tune the prompt;
  // another rubric/scale requires its own reviewed executable contract.
  if (JSON.stringify(input.rubric) !== JSON.stringify(GRAPH_PRESENTATION_RUBRIC_V11)
    || JSON.stringify(input.scoringRules) !== JSON.stringify(judgeScoringRules)) fail("This graph judge requires the v11 rubric and v6 scoring contract.");
  const fileDefinition = input.configSource ? parseDocument(input.configSource.contents).toJS() : null;
  const matchesFile = fileDefinition && input.configSource.digest === setupDigest(input.configSource.contents)
    && input.promptVersion === basename(input.configSource.file, ".yaml") && input.name === fileDefinition.name
    && input.promptTemplate === fileDefinition.promptTemplate && input.inputPromptTemplate === fileDefinition.inputPromptTemplate
    && Object.entries(settings).every(([key, value]) => fileDefinition.settings?.[key] === value);
  return { kind: input.kind, name: input.name.trim(), promptVersion: input.promptVersion,
    promptTemplate: template(input.promptTemplate, ["request", "artifactEvidence", "inventory", "rubric"]),
    inputPromptTemplate: template(input.inputPromptTemplate, ["request", "artifactEvidence", "inventory", "rubric"]), settings,
    rubric: copy(input.rubric), scoringRules: copy(input.scoringRules),
    ...(matchesFile ? { configSource: copy(input.configSource) } : {}) };
}

// Eval evidence storage only. Publishing and promoting never invoke inference.
export class SetupRegistry {
  constructor({ stateFile, judgeConfigDirectory = defaultJudgeDirectory, completionJudgeConfigDirectory = defaultCompletionJudgeDirectory, feedbackLoader = async () => fail("Human feedback is unavailable.") }) {
    Object.assign(this, { stateFile, feedbackLoader, judgeConfigDirectory, completionJudgeConfigDirectory });
    this.state = { schemaVersion: 1, revisions: [], promotions: [], evaluatorReleases: [] };
    this.tail = Promise.resolve();
  }
  async open() {
    try {
      this.state = JSON.parse(await readFile(this.stateFile, "utf8"));
      if (this.state.schemaVersion !== 1 || !Array.isArray(this.state.revisions) || !Array.isArray(this.state.promotions)) fail("Unsupported setup registry.");
      this.state.revisions.forEach(verify); this.state.promotions.forEach(verify);
      this.state.evaluatorReleases ??= [];
      if (!Array.isArray(this.state.evaluatorReleases)) fail("Unsupported evaluator releases.");
      this.state.evaluatorReleases.forEach(verify);
      for (const release of this.state.evaluatorReleases) this.validateRelease(release);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    for (const [kind, createDefault] of [["actor", defaultActorSetup], ["judge", defaultJudgeSetup], ["completion-judge", () => this.completionJudgeConfigs()[0].definition]]) {
      if (!this.state.revisions.some(revision => revision.kind === kind)) await this.publish({ ...createDefault(), predecessorId: null, feedback: [] });
    }
    return this;
  }
  withBoundary(operation) {
    const next = this.tail.then(operation);
    this.tail = next.catch(() => {}); return next;
  }
  serial(operation) {
    return this.withBoundary(async () => {
      const before = copy(this.state);
      try { const result = await operation(); await this.persist(); return copy(result); }
      catch (error) { this.state = before; throw error; }
    });
  }
  async persist() {
    await mkdir(dirname(this.stateFile), { recursive: true });
    const temporary = `${this.stateFile}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(this.state), { mode: 0o600 }); await rename(temporary, this.stateFile);
  }
  get(id, kind) {
    const revision = this.state.revisions.find((item) => item.id === id);
    if (!revision || kind && revision.kind !== kind) fail("Unknown setup revision or wrong setup kind.");
    return copy(revision);
  }
  selected(kind, id) {
    return this.get(id || this.state.promotions.findLast((item) => item.kind === kind)?.revisionId || this.state.revisions.find((item) => item.kind === kind)?.id, kind);
  }
  catalog() { return { ...copy(this.state), actorDefinition: defaultActorSetup(), judgeConfigs: this.judgeConfigs(), completionJudgeConfigs: this.completionJudgeConfigs() }; }
  judgeConfigs() { return copy(judgeConfigurations(this.judgeConfigDirectory)); }
  completionJudgeConfigs() { return copy(completionJudgeConfigurations(this.completionJudgeConfigDirectory)); }
  publishCompletionJudgeConfig(input) { return this.publishConfig({ ...input, kind: "completion-judge" }); }
  async publishConfig({ configFile, configDigest, predecessorId, feedback, kind = "judge" }) {
    if (!["judge", "completion-judge"].includes(kind)) fail("Unsupported file-backed setup kind.");
    const config = (kind === "judge" ? this.judgeConfigs() : this.completionJudgeConfigs()).find((item) => item.file === configFile);
    if (!config || config.digest !== configDigest) fail("Judge config changed or is unavailable. Reload it before publishing.");
    return this.publish({ ...config.definition, predecessorId, feedback });
  }
  publish(input) {
    return this.serial(async () => {
      const definition = normalize(input);
      const predecessorId = input.predecessorId ?? null;
      if (predecessorId !== null) this.get(predecessorId, definition.kind);
      else if (this.state.revisions.some((item) => item.kind === definition.kind)) fail("A new revision requires its predecessor.");
      if (!Array.isArray(input.feedback) || input.feedback.length > 100) fail("Supply human-feedback references.");
      if (predecessorId !== null && input.feedback.length === 0) fail("A proposed revision requires motivating human feedback.");
      const feedback = [];
      for (const ref of input.feedback) feedback.push(await this.feedbackLoader(copy(ref)));
      const revision = sealed({ schemaVersion: 1, id: `setup-${randomUUID()}`, ...definition, predecessorId, feedback, publishedAt: new Date().toISOString() });
      this.state.revisions.push(revision); return revision;
    });
  }
  validateRelease(release) {
    if (release.schemaVersion !== 1 || release.kind !== "evaluator-release" || typeof release.name !== "string" || !release.name.trim() || release.name.length > 200) fail("Invalid evaluator release.");
    for (const [field, kind] of [["actorSetup", "actor"], ["completionJudgeSetup", "completion-judge"], ["judgeSetup", "judge"]]) {
      verify(release[field] ?? {});
      if (JSON.stringify(release[field]) !== JSON.stringify(this.get(release[field].id, kind))) fail("Evaluator release must pin exact registry revisions.");
    }
    if (release.predecessorId !== null && !this.state.evaluatorReleases.some(item => item.id === release.predecessorId && item.id !== release.id)) fail("Unknown evaluator release predecessor.");
  }
  release(id) {
    const release = this.state.evaluatorReleases.find(item => item.id === id);
    if (!release) fail("Unknown evaluator release.");
    return copy(release);
  }
  publishRelease({ name, actorRevisionId, completionJudgeRevisionId, judgeRevisionId, predecessorId = null }) {
    return this.serial(async () => {
      if (predecessorId !== null) this.release(predecessorId);
      const release = sealed({ schemaVersion: 1, kind: "evaluator-release", id: `evaluator-${randomUUID()}`, name,
        actorSetup: this.get(actorRevisionId, "actor"), completionJudgeSetup: this.get(completionJudgeRevisionId, "completion-judge"),
        judgeSetup: this.get(judgeRevisionId, "judge"), predecessorId, publishedAt: new Date().toISOString() });
      this.validateRelease(release);
      this.state.evaluatorReleases.push(release);
      return release;
    });
  }
  promote({ revisionId, comment }, author) {
    return this.serial(async () => {
      const revision = this.get(revisionId);
      if (typeof comment !== "string" || !comment.trim() || comment.length > 8000) fail("Explain the human promotion decision.");
      const promotion = sealed({ id: randomUUID(), kind: revision.kind, revisionId, previousRevisionId: this.selected(revision.kind).id,
        comment: comment.trim(), author: copy(author), at: new Date().toISOString() });
      this.state.promotions.push(promotion); return promotion;
    });
  }
}
