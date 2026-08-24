import { describe, expect, it } from "vitest";
import {
  actionActivationPresentation,
  actionPresentation,
  actionReviewKind,
} from "../desktop/renderer/src/product-workspace/workspace.js";

describe("workspace action presentation grammar", () => {
  it("keeps legacy actions compatible through the canonical pill default", () => {
    expect(actionPresentation({ label: "Continue" })).toEqual({
      variant: "pill",
      label: "Continue",
      icon: null,
      description: null,
    });
  });

  it("preserves AI-authored card content without inventing presentation", () => {
    expect(actionPresentation({
      variant: "card",
      label: "Investigate the renderer",
      icon: "search",
      description: "Trace the accepted graph through the production workspace.",
    })).toEqual({
      variant: "card",
      label: "Investigate the renderer",
      icon: "search",
      description: "Trace the accepted graph through the production workspace.",
    });
  });

  it("renders an unknown legacy variant as a pill without leaking card-only detail", () => {
    expect(actionPresentation({
      variant: "banner",
      label: "Legacy action",
      description: "Unsupported presentation",
    })).toEqual({
      variant: "pill",
      label: "Legacy action",
      icon: null,
      description: null,
    });
  });

  it("keeps unresolved invoke authority mode-specific but makes resolved invokes read-only navigation", () => {
    const unresolved = { id: 7, kind: "invoke", targetLayerId: null };
    const resolved = { ...unresolved, targetLayerId: 91 };

    expect(actionActivationPresentation(unresolved, {
      canInvokeMutatingActions: true,
    })).toMatchObject({ resolvedInvoke: false, navigational: false, disabled: false });
    expect(actionActivationPresentation(unresolved, {
      canInvokeMutatingActions: false,
    })).toMatchObject({ resolvedInvoke: false, navigational: false, disabled: true });
    expect(actionActivationPresentation(unresolved, {
      invoked: true,
      canInvokeMutatingActions: true,
    })).toMatchObject({ resolvedInvoke: false, navigational: false, disabled: true });
    expect(actionActivationPresentation(resolved, {
      invoked: true,
      canInvokeMutatingActions: false,
    })).toMatchObject({ resolvedInvoke: true, navigational: true, disabled: false });
    expect(actionReviewKind(unresolved)).toBe("invoke-action");
    expect(actionReviewKind(resolved)).toBe("navigate-action");
  });
});
