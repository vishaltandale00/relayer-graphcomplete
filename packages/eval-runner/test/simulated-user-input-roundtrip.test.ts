import { describe, expect, it } from "vitest";
import {
  assertInputGroundingTrace,
  gradeInputRoundTrip,
  gradeInputRoundTripControlSet,
  gradeInputRoundTripSet,
  runInputGroundingJudge,
} from "../src/simulated-user/input-roundtrip.js";

const expectation = {
  occurrence: { presentingInteractionNodeId: 41, presentingLayerId: 10, actionId: 13 },
  sourceNodeId: 2,
  action: { control: "single_select", prompt: "Which route?", options: [{ key: "b", label: "Route B" }] },
  value: { selected: [{ key: "b", label: "Route B" }] },
} as const;

const semantic = { action: expectation.action, value: expectation.value };
const prompt = `Harness preamble\nNormalized interaction input:\n${JSON.stringify({
  message: "",
  contexts: [],
  submittedInputs: [semantic],
}, null, 2)}\n\nHarness guidance`;

function evidence() {
  return {
    authoredAccepted: true,
    interaction: { id: 52, graphNodeId: 99, submittedInputs: [semantic] },
    inputChildren: [{
      id: 1,
      parentInteractionNodeId: 99,
      ...expectation.occurrence,
      actionId: Number(expectation.occurrence.actionId),
      sourceNodeId: 2,
      action: expectation.action,
      value: expectation.value,
    }],
    harnessTraceEvents: [{ type: "prompt", data: { text: prompt } }],
  };
}

describe("input round-trip structural gate", () => {
  const requiredControls = [
    {
      presentingInteractionNodeId: 41, presentingLayerId: 10, sourceNodeId: 2, actionId: 13,
      control: "text", prompt: "What deployment window should we use?", options: [],
    },
    {
      presentingInteractionNodeId: 41, presentingLayerId: 10, sourceNodeId: 2, actionId: 14, control: "single_select",
      prompt: "Which rollout strategy should we use?",
      options: [{ key: "canary", label: "Canary" }, { key: "full-rollout", label: "Full rollout" }],
    },
    {
      presentingInteractionNodeId: 41, presentingLayerId: 10, sourceNodeId: 2, actionId: 15, control: "multi_select",
      prompt: "Which validation signals should we monitor?",
      options: [
        { key: "health-metrics", label: "Health metrics" },
        { key: "logs", label: "Logs" },
        { key: "synthetic-checks", label: "Synthetic checks" },
      ],
      minimumSelections: 2,
    },
  ] as const;

  it("requires unique text, single-select, and multi-select authoring and commits", () => {
    expect(gradeInputRoundTripControlSet(requiredControls, requiredControls)).toMatchObject({
      passed: true,
      checks: [{ passed: true }, { passed: true }],
    });
  });

  it("rejects controls that preserve the option matrix but ask unrelated questions", () => {
    const unrelated = requiredControls.map((entry) => ({
      ...entry,
      prompt: entry.control === "text"
        ? "What should the launch announcement say?"
        : entry.control === "single_select"
          ? "Which team owns this?"
          : "Which documents should we attach?",
    }));
    expect(gradeInputRoundTripControlSet(unrelated, unrelated).checks[0]!.passed).toBe(false);
  });

  it("rejects every keyword-bearing prompt that avoids the required decision", () => {
    const cases = [
    ["text", "Why does the deployment window affect rollback?"],
    ["single_select", "Is the rollout strategy documented?"],
    ["multi_select", "Are the validation signals visible?"],
    ] as const;
    expect(cases.map(([control]) => control), "deceptive prompt inventory").toEqual([
      "text", "single_select", "multi_select",
    ]);
    for (const [control, prompt] of cases) {
      const misleading = requiredControls.map((entry) => entry.control === control ? { ...entry, prompt } : entry);
      expect.soft(gradeInputRoundTripControlSet(misleading, misleading).checks[0]!.passed, control).toBe(false);
    }
  });

  it("accepts direct imperative phrasing for each required decision", () => {
    const imperative = requiredControls.map((entry) => ({
      ...entry,
      prompt: entry.control === "text"
        ? "Enter the deployment window we should use."
        : entry.control === "single_select"
          ? "Select the rollout strategy we should use."
          : "Choose the validation signals to monitor.",
    }));
    expect(gradeInputRoundTripControlSet(imperative, imperative).checks[0]!.passed).toBe(true);
  });

  it("rejects missing, duplicate, and distributed authored controls", () => {
    const cases = [
      ["missing authored control", requiredControls.slice(0, 2)],
      ["duplicate authored identity", [requiredControls[0], requiredControls[0], requiredControls[2]]],
      ["distributed nodes", requiredControls.map((entry, index) => ({ ...entry, sourceNodeId: index + 2 }))],
    ] as const;
    expect(cases.map(([label]) => label), "authored identity inventory").toEqual([
      "missing authored control", "duplicate authored identity", "distributed nodes",
    ]);
    for (const [label, authored] of cases) {
      const result = gradeInputRoundTripControlSet(authored, requiredControls);
      expect.soft(result.passed, `${label}: aggregate`).toBe(false);
      expect.soft(result.checks[0]!.passed, `${label}: authored`).toBe(false);
    }
  });

  it("rejects option-key, option-set, and selection-minimum drift", () => {
    const underscored = requiredControls.map((entry) => ({
      ...entry,
      options: entry.options.map((option) => ({ ...option, key: option.key.replaceAll("-", "_") })),
    }));
    const cases = [
      ["authored option keys", underscored, underscored, 0],
      ["committed option keys", underscored, requiredControls, 1],
      ["single-select options", requiredControls.map((entry) => entry.control === "single_select"
        ? { ...entry, options: [{ key: "full-rollout", label: "Full rollout" }] }
        : entry), requiredControls, 0],
      ["multi-select minimum", requiredControls.map((entry) => entry.control === "multi_select"
        ? { ...entry, minimumSelections: 1 }
        : entry), requiredControls, 0],
    ] as const;
    expect(cases.map(([label]) => label), "option contract inventory").toEqual([
      "authored option keys", "committed option keys", "single-select options", "multi-select minimum",
    ]);
    for (const [label, authored, committed, failedIndex] of cases) {
      const result = gradeInputRoundTripControlSet(authored, committed);
      expect.soft(result.passed, `${label}: aggregate`).toBe(false);
      expect.soft(result.checks[failedIndex]!.passed, `${label}: checkpoint`).toBe(false);
    }
  });

  it("rejects partial and duplicate committed input multisets", () => {
    const cases = [
      ["partial commits", requiredControls.slice(0, 2)],
      ["duplicate commits", [requiredControls[0], requiredControls[0], requiredControls[2]]],
    ] as const;
    expect(cases.map(([label]) => label), "committed multiset inventory").toEqual([
      "partial commits", "duplicate commits",
    ]);
    for (const [label, committed] of cases) {
      const result = gradeInputRoundTripControlSet(requiredControls, committed);
      expect.soft(result.passed, `${label}: aggregate`).toBe(false);
      expect.soft(result.checks[1]!.passed, `${label}: committed`).toBe(false);
    }
  });

  it("passes only when accepted authoring, product materialization, exact provenance, and normalized trace agree", () => {
    expect(gradeInputRoundTrip(expectation, evidence())).toMatchObject({
      passed: true,
      checks: [
        { name: "input-roundtrip:materialized-provenance:action-13", passed: true },
        { name: "input-roundtrip:normalized-harness-input:action-13", passed: true },
      ],
    });
  });

  it("rejects an extra or duplicate materialized input outside the complete commissioned multiset", () => {
    const value = evidence();
    expect(gradeInputRoundTripSet([expectation], value).passed).toBe(true);
    value.interaction.submittedInputs.push(semantic);
    value.inputChildren.push({ ...value.inputChildren[0]!, id: 2 });
    value.harnessTraceEvents = [{
      type: "prompt",
      data: { text: prompt.replace('"submittedInputs": [', '"submittedInputs": [\n    ' + `${JSON.stringify(semantic)},`) },
    }];

    const result = gradeInputRoundTripSet([expectation], value);
    expect(result.passed).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "input-roundtrip:exact-materialized-input-set",
      passed: false,
    }));
  });

  it("scopes mandatory gate identities to each input action", () => {
    const other = {
      ...expectation,
      occurrence: { ...expectation.occurrence, actionId: 14 },
    };
    expect(gradeInputRoundTrip(other, evidence()).checks.map(({ name }) => name)).toEqual([
      "input-roundtrip:materialized-provenance:action-14",
      "input-roundtrip:normalized-harness-input:action-14",
    ]);
  });

  it("rejects every missing or changed round-trip stage", () => {
    const cases = [
    ["authored acceptance", (value: ReturnType<typeof evidence>) => { value.authoredAccepted = false; }, 0],
    ["submitted semantic value", (value: ReturnType<typeof evidence>) => { value.interaction.submittedInputs = []; }, 0],
    ["child provenance", (value: ReturnType<typeof evidence>) => { value.inputChildren[0]!.actionId = 14; }, 0],
    ["normalized harness input", (value: ReturnType<typeof evidence>) => { value.harnessTraceEvents = []; }, 1],
    ] as const;
    expect(cases.map(([label]) => label), "round-trip stage inventory").toEqual([
      "authored acceptance", "submitted semantic value", "child provenance", "normalized harness input",
    ]);
    for (const [label, mutate, failedIndex] of cases) {
      const value = evidence();
      mutate(value);
      const result = gradeInputRoundTrip(expectation, value);
      expect.soft(result.passed, `${label}: aggregate`).toBe(false);
      expect.soft(result.checks[failedIndex]!.passed, `${label}: checkpoint`).toBe(false);
    }
  });

  it("parses braces and escapes inside the normalized input JSON without matching unrelated prompt text", () => {
    const value = evidence();
    value.harnessTraceEvents = [{
      type: "prompt",
      data: { text: prompt.replace("Which route?", "Which {route} says \\\"go\\\"?") },
    }];
    expect(gradeInputRoundTrip(expectation, value).checks[1]!.passed).toBe(false);
  });
});

describe("input round-trip grounding rating", () => {
  it("records a versioned screenshot-only structured judgment under read-only authority", async () => {
    let observedInput: unknown;
    let observedThreadOptions: unknown;
    const rating = await runInputGroundingJudge({
      submittedInput: { text: "Tuesday at 10" },
      screenshot: {
        screenshotId: "shot-1",
        threadRevision: "revision-2",
        imagePaths: ["/tmp/shot-1.png"],
      },
      codexPathOverride: "/managed/codex",
      environment: { HOME: "/tmp/home", SECRET: "must-not-pass" },
      workingDirectory: "/tmp/work",
      model: "gpt-test",
      modelReasoningEffort: "high",
      threadFactory: (codexOptions, threadOptions) => {
        expect(codexOptions.env).toEqual({ HOME: "/tmp/home" });
        observedThreadOptions = threadOptions;
        return {
          id: "grounding-thread",
          async run(input) {
            observedInput = input;
            return {
              items: [{ id: "message-1", type: "agent_message", text: "structured" }],
              finalResponse: JSON.stringify({
                verdict: "grounded",
                reason: "The answer schedules the submitted Tuesday window.",
                visibleEvidence: ["The visible node says Tuesday at 10."],
              }),
              usage: null,
            };
          },
        };
      },
    });

    expect(observedThreadOptions).toMatchObject({
      sandboxMode: "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
    });
    expect(observedInput).toEqual(expect.arrayContaining([
      { type: "local_image", path: "/tmp/shot-1.png" },
    ]));
    expect(rating).toMatchObject({
      status: "completed",
      verdict: "grounded",
      screenshot: {
        screenshotId: "shot-1",
        threadRevision: "revision-2",
        imageRefs: ["shot-1.png"],
      },
      judge: { codexThreadId: "grounding-thread" },
    });
  });

  it("rejects every mutating or network capability in the grounding trace", () => {
    const cases = ["command_execution", "file_change", "mcp_tool_call", "web_search"] as const;
    expect(cases, "forbidden grounding capability inventory").toEqual([
      "command_execution", "file_change", "mcp_tool_call", "web_search",
    ]);
    for (const type of cases) {
      expect.soft(() => assertInputGroundingTrace([{ id: "forbidden", type } as never]), type)
        .toThrow(`Input grounding judge used forbidden capability: ${type}`);
    }
  });

  it("requires one visible evidence item for every nested selected signal before rating a composite response grounded", async () => {
    await expect(runInputGroundingJudge({
      submittedInput: {
        values: [
          { text: "Tuesday" },
          { selected: [{ key: "logs", label: "Logs" }, { key: "synthetic", label: "Synthetic checks" }] },
        ],
      },
      screenshot: { screenshotId: "shot-2", threadRevision: "revision-3", imagePaths: ["/tmp/shot-2.png"] },
      codexPathOverride: "/managed/codex",
      workingDirectory: "/tmp/work",
      model: "gpt-test",
      modelReasoningEffort: "high",
      threadFactory: () => ({
        id: "grounding-thread",
        async run() {
          return {
            items: [{ id: "message-1", type: "agent_message", text: "structured" }],
            finalResponse: JSON.stringify({
              verdict: "grounded",
              reason: "The aggregate controls are visible, but one selected signal is not grounded.",
              visibleEvidence: ["The visible node says Tuesday.", "The visible node says Logs."],
            }),
            usage: null,
          };
        },
      }),
    })).rejects.toThrow("invalid structured rating");
  });
});
