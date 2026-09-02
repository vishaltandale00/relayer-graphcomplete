import { describe, expect, it } from "vitest";

import {
  parseRustDiagnosticFrames,
  sanitizeJavaScriptErrorFrames,
  sanitizeRustFrames,
} from "../desktop/shared/error-stack-sanitizer.mjs";

describe("desktop error stack sanitizer", () => {
  it("projects JavaScript errors to closed application-relative frames and bounds every hostile stack", () => {
    const projected = [
      ["renderer source tree", "renderer", [
        "TypeError: private graph and workspace content",
        "    at renderWorkspace (/Users/alice/private-checkout/desktop/renderer/src/product-workspace/view.js:41:7)",
        "    at async file:///Users/alice/private-checkout/desktop/renderer/src/main.js:19:3",
      ].join("\n"), [
        { module: "desktop/renderer/src/product-workspace/view.js", line: 41, column: 7 },
        { module: "desktop/renderer/src/main.js", line: 19, column: 3 },
      ]],
      ["packaged electron-main", "electron-main",
        "Error: private\n    at boot (/Applications/Relayer.app/Contents/Resources/app.asar/main/index.mjs:308:11)", [
          { module: "desktop/main/index.mjs", line: 308, column: 11 },
        ]],
      ["packaged harness-host", "node-harness-host",
        "Error: private\n    at host (C:\\Program Files\\Relayer\\resources\\app.asar\\node_modules\\@relayer\\harness-host\\dist\\index.js:72:5)", [
          { module: "packages/harness-host/dist/index.js", line: 72, column: 5 },
        ]],
    ];
    expect(projected, "projection inventory").toHaveLength(3);
    for (const [label, component, stack, frames] of projected) {
      expect(sanitizeJavaScriptErrorFrames({ component, error: { stack } }), `${label} projected without installation paths`).toEqual(frames);
    }

    const accepted = Array.from({ length: 40 }, (_, index) => (
      `    at frame${index} (/Applications/Relayer.app/Contents/Resources/renderer/src/frame-${index}.js:${index + 1}:2)`
    ));
    const hostile = {
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
    const frames = sanitizeJavaScriptErrorFrames({ component: "renderer", error: hostile });
    expect(frames, "absolute, third-party, cross-component, traversal, and malformed locations dropped; output capped").toHaveLength(32);
    expect(frames[0], "first capped frame").toEqual({ module: "desktop/renderer/src/frame-0.js", line: 1, column: 2 });
    expect(frames[31], "last capped frame").toEqual({ module: "desktop/renderer/src/frame-31.js", line: 32, column: 2 });
    expect(Object.isFrozen(frames) && frames.every((frame) => Object.isFrozen(frame)), "frames frozen").toBe(true);
    expect(JSON.stringify(frames), "no hostile location leaked").not.toMatch(/alice|customer|node_modules|vendor|\.\.|private/u);

    const throwingError = Object.create(null, {
      stack: { get() { throw new Error("private stack getter detail"); } },
    });
    const rejected = [
      ["throwing stack getter", "renderer", throwingError],
      ["cross-component frame for a Rust component", "rust-app-server", { stack: "Error: private\n at f (/repo/desktop/main/index.mjs:1:1)" }],
      ["oversized stack", "electron-main", { stack: `${"x".repeat(64 * 1024)}\n at f (/repo/desktop/main/index.mjs:1:1)` }],
      ["overlong stack", "electron-main", { stack: `${Array.from({ length: 256 }, () => "ignored").join("\n")}\n at f (/repo/desktop/main/index.mjs:1:1)` }],
    ];
    expect(rejected, "rejection inventory").toHaveLength(4);
    for (const [label, component, error] of rejected) {
      expect(sanitizeJavaScriptErrorFrames({ component, error }), `${label} returns no raw detail`).toEqual([]);
    }
  });

  it("accepts only closed typed frames from each Rust component's approved crate", () => {
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
    expect(frames, "only the approved crate frame survives").toEqual([
      { module: "crates/relayer-app-server/src/main.rs", line: 81, column: 14 },
    ]);
    expect(Object.isFrozen(frames) && Object.isFrozen(frames[0]), "rust frames frozen").toBe(true);
    expect(JSON.stringify(frames), "no hostile rust location leaked").not.toMatch(/alice|private|vendor/u);

    const capFrames = Array.from({ length: 40 }, (_, index) => ({
      module: `crates/relayer-graph-server/src/frame_${index}.rs`,
      line: index + 1,
      column: 1,
    }));
    expect(sanitizeRustFrames({ component: "rust-graph-server", frames: capFrames }), "rust output capped").toHaveLength(32);
    expect(sanitizeRustFrames({ component: "electron-main", frames: capFrames }), "rust frames rejected for a non-rust component").toEqual([]);
    expect(sanitizeRustFrames({ component: "rust-graph-server", frames: "private" }), "malformed frame container rejected").toEqual([]);

    const text = [
      "private panic at crates/relayer-app-server/src/main.rs:81:14",
      "dependency at crates/other/src/lib.rs:2:3",
      "graph at crates/relayer-graph-server/src/main.rs:9:4",
      "absolute secret /Users/person/private.rs:3:2",
    ].join("\n");
    expect(parseRustDiagnosticFrames({ component: "rust-app-server", text }), "only approved crate-relative diagnostics").toEqual([
      { module: "crates/relayer-app-server/src/main.rs", line: 81, column: 14 },
    ]);
    expect(JSON.stringify(parseRustDiagnosticFrames({ component: "rust-app-server", text })), "no raw diagnostic leaked")
      .not.toMatch(/private panic|Users|dependency/u);
  });
});
