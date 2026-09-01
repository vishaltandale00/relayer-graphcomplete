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
  DETAIL_AUTHORING_LIMITS,
  detailCapability,
  html,
  type ActionObject,
  type DetailAssetResolver,
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

  it("orders canonical HTML attributes by code point rather than host locale", () => {
    const detail = new NodeDetailAuthoring();
    detail.setComponent("attributes", html`<div title="Title" role="note" id="identity" class="card" aria-label="Label">Content</div>`);

    expect(detail.checkpoint().components[0]?.html).toBe(
      `<div aria-label="Label" class="card" id="identity" role="note" title="Title">Content</div>`,
    );
  });

  it("compiles an external-link capability and independent visual into opaque native-host mounts", () => {
    const resolver: DetailAssetResolver = {
      resolve(reference) {
        return {
          logicalId: reference.logicalId,
          authority: "current",
          availability: "available",
          digestSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          mediaType: "image/svg+xml",
          representation: { kind: "image", sanitized: true },
        };
      },
    };
    const detail = new NodeDetailAuthoring(resolver);
    const documentation = detailCapability.externalLink("documentation", "https://docs.example.com/guide");
    const externalLinkVisual = assetRef("external-link-visual");

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
      css: ".documentation-link{display:inline-flex;gap:0.5rem}",
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
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "capability_host_incompatible", componentId: "bad-hosts", line: 2 }),
        expect.objectContaining({ code: "capability_host_incompatible", componentId: "bad-hosts", line: 3 }),
      ]),
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
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "unsafe_html_element", componentId: "unsafe", line: 2 }),
        expect.objectContaining({ code: "unsafe_html_attribute", componentId: "unsafe", line: 3 }),
        expect.objectContaining({ code: "unsafe_html_attribute", componentId: "unsafe", line: 4 }),
        expect.objectContaining({ code: "capability_invalid", componentId: "unsafe", line: 5 }),
        expect.objectContaining({ code: "unsafe_css", componentId: "unsafe", path: "css:1:1" }),
      ]),
    }));
  });

  it("validates asset availability and integrity together with authored accessibility", () => {
    const unavailable = assetRef("missing-visual");
    const detail = new NodeDetailAuthoring({
      resolve: () => ({
        logicalId: "missing-visual",
        authority: "current",
        availability: "unavailable",
        digestSha256: "not-a-sha256",
        mediaType: "image/svg+xml",
        representation: { kind: "image", sanitized: false },
      }),
    });
    detail.setComponent("asset-errors", html`
      <a gc=${detailCapability.externalLink("empty-link", "https://example.com")}></a>
      <span asset=${unavailable}></span>
    `);

    expect(() => detail.checkpoint()).toThrowError(expect.objectContaining<Partial<DetailCompilationError>>({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "accessibility_name_required", componentId: "asset-errors", line: 2 }),
        expect.objectContaining({ code: "asset_unavailable", componentId: "asset-errors", line: 3 }),
        expect.objectContaining({ code: "asset_integrity_invalid", componentId: "asset-errors", line: 3 }),
        expect.objectContaining({ code: "asset_representation_unsafe", componentId: "asset-errors", line: 3 }),
        expect.objectContaining({ code: "asset_accessibility_required", componentId: "asset-errors", line: 3 }),
      ]),
    }));
  });

  it("rejects unknown, mismatched, unavailable, revoked, and unsafe resolver checkpoints", () => {
    const digest = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const resolver: DetailAssetResolver = {
      resolve(reference) {
        if (reference.logicalId === "unknown") return undefined;
        return {
          logicalId: reference.logicalId === "mismatch" ? "different" : reference.logicalId,
          authority: reference.logicalId === "stale" ? "stale" : "current",
          availability: reference.logicalId === "unavailable" ? "unavailable" : reference.logicalId === "revoked" ? "revoked" : "available",
          digestSha256: digest,
          mediaType: reference.logicalId === "unsafe" ? "image/tiff" : "image/png",
          representation: { kind: "image", sanitized: reference.logicalId !== "unsafe" },
        };
      },
    };
    const detail = new NodeDetailAuthoring(resolver);
    detail.setComponent("resolver-errors", html`
      <span asset=${assetRef("unknown")} aria-hidden="true"></span>
      <span asset=${assetRef("mismatch")} aria-hidden="true"></span>
      <span asset=${assetRef("stale")} aria-hidden="true"></span>
      <span asset=${assetRef("unavailable")} aria-hidden="true"></span>
      <span asset=${assetRef("revoked")} aria-hidden="true"></span>
      <span asset=${assetRef("unsafe")} aria-hidden="true"></span>
    `);

    expect(() => detail.checkpoint()).toThrowError(expect.objectContaining<Partial<DetailCompilationError>>({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "asset_unknown", line: 2 }),
        expect.objectContaining({ code: "asset_authority_mismatch", line: 3 }),
        expect.objectContaining({ code: "asset_authority_mismatch", line: 4 }),
        expect.objectContaining({ code: "asset_unavailable", line: 5 }),
        expect.objectContaining({ code: "asset_unavailable", line: 6 }),
        expect.objectContaining({ code: "asset_representation_unsafe", line: 7 }),
      ]),
    }));
  });

  it("does not accept caller-supplied availability, digest, or sanitization as an asset reference", () => {
    expect(() => assetRef({
      id: "forged",
      available: true,
      sanitized: true,
      digestSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    } as never)).toThrow("opaque logical asset identity string");
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
      issues: expect.arrayContaining([expect.objectContaining({ code: "binding_not_allowed", componentId: "interpolation", line: 2 })]),
    }));
  });

  it("accepts interpolations only as one unquoted opening-tag gc or asset attribute", () => {
    const docs = detailCapability.externalLink("docs", "https://example.com");
    const quoted = new NodeDetailAuthoring();
    quoted.setComponent("quoted", html`<a title="gc=${docs}">Docs</a>`);
    const text = new NodeDetailAuthoring();
    text.setComponent("text", html`<p>gc=${docs}</p>`);
    const literal = new NodeDetailAuthoring();
    literal.setComponent("literal", html`<a gc="${"docs"}">Docs</a>`);

    for (const authoring of [quoted, text, literal]) {
      expect(() => authoring.checkpoint()).toThrowError(expect.objectContaining<Partial<DetailCompilationError>>({
        issues: expect.arrayContaining([expect.objectContaining({ code: "binding_not_allowed" })]),
      }));
    }
  });

  it("requires every typed interpolation to be consumed by exactly one runtime host", () => {
    const detail = new NodeDetailAuthoring();
    detail.setComponent("double-binding", html`
      <a gc=${detailCapability.externalLink("first", "https://example.com/first")} gc=${detailCapability.externalLink("second", "https://example.com/second")}>Docs</a>
    `);

    expect(() => detail.checkpoint()).toThrowError(expect.objectContaining<Partial<DetailCompilationError>>({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "binding_consumption_invalid", componentId: "double-binding" }),
      ]),
    }));
  });

  it("requires image assets to bind to explicit native visual hosts", () => {
    const visual = assetRef("visual");
    const detail = new NodeDetailAuthoring({
      resolve: () => ({
        logicalId: "visual",
        authority: "current",
        availability: "available",
        digestSha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        mediaType: "image/png",
        representation: { kind: "image", sanitized: true },
      }),
    });
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
    detail.setComponent("escaped", html`<svg><foreignObject><p>Escape</p></foreignObject></svg>`, css`.hero { background: \75rl("https://example.com/a.png"); }`);

    expect(() => detail.checkpoint()).toThrowError(expect.objectContaining<Partial<DetailCompilationError>>({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "unsafe_html_element", componentId: "escaped" }),
        expect.objectContaining({ code: "unsafe_css", componentId: "escaped" }),
      ]),
    }));
  });

  it("rejects conflicting pinned content for one logical asset identity", () => {
    const first = assetRef("shared");
    const changed = assetRef("shared");
    let resolution = 0;
    const detail = new NodeDetailAuthoring({
      resolve: () => ({
        logicalId: "shared",
        authority: "current",
        availability: "available",
        digestSha256: resolution++ === 0
          ? "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
          : "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        mediaType: "image/png",
        representation: { kind: "image", sanitized: true },
      }),
    });
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
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "reserved_binding_attribute", componentId: "forged", line: 2 }),
        expect.objectContaining({ code: "reserved_binding_attribute", componentId: "forged", line: 3 }),
      ]),
    }));
  });

  it("reports malformed CSS through the checkpoint issue contract", () => {
    const detail = new NodeDetailAuthoring();
    detail.setComponent("bad-css", html`<p>Styled content</p>`, css`.card { color: red;`);

    expect(() => detail.checkpoint()).toThrowError(expect.objectContaining<Partial<DetailCompilationError>>({
      issues: expect.arrayContaining([expect.objectContaining({ code: "invalid_css", componentId: "bad-css" })]),
    }));
  });

  it("accepts ordinary spatial CSS and escaped identifiers through token parsing", () => {
    const detail = new NodeDetailAuthoring();
    detail.setComponent("spatial-css", html`<section class="grid:wide"><p>Layout</p></section>`, css`
      .grid\:wide {
        display: grid;
        grid-template-columns: minmax(12rem, 1fr) 2fr;
        gap: clamp(0.5rem, 2vw, 2rem);
        color: \72 ed;
      }
    `);

    expect(detail.checkpoint().components[0]?.css).toContain("grid-template-columns:minmax(12rem,1fr) 2fr");
  });

  it("rejects CSS external-resource and host API tokens at precise multiline locations", () => {
    const detail = new NodeDetailAuthoring();
    detail.setComponent("unsafe-css-ast", html`<section>Unsafe styles</section>`, css`
      .remote {
        background: image-set("https://example.com/a.png" 1x);
      }
      .worklet {
        background: paint(detail-art);
      }
      .cursor {
        cursor: url("https://example.com/cursor.cur"), auto;
      }
    `);

    expect(() => detail.checkpoint()).toThrowError(expect.objectContaining<Partial<DetailCompilationError>>({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "unsafe_css", componentId: "unsafe-css-ast", path: "css:2:21", line: 2, column: 21 }),
        expect.objectContaining({ code: "unsafe_css", componentId: "unsafe-css-ast", path: "css:5:21", line: 5, column: 21 }),
        expect.objectContaining({ code: "unsafe_css", componentId: "unsafe-css-ast", path: "css:8:17", line: 8, column: 17 }),
      ]),
    }));
  });

  it("checks decoded browser entity semantics for accessible names", () => {
    const detail = new NodeDetailAuthoring();
    detail.setComponent("encoded-names", html`
      <a gc=${detailCapability.externalLink("body", "https://example.com")}>&#32;&nbsp;</a>
      <a gc=${detailCapability.externalLink("label", "https://example.com")} aria-label="&#x20;&#32;"></a>
    `);

    expect(() => detail.checkpoint()).toThrowError(expect.objectContaining<Partial<DetailCompilationError>>({
      issues: [
        expect.objectContaining({ code: "accessibility_name_required", componentId: "encoded-names", line: 2 }),
        expect.objectContaining({ code: "accessibility_name_required", componentId: "encoded-names", line: 3 }),
      ],
    }));
  });

  it("returns typed limit errors for excessive bytes, elements, and depth without overflowing", () => {
    const overBytes = new NodeDetailAuthoring();
    overBytes.setComponent("bytes", htmlSource("x".repeat(DETAIL_AUTHORING_LIMITS.maxHtmlBytesPerComponent + 1)));
    const overElements = new NodeDetailAuthoring();
    overElements.setComponent("elements", htmlSource("<span></span>".repeat(DETAIL_AUTHORING_LIMITS.maxElementsPerComponent + 1)));
    const overDepth = new NodeDetailAuthoring();
    overDepth.setComponent("depth", htmlSource(
      "<div>".repeat(DETAIL_AUTHORING_LIMITS.maxElementDepth + 1)
      + "content"
      + "</div>".repeat(DETAIL_AUTHORING_LIMITS.maxElementDepth + 1),
    ));
    const overCss = new NodeDetailAuthoring();
    overCss.setComponent("css-bytes", html`<p>CSS</p>`, cssSource(".x{}".repeat(Math.ceil((DETAIL_AUTHORING_LIMITS.maxCssBytesPerComponent + 1) / 4))));

    for (const [authoring, code] of [
      [overBytes, "html_byte_limit_exceeded"],
      [overElements, "html_element_limit_exceeded"],
      [overDepth, "html_depth_limit_exceeded"],
      [overCss, "css_byte_limit_exceeded"],
    ] as const) {
      expect(() => authoring.checkpoint()).toThrowError(expect.objectContaining<Partial<DetailCompilationError>>({
        issues: expect.arrayContaining([expect.objectContaining({ code })]),
      }));
    }
  });

  it("uses browser fragment semantics for tables, paragraphs, interactive hosts, and raw text", () => {
    const detail = new NodeDetailAuthoring();
    detail.setComponent("browser-html", html`<table><tr><td>A</td></tr></table><p>One<div>Two</div><button gc=${detailCapability.externalLink("bad-host", "https://example.com")}>Run</button><pre><code>&lt;tag&gt;&amp;text</code></pre>`);

    expect(() => detail.checkpoint()).toThrowError(expect.objectContaining<Partial<DetailCompilationError>>({
      issues: [expect.objectContaining({ code: "capability_host_incompatible", componentId: "browser-html" })],
    }));
    detail.setComponent("browser-html", html`<table><tr><td>A</td></tr></table><p>One<div>Two</div><a gc=${detailCapability.externalLink("link", "https://example.com")}>Run</a><pre><code>&lt;tag&gt;&amp;text</code></pre>`);
    expect(detail.checkpoint().components[0]?.html).toBe(
      `<table><tbody><tr><td>A</td></tr></tbody></table><p>One</p><div>Two</div><a data-gc-mount="m_4cf8c9758617fc0e">Run</a><pre><code>&lt;tag&gt;&amp;text</code></pre>`,
    );
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
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "capability_host_incompatible", componentId: "input-hosts", line: 2 }),
      ]),
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

  it("uses a fail-closed HTML allowlist for elements, attributes, projection, and runtime state", () => {
    const detail = new NodeDetailAuthoring();
    detail.setComponent("allowlist", html`
      <product-card>Host code</product-card>
      <button is="product-action">Customized built-in</button>
      <slot name="projected"></slot>
      <div navigate-to="https://example.com" data-command="open">Custom bridge</div>
      <input value="spoofed" disabled>
    `);

    expect(() => detail.checkpoint()).toThrowError(expect.objectContaining<Partial<DetailCompilationError>>({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "unsafe_html_element", componentId: "allowlist", line: 2 }),
        expect.objectContaining({ code: "unsafe_html_attribute", componentId: "allowlist", line: 3 }),
        expect.objectContaining({ code: "unsafe_html_element", componentId: "allowlist", line: 4 }),
        expect.objectContaining({ code: "unsafe_html_attribute", componentId: "allowlist", line: 5 }),
        expect.objectContaining({ code: "runtime_state_attribute", componentId: "allowlist", line: 6 }),
      ]),
    }));
  });

  it("rejects unbound interactive elements that could imitate runtime controls", () => {
    const detail = new NodeDetailAuthoring();
    detail.setComponent("unbound-controls", html`
      <a>Link-like text</a>
      <button>Fake action</button>
      <input type="text" aria-label="Fake input">
      <select aria-label="Fake selection"></select>
    `);

    expect(() => detail.checkpoint()).toThrowError(expect.objectContaining<Partial<DetailCompilationError>>({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "interactive_host_requires_capability", line: 2 }),
        expect.objectContaining({ code: "interactive_host_requires_capability", line: 3 }),
        expect.objectContaining({ code: "interactive_host_requires_capability", line: 4 }),
        expect.objectContaining({ code: "interactive_host_requires_capability", line: 5 }),
      ]),
    }));
  });

  it("prevents authored link, action, and input state from spoofing typed capability behavior", () => {
    const source = new NodeObject("box", "Source", "Fallback", "concept", "source");
    const layer = new LayerObject([source], [], new LayerLayoutObject([new NodePlacementObject(source, 0.5, 0.5)]), "layer");
    const text = { kind: "input", label: "Explain", control: "text", prompt: "Explain", sourceLayer: layer, clientKey: "text" } satisfies ActionObject;
    const single = { kind: "input", label: "Choose", control: "single_select", prompt: "Choose", options: [{ key: "a", label: "A" }], sourceLayer: layer, clientKey: "single" } satisfies ActionObject;
    const invoke = { kind: "invoke", label: "Run", interactionText: "Run", sourceLayer: layer, clientKey: "invoke" } satisfies ActionObject;
    const detail = new NodeDetailAuthoring();
    detail.setComponent("spoofed-state", html`
      <a gc=${detailCapability.externalLink("docs", "https://example.com")} target="_self" download>Docs</a>
      <button gc=${detailCapability.invoke("run", source, invoke)} disabled value="forged">Run</button>
      <input gc=${detailCapability.input("text", source, text)} value="forged" disabled aria-label="Explain">
      <select gc=${detailCapability.input("single", source, single)} aria-label="Choose"><option selected value="forged">Forged</option></select>
    `);

    expect(() => detail.checkpoint()).toThrowError(expect.objectContaining<Partial<DetailCompilationError>>({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "runtime_state_attribute", componentId: "spoofed-state", line: 2 }),
        expect.objectContaining({ code: "runtime_state_attribute", componentId: "spoofed-state", line: 3 }),
        expect.objectContaining({ code: "runtime_state_attribute", componentId: "spoofed-state", line: 4 }),
        expect.objectContaining({ code: "runtime_controlled_children", componentId: "spoofed-state", line: 5 }),
      ]),
    }));
  });

  it("normalizes native input host state from each typed input declaration", () => {
    const source = new NodeObject("box", "Source", "Fallback", "concept", "source");
    const layer = new LayerObject([source], [], new LayerLayoutObject([new NodePlacementObject(source, 0.5, 0.5)]), "layer");
    const text = { kind: "input", label: "Explain", control: "text", prompt: "Explain", sourceLayer: layer, clientKey: "text-normalized" } satisfies ActionObject;
    const single = { kind: "input", label: "Choose", control: "single_select", prompt: "Choose", options: [{ key: "a", label: "A" }], sourceLayer: layer, clientKey: "single-normalized" } satisfies ActionObject;
    const multi = { kind: "input", label: "Signals", control: "multi_select", prompt: "Signals", options: [{ key: "a", label: "A" }], sourceLayer: layer, clientKey: "multi-normalized" } satisfies ActionObject;
    const detail = new NodeDetailAuthoring();
    detail.setComponent("normalized-inputs", html`
      <input gc=${detailCapability.input("text", source, text)} aria-label="Explain">
      <select gc=${detailCapability.input("single", source, single)} multiple aria-label="Choose"></select>
      <select gc=${detailCapability.input("multi", source, multi)} aria-label="Signals"></select>
    `);

    const compiled = detail.checkpoint().components[0]?.html ?? "";
    expect(compiled).toMatch(/<input aria-label="Explain" data-gc-mount="[^"]+" type="text">/);
    expect(compiled).toMatch(/<select aria-label="Choose" data-gc-mount="[^"]+"><\/select>/);
    expect(compiled).toMatch(/<select aria-label="Signals" data-gc-mount="[^"]+" multiple=""><\/select>/);
  });
});

function htmlSource(source: string) {
  const strings = Object.assign([source], { raw: [source] }) as unknown as TemplateStringsArray;
  return html(strings);
}

function cssSource(source: string) {
  const strings = Object.assign([source], { raw: [source] }) as unknown as TemplateStringsArray;
  return css(strings);
}
