import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  gradeReservationCapacityWorkspace,
  materializeReservationCapacityFixture,
  reservationCapacityCase,
  reservationCapacityVerifierSourceDigest,
  RESERVATION_CAPACITY_CASE_ID,
} from "../src/project-cases/reservation-capacity-case.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const behaviorCheckNames = [
  "workspace:reservation-availability",
  "workspace:reservation-expiring-holds",
  "workspace:reservation-idempotent-confirmation",
  "workspace:reservation-concurrent-contention",
  "workspace:reservation-time-zone-schedules",
  "workspace:reservation-cancellation",
  "workspace:reservation-capacity-conservation",
  "workspace:reservation-restart-persistence",
] as const;

type BehaviorCheckName = typeof behaviorCheckNames[number];

async function freshWorkspace(label: string): Promise<{ workspaceDirectory: string; seededCommit: string; seededTree: string }> {
  const root = await mkdtemp(join(tmpdir(), `relayer-reservation-${label}-`));
  temporaryDirectories.push(root);
  const workspaceDirectory = join(root, "workspace");
  const fixture = await materializeReservationCapacityFixture({
    caseId: RESERVATION_CAPACITY_CASE_ID,
    workspaceDirectory,
    platform: "darwin",
  });
  return { workspaceDirectory, seededCommit: fixture.seededCommit, seededTree: fixture.seededTree };
}

async function installCandidate(label: string, source: string) {
  const workspace = await freshWorkspace(label);
  await writeFile(join(workspace.workspaceDirectory, "src/index.js"), source, "utf8");
  await writeFile(
    join(workspace.workspaceDirectory, "index.html"),
    `<!doctype html><html lang="en"><title>Reservation console</title><main><h1>Reservation console</h1><form id="reservation"><label>Resource <input name="resource"></label><label>Start <input name="start" type="datetime-local"></label><label>End <input name="end" type="datetime-local"></label><label>Quantity <input name="quantity" type="number" min="1"></label><button type="button">Availability</button><button type="button">Hold</button><button type="button">Confirm</button><button type="button">Cancel</button></form><section id="status" role="status" aria-live="polite">Ready.</section><script>document.querySelectorAll("button").forEach((button) => button.addEventListener("click", () => { document.querySelector("#status").textContent = button.textContent + " requested"; }));</script></main></html>\n`,
    "utf8",
  );
  await writeFile(
    join(workspace.workspaceDirectory, "test/contract.test.js"),
    `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { openReservationService } from "../src/index.js";\n\ntest("exposes the documented black-box reservation factory", () => {\n  assert.equal(typeof openReservationService, "function");\n});\n`,
    "utf8",
  );
  await execFileAsync("git", ["add", "--all"], { cwd: workspace.workspaceDirectory });
  await execFileAsync("git", ["commit", "--quiet", "-m", `Implement ${label}`], { cwd: workspace.workspaceDirectory });
  return workspace;
}

async function gradeCandidate(label: string, source: string) {
  const workspace = await installCandidate(label, source);
  const checks = await gradeReservationCapacityWorkspace({
    caseId: RESERVATION_CAPACITY_CASE_ID,
    workspaceDirectory: workspace.workspaceDirectory,
    baseRevision: workspace.seededCommit,
  });
  return { ...workspace, checks };
}

function checkMap(checks: Awaited<ReturnType<typeof gradeReservationCapacityWorkspace>>) {
  return new Map(checks.map((check) => [check.name, check]));
}

const snapshotStateSolution = String.raw`
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const weekdays = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const clone = (value) => structuredClone(value);
const overlaps = (a, b) => Date.parse(a.start) < Date.parse(b.end) && Date.parse(b.start) < Date.parse(a.end);
const positiveInteger = (value, label) => { if (!Number.isInteger(value) || value <= 0) throw new Error(label); };
const maximumConcurrent = (allocations, request) => {
  const points = allocations.filter((allocation) => overlaps(allocation, request)).flatMap((allocation) => [
    { at: Math.max(Date.parse(allocation.start), Date.parse(request.start)), change: allocation.quantity },
    { at: Math.min(Date.parse(allocation.end), Date.parse(request.end)), change: -allocation.quantity },
  ]).sort((left, right) => left.at - right.at || left.change - right.change);
  let current = 0, maximum = 0;
  for (const point of points) { current += point.change; maximum = Math.max(maximum, current); }
  return maximum;
};

function localParts(instant, timeZone) {
  const date = new Date(instant);
  if (!Number.isFinite(date.valueOf())) throw new Error("invalid instant");
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date).filter(({ type }) => type !== "literal").map(({ type, value }) => [type, value]));
  return { date: values.year + "-" + values.month + "-" + values.day, weekday: weekdays[values.weekday], minute: Number(values.hour) * 60 + Number(values.minute) };
}

function inSchedule(resource, start, end) {
  const left = localParts(start, resource.timeZone), right = localParts(end, resource.timeZone);
  if (Date.parse(end) <= Date.parse(start) || left.date !== right.date) return false;
  return resource.weeklySchedule.some((window) => {
    const minutes = (value) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
    return window.weekday === left.weekday && left.minute >= minutes(window.start) && right.minute <= minutes(window.end);
  });
}

export async function openReservationService({ storagePath, now }) {
  let state = { resources: {}, holds: {}, reservations: {}, holdKeys: {}, confirmKeys: {}, cancelKeys: {}, sequence: 0 };
  try { state = { ...state, ...JSON.parse(await readFile(storagePath, "utf8")) }; } catch (error) { if (error.code !== "ENOENT") throw error; }
  let tail = Promise.resolve();
  const persist = async () => {
    await mkdir(dirname(storagePath), { recursive: true });
    const temporary = storagePath + ".tmp";
    await writeFile(temporary, JSON.stringify(state), "utf8");
    await rename(temporary, storagePath);
  };
  const locked = (operation) => {
    const result = tail.then(operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
  const activeHold = (hold) => hold.status === "held" && now() < hold.createdAt + hold.ttlMs;
  const free = (resourceId, request) => {
    if (!Number.isFinite(Date.parse(request.start)) || Date.parse(request.end) <= Date.parse(request.start)) throw new Error("invalid interval");
    const resource = state.resources[resourceId];
    if (!resource || !inSchedule(resource, request.start, request.end)) return 0;
    const allocations = [
      ...Object.values(state.holds).filter((hold) => hold.resourceId === resourceId && activeHold(hold)),
      ...Object.values(state.reservations).filter((reservation) => reservation.resourceId === resourceId && !reservation.cancelled),
    ];
    return Math.max(0, resource.capacity - maximumConcurrent(allocations, request));
  };
  return {
    upsertResource(input) { return locked(async () => {
      positiveInteger(input.capacity, "invalid capacity");
      new Intl.DateTimeFormat("en-US", { timeZone: input.timeZone }).format(0);
      if (!Array.isArray(input.weeklySchedule)) throw new Error("invalid schedule");
      state.resources[input.resourceId] = clone(input); await persist();
    }); },
    availability(request) { return locked(async () => ({ available: free(request.resourceId, request) })); },
    placeHold(input) { return locked(async () => {
      if (state.holdKeys[input.idempotencyKey]) return clone(state.holdKeys[input.idempotencyKey]);
      positiveInteger(input.quantity, "invalid quantity"); positiveInteger(input.ttlMs, "invalid ttl");
      if (Date.parse(input.end) <= Date.parse(input.start)) throw new Error("invalid interval");
      if (free(input.resourceId, input) < input.quantity) {
        const unavailable = { status: "unavailable" }; state.holdKeys[input.idempotencyKey] = unavailable; await persist(); return clone(unavailable);
      }
      const holdId = "hold-" + (++state.sequence);
      state.holds[holdId] = { ...clone(input), holdId, createdAt: now(), status: "held" };
      const result = { status: "held", holdId }; state.holdKeys[input.idempotencyKey] = result; await persist(); return clone(result);
    }); },
    confirm(input) { return locked(async () => {
      if (state.confirmKeys[input.idempotencyKey]) return clone(state.confirmKeys[input.idempotencyKey]);
      const hold = state.holds[input.holdId];
      if (!hold || (!activeHold(hold) && hold.status !== "confirmed")) {
        const expired = { status: "expired" }; state.confirmKeys[input.idempotencyKey] = expired; await persist(); return clone(expired);
      }
      if (!hold.reservationId) {
        hold.status = "confirmed"; hold.reservationId = "reservation-" + (++state.sequence);
        state.reservations[hold.reservationId] = { reservationId: hold.reservationId, resourceId: hold.resourceId, start: hold.start, end: hold.end, quantity: hold.quantity, cancelled: false };
      }
      const result = { status: "confirmed", reservationId: hold.reservationId }; state.confirmKeys[input.idempotencyKey] = result; await persist(); return clone(result);
    }); },
    cancel(input) { return locked(async () => {
      if (state.cancelKeys[input.idempotencyKey]) return clone(state.cancelKeys[input.idempotencyKey]);
      const reservation = state.reservations[input.reservationId]; if (reservation) reservation.cancelled = true;
      const result = { status: "cancelled" }; state.cancelKeys[input.idempotencyKey] = result; await persist(); return clone(result);
    }); },
    close() { return tail; },
  };
}
`;

const eventLedgerSolution = String.raw`
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const dayNumber = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const intersects = (left, right) => Date.parse(left.start) < Date.parse(right.end) && Date.parse(right.start) < Date.parse(left.end);
const assertCount = (value) => { if (!Number.isInteger(value) || value < 1) throw new Error("positive integer required"); };
const copy = (value) => structuredClone(value);
const peakUsage = (allocations, request) => {
  const changes = allocations.filter((allocation) => intersects(allocation, request)).flatMap((allocation) => [
    [Math.max(Date.parse(allocation.start), Date.parse(request.start)), allocation.quantity],
    [Math.min(Date.parse(allocation.end), Date.parse(request.end)), -allocation.quantity],
  ]).sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  let active = 0, peak = 0;
  for (const [, change] of changes) { active += change; peak = Math.max(peak, active); }
  return peak;
};

function wallClock(instant, zone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(instant)).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return { key: parts.year + parts.month + parts.day, day: dayNumber[parts.weekday], minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

function scheduled(resource, start, end) {
  if (!Number.isFinite(Date.parse(start)) || Date.parse(end) <= Date.parse(start)) throw new Error("invalid interval");
  const first = wallClock(start, resource.timeZone), last = wallClock(end, resource.timeZone);
  const minute = (text) => Number(text.slice(0, 2)) * 60 + Number(text.slice(3));
  return first.key === last.key && resource.weeklySchedule.some((window) => window.weekday === first.day && first.minute >= minute(window.start) && last.minute <= minute(window.end));
}

export async function openReservationService({ storagePath, now }) {
  let events = [];
  try { events = JSON.parse(await readFile(storagePath, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  let serial = Promise.resolve();
  const transact = (operation) => { const answer = serial.then(operation); serial = answer.then(() => undefined, () => undefined); return answer; };
  const append = async (event) => { events.push(copy(event)); await mkdir(dirname(storagePath), { recursive: true }); await writeFile(storagePath, JSON.stringify(events), "utf8"); };
  const project = () => {
    const view = { resources: new Map(), holds: new Map(), reservations: new Map(), holdKeys: new Map(), confirmKeys: new Map(), cancelKeys: new Map() };
    for (const event of events) {
      if (event.type === "resource") view.resources.set(event.value.resourceId, copy(event.value));
      if (event.type === "hold") { view.holds.set(event.hold.holdId, copy(event.hold)); view.holdKeys.set(event.key, { status: "held", holdId: event.hold.holdId }); }
      if (event.type === "unavailable") view.holdKeys.set(event.key, { status: "unavailable" });
      if (event.type === "confirmed") { const hold = view.holds.get(event.holdId); hold.reservationId = event.reservation.reservationId; view.reservations.set(event.reservation.reservationId, copy(event.reservation)); view.confirmKeys.set(event.key, { status: "confirmed", reservationId: event.reservation.reservationId }); }
      if (event.type === "expired") view.confirmKeys.set(event.key, { status: "expired" });
      if (event.type === "cancelled") { const reservation = view.reservations.get(event.reservationId); if (reservation) reservation.cancelled = true; view.cancelKeys.set(event.key, { status: "cancelled" }); }
    }
    return view;
  };
  const remaining = (view, resourceId, request) => {
    const resource = view.resources.get(resourceId); if (!resource || !scheduled(resource, request.start, request.end)) return 0;
    const allocations = [
      ...[...view.holds.values()].filter((hold) => hold.resourceId === resourceId && !hold.reservationId && now() < hold.createdAt + hold.ttlMs),
      ...[...view.reservations.values()].filter((reservation) => reservation.resourceId === resourceId && !reservation.cancelled),
    ];
    return Math.max(0, resource.capacity - peakUsage(allocations, request));
  };
  return {
    upsertResource(value) { return transact(async () => { assertCount(value.capacity); new Intl.DateTimeFormat("en-US", { timeZone: value.timeZone }).format(0); await append({ type: "resource", value }); }); },
    availability(request) { return transact(async () => ({ available: remaining(project(), request.resourceId, request) })); },
    placeHold(input) { return transact(async () => {
      const view = project(); if (view.holdKeys.has(input.idempotencyKey)) return copy(view.holdKeys.get(input.idempotencyKey));
      assertCount(input.quantity); assertCount(input.ttlMs); const resource = view.resources.get(input.resourceId); if (!resource || !scheduled(resource, input.start, input.end) || remaining(view, input.resourceId, input) < input.quantity) { const result = { status: "unavailable" }; await append({ type: "unavailable", key: input.idempotencyKey }); return result; }
      const hold = { ...copy(input), holdId: "h-" + (events.length + 1), createdAt: now() }; await append({ type: "hold", key: input.idempotencyKey, hold }); return { status: "held", holdId: hold.holdId };
    }); },
    confirm(input) { return transact(async () => {
      const view = project(); if (view.confirmKeys.has(input.idempotencyKey)) return copy(view.confirmKeys.get(input.idempotencyKey));
      const hold = view.holds.get(input.holdId); if (!hold || (now() >= hold.createdAt + hold.ttlMs && !hold.reservationId)) { await append({ type: "expired", key: input.idempotencyKey }); return { status: "expired" }; }
      if (hold.reservationId) { const result = { status: "confirmed", reservationId: hold.reservationId }; await append({ type: "confirmed", key: input.idempotencyKey, holdId: hold.holdId, reservation: view.reservations.get(hold.reservationId) }); return result; }
      const reservation = { reservationId: "r-" + (events.length + 1), resourceId: hold.resourceId, start: hold.start, end: hold.end, quantity: hold.quantity, cancelled: false };
      await append({ type: "confirmed", key: input.idempotencyKey, holdId: hold.holdId, reservation }); return { status: "confirmed", reservationId: reservation.reservationId };
    }); },
    cancel(input) { return transact(async () => { const view = project(); if (view.cancelKeys.has(input.idempotencyKey)) return copy(view.cancelKeys.get(input.idempotencyKey)); await append({ type: "cancelled", key: input.idempotencyKey, reservationId: input.reservationId }); return { status: "cancelled" }; }); },
    close() { return serial; },
  };
}
`;

const mutants: Readonly<Record<BehaviorCheckName, string>> = {
  "workspace:reservation-availability": snapshotStateSolution.replace(
    "if (!resource || !inSchedule(resource, request.start, request.end)) return 0;",
    "if (!resource) return 0;",
  ),
  "workspace:reservation-expiring-holds": snapshotStateSolution.replace(
    "const activeHold = (hold) => hold.status === \"held\" && now() < hold.createdAt + hold.ttlMs;",
    "const activeHold = (hold) => hold.status === \"held\";",
  ),
  "workspace:reservation-idempotent-confirmation": snapshotStateSolution.replace(
    "if (!hold.reservationId) {",
    "hold.reservationId = undefined; if (!hold.reservationId) {",
  ),
  "workspace:reservation-concurrent-contention": snapshotStateSolution.replace(
    "if (free(input.resourceId, input) < input.quantity) {",
    "if (free(input.resourceId, input) < input.quantity && !input.idempotencyKey.startsWith(\"race-\")) {",
  ),
  "workspace:reservation-time-zone-schedules": snapshotStateSolution.replace(
    "const date = new Date(instant);",
    "const source = new Date(instant); const offsets = { \"America/New_York\": -5, \"America/Los_Angeles\": -8 }; const date = new Date(source.valueOf() + (offsets[timeZone] ?? 0) * 3600000); timeZone = \"UTC\";",
  ),
  "workspace:reservation-cancellation": snapshotStateSolution.replace(
    "&& !reservation.cancelled)",
    ")",
  ),
  "workspace:reservation-capacity-conservation": snapshotStateSolution.replace(
    "change: allocation.quantity",
    "change: 1",
  ),
  "workspace:reservation-restart-persistence": snapshotStateSolution.replace(
    "try { state = { ...state, ...JSON.parse(await readFile(storagePath, \"utf8\")) }; } catch (error) { if (error.code !== \"ENOENT\") throw error; }",
    "try { await readFile(storagePath, \"utf8\"); } catch (error) { if (error.code !== \"ENOENT\") throw error; }",
  ),
};

describe("reservation capacity case identity and materialization", () => {
  it("publishes an immutable candidate snapshot with sealed paths removed from the public catalog", () => {
    expect(reservationCapacityCase.snapshot).toMatchObject({
      id: RESERVATION_CAPACITY_CASE_ID,
      authoringStatus: "candidate",
      category: "coding",
      taskType: "greenfield-build",
      artifacts: {
        workspace: { kind: "frozen-workspace", materializerId: "reservation-capacity-template-v1" },
        verifier: { verifierId: "reservation-capacity-public-seam-v1" },
      },
    });
    expect(reservationCapacityCase.snapshot.artifacts.verifier.mandatoryGates.map(({ id }) => id)).toEqual([
      "reservation-availability",
      "reservation-expiring-holds",
      "reservation-idempotent-confirmation",
      "reservation-concurrent-contention",
      "reservation-time-zone-schedules",
      "reservation-cancellation",
      "reservation-capacity-conservation",
      "reservation-restart-persistence",
      "reservation-durable-delivery",
    ]);
    expect(reservationCapacityCase.snapshotDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.isFrozen(reservationCapacityCase)).toBe(true);
    expect(Object.isFrozen(reservationCapacityCase.snapshot)).toBe(true);
    expect(JSON.stringify(reservationCapacityCase.catalogSnapshot)).not.toContain("sealedPath");
    expect(JSON.stringify(reservationCapacityCase.catalogSnapshot)).not.toContain("reservation-capacity-case.test.ts");
    expect(reservationCapacityCase.catalogSnapshot.artifacts.verifier.contentDigest).toBe(reservationCapacityCase.snapshot.artifacts.verifier.contentDigest);
  });

  it("binds the sealed reference digest to the complete admission portfolio bytes", async () => {
    const bytes = await readFile(new URL(import.meta.url));
    expect(reservationCapacityCase.snapshot.artifacts.reference.contentDigest).toBe(
      `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    );
  });

  it("fails closed when the exact v1 verifier implementation drifts", async () => {
    const source = await readFile(new URL("../src/project-cases/reservation-capacity-case.ts", import.meta.url), "utf8");
    expect(reservationCapacityCase.snapshot.artifacts.verifier.contentDigest).toBe(
      reservationCapacityVerifierSourceDigest(source),
    );
  });

  it("materializes byte-identical pristine repositories and refuses to overwrite either one", async () => {
    const first = await freshWorkspace("pristine-a");
    const second = await freshWorkspace("pristine-b");
    expect(first.seededTree).toBe(second.seededTree);
    expect(reservationCapacityCase.snapshot.artifacts.workspace.revision).toBe(`git-tree:${first.seededTree}`);
    expect(await readFile(join(first.workspaceDirectory, "src/index.js"), "utf8")).toBe(await readFile(join(second.workspaceDirectory, "src/index.js"), "utf8"));
    await expect(materializeReservationCapacityFixture({
      caseId: RESERVATION_CAPACITY_CASE_ID,
      workspaceDirectory: first.workspaceDirectory,
      platform: "darwin",
    })).rejects.toThrow("Refusing to overwrite");
    const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: second.workspaceDirectory });
    expect(stdout).toBe("");
  });

  it("fails closed before materialization when the runtime Node major is not 22", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-reservation-node-major-"));
    temporaryDirectories.push(root);
    const workspaceDirectory = join(root, "workspace");
    await expect(materializeReservationCapacityFixture({
      caseId: RESERVATION_CAPACITY_CASE_ID,
      workspaceDirectory,
      platform: "darwin",
      runtimeNodeVersion: "20.19.0",
    })).rejects.toThrow("requires Node 22");
    await expect(access(workspaceDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("reservation capacity verifier admission", () => {
  it("keeps the untouched fixture red for every behavior and durable-delivery predicate", async () => {
    const workspace = await freshWorkspace("red-baseline");
    const checks = await gradeReservationCapacityWorkspace({
      caseId: RESERVATION_CAPACITY_CASE_ID,
      workspaceDirectory: workspace.workspaceDirectory,
      baseRevision: workspace.seededCommit,
    });
    const byName = checkMap(checks);
    for (const name of behaviorCheckNames) expect(byName.get(name), name).toMatchObject({ passed: false });
    expect(byName.get("workspace:reservation-delivery-commit")).toMatchObject({ passed: false });
    expect(byName.get("workspace:reservation-required-artifacts")).toMatchObject({ passed: false });
    expect(byName.get("workspace:reservation-ui-contract")).toMatchObject({ passed: false });
    expect(byName.get("workspace:reservation-project-tests")).toMatchObject({ passed: false });
    expect(checks).toHaveLength(13);
  }, 20_000);

  it.each([
    ["snapshot-state", snapshotStateSolution],
    ["event-ledger", eventLedgerSolution],
  ])("accepts the materially different %s implementation through only the public seam", async (label, source) => {
    const { checks } = await gradeCandidate(label, source);
    expect(checks, JSON.stringify(checks, null, 2)).toHaveLength(13);
    expect(checks.every(({ passed }) => passed), JSON.stringify(checks, null, 2)).toBe(true);
  }, 20_000);

  it.each(Object.entries(mutants))("rejects the targeted %s mutant while preserving independent receipts", async (target, source) => {
    expect(source, `${target} mutation must change the candidate`).not.toBe(snapshotStateSolution);
    const { checks } = await gradeCandidate(`mutant-${target}`, source);
    const byName = checkMap(checks);
    expect(checks).toHaveLength(13);
    expect(byName.get(target), JSON.stringify(checks, null, 2)).toMatchObject({ passed: false });
    for (const name of behaviorCheckNames) expect(byName.has(name), name).toBe(true);
    expect(byName.get("workspace:reservation-required-artifacts")).toMatchObject({ passed: true });
    expect(byName.get("workspace:reservation-ui-contract")).toMatchObject({ passed: true });
    expect(byName.get("workspace:reservation-project-tests")).toMatchObject({ passed: true });
    expect(byName.get("workspace:reservation-delivery-commit")).toMatchObject({ passed: true });
    expect(byName.get("workspace:reservation-delivery-clean")).toMatchObject({ passed: true });
  }, 20_000);

  it("keeps receipts evaluator-owned when candidate code tampers with stdout", async () => {
    const source = `
const originalWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  const text = String(chunk).replace(/\\"passed\\":false/g, '\"passed\":true');
  return originalWrite(text, ...rest);
};
export async function openReservationService() { throw new Error("deliberately broken"); }
`;
    const { checks } = await gradeCandidate("receipt-tamper", source);
    for (const name of behaviorCheckNames) expect(checkMap(checks).get(name), name).toMatchObject({ passed: false });
  }, 20_000);

  it("rejects generic buttons and dead script as the browser lifecycle scaffold", async () => {
    const workspace = await installCandidate("ui-false-positive", snapshotStateSolution);
    await writeFile(join(workspace.workspaceDirectory, "index.html"), `<!doctype html><form>
      <label>Resource<input name="resource"></label><label>Start<input name="start"></label>
      <label>End<input name="end"></label><label>Quantity<input name="quantity"></label>
      <button>Availability</button><button>Hold</button><button>Confirm</button><button>Cancel</button>
      <output role="status"></output><script src="missing.js"></script></form>`, "utf8");
    const checks = await gradeReservationCapacityWorkspace({
      caseId: RESERVATION_CAPACITY_CASE_ID,
      workspaceDirectory: workspace.workspaceDirectory,
      baseRevision: workspace.seededCommit,
    });
    expect(checkMap(checks).get("workspace:reservation-ui-contract")).toMatchObject({ passed: false });
  }, 20_000);

  it("records subcheckpoints independently after an earlier checkpoint fails", async () => {
    const { checks } = await gradeCandidate("independent-checkpoints", mutants["workspace:reservation-availability"]);
    const check = checkMap(checks).get("workspace:reservation-availability");
    expect(check).toMatchObject({ passed: false });
    const evidence = JSON.parse(check?.detail ?? "") as { checkpoints: Array<{ id: string; passed: boolean }> };
    expect(evidence.checkpoints).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "capacity-matrix", passed: false }),
      expect.objectContaining({ id: "capacity-validation", passed: true }),
      expect.objectContaining({ id: "interval-validation", passed: true }),
    ]));
  }, 20_000);

  it("denies candidate discovery of evaluator-owned sealed source", async () => {
    const sealedPath = join(repositoryRoot, "packages/eval-runner/src/project-cases/reservation-capacity-case.ts");
    const source = `
import { readFileSync } from "node:fs";
export async function openReservationService() {
  try { readFileSync(${JSON.stringify(sealedPath)}, "utf8"); }
  catch (error) { throw new Error("sealed-source-denied:" + error.code + ":pwd=" + process.env.PWD); }
  throw new Error("sealed-source-leaked");
}
`;
    const { checks, workspaceDirectory } = await gradeCandidate("sealed-discovery", source);
    const availability = checkMap(checks).get("workspace:reservation-availability");
    expect(availability).toMatchObject({ passed: false });
    expect(availability?.detail).toContain("sealed-source-denied:EPERM");
    expect(availability?.detail).toContain(`pwd=${await realpath(workspaceDirectory)}`);
    expect(availability?.detail).not.toContain(`pwd=${repositoryRoot}`);
  }, 20_000);
});
