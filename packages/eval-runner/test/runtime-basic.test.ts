import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { basicEvalFacts, checkBasicOutput, judgeVisibleGraph, renderArtifact, runBasicRuntimeEval } from "../src/runtime-basic.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("first runtime evaluation", () => {
  it("recognizes equivalent concurrency language and gives the judge endpoint-resolvable node IDs", () => {
    const concurrency = basicEvalFacts.find((fact) => fact.id === "two-active-limit")!;
    expect(concurrency.patterns.some((pattern) => pattern.test("allowing up to two tasks to run at the same time"))).toBe(true);
    expect(concurrency.patterns.some((pattern) => pattern.test("While both workers are busy: no new task starts."))).toBe(true);
    const visible = judgeVisibleGraph({
      nodeId: 1,
      rootAction: { id: 1, sourceNodeId: 1, kind: "navigate", label: "Response", targetLayerId: 3, response: true, state: "accepted" },
      rootLayer: {
        layer: { id: 3, nodes: [2, 6], edges: [4], state: "accepted" },
        nodes: [
          { id: 2, kind: "concept", icon: "Q", title: "Queue", detail: "Wait", state: "accepted" },
          { id: 6, kind: "concept", icon: "R", title: "Results", detail: "Stored", state: "accepted" },
        ],
        edges: [{ id: 4, endpoints: [2, 6], state: "accepted" }],
        actions: [],
      },
    });
    expect(visible.nodes.map((node) => node.id)).toEqual([2, 6]);
    expect(visible.edges).toEqual([[2, 6]]);

    const mismatched = {
      nodeId: 1,
      rootAction: { id: 1, sourceNodeId: 1, kind: "navigate" as const, label: "Response", targetLayerId: 3, response: true, state: "accepted" as const },
      rootLayer: {
        layer: { id: 3, nodes: [2], edges: [], state: "accepted" as const },
        nodes: [{ id: 6, kind: "concept", icon: "R", title: "Results", detail: "Stored", state: "draft" as const }],
        edges: [],
        actions: [],
      },
    };
    const checks = checkBasicOutput(mismatched);
    expect(checks.find((check) => check.name === "resolved-membership")?.passed).toBe(false);
    expect(checks.find((check) => check.name === "accepted-closure")?.passed).toBe(false);
  });

  it("runs two interactions through one live harness object and saves both fixture graphs", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "relayer-eval-test-")); temporary.push(outputDirectory);
    const artifact = await runBasicRuntimeEval({ outputDirectory, live: false });
    expect(artifact.passed).toBe(true);
    expect(artifact.turns).toHaveLength(2);
    expect(artifact.turns.map((turn) => turn.output.nodeId)).toEqual(artifact.turns.map((turn) => turn.interactionNodeId));
    expect(artifact.turns.every((turn) => turn.output.rootLayer.nodes.length === 3)).toBe(true);
    expect(artifact.turns.every((turn) => turn.output.rootLayer.edges.length === 2)).toBe(true);
    expect(artifact.turns.every((turn) => turn.checks.every((check) => check.passed))).toBe(true);
    expect(artifact.sessionChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "single-harness-object", passed: true }),
      expect.objectContaining({ name: "rotated-interaction-capability", passed: true }),
    ]));
    expect(JSON.parse(await readFile(join(outputDirectory, artifact.runId, "result.json"), "utf8"))).toMatchObject({ schemaVersion: 2, runId: artifact.runId, passed: true, turns: [{ passed: true }, { passed: true }] });
    expect(await readFile(join(outputDirectory, artifact.runId, "index.html"), "utf8")).toContain("Incoming queue");
    const unsafe = {
      ...artifact,
      turns: artifact.turns.map((turn, turnIndex) => turnIndex === 0 ? {
        ...turn,
        prompt: '<img src=x onerror="alert(1)">',
        output: {
          ...turn.output,
          rootLayer: {
            ...turn.output.rootLayer,
            nodes: turn.output.rootLayer.nodes.map((node, nodeIndex) => nodeIndex === 0 ? { ...node, title: '<img src=x onerror="alert(2)">' } : node),
          },
        },
      } : turn),
    };
    const html = renderArtifact(unsafe);
    expect(html).not.toContain('<img src=x onerror="alert');
    expect(html).toContain("title.textContent=node.title");
  }, 15_000);

  it("reports a controlled failure when the graph server cannot be executed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-eval-spawn-error-")); temporary.push(directory);
    const executable = join(directory, "not-executable");
    await writeFile(executable, "not a binary", "utf8");
    await chmod(executable, 0o644);

    await expect(runBasicRuntimeEval({
      outputDirectory: join(directory, "output"),
      live: false,
      serverBinary: executable,
    })).rejects.toThrow("Graph server could not start");
  });

  it("times out and terminates a graph process that never becomes ready", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-eval-timeout-")); temporary.push(directory);
    const executable = join(directory, "stalled-server");
    await writeFile(executable, "#!/usr/bin/env node\nprocess.on('SIGTERM', () => {});\nsetInterval(() => {}, 30_000);\n", "utf8");
    await chmod(executable, 0o755);

    await expect(runBasicRuntimeEval({
      outputDirectory: join(directory, "output"),
      live: false,
      serverBinary: executable,
      serverReadyTimeoutMs: 300,
    })).rejects.toThrow("did not become ready");
  });

  it("terminates a graph process that emits invalid readiness output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-eval-invalid-ready-")); temporary.push(directory);
    const executable = join(directory, "invalid-server");
    await writeFile(executable, "#!/usr/bin/env node\nprocess.stdout.write('not-json\\n');\nsetInterval(() => {}, 30_000);\n", "utf8");
    await chmod(executable, 0o755);

    await expect(runBasicRuntimeEval({
      outputDirectory: join(directory, "output"),
      live: false,
      serverBinary: executable,
    })).rejects.toThrow("Unexpected token");
  });
});
