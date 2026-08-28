import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

import {
  authoritativeRefreshConfirmed,
  validateHarnessRules,
} from "../desktop/renderer/src/harness-settings-model.js";

describe("harness Settings model-rule validation", () => {
  it("refreshes authoritative harness eligibility after saving advanced rules", async () => {
    const source = await readFile(new URL("../desktop/renderer/src/harness-settings.js", import.meta.url), "utf8");
    const save = source.indexOf("await saveHarnessModelRules");
    const refresh = source.indexOf("const applied = await refreshModelSettings()", save);
    const failClosed = source.indexOf("eligibilityRefreshFailed = true", refresh);
    const safeRender = source.indexOf("if (!harness && eligibilityRefreshFailed)");
    expect(save).toBeGreaterThan(-1);
    expect(refresh).toBeGreaterThan(save);
    expect(failClosed).toBeGreaterThan(refresh);
    expect(safeRender).toBeGreaterThan(-1);
    expect(source).toContain('id="retryHarnessEligibility"');
    expect(source).toContain("authoritativeRefreshConfirmed(");
    expect(source).toContain("export function markHarnessEligibilityCurrent()");
    const familySource = await readFile(new URL("../desktop/renderer/src/model-family-settings.js", import.meta.url), "utf8");
    expect(familySource).toContain("markHarnessEligibilityCurrent();");
  });

  it("distinguishes a successful newer refresh from an unconfirmed superseded request", () => {
    const previous = {};
    expect(authoritativeRefreshConfirmed(previous, previous, false)).toBe(false);
    expect(authoritativeRefreshConfirmed(previous, {}, false)).toBe(true);
    expect(authoritativeRefreshConfirmed(previous, previous, true)).toBe(true);
  });

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
