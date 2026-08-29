import { describe, expect, it } from "vitest";

import {
  parseRustDiagnosticFrames,
  sanitizeJavaScriptErrorFrames,
  sanitizeRustFrames,
} from "../desktop/shared/error-stack-sanitizer.mjs";

describe("desktop error stack sanitizer", () => {
  it("projects renderer source-tree stack locations to closed application-relative frames", () => {
    const error = new TypeError("private graph and workspace content");
    error.stack = [
      "TypeError: private graph and workspace content",
      "    at renderWorkspace (/Users/alice/private-checkout/desktop/renderer/src/product-workspace/view.js:41:7)",
      "    at async file:///Users/alice/private-checkout/desktop/renderer/src/main.js:19:3",
    ].join("\n");

    expect(sanitizeJavaScriptErrorFrames({ component: "renderer", error })).toEqual([
      { module: "desktop/renderer/src/product-workspace/view.js", line: 41, column: 7 },
      { module: "desktop/renderer/src/main.js", line: 19, column: 3 },
    ]);
  });

  it("recognizes packaged Electron-main and harness-host locations without retaining installation paths", () => {
    const mainError = {
      stack: "Error: private\n    at boot (/Applications/Relayer.app/Contents/Resources/app.asar/main/index.mjs:308:11)",
    };
    const harnessError = {
      stack: "Error: private\n    at host (C:\\Program Files\\Relayer\\resources\\app.asar\\node_modules\\@relayer\\harness-host\\dist\\index.js:72:5)",
    };

    expect(sanitizeJavaScriptErrorFrames({ component: "electron-main", error: mainError })).toEqual([
      { module: "desktop/main/index.mjs", line: 308, column: 11 },
    ]);
    expect(sanitizeJavaScriptErrorFrames({ component: "node-harness-host", error: harnessError })).toEqual([
      { module: "packages/harness-host/dist/index.js", line: 72, column: 5 },
    ]);
  });

  it("drops absolute, third-party, cross-component, traversal, and malformed locations and caps output", () => {
    const accepted = Array.from({ length: 40 }, (_, index) => (
      `    at frame${index} (/Applications/Relayer.app/Contents/Resources/renderer/src/frame-${index}.js:${index + 1}:2)`
    ));
    const error = {
      stack: [
        "Error: private workspace content",
        "    at secret (/Users/alice/Documents/customer.js:2:3)",
        "    at dependency (/repo/node_modules/evil/desktop/renderer/src/steal.js:3:4)",
        "    at vendor (/repo/vendor/desktop/renderer/src/steal.js:4:5)",
        "    at traversal (/repo/desktop/renderer/src/../../private.js:5:6)",
        "    at main (/repo/desktop/main/index.mjs:6:7)",
        "    at data (/repo/desktop/renderer/src/data.json:7:8)",
        "    at zero (/repo/desktop/renderer/src/zero.js:0:1)",
        ...accepted,
      ].join("\n"),
    };

    const frames = sanitizeJavaScriptErrorFrames({ component: "renderer", error });
    expect(frames).toHaveLength(32);
    expect(frames[0]).toEqual({ module: "desktop/renderer/src/frame-0.js", line: 1, column: 2 });
    expect(frames[31]).toEqual({ module: "desktop/renderer/src/frame-31.js", line: 32, column: 2 });
    expect(Object.isFrozen(frames)).toBe(true);
    expect(frames.every((frame) => Object.isFrozen(frame))).toBe(true);
    expect(JSON.stringify(frames)).not.toMatch(/alice|customer|node_modules|vendor|\.\.|private/u);
  });

  it("returns no raw detail when stack access or component input is untrusted", () => {
    const throwingError = Object.create(null, {
      stack: { get() { throw new Error("private stack getter detail"); } },
    });
    expect(sanitizeJavaScriptErrorFrames({ component: "renderer", error: throwingError })).toEqual([]);
    expect(sanitizeJavaScriptErrorFrames({
      component: "rust-app-server",
      error: { stack: "Error: private\n at f (/repo/desktop/main/index.mjs:1:1)" },
    })).toEqual([]);
  });

  it("rejects oversized or overlong stacks before parsing application frames", () => {
    expect(sanitizeJavaScriptErrorFrames({
      component: "electron-main",
      error: { stack: `${"x".repeat(64 * 1024)}\n at f (/repo/desktop/main/index.mjs:1:1)` },
    })).toEqual([]);
    expect(sanitizeJavaScriptErrorFrames({
      component: "electron-main",
      error: { stack: `${Array.from({ length: 256 }, () => "ignored").join("\n")}\n at f (/repo/desktop/main/index.mjs:1:1)` },
    })).toEqual([]);
  });

  it("accepts only closed typed frames from the Rust component's approved crate", () => {
    const frames = sanitizeRustFrames({
      component: "rust-app-server",
      frames: [
        { module: "crates/relayer-app-server/src/main.rs", line: 81, column: 14 },
        { module: "crates/relayer-graph-server/src/main.rs", line: 7, column: 2 },
        { module: "/Users/alice/relayer/crates/relayer-app-server/src/private.rs", line: 8, column: 3 },
        { module: "crates/relayer-app-server/src/../private.rs", line: 9, column: 4 },
        { module: "crates/relayer-app-server/vendor/secret.rs", line: 10, column: 5 },
        { module: "crates/relayer-app-server/src/lib.rs", line: 0, column: 1 },
        { module: "crates/relayer-app-server/src/lib.rs", line: 1, column: 1, raw: "private" },
      ],
    });

    expect(frames).toEqual([
      { module: "crates/relayer-app-server/src/main.rs", line: 81, column: 14 },
    ]);
    expect(Object.isFrozen(frames)).toBe(true);
    expect(Object.isFrozen(frames[0])).toBe(true);
    expect(JSON.stringify(frames)).not.toMatch(/alice|private|vendor/u);
  });

  it("caps Rust output and rejects malformed containers without exposing them", () => {
    const frames = Array.from({ length: 40 }, (_, index) => ({
      module: `crates/relayer-graph-server/src/frame_${index}.rs`,
      line: index + 1,
      column: 1,
    }));
    expect(sanitizeRustFrames({ component: "rust-graph-server", frames })).toHaveLength(32);
    expect(sanitizeRustFrames({ component: "electron-main", frames })).toEqual([]);
    expect(sanitizeRustFrames({ component: "rust-graph-server", frames: "private" })).toEqual([]);
  });

  it("extracts only approved crate-relative Rust locations from raw diagnostics", () => {
    const text = [
      "private panic at crates/relayer-app-server/src/main.rs:81:14",
      "dependency at crates/other/src/lib.rs:2:3",
      "graph at crates/relayer-graph-server/src/main.rs:9:4",
      "absolute secret /Users/person/private.rs:3:2",
    ].join("\n");
    expect(parseRustDiagnosticFrames({ component: "rust-app-server", text })).toEqual([
      { module: "crates/relayer-app-server/src/main.rs", line: 81, column: 14 },
    ]);
    expect(JSON.stringify(parseRustDiagnosticFrames({ component: "rust-app-server", text })))
      .not.toMatch(/private panic|Users|dependency/u);
  });
});
