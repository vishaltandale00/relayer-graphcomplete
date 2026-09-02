import { createRequire } from "node:module";

import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { installRendererErrorReporting, sameOriginFrames } = require("../desktop/preload/index.cjs");

describe("renderer typed error-reporting capability", () => {
  it("submits only same-origin application-relative frames, bounds raw stacks, and contains transport failure", () => {
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
    expect(send, "same-origin application-relative frame submitted").toHaveBeenCalledWith({
      code: "renderer.unhandled_crash",
      exceptionClass: "TypeError",
      frames: [{ module: "desktop/renderer/assets/app.js", line: 41, column: 7 }],
    });
    expect(JSON.stringify(send.mock.calls), "no raw prompt, path, or remote host leaked").not.toMatch(/private prompt|Users|privacy-sentinel/u);
    installed.close();
    expect(listeners.size, "error listener removed on close").toBe(0);

    const rejectedFrames = [
      ["traversal", " at traversal (http://127.0.0.1:43120/assets/../secret.js:1:1)"],
      ["dependency", " at dependency (http://127.0.0.1:43120/node_modules/evil.js:1:1)"],
      ["cross-origin", " at cross (http://127.0.0.1:43121/assets/app.js:1:1)"],
      ["zero position", " at zero (http://127.0.0.1:43120/assets/app.js:0:1)"],
    ];
    for (const [label, line] of rejectedFrames) {
      expect(sameOriginFrames({ stack: ["Error: private", line].join("\n") }, "http://127.0.0.1:43120"), `${label} frame rejected`).toEqual([]);
    }

    const oversized = {
      name: "Error",
      stack: `${"x".repeat(64 * 1024)}\n at render (http://127.0.0.1:43120/src/main.js:1:1)`,
    };
    expect(sameOriginFrames(oversized, "http://127.0.0.1:43120"), "oversized raw stack bounded").toEqual([]);

    const failingListeners = new Map();
    const failing = installRendererErrorReporting({
      windowTarget: {
        addEventListener: (name, listener) => failingListeners.set(name, listener),
        removeEventListener: (name) => failingListeners.delete(name),
      },
      locationTarget: { origin: "http://127.0.0.1:43120" },
      send: () => { throw new Error("renderer IPC is unavailable"); },
    });
    expect(() => failingListeners.get("error")({ error: oversized }), "renderer transport failure contained").not.toThrow();
    failing.close();
  });
});
