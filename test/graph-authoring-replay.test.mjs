import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  EdgeObject,
  LayerObject,
  NodeObject,
  RelayerGraphClient,
} from "@relayer/graph-client";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..");
const processes = [];
const directories = [];

afterEach(async () => {
  for (const child of processes.splice(0).reverse()) await terminate(child);
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("replay-safe graph authoring", () => {
  it("replays stable keys, rejects a duplicate root, discards the retargeted orphan, and submits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-graph-replay-"));
    directories.push(directory);
    const controlToken = "deterministic-replay-control-token";
    const server = await startGraphServer(join(directory, "graph.sqlite3"), controlToken);
    processes.push(server.process);
    const interaction = await controlRequest(server.url, controlToken, "/api/control/interactions", {
      projectId: 41,
      threadId: 73,
      text: "Exercise replay-safe graph authoring",
    });
    const graph = new RelayerGraphClient({
      url: server.url,
      token: interaction.graphToken,
      nodeId: interaction.node.id,
    });

    const first = await authorCompleteProgram(graph, interaction.node.id);
    const replayed = await authorCompleteProgram(graph, interaction.node.id);
    expect(replayed.ids).toEqual(first.ids);
    expect(new Set(replayed.ids.nodes).size).toBe(3);
    expect(new Set(replayed.ids.edges).size).toBe(1);
    expect(new Set(replayed.ids.layers).size).toBe(2);
    expect(new Set(replayed.ids.actions).size).toBe(1);
    await expect(graph.getLayer(replayed.oldLayer)).resolves.toMatchObject({
      layer: { id: replayed.oldLayer.id, state: "draft" },
      nodes: [{ id: replayed.summary.id }, { id: replayed.detail.id }],
      edges: [{ id: replayed.summaryDetail.id }],
    });

    await expect(graph.addAction(interaction.node.id, {
      clientKey: "different-root",
      kind: "navigate",
      relation: "expand",
      label: "Duplicate response",
      target: replayed.replacementLayer,
    })).rejects.toMatchObject({
      status: 422,
      code: "root_action_already_exists",
      path: "clientKey",
      message: expect.stringContaining("root-response"),
    });
    await expect(graph.discardLayer(replayed.oldLayer)).rejects.toMatchObject({
      status: 422,
      code: "reachable_layer",
    });

    const afterRejectedWrite = await authorCompleteProgram(graph, interaction.node.id);
    expect(afterRejectedWrite.ids).toEqual(first.ids);
    const retargeted = await graph.addAction(interaction.node.id, {
      clientKey: "root-response",
      kind: "navigate",
      relation: "expand",
      label: "Response",
      target: afterRejectedWrite.replacementLayer,
    });
    expect(retargeted.id).toBe(first.rootAction.id);

    const discarded = await graph.discardLayer(afterRejectedWrite.oldLayer);
    const discardedAgain = await graph.discardLayer(afterRejectedWrite.oldLayer);
    expect(discarded).toEqual(discardedAgain);
    expect(discarded).toMatchObject({ id: first.oldLayer.id, state: "stopped" });

    const output = await graph.submit(interaction.node.id);
    expect(output.rootLayer).toMatchObject({
      layer: { id: first.replacementLayer.id, state: "accepted" },
      nodes: [{ id: first.replacement.id, state: "accepted" }],
      edges: [],
      actions: [],
    });
    await expect(graph.getLayer(first.oldLayer)).resolves.toMatchObject({
      layer: { id: first.oldLayer.id, state: "stopped" },
    });
  });
});

async function authorCompleteProgram(graph, interactionNodeId) {
  const summary = new NodeObject("brain", "Summary", "Replay-safe summary", "concept", "summary-node");
  const detail = new NodeObject("file-text", "Detail", "Replay-safe detail", "concept", "detail-node");
  const replacement = new NodeObject("check-circle", "Replacement", "Final response", "concept", "replacement-node");
  const summaryDetail = new EdgeObject([summary, detail], "summary-detail-edge");
  const oldLayer = new LayerObject([summary, detail], [summaryDetail], "old-response-layer");
  const replacementLayer = new LayerObject([replacement], [], "replacement-response-layer");

  const nodes = [];
  for (const node of [summary, detail, replacement]) nodes.push(await graph.submitNode(node));
  const edge = await graph.createEdge(summaryDetail);
  const old = await graph.submitLayer(oldLayer);
  const replacementResult = await graph.submitLayer(replacementLayer);
  const rootAction = await graph.addAction(interactionNodeId, {
    clientKey: "root-response",
    kind: "navigate",
    relation: "expand",
    label: "Response",
    target: oldLayer,
  });

  return {
    summary: nodes[0],
    detail: nodes[1],
    replacement: nodes[2],
    summaryDetail: edge,
    oldLayer: old,
    replacementLayer: replacementResult,
    rootAction,
    ids: {
      nodes: nodes.map(({ id }) => id),
      edges: [edge.id],
      layers: [old.id, replacementResult.id],
      actions: [rootAction.id],
    },
  };
}

async function startGraphServer(database, controlToken) {
  const child = spawn(
    join(repositoryRoot, "target", "debug", "relayer-graph-server"),
    ["--database", database, "--control-token", controlToken, "--port", "0"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    const line = await firstLine(child);
    const ready = JSON.parse(line);
    if (typeof ready.url !== "string") throw new Error(`Invalid graph-server readiness: ${line}`);
    return { url: ready.url, process: child };
  } catch (error) {
    await terminate(child);
    throw error;
  }
}

function firstLine(child) {
  return new Promise((resolveLine, reject) => {
    let output = "";
    let settled = false;
    const timeout = setTimeout(() => finish(new Error("Graph server readiness timed out")), 10_000);
    const onData = (chunk) => {
      output += chunk.toString();
      const newline = output.indexOf("\n");
      if (newline >= 0) finish(undefined, output.slice(0, newline));
    };
    const onExit = (code) => finish(new Error(`Graph server exited before readiness (${code})`));
    const onError = (error) => finish(new Error(`Graph server failed to start: ${error.message}`));
    const finish = (error, line) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error) reject(error);
      else resolveLine(line);
    };
    child.stdout.on("data", onData);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function controlRequest(url, token, path, body) {
  const response = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(`Control request failed (${response.status}): ${JSON.stringify(value)}`);
  return value;
}

async function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  child.kill("SIGTERM");
  let timer;
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout(false), 1_000);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (!graceful) {
    child.kill("SIGKILL");
    await exited;
  }
}
