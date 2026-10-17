import { runInNewContext } from "node:vm";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSettingsStore } from "../desktop/main/services/settings-store.mjs";
import { readFile, access, mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, request as httpRequest } from "node:http";
import { createEvalDashboard, createReviewSurface, createSettingsSurface, createHumanTaskSurface, openHumanReview } from "../desktop/eval-main/web-host.mjs";

const opened = [];
afterEach(async () => { await Promise.all(opened.splice(0).map((surface) => surface.close())); });
const authorized = (surface, extra = {}) => ({ Authorization: `Bearer ${new URL(surface.url).hash.slice(1)}`, ...extra });
const context = { readOnly: true, executionId: "e1", cases: [{ executionId: "e1", threadIds: [7] }] };

describe("Eval localhost authority", () => {
  it("registers live graph annotations without widening product write authority", async () => {
    const registered = [];
    const forwarded = [];
    const productSession = { origin: "http://product.invalid", cookie: { name: "control", value: "private" }, readOnlyCookie: { name: "read", value: "only" } };
    const fetchImpl = async (url, options = {}) => {
      forwarded.push({ path: url.pathname, method: options.method || "GET", cookie: options.headers?.Cookie });
      const scoped = registered.some(({ token, threadIds }) => options.headers?.Cookie === `read=only; relayer_annotation=${token}` && threadIds.includes(7));
      if (url.pathname === "/api/capabilities") return Response.json({ annotations: scoped });
      if (url.pathname === "/api/state") return Response.json({ capabilities: { annotations: scoped }, threads: [{ id: 7, projectId: 1, active: true }], projects: [{ id: 1 }], interactions: [] });
      return Response.json({ annotation: { id: 1 } }, { status: scoped ? 201 : 401, headers: { "Set-Cookie": "control=must-not-escape" } });
    };
    const tasks = {
      get: () => ({ status: "active", currentThreadId: 7, threadIds: [7], prepared: { execution: { projectId: 1 } } }),
      upstream: (path, options) => fetchImpl(new URL(path, productSession.origin), { ...options, headers: { Cookie: "read=only" } }),
      write: () => { throw Object.assign(new Error("Write is outside this task session."), { status: 403 }); },
    };
    const surface = await createHumanTaskSurface({ tasks, sessionId: "task", productSession, fetchImpl,
      registerAnnotations: async (_product, scope) => registered.push(scope),
    });
    opened.push(surface);
    expect(registered).toHaveLength(1);
    expect(registered[0].threadIds).toEqual([7]);
    const request = (path, method = "GET") => fetch(surface.origin + path, {
      method, headers: authorized(surface, { Cookie: "control=forged; relayer_annotation=forged" }),
      ...(method === "POST" ? { body: JSON.stringify({ anchor: { kind: "thread" }, comment: "Useful" }) } : {}),
    });
    expect(await (await request("/api/capabilities")).json()).toEqual({ annotations: true });
    expect((await (await request("/api/state?threadId=7")).json()).capabilities.annotations).toBe(true);
    for (const suffix of ["", "/1/revisions", "/1/retract"]) {
      const response = await request(`/api/threads/7/annotations${suffix}`, "POST");
      expect(response.status).toBe(201);
      expect(response.headers.get("set-cookie")).toBeNull();
    }
    for (const path of ["/api/threads/8/annotations", "/api/threads/7/interactions", "/api/internal/annotation-sessions"]) {
      expect((await request(path, "POST")).status).toBe(403);
    }
    expect(forwarded).toHaveLength(5);
    expect(forwarded.every(({ cookie }) => cookie === `read=only; relayer_annotation=${registered[0].token}`)).toBe(true);
  });

  it("routes only model validation through the task's scoped write admission", async () => {
    const calls = [];
    const selection = { harnessId: "codex-basic", familyId: 1, providerId: "codex", modelId: "fixture" };
    const surface = await createHumanTaskSurface({ sessionId: "owned", productSession: { origin: "http://product.invalid" }, tasks: {
      get: () => ({ status: "active", currentThreadId: 7, threadIds: [7] }),
      upstream: async () => Response.json({ error: "read-only authority" }, { status: 403 }),
      write: async (...args) => { calls.push(args); return { status: 200, bytes: JSON.stringify(selection) }; },
    } });
    opened.push(surface);
    const response = await fetch(surface.origin + "/api/model-selection/validate", { method: "POST", headers: authorized(surface), body: JSON.stringify(selection) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(selection);
    expect(calls).toEqual([["owned", "/api/model-selection/validate", "POST", selection]]);
  });

  it("allows human-session grading in read-only review without enabling product writes or judge grading", async () => {
    const grades = [];
    const productSession = { origin: "http://product.invalid", readOnlyCookie: { name: "read", value: "only" } };
    const review = await createReviewSurface({ productSession, context, humanGrading: {
      task: () => ({ status: "completed" }), grade: (input) => { grades.push(input); return { status: "completed" }; }, annotate: () => ({}),
    } });
    const judge = await createReviewSurface({ productSession, context }); opened.push(review, judge);
    const post = (surface, path, headers = authorized(surface)) => fetch(surface.origin + path, { method: "POST", headers, body: JSON.stringify({ satisfaction: 3, comment: "Useful" }) });
    expect((await post(review, "/eval-api/grade", {})).status).toBe(401);
    expect((await post(review, "/eval-api/grade")).status).toBe(200);
    expect(grades).toHaveLength(1);
    expect((await post(judge, "/eval-api/grade")).status).toBe(404);
    expect((await post(review, "/eval-api/finish")).status).toBe(404);
    expect((await post(review, "/api/threads/7/interactions")).status).toBe(403);
  });

  it("binds workspace grading to its task and requires that surface capability", async () => {
    const calls = [];
    const surface = await createHumanTaskSurface({
      sessionId: "owned", productSession: { origin: "http://product.invalid" },
      tasks: { get: () => ({ currentThreadId: 7 }),
        grade: (id, input) => { calls.push(["grade", id, input]); return { status: "active" }; },
        finish: (id, input) => { calls.push(["finish", id, input]); return { status: "completed" }; },
        annotate: (id, input) => { calls.push(["annotate", id, input]); return { status: "completed" }; } },
    });
    opened.push(surface);
    const post = (path, input, headers = authorized(surface)) => fetch(surface.origin + path, {
      method: "POST", headers, body: JSON.stringify(input),
    });
    expect((await post("/eval-api/finish", {}, {})).status).toBe(401);
    expect((await post("/eval-api/grade", {}, {})).status).toBe(401);
    const context = await fetch(surface.origin + "/eval-api/task", { headers: authorized(surface) }).then((response) => response.json());
    expect(context.workspaceGrading).toBe(2);
    const grade = { sessionId: "foreign", satisfaction: 3, reason: "satisfied" };
    expect((await post("/eval-api/grade", grade)).status).toBe(200);
    expect((await post("/eval-api/finish", grade)).status).toBe(200);
    const annotation = { sessionId: "foreign", eventId: "e1", comment: "Useful" };
    expect((await post("/eval-api/annotate", annotation)).status).toBe(200);
    expect(calls).toEqual([["grade", "owned", grade], ["finish", "owned", grade], ["annotate", "owned", annotation]]);
    expect((await post("/eval-api/finishHumanTask", [])).status).toBe(404);
  });

  it("keeps a copied settings URL usable in a fresh browser and restores older tab URLs", async () => {
    const surface = await createSettingsSurface({
      productSession: { origin: "http://product.invalid", cookie: { name: "control", value: "private" } },
      providerSetup: { status: () => ({ definitions: [] }) },
    });
    opened.push(surface);
    const bridge = await readFile("desktop/eval-renderer/web-bridge.js", "utf8");
    const boot = (address, storage = new Map()) => {
      let location = new URL(address);
      const window = { fetch: (input, options) => fetch(new URL(input, location), options) };
      runInNewContext(bridge, {
        window, location, URL, URLSearchParams, Headers, Request, fetch: (...args) => window.fetch(...args),
        sessionStorage: { setItem: (key, value) => storage.set(key, value), getItem: (key) => storage.get(key) },
        history: { replaceState: (_state, _title, next) => { location = new URL(next, location); } },
      });
      return { window, storage, address: () => location.href };
    };
    const original = boot(surface.url);
    expect(await original.window.relayerDesktop.providers.status()).toEqual({ definitions: [] });
    const copied = boot(original.address());
    await expect(copied.window.relayerDesktop.providers.status()).resolves.toEqual({ definitions: [] });
    const dashboard = `http://127.0.0.1:12345/#${"d".repeat(64)}`;
    const returnAddress = `${surface.url}&${new URLSearchParams({ returnTo: dashboard })}`;
    const withReturn = boot(returnAddress);
    expect(withReturn.window.relayerEvalSettings.returnTo).toBe(dashboard);
    await expect(withReturn.window.relayerDesktop.providers.status()).resolves.toEqual({ definitions: [] });
    expect(boot(withReturn.address()).window.relayerEvalSettings.returnTo).toBe(dashboard);
    const restoredReturn = boot(surface.origin + "/?evalSettings=1", withReturn.storage);
    expect(boot(restoredReturn.address()).window.relayerEvalSettings.returnTo).toBe(dashboard);
    expect(boot(`${surface.url}&returnTo=https%3A%2F%2Fevil.example`).window.relayerEvalSettings.returnTo).toBeNull();
    const rootAddress = new URL(surface.url); rootAddress.search = "";
    const rootSettings = boot(rootAddress.href);
    // The settings entry point must initialize its bridge without a query flag.
    rootSettings.window.initializeRelayerEvalSettings();
    await expect(rootSettings.window.relayerDesktop.providers.status()).resolves.toEqual({ definitions: [] });
    const stripped = new URL(surface.url); stripped.hash = "";
    const recovered = boot(stripped.href, original.storage);
    await expect(boot(recovered.address()).window.relayerDesktop.providers.status()).resolves.toEqual({ definitions: [] });
    // A bare URL does not acquire authority from the server or another browser.
    await expect(boot(stripped.href).window.relayerDesktop.providers.status()).rejects.toThrow("authenticated URL");
  });

  it("opens separately scoped production settings only from an authenticated dashboard", async () => {
    const seen = [];
    let busy = false;
    const settings = await createSettingsSurface({
      productSession: { origin: "http://product.invalid", cookie: { name: "control", value: "private" } },
      providerSetup: { status: () => ({ definitions: [] }), connect: (input) => ({ status: "pending", connectionId: input.connectionId }) },
      isBusy: () => busy,
      fetchImpl: async (url, options) => {
        seen.push({ path: url.pathname, cookie: options.headers.Cookie, authorization: options.headers.Authorization, method: options.method, body: options.body?.toString() });
        return Response.json({ ok: true }, { headers: { "Set-Cookie": "control=must-not-escape" } });
      },
    });
    const dashboard = await createEvalDashboard({ service: {}, rendererDirectory: "desktop/eval-renderer", openSettings: () => settings.url });
    opened.push(settings, dashboard);
    const open = (headers) => fetch(dashboard.origin + "/eval-api/openSettings", { method: "POST", headers, body: "[]" });
    expect((await open({})).status).toBe(401);
    expect((await open(authorized(dashboard, { Origin: "https://foreign.test" }))).status).toBe(403);
    expect(await (await open(authorized(dashboard))).json()).toBe(settings.url);
    expect(new URL(settings.url).searchParams.get("evalSettings")).toBe("1");
    expect((await fetch(settings.origin + "/eval-api/status", { method: "POST", headers: authorized(dashboard), body: "[]" })).status).toBe(401);
    const request = (path, method = "GET", value) => fetch(settings.origin + path, {
      method, headers: authorized(settings, { Cookie: "forged=secret", "Content-Type": "application/json" }),
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
    expect(await (await request("/eval-api/connect", "POST", [{ connectionId: "chosen" }])).json()).toEqual({ status: "pending", connectionId: "chosen" });
    for (const [path, method] of [["/api/state", "GET"], ["/api/threads/7", "GET"], ["/api/threads/7/interactions", "POST"], ["/api/internal/annotation-sessions", "POST"], ["/eval-api/createRun", "POST"]]) {
      expect((await request(path, method, method === "POST" ? {} : undefined)).status, path).toBe(403);
    }
    expect(seen).toEqual([]);
    for (const [path, method, value] of [
      ["/api/model-settings", "GET"],
      ["/api/model-families", "POST", { name: "Chosen", enabled: true, members: [{ providerId: "chosen", modelId: "test-model", roles: [{ name: "orchestrator" }] }] }],
      ["/api/model-settings/defaults", "PUT", { harnessId: "codex-basic", familyId: 1, providerId: "chosen", modelId: "test-model" }],
      ["/api/harness-configurations/codex-basic/model-rules", "PUT", { allow: ["test-*"], deny: [] }],
    ]) {
      const response = await request(path, method, value);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(seen.at(-1)).toMatchObject({ path, method, cookie: "control=private", authorization: undefined });
      if (value) expect(JSON.parse(seen.at(-1).body)).toEqual(value);
    }
    busy = true;
    expect((await request("/api/model-settings/defaults", "PUT", {})).status).toBe(409);
    expect(seen).toHaveLength(4);
    const review = await createReviewSurface({ context, productSession: { origin: "http://product.invalid", readOnlyCookie: { name: "read", value: "only" } }, fetchImpl: async () => { throw new Error("Settings writes reached review upstream"); } });
    opened.push(review);
    expect((await fetch(review.origin + "/api/model-settings/defaults", { method: "PUT", headers: authorized(review), body: "{}" })).status).toBe(403);
    expect((await fetch(review.origin + "/eval-api/connect", { method: "POST", headers: authorized(review), body: "[]" })).status).toBe(404);
  });
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

it("scopes review reads and state metadata to the opening roster, including Rust's missing-thread fallback", async () => {
  const seen = [];
  let missing = false;
  const surface = await createReviewSurface({
    context, productSession: { origin: "http://product.invalid", readOnlyCookie: { name: "read", value: "only" } },
    fetchImpl: async (url) => {
      seen.push(url.pathname + url.search);
      if (url.pathname === "/api/state") return Response.json({
        projects: [{ id: 1 }, { id: 2 }],
        threads: [...(missing ? [] : [{ id: 7, projectId: 1, active: true }]), { id: 8, projectId: 2, active: missing }],
        interactions: [{ id: 10, threadId: missing ? 8 : 7 }],
        currentProjection: { nodes: [missing ? "private" : "reviewed"] },
      });
      if (url.pathname.endsWith("/destination")) return Response.json({ threadId: 8 });
      return Response.json({ ok: true });
    },
  });
  opened.push(surface);
  const read = (path) => fetch(surface.origin + path, { headers: authorized(surface) });
  for (const path of ["/api/state", "/api/state?threadId=8", "/api/state?threadId=7&threadId=8", "/api/threads/8", "/api/threads/8/annotations", "/api/threads", "/api/projects", "/api/completions/7", "/api/internal/annotation-sessions", "/api/threads/7/unknown", "/api/projects/2/environment"]) {
    expect((await read(path)).status, path).toBe(403);
  }
  expect(seen).toEqual([]);
  const state = await (await read("/api/state?threadId=7")).json();
  expect(state).toEqual({ projects: [{ id: 1 }], threads: [{ id: 7, projectId: 1, active: true }], interactions: [{ id: 10, threadId: 7 }], currentProjection: { nodes: ["reviewed"] } });
  expect((await read("/api/projects/1/environment")).status).toBe(200);
  expect((await read("/api/projects/2/environment")).status).toBe(403);
  expect((await read("/api/threads/7/interactions/10/actions/11/destination")).status).toBe(403);
  missing = true;
  const fallback = await read("/api/state?threadId=7");
  expect(fallback.status).toBe(404);
  expect(await fallback.text()).not.toContain("private");
});

it("preserves encoded opaque asset IDs without allowing encoded structural paths or foreign threads", async () => {
  const seen = [];
  const surface = await createReviewSurface({ context,
    productSession: { origin: "http://product.invalid", readOnlyCookie: { name: "read", value: "only" } },
    fetchImpl: async (url) => { seen.push(url.pathname + url.search); return new Response("asset bytes"); },
  });
  opened.push(surface);
  for (const id of ["image one.png", "圖:1", "folder/asset%25"]) {
    const path = `/api/threads/7/interactions/10/nodes/11/detail-assets/${encodeURIComponent(id)}?layerId=12`;
    expect((await fetch(surface.origin + path)).status).toBe(401);
    const response = await fetch(surface.origin + path, { headers: authorized(surface) });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("asset bytes");
    expect(seen.at(-1)).toBe(path);
  }
  for (const path of ["/%61pi/threads/7", "/api/threads/%37", "/api/threads/7/interactions/10/nodes/11/detail-assets/%ZZ"]) {
    expect((await fetch(surface.origin + path, { headers: authorized(surface) })).status).toBe(400);
  }
  expect((await fetch(surface.origin + "/api/threads/8/interactions/10/nodes/11/detail-assets/secret%20asset", { headers: authorized(surface) })).status).toBe(403);
  expect(seen).toHaveLength(3);
});


it("persists Eval layout across origins while keeping preference writes authenticated and product writes forbidden", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relayer-eval-layout-"));
  const start = async () => {
    const surface = await createReviewSurface({ context,
      productSession: { origin: "http://product.invalid", readOnlyCookie: { name: "read", value: "only" } },
      presentationSettings: createSettingsStore(directory),
    });
    opened.push(surface);
    return surface;
  };
  const post = (surface, value, headers = authorized(surface)) => fetch(surface.origin + "/eval-api/workspace-layout", {
    method: "POST", headers, body: JSON.stringify(value),
  });
  try {
    const first = await start();
    expect(await (await fetch(first.origin + "/eval-api/workspace-layout", { headers: authorized(first) })).json()).toBe(0.5);
    expect((await post(first, 0.64, {})).status).toBe(401);
    expect((await post(first, 0.64, authorized(first, { Origin: "https://foreign.example" }))).status).toBe(403);
    expect((await post(first, 0.64)).status).toBe(200);
    expect((await post(first, "0.6")).status).toBe(400);
    expect((await post(first, 0.9)).status).toBe(400);
    const reopened = await start();
    expect(reopened.origin).not.toBe(first.origin);
    expect(await (await fetch(reopened.origin + "/eval-api/workspace-layout", { headers: authorized(reopened) })).json()).toBe(0.64);
    expect((await fetch(reopened.origin + "/api/threads/7/interactions", {
      method: "POST", headers: authorized(reopened), body: "{}",
    })).status).toBe(403);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("an active actor review refreshes its annotation roster only after registration succeeds", async () => {
  let roster = [7]; let fail = false;
  const scopes = [];
  const surface = await openHumanReview({
    executionId: "e1", assertRunning: () => {}, humanGrading: { task: () => ({ status: "active" }) },
    reviewContext: () => ({ readOnly: true, cases: [{ executionId: "e1", threadIds: [...roster] }] }),
    productSession: async () => ({ origin: "http://127.0.0.1:1", readOnlyCookie: { name: "read", value: "only" } }),
    registerAnnotations: async (_session, scope) => { if (fail) throw new Error("Registration failed"); scopes.push(scope); },
  }); opened.push(surface);
  const read = () => fetch(surface.origin + "/eval-api/context", { headers: authorized(surface) });
  roster = [7, 8]; fail = true;
  expect((await read()).status).toBe(400);
  expect(scopes).toHaveLength(1);
  fail = false;
  expect((await (await read()).json()).cases[0].threadIds).toEqual([7, 8]);
  expect(scopes.map(scope => scope.threadIds)).toEqual([[7], [7, 8]]);
  expect(scopes[1].token).toBe(scopes[0].token);
  expect((await fetch(surface.origin + "/api/threads/9/annotations", { method: "POST", headers: authorized(surface), body: "{}" })).status).toBe(403);
  expect((await fetch(surface.origin + "/api/threads/8/interactions", { method: "POST", headers: authorized(surface), body: "{}" })).status).toBe(403);
});
