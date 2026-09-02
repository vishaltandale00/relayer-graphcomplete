import { afterEach, describe, expect, it, vi } from "vitest";
import * as lucideExports from "lucide";
import {
  RELAYER_ICON_NAMES,
  assertRelayerIconRendererReady,
  createRelayerIcon,
  relayerIconDescriptor,
  resolveRelayerIconName,
} from "../desktop/renderer/src/product-workspace/icons.js";

describe("workspace Relayer icons", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves the curated vocabulary through rendering and fails startup without the vendored renderer", () => {
    expect(RELAYER_ICON_NAMES, "curated vocabulary").toContain("compass");
    expect(new Set(RELAYER_ICON_NAMES).size, "unique curated names").toBe(RELAYER_ICON_NAMES.length);
    expect(resolveRelayerIconName("CIRCLE_ALERT"), "compatibility alias").toBe("alert-circle");
    expect(relayerIconDescriptor("file code 2"), "canonical descriptor").toMatchObject({
      renderedName: "file-code-2",
      lucideExportName: "FileCode2",
      usesFallback: false,
    });
    for (const name of RELAYER_ICON_NAMES) {
      expect(lucideExports[relayerIconDescriptor(name).lucideExportName], `pinned Lucide drawing for ${name}`).toBeDefined();
    }

    const neutralFallback = {
      canonicalName: null,
      renderedName: "circle",
      lucideExportName: "Circle",
      usesFallback: true,
    };
    expect(relayerIconDescriptor("🧭"), "legacy unknown name fallback").toEqual(neutralFallback);
    expect(relayerIconDescriptor("constructor"), "prototype-name fallback").toEqual(neutralFallback);

    const Compass = Symbol("Compass");
    const Circle = Symbol("Circle");
    const createElement = vi.fn((icon, attributes) => ({ icon, attributes }));
    vi.stubGlobal("lucide", { Compass, Circle, createElement });

    expect(createRelayerIcon("compass", { class: "node-icon" }), "selected Lucide SVG creation").toEqual({
      icon: Compass,
      attributes: expect.objectContaining({
        class: "node-icon",
        "aria-hidden": "true",
        "data-relayer-icon": "compass",
      }),
    });
    expect(createRelayerIcon("alarm-clock"), "icon outside the stubbed catalog").toMatchObject({ icon: Circle });

    vi.stubGlobal("lucide", undefined);
    expect(() => assertRelayerIconRendererReady(), "startup failure without the vendored renderer").toThrow(
      "The vendored Lucide renderer must load before Relayer icons are created.",
    );
  });
});
