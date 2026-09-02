import { describe, expect, it } from "vitest";

import { evalSidebarHeading } from "../desktop/renderer/src/navigation-model.js";

describe("Eval ProductWorkspace sidebar presentation", () => {
  it("labels the sidebar from execution origin, keeping case and harness context for local runs", () => {
    const cases = [
      [
        "imported review context is named as an external conversation",
        { harnessConfigurationName: null, origin: { kind: "external-conversation-export" } },
        "External conversation",
      ],
      [
        "local Eval executions retain case and harness context",
        { harnessConfigurationName: "codex-basic", origin: null },
        "Cases · codex-basic",
      ],
    ];
    expect(cases, "sidebar heading corpus").toHaveLength(2);
    for (const [label, input, heading] of cases) {
      expect(evalSidebarHeading(input), label).toBe(heading);
    }
  });
});
