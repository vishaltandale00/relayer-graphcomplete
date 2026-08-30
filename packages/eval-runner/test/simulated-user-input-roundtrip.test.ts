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

  it("accepts model-authored option keys while preserving the exact committed snapshot", () => {
    const underscored = requiredControls.map((entry) => ({
      ...entry,
      options: entry.options.map((option) => ({ ...option, key: option.key.replaceAll("-", "_") })),
    }));
    expect(gradeInputRoundTripControlSet(underscored, underscored).passed).toBe(true);
    expect(gradeInputRoundTripControlSet(underscored, requiredControls).checks[1]!.passed).toBe(false);
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

  it.each([
    ["text", "Why does the deployment window affect rollback?"],
    ["single_select", "Is the rollout strategy documented?"],
    ["multi_select", "Are the validation signals visible?"],
  ] as const)("rejects a %s keyword-bearing prompt that does not ask for the required decision", (control, prompt) => {
    const misleading = requiredControls.map((entry) => entry.control === control ? { ...entry, prompt } : entry);
    expect(gradeInputRoundTripControlSet(misleading, misleading).checks[0]!.passed).toBe(false);
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

  it.each([
    ["missing authored control", requiredControls.slice(0, 2), requiredControls.slice(0, 2), 0],
    ["duplicate authored identity", [requiredControls[0], requiredControls[0], requiredControls[2]], requiredControls, 0],
    ["distributed nodes", requiredControls.map((entry, index) => ({ ...entry, sourceNodeId: index + 2 })), requiredControls, 0],
    ["wrong single-select options", requiredControls.map((entry) => entry.control === "single_select"
      ? { ...entry, options: [{ key: "full-rollout", label: "Full rollout" }] }
      : entry), requiredControls, 0],
    ["wrong multi-select minimum", requiredControls.map((entry) => entry.control === "multi_select"
      ? { ...entry, minimumSelections: 1 }
      : entry), requiredControls, 0],
    ["partial commits", requiredControls, requiredControls.slice(0, 2), 1],
    ["duplicate commits", requiredControls, [requiredControls[0], requiredControls[0], requiredControls[2]], 1],
  ] as const)("rejects %s", (_name, authored, committed, failedIndex) => {
    const result = gradeInputRoundTripControlSet(authored, committed);
    expect(result.passed).toBe(false);
    expect(result.checks[failedIndex]!.passed).toBe(false);
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

  it.each([
    ["authored acceptance", (value: ReturnType<typeof evidence>) => { value.authoredAccepted = false; }, 0],
    ["submitted semantic value", (value: ReturnType<typeof evidence>) => { value.interaction.submittedInputs = []; }, 0],
    ["child provenance", (value: ReturnType<typeof evidence>) => { value.inputChildren[0]!.actionId = 14; }, 0],
    ["normalized harness input", (value: ReturnType<typeof evidence>) => { value.harnessTraceEvents = []; }, 1],
  ])("fails when %s is absent or changed", (_name, mutate, failedIndex) => {
    const value = evidence();
    mutate(value);
    const result = gradeInputRoundTrip(expectation, value);
    expect(result.passed).toBe(false);
    expect(result.checks[failedIndex]!.passed).toBe(false);
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

  it.each(["command_execution", "file_change", "mcp_tool_call", "web_search"] as const)(
    "rejects a %s capability in the grounding trace",
    (type) => {
      expect(() => assertInputGroundingTrace([{ id: "forbidden", type } as never]))
        .toThrow(`Input grounding judge used forbidden capability: ${type}`);
    },
  );

  it("requires one visible evidence item for every submitted value before rating a composite response grounded", async () => {
    await expect(runInputGroundingJudge({
      submittedInput: { values: [{ text: "Tuesday" }, { selected: [{ key: "canary", label: "Canary" }] }] },
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
              reason: "Only one value is visibly grounded.",
              visibleEvidence: ["The visible node says Canary."],
            }),
            usage: null,
          };
        },
      }),
    })).rejects.toThrow("invalid structured rating");
  });
});
