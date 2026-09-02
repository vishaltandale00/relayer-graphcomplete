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
  it("keeps Send retry identity, settles operator leases, and classifies round-trip evidence", async () => {
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
      await expect(operator.send({}), `Send retry rejected for ${expectedError}`).rejects.toThrow(expectedError);
      expect(operator.state(), "retry identity preserved across malformed and invalid responses").toMatchObject({
        committedDraftRevision: 8,
        pendingSendInputId: "stable-input-id",
      });
    }
    await expect(operator.send({}), "Send finally succeeds with a valid interaction id").resolves.toEqual({ id: 99 });
    expect(sendBodies, "one body per attempt").toHaveLength(7);
    expect(sendBodies, "every attempt carries the same stable input identity").toEqual(sendBodies.map(() => (
      { text: "", inputId: "stable-input-id", inputDraftRevision: 8 }
    )));
    await expect(parseProductWriteResponse(new Response(null, { status: 204 })), "bodyless control revocation accepted")
      .resolves.toBeUndefined();

    const leaseOperator = { state: vi.fn() };
    const revoke = vi.fn()
      .mockRejectedValueOnce(new Error("temporary DELETE failure"))
      .mockResolvedValueOnce(undefined);
    const lease = createInputOperatorLease({ operator: leaseOperator, revoke });

    await expect(lease.release(), "transient revocation failure surfaces").rejects.toThrow("temporary DELETE failure");
    await expect(Promise.all([lease.release(), lease.release()]), "retry coalesces concurrent releases").resolves.toEqual([undefined, undefined]);
    await expect(lease.release(), "release stays idempotent after success").resolves.toBeUndefined();
    expect(lease.operator, "lease exposes its operator").toBe(leaseOperator);
    expect(revoke, "revocation attempted exactly twice").toHaveBeenCalledTimes(2);

    expect(operatorInteractionIsTerminal("cancelled"), "cancelled follow-ups are terminal").toBe(true);
    expect(operatorInteractionIsTerminal("running"), "running follow-ups are not terminal").toBe(false);

    expect(incompleteInputRoundTripEvidence([]), "no operations means not exercised").toMatchObject({ status: "not_exercised" });
    expect(incompleteInputRoundTripEvidence([{ operation: "input_commit", inputDraftRevision: 9 }]), "committed input without Send is indeterminate")
      .toMatchObject({
        status: "indeterminate",
        passed: false,
        detail: "The simulated user committed input, but the judge ended before activating Send.",
      });
    expect(incompleteInputRoundTripEvidence([
      { operation: "input_commit", inputDraftRevision: 9 },
      { operation: "send", response: { id: 99 } },
    ]), "complete round trip leaves no incomplete evidence").toBeNull();
  });

  it("persists per-layer rating receipts and resolves the exact local judge proof selection", async () => {
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

    expect(first.ref, "layer 10 receipt path").toBe("input-rating-receipts/layer-10-node-2-revision-1.json");
    expect(second.ref, "layer 20 receipt path").toBe("input-rating-receipts/layer-20-node-2-revision-1.json");
    await expect(readFile(join(artifactDirectory, first.ref), "utf8"), "layer 10 receipt bytes").resolves.toContain('"presentingLayerId": 10');
    await expect(readFile(join(artifactDirectory, second.ref), "utf8"), "layer 20 receipt bytes").resolves.toContain('"presentingLayerId": 20');

    expect(LOCAL_SIMULATED_USER_JUDGE_CONFIGURATION, "code-owned quality configuration with explicit reasoning").toEqual({
      model: "gpt-5.6-sol",
      modelReasoningEffort: "high",
    });

    expect(resolveLocalSimulatedUserAutorun({ environment: {}, arguments: [] }), "paid autorun off by default").toBeNull();
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
    }), "local H3 proof selected by environment").toEqual(selection);
    expect(resolveLocalSimulatedUserAutorun({
      environment: {},
      arguments: [LOCAL_SIMULATED_USER_AUTORUN_FLAG],
    }), "local H3 proof selected by flag").toEqual(selection);
    expect(resolveLocalSimulatedUserAutorun({
      environment: { [LOCAL_SIMULATED_USER_AUTORUN_ENV]: "1" },
      arguments: [],
      availableHarnessConfigurationNames: ["codex-layered-navigation-luna"],
    }), "available harness subset respected").toEqual({
      ...selection,
      harnessConfigurationNames: ["codex-layered-navigation-luna"],
    });
    expect(() => resolveLocalSimulatedUserAutorun({
      environment: { [LOCAL_SIMULATED_USER_AUTORUN_ENV]: "1" },
      arguments: [],
      availableHarnessConfigurationNames: [],
    }), "missing required harness named").toThrow("requires codex-layered-navigation-luna");
    expect(() => resolveLocalSimulatedUserAutorun({
      environment: { [LOCAL_SIMULATED_USER_AUTORUN_ENV]: "1" },
      arguments: [],
      packaged: true,
    }), "packaged app refuses local autorun").toThrow("only in a local development checkout");
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
    }), "personal presentation selected by environment").toEqual(personalSelection);
    expect(resolveLocalSimulatedUserAutorun({
      environment: {},
      arguments: [PERSONAL_PRESENTATION_AUTORUN_FLAG],
      availableHarnessConfigurationNames: personalSelection.harnessConfigurationNames,
    }), "personal presentation selected by flag").toEqual(personalSelection);
    expect(() => resolveLocalSimulatedUserAutorun({
      environment: { [PERSONAL_PRESENTATION_AUTORUN_ENV]: "1" },
      arguments: [],
      availableHarnessConfigurationNames: personalSelection.harnessConfigurationNames.slice(0, 1),
    }), "both personal presentation versions required").toThrow("requires both V0 and V1");
    const productSelection = {
      testCaseIds: ["empty-project.task-system.single-turn"],
      harnessConfigurationNames: ["codex-basic"],
      judgeConfigurationName: "simulated-user-sol-high",
    };
    expect(resolveLocalSimulatedUserAutorun({
      environment: { [PRODUCT_PRESENTATION_AUTORUN_ENV]: "1" },
      arguments: [],
      availableHarnessConfigurationNames: ["codex-basic"],
    }), "product presentation selected by environment").toEqual(productSelection);
    expect(resolveLocalSimulatedUserAutorun({
      environment: {},
      arguments: [PRODUCT_PRESENTATION_AUTORUN_FLAG],
    }), "product presentation selected by flag").toEqual(productSelection);
    expect(() => resolveLocalSimulatedUserAutorun({
      environment: { [PRODUCT_PRESENTATION_AUTORUN_ENV]: "1" },
      arguments: [],
      availableHarnessConfigurationNames: [],
    }), "product presentation requires codex-basic").toThrow("requires codex-basic");
    const inputRoundTripSelection = {
      testCaseIds: ["empty-project.node-input-roundtrip.single-turn"],
      harnessConfigurationNames: ["codex-basic"],
      judgeConfigurationName: "simulated-user-sol-high",
    };
    expect(resolveLocalSimulatedUserAutorun({
      environment: { [INPUT_ROUNDTRIP_AUTORUN_ENV]: "1" },
      arguments: [],
      availableHarnessConfigurationNames: ["codex-basic"],
    }), "input round trip selected by environment").toEqual(inputRoundTripSelection);
    expect(resolveLocalSimulatedUserAutorun({
      environment: {},
      arguments: [INPUT_ROUNDTRIP_AUTORUN_FLAG],
    }), "input round trip selected by flag").toEqual(inputRoundTripSelection);
    expect(() => resolveLocalSimulatedUserAutorun({
      environment: {
        [PERSONAL_PRESENTATION_AUTORUN_ENV]: "1",
        [PRODUCT_PRESENTATION_AUTORUN_ENV]: "1",
      },
      arguments: [],
    }), "competing autorun selections rejected").toThrow("Select only one");
  });

  it("plans authoritative review topologies and action-only grounding captures from accepted layers", async () => {
    const layers = acceptedLayers();
    const loadLayer = vi.fn(async (layerId) => layers.get(String(layerId)));
    const topology = await buildAcceptedReviewTopology({
      turnId: 41,
      presentingInteractionNodeId: 99,
      rootLayerId: 10,
      loadLayer,
    });

    expect(loadLayer.mock.calls.map(([layerId]) => layerId), "only authoritative accepted navigate destinations loaded").toEqual(["10", "20"]);
    expect(topology, "recursive inventory of accepted layers and actions").toEqual({
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
    const inputTopology = await buildAcceptedReviewTopology({
      turnId: 41,
      presentingInteractionNodeId: 99,
      rootLayerId: 10,
      loadLayer: async (layerId) => layers.get(String(layerId)),
    });
    expect(inputTopology.layers[0].actions.slice(2), "accepted text and select questions carried into immutable topology").toEqual([
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

    const deepTopology = await buildAcceptedReviewTopology({
      turnId: 41,
      rootLayerId: 10,
      loadLayer: async (layerId) => acceptedLayers({ includeGrandchild: true }).get(String(layerId)),
    });
    expect(gradeAcceptedReviewTopology(deepTopology, { requireGrandchild: true }), "complete closure graded with a real grandchild").toEqual([
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
    }), { requireGrandchild: true })[1], "architecture requires a real grandchild").toMatchObject({ passed: false });

    const outsideSourceLayers = acceptedLayers();
    outsideSourceLayers.get("10").actions[0].sourceNodeId = 999;
    await expect(buildAcceptedReviewTopology({
      turnId: 41,
      rootLayerId: 10,
      loadLayer: async (layerId) => outsideSourceLayers.get(String(layerId)),
    }), "action sourced outside its declared layer rejected").rejects.toThrow("source is outside its layer");

    expect(groundingRootNodeIds({
      completionOutput: { rootLayer: { nodes: [{ id: 7 }, { id: 8 }, { id: 9 }] } },
    }), "every visible root node grounded").toEqual(["7", "8", "9"]);

    const groundingTopology = await buildAcceptedReviewTopology({
      turnId: 41,
      rootLayerId: 10,
      loadLayer: async (layerId) => acceptedLayers({ includeGrandchild: true }).get(String(layerId)),
    });
    expect(groundingCaptureTargets(groundingTopology), "grounding planned for every accepted descendant layer").toEqual([
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

    const groundingLayers = acceptedLayers({ includeGrandchild: true });
    const groundingLoadLayer = vi.fn(async ({ layerId }) => groundingLayers.get(String(layerId)));
    const groundingTopologyFromTurn = await buildInputGroundingTopology({
      threadId: 7,
      interaction: {
        id: 41,
        graphNodeId: 2,
        completionOutput: { rootLayer: { layer: { id: 10 } } },
      },
      loadLayer: groundingLoadLayer,
    });
    expect(groundingTopologyFromTurn.turnId, "grounding keyed to the submitted-input follow-up turn").toBe("41");
    expect(groundingLoadLayer, "root layer loaded from the follow-up turn").toHaveBeenCalledWith({ threadId: 7, turnId: 41, layerId: "10" });
    expect(groundingLoadLayer, "child layer loaded from the follow-up turn").toHaveBeenCalledWith({ threadId: 7, turnId: 41, layerId: "20" });
    expect(groundingLoadLayer, "grandchild layer loaded from the follow-up turn").toHaveBeenCalledWith({ threadId: 7, turnId: 41, layerId: "30" });

    const rewindCalls = [];
    let selectedNodeId = null;
    const rewindSession = {
      state: vi.fn(async () => ({ selectedNodeId })),
      interact: vi.fn(async (input) => {
        rewindCalls.push(["interact", input.elementRef]);
        if (input.elementRef.startsWith("node-")) selectedNodeId = input.elementRef.slice(5);
        if (input.elementRef.startsWith("action-")) selectedNodeId = null;
      }),
      screenshot: vi.fn(async ({ label }) => { rewindCalls.push(["screenshot", label]); return { label }; }),
      history: vi.fn(async ({ delta }) => { rewindCalls.push(["history", delta]); selectedNodeId = "2"; }),
    };
    const rewindTargets = [
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

    await captureGroundingTargets(rewindSession, rewindTargets);

    expect(rewindSession.history.mock.calls, "history rewinds by action navigation only").toEqual([[{ delta: -1 }], [{ delta: -2 }]]);
    expect(rewindCalls.filter(([kind]) => kind === "history"), "rewind order recorded").toEqual([
      ["history", -1],
      ["history", -2],
    ]);
    expect(rewindSession.screenshot, "one capture per grounded layer").toHaveBeenCalledTimes(3);
    expect(rewindSession.interact.mock.calls.filter(([input]) => input.elementRef === "node-2"), "root node selected exactly once")
      .toHaveLength(1);
  });

  it("screens, rates, commissions, and acknowledges simulated input captures", async () => {
    const tilesDirectory = await temporaryDirectory();
    const tilesScreenshotId = "shot-1";
    const tilesScreenshotDirectory = join(tilesDirectory, tilesScreenshotId);
    await mkdir(tilesScreenshotDirectory);
    await writeFile(join(tilesScreenshotDirectory, `${tilesScreenshotId}-001.png`), "first");
    await writeFile(join(tilesScreenshotDirectory, `${tilesScreenshotId}-002.png`), "second");
    const tilesCapture = vi.fn(async () => ({
      ok: true,
      screenshot: metadata({ screenshotId: tilesScreenshotId, layerId: "layer-1", selectedNodeId: null, tileCount: 2 }),
    }));
    const tilesSession = {
      screenshot: tilesCapture,
      interact: vi.fn(),
      history: vi.fn(),
      artifactDirectoryFor: () => tilesScreenshotDirectory,
    };
    const tilesScreenshots = new Map();
    const tilesController = createReviewSessionController(tilesSession, tilesScreenshots);

    const tilesResult = await tilesController.screenshot({
      target: { kind: "viewport" },
      mode: "visible",
      label: "Layer",
    });

    expect(tilesCapture, "existing tiles returned without duplicate capture").toHaveBeenCalledTimes(1);
    expect(tilesResult.output.screenshot.screenshotId, "screenshot identity returned to MCP").toBe(tilesScreenshotId);
    expect(tilesResult.images, "ordered PNG tiles base64-encoded").toEqual([
      { data: Buffer.from("first").toString("base64"), mimeType: "image/png" },
      { data: Buffer.from("second").toString("base64"), mimeType: "image/png" },
    ]);
    expect(tilesScreenshots.get(tilesScreenshotId), "screenshot metadata tracked").toEqual(tilesResult.output.screenshot);

    const missingDirectory = await temporaryDirectory();
    const missingScreenshotId = "shot-missing-input";
    const missingShot = {
      ...metadata({
        screenshotId: missingScreenshotId,
        layerId: "10",
        selectedNodeId: "2",
        tileCount: 1,
        target: { kind: "element", elementRef: "input-action-41-10-13" },
        mode: "full",
      }),
      threadRevision: "thread:7:input-draft:0",
    };
    const missingSession = {
      state: vi.fn(async () => ({
        threadRevision: missingShot.threadRevision,
        turnId: "41",
        layerId: "10",
        selectedNodeId: "2",
        activatedActionId: null,
        navigationPath: [{ layerId: "10", viaActionId: null }],
        controls: [{ elementRef: "send-interaction", kind: "input-operator-send", disabled: false }],
      })),
      screenshot: vi.fn(async () => ({ ok: true, screenshot: missingShot })),
      interact: vi.fn(),
      history: vi.fn(),
      artifactDirectoryFor: () => join(missingDirectory, "missing"),
    };
    const missingOperator = {
      beginCapture: vi.fn(() => ({ captureId: "capture-missing", threadRevision: missingShot.threadRevision })),
      failCapture: vi.fn(),
    };
    const missingScreenshots = new Map();
    const missingController = createReviewSessionController(missingSession, missingScreenshots, {
      inputOperator: missingOperator,
      inputBindings: new Map([["input-action-41-10-13", {
        occurrence: { presentingInteractionNodeId: 41, presentingLayerId: 10, actionId: 13 },
        action: { control: "text", prompt: "When?" },
      }]]),
    });

    await expect(missingController.screenshot({
      target: { kind: "element", elementRef: "input-action-41-10-13" },
      mode: "full",
      label: "Missing artifact",
    }), "input capture fails when its screenshot artifact cannot be loaded").rejects.toThrow();
    expect(missingOperator.failCapture, "unloadable artifact fails the capture").toHaveBeenCalledWith("capture-missing");
    expect(missingScreenshots, "failed capture leaves no screenshot tracked").toEqual(new Map());

    const unsuccessfulOccurrence = { presentingInteractionNodeId: 41, presentingLayerId: 10, actionId: 13 };
    const unsuccessfulSession = {
      state: vi.fn(async () => ({ threadRevision: "thread:7:input-draft:0" })),
      screenshot: vi.fn(async () => ({ ok: false, error: "viewport unavailable" })),
      interact: vi.fn(),
      history: vi.fn(),
    };
    const unsuccessfulOperator = {
      beginCapture: vi.fn(() => ({
        captureId: "capture-unsuccessful",
        threadRevision: "thread:7:input-draft:0",
      })),
      failCapture: vi.fn(),
    };
    const unsuccessfulController = createReviewSessionController(unsuccessfulSession, new Map(), {
      inputOperator: unsuccessfulOperator,
      inputBindings: new Map([["input-action-41-10-13", {
        occurrence: unsuccessfulOccurrence,
        action: { control: "text", prompt: "When?" },
      }]]),
    });

    await expect(unsuccessfulController.screenshot({
      target: { kind: "element", elementRef: "input-action-41-10-13" },
      mode: "full",
      label: "Unsuccessful screenshot",
    }), "unsuccessful screenshot surfaces the session error").resolves.toEqual({
      output: { ok: false, error: "viewport unavailable" },
      images: [],
    });
    expect(unsuccessfulOperator.failCapture, "unsuccessful capture failed at the operator").toHaveBeenCalledWith("capture-unsuccessful");

    const gatedSession = {
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
    const gatedOperator = {
      commit: vi.fn(async () => 1),
      send: vi.fn(async () => ({ id: 99 })),
    };
    const gatedController = createReviewSessionController(gatedSession, new Map(), { inputOperator: gatedOperator });

    await expect(gatedController.interact({ elementRef: "send-interaction", activate: true }), "Send refused without the visible production control")
      .rejects.toThrow("visible operator Send control");
    expect(gatedOperator.send, "Send not invoked without the control").not.toHaveBeenCalled();

    gatedSession.state.mockResolvedValueOnce({
      ...(await gatedSession.state()),
      controls: [{ elementRef: "send-interaction", kind: "input-operator-send", disabled: false }],
    });
    await expect(gatedController.interact({ elementRef: "send-interaction", activate: true }), "Send refused until one commissioned input is committed")
      .rejects.toThrow("committed input");
    expect(gatedOperator.send, "Send not invoked before a committed input").not.toHaveBeenCalled();

    const ratedDirectory = await temporaryDirectory();
    const ratedScreenshotId = "shot-input";
    const ratedScreenshotDirectory = join(ratedDirectory, ratedScreenshotId);
    await mkdir(ratedScreenshotDirectory);
    await writeFile(join(ratedScreenshotDirectory, `${ratedScreenshotId}-001.png`), "input");
    const ratedShot = {
      ...metadata({ screenshotId: ratedScreenshotId, layerId: "10", selectedNodeId: "2", tileCount: 1, target: { kind: "element", elementRef: "input-action-13" }, mode: "full" }),
      threadRevision: "thread:7:revision:1",
    };
    const ratedSession = {
      state: vi.fn(async () => ({
        threadRevision: ratedShot.threadRevision,
        turnId: "41",
        layerId: "10",
        selectedNodeId: "2",
        activatedActionId: null,
        navigationPath: [{ layerId: "10", viaActionId: null }],
        controls: [{ elementRef: "send-interaction", kind: "input-operator-send", disabled: false }],
      })),
      screenshot: vi.fn(async () => ({ ok: true, screenshot: ratedShot })),
      interact: vi.fn(),
      history: vi.fn(),
      artifactDirectoryFor: () => ratedScreenshotDirectory,
    };
    const ratedOperator = {
      beginCapture: vi.fn(() => ({ captureId: "capture-1", threadRevision: ratedShot.threadRevision })),
      failCapture: vi.fn(),
      rateCaptures: vi.fn(),
      commit: vi.fn(async () => 9),
      send: vi.fn(async () => ({ interaction: { id: 99 } })),
    };
    const ratedBinding = {
      occurrence: { presentingInteractionNodeId: 41, presentingLayerId: 10, actionId: 13 },
      action: { control: "text", prompt: "What constraint matters most?" },
    };
    const ratedPersist = vi.fn(async () => "input-rating-receipts/node-2-revision-3.json");
    const ratedController = createReviewSessionController(ratedSession, new Map(), {
      inputOperator: ratedOperator,
      inputBindings: new Map([["input-action-13", ratedBinding]]),
      persistInputRatingReceipt: ratedPersist,
    });

    await ratedController.screenshot({
      target: { kind: "element", elementRef: "input-action-13" },
      mode: "full",
      label: "Input action before answer",
    });
    await expect(ratedController.interact({ elementRef: "input-action-13", value: { text: "Ship Friday" } }), "input must be rated before commissioning")
      .rejects.toThrow("must be rated before");
    await ratedController.recordInputRatings({
      revision: 3,
      review: {
        layerId: "10",
        nodeId: "2",
        actions: [{
          actionId: "13",
          kind: "input",
          evidence: [ratedScreenshotId],
          inputActionJudgments: {
            prompt_answerability: { evidence: [ratedScreenshotId] },
            option_set_quality: { evidence: [ratedScreenshotId] },
            control_fit: { evidence: [ratedScreenshotId] },
          },
        }],
      },
    });
    expect(ratedOperator.rateCaptures, "versioned capture commissioned after rating").toHaveBeenCalledWith([{
      captureId: "capture-1",
      ratingId: "input-rating-receipts/node-2-revision-3.json",
      threadRevision: ratedShot.threadRevision,
    }]);
    expect(ratedPersist.mock.invocationCallOrder[0], "durable receipt persisted before operator commissioning")
      .toBeLessThan(ratedOperator.rateCaptures.mock.invocationCallOrder[0]);
    await expect(ratedController.interact({ elementRef: "input-action-13", value: { text: "Ship Friday" } }), "rated input commits through the operator")
      .resolves.toMatchObject({ operator: { operation: "input_commit", inputDraftRevision: 9 } });
    await expect(ratedController.interact({ elementRef: "send-interaction", activate: true }), "Send enabled after the commissioned commit")
      .resolves.toMatchObject({ operator: { operation: "send" } });
    expect(ratedOperator.commit, "commit carries the captured value").toHaveBeenCalledWith({ captureId: "capture-1", value: { text: "Ship Friday" } });
    expect(ratedSession.interact, "operator writes never touch the renderer session").not.toHaveBeenCalled();

    const committedOccurrence = { presentingInteractionNodeId: 41, presentingLayerId: 10, actionId: 13 };
    const committedSession = {
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
    const committedOperator = {
      commit: vi.fn(async () => 1),
      send: vi.fn(async () => ({ id: 99 })),
    };
    const committedController = createReviewSessionController(committedSession, new Map(), {
      inputOperator: committedOperator,
      inputBindings: new Map([["input-action-41-10-13", {
        occurrence: committedOccurrence,
        action: { control: "text", prompt: "When?" },
      }]]),
      persistInputRatingReceipt: vi.fn(async () => "receipt-1.json"),
    });
    const committedDirectory = await temporaryDirectory();
    const committedScreenshotDirectory = join(committedDirectory, "shot-input");
    await mkdir(committedScreenshotDirectory);
    await writeFile(join(committedScreenshotDirectory, "shot-input-001.png"), "input");
    committedSession.screenshot.mockResolvedValue({
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
    committedSession.artifactDirectoryFor = () => committedScreenshotDirectory;
    committedOperator.beginCapture = vi.fn(() => ({ captureId: "capture-1", threadRevision: "thread:7:input-draft:0" }));
    committedOperator.failCapture = vi.fn();
    committedOperator.rateCaptures = vi.fn();
    committedOperator.state = vi.fn(() => ({ captures: [{ captureId: "capture-1", status: "capturing" }] }));
    await committedController.screenshot({ target: { kind: "element", elementRef: "input-action-41-10-13" }, mode: "full" });
    await committedController.recordInputRatings({
      revision: 1,
      review: { layerId: "10", nodeId: "2", actions: [{ actionId: "13", kind: "input", evidence: ["shot-input"], inputActionJudgments: {} }] },
    });
    await committedController.interact({ elementRef: "input-action-41-10-13", value: { text: "Friday" } });
    expect(committedSession.setInputOperatorCommitted, "production Send affordance enabled after commission").toHaveBeenCalledWith(true);
    await expect(committedController.interact({ elementRef: "send-interaction", activate: true }), "production Send succeeds after commission")
      .resolves.toMatchObject({ operator: { operation: "send" } });

    const commitAcknowledgement = vi.fn()
      .mockRejectedValueOnce(new Error("renderer commit acknowledgement timed out"))
      .mockResolvedValueOnce(undefined);
    const commitRetry = await commissionedInputController({ acknowledgement: commitAcknowledgement });

    await expect(commitRetry.controller.interact(commitRetry.input), "commit recorded before the renderer acknowledgement fails")
      .rejects.toThrow("renderer commit acknowledgement timed out");
    expect(commitRetry.operator.commit, "commit not repeated for a failed acknowledgement").toHaveBeenCalledTimes(1);
    expect(commitRetry.controller.operatorTrace(), "failed acknowledgement traced").toMatchObject([{
      operation: "input_commit",
      inputDraftRevision: 9,
      rendererAcknowledgement: {
        status: "failed",
        attempts: 1,
        error: "renderer commit acknowledgement timed out",
      },
    }]);

    await expect(commitRetry.controller.interact({
      value: { text: "Ship Saturday" },
      elementRef: commitRetry.input.elementRef,
    }), "new input blocked while acknowledgement is pending").rejects.toThrow("acknowledgement is pending");
    expect(commitRetry.operator.commit, "pending acknowledgement does not re-commit").toHaveBeenCalledTimes(1);
    expect(commitAcknowledgement, "no acknowledgement while one is pending").toHaveBeenCalledTimes(1);
    await expect(commitRetry.controller.interact({ value: { text: commitRetry.input.value.text }, elementRef: commitRetry.input.elementRef }), "retry acknowledges the recorded commit")
      .resolves.toMatchObject({ operator: { operation: "input_commit", inputDraftRevision: 9 } });
    expect(commitRetry.operator.commit, "retry never re-commits").toHaveBeenCalledTimes(1);
    expect(commitAcknowledgement, "acknowledgement retried exactly once").toHaveBeenCalledTimes(2);
    expect(commitRetry.controller.operatorTrace(), "completed acknowledgement traced").toMatchObject([{
      operation: "input_commit",
      rendererAcknowledgement: { status: "completed", attempts: 2 },
    }]);

    const sendAcknowledgement = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("renderer Send acknowledgement timed out"))
      .mockResolvedValueOnce(undefined);
    const sendRetry = await commissionedInputController({ acknowledgement: sendAcknowledgement });
    await sendRetry.controller.interact(sendRetry.input);
    const send = { elementRef: "send-interaction", activate: true };

    await expect(sendRetry.controller.interact(send), "Send recorded before the renderer acknowledgement fails")
      .rejects.toThrow("renderer Send acknowledgement timed out");
    expect(sendRetry.operator.send, "Send not repeated for a failed acknowledgement").toHaveBeenCalledTimes(1);
    expect(sendRetry.controller.operatorTrace(), "failed Send acknowledgement traced").toMatchObject([
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

    await expect(sendRetry.controller.interact({
      activate: true,
      elementRef: "another-interaction",
    }), "other interactions blocked while Send acknowledgement is pending").rejects.toThrow("acknowledgement is pending");
    expect(sendRetry.operator.send, "pending acknowledgement does not re-Send").toHaveBeenCalledTimes(1);
    expect(sendAcknowledgement, "commit acknowledgement plus one pending Send acknowledgement").toHaveBeenCalledTimes(2);
    await expect(sendRetry.controller.interact({ activate: true, elementRef: "send-interaction" }), "retry acknowledges the recorded Send")
      .resolves.toMatchObject({ operator: { operation: "send", response: { id: 99 } } });
    expect(sendRetry.operator.send, "retry never re-Sends").toHaveBeenCalledTimes(1);
    expect(sendAcknowledgement, "Send acknowledgement retried exactly once").toHaveBeenCalledTimes(3);
    expect(sendRetry.controller.operatorTrace().at(-1), "completed Send acknowledgement traced").toMatchObject({
      operation: "send",
      rendererAcknowledgement: { status: "completed", attempts: 2 },
    });

    const atomicDirectory = await temporaryDirectory();
    const screenshotsByRef = new Map();
    for (const actionId of ["13", "14"]) {
      const screenshotId = `shot-input-${actionId}`;
      const screenshotDirectory = join(atomicDirectory, screenshotId);
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
    const atomicSession = {
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
      artifactDirectoryFor: (screenshotId) => join(atomicDirectory, screenshotId),
    };
    let captureSequence = 0;
    const atomicOperator = {
      beginCapture: vi.fn(({ threadRevision }) => ({ captureId: `capture-${++captureSequence}`, threadRevision })),
      failCapture: vi.fn(),
      rateCaptures: vi.fn(),
      commit: vi.fn(),
      send: vi.fn(),
    };
    const atomicController = createReviewSessionController(atomicSession, new Map(), {
      inputOperator: atomicOperator,
      inputBindings: new Map(["13", "14"].map((actionId) => [`input-action-${actionId}`, {
        occurrence: { presentingInteractionNodeId: 41, presentingLayerId: 10, actionId: Number(actionId) },
        action: { control: "text", prompt: `Question ${actionId}` },
      }])),
      persistInputRatingReceipt: vi.fn(async () => "input-rating-receipts/node-2-revision-1.json"),
    });

    for (const actionId of ["13", "14"]) {
      await atomicController.screenshot({
        target: { kind: "element", elementRef: `input-action-${actionId}` },
        mode: "full",
        label: `Input ${actionId}`,
      });
    }
    await atomicController.recordInputRatings({
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

    expect(atomicOperator.rateCaptures, "both input actions commissioned atomically").toHaveBeenCalledWith([
      { captureId: "capture-1", ratingId: "input-rating-receipts/node-2-revision-1.json", threadRevision: "thread:7:input-draft:0" },
      { captureId: "capture-2", ratingId: "input-rating-receipts/node-2-revision-1.json", threadRevision: "thread:7:input-draft:0" },
    ]);

    const expiredDirectory = await temporaryDirectory();
    const expiredScreenshotId = "shot-expired";
    const expiredScreenshotDirectory = join(expiredDirectory, expiredScreenshotId);
    await mkdir(expiredScreenshotDirectory);
    await writeFile(join(expiredScreenshotDirectory, `${expiredScreenshotId}-001.png`), "input");
    const expiredShot = {
      ...metadata({
        screenshotId: expiredScreenshotId,
        layerId: "10",
        selectedNodeId: "2",
        tileCount: 1,
        target: { kind: "element", elementRef: "input-action-41-10-13" },
        mode: "full",
      }),
      threadRevision: "thread:7:input-draft:0",
    };
    const expiredSession = {
      state: vi.fn(async () => ({
        threadRevision: expiredShot.threadRevision,
        turnId: "41",
        layerId: "10",
        selectedNodeId: "2",
        activatedActionId: null,
        navigationPath: [{ layerId: "10", viaActionId: null }],
      })),
      screenshot: vi.fn(async () => ({ ok: true, screenshot: expiredShot })),
      interact: vi.fn(),
      history: vi.fn(),
      artifactDirectoryFor: () => expiredScreenshotDirectory,
    };
    const discard = vi.fn(async () => {});
    const expiredOperator = {
      beginCapture: vi.fn(() => ({ captureId: "capture-expired", threadRevision: expiredShot.threadRevision })),
      failCapture: vi.fn(),
      rateCaptures: vi.fn(() => { throw new Error("capture timed out"); }),
    };
    const expiredController = createReviewSessionController(expiredSession, new Map(), {
      inputOperator: expiredOperator,
      inputBindings: new Map([["input-action-41-10-13", {
        occurrence: { presentingInteractionNodeId: 41, presentingLayerId: 10, actionId: 13 },
        action: { control: "text", prompt: "When?" },
      }]]),
      persistInputRatingReceipt: vi.fn(async () => ({
        ref: "input-rating-receipts/node-2-revision-1.json",
        discard,
      })),
    });
    await expiredController.screenshot({
      target: { kind: "element", elementRef: "input-action-41-10-13" },
      mode: "full",
      label: "Expired capture",
    });

    await expect(expiredController.recordInputRatings({
      revision: 1,
      review: {
        layerId: "10",
        nodeId: "2",
        actions: [{ actionId: "13", kind: "input", evidence: [expiredScreenshotId], inputActionJudgments: {} }],
      },
    }), "failed commission surfaces the operator error").rejects.toThrow("capture timed out");
    expect(discard, "durable rating receipt discarded when commission fails").toHaveBeenCalledOnce();
    expect(expiredController.inputRatingReceiptRefs(), "no receipt retained after discard").toEqual([]);

    const revisionDirectory = await temporaryDirectory();
    let sequence = 0;
    const revisionSession = {
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
        const screenshotDirectory = join(revisionDirectory, screenshotId);
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
      artifactDirectoryFor: (screenshotId) => join(revisionDirectory, screenshotId),
    };
    const revisionCaptures = new Map();
    const revisionOperator = {
      beginCapture: vi.fn(({ threadRevision }) => {
        const capture = { captureId: `capture-${sequence + 1}`, threadRevision };
        revisionCaptures.set(capture.captureId, "capturing");
        return capture;
      }),
      failCapture: vi.fn(),
      rateCaptures: vi.fn((ratings) => {
        for (const { captureId } of ratings) revisionCaptures.set(captureId, "commissioned");
      }),
      state: vi.fn(() => ({
        captures: [...revisionCaptures].map(([captureId, status]) => ({ captureId, status })),
      })),
    };
    const revisionController = createReviewSessionController(revisionSession, new Map(), {
      inputOperator: revisionOperator,
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

    await revisionController.screenshot({ target: { kind: "element", elementRef: "input-action-41-10-13" }, mode: "full", label: "First" });
    await revisionController.recordInputRatings({ revision: 1, review: review(["shot-revision-1"]) });
    await revisionController.screenshot({ target: { kind: "element", elementRef: "input-action-41-10-13" }, mode: "full", label: "Second" });
    await revisionController.recordInputRatings({ revision: 2, review: review(["shot-revision-2", "shot-revision-1"]) });

    expect(revisionOperator.rateCaptures, "revised review commissions the latest occurrence-matched capture").toHaveBeenLastCalledWith([{
      captureId: "capture-2",
      ratingId: "receipt-2.json",
      threadRevision: "thread:7:input-draft:1",
    }]);

    const crossDirectory = await temporaryDirectory();
    const crossScreenshotDirectory = join(crossDirectory, "shot-input-14");
    await mkdir(crossScreenshotDirectory);
    await writeFile(join(crossScreenshotDirectory, "shot-input-14-001.png"), "input-14");
    const crossShot = {
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
    const crossSession = {
      state: vi.fn(async () => ({
        threadRevision: crossShot.threadRevision,
        turnId: "41",
        layerId: "10",
        selectedNodeId: "2",
        activatedActionId: null,
        navigationPath: [{ layerId: "10", viaActionId: null }],
      })),
      screenshot: vi.fn(async () => ({ ok: true, screenshot: crossShot })),
      interact: vi.fn(),
      history: vi.fn(),
      artifactDirectoryFor: () => crossScreenshotDirectory,
    };
    const crossOperator = {
      beginCapture: vi.fn(() => ({ captureId: "capture-14", threadRevision: crossShot.threadRevision })),
      failCapture: vi.fn(),
      rateCaptures: vi.fn(),
      commit: vi.fn(),
      send: vi.fn(),
    };
    const crossController = createReviewSessionController(crossSession, new Map(), {
      inputOperator: crossOperator,
      inputBindings: new Map([["input-action-14", {
        occurrence: { presentingInteractionNodeId: 41, presentingLayerId: 10, actionId: 14 },
        action: { control: "text", prompt: "Question 14" },
      }]]),
      persistInputRatingReceipt: vi.fn(async () => "unreachable.json"),
    });
    await crossController.screenshot({
      target: { kind: "element", elementRef: "input-action-14" },
      mode: "full",
      label: "Input 14",
    });

    await expect(crossController.recordInputRatings({
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
    }), "cross-cited evidence between inputs rejected").rejects.toThrow("occurrence-matched");
    expect(crossOperator.rateCaptures, "no commission from cross-cited evidence").not.toHaveBeenCalled();
  }, 60_000);

  it("opens the exact turn, judges with the configured authority, and settles every review window", async () => {
    const wrongTurnDirectory = await temporaryDirectory();
    const wrongTurnRelease = vi.fn(async () => {});
    const wrongTurnJudge = vi.fn();
    const wrongTurnRunner = createLocalSimulatedUserJudgeRunner({
      loadLayer: async ({ layerId }) => acceptedLayers().get(String(layerId)),
      openReviewSession: async () => ({
        session: fakeReviewSession(join(wrongTurnDirectory, "screenshots")),
        state: { executionId: "execution-1", threadId: "7", turnId: "wrong", layerId: "10" },
        release: wrongTurnRelease,
      }),
      resolveCodexRuntime: async () => codexRuntime,
      runJudge: wrongTurnJudge,
    });

    await expect(wrongTurnRunner({
      artifactDirectory: wrongTurnDirectory,
      execution: { id: "execution-1" },
      thread: { id: "7" },
      turn: { id: "41", rootLayerId: "10" },
      request: { text: "Explain." },
      reviewSequence: { index: 0, count: 1 },
    }), "wrong-turn window rejected before invoking the judge").rejects.toThrow("exact accepted turn and root layer");
    expect(wrongTurnJudge, "judge never invoked for the wrong turn").not.toHaveBeenCalled();
    expect(wrongTurnRelease, "wrong-turn session released closed").toHaveBeenCalledWith({ close: true });

    const historicalDirectory = await temporaryDirectory();
    const historicalRelease = vi.fn(async () => {});
    const historicalJudge = vi.fn();
    const historicalRunner = createLocalSimulatedUserJudgeRunner({
      loadLayer: async ({ layerId }) => acceptedLayers().get(String(layerId)),
      openReviewSession: async () => ({
        session: fakeReviewSession(join(historicalDirectory, "screenshots")),
        state: { executionId: "execution-1", threadId: "7", turnId: "41", layerId: "10" },
        release: historicalRelease,
      }),
      resolveCodexRuntime: async () => codexRuntime,
      runJudge: historicalJudge,
    });

    await expect(historicalRunner({
      artifactDirectory: historicalDirectory,
      execution: { id: "execution-1" },
      thread: { id: "7" },
      turn: { id: "41", rootLayerId: "10" },
      request: { text: "Explain." },
      rubric: { rubricVersion: "graph-presentation-rubric-v10" },
      reviewSequence: { index: 0, count: 1 },
    }), "historical rubric cannot be relabelled as the active v6 contract").rejects.toThrow("remains readable but cannot start a new v6 judgment");
    expect(historicalJudge, "judge never invoked for a historical rubric").not.toHaveBeenCalled();
    expect(historicalRelease, "historical rubric session released closed").toHaveBeenCalledWith({ close: true });

    const judgeOnlyDirectory = await temporaryDirectory();
    const judgeOnlyCreateInputOperator = vi.fn();
    const judgeOnlyRunner = createLocalSimulatedUserJudgeRunner({
      loadLayer: async ({ layerId }) => acceptedLayers().get(String(layerId)),
      openReviewSession: async () => ({
        session: fakeReviewSession(join(judgeOnlyDirectory, "screenshots")),
        state: { executionId: "execution-1", threadId: "7", turnId: "41", layerId: "10" },
        release: vi.fn(async () => {}),
      }),
      resolveCodexRuntime: async () => codexRuntime,
      createInputOperator: judgeOnlyCreateInputOperator,
      runJudge: async () => { throw new Error("fixture stops before inference"); },
    });

    await judgeOnlyRunner({
      artifactDirectory: judgeOnlyDirectory,
      execution: { id: "execution-1" },
      thread: { id: "7" },
      turn: { id: "41", rootLayerId: "10" },
      request: { text: "Review only." },
      allowInputOperator: false,
      reviewSequence: { index: 0, count: 1 },
    });

    expect(judgeOnlyCreateInputOperator, "judge-only rerun never mints input write authority").not.toHaveBeenCalled();

    const operatorDirectory = await temporaryDirectory();
    const operatorOpenReviewSession = vi.fn(async () => ({
      session: fakeReviewSession(join(operatorDirectory, "screenshots")),
      state: { executionId: "execution-1", threadId: "7", turnId: "41", layerId: "10" },
      release: vi.fn(async () => {}),
    }));
    const operatorLeaseRelease = vi.fn()
      .mockRejectedValueOnce(new Error("transient DELETE failure"))
      .mockResolvedValueOnce(undefined);
    const operatorCreateInputOperator = vi.fn(async () => ({ operator: {}, release: operatorLeaseRelease }));
    const operatorJudge = vi.fn(async () => { throw new Error("fixture stops before inference"); });
    const operatorRunner = createLocalSimulatedUserJudgeRunner({
      loadLayer: async ({ layerId }) => acceptedLayers().get(String(layerId)),
      openReviewSession: operatorOpenReviewSession,
      resolveCodexRuntime: async () => codexRuntime,
      createInputOperator: operatorCreateInputOperator,
      runJudge: operatorJudge,
    });

    await operatorRunner({
      artifactDirectory: operatorDirectory,
      execution: { id: "execution-1" },
      thread: { id: "7" },
      turn: { id: "41", rootLayerId: "10" },
      request: { text: "Review with input authority." },
      allowInputOperator: true,
      reviewSequence: { index: 0, count: 1 },
    });

    expect(operatorCreateInputOperator.mock.invocationCallOrder[0], "operator minted before the session opens")
      .toBeLessThan(operatorOpenReviewSession.mock.invocationCallOrder[0]);
    expect(operatorOpenReviewSession, "session opened with the operator capability").toHaveBeenCalledWith(expect.objectContaining({ inputOperatorAvailable: true }));
    expect(operatorJudge, "judge runs with the operator capability").toHaveBeenCalledWith(expect.objectContaining({ inputOperatorAvailable: true }));
    expect(operatorLeaseRelease, "transient lease cleanup retried").toHaveBeenCalledTimes(2);

    const rubricDirectory = await temporaryDirectory();
    const rubricEvidence = {
      schemaVersion: 1,
      source: "bounded_host_packet",
      summary: "One verifier fact.",
      facts: ["PASS workspace:focused-tests"],
    };
    const rubricJudge = vi.fn(async ({ reviewStore, artifactEvidence }) => {
      expect(reviewStore.snapshot(), "input-aware recursive review store selected for rubric v11").toMatchObject({
        schemaVersion: 6,
        contractId: "recursive-presentation-judge-v6",
      });
      expect(artifactEvidence, "artifact evidence forwarded to the judge").toEqual(rubricEvidence);
      throw new Error("fixture stops before paid inference");
    });
    const rubricRunner = createLocalSimulatedUserJudgeRunner({
      loadLayer: async ({ layerId }) => acceptedLayers().get(String(layerId)),
      openReviewSession: async () => ({
        session: fakeReviewSession(join(rubricDirectory, "screenshots")),
        state: { executionId: "execution-1", threadId: "7", turnId: "41", layerId: "10" },
        release: vi.fn(async () => {}),
      }),
      resolveCodexRuntime: async () => codexRuntime,
      runJudge: rubricJudge,
    });

    const rubricResult = await rubricRunner({
      artifactDirectory: rubricDirectory,
      execution: { id: "execution-1" },
      thread: { id: "7" },
      turn: { id: "41", rootLayerId: "10" },
      request: { text: "Explain." },
      rubric: { rubricVersion: "graph-presentation-rubric-v11" },
      artifactEvidence: rubricEvidence,
      reviewSequence: { index: 0, count: 1 },
    });

    expect(rubricResult, "judge failure yields a partial v6 review").toMatchObject({ status: "partial", review: { schemaVersion: 6 }, error: "fixture stops before paid inference" });

    const fullDirectory = await temporaryDirectory();
    const fullScreenshotDirectory = join(fullDirectory, "screenshots");
    const fullLayers = acceptedLayers();
    const fullLoadLayer = vi.fn(async ({ layerId }) => fullLayers.get(String(layerId)));
    const fullRelease = vi.fn(async () => {});
    const fullSession = fakeReviewSession(fullScreenshotDirectory);
    const fullOpenReviewSession = vi.fn(async (request) => ({
      session: fullSession,
      state: {
        executionId: request.executionId,
        threadId: request.threadId,
        turnId: request.turnId,
        layerId: request.rootLayerId,
      },
      release: fullRelease,
    }));
    const fullRunJudge = vi.fn(async ({ controller, reviewStore }) => {
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
    const fullResolveCodexRuntime = vi.fn(async () => codexRuntime);
    const fullCaptureInputRoundTrip = vi.fn(async () => {
      throw new Error("candidate trace unavailable");
    });
    const fullRunner = createLocalSimulatedUserJudgeRunner({
      loadLayer: fullLoadLayer,
      openReviewSession: fullOpenReviewSession,
      resolveCodexRuntime: fullResolveCodexRuntime,
      runJudge: fullRunJudge,
      captureInputRoundTrip: fullCaptureInputRoundTrip,
    });

    const fullResult = await fullRunner({
      artifactDirectory: fullDirectory,
      execution: { id: "execution-1" },
      artifact: {
        kind: "git_workspace",
        workingDirectory: fullDirectory,
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

    expect(fullOpenReviewSession, "review session opened on the exact turn and root layer").toHaveBeenCalledWith(expect.objectContaining({
      executionId: "execution-1",
      threadId: "7",
      turnId: "41",
      rootLayerId: "10",
      artifactDirectory: fullScreenshotDirectory,
      inputOperatorAvailable: false,
    }));
    expect(fullRunJudge, "judge invoked exactly once").toHaveBeenCalledTimes(1);
    expect(fullRunJudge, "judge receives the managed codex runtime").toHaveBeenCalledWith(expect.objectContaining({
      workingDirectory: fullDirectory,
      additionalDirectories: [],
      artifactEvidence: undefined,
      codexPathOverride: "/managed/codex",
      environment: { PATH: "/managed/codex-path:/usr/bin" },
      inputOperatorAvailable: false,
    }));
    expect(fullResolveCodexRuntime, "codex runtime resolved once").toHaveBeenCalledOnce();
    expect(fullSession.screenshot, "six-tool review captured five screenshots").toHaveBeenCalledTimes(5);
    expect(fullSession.interact, "one navigation interaction").toHaveBeenCalledTimes(1);
    expect(fullSession.history, "one history comparison").toHaveBeenCalledTimes(1);
    expect(fullRelease, "session released closed after the review").toHaveBeenCalledWith({ close: true });
    expect(fullResult, "authoritative refs persisted for the complete review").toMatchObject({
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
    expect(fullCaptureInputRoundTrip, "follow-up round trip capture attempted").toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(join(fullDirectory, "judge-configuration.json"), "utf8")), "judge configuration artifact").toEqual({
      model: "gpt-5.6-sol",
      modelReasoningEffort: "high",
    });
    expect(JSON.parse(await readFile(join(fullDirectory, "interaction-trace.json"), "utf8")), "interaction trace artifact").toMatchObject({
      session: [{ type: "session-opened" }],
      tools: [{ tool: "screenshot" }],
      codex: [{ type: "mcp_tool_call", tool: "screenshot" }],
    });

    fullCaptureInputRoundTrip.mockClear();
    const rejudgeDirectory = await temporaryDirectory();
    const rejudge = await fullRunner({
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
    expect(fullCaptureInputRoundTrip, "rejudge without write authority skips the round trip capture").not.toHaveBeenCalled();
    expect(rejudge, "rejudge carries no round trip ref").not.toHaveProperty("inputRoundTripRef");
    expect(rejudge, "rejudge carries no round trip summary").not.toHaveProperty("inputRoundTrip");

    const retainedDirectory = await temporaryDirectory();
    const retainedLayers = acceptedLayers();
    retainedLayers.get("10").actions.push({
      id: 13,
      sourceNodeId: 2,
      kind: "input",
      control: "text",
      prompt: "What constraint matters most?",
      state: "accepted",
    });
    const retainedSession = fakeReviewSession(join(retainedDirectory, "screenshots"));
    const retainedCaptureScreenshot = retainedSession.screenshot;
    retainedSession.state = vi.fn(async () => ({
      threadRevision: "thread:7:revision:1",
      turnId: "41",
      layerId: "10",
      selectedNodeId: "2",
      activatedActionId: null,
      navigationPath: [{ layerId: "10", viaActionId: null }],
      controls: [{ elementRef: "send-interaction", kind: "input-operator-send", disabled: false }],
    }));
    retainedSession.setInputOperatorCommitted = vi.fn(async () => {});
    retainedSession.screenshot = vi.fn(async (input) => {
      const output = await retainedCaptureScreenshot(input);
      output.screenshot.threadRevision = "thread:7:revision:1";
      return output;
    });
    const retainedOperator = {
      beginCapture: vi.fn(() => ({ captureId: "capture-13", threadRevision: "thread:7:revision:1" })),
      failCapture: vi.fn(),
      rateCaptures: vi.fn(),
      state: vi.fn(() => ({ captures: [{ captureId: "capture-13", status: "capturing" }] })),
      commit: vi.fn(async () => 9),
      send: vi.fn(async () => ({ id: 99 })),
    };
    const retainedRunJudge = vi.fn(async ({ controller }) => {
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
    const retainedCaptureInputRoundTrip = vi.fn(async () => {
      throw new Error("follow-up capture unavailable");
    });
    const retainedRunner = createLocalSimulatedUserJudgeRunner({
      loadLayer: async ({ layerId }) => retainedLayers.get(String(layerId)),
      openReviewSession: async () => ({
        session: retainedSession,
        state: { executionId: "execution-1", threadId: "7", turnId: "41", layerId: "10" },
        release: vi.fn(async () => {}),
      }),
      resolveCodexRuntime: async () => codexRuntime,
      createInputOperator: async () => retainedOperator,
      runJudge: retainedRunJudge,
      captureInputRoundTrip: retainedCaptureInputRoundTrip,
    });

    const retainedResult = await retainedRunner({
      artifactDirectory: retainedDirectory,
      execution: { id: "execution-1" },
      thread: { id: "7" },
      turn: { id: "41", graphNodeId: "41", rootLayerId: "10" },
      request: { text: "Review and answer the input." },
      allowInputOperator: true,
      reviewSequence: { index: 0, count: 1 },
    });

    expect(retainedResult, "committed input evidence retained when the judge fails after product writes").toMatchObject({
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
    expect(retainedCaptureInputRoundTrip, "round trip capture receives the operator trace").toHaveBeenCalledWith(expect.objectContaining({
      operatorTrace: [
        expect.objectContaining({ operation: "input_commit", inputDraftRevision: 9 }),
        expect.objectContaining({ operation: "send", response: { id: 99 } }),
      ],
    }));
    expect(JSON.parse(await readFile(join(retainedDirectory, "input-roundtrip.json"), "utf8")), "input round trip evidence persisted")
      .toMatchObject(retainedResult.inputRoundTrip);
  }, 60_000);
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
