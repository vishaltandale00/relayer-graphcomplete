import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  buildLayeredNavigationPrompt,
  CodexBasicHarness,
} from "../src/implementations/codex-basic.js";
import {
  EXPERIMENTAL_AUTHORING_STRATEGIES,
  PYTHON_CODE_MODEL_CALL_REFERENCE,
  javascriptExperimentalAuthoringGuidance,
  pythonExperimentalAuthoringGuidance,
} from "../src/implementations/experimental-authoring-guidance.js";
import type { GraphNode } from "@relayer/graph-client";
import type { HarnessConfiguration } from "../src/types.js";

const pythonExecutable = process.platform === "win32" ? "python" : "python3";

const interaction = {
  id: 21,
  title: "Task",
  detail: "Do the work",
} as GraphNode;

const configuration: HarnessConfiguration = {
  schemaVersion: 1,
  name: "codex-experiment",
  implementation: "codex.basic",
  implementationVersion: 1,
  permissionBindings: {
    auto: {
      sandboxMode: "workspace-write",
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
      networkAccessEnabled: true,
    },
  },
  settings: {
    promptProfile: "layered-navigation-multi-agent-v1",
    experimentalAuthoringStrategy: "saved-module-v1",
  },
};

describe("experimental authoring guidance", () => {
  it("keeps the absent strategy byte-identical to the PR610 control prompt", () => {
    const control = buildLayeredNavigationPrompt(
      interaction,
      "file:///graph-client.js",
      undefined,
      "file:///complete.js",
      "Codex",
      false,
      false,
    );
    const explicitControl = buildLayeredNavigationPrompt(
      interaction,
      "file:///graph-client.js",
      undefined,
      "file:///complete.js",
      "Codex",
      false,
      false,
      undefined,
    );
    expect(explicitControl).toBe(control);
    expect(createHash("sha256").update(control).digest("hex")).toBe(
      "6ced0914937227824c76f475749a8d6e34a074981bb077e6f4989f2548ae8171",
    );
    expect(control).not.toContain("Experimental authoring strategy");
  });

  it.each(EXPERIMENTAL_AUTHORING_STRATEGIES.filter((strategy) => strategy !== "code-model-recursion-v1"))(
    "delivers one bounded JavaScript treatment for %s",
    (strategy) => {
      const prompt = buildLayeredNavigationPrompt(
        interaction,
        "@relayer/graph-client",
        undefined,
        false,
        "Codex",
        true,
        false,
        strategy,
      );
      expect(prompt).toContain("Experimental authoring strategy");
      expect(prompt).toContain(
        javascriptExperimentalAuthoringGuidance(strategy, 21),
      );
      expect(prompt).not.toContain("graph_helpers.py");
      expect(prompt).toContain(
        "final graph call must be await graph.submit(21)",
      );
    },
  );

  it("replaces the stdin-only restriction only in the isolated saved-module arm", () => {
    const prompt = buildLayeredNavigationPrompt(
      interaction,
      "@relayer/graph-client",
      undefined,
      false,
      "Codex",
      true,
      false,
      "saved-module-v1",
    );
    expect(prompt).toContain(
      "node --input-type=module < '.relayer/authoring-experiments/21/graph.mjs'",
    );
    expect(prompt).not.toContain(
      "do not create a script in either the project checkout or a temporary directory",
    );
    expect(prompt).toContain(
      "grants no additional filesystem, network, graph, or completion authority",
    );
  });

  it("refuses the saved-module arm at the trusted pinned-launcher boundary", () => {
    expect(
      () =>
        new CodexBasicHarness(
          {
            threadId: 1,
            permissionProfileId: "auto",
            permissionBinding: configuration.permissionBindings.auto!,
            workingDirectory: "/isolated/experiment",
            configuration,
          },
          {
            graphAuthoringLauncherPath:
              "/immutable/runtime/graph-authoring-launcher",
          },
        ),
    ).toThrow("cannot widen the trusted graph-authoring launcher contract");
  });

  it("refuses the Prime-only code/model treatment in Codex before execution", () => {
    expect(
      () =>
        new CodexBasicHarness({
          threadId: 1,
          permissionProfileId: "auto",
          permissionBinding: configuration.permissionBindings.auto!,
          workingDirectory: "/isolated/experiment",
          configuration: {
            ...configuration,
            settings: {
              ...configuration.settings,
              experimentalAuthoringStrategy: "code-model-recursion-v1",
            },
          },
        }),
    ).toThrow("requires the prime.agent Python execution surface");
  });

  it.each(EXPERIMENTAL_AUTHORING_STRATEGIES)(
    "keeps Prime guidance Python-specific for %s",
    (strategy) => {
      const guidance = pythonExperimentalAuthoringGuidance(strategy, 21);
      expect(guidance).toContain("Experimental authoring strategy");
      expect(guidance).not.toContain("graph.mjs");
      expect(guidance).not.toContain("Recursive JavaScript");
    },
  );

  it("distinguishes local functions, native helpers, and semantic Complete", () => {
    const js = javascriptExperimentalAuthoringGuidance(
      "decompose-publish-v1",
      21,
    );
    const python = pythonExperimentalAuthoringGuidance(
      "decompose-publish-v1",
      21,
    );
    for (const guidance of [js, python]) {
      expect(guidance).toContain("functions only structure local computation");
      expect(guidance).toContain(
        "native helpers remain inside this completion",
      );
      expect(guidance).toMatch(
        /only an explicit complete\(input(?:Graph|_graph)\) call creates a separately accepted semantic child/i,
      );
      expect(guidance).toContain("never publish empty placeholders");
      expect(guidance).toContain(
        "there is no required helper, child, node, call, or recursion count",
      );
    }
  });

  it("executes the frozen Python call reference and changes recursion from the returned value", () => {
    const program = `
import asyncio, json, sys, types
calls = []
async def host_request(kind, payload):
    assert kind == "relayer.experimental.model.complete"
    calls.append(payload["prompt"])
    split = sys.argv[1] == "split" and "depth=0" in payload["prompt"]
    return {"text": json.dumps({"split": split}), "usage": {"totalTokens": 1}}
rlm = types.ModuleType("rlm")
rlm.host_request = host_request
sys.modules["rlm"] = rlm
${PYTHON_CODE_MODEL_CALL_REFERENCE}
async def walk(values, depth=0, call_id="root", parent_call_id=None):
    response = await relayer_model_complete(
        f"depth={depth};values={values}",
        call_id=call_id,
        parent_call_id=parent_call_id,
        depth=depth,
    )
    decision = json.loads(response["text"])
    if decision["split"] and depth < 2:
        midpoint = len(values) // 2
        return await walk(values[:midpoint], depth + 1, call_id + ".left", call_id) + await walk(values[midpoint:], depth + 1, call_id + ".right", call_id)
    return [{"depth": depth, "values": values}]
publications = []
class Graph:
    async def advance_current(self, layer):
        publications.append({"kind": "current", "layer": layer})
    async def submit(self, node_id):
        publications.append({"kind": "accepted", "nodeId": node_id})
async def main():
    result = await walk([1, 2, 3, 4])
    await Graph().advance_current({"leafCount": len(result), "findings": result})
    await Graph().submit(21)
    return result
result = asyncio.run(main())
print(json.dumps({"calls": calls, "result": result, "publications": publications}))
`;
    const run = (mode: "split" | "stop") => JSON.parse(execFileSync(pythonExecutable, ["-c", program, mode], {
      encoding: "utf8",
    })) as {
      calls: string[];
      result: { depth: number; values: number[] }[];
      publications: { kind: string; layer?: { leafCount: number }; nodeId?: number }[];
    };
    const split = run("split");
    const stop = run("stop");
    expect(split.calls).toHaveLength(3);
    expect(split.result.map(({ depth }) => depth)).toEqual([1, 1]);
    expect(split.publications).toEqual([
      { kind: "current", layer: { leafCount: 2, findings: split.result } },
      { kind: "accepted", nodeId: 21 },
    ]);
    expect(stop.calls).toHaveLength(1);
    expect(stop.result).toEqual([{ depth: 0, values: [1, 2, 3, 4] }]);
    expect(stop.publications[0]?.layer?.leafCount).toBe(1);
  });
});
