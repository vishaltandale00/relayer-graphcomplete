import { readFile, access } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, request as httpRequest } from "node:http";
import { createEvalDashboard, createReviewSurface, openHumanReview } from "../desktop/eval-main/web-host.mjs";

const opened = [];
afterEach(async () => { await Promise.all(opened.splice(0).map((surface) => surface.close())); });
const authorized = (surface, extra = {}) => ({ Authorization: `Bearer ${new URL(surface.url).hash.slice(1)}`, ...extra });
const context = { readOnly: true, executionId: "e1", cases: [{ executionId: "e1", threadIds: [7] }] };

describe("Eval localhost authority", () => {
  it("authenticates dashboard operations and rejects foreign origins, hosts and encoded API paths", async () => {
    const surface = await createEvalDashboard({ service: { listRuns: () => [{ id: "run" }] }, rendererDirectory: "desktop/eval-renderer" });
    opened.push(surface);
    const request = (headers = {}, path = "/eval-api/listRuns") => fetch(surface.origin + path, { method: "POST", headers, body: "[]" });
    expect((await request()).status).toBe(401);
    expect((await request(authorized(surface, { Origin: "https://example.com" }))).status).toBe(403);
    const hostileHostStatus = await new Promise((resolve, reject) => {
      const req = httpRequest(surface.origin + "/eval-api/listRuns", { method: "POST", headers: { Host: "attacker.example" } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on("error", reject); req.end("[]");
    });
    expect(hostileHostStatus).toBe(403);
    expect((await request(authorized(surface), "/%65val-api/listRuns")).status).toBe(400);
    expect(await (await request(authorized(surface))).json()).toEqual([{ id: "run" }]);
    expect((await request(authorized(surface), "/eval-api/constructor")).status).toBe(404);
    const html = await fetch(surface.origin).then((response) => response.text());
    expect(html).toContain('/eval-bridge.js');
    expect(html).not.toContain(new URL(surface.url).hash.slice(1));
  });

  it("keeps human capabilities separate and forwards only fixed read-only and scoped annotation credentials", async () => {
    const seen = [];
    const upstream = createServer((request, response) => {
      seen.push({ cookie: request.headers.cookie, authorization: request.headers.authorization, url: request.url });
      response.setHeader("Content-Type", "application/json");
      response.setHeader("Set-Cookie", "control=must-not-escape");
      response.end('{"ok":true}');
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    opened.push({ close: () => new Promise((resolve) => { upstream.close(resolve); upstream.closeAllConnections(); }) });
    const productSession = { origin: `http://127.0.0.1:${upstream.address().port}`, cookie: { name: "control", value: "secret" }, readOnlyCookie: { name: "read", value: "readonly" } };
    const human = await createReviewSurface({ productSession, context, annotationToken: "human-7" });
    const judge = await createReviewSurface({ productSession, context });
    opened.push(human, judge);
    expect((await fetch(judge.origin + "/eval-api/context", { headers: authorized(human) })).status).toBe(401);
    const send = (surface, path) => fetch(surface.origin + path, { method: "POST", headers: authorized(surface, { Cookie: "control=secret; relayer_annotation=forged" }), body: "{}" });
    expect((await send(judge, "/api/threads/7/annotations")).status).toBe(403);
    expect((await send(human, "/api/threads/8/annotations")).status).toBe(403);
    expect((await send(human, "/api/threads/7/interactions")).status).toBe(403);
    expect((await send(human, "/api/internal/annotation-sessions")).status).toBe(403);
    const response = await send(human, "/api/threads/7/annotations");
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(seen).toEqual([{ cookie: "read=readonly; relayer_annotation=human-7", authorization: undefined, url: "/api/threads/7/annotations" }]);
    await fetch(judge.origin + "/api/threads/7", { headers: authorized(judge, { Cookie: "control=secret" }) });
    expect(seen.at(-1).cookie).toBe("read=readonly");
  });
});

it("imports uploaded bytes through a private temporary file and removes it after parsing", async () => {
  let uploadedPath;
  const content = '{"kind":"conversation"}\n';
  const surface = await createEvalDashboard({ rendererDirectory: "desktop/eval-renderer", service: {
    importConversation: async (path) => { uploadedPath = path; return { content: await readFile(path, "utf8") }; },
  } });
  opened.push(surface);
  const response = await fetch(surface.origin + "/eval-api/import", { method: "POST", headers: authorized(surface), body: content });
  expect(await response.json()).toEqual({ content });
  // Cleanup finishes after the response has been written.
  await expect.poll(async () => {
    try { await access(uploadedPath); return true; }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  }).toBe(false);
});

it("reopening a growing run snapshots a new roster without widening old review tabs", async () => {
  let roster = [7];
  const scopes = [];
  const options = {
    executionId: "e1", assertRunning: () => {},
    reviewContext: () => ({ readOnly: true, cases: [{ executionId: "e1", threadIds: [...roster] }] }),
    productSession: async () => ({ origin: "http://127.0.0.1:1", readOnlyCookie: { name: "read", value: "only" } }),
    registerAnnotations: async (_session, scope) => scopes.push(scope),
  };
  const first = await openHumanReview(options); opened.push(first);
  roster = [7, 8];
  const second = await openHumanReview(options); opened.push(second);
  const read = (surface) => fetch(surface.origin + "/eval-api/context", { headers: authorized(surface) }).then((response) => response.json());
  expect((await read(first)).cases[0].threadIds).toEqual([7]);
  expect((await read(second)).cases[0].threadIds).toEqual([7, 8]);
  expect(scopes.map(({ threadIds }) => threadIds)).toEqual([[7], [7, 8]]);
  expect(scopes[0].token).not.toBe(scopes[1].token);
  expect((await fetch(first.origin + "/api/threads/8/annotations", {
    method: "POST", headers: authorized(first), body: "{}",
  })).status).toBe(403);
});

it("does not create a review surface when shutdown starts during annotation registration", async () => {
  let stopping = false;
  let finish;
  let entered;
  const registering = new Promise((resolve) => { entered = resolve; });
  const pending = openHumanReview({
    executionId: "e1", reviewContext: () => context,
    productSession: async () => ({ origin: "http://127.0.0.1:1", readOnlyCookie: { name: "read", value: "only" } }),
    assertRunning: () => { if (stopping) throw new Error("Eval is stopping."); },
    registerAnnotations: () => { entered(); return new Promise((resolve) => { finish = resolve; }); },
  });
  await registering;
  stopping = true;
  finish();
  await expect(pending).rejects.toThrow("Eval is stopping.");
});
