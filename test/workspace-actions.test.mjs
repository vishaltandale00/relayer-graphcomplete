import { describe, expect, it } from "vitest";
import { actionPresentation } from "../desktop/renderer/src/product-workspace/workspace.js";

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
});
