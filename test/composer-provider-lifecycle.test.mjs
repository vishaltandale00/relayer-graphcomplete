import { describe, expect, it } from "vitest";

import {
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

describe("composer provider lifecycle", () => {
  it("reselects only within the current family while a turn is unsent", () => {
    expect(resolveUnsentModelIntent(settings, {
      harnessId: "coding-default",
      familyId: 12,
      providerId: "anthropic-work",
      modelId: "claude-sonnet-4",
    })).toEqual({
      selection: {
        harnessId: "coding-default",
        familyId: 12,
        providerId: "openai-personal",
        modelId: "gpt-5.2",
      },
      blockedFamilyId: null,
    });
  });

  it("blocks instead of jumping families when the selected family has no resolvable member", () => {
    const unavailable = structuredClone(settings);
    unavailable.providers[2].connected = false;
    unavailable.families.push({
      id: 13,
      enabled: true,
      members: [{ providerId: "openai-personal", modelId: "gpt-5.2", position: 0 }],
    });
    expect(resolveUnsentModelIntent(unavailable, {
      harnessId: "coding-default",
      familyId: 12,
      providerId: "anthropic-work",
      modelId: "claude-sonnet-4",
    })).toEqual({ selection: null, blockedFamilyId: 12 });
  });

  it("restores model-related failures as the same unsent draft", () => {
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
    })).toEqual({
      text: "Review this repository",
      modelSelection: { familyId: 12, providerId: "openai-work", modelId: "gpt-5.2" },
      failureCategory: "rate_limit",
      retryAttemptId: 44,
      message: "OpenAI Work is rate limited.",
    });
  });

  it("restores model failures after partial effects under the accepted duplicate-risk contract", () => {
    for (const effectBoundary of ["partial_output", "graph_write", "tool_effect", "unknown"]) {
      expect(restoredDraftForInteraction({
        completionStatus: "not_started",
        text: "Review this repository",
        modelSelection: { familyId: 12, providerId: "openai-work", modelId: "gpt-5.2" },
        latestAttempt: {
          id: 44,
          outcome: "model_failed",
          effectBoundary,
          failureCategory: "provider_timeout",
        },
      })).toMatchObject({
        text: "Review this repository",
        retryAttemptId: 44,
        failureCategory: "provider_timeout",
      });
    }
  });

  it("uses the durable model-failed outcome when admission has only a generic execution category", () => {
    expect(restoredDraftForInteraction({
      completionStatus: "not_started",
      text: "Review this repository",
      latestAttempt: {
        id: 45,
        outcome: "model_failed",
        effectBoundary: "none",
        failureCategory: "execution",
      },
    })).toMatchObject({
      text: "Review this repository",
      retryAttemptId: 45,
      failureCategory: "execution",
    });
  });

  it("does not restore harness, graph, tool, permission, or app failures", () => {
    for (const failureCategory of ["harness_logic", "graph_validation", "tool_failure", "permission_denied", "application_bug"]) {
      expect(restoredDraftForInteraction({
        completionStatus: "failed",
        text: "Do not restore",
        latestAttempt: { failureCategory },
      })).toBeNull();
    }
  });

  it("re-admits the serialized unsent turn instead of creating a duplicate interaction", () => {
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
    )).toEqual({
      path: "/api/threads/7/interactions/91/retry",
      body: {
        attemptId: 44,
        text: "Review this repository carefully",
        modelSelection: { familyId: 12, providerId: "openai-personal", modelId: "gpt-5.2" },
      },
    });
  });

  it("applies adapter exact/regex allow rules with deny precedence", () => {
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
    expect(resolveUnsentModelIntent(ruled, {
      harnessId: "coding-default",
      familyId: 12,
      providerId: "anthropic-work",
      modelId: "claude-sonnet-4",
    }).selection).toMatchObject({ providerId: "openai-work", modelId: "gpt-5.2" });
  });
});
