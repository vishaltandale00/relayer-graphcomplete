import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

import { validateHarnessRules } from "../desktop/renderer/src/harness-settings-model.js";

describe("harness Settings model-rule validation", () => {
  it("keeps the model-rule editor unexposed and validates every rule before save", async () => {
    const source = await readFile(new URL("../desktop/renderer/src/harness-settings.js", import.meta.url), "utf8");
    const shell = await readFile(new URL("../desktop/renderer/index.html", import.meta.url), "utf8");
    expect(source, "the rule editor save path stays out of Harnesses settings").not.toContain("saveHarnessModelRules");
    expect(source, "rule row markup stays out of Harnesses settings").not.toContain("data-harness-rule");
    expect(source, "the advanced configuration section stays out of Harnesses settings").not.toContain("Advanced configuration");
    expect(shell, "the settings shell never advertises execution-behavior control").not.toContain("Harness configurations control execution behavior");

    const cases = [
      [
        "accepts separate allow and deny exact/regex rules",
        {
          allow: [
            { adapterId: "openai-api", modelIdExact: "gpt-5.2" },
            { adapterId: "anthropic-api", modelIdRegex: "^claude-sonnet-" },
          ],
          deny: [{ adapterId: "openai-api", modelIdRegex: "-preview$" }],
        },
        {},
      ],
      [
        "blocks malformed adapter ids, empty exact patterns, and unsupported regexes",
        {
          allow: [
            { adapterId: " openai-api", modelIdExact: "" },
            { adapterId: "openai-api", modelIdRegex: "(?=preview)" },
          ],
          deny: [],
        },
        {
          "allow.0.adapterId": /valid adapter/i,
          "allow.0.pattern": /exact model/i,
          "allow.1.pattern": /unsupported/i,
        },
      ],
      [
        "blocks duplicate deny rules before save",
        {
          allow: [],
          deny: [
            { adapterId: "openai-api", modelIdExact: "gpt-5.2" },
            { adapterId: "openai-api", modelIdExact: "gpt-5.2" },
          ],
        },
        { "deny.1.pattern": /duplicate/i },
      ],
    ];
    expect(cases).toHaveLength(3);
    for (const [label, rules, expectedErrors] of cases) {
      expect.soft(validateHarnessRules(rules), label).toMatchObject(expectedErrors);
      if (Object.keys(expectedErrors).length === 0) {
        expect.soft(validateHarnessRules(rules), `${label}: no stray errors`).toEqual({});
      }
    }
  });
});
