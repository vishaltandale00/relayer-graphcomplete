import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_SIMULATED_USER_RUBRIC } from "@relayer/eval-runner";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LOCAL_SIMULATED_USER_JUDGE_CONFIGURATION,
  LOCAL_SIMULATED_USER_AUTORUN_ENV,
  LOCAL_SIMULATED_USER_AUTORUN_FLAG,
  buildAcceptedReviewTopology,
  createLocalSimulatedUserJudgeRunner,
  createReviewSessionController,
  gradeAcceptedReviewTopology,
  resolveLocalSimulatedUserAutorun,
} from "../desktop/eval-main/simulated-user-judge.mjs";

const directories = [];
const digest = `sha256:${"a".repeat(64)}`;

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("local Electron simulated-user judge adapter", () => {
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

  it("recursively inventories only authoritative accepted navigate destinations", async () => {
    const layers = acceptedLayers();
    const loadLayer = vi.fn(async (layerId) => layers.get(String(layerId)));
    const topology = await buildAcceptedReviewTopology({
      turnId: 41,
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
    const runner = createLocalSimulatedUserJudgeRunner({ loadLayer, openReviewSession, runJudge });

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
    }));
    expect(runJudge).toHaveBeenCalledTimes(1);
    expect(runJudge).toHaveBeenCalledWith(expect.objectContaining({
      workingDirectory: artifactDirectory,
      additionalDirectories: [],
      artifactEvidence: undefined,
    }));
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
    });
    expect(JSON.parse(await readFile(join(artifactDirectory, "judge-configuration.json"), "utf8"))).toEqual({
      model: "gpt-5.6-sol",
      modelReasoningEffort: "high",
    });
    expect(JSON.parse(await readFile(join(artifactDirectory, "interaction-trace.json"), "utf8"))).toMatchObject({
      session: [{ type: "session-opened" }],
      tools: [{ tool: "screenshot" }],
      codex: [{ type: "mcp_tool_call", tool: "screenshot" }],
    });
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

  it("selects the missing-action-aware recursive review store for rubric v5 and forwards artifact evidence", async () => {
    const artifactDirectory = await temporaryDirectory();
    const evidence = {
      schemaVersion: 1,
      source: "bounded_host_packet",
      summary: "One verifier fact.",
      facts: ["PASS workspace:focused-tests"],
    };
    const runJudge = vi.fn(async ({ reviewStore, artifactEvidence }) => {
      expect(reviewStore.snapshot()).toMatchObject({
        schemaVersion: 3,
        contractId: "recursive-presentation-judge-v3",
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
      runJudge,
    });

    const result = await runner({
      artifactDirectory,
      execution: { id: "execution-1" },
      thread: { id: "7" },
      turn: { id: "41", rootLayerId: "10" },
      request: { text: "Explain." },
      rubric: { rubricVersion: "graph-presentation-rubric-v5" },
      artifactEvidence: evidence,
      reviewSequence: { index: 0, count: 1 },
    });

    expect(result).toMatchObject({ status: "partial", review: { schemaVersion: 3 }, error: "fixture stops before paid inference" });
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
