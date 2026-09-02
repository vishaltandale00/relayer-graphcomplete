import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// Electron sandboxed preloads resolve only electron, events, timers and url.
// A relative require throws before contextBridge runs, which removes the whole
// desktop bridge: the renderer then sees no window.relayerDesktop and every
// account and settings call dies. Read the preload as text so this holds even
// when the file cannot be imported.
const preloadSource = readFileSync(new URL("../desktop/preload/index.cjs", import.meta.url), "utf8");

describe("sandboxed preload module boundary", () => {
  it("stays resolvable from a sandboxed preload and exposes the desktop bridge under the renderer's name", () => {
    expect(preloadSource.match(/require\(\s*["'`]\.[^"'`]*["'`]\s*\)/gu), "no relative require").toBeNull();
    const required = [...preloadSource.matchAll(/require\(\s*["'`]([^"'`]+)["'`]\s*\)/gu)].map(([, name]) => name);
    expect(required.length, "preload requires at least one module").toBeGreaterThan(0);
    const unresolvable = required.filter((name) => !["electron", "events", "timers", "url"].includes(name));
    expect(unresolvable, `every require resolves in a sandboxed preload, found: ${unresolvable.join(", ")}`).toEqual([]);
    expect(preloadSource, "bridge exposed as window.relayerDesktop").toContain('exposeInMainWorld("relayerDesktop"');
  });
});
