import { describe, expect, it } from "vitest";

import { evalSidebarHeading } from "../desktop/renderer/src/navigation-model.js";

describe("Eval ProductWorkspace sidebar presentation", () => {
  it("labels imported review context as an external conversation", () => {
    expect(evalSidebarHeading({
      harnessConfigurationName: null,
      origin: { kind: "external-conversation-export" },
    })).toBe("External conversation");
  });

  it("retains case and harness context for local Eval executions", () => {
    expect(evalSidebarHeading({
      harnessConfigurationName: "codex-basic",
      origin: null,
    })).toBe("Cases · codex-basic");
  });
});
