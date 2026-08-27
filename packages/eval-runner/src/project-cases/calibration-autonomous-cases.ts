import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { bindAutonomousCaseSnapshot } from "../cases/catalog.js";
import { createAutonomousCaseSnapshot } from "../cases/contracts.js";
import type { EvalCheck } from "../runtime-basic.js";
import type { CommandResult, CommandRunner, ProjectEvalThreadDefinition } from "./h3.js";

export const calibrationCaseIds = Object.freeze({
  jsonExplorer: "calibration.greenfield.json-explorer",
  localTripBoard: "calibration.greenfield.local-trip-board",
  podcastWorkspace: "calibration.greenfield.podcast-workspace",
  resumableUploads: "calibration.feature.resumable-uploads",
  readonlyCollaborators: "calibration.feature.readonly-collaborators",
  staleResultRace: "calibration.debugging.stale-result-race",
  credentialLeak: "calibration.security.credential-leak",
  romeTransition: "calibration.research.rome-transition",
  humanoidRobots: "calibration.research.humanoid-robots",
  groupEuropeTrip: "calibration.planning.group-europe-trip",
  mysterySeason: "calibration.creative.mystery-season",
  nflForecast: "calibration.forecasting.nfl-season",
} as const);

export type CalibrationCaseId = typeof calibrationCaseIds[keyof typeof calibrationCaseIds];

interface CalibrationFixtureDefinition {
  readonly source: string;
  readonly revision: string;
  readonly packageManager: "node@22" | "none";
}

export interface CalibrationCaseDefinition {
  readonly schemaVersion: 1;
  readonly id: CalibrationCaseId;
  readonly name: string;
  readonly description: string;
  readonly localOnly: true;
  readonly supportedPlatform: "darwin";
  readonly autonomous: true;
  readonly category: "coding" | "work";
  readonly taskType: string;
  readonly fixture: CalibrationFixtureDefinition;
  readonly threads: readonly ProjectEvalThreadDefinition[];
}

interface CalibrationSpec {
  readonly id: CalibrationCaseId;
  readonly name: string;
  readonly description: string;
  readonly category: "coding" | "work";
  readonly taskType: string;
  readonly prompt: string;
  readonly files: Readonly<Record<string, string>>;
  readonly requiredDeliverables: readonly string[];
  readonly referenceSummary: string;
  readonly hiddenScript?: string;
  readonly structuredVerifier?: "sources" | "trip" | "mystery" | "nfl";
}

const codingFiles = (title: string, contract: string, visibleTest: string): Readonly<Record<string, string>> => Object.freeze({
  "README.md": `# ${title}\n\n${contract.trim()}\n`,
  "package.json": `${JSON.stringify({ name: title.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`,
  "src/index.js": "// The starter intentionally leaves the product behavior for the candidate to implement.\nexport const starter = true;\n",
  "test/contract.test.js": visibleTest.trimStart(),
});

const researchFiles = (title: string, deliverables: string): Readonly<Record<string, string>> => Object.freeze({
  "README.md": `# ${title}\n\nThis is an empty research workspace. Research the request independently; no source bundle or preferred answer is provided.\n\n${deliverables.trim()}\n`,
});

const specs: readonly CalibrationSpec[] = Object.freeze([
  Object.freeze({
    id: calibrationCaseIds.jsonExplorer,
    name: "0→1 · huge JSON explorer",
    description: "Builds a responsive visual workspace for searching and comparing large JSON documents.",
    category: "coding",
    taskType: "greenfield-build",
    prompt: "Build me a really good web app for exploring and comparing huge JSON files. I want to find differences without the page freezing. Make it usable, test it, and commit the finished app. Do not push or publish anything.",
    files: codingFiles("JSON Explorer", `Build a browser application, not only a library. Keep the pure data operations in \`src/index.js\` and export:\n\n- \`parseJson(text)\` returning \`{ ok: true, value }\` or \`{ ok: false, error }\`;\n- \`diffJson(left, right)\` returning deterministic entries with JSON-pointer \`path\` and \`kind\` (\`added\`, \`removed\`, or \`changed\`);\n- \`searchJson(value, query)\` returning matching JSON-pointer paths.\n\nThe finished product must also include an \`index.html\`, usable visual navigation, input-error recovery, and a design that can move expensive work off the main interaction path.`, `import test from "node:test";
import assert from "node:assert/strict";
import { diffJson, parseJson, searchJson } from "../src/index.js";

test("parses, searches, and compares nested JSON", () => {
  assert.deepEqual(parseJson('{"a":1}'), { ok: true, value: { a: 1 } });
  assert.equal(parseJson('{').ok, false);
  assert.deepEqual(searchJson({ user: { name: "Ada" } }, "ada"), ["/user/name"]);
  assert.deepEqual(diffJson({ a: 1 }, { a: 2, b: true }), [
    { path: "/a", kind: "changed", before: 1, after: 2 },
    { path: "/b", kind: "added", after: true },
  ]);
});
`),
    requiredDeliverables: ["src/index.js", "test/contract.test.js", "index.html"],
    referenceSummary: "A complete solution combines correct deterministic JSON operations with a responsive, navigable browser experience and explicit large-input/error handling.",
    hiddenScript: `import assert from 'node:assert/strict'; import {diffJson,parseJson,searchJson} from './src/index.js';
assert.equal(parseJson('null').ok,true); assert.equal(parseJson('{').ok,false);
assert.deepEqual(searchJson({a:[{label:'Needle'}]},'needle'),['/a/0/label']);
assert.deepEqual(diffJson({a:[1,2]},{a:[1,3]}),[{path:'/a/1',kind:'changed',before:2,after:3}]);`,
  }),
  Object.freeze({
    id: calibrationCaseIds.localTripBoard,
    name: "0→1 · local-first group trip board",
    description: "Builds an offline trip board with deterministic merge and undo semantics.",
    category: "coding",
    taskType: "greenfield-build",
    prompt: "Build a trip-planning board my friends and I can use offline. Our edits should merge when we reconnect, and we need to undo mistakes. Make the app work, test it, and commit it. Do not push or publish anything.",
    files: codingFiles("Local-first Trip Board", `Build a browser application with an itinerary board and durable local state. Export these pure operations from \`src/index.js\`:\n\n- \`createBoard(actorId)\`;\n- \`applyEdit(board, edit)\`, where edits have stable \`id\`, \`actorId\`, \`sequence\`, \`type\`, and payload;\n- \`mergeBoards(left, right)\`, which must be commutative, idempotent, deterministic, and preserve independent edits;\n- \`undo(board, actorId)\`, which reverses that actor's latest effective edit without erasing another actor's work;\n- \`serializeBoard\` and \`deserializeBoard\`.\n\nAdd an \`index.html\` and a usable offline interface. Document the conflict rule rather than silently using arrival order.`, `import test from "node:test";
import assert from "node:assert/strict";
import { applyEdit, createBoard, mergeBoards, undo } from "../src/index.js";

test("independent offline edits converge and actor undo is scoped", () => {
  const base = createBoard("maya");
  const maya = applyEdit(base, { id: "m1", actorId: "maya", sequence: 1, type: "add", item: { id: "rome", title: "Rome" } });
  const luis = applyEdit(base, { id: "l1", actorId: "luis", sequence: 1, type: "add", item: { id: "paris", title: "Paris" } });
  assert.deepEqual(mergeBoards(maya, luis), mergeBoards(luis, maya));
  assert.deepEqual(mergeBoards(maya, maya), maya);
  const undone = undo(mergeBoards(maya, luis), "maya");
  assert.equal(undone.items.some((item) => item.id === "rome"), false);
  assert.equal(undone.items.some((item) => item.id === "paris"), true);
});
`),
    requiredDeliverables: ["src/index.js", "test/contract.test.js", "index.html"],
    referenceSummary: "A complete solution provides a usable offline board plus a documented convergent edit model, durable serialization, scoped undo, and conflict-focused tests.",
    hiddenScript: `import assert from 'node:assert/strict'; import {createBoard,applyEdit,mergeBoards,serializeBoard,deserializeBoard} from './src/index.js';
const b=createBoard('a'); const x=applyEdit(b,{id:'x',actorId:'a',sequence:1,type:'add',item:{id:'x',title:'X'}}); const y=applyEdit(b,{id:'y',actorId:'b',sequence:1,type:'add',item:{id:'y',title:'Y'}});
assert.deepEqual(mergeBoards(x,y),mergeBoards(y,x)); assert.deepEqual(mergeBoards(x,x),x); assert.deepEqual(deserializeBoard(serializeBoard(mergeBoards(x,y))),mergeBoards(x,y));`,
  }),
  Object.freeze({
    id: calibrationCaseIds.podcastWorkspace,
    name: "0→1 · podcast research workspace",
    description: "Builds transcript search, timestamped clips, persistent playlists, and portable export.",
    category: "coding",
    taskType: "greenfield-build",
    prompt: "Build an app where I can search podcast transcripts, save timestamped clips, and organize them into playlists. Make it polished enough to use, test it, and commit it. Do not push or publish anything.",
    files: Object.freeze({
      ...codingFiles("Podcast Research Workspace", `Build a browser application around the transcript fixture in \`fixtures/transcript.json\`. Export \`searchTranscript(segments, query)\`, \`createClip(segments, startMs, endMs)\`, \`createPlaylist(title)\`, \`addClip(playlist, clip)\`, \`exportWorkspace(value)\`, and \`importWorkspace(text)\` from \`src/index.js\`. Clip boundaries must be valid and playlists must preserve ordering. Add \`index.html\`, persistent local state, and keyboard-usable controls.`, `import test from "node:test";
import assert from "node:assert/strict";
import { addClip, createClip, createPlaylist, importWorkspace, exportWorkspace, searchTranscript } from "../src/index.js";
import segments from "../fixtures/transcript.json" with { type: "json" };

test("searches transcript and round-trips an ordered clip playlist", () => {
  assert.deepEqual(searchTranscript(segments, "retries").map((item) => item.id), ["s2"]);
  const clip = createClip(segments, 900, 4100);
  const playlist = addClip(createPlaylist("Reliability"), clip);
  assert.deepEqual(importWorkspace(exportWorkspace({ playlists: [playlist] })), { playlists: [playlist] });
});
`),
      "fixtures/transcript.json": `${JSON.stringify([
        { id: "s1", startMs: 0, endMs: 1_500, text: "Today we are discussing durable jobs." },
        { id: "s2", startMs: 1_500, endMs: 4_000, text: "Retries need stable idempotency keys." },
        { id: "s3", startMs: 4_000, endMs: 6_500, text: "Recovery should preserve evidence." },
      ], null, 2)}\n`,
    }),
    requiredDeliverables: ["src/index.js", "test/contract.test.js", "index.html"],
    referenceSummary: "A complete solution delivers accurate transcript search and clipping, ordered persistent playlists, portable round-tripping, and a usable keyboard-accessible browser workspace.",
    hiddenScript: `import assert from 'node:assert/strict'; import fs from 'node:fs'; import {createClip,searchTranscript,createPlaylist,addClip} from './src/index.js'; const s=JSON.parse(fs.readFileSync('./fixtures/transcript.json'));
assert.deepEqual(searchTranscript(s,'IDEMPOTENCY').map(x=>x.id),['s2']); assert.throws(()=>createClip(s,5000,1000)); const p=addClip(addClip(createPlaylist('x'),createClip(s,0,1000)),createClip(s,4000,5000)); assert.equal(p.clips.length,2);`,
  }),
  Object.freeze({
    id: calibrationCaseIds.resumableUploads,
    name: "Feature · durable resumable uploads",
    description: "Extends a seeded upload core with restart-safe chunking, idempotency, integrity, cancellation, and cleanup.",
    category: "coding",
    taskType: "feature-change",
    prompt: "Make large uploads resumable, including after the app restarts. Preserve ordinary uploads, handle retries safely, add focused tests, and commit the change. Do not push or publish anything.",
    files: Object.freeze({
      ...codingFiles("Upload Core", `This repository already exposes ordinary in-memory uploads through \`UploadStore\` in \`src/index.js\`. Extend it without removing \`put(id, bytes)\` or \`get(id)\`. Add restart-safe \`begin\`, \`acceptChunk\`, \`resumeState\`, \`finalize\`, \`cancel\`, \`exportState\`, and \`fromState\`. Repeating the same chunk must be idempotent; conflicting bytes for the same chunk must fail; finalize must reject gaps and integrity mismatches.`, `import test from "node:test";
import assert from "node:assert/strict";
import { UploadStore } from "../src/index.js";

test("ordinary uploads remain available", () => {
  const store = new UploadStore();
  store.put("small", Buffer.from("hello"));
  assert.equal(store.get("small").toString(), "hello");
});

test("a chunked upload resumes after state round-trip", () => {
  const store = new UploadStore();
  store.begin("large", { chunks: 2 });
  store.acceptChunk("large", 0, Buffer.from("hel"));
  const resumed = UploadStore.fromState(store.exportState());
  resumed.acceptChunk("large", 1, Buffer.from("lo"));
  assert.equal(resumed.finalize("large").toString(), "hello");
});
`),
      "src/index.js": `export class UploadStore {
  #files = new Map();
  put(id, bytes) { this.#files.set(id, Buffer.from(bytes)); }
  get(id) { const value = this.#files.get(id); return value && Buffer.from(value); }
}
`,
    }),
    requiredDeliverables: ["src/index.js", "test/contract.test.js"],
    referenceSummary: "A complete solution preserves the old path while implementing durable, idempotent, integrity-checked chunk lifecycle behavior with restart and cleanup coverage.",
    hiddenScript: `import assert from 'node:assert/strict'; import {UploadStore} from './src/index.js'; const s=new UploadStore(); s.begin('u',{chunks:2}); s.acceptChunk('u',0,Buffer.from('a')); s.acceptChunk('u',0,Buffer.from('a')); assert.throws(()=>s.acceptChunk('u',0,Buffer.from('b'))); assert.throws(()=>s.finalize('u')); const r=UploadStore.fromState(s.exportState()); r.acceptChunk('u',1,Buffer.from('b')); assert.equal(r.finalize('u').toString(),'ab');`,
  }),
  Object.freeze({
    id: calibrationCaseIds.readonlyCollaborators,
    name: "Feature · read-only collaborators",
    description: "Adds invitation, authorization, revocation, UI-state, and compatibility behavior to a seeded project model.",
    category: "coding",
    taskType: "feature-change",
    prompt: "Let me invite someone who can view a project but can’t change anything. Enforce it for real, cover the important lifecycle, test it, and commit the change. Do not push or publish anything.",
    files: Object.freeze({
      ...codingFiles("Project Membership Core", `The existing \`ProjectAccess\` supports owners and editors. Add viewer invitations and membership without weakening server-side authorization. Keep existing methods compatible and implement invitation creation, acceptance, revocation, \`authorize(userId, action)\`, and a serializable UI projection. Viewers may read but may not mutate, invite, delete, or bypass denial by calling the core directly.`, `import test from "node:test";
import assert from "node:assert/strict";
import { ProjectAccess } from "../src/index.js";

test("viewer lifecycle grants reads and denies every mutation", () => {
  const access = new ProjectAccess({ ownerId: "owner" });
  const invitation = access.invite("owner", "viewer@example.test", "viewer");
  access.accept(invitation.token, "viewer");
  assert.equal(access.authorize("viewer", "read"), true);
  for (const action of ["write", "invite", "delete"]) assert.equal(access.authorize("viewer", action), false);
  access.revoke("owner", "viewer");
  assert.equal(access.authorize("viewer", "read"), false);
});
`),
      "src/index.js": `export class ProjectAccess {
  #roles = new Map();
  constructor({ ownerId }) { this.#roles.set(ownerId, "owner"); }
  addEditor(actorId, userId) { if (this.#roles.get(actorId) !== "owner") throw new Error("forbidden"); this.#roles.set(userId, "editor"); }
  authorize(userId, action) { const role = this.#roles.get(userId); return role === "owner" || (role === "editor" && action !== "delete"); }
}
`,
    }),
    requiredDeliverables: ["src/index.js", "test/contract.test.js"],
    referenceSummary: "A complete solution owns the viewer lifecycle and denies protected operations in the authorization core while preserving existing roles and projecting clear UI state.",
    hiddenScript: `import assert from 'node:assert/strict'; import {ProjectAccess} from './src/index.js'; const a=new ProjectAccess({ownerId:'o'}); const i=a.invite('o','v@x.test','viewer'); assert.throws(()=>a.invite('x','z@x.test','viewer')); a.accept(i.token,'v'); for(const x of ['write','invite','delete']) assert.equal(a.authorize('v',x),false); assert.equal(a.authorize('o','delete'),true);`,
  }),
  Object.freeze({
    id: calibrationCaseIds.staleResultRace,
    name: "Debugging · stale result race",
    description: "Diagnoses and repairs a seeded overlapping-publication race without globally serializing work.",
    category: "coding",
    taskType: "debugging",
    prompt: "Users sometimes see an older result after refreshing. Figure out why and fix it without making all work run one at a time. Add a regression test, verify it, and commit the fix. Do not push or publish anything.",
    files: Object.freeze({
      ...codingFiles("Asynchronous Result Store", `\`ResultStore\` receives results from overlapping attempts. A larger generation is newer. The seeded implementation publishes whichever attempt finishes last, so a slow old generation can replace a newer one. Preserve concurrent execution while making publication and state round-tripping safe.`, `import test from "node:test";
import assert from "node:assert/strict";
import { ResultStore } from "../src/index.js";

test("a stale completion cannot overwrite a newer generation", async () => {
  const store = new ResultStore();
  await store.publish("report", { generation: 2, value: "new" });
  await store.publish("report", { generation: 1, value: "old" });
  assert.deepEqual(store.read("report"), { generation: 2, value: "new" });
});
`),
      "src/index.js": `export class ResultStore {
  #results = new Map();
  async publish(key, result) { await Promise.resolve(); this.#results.set(key, structuredClone(result)); }
  read(key) { const result = this.#results.get(key); return result && structuredClone(result); }
  exportState() { return JSON.stringify([...this.#results]); }
  static fromState(state) { const store = new ResultStore(); store.#results = new Map(JSON.parse(state)); return store; }
}
`,
    }),
    requiredDeliverables: ["src/index.js", "test/contract.test.js"],
    referenceSummary: "A complete solution identifies the publication race and uses per-result monotonic admission rather than global work serialization, including restart and concurrency regression evidence.",
    hiddenScript: `import assert from 'node:assert/strict'; import {ResultStore} from './src/index.js'; const s=new ResultStore(); await Promise.all([s.publish('x',{generation:3,value:'three'}),s.publish('x',{generation:1,value:'one'}),s.publish('x',{generation:2,value:'two'})]); assert.equal(s.read('x').generation,3); const r=ResultStore.fromState(s.exportState()); await r.publish('x',{generation:2,value:'stale'}); assert.equal(r.read('x').value,'three');`,
  }),
  Object.freeze({
    id: calibrationCaseIds.credentialLeak,
    name: "Security · proxy credential leakage",
    description: "Repairs seeded leakage while preserving proxy transport authentication.",
    category: "coding",
    taskType: "debugging",
    prompt: "Stop proxy credentials from appearing in logs, errors, and debug representations without breaking proxy authentication. Add adversarial tests and commit the fix. Do not push or publish anything.",
    files: Object.freeze({
      ...codingFiles("Proxy Transport", `The seeded proxy helper must continue to derive a correct Basic authorization header from URL userinfo. Export \`proxyAuthorization(url)\`, \`sanitizeUrl(url)\`, \`safeError(error)\`, and \`debugProxy(url)\`. No raw or percent-encoded password may appear in sanitized URLs, errors, or debug output. Do not redact unrelated host, port, path, or username information.`, `import test from "node:test";
import assert from "node:assert/strict";
import { debugProxy, proxyAuthorization, safeError, sanitizeUrl } from "../src/index.js";

test("keeps transport auth while redacting representations", () => {
  const url = "http://ada:s3cr%40t@proxy.example:8080/path";
  assert.equal(proxyAuthorization(url), "Basic " + Buffer.from("ada:s3cr@t").toString("base64"));
  for (const value of [sanitizeUrl(url), debugProxy(url), safeError(new Error("failed " + url)).message]) {
    assert.equal(value.includes("s3cr"), false);
    assert.equal(value.includes("proxy.example:8080"), true);
  }
});
`),
      "src/index.js": `export function proxyAuthorization(value) { const url = new URL(value); return "Basic " + Buffer.from(decodeURIComponent(url.username) + ":" + decodeURIComponent(url.password)).toString("base64"); }
export function sanitizeUrl(value) { return String(value); }
export function safeError(error) { return new Error(String(error?.message ?? error)); }
export function debugProxy(value) { return "Proxy(" + value + ")"; }
`,
    }),
    requiredDeliverables: ["src/index.js", "test/contract.test.js"],
    referenceSummary: "A complete solution separates secret-bearing transport data from every representation, handles encoded credentials, preserves useful URL context, and adds adversarial regression coverage.",
    hiddenScript: `import assert from 'node:assert/strict'; import {proxyAuthorization,sanitizeUrl,debugProxy,safeError} from './src/index.js'; const u='http://u:p%40ss@proxy.test:9/a'; assert.equal(proxyAuthorization(u),'Basic '+Buffer.from('u:p@ss').toString('base64')); for(const x of [sanitizeUrl(u),debugProxy(u),safeError(new Error(u)).message]){assert.equal(/p%40ss|p@ss/.test(x),false); assert.equal(x.includes('proxy.test:9'),true);}`,
  }),
  Object.freeze({
    id: calibrationCaseIds.romeTransition,
    name: "History · Rome’s republic-to-empire transition",
    description: "Explains a long institutional transformation through chronology, actors, causes, and contested turning points.",
    category: "work",
    taskType: "historical-explanation",
    prompt: "How did Rome go from a republic to an empire when nobody simply voted to end the republic? Research it and write me a clear, compelling briefing in rome-briefing.md with a source list in sources.json. Commit the result. Do not push or publish anything.",
    files: researchFiles("Rome: Republic to Empire", "Deliver a Markdown briefing and a JSON array in `sources.json`. Each source entry must contain a title, URL, publisher, and access date. Source selection and interpretation are part of the task."),
    requiredDeliverables: ["rome-briefing.md", "sources.json"],
    referenceSummary: "A strong briefing explains institutional erosion across time, connects actors and structural causes, treats disputed turning points honestly, and distinguishes evidence from interpretation.",
    structuredVerifier: "sources",
  }),
  Object.freeze({
    id: calibrationCaseIds.humanoidRobots,
    name: "Current technology · humanoid robots",
    description: "Separates demonstrated capability, pilots, claims, economics, constraints, and uncertainty in a fast-moving field.",
    category: "work",
    taskType: "current-events-research",
    prompt: "What’s actually going on with humanoid robots right now—what really works, what’s hype, and who is close? Research it as of today and write humanoid-robots.md plus sources.json. Commit the result. Do not push or publish anything.",
    files: researchFiles("Humanoid Robots: Current State", "Deliver a dated Markdown briefing and a JSON array in `sources.json`. Each source entry must contain title, URL, publisher, published date when available, and access date. No preferred companies or sources are supplied."),
    requiredDeliverables: ["humanoid-robots.md", "sources.json"],
    referenceSummary: "A strong briefing distinguishes claims from demonstrated deployments, compares the field on consistent dimensions, covers technical and economic constraints, and makes uncertainty visible.",
    structuredVerifier: "sources",
  }),
  Object.freeze({
    id: calibrationCaseIds.groupEuropeTrip,
    name: "Planning · multi-city group Europe trip",
    description: "Coordinates six travelers with different origins, dates, preferences, mobility, and shared-time constraints.",
    category: "work",
    taskType: "travel-planning",
    prompt: "Plan a Europe trip for Maya, Luis, Priya, Sam, Jordan, and me from September 5–19, 2027. We’re coming from New York, Miami, London, Toronto, Austin, and San Francisco; Maya arrives September 6, Sam and Jordan leave September 16, Maya and Luis want nightlife, Priya and Sam care most about museums and food, Jordan can’t walk all day, and I want everyone together September 11–12. We don’t all need every city and want to stay under $4,500 each before flights. Research a feasible plan, write trip-plan.md, itineraries.json, and sources.json, then commit it. Do not book anything or push or publish anything.",
    files: researchFiles("Six-person Europe Trip", "Deliver `trip-plan.md`, `sources.json`, and `itineraries.json`. The itinerary file must be a JSON object with a `travelers` array; each traveler has a name and dated `days`, and each day records city plus activities. Include shared lodging/transit logic and mobility-aware alternatives."),
    requiredDeliverables: ["trip-plan.md", "itineraries.json", "sources.json"],
    referenceSummary: "A strong plan is date- and transit-feasible, keeps the shared weekend intact, respects individual preferences and mobility, coordinates lodging, and exposes alternatives and assumptions.",
    structuredVerifier: "trip",
  }),
  Object.freeze({
    id: calibrationCaseIds.mysterySeason,
    name: "Creative · murder-mystery television season",
    description: "Designs a bingeable fair-play mystery with coherent clues, character arcs, episode reveals, and finale resolution.",
    category: "work",
    taskType: "creative-development",
    prompt: "Design the first season of a new murder-mystery show that I’d actually want to binge. Create a proper season bible in season-bible.md and an episode-and-clue outline in episodes.json, then commit it. Do not push or publish anything.",
    files: researchFiles("Murder-mystery Season", "Deliver `season-bible.md` and `episodes.json`. The JSON must contain 8–10 ordered episodes, the culprit and motive, and a clue ledger whose setup episode is not later than its payoff episode. The creative choices remain yours."),
    requiredDeliverables: ["season-bible.md", "episodes.json"],
    referenceSummary: "A strong season has an original dramatic engine, fair-play clue logic, character-driven suspicion, escalating episode turns, a satisfying solution, and future hooks that do not invalidate the mystery.",
    structuredVerifier: "mystery",
  }),
  Object.freeze({
    id: calibrationCaseIds.nflForecast,
    name: "Forecasting · every NFL team",
    description: "Produces a current, internally consistent 32-team season forecast with evidence, assumptions, and playoff implications.",
    category: "work",
    taskType: "sports-forecasting",
    prompt: "Predict the upcoming NFL season for every team and explain how you got there. Research the current league, write nfl-forecast.md, predictions.json, and sources.json, then commit the result. Do not gamble, push, or publish anything.",
    files: researchFiles("NFL Season Forecast", "Deliver `nfl-forecast.md`, `sources.json`, and `predictions.json`. Predictions must be a JSON object with a 32-entry `teams` array; every entry has team, wins, losses, division, playoff, reasoning, and uncertainty. Include exactly 14 playoff teams and make league totals internally consistent."),
    requiredDeliverables: ["nfl-forecast.md", "predictions.json", "sources.json"],
    referenceSummary: "A strong forecast uses current team evidence, provides non-boilerplate reasoning for all 32 teams, reconciles records league-wide, and exposes uncertainty and high-leverage assumptions.",
    structuredVerifier: "nfl",
  }),
]);

const digest = (value: string): `sha256:${string}` => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const canonicalFiles = (files: Readonly<Record<string, string>>): string => Object.entries(files)
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([path, contents]) => `${path}\0${contents.length}\0${contents}`)
  .join("\0");

const fixtureFor = (spec: CalibrationSpec): CalibrationFixtureDefinition => Object.freeze({
  source: `relayer-eval://calibration/${spec.id}`,
  revision: `template:${digest(canonicalFiles(spec.files))}`,
  packageManager: spec.category === "coding" ? "node@22" : "none",
});

function threadFor(spec: CalibrationSpec): ProjectEvalThreadDefinition {
  return Object.freeze({
    id: "delivery",
    name: "Complete the task",
    permissionProfileId: "auto",
    mutationPolicy: "writable",
    workspaceGrade: "autonomous-implementation",
    prompts: Object.freeze([spec.prompt]),
  });
}

const definitions: readonly CalibrationCaseDefinition[] = Object.freeze(specs.map((spec) => Object.freeze({
  schemaVersion: 1 as const,
  id: spec.id,
  name: spec.name,
  description: spec.description,
  localOnly: true as const,
  supportedPlatform: "darwin" as const,
  autonomous: true as const,
  category: spec.category,
  taskType: spec.taskType,
  fixture: fixtureFor(spec),
  threads: Object.freeze([threadFor(spec)]),
})));

function bind(definition: CalibrationCaseDefinition) {
  const spec = requireSpec(definition.id);
  const criteria = definition.category === "coding"
    ? [
      { id: "behavior", label: "Behavioral correctness", description: "The requested behavior works across the visible and evaluator-owned checks.", weight: 3 },
      { id: "quality", label: "Implementation quality", description: "The implementation is coherent, usable, tested, and fits the starter architecture.", weight: 1 },
    ]
    : [
      { id: "substance", label: "Substantive quality", description: "The deliverable is accurate or internally coherent, complete for the request, and appropriately evidence-grounded.", weight: 3 },
      { id: "usability", label: "Deliverable usability", description: "The result is clear, useful, and well structured for its intended audience.", weight: 1 },
    ];
  const verifierSource = [gradeCalibrationWorkspace.toString(), verifyStructuredDeliverable.toString(), spec.hiddenScript ?? "", spec.structuredVerifier ?? ""].join("\n");
  return bindAutonomousCaseSnapshot(definition, createAutonomousCaseSnapshot({
    id: definition.id,
    name: definition.name,
    description: definition.description,
    category: definition.category,
    taskType: definition.taskType,
    artifacts: {
      task: { kind: "visible-task", text: spec.prompt, contentDigest: digest(spec.prompt) },
      workspace: {
        kind: "frozen-workspace",
        materializerId: "calibration-template-v1",
        source: definition.fixture.source,
        revision: definition.fixture.revision,
        contentDigest: digest(canonicalFiles(spec.files)),
        environmentDigest: digest(JSON.stringify({ packageManager: definition.fixture.packageManager, platform: "darwin" })),
      },
      reference: {
        kind: "sealed-reference",
        artifactId: `${definition.id.replaceAll(".", "-")}-reference-v1`,
        format: "markdown",
        contentDigest: digest(spec.referenceSummary),
        sealedPath: "packages/eval-runner/src/project-cases/calibration-autonomous-cases.ts",
      },
      verifier: {
        kind: "sealed-verifier",
        artifactId: `${definition.id.replaceAll(".", "-")}-verifier-v1`,
        verifierId: `${definition.id.replaceAll(".", "-")}-v1`,
        contentDigest: digest(verifierSource),
        sealedPath: "packages/eval-runner/src/project-cases/calibration-autonomous-cases.ts",
        mandatoryGates: [
          { id: "required-deliverables", label: "Required deliverables", description: "The requested durable artifacts exist and are non-empty." },
          { id: "behavior-or-structure", label: definition.category === "coding" ? "Behavioral checks" : "Artifact structure", description: definition.category === "coding" ? "Visible and evaluator-owned behavioral checks pass." : "Machine-checkable structural and consistency requirements pass without pretending to judge subjective quality." },
          { id: "scoped-commit", label: "Committed delivery", description: "The candidate created at least one commit and left the workspace clean." },
        ],
      },
      outcomeRubric: {
        kind: "outcome-rubric",
        rubricVersion: `${definition.id.replaceAll(".", "-")}-outcome-v1`,
        criteria,
        contentDigest: digest(JSON.stringify(criteria)),
      },
    },
  }));
}

export const calibrationAutonomousCases = Object.freeze(definitions.map(bind));
export const calibrationAutonomousCaseIds = new Set<CalibrationCaseId>(definitions.map(({ id }) => id));

export interface CalibrationFixtureReceipt {
  readonly schemaVersion: 1;
  readonly fixtureId: CalibrationCaseId;
  readonly workspaceDirectory: string;
  readonly repositoryUrl: string;
  readonly sourceRevision: string;
  readonly seededCommit: string;
  readonly seededTree: string;
  readonly packageManager: "node@22" | "none";
  readonly installedWithFrozenLockfile: false;
}

export async function materializeCalibrationFixture(options: {
  readonly caseId: CalibrationCaseId;
  readonly workspaceDirectory: string;
  readonly platform?: NodeJS.Platform;
  readonly runCommand?: CommandRunner;
}): Promise<CalibrationFixtureReceipt> {
  if ((options.platform ?? process.platform) !== "darwin") throw new Error("Calibration cases are local Mac only.");
  const spec = requireSpec(options.caseId);
  const definition = requireDefinition(options.caseId);
  await requireMissing(options.workspaceDirectory);
  await mkdir(options.workspaceDirectory, { recursive: true, mode: 0o700 });
  for (const [relativePath, contents] of Object.entries(spec.files)) {
    const target = join(options.workspaceDirectory, relativePath);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, contents, "utf8");
  }
  const runCommand = options.runCommand ?? run;
  await required(runCommand, "git", ["init", "--quiet", "--initial-branch=main"], options.workspaceDirectory);
  await required(runCommand, "git", ["config", "user.name", "Relayer Eval Fixture"], options.workspaceDirectory);
  await required(runCommand, "git", ["config", "user.email", "eval-fixture@relayer.local"], options.workspaceDirectory);
  await required(runCommand, "git", ["add", "--all"], options.workspaceDirectory);
  await required(runCommand, "git", ["commit", "--quiet", "-m", `Seed ${options.caseId}`], options.workspaceDirectory, {
    GIT_AUTHOR_DATE: "2026-08-27T12:00:00Z",
    GIT_COMMITTER_DATE: "2026-08-27T12:00:00Z",
  });
  const seededCommit = (await required(runCommand, "git", ["rev-parse", "HEAD"], options.workspaceDirectory)).stdout.trim();
  const seededTree = (await required(runCommand, "git", ["rev-parse", "HEAD^{tree}"], options.workspaceDirectory)).stdout.trim();
  return Object.freeze({
    schemaVersion: 1 as const,
    fixtureId: options.caseId,
    workspaceDirectory: options.workspaceDirectory,
    repositoryUrl: definition.fixture.source,
    sourceRevision: definition.fixture.revision,
    seededCommit,
    seededTree,
    packageManager: definition.fixture.packageManager,
    installedWithFrozenLockfile: false as const,
  });
}

export async function gradeCalibrationWorkspace(options: {
  readonly caseId: CalibrationCaseId;
  readonly workspaceDirectory: string;
  readonly baseRevision?: string;
  readonly runCommand?: CommandRunner;
}): Promise<readonly EvalCheck[]> {
  const spec = requireSpec(options.caseId);
  const runCommand = options.runCommand ?? run;
  const baseRevision = options.baseRevision ?? (await required(runCommand, "git", ["rev-list", "--max-parents=0", "HEAD"], options.workspaceDirectory)).stdout.trim();
  const deliverableChecks = await Promise.all(spec.requiredDeliverables.map(async (relativePath) => {
    const contents = await readFile(join(options.workspaceDirectory, relativePath), "utf8").catch(() => "");
    return { relativePath, present: contents.trim().length > 0 };
  }));
  const behavior = spec.category === "coding"
    ? await verifyCoding(spec, options.workspaceDirectory, runCommand)
    : await verifyStructuredDeliverable(spec, options.workspaceDirectory);
  const commits = lines((await required(runCommand, "git", ["rev-list", `${baseRevision}..HEAD`], options.workspaceDirectory)).stdout);
  const status = (await required(runCommand, "git", ["status", "--porcelain=v1", "--untracked-files=all"], options.workspaceDirectory)).stdout.trim();
  return Object.freeze([
    {
      name: "workspace:required-deliverables",
      passed: deliverableChecks.every(({ present }) => present),
      detail: deliverableChecks.map(({ relativePath, present }) => `${relativePath}: ${present ? "present" : "missing"}`).join(", "),
    },
    { name: "workspace:behavior-or-structure", passed: behavior.exitCode === 0, detail: commandDetail("case verifier", behavior) },
    { name: "workspace:delivery-commit", passed: commits.length >= 1, detail: `${commits.length} post-fixture commit(s).` },
    { name: "workspace:delivery-clean", passed: status === "", detail: status === "" ? "The workspace is clean." : `Uncommitted changes remain: ${status}` },
  ]);
}

async function verifyCoding(spec: CalibrationSpec, cwd: string, runCommand: CommandRunner): Promise<CommandResult> {
  const visible = await runCommand("npm", ["test"], { cwd });
  if (visible.exitCode !== 0 || !spec.hiddenScript) return visible;
  return runCommand("node", ["--input-type=module", "--eval", spec.hiddenScript], { cwd });
}

async function verifyStructuredDeliverable(spec: CalibrationSpec, cwd: string): Promise<CommandResult> {
  const fail = (message: string): CommandResult => ({ exitCode: 1, stdout: "", stderr: message });
  const readJson = async (path: string): Promise<unknown> => {
    try { return JSON.parse(await readFile(join(cwd, path), "utf8")); } catch { return undefined; }
  };
  const sources = spec.requiredDeliverables.includes("sources.json") ? await readJson("sources.json") : undefined;
  if (spec.requiredDeliverables.includes("sources.json") && (!Array.isArray(sources) || sources.length < 5 || sources.some((source) => (
    !source || typeof source !== "object" || typeof source.title !== "string" || typeof source.url !== "string" || !/^https?:\/\//.test(source.url)
  )))) return fail("sources.json must contain at least five titled HTTP(S) sources.");
  if (spec.structuredVerifier === "trip") {
    const itinerary = await readJson("itineraries.json") as { travelers?: unknown } | undefined;
    const travelers = Array.isArray(itinerary?.travelers) ? itinerary.travelers as { name?: unknown; days?: unknown }[] : [];
    const names = new Set(travelers.map(({ name }) => String(name).toLowerCase()));
    if (travelers.length !== 6 || !["maya", "luis", "priya", "sam", "jordan"].every((name) => names.has(name))) return fail("itineraries.json must contain all six travelers.");
    if (travelers.some(({ days }) => !Array.isArray(days) || days.length === 0)) return fail("Every traveler needs dated itinerary days.");
  }
  if (spec.structuredVerifier === "mystery") {
    const outline = await readJson("episodes.json") as { episodes?: unknown; clues?: unknown; culprit?: unknown; motive?: unknown } | undefined;
    const episodes = Array.isArray(outline?.episodes) ? outline.episodes : [];
    const clues = Array.isArray(outline?.clues) ? outline.clues as { setupEpisode?: unknown; payoffEpisode?: unknown }[] : [];
    if (episodes.length < 8 || episodes.length > 10 || typeof outline?.culprit !== "string" || typeof outline?.motive !== "string") return fail("episodes.json needs 8–10 episodes plus culprit and motive.");
    if (clues.length < 5 || clues.some(({ setupEpisode, payoffEpisode }) => !Number.isInteger(setupEpisode) || !Number.isInteger(payoffEpisode) || Number(setupEpisode) > Number(payoffEpisode))) return fail("The clue ledger must contain at least five setup-before-payoff clues.");
  }
  if (spec.structuredVerifier === "nfl") {
    const forecast = await readJson("predictions.json") as { teams?: unknown } | undefined;
    const teams = Array.isArray(forecast?.teams) ? forecast.teams as { team?: unknown; wins?: unknown; losses?: unknown; playoff?: unknown; reasoning?: unknown }[] : [];
    if (teams.length !== 32 || new Set(teams.map(({ team }) => team)).size !== 32) return fail("predictions.json needs 32 unique teams.");
    if (teams.some(({ wins, losses, reasoning }) => !Number.isInteger(wins) || !Number.isInteger(losses) || Number(wins) + Number(losses) !== 17 || typeof reasoning !== "string" || reasoning.trim().length < 20)) return fail("Every team needs a 17-game record and substantive reasoning.");
    if (teams.reduce((sum, { wins }) => sum + Number(wins), 0) !== 272 || teams.filter(({ playoff }) => playoff === true).length !== 14) return fail("League wins must total 272 and exactly 14 teams must make the playoffs.");
  }
  return { exitCode: 0, stdout: "Machine-checkable artifact structure passed; semantic quality remains for scoped outcome review.", stderr: "" };
}

function requireSpec(caseId: CalibrationCaseId): CalibrationSpec {
  const spec = specs.find(({ id }) => id === caseId);
  if (!spec) throw new Error(`Unknown calibration case: ${caseId}`);
  return spec;
}

function requireDefinition(caseId: CalibrationCaseId): CalibrationCaseDefinition {
  const definition = definitions.find(({ id }) => id === caseId);
  if (!definition) throw new Error(`Unknown calibration case definition: ${caseId}`);
  return definition;
}

async function requireMissing(path: string): Promise<void> {
  try { await access(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  throw new Error(`Refusing to overwrite existing calibration workspace: ${path}`);
}

async function required(
  runCommand: CommandRunner,
  command: string,
  args: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string>> = {},
): Promise<CommandResult> {
  const result = await runCommand(command, args, { cwd, env: { ...process.env, ...environment } as Readonly<Record<string, string>> });
  if (result.exitCode !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`);
  return result;
}

function lines(value: string): string[] { return value.split("\n").map((line) => line.trim()).filter(Boolean); }
function commandDetail(label: string, result: CommandResult): string { return result.exitCode === 0 ? `${label} passed.` : `${label} failed (${result.exitCode}): ${(result.stderr || result.stdout).trim().slice(-1_000) || "no output"}`; }

const execFileAsync = promisify(execFile);
const run: CommandRunner = async (command, args, options) => {
  try {
    const result = await execFileAsync(command, [...args], { cwd: options.cwd, env: options.env ? { ...process.env, ...options.env } : process.env, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 10 * 60_000 });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    return { exitCode: typeof failure.code === "number" ? failure.code : 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? failure.message };
  }
};
