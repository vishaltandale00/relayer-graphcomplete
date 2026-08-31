import { createRequire } from "node:module";

import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { installRendererErrorReporting, sameOriginFrames } = require("../desktop/preload/index.cjs");

describe("renderer typed error-reporting capability", () => {
  it("submits only same-origin application-relative frames for an unhandled renderer error", () => {
    const listeners = new Map();
    const windowTarget = {
      addEventListener: (name, listener) => listeners.set(name, listener),
      removeEventListener: (name) => listeners.delete(name),
    };
    const send = vi.fn();
    const installed = installRendererErrorReporting({
      windowTarget,
      locationTarget: { origin: "http://127.0.0.1:43120" },
      send,
    });
    const error = new TypeError("private prompt /Users/person/workspace");
    error.stack = [
      "TypeError: private prompt",
      " at render (http://127.0.0.1:43120/assets/app.js:41:7)",
      " at remote (https://privacy-sentinel.invalid/private.js:2:3)",
    ].join("\n");

    listeners.get("error")({ error });
    expect(send).toHaveBeenCalledWith({
      code: "renderer.unhandled_crash",
      exceptionClass: "TypeError",
      frames: [{ module: "desktop/renderer/assets/app.js", line: 41, column: 7 }],
    });
    expect(JSON.stringify(send.mock.calls)).not.toMatch(/private prompt|Users|privacy-sentinel/u);
    installed.close();
    expect(listeners.size).toBe(0);
  });

  it("rejects traversal, dependencies, malformed positions, and cross-origin frames", () => {
    const frames = sameOriginFrames({ stack: [
      "Error: private",
      " at traversal (http://127.0.0.1:43120/assets/../secret.js:1:1)",
      " at dependency (http://127.0.0.1:43120/node_modules/evil.js:1:1)",
      " at cross (http://127.0.0.1:43121/assets/app.js:1:1)",
      " at zero (http://127.0.0.1:43120/assets/app.js:0:1)",
    ].join("\n") }, "http://127.0.0.1:43120");
    expect(frames).toEqual([]);
  });

  it("bounds raw stacks and contains renderer transport failure", () => {
    const listeners = new Map();
    const installed = installRendererErrorReporting({
      windowTarget: {
        addEventListener: (name, listener) => listeners.set(name, listener),
        removeEventListener: (name) => listeners.delete(name),
      },
      locationTarget: { origin: "http://127.0.0.1:43120" },
      send: () => { throw new Error("renderer IPC is unavailable"); },
    });
    const oversized = {
      name: "Error",
      stack: `${"x".repeat(64 * 1024)}\n at render (http://127.0.0.1:43120/src/main.js:1:1)`,
    };

    expect(() => listeners.get("error")({ error: oversized })).not.toThrow();
    expect(sameOriginFrames(oversized, "http://127.0.0.1:43120")).toEqual([]);
    installed.close();
  });
});
