import { describe, expect, it } from "vitest";
import { openEvidenceBrowserPage } from "../scripts/evidence-browser-target.mjs";

describe("provider evidence page bootstrap", () => {
  it.each([false, true])("runs first-boot onboarding once, after viewport setup (forced colors: %s)", async (forcedColors) => {
    const scene = "http://fixture/evidence.html?scene=onboarding";
    let dismissed = false;
    let viewport;
    let media;
    const boots = [];
    const boot = (url) => {
      if (url === "about:blank") return;
      // A completed initial boot wins the attachment race and persists Not now.
      boots.push({ url, onboardingVisible: !dismissed, viewport, media });
      dismissed = true;
    };
    const cdp = { call: async (method, params) => {
      if (method === "Emulation.setDeviceMetricsOverride") viewport = params;
      if (method === "Emulation.setEmulatedMedia") media = params;
      if (method === "Page.navigate") boot(params.url);
      if (method === "Page.reload") boot(scene);
    }, close() {} };
    const result = await openEvidenceBrowserPage(new URL("ws://localhost:9222/devtools/browser/fixture"), scene, {
      width: 620, forcedColors,
      request: async (url, options) => {
        expect(options.method).toBe("PUT");
        boot(decodeURIComponent(new URL(url).search.slice(1)));
        return { json: async () => ({ webSocketDebuggerUrl: "ws://fixture/page" }) };
      },
      connect: async (url) => { expect(url).toBe("ws://fixture/page"); return cdp; },
    });
    expect(result).toBe(cdp);
    expect(boots).toEqual([{ url: scene, onboardingVisible: true,
      viewport: { width: 620, height: 800, deviceScaleFactor: 1, mobile: false },
      media: forcedColors ? { features: [{ name: "forced-colors", value: "active" }] } : undefined,
    }]);
  });
});
