import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { bindAutonomousCaseSnapshot } from "../cases/catalog.js";
import { createAutonomousCaseSnapshot } from "../cases/contracts.js";
import type { EvalCheck } from "../runtime-basic.js";
import type { CommandResult, CommandRunner, ProjectEvalThreadDefinition } from "./h3.js";

export const RESERVATION_CAPACITY_CASE_ID = "capability.greenfield.reservation-capacity";

export type ReservationCapacityCaseId = typeof RESERVATION_CAPACITY_CASE_ID;

const visibleTask = `Build a local reservation and capacity product for appointment-style resources. Deliver a browser control-surface scaffold in \`index.html\`, the production module in \`src/index.js\`, and add focused coverage in \`test/contract.test.js\`; keep \`package.json\` so the project runs with Node 22 and no install or network step. Commit the completed project and leave the workspace clean. Do not push or publish anything.

The black-box production seam is \`await openReservationService({ storagePath, now })\`, exported from \`src/index.js\`. \`storagePath\` is an evaluator-provided path for durable local state and \`now\` is a zero-argument clock returning epoch milliseconds. The returned service must expose asynchronous (or awaitable) \`upsertResource\`, \`availability\`, \`placeHold\`, \`confirm\`, \`cancel\`, and \`close\` methods. Internal architecture, storage format, and UI design are yours.

- \`upsertResource({ resourceId, capacity, timeZone, weeklySchedule })\` stores a resource. Capacity is a positive integer. \`weeklySchedule\` is an array of local-time windows \`{ weekday, start, end }\`, where weekday is ISO 1=Monday through 7=Sunday and times are 24-hour \`HH:MM\`. Requested intervals are half-open RFC 3339 instants and must fit wholly inside one local schedule window.
- \`availability({ resourceId, start, end })\` returns an object with integer \`available\`, the capacity still free for that entire interval. Outside schedule it returns zero. Active overlapping holds and confirmed reservations consume quantity; expired holds and cancelled reservations do not.
- \`placeHold({ idempotencyKey, resourceId, start, end, quantity, ttlMs })\` atomically returns \`{ status: "held", holdId }\` or \`{ status: "unavailable" }\`. A hold expires when \`now() >= createdAt + ttlMs\`. Concurrent calls may never overbook.
- \`confirm({ idempotencyKey, holdId })\` returns \`{ status: "confirmed", reservationId }\` for a live hold or \`{ status: "expired" }\`. Retrying the same confirmation, including after restart, returns the same result and does not consume capacity twice.
- \`cancel({ idempotencyKey, reservationId })\` releases a confirmed reservation and returns \`{ status: "cancelled" }\`. Retrying the same cancellation is safe.

All resource configuration, holds, confirmations, cancellations, and idempotency results must survive closing and reopening the service on the same \`storagePath\`. Handle daylight-saving time through the named IANA time zone, conserve capacity across overlapping intervals, and validate bad quantities and intervals without corrupting state. The browser scaffold must include a form with labeled resource, start, end, and quantity controls; availability, hold, confirm, and cancel actions; a live status region; and client-side script that wires those visible actions to status feedback. Full interface usability remains part of delivery quality rather than changing the black-box service seam.`;

const starterFiles: Readonly<Record<string, string>> = Object.freeze({
  "README.md": `# Reservation and Capacity Product\n\n${visibleTask}\n`,
  "package.json": `${JSON.stringify({
    name: "reservation-capacity-product",
    private: true,
    type: "module",
    scripts: { test: "node --test" },
  }, null, 2)}\n`,
  "src/index.js": `export async function openReservationService() {
  throw new Error("The reservation service has not been implemented yet.");
}
`,
  "test/contract.test.js": `import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openReservationService } from "../src/index.js";

test("reports configured capacity through the production seam", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reservation-contract-"));
  try {
    const service = await openReservationService({ storagePath: join(directory, "state.json"), now: () => Date.parse("2026-01-05T14:00:00Z") });
    await service.upsertResource({ resourceId: "room", capacity: 2, timeZone: "America/New_York", weeklySchedule: [{ weekday: 1, start: "09:00", end: "17:00" }] });
    assert.equal((await service.availability({ resourceId: "room", start: "2026-01-05T14:15:00Z", end: "2026-01-05T14:45:00Z" })).available, 2);
    await service.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
`,
  "index.html": `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Reservations</title></head>
<body><main><h1>Reservation workspace</h1><p>Replace this starter with the usable reservation interface described in README.md.</p></main></body></html>
`,
});

const predicateIds = Object.freeze([
  "availability",
  "expiring-holds",
  "idempotent-confirmation",
  "concurrent-contention",
  "time-zone-schedules",
  "cancellation",
  "capacity-conservation",
  "restart-persistence",
] as const);

type ReservationPredicateId = typeof predicateIds[number];

export const reservationCapacityGateCheckPatterns: Readonly<Record<string, readonly string[]>> = Object.freeze({
  ...Object.fromEntries(predicateIds.map((id) => [`reservation-${id}`, Object.freeze([`reservation-${id}`])])),
  "reservation-durable-delivery": Object.freeze([
    "reservation-required-artifacts",
    "reservation-ui-contract",
    "reservation-project-tests",
    "reservation-delivery-commit",
    "reservation-delivery-clean",
  ]),
});

const candidateHostProgram = String.raw`
import { createInterface } from "node:readline";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Capture the transport before loading untrusted candidate code. Candidate writes may
// corrupt its own API response, but cannot rewrite the evaluator-owned receipt.
const transportWrite = process.stdout.write.bind(process.stdout);
const send = (message) => transportWrite(JSON.stringify(message) + "\n");
let service;
let currentNow = 0;
const methods = new Set(["upsertResource", "availability", "placeHold", "confirm", "cancel", "close"]);
send({ kind: "ready" });
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  void (async () => {
    let request;
    try {
      request = JSON.parse(line);
      if (request.op === "open") {
        currentNow = request.now;
        const candidate = await import(pathToFileURL(join(process.cwd(), "src/index.js")).href + "?host=" + Date.now());
        if (typeof candidate.openReservationService !== "function") throw new Error("src/index.js must export openReservationService");
        service = await candidate.openReservationService({ storagePath: request.storagePath, now: () => currentNow });
        for (const method of methods) if (typeof service?.[method] !== "function") throw new Error("service must expose " + method);
        send({ id: request.id, ok: true, value: null });
        return;
      }
      if (request.op === "setNow") {
        currentNow = request.now;
        send({ id: request.id, ok: true, value: null });
        return;
      }
      if (request.op !== "call" || !methods.has(request.method) || !service) throw new Error("Invalid candidate host request");
      const value = await service[request.method](...(request.args || []));
      send({ id: request.id, ok: true, value });
    } catch (error) {
      send({ id: request?.id, ok: false, error: String(error?.stack || error) });
    }
  })();
});
`;

const verifierProgram = String.raw`
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
const candidateHostProgram = ${JSON.stringify(candidateHostProgram)};

const schedule = [{ weekday: 1, start: "09:00", end: "17:00" }];
const instant = (value) => Date.parse(value);
const interval = { start: "2026-01-05T14:15:00Z", end: "2026-01-05T14:45:00Z" };

async function startCandidateHost(storagePath, now) {
  const hostDirectory = await mkdtemp(join(tmpdir(), "relayer-reservation-host-"));
  const canonicalHostDirectory = await realpath(hostDirectory);
  const hostPath = join(canonicalHostDirectory, "host.mjs");
  await writeFile(hostPath, candidateHostProgram, { encoding: "utf8", mode: 0o600 });
  const quote = (value) => JSON.stringify(value);
  const candidateDirectory = await realpath(process.cwd());
  const storageDirectory = await realpath(dirname(storagePath));
  const nodeInstallation = await realpath(dirname(dirname(process.execPath)));
  const sandboxProfile = [
    '(version 1)',
    '(import "system.sb")',
    '(deny default)',
    '(deny network*)',
    '(allow process*)',
    '(allow file-read-metadata)',
    '(allow file-read* (subpath ' + quote(candidateDirectory) + ') (subpath ' + quote(canonicalHostDirectory) + ') (subpath ' + quote(storageDirectory) + ') (subpath ' + quote(nodeInstallation) + '))',
    '(allow file-write* (subpath ' + quote(canonicalHostDirectory) + ') (subpath ' + quote(storageDirectory) + '))',
  ].join("\n");
  const childEnvironment = {
    LANG: "en_US.UTF-8",
    PATH: join(nodeInstallation, "bin"),
    PWD: candidateDirectory,
    TMPDIR: canonicalHostDirectory,
  };
  const child = spawn("/usr/bin/sandbox-exec", ["-p", sandboxProfile, process.execPath, hostPath], {
    cwd: candidateDirectory, env: childEnvironment, stdio: ["pipe", "pipe", "pipe"],
  });
  let nextId = 1; let stderr = ""; let ready = false; let terminalError;
  const pending = new Map();
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2000); });
  const rejectAll = (error) => { terminalError = error; for (const item of pending.values()) item.reject(error); pending.clear(); };
  child.once("error", rejectAll);
  child.once("close", (code, signal) => rejectAll(new Error("Candidate host stopped (" + String(code ?? signal) + "): " + stderr)));
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { rejectAll(new Error("Candidate host emitted non-protocol output")); child.kill("SIGKILL"); return; }
    if (message.kind === "ready" && !ready) { ready = true; return; }
    const item = pending.get(message.id);
    if (!item) { rejectAll(new Error("Candidate host emitted an unsolicited response")); child.kill("SIGKILL"); return; }
    pending.delete(message.id);
    if (message.ok === true) item.resolve(message.value); else item.reject(new Error(String(message.error || "Candidate operation failed")));
  });
  const waitReady = async () => {
    const deadline = Date.now() + 2_000;
    while (!ready && !terminalError && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    if (!ready) throw terminalError || new Error("Candidate host did not become ready");
  };
  await waitReady();
  await unlink(hostPath).catch(() => {});
  const request = (payload) => new Promise((resolve, reject) => {
    if (terminalError) { reject(terminalError); return; }
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("Candidate operation timed out")); child.kill("SIGKILL"); }, 5_000);
    pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    child.stdin.write(JSON.stringify({ id, ...payload }) + "\n");
  });
  try { await request({ op: "open", storagePath, now }); }
  catch (error) { child.kill("SIGKILL"); await rm(hostDirectory, { recursive: true, force: true }); throw error; }
  const proxy = Object.fromEntries([...new Set(["upsertResource", "availability", "placeHold", "confirm", "cancel"])].map((method) => [method, (...args) => request({ op: "call", method, args })]));
  proxy.close = async () => { try { await request({ op: "call", method: "close", args: [] }); } finally { child.stdin.end(); await rm(hostDirectory, { recursive: true, force: true }); } };
  return { service: proxy, setNow: (value) => request({ op: "setNow", now: value }), terminate: () => { child.kill("SIGKILL"); } };
}

async function isolated(run, initialNow = instant("2026-01-05T14:00:00Z")) {
  const directory = await mkdtemp(join(tmpdir(), "relayer-reservation-verifier-"));
  const storagePath = join(directory, "state.json");
  const hosts = [];
  let activeHost;
  const open = async (now = initialNow) => { activeHost = await startCandidateHost(storagePath, now); hosts.push(activeHost); return activeHost.service; };
  try { return await run({ open, storagePath, setNow: async (value) => { if (!activeHost) throw new Error("service is not open"); await activeHost.setNow(value); } }); }
  finally { for (const host of hosts) host.terminate(); await rm(directory, { recursive: true, force: true }); }
}

async function restartStage(stage, storagePath, now, state = {}) {
  const host = await startCandidateHost(storagePath, now);
  const service = host.service;
  let output = state;
  try {
    if (stage === 1) {
      await service.upsertResource({ resourceId: "room", capacity: 2, timeZone: "America/New_York", weeklySchedule: schedule });
      await service.upsertResource({ resourceId: "expiry-room", capacity: 1, timeZone: "America/New_York", weeklySchedule: schedule });
      const held = await service.placeHold({ idempotencyKey: "persist-hold", resourceId: "room", ...interval, quantity: 1, ttlMs: 300_000 });
      const confirmed = await service.confirm({ idempotencyKey: "persist-confirm", holdId: held.holdId });
      const pending = await service.placeHold({ idempotencyKey: "pending-hold", resourceId: "room", ...interval, quantity: 1, ttlMs: 60_000 });
      const unavailable = await service.placeHold({ idempotencyKey: "persist-unavailable", resourceId: "room", ...interval, quantity: 1, ttlMs: 60_000 });
      const expiring = await service.placeHold({ idempotencyKey: "expiry-hold", resourceId: "expiry-room", ...interval, quantity: 1, ttlMs: 60_000 });
      assert.equal(confirmed.status, "confirmed"); assert.equal(pending.status, "held"); assert.deepEqual(unavailable, { status: "unavailable" }); assert.equal(expiring.status, "held");
      output = { held, confirmed, pending, unavailable, expiring };
    } else if (stage === 2) {
      assert.equal((await service.availability({ resourceId: "room", ...interval })).available, 0);
      assert.deepEqual(await service.placeHold({ idempotencyKey: "pending-hold", resourceId: "room", ...interval, quantity: 1, ttlMs: 60_000 }), output.pending);
      assert.deepEqual(await service.placeHold({ idempotencyKey: "persist-unavailable", resourceId: "room", ...interval, quantity: 1, ttlMs: 60_000 }), output.unavailable);
      assert.deepEqual(await service.confirm({ idempotencyKey: "persist-confirm", holdId: output.held.holdId }), output.confirmed);
    } else if (stage === 3) {
      assert.equal((await service.availability({ resourceId: "room", ...interval })).available, 1);
      const expired = await service.confirm({ idempotencyKey: "persist-expired", holdId: output.expiring.holdId });
      assert.deepEqual(expired, { status: "expired" });
      const cancelled = await service.cancel({ idempotencyKey: "persist-cancel", reservationId: output.confirmed.reservationId });
      assert.deepEqual(cancelled, { status: "cancelled" }); output = { ...output, expired, cancelled };
    } else if (stage === 4) {
      assert.equal((await service.availability({ resourceId: "room", ...interval })).available, 2);
      assert.deepEqual(await service.confirm({ idempotencyKey: "persist-expired", holdId: output.expiring.holdId }), output.expired);
      assert.deepEqual(await service.cancel({ idempotencyKey: "persist-cancel", reservationId: output.confirmed.reservationId }), output.cancelled);
    } else throw new Error("Unknown restart stage");
    await service.close();
    return output;
  } finally { host.terminate(); }
}

async function runCheckpointSuite(entries) {
  const results = [];
  for (const entry of entries) {
    try { await entry.run(); results.push({ id: entry.id, passed: true, detail: "passed" }); }
    catch (error) { results.push({ id: entry.id, passed: false, detail: String(error?.stack || error) }); }
  }
  return results;
}

const predicates = {
  availability: () => runCheckpointSuite([
    { id: "capacity-matrix", run: () => isolated(async ({ open }) => {
      const service = await open();
      for (const capacity of [1, 2, 5]) {
        const resourceId = "room-" + capacity;
        await service.upsertResource({ resourceId, capacity, timeZone: "America/New_York", weeklySchedule: schedule });
        assert.equal((await service.availability({ resourceId, ...interval })).available, capacity);
        assert.equal((await service.availability({ resourceId, start: "2026-01-05T13:30:00Z", end: "2026-01-05T14:30:00Z" })).available, 0);
      }
      await service.close();
    }) },
    { id: "capacity-validation", run: () => isolated(async ({ open }) => {
      const service = await open();
      for (const capacity of [0, -1, 1.5, "2", null]) await assert.rejects(service.upsertResource({ resourceId: "invalid-" + String(capacity), capacity, timeZone: "America/New_York", weeklySchedule: schedule }));
      await service.close();
    }) },
    { id: "interval-validation", run: () => isolated(async ({ open }) => {
      const service = await open();
      await service.upsertResource({ resourceId: "room", capacity: 1, timeZone: "America/New_York", weeklySchedule: schedule });
      await assert.rejects(service.availability({ resourceId: "room", start: interval.end, end: interval.start }));
      await service.close();
    }) },
  ]),
  "expiring-holds": () => runCheckpointSuite([
    { id: "hold-consumes-before-expiry", run: () => isolated(async ({ open }) => { const service = await open(); await service.upsertResource({ resourceId: "room", capacity: 2, timeZone: "America/New_York", weeklySchedule: schedule }); const held = await service.placeHold({ idempotencyKey: "hold", resourceId: "room", ...interval, quantity: 2, ttlMs: 60_000 }); assert.equal(held.status, "held"); assert.equal((await service.availability({ resourceId: "room", ...interval })).available, 0); await service.close(); }) },
    { id: "capacity-restores-at-expiry-equality", run: () => isolated(async ({ open, setNow }) => { const service = await open(); await service.upsertResource({ resourceId: "room", capacity: 2, timeZone: "America/New_York", weeklySchedule: schedule }); await service.placeHold({ idempotencyKey: "hold", resourceId: "room", ...interval, quantity: 2, ttlMs: 60_000 }); await setNow(instant("2026-01-05T14:01:00Z")); assert.equal((await service.availability({ resourceId: "room", ...interval })).available, 2); await service.close(); }) },
    { id: "expired-hold-cannot-confirm", run: () => isolated(async ({ open, setNow }) => { const service = await open(); await service.upsertResource({ resourceId: "room", capacity: 1, timeZone: "America/New_York", weeklySchedule: schedule }); const held = await service.placeHold({ idempotencyKey: "hold", resourceId: "room", ...interval, quantity: 1, ttlMs: 60_000 }); await setNow(instant("2026-01-05T14:01:00Z")); assert.deepEqual(await service.confirm({ idempotencyKey: "confirm", holdId: held.holdId }), { status: "expired" }); await service.close(); }) },
  ]),
  "idempotent-confirmation": () => runCheckpointSuite([
    { id: "same-key-retry", run: () => isolated(async ({ open }) => { const service = await open(); await service.upsertResource({ resourceId: "room", capacity: 1, timeZone: "America/New_York", weeklySchedule: schedule }); const held = await service.placeHold({ idempotencyKey: "hold", resourceId: "room", ...interval, quantity: 1, ttlMs: 300_000 }); const first = await service.confirm({ idempotencyKey: "confirm", holdId: held.holdId }); assert.equal(first.status, "confirmed"); assert.deepEqual(await service.confirm({ idempotencyKey: "confirm", holdId: held.holdId }), first); await service.close(); }) },
    { id: "hold-has-one-reservation", run: () => isolated(async ({ open }) => { const service = await open(); await service.upsertResource({ resourceId: "room", capacity: 1, timeZone: "America/New_York", weeklySchedule: schedule }); const held = await service.placeHold({ idempotencyKey: "hold", resourceId: "room", ...interval, quantity: 1, ttlMs: 300_000 }); const first = await service.confirm({ idempotencyKey: "confirm-a", holdId: held.holdId }); const alternate = await service.confirm({ idempotencyKey: "confirm-b", holdId: held.holdId }); assert.equal(alternate.reservationId, first.reservationId); assert.equal((await service.availability({ resourceId: "room", ...interval })).available, 0); await service.close(); }) },
  ]),
  "concurrent-contention": () => runCheckpointSuite([
    { id: "atomic-winner-count", run: () => isolated(async ({ open }) => { const service = await open(); await service.upsertResource({ resourceId: "room", capacity: 2, timeZone: "America/New_York", weeklySchedule: schedule }); const attempts = await Promise.all(Array.from({ length: 5 }, (_, index) => service.placeHold({ idempotencyKey: "race-" + index, resourceId: "room", ...interval, quantity: 1, ttlMs: 300_000 }))); assert.equal(attempts.filter((item) => item.status === "held").length, 2); assert.equal(attempts.filter((item) => item.status === "unavailable").length, 3); assert.equal((await service.availability({ resourceId: "room", ...interval })).available, 0); await service.close(); }) },
    { id: "unreservable-boundaries", run: () => isolated(async ({ open }) => { const service = await open(); await service.upsertResource({ resourceId: "room", capacity: 2, timeZone: "America/New_York", weeklySchedule: schedule }); assert.deepEqual(await service.placeHold({ idempotencyKey: "outside", resourceId: "room", start: "2026-01-05T13:00:00Z", end: "2026-01-05T13:30:00Z", quantity: 1, ttlMs: 60_000 }), { status: "unavailable" }); assert.deepEqual(await service.placeHold({ idempotencyKey: "missing", resourceId: "missing", ...interval, quantity: 1, ttlMs: 60_000 }), { status: "unavailable" }); await service.close(); }) },
  ]),
  "time-zone-schedules": () => runCheckpointSuite([
    { id: "seasonal-zone-offsets", run: () => isolated(async ({ open }) => {
      const service = await open();
      await service.upsertResource({ resourceId: "new-york", capacity: 1, timeZone: "America/New_York", weeklySchedule: [{ weekday: 1, start: "09:00", end: "10:00" }] });
      await service.upsertResource({ resourceId: "los-angeles", capacity: 1, timeZone: "America/Los_Angeles", weeklySchedule: [{ weekday: 1, start: "09:00", end: "10:00" }] });
      assert.equal((await service.availability({ resourceId: "new-york", start: "2026-01-05T14:15:00Z", end: "2026-01-05T14:45:00Z" })).available, 1);
      assert.equal((await service.availability({ resourceId: "new-york", start: "2026-07-06T13:15:00Z", end: "2026-07-06T13:45:00Z" })).available, 1);
      assert.equal((await service.availability({ resourceId: "new-york", start: "2026-07-06T14:15:00Z", end: "2026-07-06T14:45:00Z" })).available, 0);
      assert.equal((await service.availability({ resourceId: "los-angeles", start: "2026-03-09T16:15:00Z", end: "2026-03-09T16:45:00Z" })).available, 1); await service.close();
    }) },
    { id: "multiple-windows-and-weekdays", run: () => isolated(async ({ open }) => {
      const service = await open(); await service.upsertResource({ resourceId: "split-week", capacity: 2, timeZone: "America/New_York", weeklySchedule: [
        { weekday: 1, start: "09:00", end: "10:00" }, { weekday: 1, start: "13:00", end: "14:00" }, { weekday: 2, start: "11:00", end: "12:00" },
      ] });
      assert.equal((await service.availability({ resourceId: "split-week", start: "2026-01-05T18:15:00Z", end: "2026-01-05T18:45:00Z" })).available, 2);
      assert.equal((await service.availability({ resourceId: "split-week", start: "2026-01-06T16:15:00Z", end: "2026-01-06T16:45:00Z" })).available, 2);
      assert.equal((await service.availability({ resourceId: "split-week", start: "2026-01-07T16:15:00Z", end: "2026-01-07T16:45:00Z" })).available, 0); await service.close();
    }) },
    { id: "spring-forward-gap", run: () => isolated(async ({ open }) => {
      const service = await open(); await service.upsertResource({ resourceId: "spring-gap", capacity: 1, timeZone: "America/New_York", weeklySchedule: [{ weekday: 7, start: "01:00", end: "04:00" }] });
      assert.equal((await service.availability({ resourceId: "spring-gap", start: "2026-03-08T06:30:00Z", end: "2026-03-08T07:30:00Z" })).available, 1); await service.close();
    }) },
    { id: "fall-back-fold", run: () => isolated(async ({ open }) => {
      const service = await open(); await service.upsertResource({ resourceId: "fall-fold", capacity: 1, timeZone: "America/New_York", weeklySchedule: [{ weekday: 7, start: "01:00", end: "02:00" }] });
      const firstFold = { start: "2026-11-01T05:15:00Z", end: "2026-11-01T05:45:00Z" }, secondFold = { start: "2026-11-01T06:15:00Z", end: "2026-11-01T06:45:00Z" };
      assert.equal((await service.availability({ resourceId: "fall-fold", ...firstFold })).available, 1); assert.equal((await service.availability({ resourceId: "fall-fold", ...secondFold })).available, 1);
      assert.equal((await service.placeHold({ idempotencyKey: "first-fold", resourceId: "fall-fold", ...firstFold, quantity: 1, ttlMs: 60_000 })).status, "held");
      assert.equal((await service.placeHold({ idempotencyKey: "second-fold", resourceId: "fall-fold", ...secondFold, quantity: 1, ttlMs: 60_000 })).status, "held"); await service.close();
    }) },
  ]),
  cancellation: () => runCheckpointSuite([
    { id: "idempotent-cancel", run: () => isolated(async ({ open }) => { const service = await open(); await service.upsertResource({ resourceId: "room", capacity: 1, timeZone: "America/New_York", weeklySchedule: schedule }); const held = await service.placeHold({ idempotencyKey: "hold", resourceId: "room", ...interval, quantity: 1, ttlMs: 300_000 }); const confirmed = await service.confirm({ idempotencyKey: "confirm", holdId: held.holdId }); const first = await service.cancel({ idempotencyKey: "cancel", reservationId: confirmed.reservationId }); assert.deepEqual(first, { status: "cancelled" }); assert.deepEqual(await service.cancel({ idempotencyKey: "cancel", reservationId: confirmed.reservationId }), first); await service.close(); }) },
    { id: "cancel-releases-capacity", run: () => isolated(async ({ open }) => { const service = await open(); await service.upsertResource({ resourceId: "room", capacity: 1, timeZone: "America/New_York", weeklySchedule: schedule }); const held = await service.placeHold({ idempotencyKey: "hold", resourceId: "room", ...interval, quantity: 1, ttlMs: 300_000 }); const confirmed = await service.confirm({ idempotencyKey: "confirm", holdId: held.holdId }); assert.equal((await service.availability({ resourceId: "room", ...interval })).available, 0); await service.cancel({ idempotencyKey: "cancel", reservationId: confirmed.reservationId }); assert.equal((await service.availability({ resourceId: "room", ...interval })).available, 1); await service.close(); }) },
  ]),
  "capacity-conservation": () => runCheckpointSuite([
    { id: "overlap-and-expiry", run: () => isolated(async ({ open, setNow }) => {
      const service = await open(); await service.upsertResource({ resourceId: "room", capacity: 3, timeZone: "America/New_York", weeklySchedule: schedule });
      assert.equal((await service.placeHold({ idempotencyKey: "q2", resourceId: "room", ...interval, quantity: 2, ttlMs: 300_000 })).status, "held");
      assert.equal((await service.placeHold({ idempotencyKey: "q1", resourceId: "room", ...interval, quantity: 1, ttlMs: 60_000 })).status, "held");
      assert.equal((await service.placeHold({ idempotencyKey: "overflow", resourceId: "room", ...interval, quantity: 1, ttlMs: 300_000 })).status, "unavailable");
      for (const request of [interval, { start: "2026-01-05T14:00:00Z", end: "2026-01-05T14:20:00Z" }, { start: "2026-01-05T14:40:00Z", end: "2026-01-05T15:00:00Z" }]) assert.equal((await service.availability({ resourceId: "room", ...request })).available, 0);
      assert.equal((await service.availability({ resourceId: "room", start: "2026-01-05T15:00:00Z", end: "2026-01-05T15:30:00Z" })).available, 3);
      await setNow(instant("2026-01-05T14:01:00Z")); assert.equal((await service.availability({ resourceId: "room", ...interval })).available, 1); await service.close();
    }) },
    { id: "touching-and-nested-intervals", run: () => isolated(async ({ open }) => {
      const service = await open(); await service.upsertResource({ resourceId: "segmented", capacity: 2, timeZone: "America/New_York", weeklySchedule: schedule });
      await service.placeHold({ idempotencyKey: "segment-a", resourceId: "segmented", start: "2026-01-05T14:00:00Z", end: "2026-01-05T14:30:00Z", quantity: 1, ttlMs: 300_000 });
      await service.placeHold({ idempotencyKey: "segment-b", resourceId: "segmented", start: "2026-01-05T14:30:00Z", end: "2026-01-05T15:00:00Z", quantity: 1, ttlMs: 300_000 });
      assert.equal((await service.availability({ resourceId: "segmented", start: "2026-01-05T14:00:00Z", end: "2026-01-05T15:00:00Z" })).available, 1);
      await service.placeHold({ idempotencyKey: "nested", resourceId: "segmented", start: "2026-01-05T14:10:00Z", end: "2026-01-05T14:20:00Z", quantity: 1, ttlMs: 300_000 });
      assert.equal((await service.availability({ resourceId: "segmented", start: "2026-01-05T14:00:00Z", end: "2026-01-05T15:00:00Z" })).available, 0); await service.close();
    }) },
    { id: "generated-capacity-matrix", run: () => isolated(async ({ open }) => {
      const service = await open(); for (const capacity of [2, 3, 5]) { const resourceId = "matrix-" + capacity;
        await service.upsertResource({ resourceId, capacity, timeZone: "America/New_York", weeklySchedule: schedule });
        for (let segment = 0; segment < 3; segment += 1) { const startMinute = String(segment * 10).padStart(2, "0"), endMinute = String((segment + 1) * 10).padStart(2, "0");
          await service.placeHold({ idempotencyKey: resourceId + "-" + segment, resourceId, start: "2026-01-05T14:" + startMinute + ":00Z", end: "2026-01-05T14:" + endMinute + ":00Z", quantity: capacity - 1, ttlMs: 300_000 }); }
        assert.equal((await service.availability({ resourceId, start: "2026-01-05T14:00:00Z", end: "2026-01-05T14:30:00Z" })).available, 1); } await service.close();
    }) },
    { id: "invalid-input-does-not-corrupt-capacity", run: () => isolated(async ({ open }) => {
      const service = await open(); await service.upsertResource({ resourceId: "room", capacity: 1, timeZone: "America/New_York", weeklySchedule: schedule });
      for (const quantity of [0, -1, 1.5, "1", null]) await assert.rejects(service.placeHold({ idempotencyKey: "bad-" + String(quantity), resourceId: "room", ...interval, quantity, ttlMs: 1 }));
      await assert.rejects(service.placeHold({ idempotencyKey: "backwards", resourceId: "room", start: interval.end, end: interval.start, quantity: 1, ttlMs: 1 }));
      assert.equal((await service.availability({ resourceId: "room", ...interval })).available, 1); await service.close();
    }) },
  ]),
  "restart-persistence": () => isolated(async ({ storagePath }) => {
    const results = []; let state = {};
    for (const [stage, label, now] of [[1, "seed-durable-state", "2026-01-05T14:00:00Z"], [2, "same-time-replay", "2026-01-05T14:00:00Z"], [3, "expiry-and-cancellation-reconcile", "2026-01-05T14:01:00Z"], [4, "terminal-results-replay", "2026-01-05T14:02:00Z"]]) {
      try { state = await restartStage(stage, storagePath, instant(now), state); results.push({ id: label, passed: true, detail: "passed" }); }
      catch (error) { results.push({ id: label, passed: false, detail: String(error?.stack || error) }); }
    }
    return results;
  }),
};

const id = __RELAYER_PREDICATE_ID__;
if (!Object.hasOwn(predicates, id)) throw new Error("Unknown reservation verifier predicate: " + id);
let result;
try {
  const recorded = await predicates[id]();
  const checkpoints = Array.isArray(recorded) ? recorded : [{ id: "complete", passed: true, detail: "passed" }];
  result = { id, passed: checkpoints.every((checkpoint) => checkpoint.passed), detail: JSON.stringify({ checkpoints }) };
}
catch (error) { result = { id, passed: false, detail: String(error?.stack || error) }; }
process.stdout.write(JSON.stringify({ schemaVersion: 1, result }) + "\n");
`;

const digest = (value: string): `sha256:${string}` => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const canonicalFiles = (files: Readonly<Record<string, string>>): string => Object.entries(files)
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([path, contents]) => `${path}\0${contents.length}\0${contents}`)
  .join("\0");

const fixtureDigest = digest(canonicalFiles(starterFiles));
const fixtureSource = `relayer-eval://capability/${RESERVATION_CAPACITY_CASE_ID}`;
const fixtureRevision = "git-tree:ef412dbd8e7c62045d62071eea303597e6e4dbfc";
const fixtureEnvironmentDigest = digest(JSON.stringify({ runtime: "node@22", install: null, platform: "darwin" }));
const expectedVerifierDigest = "sha256:b64bbfa1330e6b79c393df9c8f3f88573c390993f8eb2a5460ab1a36f356e27c";

export interface ReservationCapacityCaseDefinition {
  readonly schemaVersion: 1;
  readonly id: ReservationCapacityCaseId;
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

const definition: ReservationCapacityCaseDefinition = Object.freeze({
  schemaVersion: 1,
  id: RESERVATION_CAPACITY_CASE_ID,
  name: "Reservation and capacity product",
  description: "Builds a persistent, contention-safe reservation product with expiring holds and local schedules.",
  localOnly: true,
  supportedPlatform: "darwin",
  autonomous: true,
  category: "coding",
  taskType: "greenfield-build",
  fixture: Object.freeze({ source: fixtureSource, revision: fixtureRevision, packageManager: "node@22" }),
  threads: Object.freeze([Object.freeze({
    id: "implementation",
    name: "Build the reservation product",
    permissionProfileId: "auto",
    mutationPolicy: "writable",
    workspaceGrade: "autonomous-implementation",
    prompts: Object.freeze([visibleTask]),
  })]),
});

const mandatoryGates = predicateIds.map((id) => Object.freeze({
  id: `reservation-${id}`,
  label: id.split("-").map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join(" "),
  description: `The evaluator-owned public-seam ${id} predicate passes.`,
}));

export const reservationCapacityCase = bindAutonomousCaseSnapshot(definition, createAutonomousCaseSnapshot({
  id: definition.id,
  name: definition.name,
  description: definition.description,
  category: definition.category,
  taskType: definition.taskType,
  artifacts: {
    task: { kind: "visible-task", text: visibleTask, contentDigest: digest(visibleTask) },
    workspace: {
      kind: "frozen-workspace",
      materializerId: "reservation-capacity-template-v1",
      source: fixtureSource,
      revision: fixtureRevision,
      contentDigest: fixtureDigest,
      environmentDigest: fixtureEnvironmentDigest,
    },
    reference: {
      kind: "sealed-reference",
      artifactId: "reservation-capacity-admission-portfolio-v1",
      format: "behavioral-admission-portfolio",
      contentDigest: "sha256:5cd346d426f8b440b967ce12df5667410cc28d54722c82f7619f334aeb6c24ad",
      sealedPath: "packages/eval-runner/test/reservation-capacity-case.test.ts",
    },
    verifier: {
      kind: "sealed-verifier",
      artifactId: "reservation-capacity-public-seam-verifier-v1",
      verifierId: "reservation-capacity-public-seam-v1",
      contentDigest: expectedVerifierDigest,
      sealedPath: "packages/eval-runner/src/project-cases/reservation-capacity-case.ts",
      mandatoryGates: [
        ...mandatoryGates,
        { id: "reservation-durable-delivery", label: "Durable delivery", description: "The declared project artifacts are present in a clean post-fixture commit." },
      ],
    },
    outcomeRubric: {
      kind: "outcome-rubric",
      rubricVersion: "reservation-capacity-outcome-v1",
      criteria: [
        { id: "behavior", label: "Reservation correctness", description: "The public product seam preserves schedules, capacity, lifecycle, concurrency, and durability.", weight: 3 },
        { id: "usability", label: "Product usability", description: "The browser interface makes availability and reservation lifecycle understandable and usable.", weight: 1 },
      ],
      contentDigest: digest("reservation-correctness:3\nproduct-usability:1"),
    },
  },
}));

export const reservationCapacityCases = Object.freeze([reservationCapacityCase]);
export const reservationCapacityCaseIds = new Set<ReservationCapacityCaseId>([RESERVATION_CAPACITY_CASE_ID]);

export interface ReservationCapacityFixtureReceipt {
  readonly schemaVersion: 1;
  readonly fixtureId: ReservationCapacityCaseId;
  readonly workspaceDirectory: string;
  readonly repositoryUrl: string;
  readonly sourceRevision: string;
  readonly seededCommit: string;
  readonly seededTree: string;
  readonly packageManager: "node@22";
  readonly installedWithFrozenLockfile: false;
  readonly sourceContentDigest: `sha256:${string}`;
  readonly environmentDigest: `sha256:${string}`;
}

export async function materializeReservationCapacityFixture(options: {
  readonly caseId: ReservationCapacityCaseId;
  readonly workspaceDirectory: string;
  readonly platform?: NodeJS.Platform;
  readonly runtimeNodeVersion?: string;
  readonly runCommand?: CommandRunner;
}): Promise<ReservationCapacityFixtureReceipt> {
  if (options.caseId !== RESERVATION_CAPACITY_CASE_ID) throw new Error(`Unknown reservation capacity case: ${options.caseId}`);
  if ((options.platform ?? process.platform) !== "darwin") throw new Error("The reservation capacity case is local Mac only.");
  if (Number((options.runtimeNodeVersion ?? process.versions.node).split(".")[0]) !== 22) {
    throw new Error("The reservation capacity case requires Node 22.");
  }
  await requireMissing(options.workspaceDirectory);
  await mkdir(options.workspaceDirectory, { recursive: true, mode: 0o700 });
  for (const [relativePath, contents] of Object.entries(starterFiles)) {
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
    GIT_AUTHOR_DATE: "2026-08-28T12:00:00Z",
    GIT_COMMITTER_DATE: "2026-08-28T12:00:00Z",
  });
  const seededCommit = (await required(runCommand, "git", ["rev-parse", "HEAD"], options.workspaceDirectory)).stdout.trim();
  const seededTree = (await required(runCommand, "git", ["rev-parse", "HEAD^{tree}"], options.workspaceDirectory)).stdout.trim();
  if (`git-tree:${seededTree}` !== fixtureRevision) {
    throw new Error(`Materialized reservation capacity tree drifted: ${seededTree}.`);
  }
  return Object.freeze({
    schemaVersion: 1,
    fixtureId: options.caseId,
    workspaceDirectory: options.workspaceDirectory,
    repositoryUrl: fixtureSource,
    sourceRevision: fixtureRevision,
    seededCommit,
    seededTree,
    packageManager: "node@22",
    installedWithFrozenLockfile: false,
    sourceContentDigest: fixtureDigest,
    environmentDigest: fixtureEnvironmentDigest,
  });
}

export async function gradeReservationCapacityWorkspace(options: {
  readonly caseId: ReservationCapacityCaseId;
  readonly workspaceDirectory: string;
  readonly baseRevision?: string;
  readonly runCommand?: CommandRunner;
}): Promise<readonly EvalCheck[]> {
  if (options.caseId !== RESERVATION_CAPACITY_CASE_ID) throw new Error(`Unknown reservation capacity case: ${options.caseId}`);
  const runCommand = options.runCommand ?? run;
  const predicateResults = await Promise.all(predicateIds.map(async (id) => parseVerifierResult(
    await runSealedNodeProgram(
      verifierProgram.replace("__RELAYER_PREDICATE_ID__", JSON.stringify(id)),
      options.workspaceDirectory,
    ),
    id,
  )));
  const predicates = new Map(predicateResults.map((result) => [result.id, result]));
  const baseRevision = options.baseRevision ?? (await required(runCommand, "git", ["rev-list", "--max-parents=0", "HEAD"], options.workspaceDirectory)).stdout.trim();
  const commits = lines((await required(runCommand, "git", ["rev-list", `${baseRevision}..HEAD`], options.workspaceDirectory)).stdout);
  const status = (await required(runCommand, "git", ["status", "--porcelain=v1", "--untracked-files=all"], options.workspaceDirectory)).stdout.trim();
  const changedPaths = new Set(lines((await required(runCommand, "git", ["diff", "--name-only", baseRevision, "HEAD", "--"], options.workspaceDirectory)).stdout));
  const projectTests = await runCommand("npm", ["test"], { cwd: options.workspaceDirectory });
  const interfaceCheck = await verifyReservationInterface(options.workspaceDirectory);
  const deliverables = await Promise.all(["package.json", "src/index.js", "index.html", "test/contract.test.js"].map(async (relativePath) => ({
    relativePath,
    present: (await readFile(join(options.workspaceDirectory, relativePath), "utf8").catch(() => "")).trim().length > 0,
    changed: !["src/index.js", "index.html", "test/contract.test.js"].includes(relativePath) || changedPaths.has(relativePath),
  })));
  return Object.freeze([
    ...predicateIds.map((id) => {
      const result = predicates.get(id);
      return {
        name: `workspace:reservation-${id}`,
        passed: result?.passed === true,
        detail: result?.detail ?? `Verifier did not emit the independent ${id} predicate.`,
      };
    }),
    {
      name: "workspace:reservation-required-artifacts",
      passed: deliverables.every(({ present, changed }) => present && changed),
      detail: deliverables.map(({ relativePath, present, changed }) => (
        `${relativePath}: ${present ? "present" : "missing"}${changed ? "" : ", unchanged from starter"}`
      )).join("; "),
    },
    {
      name: "workspace:reservation-ui-contract",
      passed: interfaceCheck.passed,
      detail: interfaceCheck.detail,
    },
    {
      name: "workspace:reservation-project-tests",
      passed: projectTests.exitCode === 0,
      detail: projectTests.exitCode === 0
        ? "Candidate-declared Node tests passed."
        : `Candidate-declared Node tests failed (${projectTests.exitCode}): ${(projectTests.stderr || projectTests.stdout).trim().slice(-2_000) || "no output"}`,
    },
    { name: "workspace:reservation-delivery-commit", passed: commits.length >= 1, detail: `${commits.length} post-fixture commit(s).` },
    { name: "workspace:reservation-delivery-clean", passed: status === "", detail: status === "" ? "The workspace is clean." : `Uncommitted changes remain: ${status}` },
  ]);
}

async function verifyReservationInterface(workspaceDirectory: string): Promise<{ passed: boolean; detail: string }> {
  const source = await readFile(join(workspaceDirectory, "index.html"), "utf8").catch(() => "");
  const html = source.replace(/<!--[\s\S]*?-->/g, "");
  const count = (pattern: RegExp) => html.match(pattern)?.length ?? 0;
  const buttonLabels = [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/gi)]
    .map((match) => match[0].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().toLowerCase());
  const inlineScripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
  const scriptSources = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)].map((match) => match[1] ?? "");
  const externalScripts = await Promise.all(scriptSources.map(async (relativePath) => (
    relativePath !== "" && !relativePath.startsWith("/") && !relativePath.split("/").includes("..")
      ? await readFile(join(workspaceDirectory, relativePath), "utf8").catch(() => "")
      : ""
  )));
  const scripts = [...inlineScripts, ...externalScripts].join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\n)\s*\/\/.*(?=\n|$)/g, "$1");
  const facts = {
    form: count(/<form\b/gi) >= 1,
    namedControls: ["resource", "start", "end", "quantity"].every((name) => (
      new RegExp(`<label\\b[^>]*>[\\s\\S]*?${name}[\\s\\S]*?<\\/(?:label)>`, "i").test(html)
      && new RegExp(`<(?:input|select|textarea)\\b[^>]*(?:name|id)\\s*=\\s*["'][^"']*${name}`, "i").test(html)
    )),
    namedActions: ["availability", "hold", "confirm", "cancel"].every((action) => (
      buttonLabels.some((label) => label.includes(action))
      || new RegExp(`<button\\b[^>]*(?:data-action|aria-label)\\s*=\\s*["'][^"']*${action}`, "i").test(html)
    )),
    liveStatus: /\b(?:aria-live\s*=|role\s*=\s*["']status["'])/i.test(html),
    statusWiring: /\b(?:addEventListener|onclick)\b/i.test(scripts)
      && /(?:querySelectorAll?|getElementsBy\w+)\s*\([^)]*(?:button|data-action)/i.test(scripts)
      && /(?:querySelector|getElementById)\s*\([^)]*(?:status|aria-live)/i.test(scripts),
  };
  return {
    passed: Object.values(facts).every(Boolean),
    detail: Object.entries(facts).map(([name, present]) => `${name}: ${present ? "present" : "missing"}`).join(", "),
  };
}

function parseVerifierResult(
  result: CommandResult,
  id: ReservationPredicateId,
): { id: ReservationPredicateId; passed: boolean; detail: string } {
  if (result.exitCode !== 0) {
    const detail = `Public-seam verifier process failed (${result.exitCode}): ${(result.stderr || result.stdout).trim().slice(-2_000) || "no output"}`;
    return { id, passed: false, detail };
  }
  try {
    const receipt = JSON.parse(lines(result.stdout).at(-1) ?? "") as { result?: { id?: unknown; passed?: unknown; detail?: unknown } };
    if (receipt.result?.id !== id) throw new Error(`expected ${id}, received ${String(receipt.result?.id)}`);
    return { id, passed: receipt.result.passed === true, detail: String(receipt.result.detail ?? "") };
  } catch (error) {
    const detail = `Public-seam verifier emitted an invalid receipt: ${error instanceof Error ? error.message : String(error)}`;
    return { id, passed: false, detail };
  }
}

export function reservationCapacityVerifierSourceDigest(source: string): `sha256:${string}` {
  const canonical = source.replace(
    /const expectedVerifierDigest = "sha256:[a-f0-9]{64}";/,
    'const expectedVerifierDigest = "sha256:SELF";',
  );
  if (canonical === source) throw new Error("Reservation verifier source is missing its canonical self-digest field.");
  return digest(canonical);
}

async function runSealedNodeProgram(source: string, cwd: string): Promise<CommandResult> {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-"], {
      cwd,
      env: {
        LANG: "en_US.UTF-8",
        PATH: dirname(process.execPath),
        PWD: cwd,
        TMPDIR: process.env.TMPDIR ?? "/tmp",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ exitCode: 1, stdout, stderr: `${stderr}\nSealed verifier timed out.`.trim() });
    }, 15_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout = `${stdout}${chunk}`.slice(-4 * 1024 * 1024); });
    child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-4 * 1024 * 1024); });
    child.once("error", (error) => finish({ exitCode: 1, stdout, stderr: error.message }));
    child.once("close", (code, signal) => finish({
      exitCode: code ?? 1,
      stdout,
      stderr: code === null ? `${stderr}\nSealed verifier stopped by ${String(signal)}.`.trim() : stderr,
    }));
    child.stdin.end(source);
  });
}

async function requireMissing(path: string): Promise<void> {
  try { await access(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  throw new Error(`Refusing to overwrite existing reservation capacity workspace: ${path}`);
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

const execFileAsync = promisify(execFile);
async function run(command: string, args: readonly string[], options: Parameters<CommandRunner>[2]): Promise<CommandResult> {
  try {
    const result = await execFileAsync(command, [...args], {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 60_000,
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    return { exitCode: typeof failure.code === "number" ? failure.code : 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? failure.message };
  }
}
