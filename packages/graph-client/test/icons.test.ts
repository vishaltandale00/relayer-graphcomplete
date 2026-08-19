import { describe, expect, it } from "vitest";
import {
  RELAYER_ICON_NAMES,
  isSupportedRelayerIcon,
  resolveRelayerIconName,
} from "../src/icons.js";

describe("Relayer icon vocabulary", () => {
  it("exports the curated names without duplicates", () => {
    expect(RELAYER_ICON_NAMES).toContain("compass");
    expect(new Set(RELAYER_ICON_NAMES).size).toBe(RELAYER_ICON_NAMES.length);
  });

  it("normalizes canonical names and compatibility aliases", () => {
    expect(resolveRelayerIconName(" Compass ")).toBe("compass");
    expect(resolveRelayerIconName("CIRCLE_ALERT")).toBe("alert-circle");
    expect(resolveRelayerIconName("file pen")).toBe("file-edit");
  });

  it("does not expose Lucide names outside Relayer's vocabulary", () => {
    expect(resolveRelayerIconName("alarm-clock")).toBeNull();
    expect(resolveRelayerIconName("constructor")).toBeNull();
    expect(isSupportedRelayerIcon("🧭")).toBe(false);
  });
});
