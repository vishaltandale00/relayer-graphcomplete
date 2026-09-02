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
  it("attributes provider-neutral receipts, scrubs secrets, and seals only faithful request records", async () => {
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
    expect(slowResult.status, "slow node creation status").toBe(201);
    expect(fastResult.status, "fast input read status").toBe(200);
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
    })).status, "search status").toBe(200);
    expect((await jsonRequest(`${recorder.url}/api/graph/not-a-route`, { token })).status, "unknown route status").toBe(403);

    const target = await createCandidateTraceDirectory();
    const descriptor = await recorder.exportInteraction(17, target);
    const eventsText = await readFile(join(target, "graph-operations.jsonl"), "utf8");
    const events = eventsText.trim().split("\n").map((line) => JSON.parse(line));
    const manifest = JSON.parse(await readFile(join(target, "manifest.json"), "utf8"));

    expect(events.map((event) => event.path), "receipts sequenced by completed response").toEqual([
      "/api/graph/input",
      "/api/graph/nodes",
      "/api/graph/search",
      "/api/graph/not-a-route",
    ]);
    expect(events.map((event) => event.sequence), "contiguous sequence numbers").toEqual([1, 2, 3, 4]);
    expect(events[1], "node receipt attributed from the response").toMatchObject({ status: 201, recordKind: "node", recordId: 41, recordState: "draft" });
    expect(events[2], "search receipt keeps faithful query evidence").toMatchObject({
      status: 200,
      queryContractVersion: 1,
      target: { scope: "project", id: 23 },
      query: "MATCH (l:Layer)-[:CONTAINS]->(n:Content) WHERE n.title = $anchor RETURN l AS layer",
      parameters: { anchor: { type: "string", value: "private anchor" } },
      budget: { resultRows: 2 },
      searchLayerIds: [9],
      resultTruncated: false,
    });
    expect(events[3], "rejected route keeps error codes").toMatchObject({ status: 403, errorCodes: ["forbidden"] });
    expect(descriptor, "complete export descriptor").toMatchObject({
      status: "complete",
      format: "relayer-graph-operations-v1",
      eventCount: 4,
      truncated: false,
      ref: "graph-operations.jsonl",
    });
    expect(descriptor.sha256, "descriptor digest shape").toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(manifest.artifacts.events.sha256, "provider event digest untouched").toBe("sha256:provider-events");
    expect(manifest.artifacts.graphOperations, "graph operations attached to the manifest").toEqual(descriptor);
    expect(`${eventsText}\n${JSON.stringify(manifest)}`, "graph token never persisted").not.toContain(token);
    expect(`${eventsText}\n${JSON.stringify(manifest)}`, "control secret never persisted").not.toContain("control-secret");
    expect(eventsText, "request bodies never persisted").not.toContain("private request body");
    expect(eventsText, "tagged query parameters retained").toContain("private anchor");

    const scrubUpstream = await startUpstream();
    const scrubRecorder = await startGraphOperationRecorder({ upstreamUrl: scrubUpstream.url });
    resources.push(scrubRecorder);
    const scrubToken = "graph-secret-value";
    await bindCapability(scrubRecorder.url, scrubToken);
    await jsonRequest(`${scrubRecorder.url}/api/graph/search`, {
      method: "POST",
      token: scrubToken,
      body: {
        queryContractVersion: 1,
        query: `MATCH (n:Content) WHERE n.title = '${scrubToken}' RETURN n`,
        parameters: {
          ordinary: { type: "string", value: `prefix-${scrubToken}-suffix` },
          nested: { type: "record", fields: [{ name: "safe", value: { type: "string", value: scrubToken } }] },
        },
        budget: { diagnostic: `contains-${scrubToken}` },
      },
    });
    await jsonRequest(`${scrubRecorder.url}/api/graph/search`, {
      method: "POST",
      token: scrubToken,
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
    const scrubTarget = await createCandidateTraceDirectory();
    await scrubRecorder.exportInteraction(17, scrubTarget);
    const scrubText = await readFile(join(scrubTarget, "graph-operations.jsonl"), "utf8");
    const scrubEvents = scrubText.trim().split("\n").map((line) => JSON.parse(line));
    expect(scrubText, "bound credentials scrubbed from every substring").not.toContain(scrubToken);
    expect(scrubText, "redaction marker keeps surrounding text").toContain("prefix-[REDACTED]-suffix");
    expect(scrubText, "query structure retained").toContain("MATCH (n:Content)");
    expect(scrubEvents[1].parameters.profile.fields, "sensitive tagged fields scrubbed, ordinary evidence retained").toEqual([
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
    expect(scrubText, "nested password value scrubbed").not.toContain("unknown-password-value");
    expect(scrubText, "nested token value scrubbed").not.toContain("unknown-nested-token");

    const rejectedUpstream = await startUpstream();
    const rejectedRecorder = await startGraphOperationRecorder({ upstreamUrl: rejectedUpstream.url });
    resources.push(rejectedRecorder);
    const rejectedToken = "rejected-request-token";
    await bindCapability(rejectedRecorder.url, rejectedToken);
    const rejectedResult = await jsonRequest(`${rejectedRecorder.url}/api/graph/search`, {
      method: "POST",
      token: rejectedToken,
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
    expect(rejectedResult, "unknown target and budget fields rejected upstream").toMatchObject({ status: 400, body: { error: { code: "invalid_request" } } });
    const invalidScope = "/private/invalid-target-scope";
    const invalidScopeResult = await jsonRequest(`${rejectedRecorder.url}/api/graph/search`, {
      method: "POST",
      token: rejectedToken,
      body: {
        queryContractVersion: 1,
        target: { scope: invalidScope, id: 24 },
        query: "MATCH (n:Content) RETURN n",
        parameters: {},
        budget: { resultRows: 1 },
      },
    });
    expect(invalidScopeResult, "invalid scope rejected upstream").toMatchObject({
      status: 400,
      body: { error: { code: "invalid_request" } },
    });

    const rejectedTarget = await createCandidateTraceDirectory();
    await rejectedRecorder.exportInteraction(17, rejectedTarget);
    const rejectedText = await readFile(join(rejectedTarget, "graph-operations.jsonl"), "utf8");
    const rejectedEvents = rejectedText.trim().split("\n").map((line) => JSON.parse(line));
    expect(rejectedEvents, "both rejected requests persisted").toHaveLength(2);
    expect(rejectedEvents[0], "rejected receipt keeps only closed fields").toMatchObject({
      status: 400,
      target: { scope: "project", id: 23 },
      query: "MATCH (n:Content) WHERE n.title = $anchor RETURN n",
      parameters: { anchor: { type: "string", value: "retained tagged parameter" } },
      budget: { resultRows: 2, wallTimeMs: 100 },
      errorCodes: ["invalid_request"],
    });
    expect(Object.keys(rejectedEvents[0].target), "target keeps only scope and id").toEqual(["scope", "id"]);
    expect(Object.keys(rejectedEvents[0].budget), "budget keeps only closed counters").toEqual(["wallTimeMs", "resultRows"]);
    expect(rejectedEvents[1], "invalid scope receipt omits the target").toMatchObject({
      status: 400,
      query: "MATCH (n:Content) RETURN n",
      parameters: {},
      budget: { resultRows: 1 },
      errorCodes: ["invalid_request"],
    });
    expect(rejectedEvents[1], "no target recorded for the invalid scope").not.toHaveProperty("target");
    expect(rejectedText, "invalid scope value never persisted").not.toContain(invalidScope);
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
      expect(rejectedText, `forbidden field ${forbidden} never persisted`).not.toContain(forbidden);
    }

    const remintUpstream = await startUpstream();
    const remintRecorder = await startGraphOperationRecorder({ upstreamUrl: remintUpstream.url });
    resources.push(remintRecorder);
    await bindCapability(remintRecorder.url, "old-token");
    await jsonRequest(`${remintRecorder.url}/api/graph/input`, { token: "old-token" });
    await bindCapability(remintRecorder.url, "new-token");
    await jsonRequest(`${remintRecorder.url}/api/graph/input`, { token: "old-token" });
    await jsonRequest(`${remintRecorder.url}/api/graph/input`, { token: "new-token" });
    expect((await jsonRequest(`${remintRecorder.url}/api/control/capabilities`, {
      method: "DELETE",
      token: "control-secret",
      body: { graphToken: "new-token" },
    })).status, "revocation status").toBe(200);
    await jsonRequest(`${remintRecorder.url}/api/graph/input`, { token: "new-token" });
    const remintTarget = await createCandidateTraceDirectory();
    const remintDescriptor = await remintRecorder.exportInteraction(17, remintTarget);
    expect(remintDescriptor.eventCount, "only live attribution survives remint and revocation").toBe(2);
  }, 30_000);
  it("settles exports around in-flight, aborted, bounded, and runtime-integrated work", async () => {
    const abortUpstream = await startUpstream();
    const abortRecorder = await startGraphOperationRecorder({ upstreamUrl: abortUpstream.url });
    resources.push(abortRecorder);
    const abortToken = "abort-token";
    await bindCapability(abortRecorder.url, abortToken);
    const controller = new AbortController();
    const pending = fetch(`${abortRecorder.url}/api/graph/search`, {
      method: "POST",
      headers: { authorization: `Bearer ${abortToken}`, "content-type": "application/json" },
      body: JSON.stringify({ queryContractVersion: 1, query: "SLOW", parameters: {}, budget: {} }),
      signal: controller.signal,
    });
    await abortUpstream.slowSearchStarted;
    controller.abort();
    await expect(pending, "downstream abort propagated").rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(abortUpstream.abortedSearches(), "upstream saw the abort").toBe(1);
    const abortTarget = await createCandidateTraceDirectory();
    const abortDescriptor = await abortRecorder.exportInteraction(17, abortTarget);
    expect(abortDescriptor.eventCount, "cancelled search never recorded").toBe(0);

    const inFlightUpstream = await startUpstream();
    const inFlightRecorder = await startGraphOperationRecorder({ upstreamUrl: inFlightUpstream.url });
    resources.push(inFlightRecorder);
    const inFlightToken = "in-flight-token";
    await bindCapability(inFlightRecorder.url, inFlightToken);
    const pendingRequest = jsonRequest(`${inFlightRecorder.url}/api/graph/nodes`, { method: "POST", token: inFlightToken, body: {} });
    await inFlightUpstream.nodeStarted;
    const inFlightTarget = await createCandidateTraceDirectory();
    const exportPromise = inFlightRecorder.exportInteraction(17, inFlightTarget);
    await expect(Promise.race([
      exportPromise.then(() => "exported"),
      new Promise((resolve) => setTimeout(() => resolve("waiting"), 10)),
    ]), "export waits for attributed in-flight work").resolves.toBe("waiting");
    await pendingRequest;
    const inFlightDescriptor = await exportPromise;
    expect(inFlightDescriptor.eventCount, "in-flight work sealed once complete").toBe(1);
    expect(await readFile(join(inFlightTarget, "graph-operations.jsonl"), "utf8"), "sealed receipt carries the node id").toContain('"recordId":41');

    const settleUpstream = await startUpstream();
    const settleRecorder = await startGraphOperationRecorder({ upstreamUrl: settleUpstream.url, settleTimeoutMs: 25 });
    resources.push(settleRecorder);
    const settleToken = "settlement-token";
    await bindCapability(settleRecorder.url, settleToken);
    const hungRequest = jsonRequest(`${settleRecorder.url}/api/graph/search`, {
      method: "POST",
      token: settleToken,
      body: { queryContractVersion: 1, query: "SLOW", parameters: {}, budget: {} },
    });
    await settleUpstream.slowSearchStarted;
    const settleTarget = await createCandidateTraceDirectory();
    const settleDescriptor = await settleRecorder.exportInteraction(17, settleTarget);
    expect(settleDescriptor, "bounded settlement fails partial instead of sealing around a hung request").toMatchObject({ status: "partial", promotable: false, eventCount: 0, discardedEvents: 1 });
    expect((await hungRequest).status, "hung request fails at the proxy").toBe(502);
    expect(settleUpstream.abortedSearches(), "hung upstream request aborted").toBe(1);

    const boundedUpstream = await startUpstream();
    const boundedRecorder = await startGraphOperationRecorder({
      upstreamUrl: boundedUpstream.url,
      maxEventsPerInteraction: 2,
      maxBytesPerInteraction: 2_000,
    });
    resources.push(boundedRecorder);
    const boundedToken = "bounded-token";
    await bindCapability(boundedRecorder.url, boundedToken);
    await jsonRequest(`${boundedRecorder.url}/api/graph/input`, { token: boundedToken });
    await jsonRequest(`${boundedRecorder.url}/api/graph/search`, { method: "POST", token: boundedToken, body: {} });
    await jsonRequest(`${boundedRecorder.url}/api/graph/not-a-route`, { token: boundedToken });

    expect(await rawTargetRequest(boundedRecorder.url, "http://example.com/api/graph/input"), "escaped proxy target rejected").toBe(400);
    const boundedTarget = await createCandidateTraceDirectory();
    const boundedDescriptor = await boundedRecorder.exportInteraction(17, boundedTarget);
    expect(boundedDescriptor, "bounded export fails partial with explicit truncation").toMatchObject({
      status: "partial",
      promotable: false,
      eventCount: 2,
      truncated: true,
      discardedEvents: 1,
    });
    expect(boundedDescriptor.discardedBytes, "discarded bytes accounted").toBeGreaterThan(0);
    expect((await readFile(join(boundedTarget, "graph-operations.jsonl"), "utf8")).trim().split("\n"), "only retained events written").toHaveLength(2);

    const runtimeUpstream = await startUpstream();
    const runtimeRecorder = await startGraphOperationRecorder({
      upstreamUrl: runtimeUpstream.url,
      maxEventsPerInteraction: 1,
    });
    resources.push(runtimeRecorder);
    const runtimeToken = "runtime-export-token";
    await bindCapability(runtimeRecorder.url, runtimeToken);
    await jsonRequest(`${runtimeRecorder.url}/api/graph/input`, { token: runtimeToken });
    await jsonRequest(`${runtimeRecorder.url}/api/graph/search`, { method: "POST", token: runtimeToken, body: {} });
    const root = await mkdtemp(join(tmpdir(), "relayer-runtime-graph-operation-export-"));
    directories.push(root);
    const runtimeTarget = join(root, "candidate-trace");
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
    runtime.graphOperationRecorder = runtimeRecorder;

    const exported = await runtime.exportCandidateTrace(77, runtimeTarget, { executionId: "execution-1" });
    const runtimeManifest = JSON.parse(await readFile(join(runtimeTarget, "manifest.json"), "utf8"));
    expect(exported, "graph evidence attached without changing provider digest semantics").toMatchObject({
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
    expect(runtimeManifest.artifacts.events.sha256, "provider trace digest unchanged").toBe("sha256:provider-events");
    expect(runtimeManifest.artifacts.graphOperations.sha256, "graph operations digest recorded").toBe(exported.graphOperations.sha256);
  }, 30_000);
});
