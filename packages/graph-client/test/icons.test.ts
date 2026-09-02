import { describe, expect, it } from "vitest";
import {
  RELAYER_ICON_NAMES,
  isSupportedRelayerIcon,
  resolveRelayerIconName,
} from "../src/icons.js";

describe("Relayer icon vocabulary", () => {
  it("curates, normalizes, and confines the icon vocabulary", () => {
    expect(RELAYER_ICON_NAMES, "curated inventory").toContain("compass");
    expect(new Set(RELAYER_ICON_NAMES).size, "no duplicate names").toBe(RELAYER_ICON_NAMES.length);

    const resolutions: Array<[label: string, input: string, expected: string | null]> = [
      ["canonical name with stray casing and whitespace", " Compass ", "compass"],
      ["compatibility alias CIRCLE_ALERT", "CIRCLE_ALERT", "alert-circle"],
      ["compatibility alias file pen", "file pen", "file-edit"],
      ["Lucide name outside the vocabulary", "alarm-clock", null],
      ["prototype-pollution style name", "constructor", null],
    ];
    expect(resolutions, "resolution corpus").toHaveLength(5);
    for (const [label, input, expected] of resolutions) {
      expect.soft(resolveRelayerIconName(input), label).toBe(expected);
    }
    expect.soft(isSupportedRelayerIcon("🧭"), "emoji is not a supported icon").toBe(false);
  });
});
