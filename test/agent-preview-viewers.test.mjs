import { describe, expect, it } from "vitest";

import { PREVIEW_VIEWERS } from "../scripts/agent-preview-viewers.mjs";

const at = "2026-09-30T12:00:00.000Z";
const layer = "layer-30-abababababababab.png";

describe("PREV-005 preview viewers", () => {
  it("reads Codex image views", () => {
    expect(PREVIEW_VIEWERS["codex-basic"]([
      { type: "provider.event", observedAt: at, data: { method: "item/completed", params: { item: { type: "imageView", path: `/tmp/p/${layer}` } } } },
      { type: "provider.event", observedAt: at, data: { method: "item/started", params: { item: { type: "imageView", path: "/tmp/p/other.png" } } } },
    ])).toEqual([{ observedAt: at, file: layer }]);
  });

  it("reads only Claude previews the tool returned", () => {
    expect(PREVIEW_VIEWERS["claude-basic"]([
      { type: "tool.call.completed", observedAt: at, data: { tool: "view_graph_preview", outcome: "viewed", file: layer, byteLength: 9 } },
      { type: "tool.call.completed", observedAt: at, data: { tool: "view_graph_preview", outcome: "refused", file: "passwd" } },
    ])).toEqual([{ observedAt: at, file: layer }]);
  });

  it("reads only Prime attachments that reached the model as images", () => {
    const attachment = { mimeType: "image/png", byteLength: 9, path: `/tmp/p/${layer}` };
    const result = (content, isError = false) => ({ type: "tool.call.completed", observedAt: at, data: {
      toolCallId: "t", toolName: "ipython", isError, result: { content, details: { attachments: [attachment] } },
    } });
    const image = { type: "image", mimeType: "image/png", byteLength: 9 };
    expect(PREVIEW_VIEWERS["prime-agent-basic"]([
      result([{ type: "text", text: "Loaded" }, image]),
      result([{ type: "text", text: "Loaded" }]),
      result([{ type: "text", text: "Loaded" }, image], true),
      { type: "tool.call.started", observedAt: at, data: { toolName: "ipython", args: { code: "attach_image(p)" } } },
    ])).toEqual([{ observedAt: at, file: layer }]);
  });
});
