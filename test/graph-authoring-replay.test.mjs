import { currentCommunicationAuthoringRecipePython, scopedAuthoringRecipeJs, scopedAuthoringRecipePython } from "../packages/harness-host/dist/implementations/graph-presentation-guidance.js";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  PrimeVisualAuthoring,
  submitPrimeLayer,
} from "../packages/harness-host/dist/implementations/prime-visual-authoring.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  EdgeObject,
  LayerLayoutObject,
  LayerObject,
  NodeObject,
  NodePlacementObject,
  RelayerGraphClient,
  detailCapability,
  html,
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
    const server = await startGraphServer(
      join(directory, "graph.sqlite3"),
      controlToken,
    );
    processes.push(server.process);
    const interaction = await controlRequest(
      server.url,
      controlToken,
      "/api/control/interactions",
      {
        projectId: 41,
        threadId: 73,
        text: "Exercise replay-safe graph authoring",
      },
    );
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

    await expect(
      graph.addAction(interaction.node.id, {
        clientKey: "different-root",
        kind: "navigate",
        relation: "expand",
        label: "Duplicate response",
        target: replayed.replacementLayer,
      }),
    ).rejects.toMatchObject({
      status: 422,
      code: "root_action_already_exists",
      path: "clientKey",
      message: expect.stringContaining("root-response"),
    });
    await expect(graph.discardLayer(replayed.oldLayer)).rejects.toMatchObject({
      status: 422,
      code: "reachable_layer",
    });

    const afterRejectedWrite = await authorCompleteProgram(
      graph,
      interaction.node.id,
    );
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
    const discardedAgain = await graph.discardLayer(
      afterRejectedWrite.oldLayer,
    );
    expect(discarded).toEqual(discardedAgain);
    expect(discarded).toMatchObject({
      id: first.oldLayer.id,
      state: "stopped",
    });

    const output = await graph.submit(interaction.node.id);
    expect(output.rootLayer).toMatchObject({
      layer: { id: first.replacementLayer.id, state: "accepted" },
      nodes: [{ id: first.replacement.id, state: "accepted" }],
      edges: [],
      actions: [],
    });
    await expect(graph.getLayer(first.oldLayer)).rejects.toMatchObject({
      status: 422,
      code: "authority_generation_expired",
    });
    await expect(
      controlRead(
        server.url,
        controlToken,
        `/api/control/interactions/${interaction.node.id}/layers/${first.oldLayer.id}`,
      ),
    ).resolves.toMatchObject({
      layer: { id: first.oldLayer.id, state: "stopped" },
    });
  });
  it("writes scoped TS and Python programs through canonical compilation and Rust authority", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "relayer-scoped-authoring-"),
    );
    directories.push(directory);
    const token = "scoped-authoring-control";
    const server = await startGraphServer(
      join(directory, "graph.sqlite3"),
      token,
    );
    processes.push(server.process);
    const interaction = await controlRequest(
      server.url,
      token,
      "/api/control/interactions",
      { projectId: 41, threadId: 73, text: "Scoped answer" },
    );
    const graph = new RelayerGraphClient({
      url: server.url,
      token: interaction.graphToken,
      nodeId: interaction.node.id,
    });
    const author = graph.authoring("finding-v1");
    const root = author.layer("answer");
    const evidence = author.layer("evidence");
    const a = root.node("finding", {
      icon: "info",
      title: "Finding",
      detail: "Supported finding",
    });
    const b = root.node("limit", {
      icon: "file",
      title: "Limit",
      detail: "Measured limitation",
    });
    const proof = evidence.node("proof", {
      icon: "file",
      title: "Proof",
      detail: "Evidence",
    });
    const action = root.action("evidence", a, {
      kind: "navigate",
      relation: "expand",
      label: "Evidence",
      target: evidence,
    });
    a.detailAuthoring.setComponent(
      "main",
      html`<button gc=${detailCapability.expand("evidence", action)}>
        Evidence
      </button>`,
    );
    root.edge("relationship", a, b);
    root.layout(
      [
        [a, 0.2, 0.5],
        [b, 0.8, 0.5],
      ],
      { edgeShape: "arc-outward", defaultNode: a },
    );
    evidence.layout([[proof, 0.5, 0.5]], { edgeShape: "default" });
    const draft = await author.write(root);
    expect(draft.rootLayer.state).toBe("draft");
    await graph.addAction(interaction.node.id, {
      kind: "navigate",
      relation: "expand",
      label: "Response",
      target: draft.rootLayer,
      clientKey: "root-response",
    });
    const accepted = await graph.submit();
    expect(accepted.rootLayer.layer.state).toBe("accepted");
    expect(accepted.rootLayer.actions).toEqual([
      expect.objectContaining({
        id: action.ref.id,
        sourceNodeId: a.ref.id,
        sourceLayerId: draft.rootLayer.id,
        targetLayerId: evidence.object.ref.id,
      }),
    ]);
    expect(
      accepted.rootLayer.nodes[0].authoredDetail.mounts[0].capability.action,
    ).toMatchObject({
      clientKey: action.clientKey,
      sourceNode: { clientKey: a.clientKey },
      sourceLayer: { clientKey: root.object.clientKey },
    });

    for (const [index, mode] of ["cycle", "orphan"].entries()) {
      const rejectedInteraction = await controlRequest(
        server.url,
        token,
        "/api/control/interactions",
        { projectId: 41, threadId: 80 + index, text: mode },
      );
      const writer = new RelayerGraphClient({
        url: server.url,
        token: rejectedInteraction.graphToken,
        nodeId: rejectedInteraction.node.id,
      });
      const scope = writer.authoring(mode);
      const answer = scope.layer("answer");
      const child = scope.layer("child");
      const one = answer.node("one", {
        icon: "info",
        title: "One",
        detail: "One",
      });
      const two = child.node("two", {
        icon: "info",
        title: "Two",
        detail: "Two",
      });
      answer.layout([[one, 0.5, 0.5]], { edgeShape: "default" });
      child.layout([[two, 0.5, 0.5]], { edgeShape: "default" });
      if (mode === "cycle") {
        answer.action("child", one, {
          kind: "navigate",
          relation: "expand",
          label: "Child",
          target: child,
        });
        child.action("back", two, {
          kind: "navigate",
          relation: "expand",
          label: "Back",
          target: answer,
        });
      }
      const written = await scope.write(answer);
      if (mode === "orphan") await scope.write(child);
      await writer.addAction(rejectedInteraction.node.id, {
        kind: "navigate",
        relation: "expand",
        label: "Response",
        target: written.rootLayer,
        clientKey: "root",
      });
      await expect(writer.submit()).rejects.toMatchObject({
        status: 422,
        code: mode === "cycle" ? "expand_cycle" : "orphan_draft_layers",
      });
      expect((await writer.getLayer(written.rootLayer)).layer.state).toBe(
        "draft",
      );
    }

    // Execute the exact primary recipe delivered to Codex/Claude, including its import.
    const recipeInteraction = await controlRequest(server.url, token, "/api/control/interactions", {
      projectId: 41, threadId: 75, text: "Delivered JS recipe",
    });
    const recipe = scopedAuthoringRecipeJs(recipeInteraction.node.id,
      pathToFileURL(join(repositoryRoot, "packages/graph-client/dist/index.js")).href)
      .match(/```javascript\n([\s\S]*?)\n```/)[1];
    const recipeResult = await runRecipeProcess(process.execPath, ["--input-type=module"],
      recipe + '\nconsole.log("RECIPE:" + written.rootLayer.id);', {
        RELAYER_GRAPH_URL: server.url, RELAYER_GRAPH_TOKEN: recipeInteraction.graphToken,
        RELAYER_NODE_ID: String(recipeInteraction.node.id),
      });
    const recipeLayerId = Number(recipeResult.match(/RECIPE:(\d+)/)[1]);
    const recipeAccepted = await controlRead(server.url, token,
      `/api/control/interactions/${recipeInteraction.node.id}/layers/${recipeLayerId}`);
    expect(recipeAccepted).toMatchObject({ layer: { state: "accepted" }, nodes: [{ icon: "info", authoredDetail: { components: [{ id: "main" }] } }], actions: [expect.objectContaining({ relation: "expand", state: "accepted" })] });
    const mounts = recipeAccepted.nodes[0].authoredDetail.mounts;
    expect(mounts).toHaveLength(1);
    expect(mounts[0]).toMatchObject({ capability: { kind: "expand", action: { clientKey: recipeAccepted.actions[0].clientKey } } });
    expect((await controlRead(server.url, token,
      `/api/control/interactions/${recipeInteraction.node.id}/layers/${recipeAccepted.actions[0].targetLayerId}`)).layer.state).toBe("accepted");

    const foreignInteraction = await controlRequest(
      server.url,
      token,
      "/api/control/interactions",
      {
        projectId: 42,
        threadId: 90,
        text: "Foreign accepted record is not a grant",
      },
    );
    const foreignClient = new RelayerGraphClient({
      url: server.url,
      token: foreignInteraction.graphToken,
      nodeId: foreignInteraction.node.id,
    });
    const foreign = foreignClient.authoring("foreign");
    const foreignLayer = foreign.layer("answer");
    const history = accepted.rootLayer.nodes.find(
      (node) => node.id === a.ref.id,
    );
    foreignLayer.include(history);
    const newNode = foreignLayer.node("new", {
      icon: "info",
      title: "New",
      detail: "New",
    });
    foreignLayer.edge("ungranted", newNode, history);
    foreignLayer.layout(
      [
        [newNode, 0.2, 0.5],
        [history, 0.8, 0.5],
      ],
      { edgeShape: "default" },
    );
    await expect(foreign.write(foreignLayer)).rejects.toMatchObject({
      completed: [{ kind: "node" }],
      failures: [
        {
          outcome: "rejected",
          cause: { status: 422, code: "unknown_endpoint" },
        },
      ],
      unstarted: ['layers["answer"]'],
    });

    const pythonInteraction = await controlRequest(
      server.url,
      token,
      "/api/control/interactions",
      {
        projectId: 41,
        threadId: 74,
        text: "Reuse accepted context",
        contexts: [
          {
            target: {
              nodeId: a.ref.id,
              sourceInteractionNodeId: interaction.node.id,
              sourceLayerId: draft.rootLayer.id,
            },
            annotations: [],
          },
        ],
      },
    );
    let capability = {
      url: server.url,
      token: pythonInteraction.graphToken,
      nodeId: pythonInteraction.node.id,
    };
    const bridge = new PrimeVisualAuthoring();
    const host = createServer(async (request, response) => {
      try {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const { method, payload } = JSON.parse(Buffer.concat(chunks));
        const value =
          method === "relayer.graph.current" ? capability :
          method === "relayer.graph.visual-authoring"
            ? await bridge.execute(
                payload,
                capability,
                () => {},
                new AbortController().signal,
              )
            : await submitPrimeLayer(
                payload,
                capability,
                () => {},
                new AbortController().signal,
              );
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify(value));
      } catch (error) {
        response.writeHead(500).end(JSON.stringify({ error: error.message }));
      }
    });
    await new Promise((resolve) => host.listen(0, "127.0.0.1", resolve));
    try {
      const python = spawn("python3", ["-c", SCOPED_PYTHON], {
        env: {
          ...process.env,
          PYTHONPATH: join(repositoryRoot, "python/relayer-graph/src"),
          SCOPED_HOST: `http://127.0.0.1:${host.address().port}`,
          SCOPED_CAPABILITY: JSON.stringify(capability),
          SCOPED_HISTORY: JSON.stringify(accepted.rootLayer.nodes[0]),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      processes.push(python);
      let output = "",
        errors = "";
      python.stdout.on("data", (bytes) => (output += bytes));
      python.stderr.on("data", (bytes) => (errors += bytes));
      const code = await new Promise((resolve, reject) => {
        python.once("error", reject);
        python.once("exit", resolve);
      });
      expect(code, errors).toBe(0);
      const result = JSON.parse(output);
      expect(result.acceptedState).toBe("accepted");
      expect(result.reusedId).toBe(a.ref.id);
      expect(result.mounts).toBe(1);
      expect(result.layers).toBe(3);
      const pyRecipeInteraction = await controlRequest(server.url, token, "/api/control/interactions", {
        projectId: 41, threadId: 76, text: "Delivered Python recipe",
      });
      capability = { url: server.url, token: pyRecipeInteraction.graphToken, nodeId: pyRecipeInteraction.node.id };
      const pyRecipe = scopedAuthoringRecipePython(capability.nodeId).match(/```python\n([\s\S]*?)\n```/)[1];
      const pyProgram = SCOPED_PYTHON.split("async def main():")[0]
        .replace("host_request(method, payload)", "host_request(method, payload=None)")
        + "async def main():\n" + pyRecipe.split("\n").map(line => "    " + line).join("\n")
        + '\n    print("RECIPE:" + str(written.root_layer.id))\nasyncio.run(main())';
      const pyOutput = await runRecipeProcess("python3", ["-c", pyProgram], undefined, {
        PYTHONPATH: join(repositoryRoot, "python/relayer-graph/src"),
        SCOPED_HOST: `http://127.0.0.1:${host.address().port}`,
        SCOPED_CAPABILITY: JSON.stringify(capability),
      });
      const pyLayerId = Number(pyOutput.match(/RECIPE:(\d+)/)[1]);
      expect(await controlRead(server.url, token,
        `/api/control/interactions/${capability.nodeId}/layers/${pyLayerId}`))
        .toMatchObject({ layer: { state: "accepted" }, nodes: [{ icon: "info", authoredDetail: { components: [{ id: "main" }] } }] });

      const temporalServer = await startGraphServer(join(directory, "temporal.sqlite3"), token, ["--temporal-schema-read", "--temporal-root-current-write"]);
      processes.push(temporalServer.process);
      // Execute Prime's delivered communication recipe through its real visual host bridge.
      for (const { withPrior, replay, temporal, later = false } of [{ withPrior: false, replay: false, temporal: true }, { withPrior: true, replay: false, temporal: true }, { withPrior: false, replay: true, temporal: true }, { withPrior: true, replay: true, temporal: true }, { withPrior: true, replay: true, temporal: true, later: true }, { withPrior: false, replay: false, temporal: false }]) {
        const baselineServer = temporal ? temporalServer : server;
        const baselineInteraction = await controlRequest(baselineServer.url, token, "/api/control/interactions", {
          projectId: 41, threadId: 77, text: "Python communication baseline",
        });
        capability = { url: baselineServer.url, token: baselineInteraction.graphToken, nodeId: baselineInteraction.node.id };
        let priorLayerId;
        if (withPrior) {
          const priorGraph = new RelayerGraphClient(capability);
          const author = priorGraph.authoring("existing-current");
          const layer = author.layer("prior");
          const node = layer.node("prior", { icon: "info", title: "Earlier finding", detail: "Previously published evidence" });
          layer.layout([[node, .5, .5]], { edgeShape: "default", defaultNode: node });
          const written = await author.write(layer);
          await priorGraph.addAction(capability.nodeId, { kind: "navigate", relation: "expand", label: "Task findings", icon: "info", target: written.rootLayer, clientKey: "root-response" });
          await priorGraph.advanceCurrent(written.rootLayer, 0, "existing-current-publication");
          priorLayerId = written.rootLayer.id;
        }
        const recipe = currentCommunicationAuthoringRecipePython(capability.nodeId).match(/```python\n([\s\S]*?)\n```/)[1]
          .replace("# Continue the underlying work.", 'if current is not None: print("ADVANCED:" + json.dumps({"current": await graph.get_current(), "layer": await graph.get_layer((await graph.get_current())["currentLayerId"])}))\n# Continue the underlying work.')
          .replace(`await graph.submit(${capability.nodeId})`, `print("FINAL_DRAFT:" + str(final_written.root_layer.id))\nawait graph.submit(${capability.nodeId})`);
        const program = SCOPED_PYTHON.split("async def main():")[0]
          .replace("host_request(method, payload)", "host_request(method, payload=None)")
          + "async def main():\n" + recipe.split("\n").map(line => "    " + line).join("\n")
          + '\nasyncio.run(main())';
        const pythonEnvironment = {
          PYTHONPATH: join(repositoryRoot, "python/relayer-graph/src"),
          SCOPED_HOST: `http://127.0.0.1:${host.address().port}`,
          SCOPED_CAPABILITY: JSON.stringify(capability),
        };
        if (temporal && !withPrior && !replay) {
          const invalidRead = program.replace('    try:\n', '    from relayer_graph import RelayerGraphClient\n    graph.get_current = RelayerGraphClient(cap["url"], "invalid-token", cap["nodeId"]).get_current\n    try:\n').replace('    author =', '    raise RuntimeError("AUTHORING_STARTED")\n    author =');
          await expect(runRecipeProcess("python3", ["-c", invalidRead], undefined, pythonEnvironment)).rejects.toThrow("AuthenticationError");
        }
        let firstPublication;
        let firstLayer;
        let beforeReplay;
        let acceptedBeforeReplay;
        if (replay) {
          await expect(runRecipeProcess("python3", ["-c", program.replace('    # Advance leaves', '    raise RuntimeError("injected after publication")\n    # Advance leaves')], undefined, pythonEnvironment)).rejects.toThrow("injected after publication");
          firstPublication = await controlRead(baselineServer.url, token, `/api/control/interactions/${capability.nodeId}/current`);
          firstLayer = await controlRead(baselineServer.url, token, `/api/control/interactions/${capability.nodeId}/layers/${firstPublication.currentLayerId}`);
          if (later) {
            const graph = new RelayerGraphClient(capability);
            const author = graph.authoring("additional-finding");
            const layer = author.layer("finding");
            const node = layer.node("finding", { icon: "info", title: "Further finding", detail: "Additional evidence after first publication" });
            const action = layer.action("prior", node, { kind: "navigate", relation: "reference", label: "Earlier findings", target: firstLayer.layer });
            node.detailAuthoring.setComponent("main", html`<button gc=${detailCapability.reference("earlier", action)}>Earlier findings</button>`);
            layer.layout([[node, .5, .5]], { edgeShape: "default", defaultNode: node });
            const written = await author.write(layer);
            await graph.addAction(capability.nodeId, { kind: "navigate", relation: "expand", label: "Task findings", icon: "info", target: written.rootLayer, clientKey: "root-response" });
            await graph.advanceCurrent(written.rootLayer, firstPublication.headRevision, "additional-publication");
          }
          beforeReplay = await controlRead(baselineServer.url, token, `/api/control/interactions/${capability.nodeId}/current`);
          acceptedBeforeReplay = await controlRead(baselineServer.url, token, `/api/control/interactions/${capability.nodeId}/layers/${beforeReplay.currentLayerId}`);
        }
        const output = await runRecipeProcess("python3", ["-c", program], undefined, pythonEnvironment);
        /* environment is shared across the failed process and its fresh retry */
        if (!temporal) {
          const finalId = Number(output.match(/FINAL_DRAFT:(\d+)/)[1]);
          const finalLayer = await controlRead(baselineServer.url, token, `/api/control/interactions/${capability.nodeId}/layers/${finalId}`);
          expect(finalLayer.layer.state).toBe("accepted");
          expect(finalLayer.nodes.map(node => node.title)).toEqual(["Result"]);
          expect(finalLayer.nodes[0].authoredDetail.mounts).toEqual([]);
          expect(finalLayer.actions).toEqual([]);
          expect(output).not.toContain("ADVANCED:");
          continue;
        }
        const advanced = JSON.parse(output.match(/ADVANCED:(.+)/)[1]);
        if (replay) {
          expect(advanced.current).toEqual(beforeReplay);
          expect(advanced.layer).toEqual(acceptedBeforeReplay);
          expect(await controlRead(baselineServer.url, token, `/api/control/interactions/${capability.nodeId}/layers/${firstPublication.currentLayerId}`)).toEqual(firstLayer);
        }
        expect(advanced.current).toMatchObject({ lifecycle: "active", headRevision: (withPrior ? 2 : 1) + (later ? 1 : 0) });
        const initialLayer = firstLayer ?? advanced.layer;
        const mounts = initialLayer.nodes[0].authoredDetail.mounts;
        expect(mounts.map(mount => mount.capability.kind)).toEqual(withPrior ? ["expand", "reference"] : ["expand"]);
        for (const mount of mounts) {
          expect(initialLayer.actions.some(action => action.clientKey === mount.capability.action.clientKey)).toBe(true);
        }
        const earlier = initialLayer.actions.find(action => action.label === "Earlier findings");
        if (withPrior) expect(earlier.targetLayerId).toBe(priorLayerId);
        else expect(earlier).toBeUndefined();
        const finalCurrent = await controlRead(baselineServer.url, token, `/api/control/interactions/${capability.nodeId}/current`);
        expect(finalCurrent).toMatchObject({ lifecycle: "succeeded", headRevision: (withPrior ? 3 : 2) + (later ? 1 : 0) });
        const finalLayer = await controlRead(baselineServer.url, token, `/api/control/interactions/${capability.nodeId}/layers/${finalCurrent.currentLayerId}`);
        const finalMount = finalLayer.nodes[0].authoredDetail.mounts[0];
        const finalEarlier = finalLayer.actions.find(action => action.label === "Earlier findings");
        expect(finalMount.capability.kind).toBe("reference");
        expect(finalMount.capability.action.clientKey).toBe(finalEarlier.clientKey);
        expect(finalEarlier.targetLayerId).toBe(advanced.current.currentLayerId);
      }

    } finally {
      await new Promise((resolve) => host.close(resolve));
    }
  }, 30_000);
});

async function authorCompleteProgram(graph, interactionNodeId) {
  const summary = new NodeObject(
    "brain",
    "Summary",
    "Replay-safe summary",
    "concept",
    "summary-node",
  );
  const detail = new NodeObject(
    "file-text",
    "Detail",
    "Replay-safe detail",
    "concept",
    "detail-node",
  );
  const replacement = new NodeObject(
    "check-circle",
    "Replacement",
    "Final response",
    "concept",
    "replacement-node",
  );
  const summaryDetail = new EdgeObject(
    [summary, detail],
    "summary-detail-edge",
  );
  const oldLayout = new LayerLayoutObject(
    [
      new NodePlacementObject(summary, 0.25, 0.5),
      new NodePlacementObject(detail, 0.75, 0.5),
    ],
    "default",
  );
  const replacementLayout = new LayerLayoutObject(
    [new NodePlacementObject(replacement, 0.5, 0.5)],
    "default",
  );
  const oldLayer = new LayerObject(
    [summary, detail],
    [summaryDetail],
    oldLayout,
    "old-response-layer",
  );
  const replacementLayer = new LayerObject(
    [replacement],
    [],
    replacementLayout,
    "replacement-response-layer",
  );

  const nodes = [];
  for (const node of [summary, detail, replacement])
    nodes.push(await graph.submitNode(node));
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

async function startGraphServer(database, controlToken, temporalArguments = []) {
  const child = spawn(
    join(repositoryRoot, "target", "debug", "relayer-graph-server"),
    ["--database", database, "--control-token", controlToken, "--port", "0", ...temporalArguments],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    const line = await firstLine(child);
    const ready = JSON.parse(line);
    if (typeof ready.url !== "string")
      throw new Error(`Invalid graph-server readiness: ${line}`);
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
    const timeout = setTimeout(
      () => finish(new Error("Graph server readiness timed out")),
      10_000,
    );
    const onData = (chunk) => {
      output += chunk.toString();
      const newline = output.indexOf("\n");
      if (newline >= 0) finish(undefined, output.slice(0, newline));
    };
    const onExit = (code) =>
      finish(new Error(`Graph server exited before readiness (${code})`));
    const onError = (error) =>
      finish(new Error(`Graph server failed to start: ${error.message}`));
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
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok)
    throw new Error(
      `Control request failed (${response.status}): ${JSON.stringify(value)}`,
    );
  return value;
}

async function controlRead(url, token, path) {
  const response = await fetch(`${url}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const value = await response.json();
  if (!response.ok)
    throw new Error(
      `Control read failed (${response.status}): ${JSON.stringify(value)}`,
    );
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

// Replaces inference only: Python -> production host compiler -> authenticated Rust writes.
const SCOPED_PYTHON = String.raw`
import asyncio, json, os, sys, types
from urllib.request import Request, urlopen
from relayer_graph import GraphSession, GraphNode, html, action_capability
cap = json.loads(os.environ['SCOPED_CAPABILITY'])
async def host_request(method, payload):
    def send():
        with urlopen(Request(os.environ['SCOPED_HOST'], data=json.dumps({'method':method,'payload':payload}).encode(), headers={'content-type':'application/json'})) as response:
            return json.load(response)
    return await asyncio.to_thread(send)
sys.modules['rlm'] = types.SimpleNamespace(host_request=host_request)
async def main():
    graph = GraphSession(cap['url'],cap['token'],cap['nodeId'])
    author = graph.authoring('python-v1')
    root, left, right = [author.layer(key) for key in ('answer','left','right')]
    author.layer('unrelated')
    history = GraphNode.from_dict(json.loads(os.environ['SCOPED_HISTORY']))
    root.include(history)
    node = root.node('answer',icon='info',title='Contextual answer',detail='New finding')
    l = left.node('left',icon='file',title='Left',detail='Left evidence')
    r = right.node('right',icon='file',title='Right',detail='Right evidence')
    reference = root.action('context',node,kind='navigate',relation='reference',label='Context',target=left)
    node.detail_authoring.set_component('main',html(['<button gc=', '>Context</button>'],action_capability('context',reference)))
    left.action('next',l,kind='navigate',relation='reference',label='Next',target=right)
    right.action('back',r,kind='navigate',relation='reference',label='Back',target=left)
    root.edge('history',node,history)
    root.layout([(node,.2,.5),(history,.8,.5)],edge_shape='straight',default_node=node)
    left.layout([(l,.5,.5)],edge_shape='default')
    right.layout([(r,.5,.5)],edge_shape='default')
    written = await author.write(root)
    assert written.root_layer.state == 'draft'
    await graph.add_navigate_action(cap['nodeId'],'Response',written.root_layer,relation='expand',client_key='python-root')
    output = await graph.submit()
    assert any(record['id'] == history.id for record in output['rootLayer']['nodes'])
    answer = next(record for record in output['rootLayer']['nodes'] if record['title'] == 'Contextual answer')
    print(json.dumps({'acceptedState':output['rootLayer']['layer']['state'],'reusedId':history.id,
        'mounts':len(answer['authoredDetail']['mounts']),'layers':len(written.layers)}))
asyncio.run(main())
`;

async function runRecipeProcess(command, args, stdin, environment) {
  const child = spawn(command, args, { env: { ...process.env, ...environment }, stdio: ["pipe", "pipe", "pipe"] });
  processes.push(child);
  let stdout = "", stderr = "";
  child.stdout.on("data", bytes => { stdout += bytes; });
  child.stderr.on("data", bytes => { stderr += bytes; });
  child.stdin.end(stdin);
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  expect(code, stderr).toBe(0);
  return stdout;
}
