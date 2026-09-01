import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LayerLayoutObject,
  LayerObject,
  NodeDetailAuthoring,
  NodeObject,
  NodePlacementObject,
  RelayerGraphClient,
  assetRef,
  css,
  DetailCompilationError,
  DETAIL_AUTHORING_LIMITS,
  detailCapability,
  html,
  type ActionObject,
  type InputActionObject,
} from "../src/index.js";

describe("typed Node Detail authoring compiler", () => {
  afterEach(() => vi.unstubAllGlobals());

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

  it("rejects malformed authored DOM identities at their source elements", () => {
    const detail = new NodeDetailAuthoring();
    detail.setComponent("invalid-dom-ids", htmlSource(`
      <span id=" leading">Whitespace</span>
      <span id="${"x".repeat(129)}">Oversized</span>
      <span id="nul${String.fromCharCode(0)}identity">NUL</span>
      <span id="">Empty</span>
    `));

    expect(() => detail.checkpoint()).toThrowError(expect.objectContaining<Partial<DetailCompilationError>>({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "dom_id_invalid", componentId: "invalid-dom-ids", line: 2 }),
        expect.objectContaining({ code: "dom_id_invalid", componentId: "invalid-dom-ids", line: 3 }),
        expect.objectContaining({ code: "dom_id_invalid", componentId: "invalid-dom-ids", line: 4 }),
        expect.objectContaining({ code: "dom_id_invalid", componentId: "invalid-dom-ids", line: 5 }),
      ]),
    }));
  });

  it("rejects package-wide DOM id collisions and prevents aria-labelledby from using them", () => {
    const detail = new NodeDetailAuthoring();
    detail.setComponent("first-label", html`<span id="shared-label">First label</span>`);
    detail.setComponent("second-label", html`<span id="shared-label">Second label</span>`);
    detail.setComponent("labelled-link", html`
      <a gc=${detailCapability.externalLink("docs", "https://example.com/docs")} aria-labelledby="shared-label"><span aria-hidden="true">↗</span></a>
    `);

    expect(() => detail.checkpoint()).toThrowError(expect.objectContaining<Partial<DetailCompilationError>>({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "dom_id_duplicate", componentId: "second-label", line: 1 }),
        expect.objectContaining({ code: "accessibility_name_required", componentId: "labelled-link", line: 2 }),
      ]),
    }));
  });

  it("compiles an external-link capability and host-resolved visual into opaque native-host mounts", async () => {
    const node = new NodeObject("box", "Documentation", "Fallback", "concept", "documentation-node");
    const detail = node.detailAuthoring;
    const documentation = detailCapability.externalLink("documentation", "https://docs.example.com/guide");
    const externalLinkVisual = assetRef("external-link-visual");

    detail.setComponent("documentation", html`
      <a gc=${documentation} class="documentation-link">
        <span asset=${externalLinkVisual} class="documentation-link__icon" aria-hidden="true"></span>
        Documentation
      </a>
    `, css`.documentation-link { display: inline-flex; gap: 0.5rem; }`);

    const checkpoint = await checkpointWithHostAssets(node, [{
      logicalId: "external-link-visual",
      authority: "current",
      availability: "available",
      digestSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      mediaType: "image/svg+xml",
      representation: { kind: "image", sanitized: true },
    }]);
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
    expect(await checkpointWithHostAssets(node, [{
      logicalId: "external-link-visual",
      authority: "current",
      availability: "available",
      digestSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      mediaType: "image/svg+xml",
      representation: { kind: "image", sanitized: true },
    }])).toEqual(checkpoint);
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

    const detail = source.detailAuthoring;
    detail.setComponent("controls", html`
      <button gc=${detailCapability.expand("expand", actions.expand)}>Expand</button>
      <button gc=${detailCapability.reference("reference", actions.reference)}>Reference</button>
      <button gc=${detailCapability.invoke("invoke", actions.invoke)}>Investigate</button>
      <select gc=${detailCapability.input("input", actions.input)} aria-label="Choose one"></select>
    `);

    expect(detail.checkpoint().mounts.map((mount) => mount.kind === "capability" ? mount.capability : mount)).toEqual([
      { kind: "expand", action: { clientKey: "expand-action", sourceNode: { clientKey: "source-node" }, sourceLayer: { clientKey: "source-layer" } } },
      { kind: "reference", action: { clientKey: "reference-action", sourceNode: { clientKey: "source-node" }, sourceLayer: { clientKey: "source-layer" } } },
      { kind: "invoke", action: { clientKey: "invoke-action", sourceNode: { clientKey: "source-node" }, sourceLayer: { clientKey: "source-layer" } } },
      { kind: "input", action: { clientKey: "input-action", sourceNode: { clientKey: "source-node" }, sourceLayer: { clientKey: "source-layer" } } },
    ]);
  });

  it("derives graph action source provenance only from the NodeObject that owns the detail", () => {
    const owner = new NodeObject("box", "Owner", "Fallback", "concept", "owner-node");
    const layer = new LayerObject(
      [owner],
      [],
      new LayerLayoutObject([new NodePlacementObject(owner, 0.5, 0.5)]),
      "owner-layer",
    );
    const action = {
      kind: "invoke",
      label: "Investigate",
      interactionText: "Investigate this",
      sourceLayer: layer,
      clientKey: "owned-action",
    } satisfies ActionObject;
    owner.detailAuthoring.setComponent("owned-action", html`
      <button gc=${detailCapability.invoke("investigate", action)}>Investigate</button>
    `);

    expect(owner.detailAuthoring.checkpoint().mounts).toEqual([
      expect.objectContaining({
        capability: {
          kind: "invoke",
          action: {
            clientKey: "owned-action",
            sourceNode: { clientKey: "owner-node" },
            sourceLayer: { clientKey: "owner-layer" },
          },
        },
      }),
    ]);
  });

  it("rejects a one-megabyte action identity before compiling provenance", async () => {
    const owner = new NodeObject("box", "Owner", "Fallback", "concept", "owner-node");
    const layer = new LayerObject([owner], [], new LayerLayoutObject([]), "owner-layer");
    const action = {
      kind: "invoke",
      label: "Investigate",
      interactionText: "Investigate this",
      sourceLayer: layer,
      clientKey: "x".repeat(1024 * 1024),
    } satisfies ActionObject;
    owner.detailAuthoring.setComponent("oversized-action", html`
      <button gc=${detailCapability.invoke("investigate", action)}>Investigate</button>
    `);

    await expect(checkpointWithHostAssets(owner, [])).rejects.toThrowError(expect.objectContaining<Partial<DetailCompilationError>>({
      issues: [expect.objectContaining({ code: "capability_invalid", componentId: "oversized-action" })],
    }));
  });

  it("bounds every emitted graph provenance identity", async () => {
    const invalidCases = [
      {
        ownerKey: "x".repeat(129),
        layerKey: "layer",
        actionKey: "action",
        mountKey: "mount",
      },
      {
        ownerKey: "owner",
        layerKey: "é".repeat(65),
        actionKey: "action",
        mountKey: "mount",
      },
      {
        ownerKey: "owner",
        layerKey: "layer",
        actionKey: "action",
        mountKey: `mount\0spoof`,
      },
    ];

    for (const [index, invalid] of invalidCases.entries()) {
      const owner = new NodeObject("box", "Owner", "Fallback", "concept", invalid.ownerKey);
      const layer = new LayerObject([owner], [], new LayerLayoutObject([]), invalid.layerKey);
      const action = {
        kind: "invoke",
        label: "Investigate",
        interactionText: "Investigate this",
        sourceLayer: layer,
        clientKey: invalid.actionKey,
      } satisfies ActionObject;
      owner.detailAuthoring.setComponent(`invalid-provenance-${index}`, html`
        <button gc=${detailCapability.invoke(invalid.mountKey, action)}>Investigate</button>
      `);

      await expect(checkpointWithHostAssets(owner, [])).rejects.toThrowError(expect.objectContaining<Partial<DetailCompilationError>>({
        issues: [expect.objectContaining({ code: "capability_invalid", componentId: `invalid-provenance-${index}` })],
      }));
    }
  });

  it("bounds component, mount, and total compiled package size", () => {
    const excessiveComponents = new NodeDetailAuthoring();
    for (let index = 0; index <= DETAIL_AUTHORING_LIMITS.maxComponents; index += 1) {
      excessiveComponents.setComponent(`component-${index}`, html`<p>Bounded</p>`);
    }
    expect(() => excessiveComponents.checkpoint()).toThrowError(expect.objectContaining<Partial<DetailCompilationError>>({
      issues: expect.arrayContaining([expect.objectContaining({ code: "component_limit_exceeded" })]),
    }));

    const excessiveMounts = new NodeDetailAuthoring();
    for (let index = 0; index < 43; index += 1) {
      excessiveMounts.setComponent(`mounts-${index}`, html`
        <a gc=${detailCapability.externalLink(`a-${index}`, "https://example.com/a")}>A</a>
        <a gc=${detailCapability.externalLink(`b-${index}`, "https://example.com/b")}>B</a>
        <a gc=${detailCapability.externalLink(`c-${index}`, "https://example.com/c")}>C</a>
      `);
    }
    expect(() => excessiveMounts.checkpoint()).toThrowError(expect.objectContaining<Partial<DetailCompilationError>>({
      issues: [expect.objectContaining({ code: "mount_limit_exceeded" })],
    }));

    const excessiveBytes = new NodeDetailAuthoring();
    for (let index = 0; index < 3; index += 1) {
      excessiveBytes.setComponent(`large-${index}`, htmlSource(`<section>${"x".repeat(200_000)}</section>`));
    }
    expect(() => excessiveBytes.checkpoint()).toThrowError(expect.objectContaining<Partial<DetailCompilationError>>({
      issues: [expect.objectContaining({ code: "compiled_package_byte_limit_exceeded" })],
    }));
  });

  it("mirrors graph-core select option invariants at each input binding source", () => {
    const owner = new NodeObject("box", "Inputs", "Fallback", "concept", "input-owner");
    const layer = new LayerObject([owner], [], new LayerLayoutObject([new NodePlacementObject(owner, 0.5, 0.5)]), "input-layer");
    const input = (clientKey: string, options: readonly { readonly key: string; readonly label: string }[]): InputActionObject => ({
      kind: "input",
      label: "Choose",
      control: "single_select",
      prompt: "Choose one",
      options,
      sourceLayer: layer,
      clientKey,
    });
    owner.detailAuthoring.setComponent("invalid-options", html`
      <select gc=${detailCapability.input("blank", input("blank", [{ key: " ", label: " " }]))} aria-label="Blank"></select>
      <select gc=${detailCapability.input("duplicate", input("duplicate", [{ key: "same", label: "One" }, { key: "same", label: "Two" }]))} aria-label="Duplicate"></select>
      <select gc=${detailCapability.input("count", input("count", Array.from({ length: 51 }, (_, index) => ({ key: `k${index}`, label: `Option ${index}` }))))} aria-label="Count"></select>
      <select gc=${detailCapability.input("oversize", input("oversize", [{ key: "é".repeat(65), label: "é".repeat(257) }]))} aria-label="Oversize"></select>
    `);

    expect(() => owner.detailAuthoring.checkpoint()).toThrowError(expect.objectContaining<Partial<DetailCompilationError>>({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "input_action_option_key_invalid", componentId: "invalid-options", line: 2 }),
        expect.objectContaining({ code: "input_action_option_label_required", componentId: "invalid-options", line: 2 }),
        expect.objectContaining({ code: "input_action_option_key_duplicate", componentId: "invalid-options", line: 3 }),
        expect.objectContaining({ code: "input_action_option_count", componentId: "invalid-options", line: 4 }),
        expect.objectContaining({ code: "input_action_option_key_invalid", componentId: "invalid-options", line: 5 }),
        expect.objectContaining({ code: "input_action_option_label_too_long", componentId: "invalid-options", line: 5 }),
      ]),
    }));
  });

  it("turns malformed runtime action shapes into source-local compilation errors", async () => {
    const malformedCases: readonly { readonly key: unknown; readonly action: unknown }[] = [
      { key: 42, action: { kind: "invoke", label: "Run", interactionText: "Run", clientKey: "run" } },
      { key: "label", action: { kind: "invoke", label: null, interactionText: "Run", clientKey: "run" } },
      { key: "control", action: { kind: "input", label: "Choose", control: "toggle", prompt: "Choose", options: [], clientKey: "choose" } },
      { key: "options-object", action: { kind: "input", label: "Choose", control: "single_select", prompt: "Choose", options: {}, clientKey: "choose" } },
      { key: "null-option", action: { kind: "input", label: "Choose", control: "single_select", prompt: "Choose", options: [null], clientKey: "choose" } },
      { key: "typed-option", action: { kind: "input", label: "Choose", control: "single_select", prompt: "Choose", options: [{ key: 7, label: {} }], clientKey: "choose" } },
    ];

    for (const [index, malformed] of malformedCases.entries()) {
      const owner = new NodeObject("box", "Owner", "Fallback", "concept", `malformed-owner-${index}`);
      const layer = new LayerObject([owner], [], new LayerLayoutObject([]), `malformed-layer-${index}`);
      const action = { ...malformed.action as object, sourceLayer: layer };
      const capability = malformed.key === 42
        ? (detailCapability.invoke as unknown as (key: unknown, action: unknown) => ReturnType<typeof detailCapability.invoke>)(malformed.key, action)
        : (detailCapability.input as unknown as (key: unknown, action: unknown) => ReturnType<typeof detailCapability.input>)(malformed.key, action);
      owner.detailAuthoring.setComponent(`malformed-${index}`, html`<button gc=${capability}>Malformed</button>`);

      await expect(checkpointWithHostAssets(owner, [])).rejects.toThrowError(expect.objectContaining<Partial<DetailCompilationError>>({
        issues: expect.arrayContaining([expect.objectContaining({ code: "capability_invalid", componentId: `malformed-${index}` })]),
      }));
    }
  });

  it("rejects a draft action whose source layer does not contain the owning node", async () => {
    const owner = new NodeObject("box", "Owner", "Fallback", "concept", "membership-owner");
    const unrelated = new NodeObject("box", "Unrelated", "Fallback", "concept", "membership-unrelated");
    const unrelatedLayer = new LayerObject([unrelated], [], new LayerLayoutObject([]), "unrelated-layer");
    const action = {
      kind: "invoke",
      label: "Run",
      interactionText: "Run",
      sourceLayer: unrelatedLayer,
      clientKey: "unrelated-action",
    } satisfies ActionObject;
    owner.detailAuthoring.setComponent("unrelated-layer", html`
      <button gc=${detailCapability.invoke("run", action)}>Run</button>
    `);

    await expect(checkpointWithHostAssets(owner, [])).rejects.toThrowError(expect.objectContaining<Partial<DetailCompilationError>>({
      issues: [expect.objectContaining({ code: "capability_source_layer_mismatch", componentId: "unrelated-layer" })],
    }));
  });

  it("does not let a standalone authoring constructor mint source-node provenance", () => {
    const owner = new NodeObject("box", "Owner", "Fallback", "concept", "constructor-owner");
    const layer = new LayerObject([owner], [], new LayerLayoutObject([]), "constructor-layer");
    const action = {
      kind: "invoke",
      label: "Run",
      interactionText: "Run",
      sourceLayer: layer,
      clientKey: "constructor-action",
    } satisfies ActionObject;
    const PublicAuthoring = NodeDetailAuthoring as unknown as new (ownerHint: string) => NodeDetailAuthoring;
    const forged = new PublicAuthoring(owner.clientKey);
    forged.setComponent("constructor-spoof", html`<button gc=${detailCapability.invoke("run", action)}>Run</button>`);

    expect(() => forged.checkpoint()).toThrowError(expect.objectContaining<Partial<DetailCompilationError>>({
      issues: [expect.objectContaining({ code: "capability_invalid", componentId: "constructor-spoof" })],
    }));
  });

  it("rejects a legacy graph capability path that tries to spoof an unrelated source node", () => {
    const owner = new NodeObject("box", "Owner", "Fallback", "concept", "owner-node");
    const unrelated = new NodeObject("box", "Unrelated", "Fallback", "concept", "unrelated-node");
    const layer = new LayerObject([owner], [], new LayerLayoutObject([new NodePlacementObject(owner, 0.5, 0.5)]), "layer");
    const action = { kind: "invoke", label: "Run", interactionText: "Run", sourceLayer: layer, clientKey: "run" } satisfies ActionObject;
    const legacyInvoke = detailCapability.invoke as unknown as (
      key: string,
      sourceNode: NodeObject,
      action: ActionObject,
    ) => ReturnType<typeof detailCapability.invoke>;
    owner.detailAuthoring.setComponent("spoof", html`
      <button gc=${legacyInvoke("run", unrelated, action)}>Run</button>
    `);

    expect(() => owner.detailAuthoring.checkpoint()).toThrowError(expect.objectContaining<Partial<DetailCompilationError>>({
      issues: [expect.objectContaining({ code: "capability_invalid", componentId: "spoof" })],
    }));
  });

  it("reports incompatible native hosts at the authored component source", () => {
    const source = new NodeObject("box", "Source", "Fallback", "concept", "source");
    const layer = new LayerObject([source], [], new LayerLayoutObject([new NodePlacementObject(source, 0.5, 0.5)]), "layer");
    const input = { kind: "input", label: "Choose", control: "single_select", prompt: "Choose", options: [{ key: "a", label: "A" }], sourceLayer: layer, clientKey: "choose" } satisfies ActionObject;
    const detail = source.detailAuthoring;
    detail.setComponent("bad-hosts", html`
      <button gc=${detailCapability.externalLink("docs", "https://docs.example.com")}>Docs</button>
      <textarea gc=${detailCapability.input("choose", input)} aria-label="Choose"></textarea>
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

  it("validates host-owned asset availability and representation together with authored accessibility", async () => {
    const unavailable = assetRef("missing-visual");
    const node = new NodeObject("box", "Asset errors", "Fallback", "concept", "asset-errors-node");
    const detail = node.detailAuthoring;
    detail.setComponent("asset-errors", html`
      <a gc=${detailCapability.externalLink("empty-link", "https://example.com")}></a>
      <span asset=${unavailable}></span>
    `);

    await expect(checkpointWithHostAssets(node, [{
      logicalId: "missing-visual",
      authority: "current",
      availability: "unavailable",
      digestSha256: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      mediaType: "image/svg+xml",
      representation: { kind: "image", sanitized: false },
    }])).rejects.toThrowError(expect.objectContaining<Partial<DetailCompilationError>>({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "accessibility_name_required", componentId: "asset-errors", line: 2 }),
        expect.objectContaining({ code: "asset_unavailable", componentId: "asset-errors", line: 3 }),
        expect.objectContaining({ code: "asset_representation_unsafe", componentId: "asset-errors", line: 3 }),
        expect.objectContaining({ code: "asset_accessibility_required", componentId: "asset-errors", line: 3 }),
      ]),
    }));
  });

  it("rejects stale, unavailable, revoked, and unsafe authenticated asset checkpoints", async () => {
    const digest = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const node = new NodeObject("box", "Resolver errors", "Fallback", "concept", "resolver-errors-node");
    const detail = node.detailAuthoring;
    detail.setComponent("resolver-errors", html`
      <span asset=${assetRef("unknown")} aria-hidden="true"></span>
      <span asset=${assetRef("mismatch")} aria-hidden="true"></span>
      <span asset=${assetRef("stale")} aria-hidden="true"></span>
      <span asset=${assetRef("unavailable")} aria-hidden="true"></span>
      <span asset=${assetRef("revoked")} aria-hidden="true"></span>
      <span asset=${assetRef("unsafe")} aria-hidden="true"></span>
    `);

    await expect(checkpointWithHostAssets(node, [
      { logicalId: "unknown", authority: "current", availability: "unavailable", digestSha256: digest, mediaType: "image/png", representation: { kind: "image", sanitized: true } },
      { logicalId: "mismatch", authority: "stale", availability: "available", digestSha256: digest, mediaType: "image/png", representation: { kind: "image", sanitized: true } },
      { logicalId: "stale", authority: "stale", availability: "available", digestSha256: digest, mediaType: "image/png", representation: { kind: "image", sanitized: true } },
      { logicalId: "unavailable", authority: "current", availability: "unavailable", digestSha256: digest, mediaType: "image/png", representation: { kind: "image", sanitized: true } },
      { logicalId: "revoked", authority: "current", availability: "revoked", digestSha256: digest, mediaType: "image/png", representation: { kind: "image", sanitized: true } },
      { logicalId: "unsafe", authority: "current", availability: "available", digestSha256: digest, mediaType: "image/png", representation: { kind: "image", sanitized: false } },
    ])).rejects.toThrowError(expect.objectContaining<Partial<DetailCompilationError>>({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "asset_unavailable", line: 2 }),
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
    const detail = source.detailAuthoring;
    detail.setComponent("invalid-action", html`
      <button gc=${detailCapability.invoke("investigate", action)}>Investigate</button>
    `);

    expect(() => detail.checkpoint()).toThrowError(expect.objectContaining<Partial<DetailCompilationError>>({
      issues: [expect.objectContaining({ code: "capability_invalid", componentId: "invalid-action", line: 2 })],
    }));
  });

  it("keeps checkpoint incremental and exposes no author-controlled finalization", () => {
    const detail = new NodeDetailAuthoring();
    detail.setComponent("summary", html`<p>First checkpoint</p>`);

    const first = detail.checkpoint();
    detail.setComponent("summary", html`<p>Second checkpoint</p>`);
    const second = detail.checkpoint();

    expect((detail as unknown as { finalize?: unknown }).finalize).toBeUndefined();
    expect(first.components[0]?.html).toBe("<p>First checkpoint</p>");
    expect(second.components[0]?.html).toBe("<p>Second checkpoint</p>");
    expect(Object.isFrozen(second)).toBe(true);
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
    const detail = new NodeDetailAuthoring();
    detail.setComponent("bad-asset-host", html`
      <div asset=${visual} aria-hidden="true"></div>
    `);

    expect(() => detail.checkpoint()).toThrowError(expect.objectContaining<Partial<DetailCompilationError>>({
      issues: expect.arrayContaining([expect.objectContaining({ code: "asset_host_incompatible", componentId: "bad-asset-host", line: 2 })]),
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

  it("keeps duplicate logical asset references behind the host resolution boundary", () => {
    const first = assetRef("shared");
    const changed = assetRef("shared");
    const detail = new NodeDetailAuthoring();
    detail.setComponent("first", html`<span asset=${first} aria-hidden="true"></span>`);
    detail.setComponent("second", html`<span asset=${changed} aria-hidden="true"></span>`);

    expect(() => detail.checkpoint()).toThrowError(expect.objectContaining<Partial<DetailCompilationError>>({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "asset_resolution_required", componentId: "first" }),
        expect.objectContaining({ code: "asset_resolution_required", componentId: "second" }),
      ]),
    }));
  });

  it("gives repeated placements stable occurrence mounts while resolving one logical asset", async () => {
    const owner = new NodeObject("box", "Repeated logo", "Fallback", "concept", "repeated-logo-owner");
    const logo = assetRef("logo");
    owner.detailAuthoring.setComponent("logos", html`
      <div>
        <img asset=${logo} alt="Primary logo">
        <img asset=${logo} alt="Secondary logo">
      </div>
    `);
    const requests: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ assets: [{
        logicalId: "logo",
        authority: "current",
        availability: "available",
        digestSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        mediaType: "image/png",
        representation: { kind: "image", sanitized: true },
      }] }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const client = new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "host", nodeId: 1 });

    const first = await client.checkpointNodeDetail(owner);
    const second = await client.checkpointNodeDetail(owner);

    expect(requests).toEqual([{ logicalIds: ["logo"] }, { logicalIds: ["logo"] }]);
    expect(first).toEqual(second);
    expect(first.assets).toEqual([expect.objectContaining({ id: "logo" })]);
    expect(first.mounts).toEqual([
      expect.objectContaining({ id: expect.stringMatching(/^m_[a-f0-9]{16}$/), kind: "asset", assetId: "logo" }),
      expect.objectContaining({ id: expect.stringMatching(/^m_[a-f0-9]{16}$/), kind: "asset", assetId: "logo" }),
    ]);
    expect(first.mounts[0]?.id).not.toBe(first.mounts[1]?.id);
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

  it("fail-closes unknown CSS functions that can produce external resources", () => {
    const detail = new NodeDetailAuthoring();
    detail.setComponent("unknown-css-function", html`<section>Unsafe image</section>`, css`
      .hero {
        background-image: image("https://attacker.example/a.png");
      }
    `);

    expect(() => detail.checkpoint()).toThrowError(expect.objectContaining<Partial<DetailCompilationError>>({
      issues: expect.arrayContaining([expect.objectContaining({
        code: "unsafe_css",
        componentId: "unknown-css-function",
        path: "css:2:27",
        line: 2,
        column: 27,
      })]),
    }));
  });

  it("fail-closes shadow-host and unknown CSS pseudos", () => {
    const detail = new NodeDetailAuthoring();
    detail.setComponent("unsafe-pseudos", html`<section class="card"><span>Content</span></section>`, css`
      :host .card { display: grid; }
      :host-context(.theme) .card { color: red; }
      .card::slotted(span) { display: block; }
      .card:future-host-state { color: blue; }
    `);

    expect(() => detail.checkpoint()).toThrowError(expect.objectContaining<Partial<DetailCompilationError>>({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "unsafe_css_selector", componentId: "unsafe-pseudos", path: "css:1:1" }),
        expect.objectContaining({ code: "unsafe_css_selector", componentId: "unsafe-pseudos", path: "css:2:7" }),
        expect.objectContaining({ code: "unsafe_css_selector", componentId: "unsafe-pseudos", path: "css:3:12" }),
        expect.objectContaining({ code: "unsafe_css_selector", componentId: "unsafe-pseudos", path: "css:4:12" }),
      ]),
    }));
  });

  it("allows documented local selector pseudos inside the isolated detail surface", () => {
    const detail = new NodeDetailAuthoring();
    detail.setComponent("safe-pseudos", html`<ul class="list"><li>One</li><li>Two</li></ul>`, css`
      .list > li:first-child { font-weight: 600; }
      .list > li:nth-child(2):hover::before { color: rgb(10 20 30); }
      .list > li:not(:empty):focus-visible { outline: 2px solid blue; }
    `);

    expect(detail.checkpoint().components[0]?.css).toContain(":first-child");
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

  it("does not treat hidden link icons or broken aria-labelledby references as accessible names", () => {
    const detail = new NodeDetailAuthoring();
    detail.setComponent("link-names", html`
      <a gc=${detailCapability.externalLink("icon-only", "https://example.com/icon")}><span aria-hidden="true">External link</span></a>
      <a gc=${detailCapability.externalLink("missing", "https://example.com/missing")} aria-labelledby="missing-label"><span aria-hidden="true">↗</span></a>
      <span id="empty-label"></span>
      <a gc=${detailCapability.externalLink("empty", "https://example.com/empty")} aria-labelledby="empty-label"><span aria-hidden="true">↗</span></a>
      <span id="duplicate-label"></span>
      <span id="duplicate-label">Second duplicate is ignored</span>
      <a gc=${detailCapability.externalLink("duplicate", "https://example.com/duplicate")} aria-labelledby="duplicate-label"><span aria-hidden="true">↗</span></a>
    `);

    expect(() => detail.checkpoint()).toThrowError(expect.objectContaining<Partial<DetailCompilationError>>({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "dom_id_duplicate", componentId: "link-names", line: 7 }),
        expect.objectContaining({ code: "accessibility_name_required", componentId: "link-names", line: 2 }),
        expect.objectContaining({ code: "accessibility_name_required", componentId: "link-names", line: 3 }),
        expect.objectContaining({ code: "accessibility_name_required", componentId: "link-names", line: 5 }),
        expect.objectContaining({ code: "accessibility_name_required", componentId: "link-names", line: 8 }),
      ]),
    }));
  });

  it("accepts a #338 icon link when aria-labelledby resolves to a visible authored label", () => {
    const detail = new NodeDetailAuthoring();
    detail.setComponent("visible-link-label", html`
      <span id="docs-label">Read documentation</span>
      <a gc=${detailCapability.externalLink("docs", "https://example.com/docs")} aria-labelledby="docs-label"><span aria-hidden="true">↗</span></a>
    `);

    expect(detail.checkpoint().components[0]?.html).toMatch(
      /<a aria-labelledby="docs-label" data-gc-mount="m_[a-f0-9]{16}"><span aria-hidden="true">↗<\/span><\/a>/,
    );
  });

  it("implements external labels, descendant image alt, and directly referenced hidden names", () => {
    const owner = new NodeObject("box", "Accessible controls", "Fallback", "concept", "accessible-owner");
    const layer = new LayerObject([owner], [], new LayerLayoutObject([new NodePlacementObject(owner, 0.5, 0.5)]), "accessible-layer");
    const input = {
      kind: "input",
      label: "Search",
      control: "text",
      prompt: "Search documentation",
      sourceLayer: layer,
      clientKey: "search-input",
    } satisfies ActionObject;
    owner.detailAuthoring.setComponent("accessible-subset", html`
      <label for="search-field">Search documentation</label>
      <input id="search-field" gc=${detailCapability.input("search", input)}>
      <a gc=${detailCapability.externalLink("image-alt", "https://example.com/image-alt")}><img alt="Read image documentation"></a>
      <span id="hidden-name" aria-hidden="true">Hidden but directly referenced</span>
      <a gc=${detailCapability.externalLink("hidden-name", "https://example.com/hidden-name")} aria-labelledby="hidden-name"><span aria-hidden="true">↗</span></a>
    `);

    expect(owner.detailAuthoring.checkpoint().mounts).toHaveLength(3);
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
    const detail = source.detailAuthoring;
    detail.setComponent("input-hosts", html`
      <input gc=${detailCapability.input("text", text)} type="file" aria-label="Explain">
      <select gc=${detailCapability.input("multi", multi)} aria-label="Choose"></select>
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
    const detail = source.detailAuthoring;
    detail.setComponent("spoofed-state", html`
      <a gc=${detailCapability.externalLink("docs", "https://example.com")} target="_self" download>Docs</a>
      <button gc=${detailCapability.invoke("run", invoke)} disabled value="forged">Run</button>
      <input gc=${detailCapability.input("text", text)} value="forged" disabled aria-label="Explain">
      <select gc=${detailCapability.input("single", single)} aria-label="Choose"><option selected value="forged">Forged</option></select>
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
    const detail = source.detailAuthoring;
    detail.setComponent("normalized-inputs", html`
      <input gc=${detailCapability.input("text", text)} aria-label="Explain">
      <select gc=${detailCapability.input("single", single)} multiple aria-label="Choose"></select>
      <select gc=${detailCapability.input("multi", multi)} aria-label="Signals"></select>
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

async function checkpointWithHostAssets(node: NodeObject, assets: readonly unknown[]) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ assets }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })));
  return new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "host", nodeId: 1 }).checkpointNodeDetail(node);
}
