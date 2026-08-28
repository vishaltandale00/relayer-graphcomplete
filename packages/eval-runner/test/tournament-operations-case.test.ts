import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  TOURNAMENT_OPERATIONS_CASE_ID,
  gradeTournamentOperationsWorkspace,
  materializeTournamentOperationsFixture,
  tournamentOperationsCase,
  verifyTournamentPublicSeam,
} from "../src/project-cases/tournament-operations-case.js";

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

type AnyState = Record<string, any>;

function functionalSolution() {
  const clone = <T>(value: T): T => structuredClone(value);
  const minutes = (value: string) => Date.parse(value);
  const overlaps = (a: number, b: number, duration: number) => a < b + duration && b < a + duration;
  const recompute = (input: AnyState): AnyState => {
    const state = clone(input);
    const active = new Set(state.registrations.filter((team: any) => team.status !== "withdrawn").map((team: any) => team.id));
    for (const match of state.matches) {
      if ([match.homeTeamId, match.awayTeamId].some((id) => id && !active.has(id)) && match.status !== "final") match.status = "cancelled";
    }
    state.standings = state.pools.map((pool: any) => {
      const rows = pool.teamIds.filter((id: string) => active.has(id)).map((teamId: string) => ({ teamId, played: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, scoreDifference: 0, points: 0 }));
      const byId = new Map(rows.map((row: any) => [row.teamId, row]));
      const completed = state.matches.filter((match: any) => match.phase === "pool" && match.poolId === pool.id && match.status === "final" && active.has(match.homeTeamId) && active.has(match.awayTeamId));
      for (const match of completed) {
        const home: any = byId.get(match.homeTeamId), away: any = byId.get(match.awayTeamId);
        home.played++; away.played++; home.goalsFor += match.homeScore; home.goalsAgainst += match.awayScore; away.goalsFor += match.awayScore; away.goalsAgainst += match.homeScore;
        if (match.homeScore > match.awayScore) { home.wins++; home.points += 3; away.losses++; }
        else if (match.homeScore < match.awayScore) { away.wins++; away.points += 3; home.losses++; }
        else { home.draws++; away.draws++; home.points++; away.points++; }
      }
      for (const row of rows) row.scoreDifference = row.goalsFor - row.goalsAgainst;
      const seed = (id: string) => state.registrations.find((team: any) => team.id === id).seed;
      rows.sort((left: any, right: any) => {
        if (right.points !== left.points) return right.points - left.points;
        const tied = rows.filter((row: any) => row.points === left.points);
        if (tied.length === 2) {
          const direct = completed.find((match: any) => [match.homeTeamId, match.awayTeamId].includes(left.teamId) && [match.homeTeamId, match.awayTeamId].includes(right.teamId));
          if (direct && direct.homeScore !== direct.awayScore) {
            const winner = direct.homeScore > direct.awayScore ? direct.homeTeamId : direct.awayTeamId;
            return winner === left.teamId ? -1 : 1;
          }
        }
        return right.scoreDifference - left.scoreDifference || seed(left.teamId) - seed(right.teamId) || left.teamId.localeCompare(right.teamId);
      });
      return { poolId: pool.id, rows };
    });
    const poolComplete = state.matches.filter((match: any) => match.phase === "pool").every((match: any) => ["final", "cancelled"].includes(match.status));
    const qualifiers = poolComplete ? state.standings.flatMap((table: any) => table.rows.slice(0, state.config.advancePerPool).map((row: any) => row.teamId)) : [];
    state.advancement = { qualifiedTeamIds: qualifiers };
    const semis = state.matches.filter((match: any) => match.stage === "semifinal");
    if (qualifiers.length === 4) {
      const [a1, a2] = state.standings[0].rows, [b1, b2] = state.standings[1].rows;
      [[a1.teamId, b2.teamId], [b1.teamId, a2.teamId]].forEach(([home, away], index) => { semis[index].homeTeamId = home; semis[index].awayTeamId = away; if (semis[index].status === "waiting") semis[index].status = "scheduled"; });
    }
    const final = state.matches.find((match: any) => match.stage === "final");
    const winners = semis.filter((match: any) => match.status === "final").map((match: any) => match.homeScore > match.awayScore ? match.homeTeamId : match.awayTeamId);
    if (winners.length === 2 && !final.homeTeamId) { final.homeTeamId = winners[0]; final.awayTeamId = winners[1]; final.status = "scheduled"; }
    state.bracket = { semifinalMatchIds: semis.map((match: any) => match.id), finalMatchId: final.id, championTeamId: final.status === "final" ? (final.homeScore > final.awayScore ? final.homeTeamId : final.awayTeamId) : null };
    const duration = state.config.matchDurationMinutes * 60_000;
    const scheduled: any[] = [];
    const conflicts: any[] = [];
    for (const match of state.matches.filter((candidate: any) => candidate.status === "scheduled" && candidate.homeTeamId && candidate.awayTeamId)) {
      if (match.schedule && slotValid(state, match, match.schedule, scheduled)) { scheduled.push(match); continue; }
      match.schedule = null;
      outer: for (const venue of state.config.venues) for (const window of venue.windows) for (let start = minutes(window.start); start + duration <= minutes(window.end); start += duration) for (const court of venue.courts) {
        const schedule = { venueId: venue.id, court, start: new Date(start).toISOString() };
        if (slotValid(state, match, schedule, scheduled)) { match.schedule = schedule; scheduled.push(match); break outer; }
      }
      if (!match.schedule) conflicts.push({ matchId: match.id, reason: "no-feasible-slot" });
    }
    state.scheduleFeasibility = { feasible: conflicts.length === 0, conflicts };
    return state;
  };
  const slotValid = (state: AnyState, match: any, schedule: any, others: any[]) => {
    const venue = state.config.venues.find((item: any) => item.id === schedule.venueId);
    if (!venue || !venue.courts.includes(schedule.court)) return false;
    const start = minutes(schedule.start), duration = state.config.matchDurationMinutes * 60_000;
    if (!venue.windows.some((window: any) => start >= minutes(window.start) && start + duration <= minutes(window.end))) return false;
    return others.every((other: any) => {
      if (!overlaps(start, minutes(other.schedule.start), duration)) return true;
      const courtFree = schedule.venueId !== other.schedule.venueId || schedule.court !== other.schedule.court;
      const teamFree = ![match.homeTeamId, match.awayTeamId].some((id) => [other.homeTeamId, other.awayTeamId].includes(id));
      return courtFree && teamFree;
    });
  };
  const createTournament = (config: AnyState) => {
    if (config.poolCount !== 2 || config.advancePerPool !== 2) throw new Error("unsupported topology");
    if (new Set(config.registrations.map((team: any) => team.id)).size !== config.registrations.length || new Set(config.registrations.map((team: any) => team.seed)).size !== config.registrations.length) throw new Error("duplicate registration");
    const registrations = clone(config.registrations).sort((a: any, b: any) => a.seed - b.seed).map((team: any) => ({ ...team, status: "active" }));
    const pools: { id: string; teamIds: string[] }[] = Array.from({ length: config.poolCount }, (_, index) => ({ id: `pool-${String.fromCharCode(65 + index)}`, teamIds: [] }));
    registrations.forEach((team: any, index: number) => { const cycle = Math.floor(index / config.poolCount), offset = index % config.poolCount; pools[cycle % 2 === 0 ? offset : config.poolCount - 1 - offset]!.teamIds.push(team.id); });
    const matches: any[] = pools.flatMap((pool) => pool.teamIds.flatMap((homeTeamId, index) => pool.teamIds.slice(index + 1).map((awayTeamId) => ({ id: `${pool.id}:${homeTeamId}:${awayTeamId}`, phase: "pool", poolId: pool.id, homeTeamId, awayTeamId, status: "scheduled", schedule: null }))));
    matches.push({ id: "semi-1", phase: "elimination", stage: "semifinal", homeTeamId: null, awayTeamId: null, status: "waiting", schedule: null }, { id: "semi-2", phase: "elimination", stage: "semifinal", homeTeamId: null, awayTeamId: null, status: "waiting", schedule: null }, { id: "final", phase: "elimination", stage: "final", homeTeamId: null, awayTeamId: null, status: "waiting", schedule: null });
    return recompute({ config: clone(config), registrations, pools, matches });
  };
  const recordResult = (input: AnyState, result: AnyState) => {
    if (!Number.isInteger(result.homeScore) || result.homeScore < 0 || !Number.isInteger(result.awayScore) || result.awayScore < 0) throw new Error("invalid score");
    const state = clone(input), match = state.matches.find((item: any) => item.id === result.matchId);
    if (!match || match.status === "cancelled" || match.status === "waiting") throw new Error("match cannot be finalized");
    Object.assign(match, { status: "final", homeScore: result.homeScore, awayScore: result.awayScore }); return recompute(state);
  };
  const withdrawTeam = (input: AnyState, event: AnyState) => { const state = clone(input), team = state.registrations.find((item: any) => item.id === event.teamId); if (!team) throw new Error("unknown team"); team.status = "withdrawn"; return recompute(state); };
  const rescheduleMatch = (input: AnyState, event: AnyState) => {
    const state = clone(input), match = state.matches.find((item: any) => item.id === event.matchId); if (!match || match.status !== "scheduled") throw new Error("unplayed scheduled match required");
    const others = state.matches.filter((item: any) => item.id !== match.id && item.status === "scheduled" && item.schedule);
    const schedule = { venueId: event.venueId, court: event.court, start: new Date(event.start).toISOString() };
    if (!slotValid(state, match, schedule, others)) throw new Error("infeasible reschedule"); match.schedule = schedule; return recompute(state);
  };
  return { createTournament, recordResult, withdrawTeam, rescheduleMatch };
}

describe("Tournament Operations capability case", () => {
  it("publishes an immutable candidate snapshot without sealed catalog paths", () => {
    expect(tournamentOperationsCase.definition.id).toBe(TOURNAMENT_OPERATIONS_CASE_ID);
    expect(tournamentOperationsCase.snapshot.authoringStatus).toBe("candidate");
    expect(tournamentOperationsCase.snapshotDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(tournamentOperationsCase.catalogSnapshot.artifacts.reference).not.toHaveProperty("sealedPath");
    expect(tournamentOperationsCase.catalogSnapshot.artifacts.verifier).not.toHaveProperty("sealedPath");
    expect(tournamentOperationsCase.snapshot.artifacts.verifier.mandatoryGates.map(({ id }) => id)).toEqual(["tournament-core", "schedule-operations", "operator-interface", "tournament-scoped-commit"]);
  });

  it("binds the sealed reference descriptor to the checked-in immutable bytes", async () => {
    for (const artifact of [tournamentOperationsCase.snapshot.artifacts.reference, tournamentOperationsCase.snapshot.artifacts.verifier]) {
      const contents = await readFile(join(import.meta.dirname, "../../..", artifact.sealedPath));
      expect(`sha256:${createHash("sha256").update(contents).digest("hex")}`).toBe(artifact.contentDigest);
    }
    const manifest = JSON.parse(await readFile(join(import.meta.dirname, "../../../eval-cases/tournament-operations-platform/verifier/manifest.json"), "utf8"));
    const operatorVerifier = await readFile(join(import.meta.dirname, "../../../eval-cases/tournament-operations-platform/verifier/operator-interface.cjs"));
    expect(`sha256:${createHash("sha256").update(operatorVerifier).digest("hex")}`).toBe(manifest.operatorInterfaceVerifierDigest);
    const behavioralSource = await readFile(join(import.meta.dirname, "../src/project-cases/tournament-operations-case.ts"), "utf8");
    const normalizedBehavioralSource = behavioralSource.replace(/"behavioralVerifierSourceDigest": "sha256:[a-f0-9]{64}"/g, `"behavioralVerifierSourceDigest": "sha256:${"0".repeat(64)}"`);
    expect(`sha256:${createHash("sha256").update(normalizedBehavioralSource).digest("hex")}`).toBe(manifest.behavioralVerifierSourceDigest);
    const serviceSource = await readFile(join(import.meta.dirname, "../../../desktop/eval-main/eval-service.mjs"));
    expect(`sha256:${createHash("sha256").update(serviceSource).digest("hex")}`).toBe(manifest.serviceIntegrationSourceDigest);
  });

  it("materializes a frozen clean greenfield fixture whose untouched baseline is red", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-tournament-red-")); temporaryDirectories.push(root);
    const workspaceDirectory = join(root, "workspace");
    const fixture = await materializeTournamentOperationsFixture({ caseId: TOURNAMENT_OPERATIONS_CASE_ID, workspaceDirectory, platform: "darwin" });
    expect(fixture.seededCommit).toMatch(/^[a-f0-9]{40}$/); expect(fixture.sourceRevision).toBe(tournamentOperationsCase.snapshot.artifacts.workspace.revision);
    expect(await readFile(join(workspaceDirectory, "README.md"), "utf8")).toContain("Public seam");
    const checks = await gradeTournamentOperationsWorkspace({ caseId: TOURNAMENT_OPERATIONS_CASE_ID, workspaceDirectory, baseRevision: fixture.seededCommit });
    expect(checks.filter(({ name }) => name.includes("registration-uniqueness") || name.includes("standings-points") || name.includes("reschedule-window")).every(({ passed }) => !passed)).toBe(true);
    expect(checks.find(({ name }) => name === "workspace:operator-interface")?.passed).toBe(false);
    expect(checks.find(({ name }) => name === "workspace:delivery-commit")?.passed).toBe(false);
    await writeFile(join(workspaceDirectory, "index.html"), `<!-- <section data-tournament-view="registration">x</section><section data-tournament-view="schedule">x</section><section data-tournament-view="standings">x</section><section data-tournament-view="bracket">x</section><section data-tournament-view="conflicts">x</section><button data-tournament-action="record-result">x</button><button data-tournament-action="withdraw">x</button><button data-tournament-action="reschedule">x</button><script type="module"></script> -->`, "utf8");
    const commented = await gradeTournamentOperationsWorkspace({ caseId: TOURNAMENT_OPERATIONS_CASE_ID, workspaceDirectory, baseRevision: fixture.seededCommit });
    expect(commented.find(({ name }) => name === "workspace:operator-interface")?.passed).toBe(false);
    await writeFile(join(workspaceDirectory, "index.html"), `<!doctype html><main><section data-tournament-view="registration">Teams</section><section data-tournament-view="schedule">Schedule</section><section data-tournament-view="standings">Standings</section><section data-tournament-view="bracket">Bracket</section><section data-tournament-view="conflicts">Conflicts</section><button data-tournament-action="record-result">Record</button><button data-tournament-action="withdraw">Withdraw</button><button data-tournament-action="reschedule">Move</button><script type="module">import "./src/index.js";for(const button of document.querySelectorAll("button"))button.onclick=()=>document.querySelector('[data-tournament-view="standings"]').append(" updated");</script></main>`, "utf8");
    const fakeUi = await gradeTournamentOperationsWorkspace({ caseId: TOURNAMENT_OPERATIONS_CASE_ID, workspaceDirectory, baseRevision: fixture.seededCommit });
    expect(fakeUi.find(({ name }) => name === "workspace:operator-interface")?.passed).toBe(false);
  }, 45_000);

  it("admits two materially different reasonable implementations through only the public seam", async () => {
    const operatorHtml = `<!doctype html><main><section data-tournament-view="registration">Registered teams</section><section data-tournament-view="schedule">Match schedule</section><section data-tournament-view="standings">Pool standings</section><section data-tournament-view="bracket">Elimination bracket</section><section data-tournament-view="conflicts">Schedule conflicts</section><button data-tournament-action="record-result">Record</button><button data-tournament-action="withdraw">Withdraw</button><button data-tournament-action="reschedule">Reschedule</button><script type="module">
import * as operations from "./src/index.js";
const config={registrations:Array.from({length:8},(_,index)=>({id:"t"+(index+1),name:"Team "+(index+1),seed:index+1})),poolCount:2,advancePerPool:2,matchDurationMinutes:30,venues:[{id:"north",courts:["n1","n2"],windows:[{start:"2027-06-05T09:00:00Z",end:"2027-06-05T15:00:00Z"}]},{id:"south",courts:["s1","s2"],windows:[{start:"2027-06-05T09:00:00Z",end:"2027-06-05T15:00:00Z"}]}]};
const hooks={"record-result":{action:"recordResult",view:"standings"},"withdraw":{action:"withdrawTeam",view:"registration"},"reschedule":{action:"rescheduleMatch",view:"schedule"}};
for(const [hook,{action,view}] of Object.entries(hooks)) document.querySelector('[data-tournament-action="'+hook+'"]').addEventListener("click",()=>{
  const state=operations.createTournament(structuredClone(config));
  let args,output;
  if(action==="recordResult"){const match=state.matches.find(({phase})=>phase==="pool");args=[state,{matchId:match.id,homeScore:2,awayScore:1}];}
  else if(action==="withdrawTeam") args=[state,{teamId:"t1"}];
  else {
    const match=state.matches.find(({phase,schedule})=>phase==="pool"&&schedule),duration=config.matchDurationMinutes*60000;
    search:for(const venue of config.venues)for(const window of venue.windows)for(let start=Date.parse(window.start);start+duration<=Date.parse(window.end);start+=duration)for(const court of venue.courts){
      const event={matchId:match.id,venueId:venue.id,court,start:new Date(start).toISOString()};
      if(event.venueId===match.schedule.venueId&&event.court===match.schedule.court&&event.start===match.schedule.start)continue;
      try{args=[state,event];output=operations[action](...args);break search;}catch{}
    }
    if(!output)throw new Error("No alternative reschedule slot.");
  }
  output??=operations[action](...args);
  document.querySelector('[data-tournament-view="'+view+'"]').textContent=JSON.stringify(output);
  document.dispatchEvent(new CustomEvent("tournament-operation",{bubbles:true,detail:{action,implementation:operations[action],args,output}}));
});
</script></main>`;
    for (const artifact of ["green-functional.js", "green-event-replay.js"]) {
      const root = await mkdtemp(join(tmpdir(), "relayer-tournament-green-")); temporaryDirectories.push(root);
      const workspaceDirectory = join(root, "workspace");
      const fixture = await materializeTournamentOperationsFixture({ caseId: TOURNAMENT_OPERATIONS_CASE_ID, workspaceDirectory, platform: "darwin" });
      const source = await readFile(join(import.meta.dirname, "../../../eval-cases/tournament-operations-platform/admission", artifact), "utf8");
      await writeFile(join(workspaceDirectory, "src/index.js"), source, "utf8");
      await writeFile(join(workspaceDirectory, "index.html"), operatorHtml, "utf8");
      await execFileAsync("git", ["add", "--all"], { cwd: workspaceDirectory });
      await execFileAsync("git", ["commit", "--quiet", "-m", `Implement ${artifact}`], { cwd: workspaceDirectory });
      const checks = await gradeTournamentOperationsWorkspace({ caseId: TOURNAMENT_OPERATIONS_CASE_ID, workspaceDirectory, baseRevision: fixture.seededCommit });
      expect(checks.every(({ passed }) => passed), `${artifact}: ${JSON.stringify(checks)}`).toBe(true);
    }
  }, 20_000);

  it("rejects adversarial shortcuts while preserving independent predicate evidence", async () => {
    const good = functionalSolution();
    const eraseEliminationSchedule = (state: any) => ({ ...state, matches: state.matches.map((match: any) => match.phase === "elimination" ? { ...match, schedule: null } : match) });
    const nonJson = (state: any) => ({ ...state, nonJson: Number.NaN });
    const mutants = [
      { ...good, createTournament: (config: any) => ({ ...good.createTournament(config), scheduleFeasibility: { feasible: true, conflicts: [] }, matches: good.createTournament(config).matches.map((match: any) => ({ ...match, schedule: { venueId: config.venues[0].id, court: config.venues[0].courts[0], start: config.venues[0].windows[0].start } })) }) },
      { ...good, withdrawTeam: (state: any) => state },
      { ...good, rescheduleMatch: (state: any, event: any) => ({ ...state, matches: state.matches.map((match: any) => match.id === event.matchId ? { ...match, schedule: event } : match) }) },
      { ...good, recordResult: (state: any) => state },
      {
        createTournament: (...args: any[]) => eraseEliminationSchedule((good.createTournament as (...values: any[]) => any)(...args)),
        recordResult: (...args: any[]) => eraseEliminationSchedule((good.recordResult as (...values: any[]) => any)(...args)),
        withdrawTeam: (...args: any[]) => eraseEliminationSchedule((good.withdrawTeam as (...values: any[]) => any)(...args)),
        rescheduleMatch: (...args: any[]) => eraseEliminationSchedule((good.rescheduleMatch as (...values: any[]) => any)(...args)),
      },
      {
        createTournament: (...args: any[]) => nonJson((good.createTournament as (...values: any[]) => any)(...args)),
        recordResult: (...args: any[]) => nonJson((good.recordResult as (...values: any[]) => any)(...args)),
        withdrawTeam: (...args: any[]) => nonJson((good.withdrawTeam as (...values: any[]) => any)(...args)),
        rescheduleMatch: (...args: any[]) => nonJson((good.rescheduleMatch as (...values: any[]) => any)(...args)),
      },
      { ...good, recordResult: (...args: any[]) => { const state = (good.recordResult as (...values: any[]) => any)(...args); return state.advancement.qualifiedTeamIds.length === 4 ? { ...state, advancement: { qualifiedTeamIds: ["t1", "t2", "t3", "t4"] } } : state; } },
      { ...good, recordResult: (...args: any[]) => { const state = (good.recordResult as (...values: any[]) => any)(...args); return state.bracket.championTeamId ? { ...state, bracket: { ...state.bracket, championTeamId: "bogus-team" } } : state; } },
      { ...good, withdrawTeam: (...args: any[]) => { const state = (good.withdrawTeam as (...values: any[]) => any)(...args), teamId = args[1].teamId; return { ...state, matches: state.matches.map((match: any) => [match.homeTeamId, match.awayTeamId].includes(teamId) ? { ...match, status: "cancelled" } : match) }; } },
      { ...good, rescheduleMatch: (...args: any[]) => nonJson((good.rescheduleMatch as (...values: any[]) => any)(...args)) },
      { ...good, createTournament: (...args: any[]) => { const state = (good.createTournament as (...values: any[]) => any)(...args); return state.scheduleFeasibility.feasible ? state : { ...state, scheduleFeasibility: { feasible: false, conflicts: ["conflict"] } }; } },
      { ...good, createTournament: (...args: any[]) => { const state = (good.createTournament as (...values: any[]) => any)(...args); return { ...state, standings: state.standings.map((table: any) => ({ ...table, rows: table.rows.map(({ played: _played, draws: _draws, goalsFor: _goalsFor, goalsAgainst: _goalsAgainst, ...row }: any) => row) })) }; } },
      { ...good, rescheduleMatch: (...args: any[]) => { const state = (good.rescheduleMatch as (...values: any[]) => any)(...args); Object.defineProperty(state, "toJSON", { enumerable: true, value() { const copy = { ...this }; delete copy.toJSON; return copy; } }); return state; } },
      { ...good, createTournament: (config: any) => { if (config.registrations[0]?.id !== "t1") throw new Error("only the frozen teams are supported"); return good.createTournament(config); } },
      { ...good, rescheduleMatch: (state: any, event: any) => {
        good.rescheduleMatch(state, event);
        const match = state.matches.find((item: any) => item.id === event.matchId), duration = state.config.matchDurationMinutes * 60_000;
        for (const venue of state.config.venues) for (const window of venue.windows) for (let start = Date.parse(window.start); start + duration <= Date.parse(window.end); start += duration) for (const court of venue.courts) {
          const alternate = { matchId: event.matchId, venueId: venue.id, court, start: new Date(start).toISOString() };
          if (alternate.venueId === event.venueId && alternate.court === event.court && alternate.start === event.start) continue;
          try { return good.rescheduleMatch(state, alternate); } catch { /* keep searching */ }
        }
        return { ...state, matches: state.matches.map((item: any) => item.id === match.id ? { ...item, schedule: null } : item) };
      } },
    ];
    const expectedFailures = ["schedule-collision-free", "withdrawal-cancellation", "reschedule-collision", "standings-points", "elimination-schedule", "json-compatible-snapshots", "advancement-pool-qualifiers", "bracket-progression", "withdrawal-cancellation", "json-compatible-snapshots", "schedule-infeasible", "snapshot-schema", "json-compatible-snapshots", "configuration-matrix", "reschedule-valid-free-slot"];
    for (const [index, mutant] of mutants.entries()) {
      const results = await verifyTournamentPublicSeam(mutant);
      expect(results).toHaveLength(23);
      expect(results.find(({ id }) => id === expectedFailures[index])?.passed).toBe(false);
    }
  });
});
