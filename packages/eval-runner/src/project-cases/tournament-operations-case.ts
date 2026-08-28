import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { bindAutonomousCaseSnapshot } from "../cases/catalog.js";
import { createAutonomousCaseSnapshot } from "../cases/contracts.js";
import type { EvalCheck } from "../runtime-basic.js";
import type { CommandResult, CommandRunner, ProjectEvalThreadDefinition } from "./h3.js";

export const TOURNAMENT_OPERATIONS_CASE_ID = "capability.greenfield.tournament-operations";

export interface TournamentOperationsCaseDefinition {
  readonly schemaVersion: 1;
  readonly id: typeof TOURNAMENT_OPERATIONS_CASE_ID;
  readonly name: string;
  readonly description: string;
  readonly localOnly: true;
  readonly supportedPlatform: "darwin";
  readonly autonomous: true;
  readonly category: "coding";
  readonly taskType: "greenfield-build";
  readonly fixture: {
    readonly source: string;
    readonly revision: string;
    readonly packageManager: "node@22";
  };
  readonly threads: readonly ProjectEvalThreadDefinition[];
}

type TournamentApi = Readonly<Record<"createTournament" | "recordResult" | "withdrawTeam" | "rescheduleMatch", (...args: any[]) => any>>;
type PredicateResult = { readonly id: string; readonly passed: boolean; readonly detail: string };

const prompt = `Build a tournament operations web app for a regional youth championship. It must register and seed teams, create balanced pools and a seeded elimination bracket, schedule matches within venue/court windows without double-booking a team or court, record results, calculate standings with head-to-head/score-difference/seed tie-breakers, advance qualifiers, handle withdrawals, and safely reschedule matches. Surface schedule feasibility and actionable conflicts instead of silently producing an impossible plan.

Keep the implementation design yours, but preserve the public black-box seam documented in README.md. The finished repository needs a usable browser interface in index.html, focused tests, and at least one local commit. Do not push or publish anything.`;

const readme = `# Tournament Operations Platform

Build a browser application for tournament directors. The evaluator deliberately does not prescribe internal files, classes, storage, or algorithms. It observes only the exported public seam below and the visible \`index.html\` application.

## Public seam

\`src/index.js\` must export four functions:

- \`createTournament(config)\` creates a deterministic snapshot from registrations, pool and elimination settings, venue windows, and match duration.
- \`recordResult(snapshot, { matchId, homeScore, awayScore })\` records one nonnegative integer result and returns the updated snapshot.
- \`withdrawTeam(snapshot, { teamId })\` marks a team withdrawn, cancels its unplayed matches, removes it from qualification, and returns the updated feasible snapshot.
- \`rescheduleMatch(snapshot, { matchId, venueId, court, start })\` moves one unplayed match when the new slot is inside a venue window and creates no team/court collision; otherwise it throws without changing the supplied snapshot.

Inputs and returned snapshots must survive a strict JSON stringify/parse round trip: no undefined values, non-finite numbers, functions, symbols, BigInts, or cycles. Config registrations are \`{ id, name, seed }\`; IDs and seeds are unique. Pool play is round-robin. Seeds are distributed by deterministic snake seeding. Each win is 3 points, draw 1, loss 0. Standings order is points, head-to-head for an exactly two-team tie, score difference, original seed, then team ID. Withdrawn teams are excluded. Once every active pool match is final or cancelled, the top \`advancePerPool\` teams advance. For two pools with two qualifiers, semifinals cross A1-B2 and B1-A2; winners populate the final.

This case's v1 elimination contract supports exactly \`poolCount: 2\` and \`advancePerPool: 2\`; reject other values. Registration count, team IDs, match duration, venues, courts, and windows are otherwise data, not constants: the same implementation must handle differently sized pools and feasibility at the exact available-slot boundary.

Each returned snapshot exposes these exact JSON fields so operators can move it between the browser and durable storage: \`registrations: [{ id, name, seed, status }]\`; \`pools: [{ id, teamIds }]\`; \`matches: [{ id, phase, poolId?, stage?, homeTeamId, awayTeamId, status, schedule }]\`; \`standings: [{ poolId, rows: [{ teamId, played, wins, draws, losses, goalsFor, goalsAgainst, scoreDifference, points }] }]\`; \`advancement: { qualifiedTeamIds }\`; \`bracket: { semifinalMatchIds, finalMatchId, championTeamId }\`; and \`scheduleFeasibility: { feasible, conflicts }\`. A schedule is \`{ venueId, court, start }\`; \`start\` is an ISO-8601 instant. Status is \`active\`/\`withdrawn\` for registrations and \`waiting\`/\`scheduled\`/\`final\`/\`cancelled\` for matches. The scheduler must keep every match with known participants and nonterminal status within a declared venue window and prevent overlapping use of a court or team. If all such matches cannot be placed, return \`feasible: false\` with specific conflicts; do not omit matches.

The browser artifact must expose visible, nonempty operator views with \`data-tournament-view=\"registration\"\`, \`schedule\`, \`standings\`, \`bracket\`, and \`conflicts\`, plus enabled native controls with \`data-tournament-action=\"record-result\"\`, \`withdraw\`, and \`reschedule\`. It must load \`src/index.js\` and connect each control to its corresponding public export. After an operation, dispatch a bubbling \`tournament-operation\` \`CustomEvent\` whose \`detail\` is \`{ action, implementation, args, output }\`: \`action\` is the export name, \`implementation\` is that imported export, \`args\` are the JSON-compatible arguments passed to it, and \`output\` is its returned snapshot. The relevant view must render the resulting state. These are stable accessibility/test hooks; styling and component structure remain yours.

Run \`npm test\` for the visible contract checks. The evaluator also exercises boundary and property matrices through these exports, without inspecting source text or comparing against a reference patch.
`;

const fixtureConfig = {
  registrations: Array.from({ length: 8 }, (_, index) => ({ id: `t${index + 1}`, name: `Team ${index + 1}`, seed: index + 1 })),
  poolCount: 2,
  advancePerPool: 2,
  matchDurationMinutes: 30,
  venues: [
    { id: "north", courts: ["n1", "n2"], windows: [{ start: "2027-06-05T09:00:00Z", end: "2027-06-05T15:00:00Z" }] },
    { id: "south", courts: ["s1", "s2"], windows: [{ start: "2027-06-05T09:00:00Z", end: "2027-06-05T15:00:00Z" }] },
  ],
};

const files = Object.freeze({
  "README.md": readme,
  "package.json": `${JSON.stringify({ name: "tournament-operations-platform", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`,
  "fixtures/regional-championship.json": `${JSON.stringify(fixtureConfig, null, 2)}\n`,
  "src/index.js": `const missing = () => { throw new Error("Tournament operations are not implemented yet."); };\nexport const createTournament = missing;\nexport const recordResult = missing;\nexport const withdrawTeam = missing;\nexport const rescheduleMatch = missing;\n`,
  "test/contract.test.js": `import test from "node:test";\nimport assert from "node:assert/strict";\nimport config from "../fixtures/regional-championship.json" with { type: "json" };\nimport { createTournament } from "../src/index.js";\n\ntest("creates seeded pools and a feasible schedule", () => {\n  const state = createTournament(config);\n  assert.equal(state.registrations.length, 8);\n  assert.deepEqual(state.pools.map((pool) => pool.teamIds), [["t1", "t4", "t5", "t8"], ["t2", "t3", "t6", "t7"]]);\n  assert.equal(state.matches.filter((match) => match.phase === "pool").length, 12);\n  assert.equal(state.scheduleFeasibility.feasible, true);\n});\n`,
  "index.html": "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><title>Tournament Operations</title><main><h1>Tournament Operations</h1><p>The candidate must replace this starter with the working director interface.</p></main></html>\n",
});

const canonicalFiles = Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([path, contents]) => `${path}\0${contents.length}\0${contents}`).join("\0");
const digest = (value: string): `sha256:${string}` => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const sourceRevision = `template:${digest(canonicalFiles)}`;
const referenceSummary = `# Tournament operations reference model

The sealed model treats registrations and original seeds as durable identity, uses deterministic snake pools and complete round robins, and derives standings from final active-team results. Qualification waits until every active pool match is final or cancelled. Two-pool semifinals cross first against second; later winners populate the final.

The v1 bracket topology accepts exactly two pools and two qualifiers per pool, rejecting other topology values. Team count and identity, pool size, duration, venue windows, and court capacity remain variable inputs.

Scheduling is constraint satisfaction over declared venue windows, courts, match duration, and team availability. Every known-participant nonterminal match remains represented. An impossible plan is an explicit infeasible result with conflicts. Withdrawal cancels future matches and removes eligibility without rewriting completed history. Rescheduling preserves match identity, rejects terminal/colliding/out-of-window moves, and leaves rejected input unchanged.

Qualification observes only the documented JSON-compatible exports and the rendered browser artifact. Browser actions publish their public-export identity, JSON arguments, and returned state so the verifier can replay the operation independently. It never matches candidate source or a reference patch.
`;

export const TOURNAMENT_VERIFIER_GATE_CHECKS = Object.freeze({
  "tournament-core": Object.freeze(["snapshot-schema", "registration-uniqueness", "configuration-matrix", "seeding-determinism", "pool-round-robin", "results-validation", "results-integer-boundary", "standings-points", "tiebreak-head-to-head", "tiebreak-differential-seed", "advancement-pool-qualifiers", "bracket-progression"]),
  "schedule-operations": Object.freeze(["schedule-venue-boundaries", "schedule-collision-free", "schedule-infeasible", "elimination-schedule", "withdrawal-cancellation", "withdrawal-eligibility", "reschedule-collision", "reschedule-window", "reschedule-terminal", "reschedule-valid-free-slot", "json-compatible-snapshots"]),
  "operator-interface": Object.freeze(["operator-interface"]),
  "tournament-scoped-commit": Object.freeze(["visible-contract", "required-deliverables", "delivery-commit", "delivery-clean"]),
} as const);

export const tournamentOperationsCaseDefinition: TournamentOperationsCaseDefinition = Object.freeze({
  schemaVersion: 1,
  id: TOURNAMENT_OPERATIONS_CASE_ID,
  name: "Tournament operations platform",
  description: "Builds and verifies a complete pool-to-elimination tournament workflow under real scheduling constraints.",
  localOnly: true,
  supportedPlatform: "darwin",
  autonomous: true,
  category: "coding",
  taskType: "greenfield-build",
  fixture: Object.freeze({ source: `relayer-eval://${TOURNAMENT_OPERATIONS_CASE_ID}`, revision: sourceRevision, packageManager: "node@22" }),
  threads: Object.freeze([Object.freeze({
    id: "delivery",
    name: "Build tournament operations",
    permissionProfileId: "auto",
    mutationPolicy: "writable",
    workspaceGrade: "autonomous-implementation",
    prompts: Object.freeze([prompt]),
  })]),
});

export const tournamentVerifierManifestContents = `{
  "schemaVersion": 1,
  "verifierId": "tournament-operations-v2",
  "logicalContentDigest": "sha256:99726ebc46af392fa7ce6d026cb28e0d7de735d71c27a003c9630cbd02c9be2a",
  "behavioralVerifierSourceDigest": "sha256:4eec11682338ceb95d8067d24a43e5743cdf024607a225ffd174bbc907111e01",
  "serviceIntegrationSourceDigest": "sha256:a9e9323e744d616c28615db28d30fd3623c2eaccab83cc2a276eceab654d2cf5",
  "operatorInterfaceVerifierDigest": "sha256:0b237f2b74ee0041271ff183fe0adb8c080f59b4d7a6259ca964bf1929f8b2aa",
  "gateChecks": {
    "tournament-core": [
      "snapshot-schema",
      "registration-uniqueness",
      "configuration-matrix",
      "seeding-determinism",
      "pool-round-robin",
      "results-validation",
      "results-integer-boundary",
      "standings-points",
      "tiebreak-head-to-head",
      "tiebreak-differential-seed",
      "advancement-pool-qualifiers",
      "bracket-progression"
    ],
    "schedule-operations": [
      "schedule-venue-boundaries",
      "schedule-collision-free",
      "schedule-infeasible",
      "elimination-schedule",
      "withdrawal-cancellation",
      "withdrawal-eligibility",
      "reschedule-collision",
      "reschedule-window",
      "reschedule-terminal",
      "reschedule-valid-free-slot",
      "json-compatible-snapshots"
    ],
    "operator-interface": [
      "operator-interface"
    ],
    "tournament-scoped-commit": [
      "visible-contract",
      "required-deliverables",
      "delivery-commit",
      "delivery-clean"
    ]
  }
}
`;
const criteria = [
  { id: "operations", label: "Tournament correctness", description: "Registration through championship advancement behaves correctly across ordinary and failure paths.", weight: 3 },
  { id: "usability", label: "Operator usability", description: "The browser app makes schedules, conflicts, standings, and bracket state usable for a director.", weight: 1 },
] as const;

export const tournamentOperationsCase = bindAutonomousCaseSnapshot(tournamentOperationsCaseDefinition, createAutonomousCaseSnapshot({
  id: TOURNAMENT_OPERATIONS_CASE_ID,
  name: tournamentOperationsCaseDefinition.name,
  description: tournamentOperationsCaseDefinition.description,
  category: "coding",
  taskType: "greenfield-build",
  artifacts: {
    task: { kind: "visible-task", text: prompt, contentDigest: digest(prompt) },
    workspace: { kind: "frozen-workspace", materializerId: "tournament-operations-template-v1", source: tournamentOperationsCaseDefinition.fixture.source, revision: sourceRevision, contentDigest: digest(canonicalFiles), environmentDigest: digest("node@22\ndarwin\nno-network") },
    reference: { kind: "sealed-reference", artifactId: "tournament-operations-reference-v1", format: "markdown", contentDigest: digest(referenceSummary), sealedPath: "eval-cases/tournament-operations-platform/solution/reference.md" },
    verifier: {
      kind: "sealed-verifier", artifactId: "tournament-operations-verifier-v2", verifierId: "tournament-operations-v2", contentDigest: digest(tournamentVerifierManifestContents), sealedPath: "eval-cases/tournament-operations-platform/verifier/manifest.json",
      mandatoryGates: [
        { id: "tournament-core", label: "Tournament structure", description: "Registration, seeding, pools, results, standings, tie-breakers, advancement, and bracket progression pass independent public-seam predicates." },
        { id: "schedule-operations", label: "Schedule operations", description: "Venue feasibility, collision rejection, withdrawal, and rescheduling pass boundary and property checks." },
        { id: "operator-interface", label: "Operator interface", description: "The durable browser artifact exposes the declared registration, schedule, standings, bracket, conflict, result, withdrawal, and rescheduling surfaces." },
        { id: "tournament-scoped-commit", label: "Committed delivery", description: "The visible application and public seam are delivered in a clean post-fixture commit." },
      ],
    },
    outcomeRubric: { kind: "outcome-rubric", rubricVersion: "tournament-operations-outcome-v1", criteria, contentDigest: digest(JSON.stringify(criteria)) },
  },
}));

export const tournamentOperationsCaseIds = new Set([TOURNAMENT_OPERATIONS_CASE_ID]);

export interface TournamentFixtureReceipt {
  readonly schemaVersion: 1;
  readonly fixtureId: typeof TOURNAMENT_OPERATIONS_CASE_ID;
  readonly workspaceDirectory: string;
  readonly repositoryUrl: string;
  readonly sourceRevision: string;
  readonly seededCommit: string;
  readonly seededTree: string;
  readonly packageManager: "node@22";
  readonly installedWithFrozenLockfile: false;
}

export async function materializeTournamentOperationsFixture(options: { readonly caseId: typeof TOURNAMENT_OPERATIONS_CASE_ID; readonly workspaceDirectory: string; readonly platform?: NodeJS.Platform; readonly runCommand?: CommandRunner }): Promise<TournamentFixtureReceipt> {
  if (options.caseId !== TOURNAMENT_OPERATIONS_CASE_ID) throw new Error(`Unknown tournament fixture: ${options.caseId}`);
  if ((options.platform ?? process.platform) !== "darwin") throw new Error("Tournament operations case is local Mac only.");
  await requireMissing(options.workspaceDirectory);
  await mkdir(options.workspaceDirectory, { recursive: true, mode: 0o700 });
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = join(options.workspaceDirectory, relativePath);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, contents, "utf8");
  }
  const runCommand = options.runCommand ?? run;
  await required(runCommand, "git", ["init", "--quiet", "--initial-branch=main"], options.workspaceDirectory);
  await required(runCommand, "git", ["config", "user.name", "Relayer Eval Fixture"], options.workspaceDirectory);
  await required(runCommand, "git", ["config", "user.email", "eval-fixture@relayer.local"], options.workspaceDirectory);
  await required(runCommand, "git", ["add", "--all"], options.workspaceDirectory);
  await required(runCommand, "git", ["commit", "--quiet", "-m", `Seed ${TOURNAMENT_OPERATIONS_CASE_ID}`], options.workspaceDirectory, { GIT_AUTHOR_DATE: "2026-08-28T12:00:00Z", GIT_COMMITTER_DATE: "2026-08-28T12:00:00Z" });
  const seededCommit = (await required(runCommand, "git", ["rev-parse", "HEAD"], options.workspaceDirectory)).stdout.trim();
  const seededTree = (await required(runCommand, "git", ["rev-parse", "HEAD^{tree}"], options.workspaceDirectory)).stdout.trim();
  return Object.freeze({ schemaVersion: 1, fixtureId: TOURNAMENT_OPERATIONS_CASE_ID, workspaceDirectory: options.workspaceDirectory, repositoryUrl: tournamentOperationsCaseDefinition.fixture.source, sourceRevision, seededCommit, seededTree, packageManager: "node@22", installedWithFrozenLockfile: false });
}

export async function verifyTournamentPublicSeam(api: Partial<TournamentApi>): Promise<readonly PredicateResult[]> {
  const results: PredicateResult[] = [];
  const check = async (id: string, fn: () => unknown | Promise<unknown>) => {
    try { await fn(); results.push({ id, passed: true, detail: `${id} passed.` }); }
    catch (error) { results.push({ id, passed: false, detail: error instanceof Error ? error.message : String(error) }); }
  };
  const requireApi = (): TournamentApi => {
    for (const name of ["createTournament", "recordResult", "withdrawTeam", "rescheduleMatch"] as const) if (typeof api[name] !== "function") throw new Error(`Missing public export ${name}.`);
    return api as TournamentApi;
  };
  const fresh = () => requireApi().createTournament(structuredClone(fixtureConfig));
  const poolMatches = (state: any) => state.matches.filter((match: any) => match.phase === "pool");
  const findMatch = (state: any, left: string, right: string) => state.matches.find((match: any) => new Set([match.homeTeamId, match.awayTeamId]).has(left) && new Set([match.homeTeamId, match.awayTeamId]).has(right));
  const play = (state: any, home: string, away: string, homeScore: number, awayScore: number) => {
    const match = findMatch(state, home, away); if (!match) throw new Error(`Missing match ${home}-${away}.`);
    const oriented = match.homeTeamId === home ? { homeScore, awayScore } : { homeScore: awayScore, awayScore: homeScore };
    return requireApi().recordResult(state, { matchId: match.id, ...oriented });
  };
  const finishPools = (initial: any) => {
    let state = initial;
    for (const match of poolMatches(state)) state = requireApi().recordResult(state, { matchId: match.id, homeScore: Number(match.homeTeamId.slice(1)), awayScore: Number(match.awayTeamId.slice(1)) });
    return state;
  };
  const memberships = (state: any) => state.pools.map((pool: any) => pool.teamIds.join(",")).join("|");
  const requireCompletePool = (state: any, pool: any) => {
    const expected = pool.teamIds.length * (pool.teamIds.length - 1) / 2;
    const pairings = poolMatches(state).filter((match: any) => match.poolId === pool.id).map((match: any) => [match.homeTeamId, match.awayTeamId].sort().join(":"));
    if (pairings.length !== expected || new Set(pairings).size !== expected) throw new Error(`Pool ${pool.id} is not a complete round robin.`);
  };
  const activeMatches = (state: any) => state.matches.filter((match: any) => match.homeTeamId && match.awayTeamId && !["final", "cancelled"].includes(match.status));
  const requireVenueBounds = (state: any, config: any = fixtureConfig) => {
    for (const match of activeMatches(state)) {
      if (!match.schedule?.venueId || !match.schedule?.court || !Number.isFinite(Date.parse(match.schedule.start))) throw new Error(`Active match ${match.id} is unscheduled.`);
      const venue = config.venues.find(({ id }: any) => id === match.schedule.venueId);
      const start = Date.parse(match.schedule.start), end = start + config.matchDurationMinutes * 60_000;
      if (!venue || !venue.courts.includes(match.schedule.court) || !venue.windows.some((window: any) => start >= Date.parse(window.start) && end <= Date.parse(window.end))) throw new Error(`Match ${match.id} is outside its venue contract.`);
    }
  };
  const requireNoCollisions = (state: any, config: any = fixtureConfig) => {
    const active = activeMatches(state), duration = config.matchDurationMinutes * 60_000;
    for (let i = 0; i < active.length; i++) for (let j = i + 1; j < active.length; j++) {
      const a = active[i], b = active[j], startA = Date.parse(a.schedule.start), startB = Date.parse(b.schedule.start);
      const overlap = startA < startB + duration && startB < startA + duration;
      if (overlap && a.schedule.venueId === b.schedule.venueId && a.schedule.court === b.schedule.court) throw new Error("Court collision detected.");
      if (overlap && [a.homeTeamId, a.awayTeamId].some((team) => team === b.homeTeamId || team === b.awayTeamId)) throw new Error("Team collision detected.");
    }
  };
  const requireJson = (value: unknown) => {
    const seen = new WeakSet<object>();
    const inspect = (child: unknown, path: string) => {
      if (child === undefined || typeof child === "function" || typeof child === "symbol" || typeof child === "bigint") throw new Error(`Non-JSON value at ${path}.`);
      if (typeof child === "number" && !Number.isFinite(child)) throw new Error(`Non-finite number at ${path}.`);
      if (child === null || typeof child !== "object") return;
      if (seen.has(child)) throw new Error(`JSON cycle at ${path}.`);
      seen.add(child);
      const descriptors = Object.getOwnPropertyDescriptors(child);
      if (Object.hasOwn(descriptors, "toJSON")) throw new Error(`Custom toJSON at ${path}.`);
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (descriptor.get || descriptor.set) throw new Error(`Accessor property at ${path}.${key}.`);
        inspect(descriptor.value, `${path}.${key}`);
      }
    };
    inspect(value, "$root");
    const encoded = JSON.stringify(value, (_key, child) => {
      if (child === undefined || typeof child === "function" || typeof child === "symbol" || typeof child === "bigint") throw new Error("Snapshot contains a non-JSON value.");
      if (typeof child === "number" && !Number.isFinite(child)) throw new Error("Snapshot contains a non-finite number.");
      return child;
    });
    if (typeof encoded !== "string") throw new Error("Snapshot is not JSON serializable.");
    const parsed = JSON.parse(encoded);
    if (JSON.stringify(parsed) !== encoded) throw new Error("Snapshot does not survive a stable JSON round trip.");
  };
  const findValidReschedule = (state: any, match: any) => {
    const duration = fixtureConfig.matchDurationMinutes * 60_000;
    for (const venue of fixtureConfig.venues) for (const window of venue.windows) for (let start = Date.parse(window.start); start + duration <= Date.parse(window.end); start += duration) for (const court of venue.courts) {
      if (match.schedule.venueId === venue.id && match.schedule.court === court && Date.parse(match.schedule.start) === start) continue;
      const event = { matchId: match.id, venueId: venue.id, court, start: new Date(start).toISOString() };
      try { return { event, state: requireApi().rescheduleMatch(structuredClone(state), event) }; } catch { /* this candidate legitimately uses the slot */ }
    }
    throw new Error("No feasible alternative slot could be rescheduled.");
  };
  await check("snapshot-schema", () => {
    const state = fresh();
    for (const name of ["registrations", "pools", "matches", "standings"] as const) if (!Array.isArray(state[name])) throw new Error(`Snapshot ${name} must be an array.`);
    if (state.registrations.some((team: any) => typeof team.id !== "string" || typeof team.name !== "string" || !Number.isInteger(team.seed) || !["active", "withdrawn"].includes(team.status))) throw new Error("Registration shape is outside the declared schema.");
    if (state.pools.some((pool: any) => typeof pool.id !== "string" || !Array.isArray(pool.teamIds) || pool.teamIds.some((teamId: unknown) => typeof teamId !== "string"))) throw new Error("Pool shape is outside the declared schema.");
    if (state.matches.some((match: any) => {
      if (typeof match.id !== "string" || !["pool", "elimination"].includes(match.phase) || !["waiting", "scheduled", "final", "cancelled"].includes(match.status) || !("schedule" in match)) return true;
      if (!(match.homeTeamId === null || typeof match.homeTeamId === "string") || !(match.awayTeamId === null || typeof match.awayTeamId === "string")) return true;
      if (match.phase === "pool" && typeof match.poolId !== "string") return true;
      if (match.phase === "elimination" && !["semifinal", "final"].includes(match.stage)) return true;
      return match.schedule !== null && (typeof match.schedule !== "object" || typeof match.schedule.venueId !== "string" || typeof match.schedule.court !== "string" || typeof match.schedule.start !== "string");
    })) throw new Error("Match shape is outside the declared schema.");
    const rowFields = ["played", "wins", "draws", "losses", "goalsFor", "goalsAgainst", "scoreDifference", "points"];
    if (state.standings.some((table: any) => typeof table.poolId !== "string" || !Array.isArray(table.rows) || table.rows.some((row: any) => typeof row.teamId !== "string" || rowFields.some((field) => !Number.isInteger(row[field]))))) throw new Error("Standings shape is outside the declared schema.");
    if (!Array.isArray(state.advancement?.qualifiedTeamIds) || !Array.isArray(state.bracket?.semifinalMatchIds) || typeof state.bracket?.finalMatchId !== "string" || !("championTeamId" in state.bracket)) throw new Error("Advancement or bracket shape is outside the declared schema.");
    if (state.advancement.qualifiedTeamIds.some((teamId: unknown) => typeof teamId !== "string") || state.bracket.semifinalMatchIds.some((matchId: unknown) => typeof matchId !== "string") || !(state.bracket.championTeamId === null || typeof state.bracket.championTeamId === "string")) throw new Error("Advancement or bracket members are outside the declared schema.");
    if (typeof state.scheduleFeasibility?.feasible !== "boolean" || !Array.isArray(state.scheduleFeasibility?.conflicts)) throw new Error("Schedule feasibility shape is outside the declared schema.");
  });
  await check("registration-uniqueness", () => {
    const state = fresh();
    if (state.registrations?.length !== 8) throw new Error("Expected eight accepted registrations.");
    const duplicate = structuredClone(fixtureConfig); duplicate.registrations[7]!.id = "t1";
    let rejected = false; try { requireApi().createTournament(duplicate); } catch { rejected = true; }
    if (!rejected) throw new Error("Duplicate registration IDs must be rejected.");
    const duplicateSeed = structuredClone(fixtureConfig); duplicateSeed.registrations[7]!.seed = 1;
    rejected = false; try { requireApi().createTournament(duplicateSeed); } catch { rejected = true; }
    if (!rejected) throw new Error("Duplicate seeds must be rejected.");
  });
  await check("configuration-matrix", () => {
    const makeConfig = (count: number, duration: number, end: string, courts: string[]) => ({
      registrations: Array.from({ length: count }, (_, index) => ({ id: "club-" + String.fromCharCode(97 + index), name: "Club " + (index + 1), seed: index + 1 })),
      poolCount: 2,
      advancePerPool: 2,
      matchDurationMinutes: duration,
      venues: [{ id: "matrix-venue", courts, windows: [{ start: "2027-07-10T09:00:00Z", end }] }],
    });
    for (const config of [makeConfig(6, 20, "2027-07-10T11:00:00Z", ["only"]), makeConfig(8, 45, "2027-07-10T14:00:00Z", ["east", "west"])]) {
      const state = requireApi().createTournament(structuredClone(config));
      if (state.registrations.length !== config.registrations.length || state.pools.length !== 2) throw new Error("Registration or pool counts were hardcoded.");
      for (const pool of state.pools) requireCompletePool(state, pool);
      if (state.scheduleFeasibility?.feasible !== true) throw new Error("A boundary-feasible matrix configuration was rejected.");
      requireVenueBounds(state, config); requireNoCollisions(state, config);
    }
    const belowCapacity = makeConfig(6, 20, "2027-07-10T10:40:00Z", ["only"]);
    const blocked = requireApi().createTournament(structuredClone(belowCapacity));
    if (blocked.scheduleFeasibility?.feasible !== false || blocked.scheduleFeasibility.conflicts.length === 0) throw new Error("Schedule capacity threshold was not enforced.");
    for (const unsupported of [{ ...makeConfig(6, 20, "2027-07-10T11:00:00Z", ["only"]), poolCount: 3 }, { ...makeConfig(6, 20, "2027-07-10T11:00:00Z", ["only"]), advancePerPool: 1 }]) {
      let rejected = false; try { requireApi().createTournament(unsupported); } catch { rejected = true; }
      if (!rejected) throw new Error("Unsupported elimination topology must be rejected explicitly.");
    }
  });
  await check("seeding-determinism", () => {
    const state = fresh();
    if (state.pools?.length !== 2 || memberships(state) !== "t1,t4,t5,t8|t2,t3,t6,t7") throw new Error(`Incorrect snake seeding: ${memberships(state)}`);
    const reversed = structuredClone(fixtureConfig); reversed.registrations.reverse();
    if (memberships(requireApi().createTournament(reversed)) !== memberships(state)) throw new Error("Seeding depends on registration arrival order.");
  });
  await check("pool-round-robin", () => { const state = fresh(); if (poolMatches(state).length !== 12) throw new Error("Expected twelve pool matches."); for (const pool of state.pools) requireCompletePool(state, pool); });
  await check("schedule-venue-boundaries", () => { const state = fresh(); if (state.scheduleFeasibility?.feasible !== true) throw new Error("Frozen tournament must be feasible."); requireVenueBounds(state); });
  await check("schedule-collision-free", () => { requireNoCollisions(fresh()); });
  await check("schedule-infeasible", () => {
    const impossible = structuredClone(fixtureConfig); impossible.venues = [{ id: "tiny", courts: ["c1"], windows: [{ start: "2027-06-05T09:00:00Z", end: "2027-06-05T10:00:00Z" }] }];
    const blocked = requireApi().createTournament(impossible);
    if (blocked.scheduleFeasibility?.feasible !== false || blocked.scheduleFeasibility.conflicts?.length === 0 || poolMatches(blocked).length !== 12) throw new Error("Impossible schedules must retain matches and expose conflicts.");
    const unscheduled = new Set(activeMatches(blocked).filter((match: any) => !match.schedule).map((match: any) => match.id));
    const reported = new Set(blocked.scheduleFeasibility.conflicts.map((conflict: any) => {
      if (!conflict || typeof conflict !== "object" || typeof conflict.matchId !== "string" || typeof (conflict.reason ?? conflict.message) !== "string" || String(conflict.reason ?? conflict.message).trim() === "") throw new Error("Schedule conflicts must be structured and actionable.");
      return conflict.matchId;
    }));
    if ([...unscheduled].some((matchId) => !reported.has(matchId))) throw new Error("Every unscheduled active match needs an actionable conflict.");
  });
  await check("results-validation", () => {
    const state = fresh();
    const match = poolMatches(state)[0]; let rejected = false;
    try { requireApi().recordResult(state, { matchId: match.id, homeScore: -1, awayScore: 0 }); } catch { rejected = true; }
    if (!rejected) throw new Error("Negative results must be rejected.");
  });
  await check("results-integer-boundary", () => {
    const state = fresh(), match = poolMatches(state)[0]; let rejected = false;
    try { requireApi().recordResult(state, { matchId: match.id, homeScore: 1.5, awayScore: 0 }); } catch { rejected = true; }
    if (!rejected) throw new Error("Fractional results must be rejected.");
  });
  await check("standings-points", () => {
    const state = fresh(), match = poolMatches(state)[0];
    const updated = requireApi().recordResult(state, { matchId: match.id, homeScore: 2, awayScore: 0 });
    const table = updated.standings.find((entry: any) => entry.poolId === match.poolId), home = table.rows.find((row: any) => row.teamId === match.homeTeamId), away = table.rows.find((row: any) => row.teamId === match.awayTeamId);
    if (home.points !== 3 || home.wins !== 1 || home.scoreDifference !== 2 || away.points !== 0 || away.losses !== 1 || away.scoreDifference !== -2) throw new Error("Result did not recompute standings.");
  });
  await check("tiebreak-head-to-head", () => {
    let state = fresh();
    state = play(state, "t1", "t4", 2, 0); state = play(state, "t1", "t5", 0, 1); state = play(state, "t1", "t8", 1, 0);
    state = play(state, "t4", "t5", 3, 0); state = play(state, "t4", "t8", 0, 1); state = play(state, "t5", "t8", 2, 0);
    const order = state.standings.find((table: any) => table.poolId === state.pools[0].id).rows.map((row: any) => row.teamId);
    if (order[0] !== "t5" || order[1] !== "t1") throw new Error(`Head-to-head ordering is wrong: ${order.join(",")}`);
  });
  await check("tiebreak-differential-seed", () => {
    let differential = fresh();
    differential = play(differential, "t1", "t4", 3, 0); differential = play(differential, "t4", "t5", 2, 0); differential = play(differential, "t5", "t1", 1, 0);
    differential = play(differential, "t1", "t8", 1, 0); differential = play(differential, "t4", "t8", 1, 0); differential = play(differential, "t5", "t8", 1, 0);
    const differentialOrder = differential.standings.find((table: any) => table.poolId === differential.pools[0].id).rows.map((row: any) => row.teamId);
    if (differentialOrder[0] !== "t1" || differentialOrder[1] !== "t4") throw new Error(`Three-way differential/seed ordering is wrong: ${differentialOrder.join(",")}`);
  });
  await check("advancement-pool-qualifiers", () => {
    const state = finishPools(fresh()), expected = state.standings.flatMap((table: any) => table.rows.slice(0, fixtureConfig.advancePerPool).map((row: any) => row.teamId));
    if (JSON.stringify(state.advancement?.qualifiedTeamIds) !== JSON.stringify(expected)) throw new Error(`Expected exact pool qualifiers ${expected.join(",")}.`);
  });
  await check("bracket-progression", () => {
    let state = finishPools(fresh());
    if (state.advancement?.qualifiedTeamIds?.length !== 4) throw new Error("Four pool qualifiers must advance.");
    const semis = state.matches.filter((match: any) => match.phase === "elimination" && match.stage === "semifinal");
    if (semis.length !== 2 || semis.some((match: any) => !match.homeTeamId || !match.awayTeamId)) throw new Error("Cross-pool semifinals were not populated.");
    const [a1, a2] = state.standings[0].rows, [b1, b2] = state.standings[1].rows;
    const expectedPairs = new Set([[a1.teamId, b2.teamId], [b1.teamId, a2.teamId]].map((pair) => pair.sort().join(":")));
    const actualPairs = new Set(semis.map((match: any) => [match.homeTeamId, match.awayTeamId].sort().join(":")));
    if (actualPairs.size !== 2 || [...expectedPairs].some((pair) => !actualPairs.has(pair))) throw new Error("Semifinals do not cross pool first against the other pool's second.");
    for (const semi of semis) state = requireApi().recordResult(state, { matchId: semi.id, homeScore: 2, awayScore: 1 });
    const final = state.matches.find((match: any) => match.stage === "final");
    const semifinalWinners = semis.map((semi: any) => semi.homeTeamId);
    if (!final?.homeTeamId || !final?.awayTeamId || new Set([final.homeTeamId, final.awayTeamId]).size !== 2 || semifinalWinners.some((winner: string) => ![final.homeTeamId, final.awayTeamId].includes(winner))) throw new Error("Semifinal winners did not exclusively populate the final.");
    state = requireApi().recordResult(state, { matchId: final.id, homeScore: 3, awayScore: 2 });
    if (state.bracket?.championTeamId !== final.homeTeamId) throw new Error("Champion is not the final winner.");
  });
  await check("elimination-schedule", () => {
    let state = finishPools(fresh()); requireVenueBounds(state); requireNoCollisions(state);
    for (const semi of state.matches.filter((match: any) => match.stage === "semifinal")) state = requireApi().recordResult(state, { matchId: semi.id, homeScore: 2, awayScore: 1 });
    requireVenueBounds(state); requireNoCollisions(state);
  });
  await check("withdrawal-cancellation", () => {
    const before = fresh(); const withdrawn = requireApi().withdrawTeam(before, { teamId: "t1" });
    const registration = withdrawn.registrations.find((team: any) => team.id === "t1");
    if (registration?.status !== "withdrawn") throw new Error("Withdrawal status is not visible.");
    if (withdrawn.matches.some((match: any) => match.status !== "cancelled" && [match.homeTeamId, match.awayTeamId].includes("t1"))) throw new Error("A withdrawn team retains an active match.");
    if (withdrawn.scheduleFeasibility?.feasible !== true) throw new Error("Cancellation should preserve feasibility.");
    let played = fresh(); const completedMatch = findMatch(played, "t1", "t4"); played = requireApi().recordResult(played, { matchId: completedMatch.id, homeScore: 2, awayScore: 1 });
    const afterPlayedWithdrawal = requireApi().withdrawTeam(played, { teamId: "t1" }), preserved = afterPlayedWithdrawal.matches.find((match: any) => match.id === completedMatch.id);
    if (preserved?.status !== "final" || preserved.homeScore !== 2 || preserved.awayScore !== 1) throw new Error("Withdrawal rewrote completed match history.");
  });
  await check("withdrawal-eligibility", () => {
    const withdrawn = requireApi().withdrawTeam(fresh(), { teamId: "t1" });
    if (withdrawn.standings.some((table: any) => table.rows.some((row: any) => row.teamId === "t1")) || withdrawn.advancement?.qualifiedTeamIds?.includes("t1")) throw new Error("Withdrawn team remains eligible.");
  });
  await check("reschedule-collision", () => {
    const state = fresh(); const [first, second] = poolMatches(state); const original = JSON.stringify(state);
    let rejected = false; try { requireApi().rescheduleMatch(state, { matchId: first.id, venueId: second.schedule.venueId, court: second.schedule.court, start: second.schedule.start }); } catch { rejected = true; }
    if (!rejected || JSON.stringify(state) !== original) throw new Error("Conflicting reschedule must reject without mutating the input.");
  });
  await check("reschedule-window", () => {
    const state = fresh(), first = poolMatches(state)[0]; let rejected = false;
    try { requireApi().rescheduleMatch(state, { matchId: first.id, venueId: "north", court: "n1", start: "2027-06-05T15:00:00Z" }); } catch { rejected = true; }
    if (!rejected) throw new Error("Out-of-window reschedule must reject.");
  });
  await check("reschedule-terminal", () => {
    let state = fresh(); const match = poolMatches(state)[0]; state = requireApi().recordResult(state, { matchId: match.id, homeScore: 1, awayScore: 0 });
    let rejected = false; try { requireApi().rescheduleMatch(state, { matchId: match.id, venueId: "north", court: "n1", start: "2027-06-05T14:30:00Z" }); } catch { rejected = true; }
    if (!rejected) throw new Error("Final matches must not be rescheduled.");
  });
  await check("reschedule-valid-free-slot", () => {
    const state = fresh(), first = poolMatches(state)[0], movedReceipt = findValidReschedule(state, first), moved = movedReceipt.state;
    const updated = moved.matches.find((match: any) => match.id === first.id);
    if (!updated?.schedule || moved.scheduleFeasibility?.feasible !== true) throw new Error("Valid reschedule was not applied feasibly.");
    if (updated.schedule.venueId !== movedReceipt.event.venueId || updated.schedule.court !== movedReceipt.event.court || updated.schedule.start !== movedReceipt.event.start) throw new Error("Reschedule did not apply the requested destination exactly.");
    requireVenueBounds(moved); requireNoCollisions(moved);
  });
  await check("json-compatible-snapshots", () => {
    requireJson(fixtureConfig); const initial = fresh(); requireJson(initial);
    const match = poolMatches(initial)[0], resultEvent = { matchId: match.id, homeScore: 1, awayScore: 0 }; requireJson(resultEvent); requireJson(requireApi().recordResult(initial, resultEvent));
    const withdrawalEvent = { teamId: "t8" }; requireJson(withdrawalEvent); requireJson(requireApi().withdrawTeam(initial, withdrawalEvent));
    const moved = findValidReschedule(initial, match); requireJson(moved.event); requireJson(moved.state);
  });
  return Object.freeze(results);
}

async function verifyOperatorInterface(cwd: string, runCommand: CommandRunner): Promise<{ readonly passed: boolean; readonly detail: string }> {
  const electronBinary = createRequire(import.meta.url)("electron") as string;
  const verifierPath = resolve(import.meta.dirname, "../../../../eval-cases/tournament-operations-platform/verifier/operator-interface.cjs");
  const result = await runCommand(electronBinary, [verifierPath, join(cwd, "index.html")], { cwd });
  const marker = lines(result.stdout).find((line) => line.startsWith("RELAYER_UI_RESULT "));
  if (result.exitCode !== 0 || !marker) return { passed: false, detail: commandDetail("rendered operator interface", result) };
  try {
    const receipt = JSON.parse(marker.slice("RELAYER_UI_RESULT ".length)) as { passed?: unknown; problems?: unknown };
    return receipt.passed === true
      ? { passed: true, detail: "Rendered operator views are visible and every declared control produces an observable state change." }
      : { passed: false, detail: `Rendered operator interface failed: ${JSON.stringify(receipt.problems ?? [])}.` };
  } catch (error) {
    return { passed: false, detail: `Rendered operator verifier emitted invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function gradeTournamentOperationsWorkspace(options: { readonly caseId: typeof TOURNAMENT_OPERATIONS_CASE_ID; readonly workspaceDirectory: string; readonly baseRevision?: string; readonly runCommand?: CommandRunner }): Promise<readonly EvalCheck[]> {
  if (options.caseId !== TOURNAMENT_OPERATIONS_CASE_ID) throw new Error(`Unknown tournament case: ${options.caseId}`);
  const runCommand = options.runCommand ?? run;
  const baseRevision = options.baseRevision ?? (await required(runCommand, "git", ["rev-list", "--max-parents=0", "HEAD"], options.workspaceDirectory)).stdout.trim();
  const visible = await runCommand("npm", ["test"], { cwd: options.workspaceDirectory });
  let predicates: readonly PredicateResult[];
  try {
    const moduleUrl = `${pathToFileURL(join(options.workspaceDirectory, "src/index.js")).href}?eval=${randomUUID()}`;
    predicates = await verifyTournamentPublicSeam(await import(moduleUrl));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    predicates = [...TOURNAMENT_VERIFIER_GATE_CHECKS["tournament-core"], ...TOURNAMENT_VERIFIER_GATE_CHECKS["schedule-operations"]].map((id) => ({ id, passed: false, detail }));
  }
  const deliverables = await Promise.all(["src/index.js", "index.html", "test/contract.test.js"].map(async (relativePath) => ({ relativePath, present: (await readFile(join(options.workspaceDirectory, relativePath), "utf8").catch(() => "")).trim().length > 0 })));
  const commits = lines((await required(runCommand, "git", ["rev-list", `${baseRevision}..HEAD`], options.workspaceDirectory)).stdout);
  const status = (await required(runCommand, "git", ["status", "--porcelain=v1", "--untracked-files=all"], options.workspaceDirectory)).stdout.trim();
  const operatorInterface = await verifyOperatorInterface(options.workspaceDirectory, runCommand);
  return Object.freeze([
    { name: "workspace:visible-contract", passed: visible.exitCode === 0, detail: commandDetail("visible npm test", visible) },
    ...predicates.map((predicate) => ({ name: `workspace:${predicate.id}`, passed: predicate.passed, detail: predicate.detail })),
    { name: "workspace:operator-interface", passed: operatorInterface.passed, detail: operatorInterface.detail },
    { name: "workspace:required-deliverables", passed: deliverables.every(({ present }) => present), detail: deliverables.map(({ relativePath, present }) => `${relativePath}: ${present ? "present" : "missing"}`).join(", ") },
    { name: "workspace:delivery-commit", passed: commits.length >= 1, detail: `${commits.length} post-fixture commit(s).` },
    { name: "workspace:delivery-clean", passed: status === "", detail: status === "" ? "The workspace is clean." : `Uncommitted changes remain: ${status}` },
  ]);
}

async function requireMissing(path: string): Promise<void> { try { await access(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; } throw new Error(`Refusing to overwrite existing tournament workspace: ${path}`); }
async function required(runCommand: CommandRunner, command: string, args: readonly string[], cwd: string, environment: Readonly<Record<string, string>> = {}): Promise<CommandResult> { const result = await runCommand(command, args, { cwd, env: { ...process.env, ...environment } as Readonly<Record<string, string>> }); if (result.exitCode !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`); return result; }
function lines(value: string): string[] { return value.split("\n").map((line) => line.trim()).filter(Boolean); }
function commandDetail(label: string, result: CommandResult): string { return result.exitCode === 0 ? `${label} passed.` : `${label} failed (${result.exitCode}): ${(result.stderr || result.stdout).trim().slice(-1_000) || "no output"}`; }
const execFileAsync = promisify(execFile);
const run: CommandRunner = async (command, args, options) => { try { const result = await execFileAsync(command, [...args], { cwd: options.cwd, env: options.env ? { ...process.env, ...options.env } : process.env, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 10 * 60_000 }); return { exitCode: 0, stdout: result.stdout, stderr: result.stderr }; } catch (error) { const failure = error as Error & { code?: number; stdout?: string; stderr?: string }; return { exitCode: typeof failure.code === "number" ? failure.code : 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? failure.message }; } };
