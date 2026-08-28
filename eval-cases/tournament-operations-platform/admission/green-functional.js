// Independent admission solution using direct immutable state transitions.
// Derived state is recomputed after every public command; no event history or
// reference implementation details are carried in the returned snapshot.

const clone = (value) => structuredClone(value);
const timestamp = (value) => Date.parse(value);
const intervalsOverlap = (left, right, duration) => left < right + duration && right < left + duration;

function validSlot(state, match, schedule, assigned) {
  const venue = state.config.venues.find((item) => item.id === schedule.venueId);
  if (!venue || !venue.courts.includes(schedule.court)) return false;
  const start = timestamp(schedule.start);
  const duration = state.config.matchDurationMinutes * 60_000;
  if (!venue.windows.some((window) => start >= timestamp(window.start) && start + duration <= timestamp(window.end))) return false;
  return assigned.every((other) => {
    if (!intervalsOverlap(start, timestamp(other.schedule.start), duration)) return true;
    const courtIsFree = schedule.venueId !== other.schedule.venueId || schedule.court !== other.schedule.court;
    const teamsAreFree = ![match.homeTeamId, match.awayTeamId].some((id) => [other.homeTeamId, other.awayTeamId].includes(id));
    return courtIsFree && teamsAreFree;
  });
}

function recompute(input) {
  const state = clone(input);
  const active = new Set(state.registrations.filter((team) => team.status !== "withdrawn").map((team) => team.id));

  for (const match of state.matches) {
    if ([match.homeTeamId, match.awayTeamId].some((id) => id && !active.has(id)) && match.status !== "final") match.status = "cancelled";
  }

  state.standings = state.pools.map((pool) => {
    const rows = pool.teamIds
      .filter((id) => active.has(id))
      .map((teamId) => ({ teamId, played: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, scoreDifference: 0, points: 0 }));
    const byId = new Map(rows.map((row) => [row.teamId, row]));
    const completed = state.matches.filter((match) => match.phase === "pool" && match.poolId === pool.id && match.status === "final" && active.has(match.homeTeamId) && active.has(match.awayTeamId));
    for (const match of completed) {
      const home = byId.get(match.homeTeamId);
      const away = byId.get(match.awayTeamId);
      home.played += 1;
      away.played += 1;
      home.goalsFor += match.homeScore;
      home.goalsAgainst += match.awayScore;
      away.goalsFor += match.awayScore;
      away.goalsAgainst += match.homeScore;
      if (match.homeScore > match.awayScore) {
        home.wins += 1;
        home.points += 3;
        away.losses += 1;
      } else if (match.homeScore < match.awayScore) {
        away.wins += 1;
        away.points += 3;
        home.losses += 1;
      } else {
        home.draws += 1;
        away.draws += 1;
        home.points += 1;
        away.points += 1;
      }
    }
    for (const row of rows) row.scoreDifference = row.goalsFor - row.goalsAgainst;
    const seed = (id) => state.registrations.find((team) => team.id === id).seed;
    rows.sort((left, right) => {
      if (right.points !== left.points) return right.points - left.points;
      const tied = rows.filter((row) => row.points === left.points);
      if (tied.length === 2) {
        const direct = completed.find((match) => [match.homeTeamId, match.awayTeamId].includes(left.teamId) && [match.homeTeamId, match.awayTeamId].includes(right.teamId));
        if (direct && direct.homeScore !== direct.awayScore) {
          const winner = direct.homeScore > direct.awayScore ? direct.homeTeamId : direct.awayTeamId;
          return winner === left.teamId ? -1 : 1;
        }
      }
      return right.scoreDifference - left.scoreDifference || seed(left.teamId) - seed(right.teamId) || left.teamId.localeCompare(right.teamId);
    });
    return { poolId: pool.id, rows };
  });

  const poolComplete = state.matches.filter((match) => match.phase === "pool").every((match) => ["final", "cancelled"].includes(match.status));
  const qualifiers = poolComplete
    ? state.standings.flatMap((table) => table.rows.slice(0, state.config.advancePerPool).map((row) => row.teamId))
    : [];
  state.advancement = { qualifiedTeamIds: qualifiers };

  const semifinals = state.matches.filter((match) => match.stage === "semifinal");
  if (qualifiers.length === 4) {
    const [a1, a2] = state.standings[0].rows;
    const [b1, b2] = state.standings[1].rows;
    [[a1.teamId, b2.teamId], [b1.teamId, a2.teamId]].forEach(([home, away], index) => {
      semifinals[index].homeTeamId = home;
      semifinals[index].awayTeamId = away;
      if (semifinals[index].status === "waiting") semifinals[index].status = "scheduled";
    });
  }
  const final = state.matches.find((match) => match.stage === "final");
  const winners = semifinals
    .filter((match) => match.status === "final")
    .map((match) => match.homeScore > match.awayScore ? match.homeTeamId : match.awayTeamId);
  if (winners.length === 2 && !final.homeTeamId) {
    final.homeTeamId = winners[0];
    final.awayTeamId = winners[1];
    final.status = "scheduled";
  }
  state.bracket = {
    semifinalMatchIds: semifinals.map((match) => match.id),
    finalMatchId: final.id,
    championTeamId: final.status === "final" ? (final.homeScore > final.awayScore ? final.homeTeamId : final.awayTeamId) : null,
  };

  const duration = state.config.matchDurationMinutes * 60_000;
  const assigned = [];
  const conflicts = [];
  for (const match of state.matches.filter((candidate) => candidate.status === "scheduled" && candidate.homeTeamId && candidate.awayTeamId)) {
    if (match.schedule && validSlot(state, match, match.schedule, assigned)) {
      assigned.push(match);
      continue;
    }
    match.schedule = null;
    search: for (const venue of state.config.venues) {
      for (const window of venue.windows) {
        for (let start = timestamp(window.start); start + duration <= timestamp(window.end); start += duration) {
          for (const court of venue.courts) {
            const schedule = { venueId: venue.id, court, start: new Date(start).toISOString() };
            if (validSlot(state, match, schedule, assigned)) {
              match.schedule = schedule;
              assigned.push(match);
              break search;
            }
          }
        }
      }
    }
    if (!match.schedule) conflicts.push({ matchId: match.id, reason: "no-feasible-slot" });
  }
  state.scheduleFeasibility = { feasible: conflicts.length === 0, conflicts };
  return state;
}

export function createTournament(config) {
  if (config.poolCount !== 2 || config.advancePerPool !== 2) throw new Error("This bracket supports exactly two pools and two qualifiers per pool.");
  const ids = config.registrations.map((team) => team.id);
  const seeds = config.registrations.map((team) => team.seed);
  if (new Set(ids).size !== ids.length || new Set(seeds).size !== seeds.length) throw new Error("duplicate registration");
  const registrations = clone(config.registrations)
    .sort((left, right) => left.seed - right.seed)
    .map((team) => ({ ...team, status: "active" }));
  const pools = Array.from({ length: config.poolCount }, (_, index) => ({ id: `pool-${String.fromCharCode(65 + index)}`, teamIds: [] }));
  registrations.forEach((team, index) => {
    const cycle = Math.floor(index / config.poolCount);
    const offset = index % config.poolCount;
    pools[cycle % 2 === 0 ? offset : config.poolCount - 1 - offset].teamIds.push(team.id);
  });
  const matches = pools.flatMap((pool) => pool.teamIds.flatMap((homeTeamId, index) => pool.teamIds.slice(index + 1).map((awayTeamId) => ({
    id: `${pool.id}:${homeTeamId}:${awayTeamId}`,
    phase: "pool",
    poolId: pool.id,
    homeTeamId,
    awayTeamId,
    status: "scheduled",
    schedule: null,
  }))));
  matches.push(
    { id: "semi-1", phase: "elimination", stage: "semifinal", homeTeamId: null, awayTeamId: null, status: "waiting", schedule: null },
    { id: "semi-2", phase: "elimination", stage: "semifinal", homeTeamId: null, awayTeamId: null, status: "waiting", schedule: null },
    { id: "final", phase: "elimination", stage: "final", homeTeamId: null, awayTeamId: null, status: "waiting", schedule: null },
  );
  return recompute({ config: clone(config), registrations, pools, matches });
}

export function recordResult(input, result) {
  if (!Number.isInteger(result.homeScore) || result.homeScore < 0 || !Number.isInteger(result.awayScore) || result.awayScore < 0) throw new Error("invalid score");
  const state = clone(input);
  const match = state.matches.find((item) => item.id === result.matchId);
  if (!match || match.status === "cancelled" || match.status === "waiting") throw new Error("match cannot be finalized");
  Object.assign(match, { status: "final", homeScore: result.homeScore, awayScore: result.awayScore });
  return recompute(state);
}

export function withdrawTeam(input, event) {
  const state = clone(input);
  const team = state.registrations.find((item) => item.id === event.teamId);
  if (!team) throw new Error("unknown team");
  team.status = "withdrawn";
  return recompute(state);
}

export function rescheduleMatch(input, event) {
  const state = clone(input);
  const match = state.matches.find((item) => item.id === event.matchId);
  if (!match || match.status !== "scheduled") throw new Error("unplayed scheduled match required");
  const others = state.matches.filter((item) => item.id !== match.id && item.status === "scheduled" && item.schedule);
  const schedule = { venueId: event.venueId, court: event.court, start: new Date(event.start).toISOString() };
  if (!validSlot(state, match, schedule, others)) throw new Error("infeasible reschedule");
  match.schedule = schedule;
  return recompute(state);
}
