import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { startGraphOperationRecorder } from "../desktop/main/services/graph-operation-recorder.mjs";
import { GraphCompleteRuntimeService } from "../desktop/main/services/graphcomplete-runtime.mjs";

const resources = [];
const directories = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const resource of resources.splice(0).reverse()) await resource.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function startUpstream({ holdNodeResponse = false, rejectVisualAssetOperations = false } = {}) {
  let resolveSlowSearchStarted;
  const slowSearchStarted = new Promise((resolve) => { resolveSlowSearchStarted = resolve; });
  let resolveNodeStarted;
  const nodeStarted = new Promise((resolve) => { resolveNodeStarted = resolve; });
  let releaseNodeResponse;
  const nodeResponseReleased = new Promise((resolve) => { releaseNodeResponse = resolve; });
  let abortedSearches = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if ((request.url === "/api/graph/visual-assets/operations"
      || request.url === "/api/control/visual-assets/imports/validate"
      || request.url === "/api/control/conversation-import-stages/test/visual-asset-contents") && request.method === "POST") {
      if (rejectVisualAssetOperations && request.url === "/api/graph/visual-assets/operations") {
        response.writeHead(422, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { code: "invalid_request" } }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
      return;
    }
    if (request.url.startsWith("/api/control/nodes/2/detail-assets/asset-1") && request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      const size = request.url.includes("oversized") ? 13 * 1024 * 1024 : 8 * 1024 * 1024;
      response.end(JSON.stringify({ contentBase64: Buffer.alloc(size, 7).toString("base64") }));
      return;
    }
    if (request.url === "/api/control/capabilities" && request.method === "POST") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ graphToken: body.graphToken }));
      return;
    }
    if (request.url === "/api/control/capabilities" && request.method === "DELETE") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ revoked: 1 }));
      return;
    }
    if (request.url === "/api/graph/current/transitions" && request.method === "POST") {
      const kind = body.transition.kind;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ completionId: 17, lifecycle: { advance: "active", return: "succeeded", stop: "stopped" }[kind],
        currentLayerId: 9, finalLayerId: kind === "return" ? 9 : null, privateField: "private response" }));
      return;
    }
    if (request.url === "/api/graph/nodes" && request.method === "POST") {
      resolveNodeStarted();
      if (holdNodeResponse) await nodeResponseReleased;
      else await new Promise((resolve) => setTimeout(resolve, 35));
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ node: { id: 41, state: "draft" } }));
      return;
    }
    if (request.url === "/api/graph/input" && request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ interaction: { id: 17 } }));
      return;
    }
    if (request.url === "/api/graph/search" && request.method === "POST") {
      if (body.target?.database !== undefined || body.budget?.database !== undefined
        || (body.target?.scope !== undefined && !["thread", "project"].includes(body.target.scope))) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { code: "invalid_request", message: "unknown field" } }));
        return;
      }
      if (body.query === "SLOW") {
        resolveSlowSearchStarted();
        await new Promise((resolve) => {
          const timeout = setTimeout(resolve, 5_000);
          response.once("close", () => {
            clearTimeout(timeout);
            if (!response.writableEnded) abortedSearches += 1;
            resolve();
          });
        });
        if (response.destroyed) return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        columns: ["layer"],
        rows: [[{ type: "layer", id: "layer:9", state: "accepted" }]],
        truncated: false,
      }));
      return;
    }
    response.writeHead(403, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "forbidden", message: "no" } }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const resource = {
    url: `http://127.0.0.1:${address.port}`,
    slowSearchStarted,
    nodeStarted,
    releaseNodeResponse,
    abortedSearches: () => abortedSearches,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
  resources.push(resource);
  return resource;
}

async function jsonRequest(url, { method = "GET", token, body } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

async function bindCapability(recorderUrl, token, nodeId = 17) {
  const result = await jsonRequest(`${recorderUrl}/api/control/capabilities`, {
    method: "POST",
    token: "control-secret",
    body: { nodeId, graphToken: token },
  });
  expect(result.status).toBe(200);
}

async function createCandidateTraceDirectory() {
  const root = await mkdtemp(join(tmpdir(), "relayer-graph-operation-recorder-"));
  directories.push(root);
  const target = join(root, "candidate-trace");
  await mkdir(target, { recursive: true });
  const manifest = {
    schemaVersion: 1,
    format: "relayer-harness-trace-v1",
    interactionNodeId: 17,
    artifacts: {
      events: { ref: "events.jsonl", sha256: "sha256:provider-events", byteLength: 12, eventCount: 1 },
      attachments: [],
    },
  };
  await writeFile(join(target, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(target, "events.jsonl"), "provider\n");
  return target;
}

function rawTargetRequest(origin, target) {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: url.hostname,
      port: url.port,
      method: "GET",
      path: target,
    }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    request.once("error", reject);
    request.end();
  });
}

describe("desktop graph-operation recorder", () => {
  it("exports closed transition outcomes without stop reasons or request payloads", async () => {
    const upstream = await startUpstream();
    const recorder = await startGraphOperationRecorder({ upstreamUrl: upstream.url });
    resources.push(recorder);
    await bindCapability(recorder.url, "transition-token");
    for (const kind of ["advance", "return", "stop"]) {
      await jsonRequest(`${recorder.url}/api/graph/current/transitions`, { method: "POST", token: "transition-token",
        body: { transition: { kind, reason: "private reason" } } });
    }
    const target = await createCandidateTraceDirectory();
    await recorder.exportInteraction(17, target);
    const text = await readFile(join(target, "graph-operations.jsonl"), "utf8");
    const records = text.trim().split("\n").map(JSON.parse);
    expect(records.map((record) => record.transitionKind)).toEqual(["advance", "return", "stop"]);
    expect(records[1]).toMatchObject({ completionLifecycle: "succeeded", completionRootLayerId: 9 });
    expect(text).not.toContain("private");
    expect(text).not.toContain("transition-token");
  });

  it("attributes provider-neutral graph receipts and sequences them by completed response", async () => {
    const upstream = await startUpstream();
    const recorder = await startGraphOperationRecorder({ upstreamUrl: upstream.url });
    resources.push(recorder);
    const token = "opaque-graph-token-do-not-persist";
    await bindCapability(recorder.url, token);

    const slow = jsonRequest(`${recorder.url}/api/graph/nodes`, {
      method: "POST",
      token,
      body: { title: "private request body", detail: "not evidence" },
    });
    const fast = jsonRequest(`${recorder.url}/api/graph/input`, { token });
    const [slowResult, fastResult] = await Promise.all([slow, fast]);
    expect(slowResult.status).toBe(201);
    expect(fastResult.status).toBe(200);
    expect((await jsonRequest(`${recorder.url}/api/graph/search`, {
      method: "POST",
      token,
      body: {
        queryContractVersion: 1,
        target: { scope: "project", id: 23 },
        query: "MATCH (l:Layer)-[:CONTAINS]->(n:Content) WHERE n.title = $anchor RETURN l AS layer",
        parameters: { anchor: { type: "string", value: "private anchor" } },
        budget: { resultRows: 2, note: `normal-${token}-suffix` },
      },
    })).status).toBe(200);
    expect((await jsonRequest(`${recorder.url}/api/graph/not-a-route`, { token })).status).toBe(403);

    const target = await createCandidateTraceDirectory();
    const descriptor = await recorder.exportInteraction(17, target);
    const eventsText = await readFile(join(target, "graph-operations.jsonl"), "utf8");
    const events = eventsText.trim().split("\n").map((line) => JSON.parse(line));
    const manifest = JSON.parse(await readFile(join(target, "manifest.json"), "utf8"));

    expect(events.map((event) => event.path)).toEqual([
      "/api/graph/input",
      "/api/graph/nodes",
      "/api/graph/search",
      "/api/graph/not-a-route",
    ]);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(events[1]).toMatchObject({ status: 201, recordKind: "node", recordId: 41, recordState: "draft" });
    expect(events[2]).toMatchObject({
      status: 200,
      queryContractVersion: 1,
      target: { scope: "project", id: 23 },
      query: "MATCH (l:Layer)-[:CONTAINS]->(n:Content) WHERE n.title = $anchor RETURN l AS layer",
      parameters: { anchor: { type: "string", value: "private anchor" } },
      budget: { resultRows: 2 },
      searchLayerIds: [9],
      resultTruncated: false,
    });
    expect(events[3]).toMatchObject({ status: 403, errorCodes: ["forbidden"] });
    expect(descriptor).toMatchObject({
      status: "complete",
      format: "relayer-graph-operations-v1",
      eventCount: 4,
      truncated: false,
      ref: "graph-operations.jsonl",
    });
    expect(descriptor.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(manifest.artifacts.events.sha256).toBe("sha256:provider-events");
    expect(manifest.artifacts.graphOperations).toEqual(descriptor);
    expect(`${eventsText}\n${JSON.stringify(manifest)}`).not.toContain(token);
    expect(`${eventsText}\n${JSON.stringify(manifest)}`).not.toContain("control-secret");
    expect(eventsText).not.toContain("private request body");
    expect(eventsText).toContain("private anchor");
  });

  it("scrubs known credentials from query substrings and nested ordinary values", async () => {
    const upstream = await startUpstream();
    const recorder = await startGraphOperationRecorder({ upstreamUrl: upstream.url });
    resources.push(recorder);
    const token = "graph-secret-value";
    await bindCapability(recorder.url, token);
    await jsonRequest(`${recorder.url}/api/graph/search`, {
      method: "POST",
      token,
      body: {
        queryContractVersion: 1,
        query: `MATCH (n:Content) WHERE n.title = '${token}' RETURN n`,
        parameters: {
          ordinary: { type: "string", value: `prefix-${token}-suffix` },
          nested: { type: "record", fields: [{ name: "safe", value: { type: "string", value: token } }] },
        },
        budget: { diagnostic: `contains-${token}` },
      },
    });
    const target = await createCandidateTraceDirectory();
    await recorder.exportInteraction(17, target);
    const text = await readFile(join(target, "graph-operations.jsonl"), "utf8");
    expect(text).not.toContain(token);
    expect(text).toContain("prefix-[REDACTED]-suffix");
    expect(text).toContain("MATCH (n:Content)");
  });

  it("scrubs sensitive tagged-record fields without discarding non-sensitive typed evidence", async () => {
    const upstream = await startUpstream();
    const recorder = await startGraphOperationRecorder({ upstreamUrl: upstream.url });
    resources.push(recorder);
    await bindCapability(recorder.url, "ordinary-graph-token");
    await jsonRequest(`${recorder.url}/api/graph/search`, {
      method: "POST",
      token: "ordinary-graph-token",
      body: {
        queryContractVersion: 1,
        query: "MATCH (n:Content) WHERE n.title = $profile RETURN n",
        parameters: {
          profile: {
            type: "record",
            fields: [
              { name: "topic", value: { type: "string", value: "retained topic" } },
              { name: "password", value: { type: "string", value: "unknown-password-value" } },
              {
                name: "history",
                value: {
                  type: "list",
                  elementType: { kind: "record", fields: [] },
                  values: [{
                    type: "record",
                    fields: [
                      { name: "note", value: { type: "string", value: "retained nested note" } },
                      { name: "apiToken", value: { type: "string", value: "unknown-nested-token" } },
                    ],
                  }],
                },
              },
            ],
          },
        },
        budget: {},
      },
    });

    const target = await createCandidateTraceDirectory();
    await recorder.exportInteraction(17, target);
    const eventsText = await readFile(join(target, "graph-operations.jsonl"), "utf8");
    const [event] = eventsText.trim().split("\n").map((line) => JSON.parse(line));
    expect(event.parameters.profile.fields).toEqual([
      { name: "topic", value: { type: "string", value: "retained topic" } },
      { name: "password", value: "[REDACTED]" },
      {
        name: "history",
        value: {
          type: "list",
          elementType: { kind: "record", fields: [] },
          values: [{
            type: "record",
            fields: [
              { name: "note", value: { type: "string", value: "retained nested note" } },
              { name: "apiToken", value: "[REDACTED]" },
            ],
          }],
        },
      },
    ]);
    expect(eventsText).not.toContain("unknown-password-value");
    expect(eventsText).not.toContain("unknown-nested-token");
  });

  it("persists only closed target and budget fields from a rejected search request", async () => {
    const upstream = await startUpstream();
    const recorder = await startGraphOperationRecorder({ upstreamUrl: upstream.url });
    resources.push(recorder);
    const token = "rejected-request-token";
    await bindCapability(recorder.url, token);
    const result = await jsonRequest(`${recorder.url}/api/graph/search`, {
      method: "POST",
      token,
      body: {
        queryContractVersion: 1,
        target: {
          scope: "project",
          id: 23,
          database: { credential: "target-database-secret", path: "/private/target.sqlite" },
          credential: { token: "target-credential-secret" },
          path: { socket: "/private/target.sock" },
        },
        query: "MATCH (n:Content) WHERE n.title = $anchor RETURN n",
        parameters: { anchor: { type: "string", value: "retained tagged parameter" } },
        budget: {
          resultRows: 2,
          wallTimeMs: 100,
          database: { credential: "budget-database-secret", path: "/private/budget.sqlite" },
          credential: { password: "budget-credential-secret" },
          path: { directory: "/private/results" },
        },
      },
    });
    expect(result).toMatchObject({ status: 400, body: { error: { code: "invalid_request" } } });
    const invalidScope = "/private/invalid-target-scope";
    const invalidScopeResult = await jsonRequest(`${recorder.url}/api/graph/search`, {
      method: "POST",
      token,
      body: {
        queryContractVersion: 1,
        target: { scope: invalidScope, id: 24 },
        query: "MATCH (n:Content) RETURN n",
        parameters: {},
        budget: { resultRows: 1 },
      },
    });
    expect(invalidScopeResult).toMatchObject({
      status: 400,
      body: { error: { code: "invalid_request" } },
    });

    const target = await createCandidateTraceDirectory();
    await recorder.exportInteraction(17, target);
    const eventsText = await readFile(join(target, "graph-operations.jsonl"), "utf8");
    const events = eventsText.trim().split("\n").map((line) => JSON.parse(line));
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      status: 400,
      target: { scope: "project", id: 23 },
      query: "MATCH (n:Content) WHERE n.title = $anchor RETURN n",
      parameters: { anchor: { type: "string", value: "retained tagged parameter" } },
      budget: { resultRows: 2, wallTimeMs: 100 },
      errorCodes: ["invalid_request"],
    });
    expect(Object.keys(events[0].target)).toEqual(["scope", "id"]);
    expect(Object.keys(events[0].budget)).toEqual(["wallTimeMs", "resultRows"]);
    expect(events[1]).toMatchObject({
      status: 400,
      query: "MATCH (n:Content) RETURN n",
      parameters: {},
      budget: { resultRows: 1 },
      errorCodes: ["invalid_request"],
    });
    expect(events[1]).not.toHaveProperty("target");
    expect(eventsText).not.toContain(invalidScope);
    for (const forbidden of [
      "database",
      "credential",
      "socket",
      "directory",
      "target-database-secret",
      "target-credential-secret",
      "budget-database-secret",
      "budget-credential-secret",
      "/private/target.sqlite",
      "/private/budget.sqlite",
      "/private/results",
    ]) {
      expect(eventsText).not.toContain(forbidden);
    }
  });

  it("propagates downstream abort and does not record a cancelled search response", async () => {
    const upstream = await startUpstream();
    const recorder = await startGraphOperationRecorder({ upstreamUrl: upstream.url });
    resources.push(recorder);
    const token = "abort-token";
    await bindCapability(recorder.url, token);
    const controller = new AbortController();
    const pending = fetch(`${recorder.url}/api/graph/search`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ queryContractVersion: 1, query: "SLOW", parameters: {}, budget: {} }),
      signal: controller.signal,
    });
    await upstream.slowSearchStarted;
    controller.abort();
    await expect(pending).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(upstream.abortedSearches()).toBe(1);
    const target = await createCandidateTraceDirectory();
    const descriptor = await recorder.exportInteraction(17, target);
    expect(descriptor.eventCount).toBe(0);
  });

  it("waits for attributed in-flight work before sealing", async () => {
    const upstream = await startUpstream({ holdNodeResponse: true });
    const recorder = await startGraphOperationRecorder({ upstreamUrl: upstream.url });
    resources.push(recorder);
    const token = "in-flight-token";
    await bindCapability(recorder.url, token);
    const pendingRequest = jsonRequest(`${recorder.url}/api/graph/nodes`, { method: "POST", token, body: {} });
    await upstream.nodeStarted;
    const target = await createCandidateTraceDirectory();
    const exportPromise = recorder.exportInteraction(17, target);
    let exportSettled = false;
    void exportPromise.then(
      () => { exportSettled = true; },
      () => { exportSettled = true; },
    );
    try {
      await new Promise((resolve) => setImmediate(resolve));
      expect(exportSettled).toBe(false);
    } finally {
      upstream.releaseNodeResponse();
    }
    await pendingRequest;
    const descriptor = await exportPromise;
    expect(descriptor.eventCount).toBe(1);
    expect(await readFile(join(target, "graph-operations.jsonl"), "utf8")).toContain('"recordId":41');
  });

  it("fails partial on bounded export settlement instead of sealing around a hung request", async () => {
    const upstream = await startUpstream();
    const recorder = await startGraphOperationRecorder({ upstreamUrl: upstream.url, settleTimeoutMs: 25 });
    resources.push(recorder);
    const token = "settlement-token";
    await bindCapability(recorder.url, token);
    const pending = jsonRequest(`${recorder.url}/api/graph/search`, {
      method: "POST",
      token,
      body: { queryContractVersion: 1, query: "SLOW", parameters: {}, budget: {} },
    });
    await upstream.slowSearchStarted;
    const target = await createCandidateTraceDirectory();
    const descriptor = await recorder.exportInteraction(17, target);
    expect(descriptor).toMatchObject({ status: "partial", promotable: false, eventCount: 0, discardedEvents: 1 });
    expect((await pending).status).toBe(502);
    expect(upstream.abortedSearches()).toBe(1);
  });

  it("removes stale attribution after same-node remint replacement and revocation", async () => {
    const upstream = await startUpstream();
    const recorder = await startGraphOperationRecorder({ upstreamUrl: upstream.url });
    resources.push(recorder);
    await bindCapability(recorder.url, "old-token");
    await jsonRequest(`${recorder.url}/api/graph/input`, { token: "old-token" });
    await bindCapability(recorder.url, "new-token");
    await jsonRequest(`${recorder.url}/api/graph/input`, { token: "old-token" });
    await jsonRequest(`${recorder.url}/api/graph/input`, { token: "new-token" });
    expect((await jsonRequest(`${recorder.url}/api/control/capabilities`, {
      method: "DELETE",
      token: "control-secret",
      body: { graphToken: "new-token" },
    })).status).toBe(200);
    await jsonRequest(`${recorder.url}/api/graph/input`, { token: "new-token" });
    const target = await createCandidateTraceDirectory();
    const descriptor = await recorder.exportInteraction(17, target);
    expect(descriptor.eventCount).toBe(2);
  });

  it("fails closed with explicit bounded truncation and rejects escaped proxy targets", async () => {
    const upstream = await startUpstream();
    const recorder = await startGraphOperationRecorder({
      upstreamUrl: upstream.url,
      maxEventsPerInteraction: 2,
      maxBytesPerInteraction: 2_000,
    });
    resources.push(recorder);
    const token = "bounded-token";
    await bindCapability(recorder.url, token);
    await jsonRequest(`${recorder.url}/api/graph/input`, { token });
    await jsonRequest(`${recorder.url}/api/graph/search`, { method: "POST", token, body: {} });
    await jsonRequest(`${recorder.url}/api/graph/not-a-route`, { token });

    expect(await rawTargetRequest(recorder.url, "http://example.com/api/graph/input")).toBe(400);
    const target = await createCandidateTraceDirectory();
    const descriptor = await recorder.exportInteraction(17, target);
    expect(descriptor).toMatchObject({
      status: "partial",
      promotable: false,
      eventCount: 2,
      truncated: true,
      discardedEvents: 1,
    });
    expect(descriptor.discardedBytes).toBeGreaterThan(0);
    expect((await readFile(join(target, "graph-operations.jsonl"), "utf8")).trim().split("\n")).toHaveLength(2);
  });

  it("attaches graph evidence without changing candidate provider-trace digest semantics", async () => {
    const upstream = await startUpstream();
    const recorder = await startGraphOperationRecorder({
      upstreamUrl: upstream.url,
      maxEventsPerInteraction: 1,
    });
    resources.push(recorder);
    const token = "runtime-export-token";
    await bindCapability(recorder.url, token);
    await jsonRequest(`${recorder.url}/api/graph/input`, { token });
    await jsonRequest(`${recorder.url}/api/graph/search`, { method: "POST", token, body: {} });
    const root = await mkdtemp(join(tmpdir(), "relayer-runtime-graph-operation-export-"));
    directories.push(root);
    const target = join(root, "candidate-trace");
    const providerDescriptor = {
      status: "complete",
      format: "relayer-harness-trace-v1",
      sha256: "sha256:provider-events",
      byteLength: 12,
      eventCount: 1,
      coverage: {},
    };
    const runtime = new GraphCompleteRuntimeService({
      userDataDirectory: root,
      graphServerBinary: "unused",
      configurationPaths: [],
    });
    runtime.harnessHost = {
      host: {
        async exportCandidateTrace(productInteractionId, targetDirectory, correlation) {
          expect(productInteractionId).toBe(77);
          expect(correlation).toEqual({ executionId: "execution-1" });
          await mkdir(targetDirectory, { recursive: true });
          await writeFile(join(targetDirectory, "events.jsonl"), "provider\n");
          await writeFile(join(targetDirectory, "manifest.json"), `${JSON.stringify({
            schemaVersion: 1,
            format: "relayer-harness-trace-v1",
            interactionNodeId: 17,
            productInteractionId: 77,
            artifacts: {
              events: { ref: "events.jsonl", sha256: providerDescriptor.sha256, byteLength: 12, eventCount: 1 },
              attachments: [],
            },
          }, null, 2)}\n`);
          return providerDescriptor;
        },
      },
    };
    runtime.graphOperationRecorder = recorder;

    const exported = await runtime.exportCandidateTrace(77, target, { executionId: "execution-1" });
    const manifest = JSON.parse(await readFile(join(target, "manifest.json"), "utf8"));
    expect(exported).toMatchObject({
      status: "partial",
      promotable: false,
      sha256: "sha256:provider-events",
      graphOperations: {
        status: "partial",
        format: "relayer-graph-operations-v1",
        eventCount: 1,
        truncated: true,
      },
    });
    expect(manifest.artifacts.events.sha256).toBe("sha256:provider-events");
    expect(manifest.artifacts.graphOperations.sha256).toBe(exported.graphOperations.sha256);
  });
});

it("preserves bounded asset request/response parity without widening ordinary graph operations", async () => {
  const upstream = await startUpstream();
  const recorder = await startGraphOperationRecorder({ upstreamUrl: upstream.url });
  resources.push(recorder);
  const token = "asset-recorder-token";
  await bindCapability(recorder.url, token);
  const bytesBase64 = Buffer.alloc(8 * 1024 * 1024, 7).toString("base64");
  const result = await jsonRequest(`${recorder.url}/api/graph/visual-assets/operations`, {
    method: "POST", token, body: { kind: "add", file: { contentBase64: bytesBase64 } },
  });
  expect(result.status).toBe(200);
  expect(result.body.file.contentBase64).toBe(bytesBase64);
  const downloaded = await jsonRequest(`${recorder.url}/api/control/nodes/2/detail-assets/asset-1`);
  expect(downloaded.status).toBe(200);
  expect(downloaded.body.contentBase64).toBe(bytesBase64);
  expect((await jsonRequest(`${recorder.url}/api/control/nodes/2/detail-assets/asset-1?oversized`)).status).toBe(502);
  const target = await createCandidateTraceDirectory();
  const trace = await recorder.exportInteraction(17, target);
  expect(trace.eventCount).toBe(1);
  const receipts = await readFile(join(target, "graph-operations.jsonl"), "utf8");
  expect(receipts).not.toContain(bytesBase64.slice(0, 80));
  expect(receipts).not.toContain(token);
  for (const path of ["/api/control/visual-assets/imports/validate", "/api/control/conversation-import-stages/test/visual-asset-contents"]) {
    expect((await jsonRequest(`${recorder.url}${path}`, {
      method: "POST", body: { contentBase64: bytesBase64 },
    })).status).toBe(200);
  }
  await expect(jsonRequest(`${recorder.url}/api/graph/nodes`, {
    method: "POST", body: { bytesBase64 },
  })).resolves.toMatchObject({ status: 502 });
  await expect(jsonRequest(`${recorder.url}/api/graph/visual-assets/operations`, {
    method: "POST", body: { bytesBase64: "x".repeat(12 * 1024 * 1024) },
  })).resolves.toMatchObject({ status: 502 });
});


it("captures caught compiler failures and server origins once without preserving authored text", async () => {
  const { RelayerGraphClient, NodeObject, html, css } = await import("../packages/graph-client/src/index.ts");
  const { authoringErrorsFromOperations } = await import("../desktop/eval-main/authoring-errors.mjs");
  const { graphTimingFromTrace } = await import("../desktop/eval-main/graph-timing.mjs");
  const upstream = await startUpstream();
  const recorder = await startGraphOperationRecorder({ upstreamUrl: upstream.url }); resources.push(recorder);
  const token = "compiler-diagnostic-secret"; await bindCapability(recorder.url, token);
  const client = new RelayerGraphClient({ url: recorder.url, token, nodeId: 17, authoringErrors: true });
  const broken = new NodeObject("info", "Private authored title", "Private authored prose", "concept", "broken");
  broken.detailAuthoring.setComponent("main", html`<p>Private authored prose</p>`, css`p { cursor: pointer; }`);
  await expect(client.checkpointNodeDetail(broken)).rejects.toThrow();
  // Same defect in a fresh attempt is another failure.
  await expect(client.checkpointNodeDetail(broken)).rejects.toThrow();
  // A checkpoint joining a failed submit sees the same compiler-origin incident.
  const submission = client.submitNode(broken);
  const joinedCheckpoint = client.checkpointNodeDetail(broken);
  await expect(submission).rejects.toThrow();
  await expect(joinedCheckpoint).rejects.toThrow();
  // Server failures are already origins, so the client must not emit a duplicate.
  await expect(client.createEdge(1, 2, "edge")).rejects.toThrow();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const target = await createCandidateTraceDirectory(); await recorder.exportInteraction(17, target);
  const text = await readFile(join(target, "graph-operations.jsonl"), "utf8");
  const records = text.trim().split("\n").map(JSON.parse);
  expect(authoringErrorsFromOperations(records)).toMatchObject({ observed: 4, total: null, byCause: { compiler: 3, server_rejection: 1 } });
  expect(graphTimingFromTrace({ sentAt: records[0].observedAt, graphOperations: records, ledgerComplete: true })).toMatchObject({ graphWriteRejections: 1 });
  expect(text).not.toContain(token); expect(text).not.toContain("Private authored");
  expect(records.filter((record) => record.authoringError).every((record) => record.authoringError.codes.includes("unsafe_css"))).toBe(true);
  expect((await jsonRequest(`${recorder.url}/api/graph/authoring-errors`, { method: "POST", token: "wrong", body: {} })).status).toBe(401);
});


it("diagnostic overflow cannot truncate graph proof", async () => {
  const upstream = await startUpstream();
  const recorder = await startGraphOperationRecorder({ upstreamUrl: upstream.url, maxEventsPerInteraction: 1, maxAuthoringDiagnosticsPerInteraction: 1 });
  resources.push(recorder); const token = "bounded-diagnostics"; await bindCapability(recorder.url, token);
  for (const id of ["00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000002"]) {
    await jsonRequest(`${recorder.url}/api/graph/authoring-errors`, { method: "POST", token,
      body: { schemaVersion: 1, id, phase: "compiler", codes: ["unsafe_css"] } });
  }
  await jsonRequest(`${recorder.url}/api/graph/nodes`, { method: "POST", token, body: { clientKey: "valid" } });
  const target = await createCandidateTraceDirectory(); const descriptor = await recorder.exportInteraction(17, target);
  expect(descriptor).toMatchObject({ status: "complete", promotable: true, truncated: false, eventCount: 2, authoringDiagnosticsDiscarded: 1 });
  const lines = (await readFile(join(target, "graph-operations.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  expect(lines.at(-1)).toMatchObject({ path: "/api/graph/nodes", status: 201 });
});


it("captures a caught template failure before any graph method is called", async () => {
  const { html } = await import("../packages/graph-client/src/index.ts");
  const upstream = await startUpstream(); const recorder = await startGraphOperationRecorder({ upstreamUrl: upstream.url }); resources.push(recorder);
  const token = "standalone-template-secret"; await bindCapability(recorder.url, token);
  vi.stubEnv("RELAYER_GRAPH_URL", recorder.url); vi.stubEnv("RELAYER_GRAPH_TOKEN", token);
  vi.stubEnv("RELAYER_NODE_ID", "17"); vi.stubEnv("RELAYER_GRAPH_AUTHORING_ERRORS", "1");
  expect(() => html`<section>${html`<p>Nested private prose</p>`}</section>`).toThrow();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const target = await createCandidateTraceDirectory(); await recorder.exportInteraction(17, target);
  const text = await readFile(join(target, "graph-operations.jsonl"), "utf8");
  const events = text.trim().split("\n").map(JSON.parse);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ authoringError: { phase: "compiler", codes: ["detail_template_nested"] } });
  expect(text).not.toContain("Nested private prose"); expect(text).not.toContain(token);
});

it("counts visual-asset mutations while excluding multiplexed reads and retaining only known kinds", async () => {
  const { authoringErrorsFromOperations } = await import("../desktop/eval-main/authoring-errors.mjs");
  const upstream = await startUpstream({ rejectVisualAssetOperations: true });
  const recorder = await startGraphOperationRecorder({ upstreamUrl: upstream.url }); resources.push(recorder);
  const token = "asset-authoring-secret"; await bindCapability(recorder.url, token);
  const writes = ["add", "create-tag", "move-tag", "associate", "organize", "archive"];
  const reads = ["list-assets", "list-tags", "list-registries", "find", "inspect", "download"];
  const { RelayerGraphClient } = await import("../packages/graph-client/src/index.ts");
  const assets = new RelayerGraphClient({ url: recorder.url, token, nodeId: 17 }).visualAssets;
  const scope = { kind: "thread", threadId: 17 };
  for (const attempt of [
    () => assets.add({ scope, name: "private asset name", file: { name: "private file", mediaType: "image/png", read: async () => Buffer.from("private bytes") } }),
    () => assets.createTag({ scope, name: "private tag" }),
    () => assets.moveTag({ scope, tagId: "private tag", parentTagId: null }),
    () => assets.associate({ scope, assetId: "private asset" }),
    () => assets.organize({ scope, assetId: "private asset", addTagIds: [], removeTagIds: [] }),
    () => assets.archive("private asset", scope),
    () => assets.listAssets({ scope }), () => assets.listTags({ scope }),
    () => assets.listRegistries({ scope }), () => assets.find({ scope, tagId: "private tag" }),
    () => assets.inspect("private asset", scope), () => assets.download("private asset", scope),
  ]) await expect(attempt()).rejects.toThrow();
  for (const body of [{ operation: { kind: "private-unknown-kind" } }, { kind: "add" }]) {
    expect(await jsonRequest(`${recorder.url}/api/graph/visual-assets/operations`, { method: "POST", token, body })).toMatchObject({ status: 422 });
  }
  const target = await createCandidateTraceDirectory(); await recorder.exportInteraction(17, target);
  const text = await readFile(join(target, "graph-operations.jsonl"), "utf8");
  const records = text.trim().split("\n").map(JSON.parse);
  expect(records.map((record) => record.visualAssetOperationKind)).toEqual([...writes, ...reads, undefined, undefined]);
  expect(authoringErrorsFromOperations(records)).toMatchObject({ observed: 6, total: null, byCause: { server_rejection: 6 } });
  for (const privateValue of [token, "private asset name", "private bytes", "private-unknown-kind"]) expect(text).not.toContain(privateValue);
});

it("captures recursive preparation and icon-write origins without counting reads or changing publication timing", async () => {
  const { RelayerGraphClient } = await import("../packages/graph-client/src/index.ts");
  const { authoringErrorsFromOperations } = await import("../desktop/eval-main/authoring-errors.mjs");
  const { graphTimingFromTrace } = await import("../desktop/eval-main/graph-timing.mjs");
  const upstream = await startUpstream();
  const recorder = await startGraphOperationRecorder({ upstreamUrl: upstream.url }); resources.push(recorder);
  const token = "recursive-authoring-secret"; await bindCapability(recorder.url, token);
  const client = new RelayerGraphClient({ url: recorder.url, token, nodeId: 17, authoringErrors: true });
  await expect(client.prepareComplete({})).rejects.toThrow();
  await expect(client.prepareComplete(123)).rejects.toThrow();
  await expect(client.proposeThreadIcon("private icon proposal")).rejects.toThrow();
  await expect(client.getNode(999)).rejects.toThrow();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const target = await createCandidateTraceDirectory(); await recorder.exportInteraction(17, target);
  const text = await readFile(join(target, "graph-operations.jsonl"), "utf8");
  const records = text.trim().split("\n").map(JSON.parse);
  expect(authoringErrorsFromOperations(records)).toMatchObject({ observed: 3, total: null, byCause: { client: 1, server_rejection: 2 } });
  expect(graphTimingFromTrace({ sentAt: records[0].observedAt, graphOperations: records, ledgerComplete: true })).toMatchObject({ graphWriteRejections: 0 });
  expect(text).not.toContain(token); expect(text).not.toContain("private icon proposal");
});


it.each([false, true])("settles partially transmitted diagnostics independently of graph proof (timeout=%s)", async (timeout) => {
  const upstream = await startUpstream();
  const recorder = await startGraphOperationRecorder({ upstreamUrl: upstream.url, settleTimeoutMs: timeout ? 30 : 1_000 });
  resources.push(recorder);
  const token = "partial-body-diagnostic";
  await bindCapability(recorder.url, token);
  const body = JSON.stringify({ schemaVersion: 1, id: "00000000-0000-0000-0000-000000000001", phase: "compiler", codes: ["unsafe_css"] });
  const request = httpRequest(`${recorder.url}/api/graph/authoring-errors`, { method: "POST", headers: {
    authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": Buffer.byteLength(body), expect: "100-continue",
  } });
  const response = new Promise((resolve) => {
    request.on("response", (response) => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
    request.on("error", () => resolve("aborted"));
  });
  const started = new Promise((resolve) => request.once("continue", resolve));
  request.flushHeaders();
  await started; // Server has entered the real request handler, before the body can finish.
  request.write(body.slice(0, 10));
  const target = await createCandidateTraceDirectory();
  const exportWork = recorder.exportInteraction(17, target);
  if (!timeout) request.end(body.slice(10));
  const descriptor = await exportWork;
  expect(await response).toBe(timeout ? "aborted" : 202);
  expect(descriptor).toMatchObject({ status: "complete", promotable: true, truncated: false, eventCount: timeout ? 0 : 1 });
  if (timeout) expect(descriptor.authoringDiagnosticsDiscarded).toBe(1);
  else expect(descriptor.authoringDiagnosticsDiscarded).toBeUndefined();
});

it("restricts candidate-supplied diagnostic codes and authenticates completion attribution", async () => {
  const upstream = await startUpstream();
  const recorder = await startGraphOperationRecorder({ upstreamUrl: upstream.url }); resources.push(recorder);
  const token = "private_identifier_text"; await bindCapability(recorder.url, token);
  const diagnostic = { schemaVersion: 1, id: "00000000-0000-0000-0000-000000000001", phase: "compiler", codes: ["unsafe_css"] };
  for (const body of [{ ...diagnostic, codes: ["private_authored_prose"] }, { ...diagnostic, codes: [token] },
    { ...diagnostic, phase: "server" }, { ...diagnostic, interactionNodeId: 99 }, { ...diagnostic, phase: "client" }]) {
    expect((await jsonRequest(`${recorder.url}/api/graph/authoring-errors`, { method: "POST", token, body })).status).toBe(400);
  }
  expect((await jsonRequest(`${recorder.url}/api/graph/authoring-errors`, { method: "POST", token: "foreign", body: diagnostic })).status).toBe(401);
  const { reportAuthoringError } = await import("../packages/graph-client/src/authoring-errors.ts");
  // An unsupported compiler issue must become a fixed fallback, even if it resembles a safe identifier.
  const fetchOriginal = globalThis.fetch;
  let settled;
  const sent = new Promise((resolve) => { settled = resolve; });
  vi.stubGlobal("fetch", async (...args) => { const response = await fetchOriginal(...args); settled(response.status); return response; });
  try {
    reportAuthoringError({ url: recorder.url, token, nodeId: 17, authoringErrors: true }, new Error("private prose"), ["private_authored_prose"]);
    expect(await sent).toBe(202);
  } finally { vi.stubGlobal("fetch", fetchOriginal); }
  const target = await createCandidateTraceDirectory(); await recorder.exportInteraction(17, target);
  const text = await readFile(join(target, "graph-operations.jsonl"), "utf8");
  const record = JSON.parse(text.trim());
  expect(record).toMatchObject({ interactionNodeId: 17, authoringError: { phase: "compiler", codes: ["compiler_validation"] } });
  expect(text).not.toContain("private");
});


it("bounds an attributed graph request stalled before its body finishes", async () => {
  const upstream = await startUpstream();
  const recorder = await startGraphOperationRecorder({ upstreamUrl: upstream.url, settleTimeoutMs: 30 }); resources.push(recorder);
  const token = "stalled-graph-body"; await bindCapability(recorder.url, token);
  const request = httpRequest(`${recorder.url}/api/graph/nodes`, { method: "POST", headers: {
    authorization: `Bearer ${token}`, "content-length": 100, expect: "100-continue",
  } });
  const aborted = new Promise((resolve) => request.once("error", resolve));
  const started = new Promise((resolve) => request.once("continue", resolve));
  request.flushHeaders(); await started; request.write("{");
  const target = await createCandidateTraceDirectory();
  const descriptor = await recorder.exportInteraction(17, target);
  await aborted;
  expect(descriptor).toMatchObject({ status: "partial", promotable: false, truncated: true, eventCount: 0, discardedEvents: 1 });
  expect(descriptor.authoringDiagnosticsDiscarded).toBeUndefined();
});
