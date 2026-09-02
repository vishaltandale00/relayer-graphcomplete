import { describe, expect, it, vi } from "vitest";
import {
  actionActivationPresentation,
  actionPresentation,
  actionReviewKind,
  navigateWorkspaceAction,
} from "../desktop/renderer/src/product-workspace/workspace.js";

describe("workspace action presentation grammar", () => {
  it("presents action variants and activation authority without inventing presentation", () => {
    const presentations = [
      ["legacy action defaults to the canonical pill", { label: "Continue" }, {
        variant: "pill",
        label: "Continue",
        icon: null,
        description: null,
      }],
      ["AI-authored card content is preserved", {
        variant: "card",
        label: "Investigate the renderer",
        icon: "search",
        description: "Trace the accepted graph through the production workspace.",
      }, {
        variant: "card",
        label: "Investigate the renderer",
        icon: "search",
        description: "Trace the accepted graph through the production workspace.",
      }],
      ["unknown legacy variant renders as a pill without leaking card-only detail", {
        variant: "banner",
        label: "Legacy action",
        description: "Unsupported presentation",
      }, {
        variant: "pill",
        label: "Legacy action",
        icon: null,
        description: null,
      }],
    ];
    expect(presentations, "presentation grammar inventory").toHaveLength(3);
    for (const [label, action, expected] of presentations) {
      expect.soft(actionPresentation(action), label).toEqual(expected);
    }

    const unresolved = { id: 7, kind: "invoke", targetLayerId: null };
    const resolved = { ...unresolved, targetLayerId: 91 };
    const activations = [
      ["unresolved invoke is enabled with mutating authority", unresolved, {
        canInvokeMutatingActions: true,
      }, { resolvedInvoke: false, navigational: false, disabled: false }],
      ["unresolved invoke is disabled without mutating authority", unresolved, {
        canInvokeMutatingActions: false,
      }, { resolvedInvoke: false, navigational: false, disabled: true }],
      ["an already-invoked action is disabled", unresolved, {
        invoked: true,
        canInvokeMutatingActions: true,
      }, { resolvedInvoke: false, navigational: false, disabled: true }],
      ["a retryable invoke relabels as Retry", { ...unresolved, label: "Continue" }, {
        retryable: true,
        canInvokeMutatingActions: true,
      }, {
        resolvedInvoke: false,
        navigational: false,
        retryableInvoke: true,
        label: "Retry Continue",
        disabled: false,
      }],
      ["a resolved invoke is read-only navigation", resolved, {
        invoked: true,
        canInvokeMutatingActions: false,
      }, { resolvedInvoke: true, navigational: true, disabled: false }],
    ];
    expect(activations, "activation authority inventory").toHaveLength(5);
    for (const [label, action, context, expected] of activations) {
      expect.soft(actionActivationPresentation(action, context), label).toMatchObject(expected);
    }

    expect.soft(actionReviewKind(unresolved), "unresolved invoke reviews as invoke-action").toBe("invoke-action");
    expect.soft(actionReviewKind(resolved), "resolved invoke reviews as navigate-action").toBe("navigate-action");
    expect.soft(actionReviewKind({ kind: "input" }), "input actions review as input-action").toBe("input-action");
  });

  it("collapses previews before resolved-invoke turn navigation but preserves them for layer navigation", async () => {
    const events = [];
    const collapseContextPreviews = vi.fn(() => events.push("collapse"));
    const onNavigateResolvedInvoke = vi.fn(async (_action, { beforeCommit }) => {
      events.push("resolved-start");
      beforeCommit();
      events.push("resolved-commit");
    });
    const onNavigateLayer = vi.fn(async () => events.push("layer"));
    const sourceNode = { id: 11 };

    await navigateWorkspaceAction({
      action: { id: 7, kind: "invoke", targetLayerId: 91 },
      activation: { resolvedInvoke: true },
      sourceNode,
      collapseContextPreviews,
      onNavigateResolvedInvoke,
      onNavigateLayer,
    });
    expect(events, "resolved invoke collapses previews between start and commit")
      .toEqual(["resolved-start", "collapse", "resolved-commit"]);

    events.length = 0;
    onNavigateResolvedInvoke.mockImplementationOnce(async () => false);
    await navigateWorkspaceAction({
      action: { id: 7, kind: "invoke", targetLayerId: 91 },
      activation: { resolvedInvoke: true },
      sourceNode,
      collapseContextPreviews,
      onNavigateResolvedInvoke,
      onNavigateLayer,
    });
    expect(events, "aborted resolved invoke leaves previews untouched").toEqual([]);

    events.length = 0;
    await navigateWorkspaceAction({
      action: { id: 8, kind: "navigate", targetLayerId: 92 },
      activation: { resolvedInvoke: false },
      sourceNode,
      collapseContextPreviews,
      onNavigateResolvedInvoke,
      onNavigateLayer,
    });
    expect(events, "layer navigation never collapses previews").toEqual(["layer"]);
    expect(onNavigateLayer, "layer navigation targets the action's layer").toHaveBeenLastCalledWith(92, {
      action: { id: 8, kind: "navigate", targetLayerId: 92 },
      sourceNode,
    });
  });
});
