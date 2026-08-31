import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_SIMULATED_USER_RUBRIC, InputOperatorController } from "@relayer/eval-runner";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LOCAL_SIMULATED_USER_JUDGE_CONFIGURATION,
  LOCAL_SIMULATED_USER_AUTORUN_ENV,
  LOCAL_SIMULATED_USER_AUTORUN_FLAG,
  PERSONAL_PRESENTATION_AUTORUN_ENV,
  PERSONAL_PRESENTATION_AUTORUN_FLAG,
  PRODUCT_PRESENTATION_AUTORUN_ENV,
  PRODUCT_PRESENTATION_AUTORUN_FLAG,
  INPUT_ROUNDTRIP_AUTORUN_ENV,
  INPUT_ROUNDTRIP_AUTORUN_FLAG,
  buildAcceptedReviewTopology,
  buildInputGroundingTopology,
  captureGroundingTargets,
  createInputOperatorLease,
  createLocalSimulatedUserJudgeRunner,
  createReviewSessionController,
  gradeAcceptedReviewTopology,
  groundingCaptureTargets,
  groundingRootNodeIds,
  incompleteInputRoundTripEvidence,
  operatorInteractionIsTerminal,
  parseProductWriteResponse,
  persistInputRatingReceipt,
  resolveLocalSimulatedUserAutorun,
} from "../desktop/eval-main/simulated-user-judge.mjs";

const directories = [];
const digest = `sha256:${"a".repeat(64)}`;
const codexRuntime = Object.freeze({
  executable: "/managed/codex",
  environment: Object.freeze({ PATH: "/managed/codex-path:/usr/bin" }),
});

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("local Electron simulated-user judge adapter", () => {
  it("keeps Send retry identity for malformed or invalid successful JSON while accepting bodyless control revocation", async () => {
    const occurrence = { presentingInteractionNodeId: 11, presentingLayerId: 12, actionId: 13 };
    const action = { control: "text", prompt: "Name the constraint" };
    const sendBodies = [];
    let sendAttempts = 0;
    const operator = new InputOperatorController({
      authority: { kind: "scoped_product_write", threadId: "thread one", authorityId: "operator-test" },
      createId: () => "stable-input-id",
      transport: {
        async request(path, request) {
          if (path.endsWith("attachments")) {
            return {
              revision: 8,
              attachments: [{ occurrence, action, value: request.body.value, draftRevision: 8 }],
            };
          }
          sendBodies.push(request.body);
          sendAttempts += 1;
          return parseProductWriteResponse(new Response(
            ['{"id":', '{}', 'null', '{"id":0}', '{"id":1.5}', '{"id":9007199254740992}', '{"id":99}'][sendAttempts - 1],
            { status: 201, headers: { "Content-Type": "application/json" } },
          ), { requireJson: true, requirePositiveInteractionId: true });
        },
      },
    });
    const capture = operator.beginCapture({ occurrence, action, threadRevision: "thread-r1" });
    operator.rateCapture({ ...capture, ratingId: "rating-1" });
    await operator.commit({ captureId: capture.captureId, value: { text: "Exact" }, expectedRevision: 7 });

    for (const expectedError of [
      "valid JSON",
      "positive interaction id",
      "positive interaction id",
      "positive interaction id",
      "positive interaction id",
      "positive interaction id",
    ]) {
      await expect(operator.send({})).rejects.toThrow(expectedError);
      expect(operator.state()).toMatchObject({
        committedDraftRevision: 8,
        pendingSendInputId: "stable-input-id",
      });
    }
    await expect(operator.send({})).resolves.toEqual({ id: 99 });
    expect(sendBodies).toHaveLength(7);
    expect(sendBodies).toEqual(sendBodies.map(() => (
      { text: "", inputId: "stable-input-id", inputDraftRevision: 8 }
    )));

    await expect(parseProductWriteResponse(new Response(null, { status: 204 })))
      .resolves.toBeUndefined();
  });

  it("persists revision-one input ratings independently for reused nodes across presenting layers", async () => {
    const artifactDirectory = await temporaryDirectory();
    const context = {
      artifactDirectory,
      execution: { id: "execution-1" },
      thread: { id: "7" },
      turn: { id: "41" },
    };
    const receipt = (presentingLayerId) => ({
      schemaVersion: 1,
      reviewRevision: 1,
      review: { layerId: String(presentingLayerId), nodeId: "2", actions: [] },
      captures: [{
        captureId: `capture-${presentingLayerId}`,
        threadRevision: "thread:7:input-draft:0",
        actionId: "13",
        occurrence: { presentingInteractionNodeId: 41, presentingLayerId, actionId: 13 },
      }],
    });

    const first = await persistInputRatingReceipt(context, receipt(10));
    const second = await persistInputRatingReceipt(context, receipt(20));

    expect(first.ref).toBe("input-rating-receipts/layer-10-node-2-revision-1.json");
    expect(second.ref).toBe("input-rating-receipts/layer-20-node-2-revision-1.json");
    await expect(readFile(join(artifactDirectory, first.ref), "utf8")).resolves.toContain('"presentingLayerId": 10');
    await expect(readFile(join(artifactDirectory, second.ref), "utf8")).resolves.toContain('"presentingLayerId": 20');
  });

  it("retries scoped operator release after a transient revocation failure", async () => {
    const operator = { state: vi.fn() };
    const revoke = vi.fn()
      .mockRejectedValueOnce(new Error("temporary DELETE failure"))
      .mockResolvedValueOnce(undefined);
    const lease = createInputOperatorLease({ operator, revoke });

    await expect(lease.release()).rejects.toThrow("temporary DELETE failure");
    await expect(Promise.all([lease.release(), lease.release()])).resolves.toEqual([undefined, undefined]);
    await expect(lease.release()).resolves.toBeUndefined();

    expect(lease.operator).toBe(operator);
    expect(revoke).toHaveBeenCalledTimes(2);
  });

  it("treats cancelled operator follow-ups as terminal", () => {
    expect(operatorInteractionIsTerminal("cancelled")).toBe(true);
    expect(operatorInteractionIsTerminal("running")).toBe(false);
  });

  it("classifies a committed input without Send as indeterminate evidence", () => {
    expect(incompleteInputRoundTripEvidence([])).toMatchObject({ status: "not_exercised" });
    expect(incompleteInputRoundTripEvidence([{ operation: "input_commit", inputDraftRevision: 9 }]))
      .toMatchObject({
        status: "indeterminate",
        passed: false,
        detail: "The simulated user committed input, but the judge ended before activating Send.",
      });
    expect(incompleteInputRoundTripEvidence([
      { operation: "input_commit", inputDraftRevision: 9 },
      { operation: "send", response: { id: 99 } },
    ])).toBeNull();
  });

  it("captures every visible root node when grounding an input follow-up", () => {
    expect(groundingRootNodeIds({
      completionOutput: { rootLayer: { nodes: [{ id: 7 }, { id: 8 }, { id: 9 }] } },
    })).toEqual(["7", "8", "9"]);
  });

  it("plans grounding captures for every accepted descendant layer", async () => {
    const layers = acceptedLayers({ includeGrandchild: true });
    const topology = await buildAcceptedReviewTopology({
      turnId: 41,
      rootLayerId: 10,
      loadLayer: async (layerId) => layers.get(String(layerId)),
    });

    expect(groundingCaptureTargets(topology)).toEqual([
      { layerId: "10", nodeIds: ["2"], path: [] },
      {
        layerId: "20",
        nodeIds: ["3"],
        path: [{ sourceNodeId: "2", actionId: "11" }],
      },
      {
        layerId: "30",
        nodeIds: ["4"],
        path: [
          { sourceNodeId: "2", actionId: "11" },
          { sourceNodeId: "3", actionId: "21" },
        ],
      },
    ]);
  });

  it("loads grounding layers from the submitted-input follow-up turn", async () => {
    const layers = acceptedLayers({ includeGrandchild: true });
    const loadLayer = vi.fn(async ({ layerId }) => layers.get(String(layerId)));
    const topology = await buildInputGroundingTopology({
      threadId: 7,
      interaction: {
        id: 41,
        graphNodeId: 2,
        completionOutput: { rootLayer: { layer: { id: 10 } } },
      },
      loadLayer,
    });

    expect(topology.turnId).toBe("41");
    expect(loadLayer).toHaveBeenCalledWith({ threadId: 7, turnId: 41, layerId: "10" });
    expect(loadLayer).toHaveBeenCalledWith({ threadId: 7, turnId: 41, layerId: "20" });
    expect(loadLayer).toHaveBeenCalledWith({ threadId: 7, turnId: 41, layerId: "30" });
  });

  it("rewinds grounding captures by action navigation only", async () => {
    const calls = [];
    let selectedNodeId = null;
    const session = {
      state: vi.fn(async () => ({ selectedNodeId })),
      interact: vi.fn(async (input) => {
        calls.push(["interact", input.elementRef]);
        if (input.elementRef.startsWith("node-")) selectedNodeId = input.elementRef.slice(5);
        if (input.elementRef.startsWith("action-")) selectedNodeId = null;
      }),
      screenshot: vi.fn(async ({ label }) => { calls.push(["screenshot", label]); return { label }; }),
      history: vi.fn(async ({ delta }) => { calls.push(["history", delta]); selectedNodeId = "2"; }),
    };
    const targets = [
      { layerId: "10", nodeIds: ["2"], path: [] },
      {
        layerId: "20",
        nodeIds: ["3"],
        path: [{ sourceNodeId: "2", actionId: "11" }],
      },
      {
        layerId: "30",
        nodeIds: ["4"],
        path: [
          { sourceNodeId: "2", actionId: "11" },
          { sourceNodeId: "3", actionId: "21" },
        ],
      },
    ];

    await captureGroundingTargets(session, targets);

    expect(session.history.mock.calls).toEqual([[{ delta: -1 }], [{ delta: -2 }]]);
    expect(calls.filter(([kind]) => kind === "history")).toEqual([
      ["history", -1],
      ["history", -2],
    ]);
    expect(session.screenshot).toHaveBeenCalledTimes(3);
    expect(session.interact.mock.calls.filter(([input]) => input.elementRef === "node-2"))
      .toHaveLength(1);
  });

  it("uses a code-owned quality configuration with explicit reasoning", () => {
    expect(LOCAL_SIMULATED_USER_JUDGE_CONFIGURATION).toEqual({
      model: "gpt-5.6-sol",
      modelReasoningEffort: "high",
    });
  });

  it("keeps paid autorun off by default and resolves the exact local H3 proof selection", () => {
    expect(resolveLocalSimulatedUserAutorun({ environment: {}, arguments: [] })).toBeNull();
    const selection = {
      testCaseIds: ["project.h3.sanitize-status-code"],
      harnessConfigurationNames: [
        "codex-layered-navigation-luna",
        "prime-agent-layered-navigation-luna",
      ],
      judgeConfigurationName: "simulated-user-sol-high",
    };
    expect(resolveLocalSimulatedUserAutorun({
      environment: { [LOCAL_SIMULATED_USER_AUTORUN_ENV]: "1" },
      arguments: [],
    })).toEqual(selection);
    expect(resolveLocalSimulatedUserAutorun({
      environment: {},
      arguments: [LOCAL_SIMULATED_USER_AUTORUN_FLAG],
    })).toEqual(selection);
    expect(resolveLocalSimulatedUserAutorun({
      environment: { [LOCAL_SIMULATED_USER_AUTORUN_ENV]: "1" },
      arguments: [],
      availableHarnessConfigurationNames: ["codex-layered-navigation-luna"],
    })).toEqual({
      ...selection,
      harnessConfigurationNames: ["codex-layered-navigation-luna"],
    });
    expect(() => resolveLocalSimulatedUserAutorun({
      environment: { [LOCAL_SIMULATED_USER_AUTORUN_ENV]: "1" },
      arguments: [],
      availableHarnessConfigurationNames: [],
    })).toThrow("requires codex-layered-navigation-luna");
    expect(() => resolveLocalSimulatedUserAutorun({
      environment: { [LOCAL_SIMULATED_USER_AUTORUN_ENV]: "1" },
      arguments: [],
      packaged: true,
    })).toThrow("only in a local development checkout");
    const personalSelection = {
      testCaseIds: ["empty-project.task-system.single-turn"],
      harnessConfigurationNames: [
        "codex-layered-personal-presentation-v0",
        "codex-layered-personal-presentation-v1",
      ],
      judgeConfigurationName: "simulated-user-sol-high",
    };
    expect(resolveLocalSimulatedUserAutorun({
      environment: { [PERSONAL_PRESENTATION_AUTORUN_ENV]: "1" },
      arguments: [],
    })).toEqual(personalSelection);
    expect(resolveLocalSimulatedUserAutorun({
      environment: {},
      arguments: [PERSONAL_PRESENTATION_AUTORUN_FLAG],
      availableHarnessConfigurationNames: personalSelection.harnessConfigurationNames,
    })).toEqual(personalSelection);
    expect(() => resolveLocalSimulatedUserAutorun({
      environment: { [PERSONAL_PRESENTATION_AUTORUN_ENV]: "1" },
      arguments: [],
      availableHarnessConfigurationNames: personalSelection.harnessConfigurationNames.slice(0, 1),
    })).toThrow("requires both V0 and V1");
    const productSelection = {
      testCaseIds: ["empty-project.task-system.single-turn"],
      harnessConfigurationNames: ["codex-basic"],
      judgeConfigurationName: "simulated-user-sol-high",
    };
    expect(resolveLocalSimulatedUserAutorun({
      environment: { [PRODUCT_PRESENTATION_AUTORUN_ENV]: "1" },
      arguments: [],
      availableHarnessConfigurationNames: ["codex-basic"],
    })).toEqual(productSelection);
    expect(resolveLocalSimulatedUserAutorun({
      environment: {},
      arguments: [PRODUCT_PRESENTATION_AUTORUN_FLAG],
    })).toEqual(productSelection);
    expect(() => resolveLocalSimulatedUserAutorun({
      environment: { [PRODUCT_PRESENTATION_AUTORUN_ENV]: "1" },
      arguments: [],
      availableHarnessConfigurationNames: [],
    })).toThrow("requires codex-basic");
    const inputRoundTripSelection = {
      testCaseIds: ["empty-project.node-input-roundtrip.single-turn"],
      harnessConfigurationNames: ["codex-basic"],
      judgeConfigurationName: "simulated-user-sol-high",
    };
    expect(resolveLocalSimulatedUserAutorun({
      environment: { [INPUT_ROUNDTRIP_AUTORUN_ENV]: "1" },
      arguments: [],
      availableHarnessConfigurationNames: ["codex-basic"],
    })).toEqual(inputRoundTripSelection);
    expect(resolveLocalSimulatedUserAutorun({
      environment: {},
      arguments: [INPUT_ROUNDTRIP_AUTORUN_FLAG],
    })).toEqual(inputRoundTripSelection);
    expect(() => resolveLocalSimulatedUserAutorun({
      environment: {
        [PERSONAL_PRESENTATION_AUTORUN_ENV]: "1",
        [PRODUCT_PRESENTATION_AUTORUN_ENV]: "1",
      },
      arguments: [],
    })).toThrow("Select only one");
  });

  it("returns existing ordered PNG tiles to MCP without duplicating screenshot capture", async () => {
    const directory = await temporaryDirectory();
    const screenshotId = "shot-1";
    const screenshotDirectory = join(directory, screenshotId);
    await mkdir(screenshotDirectory);
    await writeFile(join(screenshotDirectory, `${screenshotId}-001.png`), "first");
    await writeFile(join(screenshotDirectory, `${screenshotId}-002.png`), "second");
    const screenshot = vi.fn(async () => ({
      ok: true,
      screenshot: metadata({ screenshotId, layerId: "layer-1", selectedNodeId: null, tileCount: 2 }),
    }));
    const session = {
      screenshot,
      interact: vi.fn(),
      history: vi.fn(),
      artifactDirectoryFor: () => screenshotDirectory,
    };
    const screenshots = new Map();
    const controller = createReviewSessionController(session, screenshots);

    const result = await controller.screenshot({
      target: { kind: "viewport" },
      mode: "visible",
      label: "Layer",
    });

    expect(screenshot).toHaveBeenCalledTimes(1);
    expect(result.output.screenshot.screenshotId).toBe(screenshotId);
    expect(result.images).toEqual([
      { data: Buffer.from("first").toString("base64"), mimeType: "image/png" },
      { data: Buffer.from("second").toString("base64"), mimeType: "image/png" },
    ]);
    expect(screenshots.get(screenshotId)).toEqual(result.output.screenshot);
  });

  it("fails an input capture when its screenshot artifact cannot be loaded", async () => {
    const directory = await temporaryDirectory();
    const screenshotId = "shot-missing-input";
    const shot = {
      ...metadata({
        screenshotId,
        layerId: "10",
        selectedNodeId: "2",
        tileCount: 1,
        target: { kind: "element", elementRef: "input-action-41-10-13" },
        mode: "full",
      }),
      threadRevision: "thread:7:input-draft:0",
    };
    const session = {
      state: vi.fn(async () => ({
        threadRevision: shot.threadRevision,
        turnId: "41",
        layerId: "10",
        selectedNodeId: "2",
        activatedActionId: null,
        navigationPath: [{ layerId: "10", viaActionId: null }],
        controls: [{ elementRef: "send-interaction", kind: "input-operator-send", disabled: false }],
      })),
      screenshot: vi.fn(async () => ({ ok: true, screenshot: shot })),
      interact: vi.fn(),
      history: vi.fn(),
      artifactDirectoryFor: () => join(directory, "missing"),
    };
    const operator = {
      beginCapture: vi.fn(() => ({ captureId: "capture-missing", threadRevision: shot.threadRevision })),
      failCapture: vi.fn(),
    };
    const screenshots = new Map();
    const controller = createReviewSessionController(session, screenshots, {
      inputOperator: operator,
      inputBindings: new Map([["input-action-41-10-13", {
        occurrence: { presentingInteractionNodeId: 41, presentingLayerId: 10, actionId: 13 },
        action: { control: "text", prompt: "When?" },
      }]]),
    });

    await expect(controller.screenshot({
      target: { kind: "element", elementRef: "input-action-41-10-13" },
      mode: "full",
      label: "Missing artifact",
    })).rejects.toThrow();
    expect(operator.failCapture).toHaveBeenCalledWith("capture-missing");
    expect(screenshots).toEqual(new Map());
  });

  it("fails an input capture when the screenshot request returns an unsuccessful result", async () => {
    const occurrence = { presentingInteractionNodeId: 41, presentingLayerId: 10, actionId: 13 };
    const session = {
      state: vi.fn(async () => ({ threadRevision: "thread:7:input-draft:0" })),
      screenshot: vi.fn(async () => ({ ok: false, error: "viewport unavailable" })),
      interact: vi.fn(),
      history: vi.fn(),
    };
    const operator = {
      beginCapture: vi.fn(() => ({
        captureId: "capture-unsuccessful",
        threadRevision: "thread:7:input-draft:0",
      })),
      failCapture: vi.fn(),
    };
    const controller = createReviewSessionController(session, new Map(), {
      inputOperator: operator,
      inputBindings: new Map([["input-action-41-10-13", {
        occurrence,
        action: { control: "text", prompt: "When?" },
      }]]),
    });

    await expect(controller.screenshot({
      target: { kind: "element", elementRef: "input-action-41-10-13" },
      mode: "full",
      label: "Unsuccessful screenshot",
    })).resolves.toEqual({
      output: { ok: false, error: "viewport unavailable" },
      images: [],
    });
    expect(operator.failCapture).toHaveBeenCalledWith("capture-unsuccessful");
  });

  it("refuses operator Send until one commissioned input is committed and the production control is enabled", async () => {
    const session = {
      state: vi.fn(async () => ({
        threadRevision: "thread:7:input-draft:1",
        turnId: "41",
        layerId: "10",
        selectedNodeId: "2",
        activatedActionId: null,
        navigationPath: [{ layerId: "10", viaActionId: null }],
        controls: [],
      })),
      screenshot: vi.fn(),
      interact: vi.fn(),
      history: vi.fn(),
    };
    const operator = {
      commit: vi.fn(async () => 1),
      send: vi.fn(async () => ({ id: 99 })),
    };
    const controller = createReviewSessionController(session, new Map(), { inputOperator: operator });

    await expect(controller.interact({ elementRef: "send-interaction", activate: true }))
      .rejects.toThrow("visible operator Send control");
    expect(operator.send).not.toHaveBeenCalled();

    session.state.mockResolvedValueOnce({
      ...(await session.state()),
      controls: [{ elementRef: "send-interaction", kind: "input-operator-send", disabled: false }],
    });
    await expect(controller.interact({ elementRef: "send-interaction", activate: true }))
      .rejects.toThrow("committed input");
    expect(operator.send).not.toHaveBeenCalled();
  });

  it("enables the production operator Send affordance after a commissioned commit", async () => {
    const occurrence = { presentingInteractionNodeId: 41, presentingLayerId: 10, actionId: 13 };
    const session = {
      state: vi.fn(async () => ({
        threadRevision: "thread:7:input-draft:1",
        turnId: "41",
        layerId: "10",
        selectedNodeId: "2",
        activatedActionId: null,
        navigationPath: [{ layerId: "10", viaActionId: null }],
        controls: [{ elementRef: "send-interaction", kind: "input-operator-send", disabled: false }],
      })),
      setInputOperatorCommitted: vi.fn(async () => {}),
      screenshot: vi.fn(),
      interact: vi.fn(),
      history: vi.fn(),
    };
    const operator = {
      commit: vi.fn(async () => 1),
      send: vi.fn(async () => ({ id: 99 })),
    };
    const controller = createReviewSessionController(session, new Map(), {
      inputOperator: operator,
      inputBindings: new Map([["input-action-41-10-13", {
        occurrence,
        action: { control: "text", prompt: "When?" },
      }]]),
      persistInputRatingReceipt: vi.fn(async () => "receipt-1.json"),
    });
    const directory = await temporaryDirectory();
    const screenshotDirectory = join(directory, "shot-input");
    await mkdir(screenshotDirectory);
    await writeFile(join(screenshotDirectory, "shot-input-001.png"), "input");
    session.screenshot.mockResolvedValue({
      ok: true,
      screenshot: {
        ...metadata({
          screenshotId: "shot-input",
          layerId: "10",
          selectedNodeId: "2",
          tileCount: 1,
          target: { kind: "element", elementRef: "input-action-41-10-13" },
          mode: "full",
        }),
        threadRevision: "thread:7:input-draft:0",
      },
    });
    session.artifactDirectoryFor = () => screenshotDirectory;
    operator.beginCapture = vi.fn(() => ({ captureId: "capture-1", threadRevision: "thread:7:input-draft:0" }));
    operator.failCapture = vi.fn();
    operator.rateCaptures = vi.fn();
    operator.state = vi.fn(() => ({ captures: [{ captureId: "capture-1", status: "capturing" }] }));
    await controller.screenshot({ target: { kind: "element", elementRef: "input-action-41-10-13" }, mode: "full" });
    await controller.recordInputRatings({
      revision: 1,
      review: { layerId: "10", nodeId: "2", actions: [{ actionId: "13", kind: "input", evidence: ["shot-input"], inputActionJudgments: {} }] },
    });
    await controller.interact({ elementRef: "input-action-41-10-13", value: { text: "Friday" } });
    expect(session.setInputOperatorCommitted).toHaveBeenCalledWith(true);
    await expect(controller.interact({ elementRef: "send-interaction", activate: true }))
      .resolves.toMatchObject({ operator: { operation: "send" } });
  });

  it("rates a versioned input capture before commissioning the separate operator", async () => {
    const directory = await temporaryDirectory();
    const screenshotId = "shot-input";
    const screenshotDirectory = join(directory, screenshotId);
    await mkdir(screenshotDirectory);
    await writeFile(join(screenshotDirectory, `${screenshotId}-001.png`), "input");
    const shot = {
      ...metadata({ screenshotId, layerId: "10", selectedNodeId: "2", tileCount: 1, target: { kind: "element", elementRef: "input-action-13" }, mode: "full" }),
      threadRevision: "thread:7:revision:1",
    };
    const session = {
      state: vi.fn(async () => ({
        threadRevision: shot.threadRevision,
        turnId: "41",
        layerId: "10",
        selectedNodeId: "2",
        activatedActionId: null,
        navigationPath: [{ layerId: "10", viaActionId: null }],
        controls: [{ elementRef: "send-interaction", kind: "input-operator-send", disabled: false }],
      })),
      screenshot: vi.fn(async () => ({ ok: true, screenshot: shot })),
      interact: vi.fn(),
      history: vi.fn(),
      artifactDirectoryFor: () => screenshotDirectory,
    };
    const operator = {
      beginCapture: vi.fn(() => ({ captureId: "capture-1", threadRevision: shot.threadRevision })),
      failCapture: vi.fn(),
      rateCaptures: vi.fn(),
      commit: vi.fn(async () => 9),
      send: vi.fn(async () => ({ interaction: { id: 99 } })),
    };
    const binding = {
      occurrence: { presentingInteractionNodeId: 41, presentingLayerId: 10, actionId: 13 },
      action: { control: "text", prompt: "What constraint matters most?" },
    };
    const persistInputRatingReceipt = vi.fn(async () => "input-rating-receipts/node-2-revision-3.json");
    const controller = createReviewSessionController(session, new Map(), {
      inputOperator: operator,
      inputBindings: new Map([["input-action-13", binding]]),
      persistInputRatingReceipt,
    });

    await controller.screenshot({
      target: { kind: "element", elementRef: "input-action-13" },
      mode: "full",
      label: "Input action before answer",
    });
    await expect(controller.interact({ elementRef: "input-action-13", value: { text: "Ship Friday" } }))
      .rejects.toThrow("must be rated before");
    await controller.recordInputRatings({
      revision: 3,
      review: {
        layerId: "10",
        nodeId: "2",
        actions: [{
          actionId: "13",
          kind: "input",
          evidence: [screenshotId],
          inputActionJudgments: {
            prompt_answerability: { evidence: [screenshotId] },
            option_set_quality: { evidence: [screenshotId] },
            control_fit: { evidence: [screenshotId] },
          },
        }],
      },
    });
    expect(operator.rateCaptures).toHaveBeenCalledWith([{
      captureId: "capture-1",
      ratingId: "input-rating-receipts/node-2-revision-3.json",
      threadRevision: shot.threadRevision,
    }]);
    expect(persistInputRatingReceipt.mock.invocationCallOrder[0])
      .toBeLessThan(operator.rateCaptures.mock.invocationCallOrder[0]);
    await expect(controller.interact({ elementRef: "input-action-13", value: { text: "Ship Friday" } }))
      .resolves.toMatchObject({ operator: { operation: "input_commit", inputDraftRevision: 9 } });
    await expect(controller.interact({ elementRef: "send-interaction", activate: true }))
      .resolves.toMatchObject({ operator: { operation: "send" } });
    expect(operator.commit).toHaveBeenCalledWith({ captureId: "capture-1", value: { text: "Ship Friday" } });
    expect(session.interact).not.toHaveBeenCalled();
  });

  it("records a successful input Commit before renderer acknowledgement and retries only the acknowledgement", async () => {
    const acknowledgement = vi.fn()
      .mockRejectedValueOnce(new Error("renderer commit acknowledgement timed out"))
      .mockResolvedValueOnce(undefined);
    const { controller, input, operator } = await commissionedInputController({ acknowledgement });

    await expect(controller.interact(input)).rejects.toThrow("renderer commit acknowledgement timed out");
    expect(operator.commit).toHaveBeenCalledTimes(1);
    expect(controller.operatorTrace()).toMatchObject([{
      operation: "input_commit",
      inputDraftRevision: 9,
      rendererAcknowledgement: {
        status: "failed",
        attempts: 1,
        error: "renderer commit acknowledgement timed out",
      },
    }]);

    await expect(controller.interact({
      value: { text: "Ship Saturday" },
      elementRef: input.elementRef,
    })).rejects.toThrow("acknowledgement is pending");
    expect(operator.commit).toHaveBeenCalledTimes(1);
    expect(acknowledgement).toHaveBeenCalledTimes(1);
    await expect(controller.interact({ value: { text: input.value.text }, elementRef: input.elementRef }))
      .resolves.toMatchObject({ operator: { operation: "input_commit", inputDraftRevision: 9 } });
    expect(operator.commit).toHaveBeenCalledTimes(1);
    expect(acknowledgement).toHaveBeenCalledTimes(2);
    expect(controller.operatorTrace()).toMatchObject([{
      operation: "input_commit",
      rendererAcknowledgement: { status: "completed", attempts: 2 },
    }]);
  });

  it("records a successful Send before renderer acknowledgement and retries only the acknowledgement", async () => {
    const acknowledgement = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("renderer Send acknowledgement timed out"))
      .mockResolvedValueOnce(undefined);
    const { controller, input, operator } = await commissionedInputController({ acknowledgement });
    await controller.interact(input);
    const send = { elementRef: "send-interaction", activate: true };

    await expect(controller.interact(send)).rejects.toThrow("renderer Send acknowledgement timed out");
    expect(operator.send).toHaveBeenCalledTimes(1);
    expect(controller.operatorTrace()).toMatchObject([
      { operation: "input_commit" },
      {
        operation: "send",
        response: { id: 99 },
        rendererAcknowledgement: {
          status: "failed",
          attempts: 1,
          error: "renderer Send acknowledgement timed out",
        },
      },
    ]);

    await expect(controller.interact({
      activate: true,
      elementRef: "another-interaction",
    })).rejects.toThrow("acknowledgement is pending");
    expect(operator.send).toHaveBeenCalledTimes(1);
    expect(acknowledgement).toHaveBeenCalledTimes(2);
    await expect(controller.interact({ activate: true, elementRef: "send-interaction" }))
      .resolves.toMatchObject({ operator: { operation: "send", response: { id: 99 } } });
    expect(operator.send).toHaveBeenCalledTimes(1);
    expect(acknowledgement).toHaveBeenCalledTimes(3);
    expect(controller.operatorTrace().at(-1)).toMatchObject({
      operation: "send",
      rendererAcknowledgement: { status: "completed", attempts: 2 },
    });
  });

  it("captures and atomically commissions two input actions on the same node", async () => {
    const directory = await temporaryDirectory();
    const screenshotsByRef = new Map();
    for (const actionId of ["13", "14"]) {
      const screenshotId = `shot-input-${actionId}`;
      const screenshotDirectory = join(directory, screenshotId);
      await mkdir(screenshotDirectory);
      await writeFile(join(screenshotDirectory, `${screenshotId}-001.png`), screenshotId);
      screenshotsByRef.set(`input-action-${actionId}`, {
        ...metadata({
          screenshotId,
          layerId: "10",
          selectedNodeId: "2",
          tileCount: 1,
          target: { kind: "element", elementRef: `input-action-${actionId}` },
          mode: "full",
        }),
        threadRevision: "thread:7:input-draft:0",
      });
    }
    const session = {
      state: vi.fn(async () => ({
        threadRevision: "thread:7:input-draft:0",
        turnId: "41",
        layerId: "10",
        selectedNodeId: "2",
        activatedActionId: null,
        navigationPath: [{ layerId: "10", viaActionId: null }],
      })),
      screenshot: vi.fn(async ({ target }) => ({ ok: true, screenshot: screenshotsByRef.get(target.elementRef) })),
      interact: vi.fn(),
      history: vi.fn(),
      artifactDirectoryFor: (screenshotId) => join(directory, screenshotId),
    };
    let captureSequence = 0;
    const operator = {
      beginCapture: vi.fn(({ threadRevision }) => ({ captureId: `capture-${++captureSequence}`, threadRevision })),
      failCapture: vi.fn(),
      rateCaptures: vi.fn(),
      commit: vi.fn(),
      send: vi.fn(),
    };
    const controller = createReviewSessionController(session, new Map(), {
      inputOperator: operator,
      inputBindings: new Map(["13", "14"].map((actionId) => [`input-action-${actionId}`, {
        occurrence: { presentingInteractionNodeId: 41, presentingLayerId: 10, actionId: Number(actionId) },
        action: { control: "text", prompt: `Question ${actionId}` },
      }])),
      persistInputRatingReceipt: vi.fn(async () => "input-rating-receipts/node-2-revision-1.json"),
    });

    for (const actionId of ["13", "14"]) {
      await controller.screenshot({
        target: { kind: "element", elementRef: `input-action-${actionId}` },
        mode: "full",
        label: `Input ${actionId}`,
      });
    }
    await controller.recordInputRatings({
      revision: 1,
      review: {
        layerId: "10",
        nodeId: "2",
        actions: ["13", "14"].map((actionId) => ({
          actionId,
          kind: "input",
          evidence: [`shot-input-${actionId}`],
          inputActionJudgments: {},
        })),
      },
    });

    expect(operator.rateCaptures).toHaveBeenCalledWith([
      { captureId: "capture-1", ratingId: "input-rating-receipts/node-2-revision-1.json", threadRevision: "thread:7:input-draft:0" },
      { captureId: "capture-2", ratingId: "input-rating-receipts/node-2-revision-1.json", threadRevision: "thread:7:input-draft:0" },
    ]);
  });

  it("discards a durable rating receipt when capture commission fails", async () => {
    const directory = await temporaryDirectory();
    const screenshotId = "shot-expired";
    const screenshotDirectory = join(directory, screenshotId);
    await mkdir(screenshotDirectory);
    await writeFile(join(screenshotDirectory, `${screenshotId}-001.png`), "input");
    const shot = {
      ...metadata({
        screenshotId,
        layerId: "10",
        selectedNodeId: "2",
        tileCount: 1,
        target: { kind: "element", elementRef: "input-action-41-10-13" },
        mode: "full",
      }),
      threadRevision: "thread:7:input-draft:0",
    };
    const session = {
      state: vi.fn(async () => ({
        threadRevision: shot.threadRevision,
        turnId: "41",
        layerId: "10",
        selectedNodeId: "2",
        activatedActionId: null,
        navigationPath: [{ layerId: "10", viaActionId: null }],
      })),
      screenshot: vi.fn(async () => ({ ok: true, screenshot: shot })),
      interact: vi.fn(),
      history: vi.fn(),
      artifactDirectoryFor: () => screenshotDirectory,
    };
    const discard = vi.fn(async () => {});
    const operator = {
      beginCapture: vi.fn(() => ({ captureId: "capture-expired", threadRevision: shot.threadRevision })),
      failCapture: vi.fn(),
      rateCaptures: vi.fn(() => { throw new Error("capture timed out"); }),
    };
    const controller = createReviewSessionController(session, new Map(), {
      inputOperator: operator,
      inputBindings: new Map([["input-action-41-10-13", {
        occurrence: { presentingInteractionNodeId: 41, presentingLayerId: 10, actionId: 13 },
        action: { control: "text", prompt: "When?" },
      }]]),
      persistInputRatingReceipt: vi.fn(async () => ({
        ref: "input-rating-receipts/node-2-revision-1.json",
        discard,
      })),
    });
    await controller.screenshot({
      target: { kind: "element", elementRef: "input-action-41-10-13" },
      mode: "full",
      label: "Expired capture",
    });

    await expect(controller.recordInputRatings({
      revision: 1,
      review: {
        layerId: "10",
        nodeId: "2",
        actions: [{ actionId: "13", kind: "input", evidence: [screenshotId], inputActionJudgments: {} }],
      },
    })).rejects.toThrow("capture timed out");
    expect(discard).toHaveBeenCalledOnce();
    expect(controller.inputRatingReceiptRefs()).toEqual([]);
  });

  it("commissions the latest occurrence-matched capture when a node review is revised", async () => {
    const directory = await temporaryDirectory();
    let sequence = 0;
    const session = {
      state: vi.fn(async () => ({
        threadRevision: `thread:7:input-draft:${sequence}`,
        turnId: "41",
        layerId: "10",
        selectedNodeId: "2",
        activatedActionId: null,
        navigationPath: [{ layerId: "10", viaActionId: null }],
      })),
      screenshot: vi.fn(async () => {
        sequence += 1;
        const screenshotId = `shot-revision-${sequence}`;
        const screenshotDirectory = join(directory, screenshotId);
        await mkdir(screenshotDirectory);
        await writeFile(join(screenshotDirectory, `${screenshotId}-001.png`), screenshotId);
        return {
          ok: true,
          screenshot: {
            ...metadata({
              screenshotId,
              layerId: "10",
              selectedNodeId: "2",
              tileCount: 1,
              target: { kind: "element", elementRef: "input-action-41-10-13" },
              mode: "full",
            }),
            threadRevision: `thread:7:input-draft:${sequence - 1}`,
          },
        };
      }),
      interact: vi.fn(),
      history: vi.fn(),
      artifactDirectoryFor: (screenshotId) => join(directory, screenshotId),
    };
    const captures = new Map();
    const operator = {
      beginCapture: vi.fn(({ threadRevision }) => {
        const capture = { captureId: `capture-${sequence + 1}`, threadRevision };
        captures.set(capture.captureId, "capturing");
        return capture;
      }),
      failCapture: vi.fn(),
      rateCaptures: vi.fn((ratings) => {
        for (const { captureId } of ratings) captures.set(captureId, "commissioned");
      }),
      state: vi.fn(() => ({
        captures: [...captures].map(([captureId, status]) => ({ captureId, status })),
      })),
    };
    const controller = createReviewSessionController(session, new Map(), {
      inputOperator: operator,
      inputBindings: new Map([["input-action-41-10-13", {
        occurrence: { presentingInteractionNodeId: 41, presentingLayerId: 10, actionId: 13 },
        action: { control: "text", prompt: "When?" },
      }]]),
      persistInputRatingReceipt: vi.fn(async ({ reviewRevision }) => `receipt-${reviewRevision}.json`),
    });
    const review = (screenshotIds) => ({
      layerId: "10",
      nodeId: "2",
      actions: [{ actionId: "13", kind: "input", evidence: screenshotIds, inputActionJudgments: {} }],
    });

    await controller.screenshot({ target: { kind: "element", elementRef: "input-action-41-10-13" }, mode: "full", label: "First" });
    await controller.recordInputRatings({ revision: 1, review: review(["shot-revision-1"]) });
    await controller.screenshot({ target: { kind: "element", elementRef: "input-action-41-10-13" }, mode: "full", label: "Second" });
    await controller.recordInputRatings({ revision: 2, review: review(["shot-revision-2", "shot-revision-1"]) });

    expect(operator.rateCaptures).toHaveBeenLastCalledWith([{
      captureId: "capture-2",
      ratingId: "receipt-2.json",
      threadRevision: "thread:7:input-draft:1",
    }]);
  });

  it("rejects cross-cited capture evidence between two inputs on the same node", async () => {
    const directory = await temporaryDirectory();
    const screenshotDirectory = join(directory, "shot-input-14");
    await mkdir(screenshotDirectory);
    await writeFile(join(screenshotDirectory, "shot-input-14-001.png"), "input-14");
    const shot = {
      ...metadata({
        screenshotId: "shot-input-14",
        layerId: "10",
        selectedNodeId: "2",
        tileCount: 1,
        target: { kind: "element", elementRef: "input-action-14" },
        mode: "full",
      }),
      threadRevision: "thread:7:input-draft:0",
    };
    const session = {
      state: vi.fn(async () => ({
        threadRevision: shot.threadRevision,
        turnId: "41",
        layerId: "10",
        selectedNodeId: "2",
        activatedActionId: null,
        navigationPath: [{ layerId: "10", viaActionId: null }],
      })),
      screenshot: vi.fn(async () => ({ ok: true, screenshot: shot })),
      interact: vi.fn(),
      history: vi.fn(),
      artifactDirectoryFor: () => screenshotDirectory,
    };
    const operator = {
      beginCapture: vi.fn(() => ({ captureId: "capture-14", threadRevision: shot.threadRevision })),
      failCapture: vi.fn(),
      rateCaptures: vi.fn(),
      commit: vi.fn(),
      send: vi.fn(),
    };
    const controller = createReviewSessionController(session, new Map(), {
      inputOperator: operator,
      inputBindings: new Map([["input-action-14", {
        occurrence: { presentingInteractionNodeId: 41, presentingLayerId: 10, actionId: 14 },
        action: { control: "text", prompt: "Question 14" },
      }]]),
      persistInputRatingReceipt: vi.fn(async () => "unreachable.json"),
    });
    await controller.screenshot({
      target: { kind: "element", elementRef: "input-action-14" },
      mode: "full",
      label: "Input 14",
    });

    await expect(controller.recordInputRatings({
      revision: 1,
      review: {
        layerId: "10",
        nodeId: "2",
        actions: [{
          actionId: "13",
          kind: "input",
          evidence: ["shot-input-14"],
          inputActionJudgments: {},
        }],
      },
    })).rejects.toThrow("occurrence-matched");
    expect(operator.rateCaptures).not.toHaveBeenCalled();
  });

  it("recursively inventories only authoritative accepted navigate destinations", async () => {
    const layers = acceptedLayers();
    const loadLayer = vi.fn(async (layerId) => layers.get(String(layerId)));
    const topology = await buildAcceptedReviewTopology({
      turnId: 41,
      presentingInteractionNodeId: 99,
      rootLayerId: 10,
      loadLayer,
    });

    expect(loadLayer.mock.calls.map(([layerId]) => layerId)).toEqual(["10", "20"]);
    expect(topology).toEqual({
      turnId: "41",
      rootLayerId: "10",
      layers: [
        {
          id: "10",
          nodeIds: ["2"],
          edgeIds: [],
          actions: [
            { id: "11", sourceNodeId: "2", kind: "navigate", relation: "expand", targetLayerId: "20" },
            { id: "12", sourceNodeId: "2", kind: "invoke" },
          ],
        },
        { id: "20", nodeIds: ["3"], edgeIds: [], actions: [] },
      ],
    });
  });

  it("carries accepted text and select input questions into immutable review topology", async () => {
    const layers = acceptedLayers();
    layers.get("10").actions.push(
      {
        id: 13,
        sourceNodeId: 2,
        sourceLayerId: 10,
        kind: "input",
        label: "Explain",
        control: "text",
        prompt: "What constraint matters most?",
        state: "accepted",
      },
      {
        id: 14,
        sourceNodeId: 2,
        sourceLayerId: 10,
        kind: "input",
        label: "Choose one",
        control: "single_select",
        prompt: "Which environment?",
        options: [{ key: "preview", label: "Preview" }, { key: "stable", label: "Stable" }],
        state: "accepted",
      },
      {
        id: 15,
        sourceNodeId: 2,
        sourceLayerId: 10,
        kind: "input",
        label: "Choose checks",
        control: "multi_select",
        prompt: "Which checks are required?",
        options: [{ key: "unit", label: "Unit" }, { key: "electron", label: "Electron" }],
        minimumSelections: 2,
        state: "accepted",
      },
    );

    const topology = await buildAcceptedReviewTopology({
      turnId: 41,
      presentingInteractionNodeId: 99,
      rootLayerId: 10,
      loadLayer: async (layerId) => layers.get(String(layerId)),
    });

    expect(topology.layers[0].actions.slice(2)).toEqual([
      {
        id: "13",
        sourceNodeId: "2",
        kind: "input",
        control: "text",
        prompt: "What constraint matters most?",
        options: [],
        occurrence: { presentingInteractionNodeId: 99, presentingLayerId: 10, actionId: 13 },
      },
      {
        id: "14",
        sourceNodeId: "2",
        kind: "input",
        control: "single_select",
        prompt: "Which environment?",
        options: [{ key: "preview", label: "Preview" }, { key: "stable", label: "Stable" }],
        occurrence: { presentingInteractionNodeId: 99, presentingLayerId: 10, actionId: 14 },
      },
      {
        id: "15",
        sourceNodeId: "2",
        kind: "input",
        control: "multi_select",
        prompt: "Which checks are required?",
        options: [{ key: "unit", label: "Unit" }, { key: "electron", label: "Electron" }],
        minimumSelections: 2,
        occurrence: { presentingInteractionNodeId: 99, presentingLayerId: 10, actionId: 15 },
      },
    ]);
  });

  it("grades the complete accepted closure and requires a real grandchild for architecture", async () => {
    const layers = acceptedLayers({ includeGrandchild: true });
    const topology = await buildAcceptedReviewTopology({
      turnId: 41,
      rootLayerId: 10,
      loadLayer: async (layerId) => layers.get(String(layerId)),
    });

    expect(gradeAcceptedReviewTopology(topology, { requireGrandchild: true })).toEqual([
      {
        name: "graph:accepted-reachable-closure",
        passed: true,
        detail: "3 accepted layer(s) and their actions form the complete reachable closure.",
      },
      {
        name: "graph:root-child-grandchild",
        passed: true,
        detail: "The accepted response reaches expansion depth 2 from its root.",
      },
    ]);
    expect(gradeAcceptedReviewTopology(await buildAcceptedReviewTopology({
      turnId: 41,
      rootLayerId: 10,
      loadLayer: async (layerId) => acceptedLayers().get(String(layerId)),
    }), { requireGrandchild: true })[1]).toMatchObject({ passed: false });
  });

  it("rejects accepted actions whose source is outside the declared layer", async () => {
    const layers = acceptedLayers();
    layers.get("10").actions[0].sourceNodeId = 999;

    await expect(buildAcceptedReviewTopology({
      turnId: 41,
      rootLayerId: 10,
      loadLayer: async (layerId) => layers.get(String(layerId)),
    })).rejects.toThrow("source is outside its layer");
  });

  it("opens the exact turn, completes a fake six-tool review, and persists authoritative refs", async () => {
    const artifactDirectory = await temporaryDirectory();
    const screenshotDirectory = join(artifactDirectory, "screenshots");
    const layers = acceptedLayers();
    const loadLayer = vi.fn(async ({ layerId }) => layers.get(String(layerId)));
    const release = vi.fn(async () => {});
    const session = fakeReviewSession(screenshotDirectory);
    const openReviewSession = vi.fn(async (request) => ({
      session,
      state: {
        executionId: request.executionId,
        threadId: request.threadId,
        turnId: request.turnId,
        layerId: request.rootLayerId,
      },
      release,
    }));
    const runJudge = vi.fn(async ({ controller, reviewStore }) => {
      await controller.screenshot({ target: { kind: "viewport" }, mode: "visible", label: "root-context" });
      await controller.screenshot({ target: { kind: "element", elementRef: "node-2" }, mode: "full", label: "root-detail" });
      await controller.interact({ elementRef: "action-11", activate: true });
      await controller.screenshot({ target: { kind: "viewport" }, mode: "visible", label: "child-context" });
      await controller.screenshot({ target: { kind: "element", elementRef: "node-3" }, mode: "full", label: "child-detail" });
      await controller.history({ delta: -1 });
      await controller.screenshot({ target: { kind: "viewport" }, mode: "visible", label: "comparison" });
      expect(() => reviewStore.reviewLayer(layerReview("10", "shot-comparison")))
        .toThrow("different execution, thread, or turn state");
      reviewStore.reviewLayer(layerReview("10", "shot-root-context"));
      reviewStore.reviewLayer(layerReview("20", "shot-child-context"));
      reviewStore.reviewNode(nodeReview({
        layerId: "10",
        nodeId: "2",
        context: "shot-root-context",
        detail: "shot-root-detail",
        actions: [{
          actionId: "11",
          kind: "navigate",
          evidence: { source: ["shot-root-detail"], destination: ["shot-child-context"] },
          ratings: { placement: 4, label_expectation: 4, destination_delivery: 4, added_value: 4 },
          summary: "Useful child navigation.",
          findings: [],
        }, {
          actionId: "12",
          kind: "invoke",
          evidence: { source: ["shot-root-detail"] },
          ratings: { placement: 4, label_expectation: 4, apparent_value: 4 },
          summary: "Useful visible invocation.",
          findings: [],
        }],
      }));
      reviewStore.reviewNode(nodeReview({
        layerId: "20",
        nodeId: "3",
        context: "shot-child-context",
        detail: "shot-child-detail",
        actions: [],
      }));
      const review = reviewStore.submitReview({
        turnId: "41",
        evidence: {
          representative: ["shot-root-context", "shot-child-context", "shot-child-detail", "shot-comparison"],
        },
        ratings: {
          answer_quality: 4,
          recursive_coherence: 4,
          navigation_value: 4,
          presentation_quality: 4,
          follow_up_progress: null,
        },
        nullRatingJustifications: { follow_up_progress: "Initial turn." },
        summary: "Complete rendered review.",
        findings: [],
        structure: {
          overall: "helps",
          expansion: { need: "helpful", result: "works" },
          references: { need: "none", result: "absent" },
          reason: "The child layer adds useful detail.",
          evidence: ["shot-root-context", "shot-child-context"],
        },
        scoreCeiling: {
          maximum: 4,
          reason: "No critical comprehension gap exists.",
          evidence: ["shot-root-context", "shot-child-context"],
        },
      });
      return {
        rubric: DEFAULT_SIMULATED_USER_RUBRIC,
        toolTrace: [{ sequence: 1, tool: "screenshot", status: "completed" }],
        codexTrace: [{ type: "mcp_tool_call", tool: "screenshot" }],
        review,
      };
    });
    const resolveCodexRuntime = vi.fn(async () => codexRuntime);
    const captureInputRoundTrip = vi.fn(async () => {
      throw new Error("candidate trace unavailable");
    });
    const runner = createLocalSimulatedUserJudgeRunner({
      loadLayer,
      openReviewSession,
      resolveCodexRuntime,
      runJudge,
      captureInputRoundTrip,
    });

    const result = await runner({
      artifactDirectory,
      execution: { id: "execution-1" },
      artifact: {
        kind: "git_workspace",
        workingDirectory: artifactDirectory,
        baseRevision: "base-commit",
      },
      thread: { id: "7" },
      turn: { id: "41", rootLayerId: "10" },
      allowInputOperator: true,
      request: {
        text: "Explain the graph.",
        followUp: true,
        previousTurnIds: ["40"],
        comparisonTurnIds: ["40"],
      },
      reviewSequence: { index: 0, count: 1 },
    });

    expect(openReviewSession).toHaveBeenCalledWith(expect.objectContaining({
      executionId: "execution-1",
      threadId: "7",
      turnId: "41",
      rootLayerId: "10",
      artifactDirectory: screenshotDirectory,
      inputOperatorAvailable: false,
    }));
    expect(runJudge).toHaveBeenCalledTimes(1);
    expect(runJudge).toHaveBeenCalledWith(expect.objectContaining({
      workingDirectory: artifactDirectory,
      additionalDirectories: [],
      artifactEvidence: undefined,
      codexPathOverride: "/managed/codex",
      environment: { PATH: "/managed/codex-path:/usr/bin" },
      inputOperatorAvailable: false,
    }));
    expect(resolveCodexRuntime).toHaveBeenCalledOnce();
    expect(session.screenshot).toHaveBeenCalledTimes(5);
    expect(session.interact).toHaveBeenCalledTimes(1);
    expect(session.history).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith({ close: true });
    expect(result).toMatchObject({
      status: "completed",
      rubricRef: "rubric.json",
      configurationRef: "judge-configuration.json",
      interactionTraceRef: "interaction-trace.json",
      reviewRef: "review.json",
      coverageRef: "coverage.json",
      screenshotRefs: [
        "screenshots/shot-root-context/metadata.json",
        "screenshots/shot-root-detail/metadata.json",
        "screenshots/shot-child-context/metadata.json",
        "screenshots/shot-child-detail/metadata.json",
        "screenshots/shot-comparison/metadata.json",
      ],
      coverage: { complete: true },
      summary: "Complete rendered review.",
      inputRoundTrip: {
        status: "failed",
        passed: false,
        error: "candidate trace unavailable",
      },
    });
    expect(captureInputRoundTrip).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(join(artifactDirectory, "judge-configuration.json"), "utf8"))).toEqual({
      model: "gpt-5.6-sol",
      modelReasoningEffort: "high",
    });
    expect(JSON.parse(await readFile(join(artifactDirectory, "interaction-trace.json"), "utf8"))).toMatchObject({
      session: [{ type: "session-opened" }],
      tools: [{ tool: "screenshot" }],
      codex: [{ type: "mcp_tool_call", tool: "screenshot" }],
    });

    captureInputRoundTrip.mockClear();
    const rejudgeDirectory = await temporaryDirectory();
    const rejudge = await runner({
      artifactDirectory: rejudgeDirectory,
      execution: { id: "execution-1" },
      artifact: {
        kind: "git_workspace",
        workingDirectory: rejudgeDirectory,
        baseRevision: "base-commit",
      },
      thread: { id: "7" },
      turn: { id: "41", rootLayerId: "10" },
      request: {
        text: "Rejudge the rendered graph without write authority.",
        followUp: false,
        previousTurnIds: [],
        comparisonTurnIds: [],
      },
      allowInputOperator: false,
      reviewSequence: { index: 0, count: 1 },
    });
    expect(captureInputRoundTrip).not.toHaveBeenCalled();
    expect(rejudge).not.toHaveProperty("inputRoundTripRef");
    expect(rejudge).not.toHaveProperty("inputRoundTrip");
  });

  it("rejects a window on the wrong turn before invoking the judge", async () => {
    const artifactDirectory = await temporaryDirectory();
    const release = vi.fn(async () => {});
    const runJudge = vi.fn();
    const runner = createLocalSimulatedUserJudgeRunner({
      loadLayer: async ({ layerId }) => acceptedLayers().get(String(layerId)),
      openReviewSession: async () => ({
        session: fakeReviewSession(join(artifactDirectory, "screenshots")),
        state: { executionId: "execution-1", threadId: "7", turnId: "wrong", layerId: "10" },
        release,
      }),
      resolveCodexRuntime: async () => codexRuntime,
      runJudge,
    });

    await expect(runner({
      artifactDirectory,
      execution: { id: "execution-1" },
      thread: { id: "7" },
      turn: { id: "41", rootLayerId: "10" },
      request: { text: "Explain." },
      reviewSequence: { index: 0, count: 1 },
    })).rejects.toThrow("exact accepted turn and root layer");
    expect(runJudge).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith({ close: true });
  });

  it("does not mint input write authority for a judge-only rerun", async () => {
    const artifactDirectory = await temporaryDirectory();
    const createInputOperator = vi.fn();
    const runner = createLocalSimulatedUserJudgeRunner({
      loadLayer: async ({ layerId }) => acceptedLayers().get(String(layerId)),
      openReviewSession: async () => ({
        session: fakeReviewSession(join(artifactDirectory, "screenshots")),
        state: { executionId: "execution-1", threadId: "7", turnId: "41", layerId: "10" },
        release: vi.fn(async () => {}),
      }),
      resolveCodexRuntime: async () => codexRuntime,
      createInputOperator,
      runJudge: async () => { throw new Error("fixture stops before inference"); },
    });

    await runner({
      artifactDirectory,
      execution: { id: "execution-1" },
      thread: { id: "7" },
      turn: { id: "41", rootLayerId: "10" },
      request: { text: "Review only." },
      allowInputOperator: false,
      reviewSequence: { index: 0, count: 1 },
    });

    expect(createInputOperator).not.toHaveBeenCalled();
  });

  it("opens and judges with the actual operator capability, then retries transient lease cleanup", async () => {
    const artifactDirectory = await temporaryDirectory();
    const openReviewSession = vi.fn(async () => ({
      session: fakeReviewSession(join(artifactDirectory, "screenshots")),
      state: { executionId: "execution-1", threadId: "7", turnId: "41", layerId: "10" },
      release: vi.fn(async () => {}),
    }));
    const release = vi.fn()
      .mockRejectedValueOnce(new Error("transient DELETE failure"))
      .mockResolvedValueOnce(undefined);
    const createInputOperator = vi.fn(async () => ({ operator: {}, release }));
    const runJudge = vi.fn(async () => { throw new Error("fixture stops before inference"); });
    const runner = createLocalSimulatedUserJudgeRunner({
      loadLayer: async ({ layerId }) => acceptedLayers().get(String(layerId)),
      openReviewSession,
      resolveCodexRuntime: async () => codexRuntime,
      createInputOperator,
      runJudge,
    });

    await runner({
      artifactDirectory,
      execution: { id: "execution-1" },
      thread: { id: "7" },
      turn: { id: "41", rootLayerId: "10" },
      request: { text: "Review with input authority." },
      allowInputOperator: true,
      reviewSequence: { index: 0, count: 1 },
    });

    expect(createInputOperator.mock.invocationCallOrder[0]).toBeLessThan(openReviewSession.mock.invocationCallOrder[0]);
    expect(openReviewSession).toHaveBeenCalledWith(expect.objectContaining({ inputOperatorAvailable: true }));
    expect(runJudge).toHaveBeenCalledWith(expect.objectContaining({ inputOperatorAvailable: true }));
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("selects the input-aware recursive review store for rubric v11 and forwards artifact evidence", async () => {
    const artifactDirectory = await temporaryDirectory();
    const evidence = {
      schemaVersion: 1,
      source: "bounded_host_packet",
      summary: "One verifier fact.",
      facts: ["PASS workspace:focused-tests"],
    };
    const runJudge = vi.fn(async ({ reviewStore, artifactEvidence }) => {
      expect(reviewStore.snapshot()).toMatchObject({
        schemaVersion: 6,
        contractId: "recursive-presentation-judge-v6",
      });
      expect(artifactEvidence).toEqual(evidence);
      throw new Error("fixture stops before paid inference");
    });
    const runner = createLocalSimulatedUserJudgeRunner({
      loadLayer: async ({ layerId }) => acceptedLayers().get(String(layerId)),
      openReviewSession: async () => ({
        session: fakeReviewSession(join(artifactDirectory, "screenshots")),
        state: { executionId: "execution-1", threadId: "7", turnId: "41", layerId: "10" },
        release: vi.fn(async () => {}),
      }),
      resolveCodexRuntime: async () => codexRuntime,
      runJudge,
    });

    const result = await runner({
      artifactDirectory,
      execution: { id: "execution-1" },
      thread: { id: "7" },
      turn: { id: "41", rootLayerId: "10" },
      request: { text: "Explain." },
      rubric: { rubricVersion: "graph-presentation-rubric-v11" },
      artifactEvidence: evidence,
      reviewSequence: { index: 0, count: 1 },
    });

    expect(result).toMatchObject({ status: "partial", review: { schemaVersion: 6 }, error: "fixture stops before paid inference" });
  });

  it("retains committed input evidence when the judge fails after the product writes", async () => {
    const artifactDirectory = await temporaryDirectory();
    const layers = acceptedLayers();
    layers.get("10").actions.push({
      id: 13,
      sourceNodeId: 2,
      kind: "input",
      control: "text",
      prompt: "What constraint matters most?",
      state: "accepted",
    });
    const session = fakeReviewSession(join(artifactDirectory, "screenshots"));
    const captureScreenshot = session.screenshot;
    session.state = vi.fn(async () => ({
      threadRevision: "thread:7:revision:1",
      turnId: "41",
      layerId: "10",
      selectedNodeId: "2",
      activatedActionId: null,
      navigationPath: [{ layerId: "10", viaActionId: null }],
      controls: [{ elementRef: "send-interaction", kind: "input-operator-send", disabled: false }],
    }));
    session.setInputOperatorCommitted = vi.fn(async () => {});
    session.screenshot = vi.fn(async (input) => {
      const output = await captureScreenshot(input);
      output.screenshot.threadRevision = "thread:7:revision:1";
      return output;
    });
    const operator = {
      beginCapture: vi.fn(() => ({ captureId: "capture-13", threadRevision: "thread:7:revision:1" })),
      failCapture: vi.fn(),
      rateCaptures: vi.fn(),
      state: vi.fn(() => ({ captures: [{ captureId: "capture-13", status: "capturing" }] })),
      commit: vi.fn(async () => 9),
      send: vi.fn(async () => ({ id: 99 })),
    };
    const runJudge = vi.fn(async ({ controller }) => {
      await controller.screenshot({
        target: { kind: "element", elementRef: "input-action-41-10-13" },
        mode: "full",
        label: "input-before-write",
      });
      await controller.recordInputRatings({
        revision: 1,
        review: {
          layerId: "10",
          nodeId: "2",
          actions: [{
            actionId: "13",
            kind: "input",
            evidence: ["shot-input-before-write"],
            inputActionJudgments: {},
          }],
        },
      });
      await controller.interact({ elementRef: "input-action-41-10-13", value: { text: "Ship Friday" } });
      await controller.interact({ elementRef: "send-interaction", activate: true });
      throw new Error("judge failed after input submission");
    });
    const captureInputRoundTrip = vi.fn(async () => {
      throw new Error("follow-up capture unavailable");
    });
    const runner = createLocalSimulatedUserJudgeRunner({
      loadLayer: async ({ layerId }) => layers.get(String(layerId)),
      openReviewSession: async () => ({
        session,
        state: { executionId: "execution-1", threadId: "7", turnId: "41", layerId: "10" },
        release: vi.fn(async () => {}),
      }),
      resolveCodexRuntime: async () => codexRuntime,
      createInputOperator: async () => operator,
      runJudge,
      captureInputRoundTrip,
    });

    const result = await runner({
      artifactDirectory,
      execution: { id: "execution-1" },
      thread: { id: "7" },
      turn: { id: "41", graphNodeId: "41", rootLayerId: "10" },
      request: { text: "Review and answer the input." },
      allowInputOperator: true,
      reviewSequence: { index: 0, count: 1 },
    });

    expect(result).toMatchObject({
      status: "partial",
      error: "judge failed after input submission",
      inputRoundTrip: {
        status: "failed",
        error: "follow-up capture unavailable",
        operatorTrace: [
          { operation: "input_commit", inputDraftRevision: 9 },
          { operation: "send", response: { id: 99 } },
        ],
      },
    });
    expect(captureInputRoundTrip).toHaveBeenCalledWith(expect.objectContaining({
      operatorTrace: [
        expect.objectContaining({ operation: "input_commit", inputDraftRevision: 9 }),
        expect.objectContaining({ operation: "send", response: { id: 99 } }),
      ],
    }));
    expect(JSON.parse(await readFile(join(artifactDirectory, "input-roundtrip.json"), "utf8")))
      .toMatchObject(result.inputRoundTrip);
  });

  it("refuses to relabel a historical recursive rubric as the active v6 contract", async () => {
    const artifactDirectory = await temporaryDirectory();
    const release = vi.fn(async () => {});
    const runJudge = vi.fn();
    const runner = createLocalSimulatedUserJudgeRunner({
      loadLayer: async ({ layerId }) => acceptedLayers().get(String(layerId)),
      openReviewSession: async () => ({
        session: fakeReviewSession(join(artifactDirectory, "screenshots")),
        state: { executionId: "execution-1", threadId: "7", turnId: "41", layerId: "10" },
        release,
      }),
      resolveCodexRuntime: async () => codexRuntime,
      runJudge,
    });

    await expect(runner({
      artifactDirectory,
      execution: { id: "execution-1" },
      thread: { id: "7" },
      turn: { id: "41", rootLayerId: "10" },
      request: { text: "Explain." },
      rubric: { rubricVersion: "graph-presentation-rubric-v10" },
      reviewSequence: { index: 0, count: 1 },
    })).rejects.toThrow("remains readable but cannot start a new v6 judgment");
    expect(runJudge).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith({ close: true });
  });
});

function acceptedLayers({ includeGrandchild = false } = {}) {
  const layers = new Map([
    ["10", {
      layer: { id: 10, nodes: [2], edges: [], state: "accepted" },
      nodes: [{ id: 2, state: "accepted" }],
      edges: [],
      actions: [
        { id: 11, sourceNodeId: 2, sourceLayerId: 10, kind: "navigate", relation: "expand", targetLayerId: 20, state: "accepted" },
        { id: 12, sourceNodeId: 2, kind: "invoke", state: "accepted" },
      ],
    }],
    ["20", {
      layer: { id: 20, nodes: [3], edges: [], state: "accepted" },
      nodes: [{ id: 3, state: "accepted" }],
      edges: [],
      actions: includeGrandchild
        ? [{ id: 21, sourceNodeId: 3, sourceLayerId: 20, kind: "navigate", relation: "expand", targetLayerId: 30, state: "accepted" }]
        : [],
    }],
  ]);
  if (includeGrandchild) {
    layers.set("30", {
      layer: { id: 30, nodes: [4], edges: [], state: "accepted" },
      nodes: [{ id: 4, state: "accepted" }],
      edges: [],
      actions: [],
    });
  }
  return layers;
}

function fakeReviewSession(screenshotDirectory) {
  let currentLayer = "10";
  const screenshot = vi.fn(async (input) => {
    const screenshotId = `shot-${input.label}`;
    const child = input.label.startsWith("child");
    const comparison = input.label === "comparison";
    const detail = input.target.kind === "element";
    const shot = metadata({
      screenshotId,
      layerId: child ? "20" : "10",
      turnId: comparison ? "40" : "41",
      selectedNodeId: detail ? (child ? "3" : "2") : null,
      tileCount: 1,
      target: input.target,
      mode: input.mode,
      viaActionId: child ? "11" : null,
    });
    const directory = join(screenshotDirectory, screenshotId);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${screenshotId}-001.png`), screenshotId);
    await writeFile(join(directory, "metadata.json"), JSON.stringify(shot));
    return { ok: true, screenshot: shot };
  });
  return {
    screenshot,
    interact: vi.fn(async () => {
      currentLayer = "20";
      return { ok: true, state: { turnId: "41", layerId: currentLayer } };
    }),
    history: vi.fn(async () => {
      currentLayer = "10";
      return { ok: true, state: { turnId: "41", layerId: currentLayer } };
    }),
    artifactDirectoryFor: (screenshotId) => join(screenshotDirectory, screenshotId),
    trace: () => [{ type: "session-opened" }],
  };
}

function metadata({
  screenshotId,
  layerId,
  turnId = "41",
  selectedNodeId,
  tileCount,
  target = { kind: "viewport" },
  mode = "visible",
  viaActionId = null,
}) {
  return {
    schemaVersion: 1,
    screenshotId,
    label: screenshotId,
    executionId: "execution-1",
    threadId: "7",
    turnId,
    layerId,
    selectedNodeId,
    activatedActionId: viaActionId,
    navigationPath: layerId === "10"
      ? [{ layerId: "10", viaActionId: null }]
      : [{ layerId: "10", viaActionId: null }, { layerId, viaActionId }],
    viewport: { width: 1200, height: 800, deviceScaleFactor: 2 },
    captureTarget: target,
    mode,
    tileCount,
    tiles: Array.from({ length: tileCount }, (_, index) => ({
      index,
      width: 100,
      height: 100,
      contentDigest: digest,
    })),
    contentDigest: digest,
  };
}

function layerReview(layerId, screenshotId) {
  return {
    layerId,
    evidence: { viewport: [screenshotId] },
    ratings: {
      purpose_clarity: 4,
      cohesion: 4,
      visual_organization: 4,
      relationship_clarity: 4,
      coverage: 4,
    },
    summary: "Clear layer.",
    findings: [],
  };
}

function nodeReview({ layerId, nodeId, context, detail, actions }) {
  return {
    layerId,
    nodeId,
    evidence: { context: [context], detail: [detail] },
    ratings: {
      layer_fit: 4,
      title_detail_alignment: 4,
      substance: 4,
      detail_presentation: 4,
    },
    actions,
    structure: {
      rating: 4,
      expansion: { need: actions.some((action) => action.kind === "navigate") ? "helpful" : "none", result: actions.some((action) => action.kind === "navigate") ? "works" : "absent" },
      references: { need: "none", result: "absent" },
      invoke: { need: actions.some((action) => action.kind === "invoke") ? "helpful" : "none", result: actions.some((action) => action.kind === "invoke") ? "works" : "absent" },
      reason: "The node's recursive affordances were assessed.",
      evidence: [detail],
    },
    summary: "Useful node.",
    findings: [],
  };
}

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "relayer-simulated-user-electron-"));
  directories.push(directory);
  return directory;
}

async function commissionedInputController({ acknowledgement }) {
  const directory = await temporaryDirectory();
  const screenshotId = "shot-acknowledgement";
  const screenshotDirectory = join(directory, screenshotId);
  await mkdir(screenshotDirectory);
  await writeFile(join(screenshotDirectory, `${screenshotId}-001.png`), "input");
  const shot = {
    ...metadata({
      screenshotId,
      layerId: "10",
      selectedNodeId: "2",
      tileCount: 1,
      target: { kind: "element", elementRef: "input-action-13" },
      mode: "full",
    }),
    threadRevision: "thread:7:revision:1",
  };
  const session = {
    state: vi.fn(async () => ({
      threadRevision: shot.threadRevision,
      turnId: "41",
      layerId: "10",
      selectedNodeId: "2",
      activatedActionId: null,
      navigationPath: [{ layerId: "10", viaActionId: null }],
      controls: [{ elementRef: "send-interaction", kind: "input-operator-send", disabled: false }],
    })),
    setInputOperatorCommitted: acknowledgement,
    screenshot: vi.fn(async () => ({ ok: true, screenshot: shot })),
    interact: vi.fn(),
    history: vi.fn(),
    artifactDirectoryFor: () => screenshotDirectory,
  };
  const operator = {
    beginCapture: vi.fn(() => ({ captureId: "capture-acknowledgement", threadRevision: shot.threadRevision })),
    failCapture: vi.fn(),
    rateCaptures: vi.fn(),
    state: vi.fn(() => ({ captures: [{ captureId: "capture-acknowledgement", status: "capturing" }] })),
    commit: vi.fn(async () => 9),
    send: vi.fn(async () => ({ id: 99 })),
  };
  const occurrence = { presentingInteractionNodeId: 41, presentingLayerId: 10, actionId: 13 };
  const controller = createReviewSessionController(session, new Map(), {
    inputOperator: operator,
    inputBindings: new Map([["input-action-13", {
      occurrence,
      sourceNodeId: 2,
      action: { control: "text", prompt: "What constraint matters most?" },
    }]]),
    persistInputRatingReceipt: vi.fn(async () => "input-rating-receipts/acknowledgement.json"),
  });
  await controller.screenshot({
    target: { kind: "element", elementRef: "input-action-13" },
    mode: "full",
    label: "Input action before acknowledgement failure",
  });
  await controller.recordInputRatings({
    revision: 1,
    review: {
      layerId: "10",
      nodeId: "2",
      actions: [{
        actionId: "13",
        kind: "input",
        evidence: [screenshotId],
        inputActionJudgments: {},
      }],
    },
  });
  return {
    controller,
    operator,
    input: { elementRef: "input-action-13", value: { text: "Ship Friday" } },
  };
}
