import { describe, expect, it } from "vitest";

import {
  confirmationRestorationKey,
  interactionSubmissionTarget,
  restoredDraftForInteraction,
} from "../desktop/renderer/src/interaction-failure-model.js";
import { resolveUnsentModelIntent } from "../desktop/renderer/src/model-picker-model.js";

const settings = {
  defaults: { harnessId: "coding-default" },
  harnesses: [{
    id: "coding-default",
    modelCompatibility: [
      { providerId: "anthropic-work" },
      { providerId: "openai-work" },
      { providerId: "openai-personal" },
    ],
  }],
  providers: [
    { id: "anthropic-work", connected: true, models: [{ id: "claude-sonnet-4", visible: true, available: false }] },
    { id: "openai-work", connected: false, models: [{ id: "gpt-5.2", visible: true, available: true }] },
    { id: "openai-personal", connected: true, models: [{ id: "gpt-5.2", visible: true, available: true }] },
  ],
  families: [{
    id: 12,
    enabled: true,
    members: [
      { providerId: "anthropic-work", modelId: "claude-sonnet-4", position: 0 },
      { providerId: "openai-work", modelId: "gpt-5.2", position: 1 },
      { providerId: "openai-personal", modelId: "gpt-5.2", position: 2 },
    ],
  }],
};

const unsentSelection = {
  harnessId: "coding-default",
  familyId: 12,
  providerId: "anthropic-work",
  modelId: "claude-sonnet-4",
};

describe("composer provider lifecycle", () => {
  it("reselects unsent model intents inside the current family under rules and blocks instead of jumping families", () => {
    expect(resolveUnsentModelIntent(settings, unsentSelection), "reselect stays inside the current family").toEqual({
      selection: {
        harnessId: "coding-default",
        familyId: 12,
        providerId: "openai-personal",
        modelId: "gpt-5.2",
      },
      blockedFamilyId: null,
    });

    const ruled = structuredClone(settings);
    ruled.providers[0].adapterId = "anthropic-api";
    ruled.providers[0].models[0].available = true;
    ruled.providers[1].adapterId = "openai-api";
    ruled.providers[1].connected = true;
    ruled.providers[2].adapterId = "openai-api";
    ruled.harnesses[0] = {
      id: "coding-default",
      modelRules: {
        allow: [
          { adapterId: "anthropic-api", modelIdRegex: "^claude-" },
          { adapterId: "openai-api", modelIdExact: "gpt-5.2" },
        ],
        deny: [{ adapterId: "anthropic-api", modelIdRegex: "-sonnet-" }],
      },
    };
    expect(resolveUnsentModelIntent(ruled, unsentSelection).selection, "adapter exact/regex allow rules with deny precedence")
      .toMatchObject({ providerId: "openai-work", modelId: "gpt-5.2" });

    const unavailable = structuredClone(settings);
    unavailable.providers[2].connected = false;
    unavailable.families.push({
      id: 13,
      enabled: true,
      members: [{ providerId: "openai-personal", modelId: "gpt-5.2", position: 0 }],
    });
    expect(resolveUnsentModelIntent(unavailable, unsentSelection), "no resolvable member blocks instead of jumping families")
      .toEqual({ selection: null, blockedFamilyId: 12 });
  });

  it("restores model-failed interactions as unsent retry drafts and re-admits them instead of duplicating", () => {
    expect(restoredDraftForInteraction({
      completionStatus: "not_started",
      text: "Review this repository",
      modelSelection: { familyId: 12, providerId: "openai-work", modelId: "gpt-5.2" },
      latestAttempt: {
        id: 44,
        outcome: "model_failed",
        effectBoundary: "none",
        failureCategory: "rate_limit",
        failureMessage: "OpenAI Work is rate limited.",
      },
    }), "model failure restores the same unsent draft").toEqual({
      text: "Review this repository",
      modelSelection: { familyId: 12, providerId: "openai-work", modelId: "gpt-5.2" },
      failureCategory: "rate_limit",
      retryAttemptId: 44,
      message: "OpenAI Work is rate limited.",
    });

    const partialEffectBoundaries = ["partial_output", "graph_write", "tool_effect", "unknown"];
    expect(partialEffectBoundaries, "partial-effect inventory").toHaveLength(4);
    for (const effectBoundary of partialEffectBoundaries) {
      expect.soft(restoredDraftForInteraction({
        completionStatus: "not_started",
        text: "Review this repository",
        modelSelection: { familyId: 12, providerId: "openai-work", modelId: "gpt-5.2" },
        latestAttempt: {
          id: 44,
          outcome: "model_failed",
          effectBoundary,
          failureCategory: "provider_timeout",
        },
      }), `duplicate-risk contract after ${effectBoundary}`).toMatchObject({
        text: "Review this repository",
        retryAttemptId: 44,
        failureCategory: "provider_timeout",
      });
    }

    expect(restoredDraftForInteraction({
      completionStatus: "not_started",
      text: "Review this repository",
      latestAttempt: {
        id: 45,
        outcome: "model_failed",
        effectBoundary: "none",
        failureCategory: "execution",
      },
    }), "generic execution category keeps the durable model-failed outcome").toMatchObject({
      text: "Review this repository",
      retryAttemptId: 45,
      failureCategory: "execution",
    });

    const nonRestorableCategories = ["harness_logic", "graph_validation", "tool_failure", "permission_denied", "application_bug"];
    expect(nonRestorableCategories, "non-restorable category inventory").toHaveLength(5);
    for (const failureCategory of nonRestorableCategories) {
      expect.soft(restoredDraftForInteraction({
        completionStatus: "failed",
        text: "Do not restore",
        latestAttempt: { failureCategory },
      }), `${failureCategory} is not restored`).toBeNull();
    }

    const interaction = {
      id: 91,
      completionStatus: "not_started",
      text: "Review this repository",
      latestAttempt: {
        id: 44,
        outcome: "model_failed",
        failureCategory: "rate_limit",
      },
    };
    expect(confirmationRestorationKey(7, interaction), "confirmation restoration key tracks the attempt")
      .toBe("7:91:44");
    interaction.latestAttempt.id = 45;
    expect(confirmationRestorationKey(7, interaction), "later retry attempt restores confirmations again")
      .toBe("7:91:45");

    const latestInteraction = {
      id: 91,
      completionStatus: "not_started",
      text: "Review this repository",
      modelSelection: { familyId: 12, providerId: "openai-work", modelId: "gpt-5.2" },
      latestAttempt: {
        id: 44,
        attemptNumber: 1,
        outcome: "model_failed",
        failureCategory: "rate_limit",
        effectBoundary: "none",
      },
    };
    expect(interactionSubmissionTarget(
      7,
      latestInteraction,
      "Review this repository carefully",
      { familyId: 12, providerId: "openai-personal", modelId: "gpt-5.2" },
      "retry-input-2",
      [{ target: { nodeId: 8, sourceInteractionNodeId: 3, sourceLayerId: 4 }, annotations: ["new context"] }],
    ), "unsent turn re-admits through the retry route").toEqual({
      path: "/api/threads/7/interactions/91/retry",
      body: {
        attemptId: 44,
        text: "Review this repository carefully",
        inputId: "retry-input-2",
        contexts: [{ target: { nodeId: 8, sourceInteractionNodeId: 3, sourceLayerId: 4 }, annotations: ["new context"] }],
        contextConfirmationIds: [],
        modelSelection: { familyId: 12, providerId: "openai-personal", modelId: "gpt-5.2" },
      },
    });

    const selection = { familyId: 12, providerId: "openai-work", modelId: "gpt-5.2" };
    expect(interactionSubmissionTarget(
      7,
      null,
      "Use inputs",
      selection,
      "input-1",
      [],
      [],
      9,
    ).body, "create request carries the inspected input draft revision").toMatchObject({ inputDraftRevision: 9 });
    expect(interactionSubmissionTarget(
      7,
      {
        id: 91,
        completionStatus: "not_started",
        latestAttempt: { id: 44, outcome: "model_failed", failureCategory: "transport" },
      },
      "Use inputs",
      selection,
      "input-1",
      [],
      [],
      9,
    ).body, "retry request carries the inspected input draft revision").toMatchObject({ inputId: "input-1", inputDraftRevision: 9 });
  });
});
