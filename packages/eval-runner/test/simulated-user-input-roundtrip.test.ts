import { describe, expect, it } from "vitest";
import {
  assertInputGroundingTrace,
  gradeInputRoundTrip,
  gradeInputRoundTripControlSet,
  gradeInputRoundTripSet,
  runInputGroundingJudge,
  type InputRoundTripControlIdentity,
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

const underscoredControls = requiredControls.map((entry) => ({
  ...entry,
  options: entry.options.map((option) => ({ ...option, key: option.key.replaceAll("-", "_") })),
}));
const unrelatedControls = requiredControls.map((entry) => ({
  ...entry,
  prompt: entry.control === "text"
    ? "What should the launch announcement say?"
    : entry.control === "single_select"
      ? "Which team owns this?"
      : "Which documents should we attach?",
}));
const keywordPrompt = (control: string, replacement: string) => requiredControls.map((entry) => (
  entry.control === control ? { ...entry, prompt: replacement } : entry
));

describe("input round-trip structural gate", () => {
  it("grades control-set authoring and commits against the required decision matrix", () => {
    expect(gradeInputRoundTripControlSet(requiredControls, requiredControls), "exact authoring and commits pass").toMatchObject({
      passed: true,
      checks: [{ passed: true }, { passed: true }],
    });

    const imperative = requiredControls.map((entry) => ({
      ...entry,
      prompt: entry.control === "text"
        ? "Enter the deployment window we should use."
        : entry.control === "single_select"
          ? "Select the rollout strategy we should use."
          : "Choose the validation signals to monitor.",
    }));
    expect(
      gradeInputRoundTripControlSet(imperative, imperative).checks[0]!.passed,
      "direct imperative phrasing is accepted for each required decision",
    ).toBe(true);

    const cases: readonly [label: string, authored: readonly InputRoundTripControlIdentity[], committed: readonly InputRoundTripControlIdentity[], failedCheck: number][] = [
      ["option keys are fixed as well as labels (authoring)", underscoredControls, underscoredControls, 0],
      ["option keys are fixed as well as labels (commits)", underscoredControls, requiredControls, 1],
      ["unrelated questions with a preserved option matrix", unrelatedControls, unrelatedControls, 0],
      ["text keyword prompt that does not ask for the decision", keywordPrompt("text", "Why does the deployment window affect rollback?"), keywordPrompt("text", "Why does the deployment window affect rollback?"), 0],
      ["single-select keyword prompt that does not ask for the decision", keywordPrompt("single_select", "Is the rollout strategy documented?"), keywordPrompt("single_select", "Is the rollout strategy documented?"), 0],
      ["multi-select keyword prompt that does not ask for the decision", keywordPrompt("multi_select", "Are the validation signals visible?"), keywordPrompt("multi_select", "Are the validation signals visible?"), 0],
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
    ];
    expect(cases, "every authoring and commit corruption is a named row").toHaveLength(13);
    for (const [label, authored, committed, failedCheck] of cases) {
      const result = gradeInputRoundTripControlSet(authored, committed);
      expect.soft(result.passed, `${label}: the gate fails`).toBe(false);
      expect.soft(result.checks[failedCheck]!.passed, `${label}: check ${failedCheck} names the failure`).toBe(false);
    }
  });

  it("passes only when accepted authoring, product materialization, exact provenance, and normalized trace agree", () => {
    expect(gradeInputRoundTrip(expectation, evidence()), "complete agreement passes with named gates").toMatchObject({
      passed: true,
      checks: [
        { name: "input-roundtrip:materialized-provenance:action-13", passed: true },
        { name: "input-roundtrip:normalized-harness-input:action-13", passed: true },
      ],
    });

    const other = {
      ...expectation,
      occurrence: { ...expectation.occurrence, actionId: 14 },
    };
    expect(
      gradeInputRoundTrip(other, evidence()).checks.map(({ name }) => name),
      "mandatory gate identities are scoped to each input action",
    ).toEqual([
      "input-roundtrip:materialized-provenance:action-14",
      "input-roundtrip:normalized-harness-input:action-14",
    ]);

    const extra = evidence();
    expect(gradeInputRoundTripSet([expectation], extra).passed, "the exact commissioned multiset passes").toBe(true);
    extra.interaction.submittedInputs.push(semantic);
    extra.inputChildren.push({ ...extra.inputChildren[0]!, id: 2 });
    extra.harnessTraceEvents = [{
      type: "prompt",
      data: { text: prompt.replace('"submittedInputs": [', '"submittedInputs": [\n    ' + `${JSON.stringify(semantic)},`) },
    }];
    const extraResult = gradeInputRoundTripSet([expectation], extra);
    expect(extraResult.passed, "an extra or duplicate materialized input fails the set gate").toBe(false);
    expect(extraResult.checks, "the exact-materialized-input-set check names the failure").toContainEqual(expect.objectContaining({
      name: "input-roundtrip:exact-materialized-input-set",
      passed: false,
    }));

    const cases: readonly [label: string, mutate: (value: ReturnType<typeof evidence>) => void, failedCheck: number][] = [
      ["authored acceptance", (value) => { value.authoredAccepted = false; }, 0],
      ["submitted semantic value", (value) => { value.interaction.submittedInputs = []; }, 0],
      ["child provenance", (value) => { value.inputChildren[0]!.actionId = 14; }, 0],
      ["normalized harness input", (value) => { value.harnessTraceEvents = []; }, 1],
      ["braces and escapes inside the normalized input JSON", (value) => {
        value.harnessTraceEvents = [{
          type: "prompt",
          data: { text: prompt.replace("Which route?", "Which {route} says \\\"go\\\"?") },
        }];
      }, 1],
    ];
    expect(cases, "every evidence corruption is a named row").toHaveLength(5);
    for (const [label, mutate, failedCheck] of cases) {
      const value = evidence();
      mutate(value);
      const result = gradeInputRoundTrip(expectation, value);
      expect.soft(result.passed, `${label}: the round trip fails`).toBe(false);
      expect.soft(result.checks[failedCheck]!.passed, `${label}: check ${failedCheck} names the failure`).toBe(false);
    }
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
        expect(codexOptions.env, "the judge environment keeps only allowlisted variables").toEqual({ HOME: "/tmp/home" });
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

    expect(observedThreadOptions, "the grounding thread is read-only and offline").toMatchObject({
      sandboxMode: "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
    });
    expect(observedInput, "the screenshot is supplied as a local image").toEqual(expect.arrayContaining([
      { type: "local_image", path: "/tmp/shot-1.png" },
    ]));
    expect(rating, "the rating is a versioned, screenshot-bound judgment").toMatchObject({
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

  it("gates the grounding trace to screenshot reasoning and requires evidence for every selected signal", async () => {
    const forbidden = ["command_execution", "file_change", "mcp_tool_call", "web_search"] as const;
    for (const type of forbidden) {
      expect(
        () => assertInputGroundingTrace([{ id: "forbidden", type } as never]),
        `a ${type} capability in the grounding trace is rejected`,
      ).toThrow(`Input grounding judge used forbidden capability: ${type}`);
    }

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
    }), "one visible evidence item is required for every nested selected signal").rejects.toThrow("invalid structured rating");
  });
});
