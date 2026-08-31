import { describe, expect, it } from "vitest";
import {
  LayerLayoutObject,
  LayerObject,
  NodeDetailAuthoring,
  NodeObject,
  NodePlacementObject,
  assetRef,
  css,
  DetailCompilationError,
  detailCapability,
  html,
  type ActionObject,
} from "../src/index.js";

describe("typed Node Detail authoring compiler", () => {
  it("checkpoints incrementally authored components in stable identity order", () => {
    const detail = new NodeDetailAuthoring();

    detail.setComponent("summary", html`<section><h2>Summary</h2></section>`);
    detail.setComponent("evidence", html`<section><h2>Evidence</h2></section>`);
    detail.setComponent("summary", html`<section><h2>Decision summary</h2></section>`);

    expect(detail.checkpoint()).toEqual({
      version: 1,
      components: [
        { id: "summary", order: 0, html: "<section><h2>Decision summary</h2></section>", css: "" },
        { id: "evidence", order: 1, html: "<section><h2>Evidence</h2></section>", css: "" },
      ],
      mounts: [],
      assets: [],
      integritySha256: "7c9713d865e27d7ce6670d0c87fbe15be540eadaf9d7b56d64db13d90d9f63b5",
    });
  });

  it("compiles an external-link capability and independent visual into opaque native-host mounts", () => {
    const detail = new NodeDetailAuthoring();
    const documentation = detailCapability.externalLink("documentation", "https://docs.example.com/guide");
    const externalLinkVisual = assetRef({
      id: "external-link-visual",
      digestSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      mediaType: "image/svg+xml",
      representation: "image",
      available: true,
      sanitized: true,
    });

    detail.setComponent("documentation", html`
      <a gc=${documentation} class="documentation-link">
        <span asset=${externalLinkVisual} class="documentation-link__icon" aria-hidden="true"></span>
        Documentation
      </a>
    `, css`.documentation-link { display: inline-flex; gap: 0.5rem; }`);

    const checkpoint = detail.checkpoint();
    expect(checkpoint.components).toEqual([{
      id: "documentation",
      order: 0,
      html: expect.stringMatching(/^<a class="documentation-link" data-gc-mount="m_[a-f0-9]{16}">/),
      css: ".documentation-link { display: inline-flex; gap: 0.5rem; }",
    }]);
    expect(checkpoint.components[0]?.html).not.toMatch(/\bgc=|\basset=/);
    expect(checkpoint.mounts).toEqual([
      {
        id: expect.stringMatching(/^m_[a-f0-9]{16}$/),
        componentId: "documentation",
        kind: "capability",
        host: "a",
        capability: { kind: "link", href: "https://docs.example.com/guide" },
      },
      {
        id: expect.stringMatching(/^m_[a-f0-9]{16}$/),
        componentId: "documentation",
        kind: "asset",
        host: "span",
        assetId: "external-link-visual",
      },
    ]);
    expect(checkpoint.assets).toEqual([{
      id: "external-link-visual",
      digestSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      mediaType: "image/svg+xml",
      representation: "image",
    }]);
    expect(detail.checkpoint()).toEqual(checkpoint);
  });

  it("binds graph controls to exact stable action provenance", () => {
    const source = new NodeObject("box", "Source", "Legacy fallback", "concept", "source-node");
    const layer = new LayerObject(
      [source],
      [],
      new LayerLayoutObject([new NodePlacementObject(source, 0.5, 0.5)]),
      "source-layer",
    );
    const target = new LayerObject([], [], new LayerLayoutObject([]), "target-layer");
    const actions = {
      expand: { kind: "navigate", relation: "expand", label: "Expand", sourceLayer: layer, target, clientKey: "expand-action" },
      reference: { kind: "navigate", relation: "reference", label: "Reference", sourceLayer: layer, target, clientKey: "reference-action" },
      invoke: { kind: "invoke", label: "Investigate", interactionText: "Investigate this", sourceLayer: layer, clientKey: "invoke-action" },
      input: { kind: "input", label: "Choose", control: "single_select", prompt: "Choose one", options: [{ key: "a", label: "A" }], sourceLayer: layer, clientKey: "input-action" },
    } satisfies Record<string, ActionObject>;

    const detail = new NodeDetailAuthoring();
    detail.setComponent("controls", html`
      <button gc=${detailCapability.expand("expand", source, actions.expand)}>Expand</button>
      <button gc=${detailCapability.reference("reference", source, actions.reference)}>Reference</button>
      <button gc=${detailCapability.invoke("invoke", source, actions.invoke)}>Investigate</button>
      <select gc=${detailCapability.input("input", source, actions.input)} aria-label="Choose one"></select>
    `);

    expect(detail.checkpoint().mounts.map((mount) => mount.kind === "capability" ? mount.capability : mount)).toEqual([
      { kind: "expand", action: { clientKey: "expand-action", sourceNode: { clientKey: "source-node" }, sourceLayer: { clientKey: "source-layer" } } },
      { kind: "reference", action: { clientKey: "reference-action", sourceNode: { clientKey: "source-node" }, sourceLayer: { clientKey: "source-layer" } } },
      { kind: "invoke", action: { clientKey: "invoke-action", sourceNode: { clientKey: "source-node" }, sourceLayer: { clientKey: "source-layer" } } },
      { kind: "input", action: { clientKey: "input-action", sourceNode: { clientKey: "source-node" }, sourceLayer: { clientKey: "source-layer" } } },
    ]);
  });

  it("reports incompatible native hosts at the authored component source", () => {
    const source = new NodeObject("box", "Source", "Fallback", "concept", "source");
    const layer = new LayerObject([source], [], new LayerLayoutObject([new NodePlacementObject(source, 0.5, 0.5)]), "layer");
    const input = { kind: "input", label: "Choose", control: "single_select", prompt: "Choose", options: [{ key: "a", label: "A" }], sourceLayer: layer, clientKey: "choose" } satisfies ActionObject;
    const detail = new NodeDetailAuthoring();
    detail.setComponent("bad-hosts", html`
      <button gc=${detailCapability.externalLink("docs", "https://docs.example.com")}>Docs</button>
      <textarea gc=${detailCapability.input("choose", source, input)} aria-label="Choose"></textarea>
    `);

    expect(() => detail.checkpoint()).toThrowError(expect.objectContaining<Partial<DetailCompilationError>>({
      issues: [
        expect.objectContaining({ code: "capability_host_incompatible", componentId: "bad-hosts", line: 2 }),
        expect.objectContaining({ code: "capability_host_incompatible", componentId: "bad-hosts", line: 3 }),
      ],
    }));
  });

  it("rejects privileged HTML, direct network directives, and unsafe CSS at checkpoint", () => {
    const detail = new NodeDetailAuthoring();
    detail.setComponent("unsafe", html`
      <script>fetch("https://example.com")</script>
      <a href="https://example.com">Direct navigation</a>
      <div style="background: red">Inline style</div>
      <a gc=${detailCapability.externalLink("bad-link", "javascript:alert(1)")}>Bad link</a>
    `, css`@import "https://example.com/theme.css"; .hero { background: url("https://example.com/a.png"); }`);

    expect(() => detail.checkpoint()).toThrowError(expect.objectContaining<Partial<DetailCompilationError>>({
      issues: [
        expect.objectContaining({ code: "unsafe_html_element", componentId: "unsafe", line: 2 }),
        expect.objectContaining({ code: "unsafe_html_attribute", componentId: "unsafe", line: 3 }),
        expect.objectContaining({ code: "unsafe_html_attribute", componentId: "unsafe", line: 4 }),
        expect.objectContaining({ code: "capability_invalid", componentId: "unsafe", line: 5 }),
        expect.objectContaining({ code: "unsafe_css", componentId: "unsafe", path: "css" }),
      ],
    }));
  });

  it("validates asset availability and integrity together with authored accessibility", () => {
    const unavailable = assetRef({
      id: "missing-visual",
      digestSha256: "not-a-sha256",
      mediaType: "image/svg+xml",
      representation: "image",
      available: false,
      sanitized: false,
    });
    const detail = new NodeDetailAuthoring();
    detail.setComponent("asset-errors", html`
      <a gc=${detailCapability.externalLink("empty-link", "https://example.com")}></a>
      <span asset=${unavailable}></span>
    `);

    expect(() => detail.checkpoint()).toThrowError(expect.objectContaining<Partial<DetailCompilationError>>({
      issues: [
        expect.objectContaining({ code: "accessibility_name_required", componentId: "asset-errors", line: 2 }),
        expect.objectContaining({ code: "asset_unavailable", componentId: "asset-errors", line: 3 }),
        expect.objectContaining({ code: "asset_integrity_invalid", componentId: "asset-errors", line: 3 }),
        expect.objectContaining({ code: "asset_representation_unsafe", componentId: "asset-errors", line: 3 }),
        expect.objectContaining({ code: "asset_accessibility_required", componentId: "asset-errors", line: 3 }),
      ],
    }));
  });

  it("reports invalid graph capability declarations at their binding source", () => {
    const source = new NodeObject("box", "Source", "Fallback", "concept", "source");
    const layer = new LayerObject([source], [], new LayerLayoutObject([new NodePlacementObject(source, 0.5, 0.5)]), "layer");
    const action = { kind: "invoke", label: "Investigate", interactionText: "Investigate", sourceLayer: layer } satisfies ActionObject;
    const detail = new NodeDetailAuthoring();
    detail.setComponent("invalid-action", html`
      <button gc=${detailCapability.invoke("investigate", source, action)}>Investigate</button>
    `);

    expect(() => detail.checkpoint()).toThrowError(expect.objectContaining<Partial<DetailCompilationError>>({
      issues: [expect.objectContaining({ code: "capability_invalid", componentId: "invalid-action", line: 2 })],
    }));
  });

  it("finalizes one immutable package and rejects later authoring", () => {
    const detail = new NodeDetailAuthoring();
    detail.setComponent("summary", html`<p>Final detail</p>`);

    const finalized = detail.finalize();

    expect(detail.finalize()).toBe(finalized);
    expect(Object.isFrozen(finalized)).toBe(true);
    expect(Object.isFrozen(finalized.components)).toBe(true);
    expect(Object.isFrozen(finalized.components[0])).toBe(true);
    expect(() => detail.setComponent("late", html`<p>Too late</p>`)).toThrow("finalized");
  });

  it("rejects duplicate authored binding identities instead of emitting colliding mounts", () => {
    const docs = detailCapability.externalLink("docs", "https://example.com/docs");
    const detail = new NodeDetailAuthoring();
    detail.setComponent("duplicate", html`
      <a gc=${docs}>First</a>
      <a gc=${docs}>Second</a>
    `);

    expect(() => detail.checkpoint()).toThrowError(expect.objectContaining<Partial<DetailCompilationError>>({
      issues: [expect.objectContaining({ code: "duplicate_mount_identity", componentId: "duplicate", line: 3 })],
    }));
  });

  it("reports untyped interpolation at its source instead of compiling executable values", () => {
    const detail = new NodeDetailAuthoring();
    detail.setComponent("interpolation", html`
      <p>${"untyped value"}</p>
    `);

    expect(() => detail.checkpoint()).toThrowError(expect.objectContaining<Partial<DetailCompilationError>>({
      issues: [expect.objectContaining({ code: "binding_not_allowed", componentId: "interpolation", line: 2 })],
    }));
  });

  it("requires image assets to bind to explicit native visual hosts", () => {
    const visual = assetRef({
      id: "visual",
      digestSha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      mediaType: "image/png",
      representation: "image",
      available: true,
      sanitized: true,
    });
    const detail = new NodeDetailAuthoring();
    detail.setComponent("bad-asset-host", html`
      <div asset=${visual} aria-hidden="true"></div>
    `);

    expect(() => detail.checkpoint()).toThrowError(expect.objectContaining<Partial<DetailCompilationError>>({
      issues: [expect.objectContaining({ code: "asset_host_incompatible", componentId: "bad-asset-host", line: 2 })],
    }));
  });

  it("requires every component to have a stable authored identity", () => {
    const detail = new NodeDetailAuthoring();
    detail.setComponent(" ", html`<p>Missing identity</p>`);

    expect(() => detail.checkpoint()).toThrowError(expect.objectContaining<Partial<DetailCompilationError>>({
      issues: [expect.objectContaining({ code: "component_identity_invalid", componentId: " ", path: "component" })],
    }));
  });

  it("rejects foreign markup and escaped CSS resource directives", () => {
    const detail = new NodeDetailAuthoring();
    detail.setComponent("escaped", html`<svg><foreignObject><p>Escape</p></foreignObject></svg>`, css`.hero { background: u\\72l("https://example.com/a.png"); }`);

    expect(() => detail.checkpoint()).toThrowError(expect.objectContaining<Partial<DetailCompilationError>>({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "unsafe_html_element", componentId: "escaped" }),
        expect.objectContaining({ code: "unsafe_css", componentId: "escaped" }),
      ]),
    }));
  });

  it("rejects conflicting pinned content for one logical asset identity", () => {
    const first = assetRef({ id: "shared", digestSha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", mediaType: "image/png", representation: "image", available: true, sanitized: true });
    const changed = assetRef({ id: "shared", digestSha256: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd", mediaType: "image/png", representation: "image", available: true, sanitized: true });
    const detail = new NodeDetailAuthoring();
    detail.setComponent("first", html`<span asset=${first} aria-hidden="true"></span>`);
    detail.setComponent("second", html`<span asset=${changed} aria-hidden="true"></span>`);

    expect(() => detail.checkpoint()).toThrowError(expect.objectContaining<Partial<DetailCompilationError>>({
      issues: [expect.objectContaining({ code: "asset_identity_conflict", componentId: "second" })],
    }));
  });

  it("rejects literal authoring directives and caller-forged runtime mounts", () => {
    const detail = new NodeDetailAuthoring();
    detail.setComponent("forged", html`
      <a gc="raw">Raw directive</a>
      <span data-asset-mount="m_forged" aria-hidden="true"></span>
    `);

    expect(() => detail.checkpoint()).toThrowError(expect.objectContaining<Partial<DetailCompilationError>>({
      issues: [
        expect.objectContaining({ code: "reserved_binding_attribute", componentId: "forged", line: 2 }),
        expect.objectContaining({ code: "reserved_binding_attribute", componentId: "forged", line: 3 }),
      ],
    }));
  });

  it("reports malformed CSS through the checkpoint issue contract", () => {
    const detail = new NodeDetailAuthoring();
    detail.setComponent("bad-css", html`<p>Styled content</p>`, css`.card { color: red;`);

    expect(() => detail.checkpoint()).toThrowError(expect.objectContaining<Partial<DetailCompilationError>>({
      issues: [expect.objectContaining({ code: "invalid_css", componentId: "bad-css", path: "css" })],
    }));
  });

  it("rejects native input variants that do not match the bound control", () => {
    const source = new NodeObject("box", "Source", "Fallback", "concept", "source");
    const layer = new LayerObject([source], [], new LayerLayoutObject([new NodePlacementObject(source, 0.5, 0.5)]), "layer");
    const text = { kind: "input", label: "Explain", control: "text", prompt: "Explain", sourceLayer: layer, clientKey: "text" } satisfies ActionObject;
    const multi = { kind: "input", label: "Choose", control: "multi_select", prompt: "Choose", options: [{ key: "a", label: "A" }], sourceLayer: layer, clientKey: "multi" } satisfies ActionObject;
    const detail = new NodeDetailAuthoring();
    detail.setComponent("input-hosts", html`
      <input gc=${detailCapability.input("text", source, text)} type="file" aria-label="Explain">
      <select gc=${detailCapability.input("multi", source, multi)} aria-label="Choose"></select>
    `);

    expect(() => detail.checkpoint()).toThrowError(expect.objectContaining<Partial<DetailCompilationError>>({
      issues: [
        expect.objectContaining({ code: "capability_host_incompatible", componentId: "input-hosts", line: 2 }),
        expect.objectContaining({ code: "capability_host_incompatible", componentId: "input-hosts", line: 3 }),
      ],
    }));
  });

  it("rejects auxiliary network attributes even on a typed link host", () => {
    const detail = new NodeDetailAuthoring();
    detail.setComponent("link-policy", html`
      <a gc=${detailCapability.externalLink("docs", "https://example.com/docs")} ping="https://tracker.example.com">Docs</a>
    `);

    expect(() => detail.checkpoint()).toThrowError(expect.objectContaining<Partial<DetailCompilationError>>({
      issues: [expect.objectContaining({ code: "unsafe_html_attribute", componentId: "link-policy", line: 2 })],
    }));
  });
});
