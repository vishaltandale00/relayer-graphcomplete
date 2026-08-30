import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { startGraphOperationRecorder } from "../desktop/main/services/graph-operation-recorder.mjs";
import { GraphCompleteRuntimeService } from "../desktop/main/services/graphcomplete-runtime.mjs";

const resources = [];
const directories = [];

afterEach(async () => {
  for (const resource of resources.splice(0).reverse()) await resource.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function startUpstream() {
  let resolveSlowSearchStarted;
  const slowSearchStarted = new Promise((resolve) => { resolveSlowSearchStarted = resolve; });
  let resolveNodeStarted;
  const nodeStarted = new Promise((resolve) => { resolveNodeStarted = resolve; });
  let abortedSearches = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8"));
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
    if (request.url === "/api/graph/nodes" && request.method === "POST") {
      resolveNodeStarted();
      await new Promise((resolve) => setTimeout(resolve, 35));
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
        query: "MATCH (l:Layer)-[:CONTAINS]->(n:Content) WHERE n.title = $anchor RETURN l AS layer",
        parameters: { anchor: { type: "string", value: "private anchor" } },
        budget: { note: `normal-${token}-suffix` },
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
      query: "MATCH (l:Layer)-[:CONTAINS]->(n:Content) WHERE n.title = $anchor RETURN l AS layer",
      parameters: { anchor: { type: "string", value: "private anchor" } },
      budget: { note: "normal-[REDACTED]-suffix" },
      searchLayerIds: [9],
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
    const upstream = await startUpstream();
    const recorder = await startGraphOperationRecorder({ upstreamUrl: upstream.url });
    resources.push(recorder);
    const token = "in-flight-token";
    await bindCapability(recorder.url, token);
    const pendingRequest = jsonRequest(`${recorder.url}/api/graph/nodes`, { method: "POST", token, body: {} });
    await upstream.nodeStarted;
    const target = await createCandidateTraceDirectory();
    const exportPromise = recorder.exportInteraction(17, target);
    await expect(Promise.race([
      exportPromise.then(() => "exported"),
      new Promise((resolve) => setTimeout(() => resolve("waiting"), 10)),
    ])).resolves.toBe("waiting");
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
