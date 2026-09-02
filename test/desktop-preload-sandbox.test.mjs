import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// Electron sandboxed preloads resolve only electron, events, timers and url.
// A relative require throws before contextBridge runs, which removes the whole
// desktop bridge: the renderer then sees no window.relayerDesktop and every
// account and settings call dies. Read the preload as text so this holds even
// when the file cannot be imported.
const preloadSource = readFileSync(new URL("../desktop/preload/index.cjs", import.meta.url), "utf8");

describe("sandboxed preload module boundary", () => {
  it("requires only modules a sandboxed preload can resolve", () => {
    const required = [...preloadSource.matchAll(/require\(\s*["'`]([^"'`]+)["'`]\s*\)/gu)].map(([, name]) => name);
    expect(required.length).toBeGreaterThan(0);
    for (const name of required) expect(["electron", "events", "timers", "url"]).toContain(name);
  });

  it("exposes the desktop bridge under the name the renderer reads", () => {
    expect(preloadSource).toContain('exposeInMainWorld("relayerDesktop"');
  });
});
