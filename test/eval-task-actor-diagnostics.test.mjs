import { test, expect } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createActorDiagnostics, projectActorTrace, sanitizeActorDiagnostic } from "../desktop/eval-main/task-actor-diagnostics.mjs";

test("diagnostics are absent unless an output directory is explicitly supplied", async () => {
  expect(await createActorDiagnostics({ context: new Proxy({}, { get() { throw new Error("must not touch browser"); } }) })).toBeNull();
});

test("trace projection excludes credential-bearing params, results, events and source payloads", () => {
  const sentinel = "sensitive-test-capability";
  const clean = value => sanitizeActorDiagnostic(value, [sentinel]);
  const projected = projectActorTrace({ type: "before", callId: "call@1", method: "goto", startTime: 12,
    params: { url: `http://localhost/#${sentinel}`, headers: { authorization: sentinel } }, result: sentinel,
    stack: [{ file: sentinel }], error: { message: `failed http://localhost/#${sentinel} Authorization=${sentinel}` } }, clean);
  expect(JSON.stringify(projected)).not.toContain(sentinel);
  expect(projected.params).toEqual({}); expect(projected).not.toHaveProperty("result");
  expect(projected).not.toHaveProperty("stack");
  expect(projected.callId).toBe("call@1"); expect(projected.method).toBe("goto");
  expect(projectActorTrace({ type: "event", params: { text: sentinel } })).toBeNull();
});

test("diagnostics preserve correlation and error stages without surfacing capture failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "actor-diagnostic-test-"));
  try {
    const diagnostics = await createActorDiagnostics({ directory, sessionId: "session", surfaceUrl: "http://localhost/#capability-test", context: {
      tracing: { start: async () => { throw new Error("trace unavailable"); } },
    } });
    await diagnostics.record("action_started", { actionId: "one", actionEventId: 17, observationEventId: 16 });
    await diagnostics.failure({ locator() { throw new Error("page closed"); } }, { actionId: "one", stage: "dispatch_click", error: new Error("Element is not attached to the DOM capability-test"), target: null });
    await diagnostics.close();
    const [attempt] = await readdir(directory);
    const text = await readFile(join(directory, attempt, "events.jsonl"), "utf8");
    expect(text).not.toContain("capability-test");
    const events = text.trim().split("\n").map(JSON.parse);
    expect(events.find(event => event.type === "action_started")).toMatchObject({ actionEventId: 17, observationEventId: 16 });
    expect(events.find(event => event.type === "action_error")).toMatchObject({ stage: "dispatch_click", actionDispatched: "unknown" });
    expect(events.filter(event => event.type === "diagnostic_error")).toHaveLength(2);
    expect(JSON.parse(await readFile(join(directory, attempt, "manifest.json"), "utf8"))).toMatchObject({ status: "closed", trace: "failed", captureFailures: ["trace_start", "failure_capture"] });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("unwritable diagnostics do not reject record or teardown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "actor-diagnostic-unwritable-"));
  try {
    const diagnostics = await createActorDiagnostics({ directory, sessionId: "session", surfaceUrl: "http://localhost/#secret", context: { tracing: { start: async () => { throw Error("disabled"); } } } });
    const [attempt] = await readdir(directory);
    await rm(join(directory, attempt), { recursive: true }); await writeFile(join(directory, attempt), "blocked");
    await expect(diagnostics.record("event")).resolves.toBeUndefined();
    await expect(diagnostics.close()).resolves.toBeUndefined();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("credential-shaped exception values are removed including quoted JSON and provider keys", () => {
  for (const input of ['{"apiKey":"my-private-key-value"}', 'Cookie="session=private-cookie-value; another=private"', 'Authorization: Bearer private-bearer-value', 'secret=private-secret-value', 'sk-providerabcdefghijklmnopqrst']) {
    expect(sanitizeActorDiagnostic(input)).not.toMatch(/my-private-key-value|private-cookie-value|private-bearer-value|private-secret-value|sk-provider/);
  }
});
