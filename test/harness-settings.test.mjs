import { describe, expect, it } from "vitest";

import { validateHarnessRules } from "../desktop/renderer/src/harness-settings-model.js";

describe("harness Settings model-rule validation", () => {
  it("accepts separate allow and deny exact/regex rules", () => {
    expect(validateHarnessRules({
      allow: [
        { adapterId: "openai-api", modelIdExact: "gpt-5.2" },
        { adapterId: "anthropic-api", modelIdRegex: "^claude-sonnet-" },
      ],
      deny: [{ adapterId: "openai-api", modelIdRegex: "-preview$" }],
    })).toEqual({});
  });

  it("blocks malformed, unsupported, and duplicate rules before save", () => {
    const errors = validateHarnessRules({
      allow: [
        { adapterId: " openai-api", modelIdExact: "" },
        { adapterId: "openai-api", modelIdRegex: "(?=preview)" },
      ],
      deny: [
        { adapterId: "openai-api", modelIdExact: "gpt-5.2" },
        { adapterId: "openai-api", modelIdExact: "gpt-5.2" },
      ],
    });
    expect(errors["allow.0.adapterId"]).toMatch(/valid adapter/i);
    expect(errors["allow.0.pattern"]).toMatch(/exact model/i);
    expect(errors["allow.1.pattern"]).toMatch(/unsupported/i);
    expect(errors["deny.1.pattern"]).toMatch(/duplicate/i);
  });
});
