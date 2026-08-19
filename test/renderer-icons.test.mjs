import { afterEach, describe, expect, it, vi } from "vitest";
import * as lucideExports from "lucide";
import {
  RELAYER_ICON_NAMES,
  createRelayerIcon,
  relayerIconDescriptor,
  resolveRelayerIconName,
} from "../desktop/renderer/src/product-workspace/icons.js";

describe("workspace Relayer icons", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the curated vocabulary and resolves compatibility aliases", () => {
    expect(RELAYER_ICON_NAMES).toContain("compass");
    expect(new Set(RELAYER_ICON_NAMES).size).toBe(RELAYER_ICON_NAMES.length);
    expect(resolveRelayerIconName("CIRCLE_ALERT")).toBe("alert-circle");
    expect(relayerIconDescriptor("file code 2")).toMatchObject({
      renderedName: "file-code-2",
      lucideExportName: "FileCode2",
      usesFallback: false,
    });
  });

  it("has a pinned Lucide drawing for every curated name", () => {
    for (const name of RELAYER_ICON_NAMES) {
      expect(lucideExports[relayerIconDescriptor(name).lucideExportName], name).toBeDefined();
    }
  });

  it("uses a deterministic neutral fallback for legacy unknown names", () => {
    expect(relayerIconDescriptor("🧭")).toEqual({
      canonicalName: null,
      renderedName: "circle",
      lucideExportName: "Circle",
      usesFallback: true,
    });
    expect(relayerIconDescriptor("constructor")).toEqual({
      canonicalName: null,
      renderedName: "circle",
      lucideExportName: "Circle",
      usesFallback: true,
    });
  });

  it("creates the selected Lucide SVG without exposing the full catalog", () => {
    const Compass = Symbol("Compass");
    const Circle = Symbol("Circle");
    const createElement = vi.fn((icon, attributes) => ({ icon, attributes }));
    vi.stubGlobal("lucide", { Compass, Circle, createElement });

    expect(createRelayerIcon("compass", { class: "node-icon" })).toEqual({
      icon: Compass,
      attributes: expect.objectContaining({
        class: "node-icon",
        "aria-hidden": "true",
        "data-relayer-icon": "compass",
      }),
    });
    expect(createRelayerIcon("alarm-clock")).toMatchObject({ icon: Circle });
  });
});
