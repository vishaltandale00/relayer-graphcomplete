import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  GraphQueryError,
  LayerLayoutObject,
  LayerObject,
  NodeObject,
  NodePlacementObject,
  RelayerGraphClient,
} from "../packages/graph-client/dist/index.js";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..");
const pythonClientRoot = join(repositoryRoot, "python", "relayer-graph", "src");
const processes = [];
const directories = [];

const conceptParameter = { type: "string", value: "concept" };
const searchRequest = {
  queryContractVersion: 1,
  query: "MATCH (n:Content) WHERE n.kind = $kind RETURN n.title AS title, n AS node ORDER BY title ASC",
  parameters: { kind: conceptParameter },
  budget: {},
};
const invalidRequest = {
  queryContractVersion: 1,
  query: "CREATE (n:Content)",
  parameters: {},
  budget: {},
};

afterEach(async () => {
  for (const child of processes.splice(0).reverse()) await terminate(child);
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("real graph-search public client parity", () => {
  it("publishes once and returns the same current-thread result and contract error to TypeScript and Python", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-search-client-parity-"));
    directories.push(directory);
    const controlToken = "deterministic-search-parity-control-token";
    const server = await startGraphServer(join(directory, "graph.sqlite3"), controlToken);
    processes.push(server.process);

    const first = await createInteraction(server.url, controlToken, 71, "First parity fixture");
    const firstClient = clientFor(server.url, first);
    const authoredFirst = await authorResponse(firstClient, first.node.id, "Alpha");

    // Ladybug is derived only from accepted material. Draft public writes must
    // not leak into search, while the submit acknowledgement is the freshness
    // boundary after which the same request must see them immediately.
    await expect(firstClient.search(searchRequest)).resolves.toEqual(emptyResult());
    await firstClient.submit();
    const firstTypeScript = await firstClient.search(searchRequest);
    expect(firstTypeScript).toEqual(expectedResult(authoredFirst));

    const second = await createInteraction(server.url, controlToken, 72, "Second parity fixture");
    const secondClient = clientFor(server.url, second);
    const authoredSecond = await authorResponse(secondClient, second.node.id, "Beta");
    await secondClient.submit();
    const secondTypeScript = await secondClient.search(searchRequest);
    expect(secondTypeScript).toEqual(expectedResult(authoredSecond));

    // The capability chooses the current-thread target server-side. Neither
    // public client gets a target selector, and each sees only its own accepted
    // material even though both queries hit the same server and Ladybug store.
    expect(firstTypeScript.rows.every(([title]) => title.value.startsWith("Alpha"))).toBe(true);
    expect(secondTypeScript.rows.every(([title]) => title.value.startsWith("Beta"))).toBe(true);

    const firstPython = await pythonSearch(server.url, first);
    const secondPython = await pythonSearch(server.url, second);
    expect(firstPython.result).toEqual(firstTypeScript);
    expect(secondPython.result).toEqual(secondTypeScript);

    const firstTypeScriptError = await normalizedTypeScriptError(firstClient);
    expect(firstTypeScriptError).toEqual(contractError());
    expect(firstPython.error).toEqual(firstTypeScriptError);
    expect(secondPython.error).toEqual(firstTypeScriptError);
  }, 30_000);
});

function clientFor(url, interaction) {
  return new RelayerGraphClient({
    url,
    token: interaction.graphToken,
    nodeId: interaction.node.id,
  });
}

async function authorResponse(client, interactionNodeId, prefix) {
  const nodes = Array.from({ length: 6 }, (_, index) => new NodeObject(
    "box",
    `${prefix} ${String(index + 1).padStart(2, "0")}`,
    `${prefix} detail ${index + 1}`,
    "concept",
    `${prefix.toLowerCase()}-node-${index + 1}`,
  ));
  const submitted = [];
  for (const node of nodes) submitted.push(await client.submitNode(node));
  const edges = [];
  for (let index = 1; index < nodes.length; index += 1) {
    edges.push(await client.createEdge(
      nodes[index - 1],
      nodes[index],
      `${prefix.toLowerCase()}-edge-${index}`,
    ));
  }
  const layout = new LayerLayoutObject(nodes.map((node, index) => (
    new NodePlacementObject(node, (index % 3 + 1) / 4, (Math.floor(index / 3) + 1) / 3)
  )));
  const layer = new LayerObject(nodes, edges, layout, `${prefix.toLowerCase()}-layer`);
  await client.submitLayer(layer, {
    sizeJustification: "Six ordered parity rows make the default five-row truncation boundary observable.",
  });
  await client.addAction(interactionNodeId, {
    clientKey: `${prefix.toLowerCase()}-response`,
    kind: "navigate",
    relation: "expand",
    label: `${prefix} response`,
    target: layer,
  });
  return submitted;
}

function expectedResult(nodes) {
  return {
    queryContractVersion: 1,
    columns: ["title", "node"],
    rows: nodes.slice(0, 5).map((node) => [
      { type: "string", value: node.title },
      {
        type: "node",
        id: `content:${node.id}`,
        kind: "Content",
        properties: [
          { name: "kind", value: { type: "string", value: node.kind } },
          { name: "icon", value: { type: "string", value: node.icon } },
          { name: "title", value: { type: "string", value: node.title } },
          { name: "detail", value: { type: "string", value: node.detail } },
          { name: "state", value: { type: "string", value: "accepted" } },
        ],
      },
    ]),
    truncated: true,
  };
}

function emptyResult() {
  return {
    queryContractVersion: 1,
    columns: ["title", "node"],
    rows: [],
    truncated: false,
  };
}

function contractError() {
  return {
    status: 422,
    code: "query_construct_forbidden",
    phase: "parse",
    path: "query",
  };
}

async function normalizedTypeScriptError(client) {
  try {
    await client.search(invalidRequest);
    throw new Error("invalid graph query unexpectedly succeeded");
  } catch (error) {
    if (!(error instanceof GraphQueryError)) throw error;
    return {
      status: error.status,
      code: error.code,
      phase: error.phase,
      path: error.path,
    };
  }
}

async function pythonSearch(url, interaction) {
  const program = String.raw`
import asyncio
import json
import sys

from relayer_graph import GraphQueryError, GraphSearchRequest, RelayerGraphClient

async def main():
    client = RelayerGraphClient(sys.argv[1], sys.argv[2], int(sys.argv[3]))
    request = GraphSearchRequest(
        "MATCH (n:Content) WHERE n.kind = $kind RETURN n.title AS title, n AS node ORDER BY title ASC",
        parameters={"kind": {"type": "string", "value": "concept"}},
    )
    result = await client.search(request)
    try:
        await client.search(GraphSearchRequest("CREATE (n:Content)"))
        raise RuntimeError("invalid graph query unexpectedly succeeded")
    except GraphQueryError as error:
        normalized = {
            "status": error.status,
            "code": error.code,
            "phase": error.phase,
            "path": error.path,
        }
    print(json.dumps({"result": result, "error": normalized}, separators=(",", ":")))

asyncio.run(main())
`;
  const result = await runProcess("python3", [
    "-c",
    program,
    url,
    interaction.graphToken,
    String(interaction.node.id),
  ], {
    ...process.env,
    PYTHONPATH: pythonClientRoot,
  });
  return JSON.parse(result.stdout.trim());
}

async function createInteraction(url, controlToken, threadId, text) {
  return controlRequest(url, controlToken, "/api/control/interactions", {
    threadId,
    text,
    graphCapabilityProfile: { search: "query-v1" },
  });
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
    let errors = "";
    let settled = false;
    const timeout = setTimeout(() => finish(new Error(`Graph server readiness timed out: ${errors}`)), 15_000);
    const onData = (chunk) => {
      output += chunk.toString();
      const newline = output.indexOf("\n");
      if (newline >= 0) finish(undefined, output.slice(0, newline));
    };
    const onErrorData = (chunk) => { errors += chunk.toString(); };
    const onExit = (code) => finish(new Error(`Graph server exited before readiness (${code}): ${errors}`));
    const onError = (error) => finish(new Error(`Graph server failed to start: ${error.message}`));
    const finish = (error, line) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.stderr.off("data", onErrorData);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error) reject(error);
      else resolveLine(line);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onErrorData);
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

function runProcess(command, args, env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun({ stdout, stderr });
      else reject(new Error(`${command} exited with ${code ?? signal}: ${stderr}`));
    });
  });
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
