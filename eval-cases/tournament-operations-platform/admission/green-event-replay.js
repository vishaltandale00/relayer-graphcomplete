// Independent admission implementation: commands append facts and this projector
// rebuilds the public snapshot.  It intentionally shares no implementation with
// the direct-state reference solution used elsewhere in the admission portfolio.

const copy = (value) => structuredClone(value);
const minutes = (count) => count * 60_000;

function assertConfig(config) {
  if (!config || !Array.isArray(config.registrations) || config.registrations.length === 0) {
    throw new Error("At least one registration is required.");
  }
  if (!Number.isInteger(config.poolCount) || config.poolCount < 1) throw new Error("poolCount must be a positive integer.");
  if (!Number.isInteger(config.advancePerPool) || config.advancePerPool < 1) throw new Error("advancePerPool must be a positive integer.");
  if (config.poolCount !== 2 || config.advancePerPool !== 2) throw new Error("This bracket supports exactly two pools and two qualifiers per pool.");
  if (!Number.isInteger(config.matchDurationMinutes) || config.matchDurationMinutes < 1) throw new Error("matchDurationMinutes must be positive.");
  const ids = config.registrations.map(({ id }) => id);
  const seeds = config.registrations.map(({ seed }) => seed);
  if (ids.some((id) => typeof id !== "string" || id.length === 0) || new Set(ids).size !== ids.length) throw new Error("Registration IDs must be unique nonempty strings.");
  if (seeds.some((seed) => !Number.isInteger(seed)) || new Set(seeds).size !== seeds.length) throw new Error("Seeds must be unique integers.");
  if (!Array.isArray(config.venues)) throw new Error("venues must be an array.");
}

function seededPools(config) {
  const pools = Array.from({ length: config.poolCount }, (_, index) => ({
    id: `pool-${String.fromCharCode(65 + index)}`,
    name: `Pool ${String.fromCharCode(65 + index)}`,
    teamIds: [],
  }));
  const ordered = [...config.registrations].sort((a, b) => a.seed - b.seed || a.id.localeCompare(b.id));
  ordered.forEach((team, index) => {
    const row = Math.floor(index / pools.length);
    const offset = index % pools.length;
    const poolIndex = row % 2 === 0 ? offset : pools.length - 1 - offset;
    pools[poolIndex].teamIds.push(team.id);
  });
  return pools;
}

function poolFixtures(pools) {
  const fixtures = [];
  for (const pool of pools) {
    for (let left = 0; left < pool.teamIds.length; left += 1) {
      for (let right = left + 1; right < pool.teamIds.length; right += 1) {
        fixtures.push({
          id: `${pool.id}-m${left + 1}-${right + 1}`,
          phase: "pool",
          poolId: pool.id,
          homeTeamId: pool.teamIds[left],
          awayTeamId: pool.teamIds[right],
          status: "scheduled",
          schedule: null,
        });
      }
    }
  }
  return fixtures;
}

function candidateSlots(config) {
  const slots = [];
  for (const venue of config.venues) {
    for (const window of venue.windows ?? []) {
      const beginning = Date.parse(window.start);
      const ending = Date.parse(window.end);
      if (!Number.isFinite(beginning) || !Number.isFinite(ending)) continue;
      for (let start = beginning; start + minutes(config.matchDurationMinutes) <= ending; start += minutes(config.matchDurationMinutes)) {
        for (const court of venue.courts ?? []) slots.push({ venueId: venue.id, court, start: new Date(start).toISOString() });
      }
    }
  }
  return slots.sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.venueId.localeCompare(b.venueId) || a.court.localeCompare(b.court));
}

function overlaps(left, right, duration) {
  const a = Date.parse(left.start), b = Date.parse(right.start);
  return a < b + duration && b < a + duration;
}

function slotConflict(match, slot, assigned, duration) {
  return assigned.some((other) => {
    if (!other.schedule || !overlaps(slot, other.schedule, duration)) return false;
    const sameCourt = slot.venueId === other.schedule.venueId && slot.court === other.schedule.court;
    const sameTeam = [match.homeTeamId, match.awayTeamId].some((id) => id && (id === other.homeTeamId || id === other.awayTeamId));
    return sameCourt || sameTeam;
  });
}

function scheduleMatches(matches, config, moves) {
  const duration = minutes(config.matchDurationMinutes);
  const slots = candidateSlots(config);
  const active = matches.filter((match) => match.status !== "cancelled" && match.homeTeamId && match.awayTeamId);
  const assigned = [];
  const conflicts = [];
  for (const match of active) {
    const requested = moves.get(match.id);
    const slot = requested ?? slots.find((candidate) => !slotConflict(match, candidate, assigned, duration));
    if (!slot || slotConflict(match, slot, assigned, duration)) {
      match.schedule = null;
      conflicts.push({ matchId: match.id, type: "unscheduled", message: `No feasible venue slot for ${match.id}.` });
    } else {
      match.schedule = { ...slot };
      assigned.push(match);
    }
  }
  return { feasible: conflicts.length === 0, conflicts };
}

function standingsFor(pool, registrations, matches) {
  const active = pool.teamIds.filter((id) => registrations.find((team) => team.id === id)?.status !== "withdrawn");
  const rows = new Map(active.map((teamId) => [teamId, { teamId, played: 0, wins: 0, draws: 0, losses: 0, points: 0, goalsFor: 0, goalsAgainst: 0, scoreDifference: 0 }]));
  const finals = matches.filter((match) => match.poolId === pool.id && match.status === "final" && rows.has(match.homeTeamId) && rows.has(match.awayTeamId));
  for (const match of finals) {
    const home = rows.get(match.homeTeamId), away = rows.get(match.awayTeamId);
    home.played += 1; away.played += 1;
    home.goalsFor += match.homeScore; home.goalsAgainst += match.awayScore;
    away.goalsFor += match.awayScore; away.goalsAgainst += match.homeScore;
    if (match.homeScore > match.awayScore) { home.wins += 1; away.losses += 1; home.points += 3; }
    else if (match.homeScore < match.awayScore) { away.wins += 1; home.losses += 1; away.points += 3; }
    else { home.draws += 1; away.draws += 1; home.points += 1; away.points += 1; }
  }
  for (const row of rows.values()) row.scoreDifference = row.goalsFor - row.goalsAgainst;
  const seed = new Map(registrations.map((team) => [team.id, team.seed]));
  const pointGroups = new Map();
  for (const row of rows.values()) pointGroups.set(row.points, [...(pointGroups.get(row.points) ?? []), row.teamId]);
  const headToHead = (left, right) => {
    if ((pointGroups.get(left.points) ?? []).length !== 2) return 0;
    const game = finals.find((match) => [match.homeTeamId, match.awayTeamId].includes(left.teamId) && [match.homeTeamId, match.awayTeamId].includes(right.teamId));
    if (!game || game.homeScore === game.awayScore) return 0;
    const winner = game.homeScore > game.awayScore ? game.homeTeamId : game.awayTeamId;
    return winner === left.teamId ? -1 : 1;
  };
  const ordered = [...rows.values()].sort((left, right) => right.points - left.points || headToHead(left, right) || right.scoreDifference - left.scoreDifference || seed.get(left.teamId) - seed.get(right.teamId) || left.teamId.localeCompare(right.teamId));
  return { poolId: pool.id, rows: ordered };
}

function project(log) {
  const origin = log[0];
  if (!origin || origin.type !== "TournamentCreated") throw new Error("Invalid tournament event history.");
  const config = copy(origin.config);
  const registrations = config.registrations.map((team) => ({ ...team, status: "active" }));
  const pools = seededPools(config);
  const matches = poolFixtures(pools);
  const moves = new Map();

  for (const event of log.slice(1)) {
    if (event.type === "TeamWithdrawn") {
      const team = registrations.find(({ id }) => id === event.teamId);
      if (team) team.status = "withdrawn";
      for (const match of matches) {
        if (match.status !== "final" && [match.homeTeamId, match.awayTeamId].includes(event.teamId)) match.status = "cancelled";
      }
    } else if (event.type === "ResultRecorded") {
      const match = matches.find(({ id }) => id === event.matchId);
      if (match) Object.assign(match, { status: "final", homeScore: event.homeScore, awayScore: event.awayScore });
    } else if (event.type === "MatchRescheduled") moves.set(event.matchId, { venueId: event.venueId, court: event.court, start: event.start });
  }

  const standings = pools.map((pool) => standingsFor(pool, registrations, matches));
  const poolsComplete = matches.filter(({ phase }) => phase === "pool").every(({ status }) => status === "final" || status === "cancelled");
  const qualifiedTeamIds = poolsComplete ? standings.flatMap(({ rows }) => rows.slice(0, config.advancePerPool).map(({ teamId }) => teamId)) : [];
  const bracket = { semifinalMatchIds: ["semi-1", "semi-2"], finalMatchId: "final", championTeamId: null };

  if (pools.length === 2 && config.advancePerPool === 2 && qualifiedTeamIds.length === 4) {
    const [a1, a2] = standings[0].rows, [b1, b2] = standings[1].rows;
    matches.push(
      { id: "elimination-semifinal-1", phase: "elimination", stage: "semifinal", homeTeamId: a1.teamId, awayTeamId: b2.teamId, status: "scheduled", schedule: null },
      { id: "elimination-semifinal-2", phase: "elimination", stage: "semifinal", homeTeamId: b1.teamId, awayTeamId: a2.teamId, status: "scheduled", schedule: null },
    );
    for (const event of log.filter(({ type }) => type === "ResultRecorded")) {
      const match = matches.find(({ id }) => id === event.matchId);
      if (match) Object.assign(match, { status: "final", homeScore: event.homeScore, awayScore: event.awayScore });
    }
    const semis = matches.filter(({ stage }) => stage === "semifinal");
    if (semis.every(({ status }) => status === "final")) {
      const winner = (match) => match.homeScore > match.awayScore ? match.homeTeamId : match.awayTeamId;
      matches.push({ id: "elimination-final", phase: "elimination", stage: "final", homeTeamId: winner(semis[0]), awayTeamId: winner(semis[1]), status: "scheduled", schedule: null });
      const finalResult = [...log].reverse().find((event) => event.type === "ResultRecorded" && event.matchId === "elimination-final");
      const final = matches.at(-1);
      if (finalResult) {
        Object.assign(final, { status: "final", homeScore: finalResult.homeScore, awayScore: finalResult.awayScore });
        bracket.championTeamId = final.homeScore > final.awayScore ? final.homeTeamId : final.awayTeamId;
      }
    }
  }

  const scheduleFeasibility = scheduleMatches(matches, config, moves);
  return { registrations, pools, matches, standings, advancement: { qualifiedTeamIds }, bracket, scheduleFeasibility, eventLog: copy(log) };
}

function historyOf(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.eventLog)) throw new Error("Snapshot does not contain tournament history.");
  return copy(snapshot.eventLog);
}

export function createTournament(config) {
  assertConfig(config);
  return project([{ type: "TournamentCreated", config: copy(config) }]);
}

export function recordResult(snapshot, command) {
  if (!command || !Number.isInteger(command.homeScore) || !Number.isInteger(command.awayScore) || command.homeScore < 0 || command.awayScore < 0) throw new Error("Scores must be nonnegative integers.");
  const match = snapshot?.matches?.find(({ id }) => id === command.matchId);
  if (!match) throw new Error(`Unknown match ${command?.matchId}.`);
  if (match.status === "cancelled") throw new Error("Cancelled matches cannot receive results.");
  if (match.status === "final") throw new Error("A result has already been recorded.");
  if (match.phase === "elimination" && command.homeScore === command.awayScore) throw new Error("Elimination matches require a winner.");
  return project([...historyOf(snapshot), { type: "ResultRecorded", matchId: command.matchId, homeScore: command.homeScore, awayScore: command.awayScore }]);
}

export function withdrawTeam(snapshot, { teamId } = {}) {
  const team = snapshot?.registrations?.find(({ id }) => id === teamId);
  if (!team) throw new Error(`Unknown team ${teamId}.`);
  if (team.status === "withdrawn") throw new Error("Team is already withdrawn.");
  return project([...historyOf(snapshot), { type: "TeamWithdrawn", teamId }]);
}

export function rescheduleMatch(snapshot, command) {
  const match = snapshot?.matches?.find(({ id }) => id === command?.matchId);
  if (!match) throw new Error(`Unknown match ${command?.matchId}.`);
  if (match.status !== "scheduled") throw new Error("Only unplayed active matches may be rescheduled.");
  const config = snapshot.eventLog?.[0]?.config;
  const venue = config?.venues?.find(({ id }) => id === command.venueId);
  const start = Date.parse(command.start), end = start + minutes(config?.matchDurationMinutes ?? 0);
  if (!venue || !venue.courts.includes(command.court) || !Number.isFinite(start) || !venue.windows.some((window) => start >= Date.parse(window.start) && end <= Date.parse(window.end))) {
    throw new Error("Requested slot is outside the venue contract.");
  }
  const duration = minutes(config.matchDurationMinutes);
  const slot = { venueId: command.venueId, court: command.court, start: new Date(start).toISOString() };
  const others = snapshot.matches.filter(({ id, status, schedule }) => id !== match.id && status !== "cancelled" && schedule);
  if (slotConflict(match, slot, others, duration)) throw new Error("Requested slot collides with a team or court booking.");
  return project([...historyOf(snapshot), { type: "MatchRescheduled", matchId: match.id, ...slot }]);
}
