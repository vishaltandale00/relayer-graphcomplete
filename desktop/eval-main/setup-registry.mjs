import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join, basename } from "node:path";
import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { GRAPH_PRESENTATION_RUBRIC_V11 } from "@relayer/eval-runner";
import { actorConfiguration, ACTOR_PROMPT_TEMPLATE, ACTOR_ACTION_SCHEMA, ACTOR_PROMPT_VERSION } from "./task-actor.mjs";

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
export function defaultActorSetup() {
  return { kind: "actor", name: "Low-effort user", promptVersion: ACTOR_PROMPT_VERSION, promptTemplate: ACTOR_PROMPT_TEMPLATE,
    settings: actorConfiguration(), behaviorContract: { id: "task-actor-v2", actionSchema: copy(ACTOR_ACTION_SCHEMA) } };
}
export function defaultJudgeSetup() {
  const config = judgeConfigurations(defaultJudgeDirectory)[0];
  if (!config) fail("No judge config files are available.");
  return config.definition;
}
function normalize(input) {
  if (!["actor", "judge"].includes(input?.kind)) fail("Choose actor or judge setup.");
  if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 200) fail("Name the setup revision.");
  if (typeof input.promptVersion !== "string" || !input.promptVersion.trim() || input.promptVersion.length > 100) fail("Name the prompt version.");
  if (input.kind === "actor") {
    if (JSON.stringify(input.behaviorContract) !== JSON.stringify(defaultActorSetup().behaviorContract)) fail("Actor behavior authority contract is not editable.");
    return { kind: input.kind, name: input.name.trim(), promptVersion: input.promptVersion,
      promptTemplate: template(input.promptTemplate, ["request", "endpoint", "privateBrief", "exploration", "meticulousness"]),
      settings: actorConfiguration(input.settings), behaviorContract: copy(input.behaviorContract) };
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
  constructor({ stateFile, judgeConfigDirectory = defaultJudgeDirectory, feedbackLoader = async () => fail("Human feedback is unavailable.") }) {
    Object.assign(this, { stateFile, feedbackLoader, judgeConfigDirectory });
    this.state = { schemaVersion: 1, revisions: [], promotions: [] };
    this.tail = Promise.resolve();
  }
  async open() {
    try {
      this.state = JSON.parse(await readFile(this.stateFile, "utf8"));
      if (this.state.schemaVersion !== 1 || !Array.isArray(this.state.revisions) || !Array.isArray(this.state.promotions)) fail("Unsupported setup registry.");
      this.state.revisions.forEach(verify); this.state.promotions.forEach(verify);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    for (const [kind, createDefault] of [["actor", defaultActorSetup], ["judge", defaultJudgeSetup]]) {
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
  catalog() { return { ...copy(this.state), judgeConfigs: this.judgeConfigs() }; }
  judgeConfigs() { return copy(judgeConfigurations(this.judgeConfigDirectory)); }
  async publishConfig({ configFile, configDigest, predecessorId, feedback }) {
    const config = this.judgeConfigs().find((item) => item.file === configFile);
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
