import { createHash } from "node:crypto";
import { Window } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mountCompiledNodeDetail } from "../desktop/renderer/src/product-workspace/node-detail-runtime.js";
import { createProductWorkspace, renderProductNodeDetail } from "../desktop/renderer/src/product-workspace/workspace.js";

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function compiledPackage(content) {
  return {
    ...content,
    integritySha256: createHash("sha256").update(canonicalJson(content)).digest("hex"),
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function mountedCss(shadowRoot, index) {
  const fallback = shadowRoot.querySelector(index === 0
    ? "[data-node-detail-authored-styles]"
    : "[data-node-detail-runtime-styles]");
  if (fallback) return fallback.textContent;
  return [...(shadowRoot.adoptedStyleSheets[index]?.cssRules ?? [])].map((rule) => rule.cssText).join("\n");
}

afterEach(() => vi.unstubAllGlobals());

describe("compiled Node Detail product runtime", () => {
  it("mounts authored layout in isolation and composes an ordinary external link with an independent visual asset", async () => {
    const window = new Window({ url: "http://127.0.0.1:3000" });
    const host = window.document.createElement("div");
    const detail = compiledPackage({
      version: 1,
      components: [{
        id: "documentation",
        order: 0,
        html: '<a class="documentation-link" data-gc-mount="link-mount"><span class="documentation-link__icon" aria-hidden="true" data-asset-mount="asset-mount"></span>Documentation</a>',
        css: ".documentation-link{display:grid;grid-template-columns:auto 1fr;gap:0.5rem}",
      }],
      mounts: [
        {
          id: "link-mount",
          componentId: "documentation",
          kind: "capability",
          host: "a",
          capability: { kind: "link", href: "https://docs.example.com/guide" },
        },
        {
          id: "asset-mount",
          componentId: "documentation",
          kind: "asset",
          host: "span",
          assetId: "external-link-visual",
        },
      ],
      assets: [{
        id: "external-link-visual",
        digestSha256: "a".repeat(64),
        mediaType: "image/svg+xml",
        representation: "image",
      }],
    });
    const release = vi.fn();
    const resolveAsset = vi.fn(async () => ({
      digestSha256: "a".repeat(64),
      mediaType: "image/svg+xml",
      url: "blob:http://127.0.0.1:3000/external-link-visual",
      release,
    }));

    const runtime = await mountCompiledNodeDetail({ host, detail, resolveAsset });

    expect(runtime.status).toBe("mounted");
    expect(host.shadowRoot).not.toBeNull();
    expect(host.shadowRoot.adoptedStyleSheets).toHaveLength(2);
    expect(host.shadowRoot.querySelector("style")).toBeNull();
    expect(host.shadowRoot.textContent).toContain("Documentation");
    expect(mountedCss(host.shadowRoot, 0)).toContain("grid-template-columns");
    const link = host.shadowRoot.querySelector("[data-gc-mount='link-mount']");
    expect(link.getAttribute("href")).toBe("https://docs.example.com/guide");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noreferrer noopener");
    const visual = host.shadowRoot.querySelector("[data-asset-mount='asset-mount']");
    expect(visual.style.backgroundImage).toContain("external-link-visual");
    expect(resolveAsset).toHaveBeenCalledWith(detail.assets[0]);
    expect(host.querySelector(".documentation-link")).toBeNull();
    runtime.dispose();
    runtime.dispose();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("does not treat resource-like text inside a CSS string as an executable resource", async () => {
    const window = new Window({ url: "http://127.0.0.1:3000" });
    const host = window.document.createElement("div");
    const detail = compiledPackage({
      version: 1,
      components: [{ id: "quoted", order: 0, html: "<p>Quoted CSS value</p>", css: 'p{font-family:"url(foo)"}' }],
      mounts: [],
      assets: [],
    });

    const runtime = await mountCompiledNodeDetail({ host, detail });

    expect(runtime.status).toBe("mounted");
    expect(mountedCss(runtime.shadowRoot, 0)).toContain("url(foo)");
  });

  it("adapts invoke, input, expand, and reference through host authority without rebuilding unrelated authored regions", async () => {
    const window = new Window({ url: "http://127.0.0.1:3000" });
    const host = window.document.createElement("div");
    window.document.body.append(host);
    const actionReference = (clientKey) => ({
      clientKey,
      sourceNode: { clientKey: "source-node" },
      sourceLayer: { clientKey: "source-layer" },
    });
    const detail = compiledPackage({
      version: 1,
      components: [{
        id: "controls",
        order: 0,
        html: '<section class="independent-scroll"><button data-gc-mount="expand">Expand</button><button data-gc-mount="reference">Reference</button><button data-gc-mount="invoke">Invoke</button><select aria-label="Choose signals" multiple data-gc-mount="input"></select></section>',
        css: ".independent-scroll{max-height:12rem;overflow:auto;display:grid;gap:0.5rem}",
      }],
      mounts: [
        { id: "expand", componentId: "controls", kind: "capability", host: "button", capability: { kind: "expand", action: actionReference("expand-action") } },
        { id: "reference", componentId: "controls", kind: "capability", host: "button", capability: { kind: "reference", action: actionReference("reference-action") } },
        { id: "invoke", componentId: "controls", kind: "capability", host: "button", capability: { kind: "invoke", action: actionReference("invoke-action") } },
        { id: "input", componentId: "controls", kind: "capability", host: "select", capability: { kind: "input", action: actionReference("input-action") } },
      ],
      assets: [],
    });
    const actions = new Map([
      ["expand-action", { id: 11, kind: "navigate", relation: "expand", targetLayerId: 101 }],
      ["reference-action", { id: 12, kind: "navigate", relation: "reference", targetLayerId: 102 }],
      ["invoke-action", { id: 13, kind: "invoke", interactionText: "Investigate" }],
      ["input-action", {
        id: 14,
        kind: "input",
        control: "multi_select",
        prompt: "Choose signals",
        options: [{ key: "one", label: "One" }, { key: "two", label: "Two" }],
        minimumSelections: 1,
      }],
    ]);
    const resolveAction = vi.fn((reference) => actions.get(reference.clientKey));
    const onNavigate = vi.fn();
    const onInvoke = vi.fn();
    const onInput = vi.fn().mockRejectedValueOnce(new Error("commit failed"));

    const runtime = await mountCompiledNodeDetail({
      host,
      detail,
      resolveAction,
      onNavigate,
      onInvoke,
      onInput,
      capabilityState: { input: { value: ["one"] } },
    });

    expect(runtime.status).toBe("mounted");
    const shadow = host.shadowRoot;
    shadow.querySelector("[data-gc-mount='expand']").click();
    shadow.querySelector("[data-gc-mount='reference']").click();
    shadow.querySelector("[data-gc-mount='invoke']").click();
    await window.happyDOM.waitUntilComplete();
    expect(onNavigate.mock.calls.map(([action, context]) => [action.id, context.relation])).toEqual([
      [11, "expand"],
      [12, "reference"],
    ]);
    expect(onInvoke).toHaveBeenCalledWith(actions.get("invoke-action"), expect.objectContaining({ mountId: "invoke" }));

    const scrollRegion = shadow.querySelector(".independent-scroll");
    const input = shadow.querySelector("[data-gc-mount='input']");
    expect([...input.options].map((option) => [option.value, option.textContent, option.selected])).toEqual([
      ["one", "One", true],
      ["two", "Two", false],
    ]);
    input.focus();
    scrollRegion.scrollTop = 37;
    input.options[1].selected = true;
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
    await window.happyDOM.waitUntilComplete();
    expect(onInput).toHaveBeenCalledWith(actions.get("input-action"), ["one", "two"], expect.objectContaining({ mountId: "input" }));

    runtime.updateCapability("input", { value: ["two"], disabled: true, busy: true });
    expect(scrollRegion.scrollTop).toBe(37);
    expect(shadow.activeElement).toBe(input);
    expect(input.disabled).toBe(true);
    expect(input.getAttribute("aria-busy")).toBe("true");
    expect([...input.selectedOptions].map((option) => option.value)).toEqual(["two"]);
    expect(resolveAction).toHaveBeenCalledTimes(8);
  });

  it("keeps authored links usable when their independent visual is missing and fails closed on package drift", async () => {
    const window = new Window({ url: "http://127.0.0.1:3000" });
    const host = window.document.createElement("div");
    const content = {
      version: 1,
      components: [{
        id: "missing-visual",
        order: 0,
        html: '<a data-gc-mount="link"><img alt="External documentation" data-asset-mount="visual">Documentation</a>',
        css: "a{display:flex;gap:0.5rem}",
      }],
      mounts: [
        { id: "link", componentId: "missing-visual", kind: "capability", host: "a", capability: { kind: "link", href: "https://docs.example.com/" } },
        { id: "visual", componentId: "missing-visual", kind: "asset", host: "img", assetId: "missing" },
      ],
      assets: [{ id: "missing", digestSha256: "b".repeat(64), mediaType: "image/png", representation: "image" }],
    };
    const detail = compiledPackage(content);

    const mounted = await mountCompiledNodeDetail({ host, detail, resolveAsset: async () => undefined });

    expect(mounted.status).toBe("mounted");
    const link = host.shadowRoot.querySelector("a");
    const visual = host.shadowRoot.querySelector("img");
    expect(link.textContent).toContain("Documentation");
    expect(link.getAttribute("href")).toBe("https://docs.example.com/");
    expect(visual.dataset.assetState).toBe("unavailable");
    expect(visual.getAttribute("alt")).toBe("External documentation");
    expect(visual.getAttribute("title")).toBe("Visual unavailable");

    const tampered = { ...detail, components: [{ ...detail.components[0], html: "<script>escape()</script>" }] };
    const rejected = await mountCompiledNodeDetail({ host, detail: tampered });
    expect(rejected).toEqual(expect.objectContaining({ status: "fallback", error: "Node Detail package integrity check failed." }));
    expect(host.shadowRoot.querySelector("script")).toBeNull();
    expect(host.shadowRoot.querySelector("[role='status']").textContent).toBe("Node Detail package integrity check failed.");
  });

  it.each([
    ["executable markup", '<script>globalThis.escaped = true</script>', ""],
    ["raw network content", '<img src="https://attacker.example/pixel.png" alt="Pixel">', ""],
    ["auxiliary network attributes", '<a data-gc-mount="link" ping="https://attacker.example/pixel">Documentation</a>', ""],
    ["CSS resource functions", "<p>Remote visual</p>", 'p{background-image:image-set("https://attacker.example/pixel.png" 1x)}'],
    ["escaped CSS resource functions", "<p>Remote visual</p>", 'p{background-image:u\\72l("https://attacker.example/pixel.png")}'],
    ["escaped CSS imports", "<p>Remote visual</p>", '@\\69mport "https://attacker.example/pixel.css";'],
    ["double-quoted CSS bad strings with LF before resources", "<p>Remote visual</p>", 'p{color:red} "\n:host{background:url(https://attacker.example/pixel.png)}"'],
    ["single-quoted CSS bad strings with LF before imports", "<p>Remote visual</p>", "p{color:red} '\n@import 'https://attacker.example/pixel.css';"],
    ["double-quoted CSS bad strings with CR before resources", "<p>Remote visual</p>", 'p{color:red} "\r:host{background:url(https://attacker.example/pixel.png)}"'],
    ["single-quoted CSS bad strings with CR before imports", "<p>Remote visual</p>", "p{color:red} '\r@import 'https://attacker.example/pixel.css';"],
    ["double-quoted CSS bad strings with CRLF before resources", "<p>Remote visual</p>", 'p{color:red} "\r\n:host{background:url(https://attacker.example/pixel.png)}"'],
    ["single-quoted CSS bad strings with CRLF before imports", "<p>Remote visual</p>", "p{color:red} '\r\n@import 'https://attacker.example/pixel.css';"],
    ["double-quoted CSS bad strings with FF before resources", "<p>Remote visual</p>", 'p{color:red} "\f:host{background:url(https://attacker.example/pixel.png)}"'],
    ["single-quoted CSS bad strings with FF before imports", "<p>Remote visual</p>", "p{color:red} '\f@import 'https://attacker.example/pixel.css';"],
    ["CRLF-smuggled escaped CSS resources", "<p>Remote visual</p>", 'p{background:u\\72\r\nl(https://attacker.example/pixel.png)}'],
    ["CRLF-smuggled escaped CSS imports", "<p>Remote visual</p>", '@\\69\r\nmport "https://attacker.example/pixel.css";'],
    ["unterminated CSS structure", "<p>Overlay</p>", "p{position:fixed;inset:0}/*"],
    ["unbound interaction", '<button>Privileged action</button>', ""],
  ])("rejects canonical-looking packages containing %s", async (_name, html, css) => {
    const window = new Window({ url: "http://127.0.0.1:3000" });
    const host = window.document.createElement("div");
    const detail = compiledPackage({
      version: 1,
      components: [{ id: "unsafe", order: 0, html, css }],
      mounts: html.includes("data-gc-mount") ? [{ id: "link", componentId: "unsafe", kind: "capability", host: "a", capability: { kind: "link", href: "https://docs.example.com" } }] : [],
      assets: [],
    });

    const result = await mountCompiledNodeDetail({ host, detail });

    expect(result).toEqual(expect.objectContaining({ status: "fallback", error: "Node Detail package contains unsafe runtime markup." }));
    expect(host.shadowRoot).toBeNull();
    expect(host.querySelector("script,button,img")).toBeNull();
  });

  it.each([
    ["escaped CRLF string continuation", 'p::before{content:"safe\\\r\ntext"}'],
    ["hex escape with LF whitespace", 'p::before{content:"\\41\n"}'],
    ["hex escape with CRLF whitespace", 'p::before{content:"\\41\r\n"}'],
  ])("accepts browser-valid CSS containing %s", async (_name, css) => {
    const window = new Window({ url: "http://127.0.0.1:3000" });
    const host = window.document.createElement("div");
    const detail = compiledPackage({
      version: 1,
      components: [{ id: "safe", order: 0, html: "<p>Safe CSS</p>", css }],
      mounts: [],
      assets: [],
    });

    const result = await mountCompiledNodeDetail({ host, detail });

    expect(result.status).toBe("mounted");
    expect(mountedCss(result.shadowRoot, 0)).not.toBe("");
  });

  it("rejects an unsafe CSS token synthesized only after component concatenation", async () => {
    const window = new Window({ url: "http://127.0.0.1:3000" });
    const host = window.document.createElement("div");
    const detail = compiledPackage({
      version: 1,
      components: [
        { id: "prefix", order: 0, html: "<p>Prefix</p>", css: "@\\69" },
        { id: "suffix", order: 1, html: "<p>Suffix</p>", css: 'mport "https://attacker.example/theme.css";' },
      ],
      mounts: [],
      assets: [],
    });

    const result = await mountCompiledNodeDetail({ host, detail });

    expect(result).toEqual(expect.objectContaining({ status: "fallback", error: "Node Detail package contains unsafe runtime markup." }));
    expect(host.shadowRoot).toBeNull();
  });

  it.each(["image/gif", "image/webp"])("rejects unsupported V1 asset media %s before resolution", async (mediaType) => {
    const window = new Window({ url: "http://127.0.0.1:3000" });
    const host = window.document.createElement("div");
    const resolveAsset = vi.fn();
    const detail = compiledPackage({
      version: 1,
      components: [{ id: "asset", order: 0, html: '<img alt="Unsupported" data-asset-mount="asset">', css: "" }],
      mounts: [{ id: "asset", componentId: "asset", kind: "asset", host: "img", assetId: "asset" }],
      assets: [{ id: "asset", digestSha256: "a".repeat(64), mediaType, representation: "image" }],
    });

    const result = await mountCompiledNodeDetail({ host, detail, resolveAsset });

    expect(result).toEqual(expect.objectContaining({ status: "fallback", error: "Node Detail asset mount has an unsupported representation." }));
    expect(resolveAsset).not.toHaveBeenCalled();
  });

  it.each(["input", "select", "textarea"])("rejects a graph capability mounted on incompatible <%s>", async (hostName) => {
    const window = new Window({ url: "http://127.0.0.1:3000" });
    const host = window.document.createElement("div");
    const detail = compiledPackage({
      version: 1,
      components: [{ id: "unsafe-host", order: 0, html: `<${hostName} aria-label="Expand" data-gc-mount="expand"></${hostName}>`, css: "" }],
      mounts: [{ id: "expand", componentId: "unsafe-host", kind: "capability", host: hostName, capability: { kind: "expand", action: { clientKey: "expand", sourceNode: { clientKey: "node" }, sourceLayer: { clientKey: "layer" } } } }],
      assets: [],
    });

    const runtime = await mountCompiledNodeDetail({
      host,
      detail,
      resolveAction: () => ({ kind: "navigate", relation: "expand", targetLayerId: 2 }),
    });

    expect(runtime).toEqual(expect.objectContaining({ status: "fallback", error: "Node Detail graph action mount has an incompatible host." }));
  });

  it("rejects a compiled mount that does not occur exactly once", async () => {
    const window = new Window({ url: "http://127.0.0.1:3000" });
    const host = window.document.createElement("div");
    const detail = compiledPackage({
      version: 1,
      components: [{ id: "duplicate", order: 0, html: '<button data-gc-mount="duplicate">First</button><button data-gc-mount="duplicate">Second</button>', css: "" }],
      mounts: [{ id: "duplicate", componentId: "duplicate", kind: "capability", host: "button", capability: { kind: "invoke", action: { clientKey: "invoke", sourceNode: { clientKey: "node" }, sourceLayer: { clientKey: "layer" } } } }],
      assets: [],
    });

    const result = await mountCompiledNodeDetail({ host, detail });

    expect(result).toEqual(expect.objectContaining({ status: "fallback", error: "Node Detail mount duplicate must occur exactly once." }));
  });

  it("prevalidates every asset mount before acquiring any host asset lease", async () => {
    const window = new Window({ url: "http://127.0.0.1:3000" });
    const host = window.document.createElement("div");
    const detail = compiledPackage({
      version: 1,
      components: [{ id: "assets", order: 0, html: '<img alt="Unsupported" data-asset-mount="bad"><img alt="Valid" data-asset-mount="good">', css: "" }],
      mounts: [
        { id: "bad", componentId: "assets", kind: "asset", host: "img", assetId: "bad" },
        { id: "good", componentId: "assets", kind: "asset", host: "img", assetId: "good" },
      ],
      assets: [
        { id: "bad", digestSha256: "c".repeat(64), mediaType: "image/png", representation: "icon" },
        { id: "good", digestSha256: "d".repeat(64), mediaType: "image/png", representation: "image" },
      ],
    });
    const resolveAsset = vi.fn();

    const runtime = await mountCompiledNodeDetail({ host, detail, resolveAsset });

    expect(runtime).toEqual(expect.objectContaining({ status: "fallback", error: "Node Detail asset mount has an unsupported representation." }));
    expect(resolveAsset).not.toHaveBeenCalled();
  });

  it("degrades an unavailable action at its authored host and keeps an invoked action disabled through host settlement", async () => {
    const window = new Window({ url: "http://127.0.0.1:3000" });
    const host = window.document.createElement("div");
    const detail = compiledPackage({
      version: 1,
      components: [{ id: "actions", order: 0, html: '<button data-gc-mount="missing">Missing</button><button data-gc-mount="invoke">Invoke</button>', css: "" }],
      mounts: [
        { id: "missing", componentId: "actions", kind: "capability", host: "button", capability: { kind: "reference", action: { clientKey: "missing", sourceNode: { clientKey: "node" }, sourceLayer: { clientKey: "layer" } } } },
        { id: "invoke", componentId: "actions", kind: "capability", host: "button", capability: { kind: "invoke", action: { clientKey: "invoke", sourceNode: { clientKey: "node" }, sourceLayer: { clientKey: "layer" } } } },
      ],
      assets: [],
    });
    const settlement = deferred();
    let missingAvailable = false;
    const resolveAction = (reference) => {
      if (reference.clientKey === "invoke") return { id: 9, kind: "invoke", interactionText: "Investigate" };
      return missingAvailable ? { id: 10, kind: "navigate", relation: "reference", targetLayerId: 22 } : undefined;
    };
    const onNavigate = vi.fn();
    const runtime = await mountCompiledNodeDetail({
      host,
      detail,
      resolveAction,
      onNavigate,
      onInvoke: () => settlement.promise,
    });

    expect(runtime.status).toBe("mounted");
    const missing = host.shadowRoot.querySelector("[data-gc-mount='missing']");
    const invoke = host.shadowRoot.querySelector("[data-gc-mount='invoke']");
    expect(missing.dataset.capabilityState).toBe("unavailable");
    expect(missing.disabled).toBe(true);
    invoke.click();
    expect(invoke.disabled).toBe(true);
    expect(invoke.getAttribute("aria-busy")).toBe("true");
    settlement.resolve();
    await settlement.promise;
    await Promise.resolve();
    expect(invoke.disabled).toBe(true);
    expect(invoke.getAttribute("aria-busy")).toBe("false");

    missingAvailable = true;
    await runtime.updateAdapters({ resolveAction, onNavigate });
    runtime.updateCapability("missing", { disabled: false, error: null });
    missing.click();
    await window.happyDOM.waitUntilComplete();
    expect(missing.dataset.capabilityState).toBe("ready");
    expect(onNavigate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 10, targetLayerId: 22 }),
      expect.objectContaining({ mountId: "missing", relation: "reference" }),
    );
  });

  it("clears a prior activation error after retry success without overriding host-authoritative disabled state", async () => {
    const window = new Window({ url: "http://127.0.0.1:3000" });
    const host = window.document.createElement("div");
    const detail = compiledPackage({
      version: 1,
      components: [{ id: "retry", order: 0, html: '<button data-gc-mount="retry">Retry navigation</button>', css: "" }],
      mounts: [{ id: "retry", componentId: "retry", kind: "capability", host: "button", capability: { kind: "expand", action: { clientKey: "retry", sourceNode: { clientKey: "node" }, sourceLayer: { clientKey: "layer" } } } }],
      assets: [],
    });
    let attempt = 0;
    let runtime;
    const onNavigate = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("temporary");
      runtime.updateCapability("retry", { disabled: true });
    });
    runtime = await mountCompiledNodeDetail({
      host,
      detail,
      resolveAction: () => ({ id: 10, kind: "navigate", relation: "expand", targetLayerId: 22 }),
      onNavigate,
    });
    const retry = host.shadowRoot.querySelector("[data-gc-mount='retry']");

    retry.click();
    await window.happyDOM.waitUntilComplete();
    expect(retry.getAttribute("aria-invalid")).toBe("true");
    expect(retry.getAttribute("title")).toBe("temporary");

    retry.click();
    await window.happyDOM.waitUntilComplete();
    expect(retry.hasAttribute("aria-invalid")).toBe(false);
    expect(retry.hasAttribute("title")).toBe(false);
    expect(retry.disabled).toBe(true);
    expect(retry.dataset.capabilityState).toBe("disabled");
  });

  it("selects the canonical package in the Product Node Details container while retaining legacy Markdown compatibility", async () => {
    const window = new Window({ url: "http://127.0.0.1:3000" });
    const container = window.document.createElement("div");
    const detail = compiledPackage({
      version: 1,
      components: [{ id: "summary", order: 0, html: "<p>Authored summary</p>", css: "p{font-weight:700}" }],
      mounts: [],
      assets: [],
    });

    const authored = await renderProductNodeDetail({ container, node: { title: "Authored", authoredDetail: detail } });

    expect(authored).toEqual(expect.objectContaining({ authored: true, status: "mounted" }));
    expect(container.querySelector("[data-node-detail-runtime]").shadowRoot.textContent).toContain("Authored summary");
    expect(container.textContent).not.toContain("checkpoint");

    const invalid = await renderProductNodeDetail({
      container,
      node: { title: "Invalid", authoredDetail: { ...detail, integritySha256: "0".repeat(64) } },
      existing: authored,
    });
    expect(invalid).toEqual(expect.objectContaining({ authored: false, status: "fallback" }));

    const legacy = await renderProductNodeDetail({ container, node: { title: "Legacy", detail: "**Legacy detail**" }, existing: invalid });
    expect(legacy).toEqual({ authored: false, status: "legacy" });
    expect(container.querySelector("[data-node-detail-runtime]")).toBeNull();
    expect(container.textContent).toBe("**Legacy detail**");
  });

  it.each(["input", "textarea"])("preserves a staged authored <%s> across an ordinary Product detail rerender", async (hostName) => {
    const window = new Window({ url: "http://127.0.0.1:3000" });
    const container = window.document.createElement("div");
    window.document.body.append(container);
    const detail = compiledPackage({
      version: 1,
      components: [{
        id: "editor",
        order: 0,
        html: `<section class="scroll"><${hostName} aria-label="Draft" data-gc-mount="draft"></${hostName}></section>`,
        css: ".scroll{max-height:4rem;overflow:auto}",
      }],
      mounts: [{
        id: "draft",
        componentId: "editor",
        kind: "capability",
        host: hostName,
        capability: {
          kind: "input",
          action: { clientKey: "draft", sourceNode: { clientKey: "node" }, sourceLayer: { clientKey: "layer" } },
        },
      }],
      assets: [],
    });
    const resolveAction = () => ({ id: 7, kind: "input", control: "text", prompt: "Draft" });
    const onInput = vi.fn().mockRejectedValueOnce(new Error("temporary input failure"));
    const first = await renderProductNodeDetail({
      container,
      node: { title: "Editor", authoredDetail: detail },
      mountKey: "stable",
      resolveAction,
      onInput,
      capabilityState: { draft: { value: "committed" } },
    });
    const control = first.shadowRoot.querySelector("[data-gc-mount='draft']");
    const scroll = first.shadowRoot.querySelector(".scroll");
    control.value = "locally staged value";
    control.focus();
    control.setSelectionRange(7, 13);
    control.scrollTop = 19;
    scroll.scrollTop = 23;
    control.dispatchEvent(new window.Event("input", { bubbles: true }));

    const rerendered = await renderProductNodeDetail({
      container,
      node: { title: "Editor", authoredDetail: detail },
      mountKey: "stable",
      existing: first,
      resolveAction,
      onInput,
      capabilityState: { draft: { value: "committed" } },
    });

    expect(rerendered).toBe(first);
    expect(rerendered.shadowRoot.querySelector("[data-gc-mount='draft']")).toBe(control);
    expect(control.value).toBe("locally staged value");
    expect(rerendered.shadowRoot.activeElement).toBe(control);
    expect([control.selectionStart, control.selectionEnd]).toEqual([7, 13]);
    expect(control.scrollTop).toBe(19);
    expect(scroll.scrollTop).toBe(23);

    control.dispatchEvent(new window.Event("change", { bubbles: true }));
    await window.happyDOM.waitUntilComplete();
    expect(onInput).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7 }),
      "locally staged value",
      expect.objectContaining({ mountId: "draft" }),
    );
    expect(control.getAttribute("aria-invalid")).toBe("true");
    control.value = "revised after failure";
    control.dispatchEvent(new window.Event("input", { bubbles: true }));
    expect(control.hasAttribute("aria-invalid")).toBe(false);
    expect(control.hasAttribute("title")).toBe(false);
  });

  it.each([260, 420])("installs the runtime containment contract at a %ipx supported sidebar width", async (width) => {
    const window = new Window({ url: "http://127.0.0.1:3000" });
    const host = window.document.createElement("div");
    host.style.width = `${width}px`;
    const detail = compiledPackage({
      version: 1,
      components: [
        { id: "after", order: 1, html: "<p>After</p>", css: "" },
        { id: "wide", order: 0, html: '<section class="wide-grid"><p>First</p><p>Second</p></section>', css: ".wide-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr);gap:1rem}" },
      ],
      mounts: [],
      assets: [],
    });

    const runtime = await mountCompiledNodeDetail({ host, detail });

    const runtimeCss = mountedCss(runtime.shadowRoot, 1);
    expect(runtimeCss).toMatch(/inline-size:\s*100%\s*!important/);
    expect(runtimeCss).toMatch(/contain:\s*layout paint style\s*!important/);
    expect(runtimeCss).toMatch(/overflow:\s*hidden\s*!important/);
    expect(runtimeCss).toMatch(/overflow-wrap:\s*anywhere/);
    expect(runtime.shadowRoot.querySelector(".wide-grid")).not.toBeNull();
    expect(runtime.shadowRoot.textContent.indexOf("First")).toBeLessThan(runtime.shadowRoot.textContent.indexOf("After"));
  });

  it("mounts the canonical package when a user opens a node through the real Product workspace selection path", async () => {
    const window = new Window({ url: "http://127.0.0.1:3000" });
    vi.stubGlobal("document", window.document);
    vi.stubGlobal("window", window);
    vi.stubGlobal("lucide", new Proxy({
      Circle: {},
      createElement: (_icon, attributes) => {
        const svg = window.document.createElement("svg");
        for (const [name, value] of Object.entries(attributes)) svg.setAttribute(name, value);
        return svg;
      },
    }, { get: (target, key) => target[key] ?? {} }));
    window.document.body.innerHTML = '<section id="threadView"></section>';
    const detail = compiledPackage({
      version: 1,
      components: [{ id: "product", order: 0, html: '<section class="independent-scroll"><p>Product-authored detail</p><button data-gc-mount="expand">Expand</button><button data-gc-mount="invoke">Invoke</button><textarea aria-label="Draft answer" data-gc-mount="input"></textarea></section>', css: "p{color:teal}.independent-scroll{max-height:10rem;overflow:auto}" }],
      mounts: [
        { id: "expand", componentId: "product", kind: "capability", host: "button", capability: { kind: "expand", action: { clientKey: "expand-action", sourceNode: { clientKey: "authored-node" }, sourceLayer: { clientKey: "original-layer" } } } },
        { id: "invoke", componentId: "product", kind: "capability", host: "button", capability: { kind: "invoke", action: { clientKey: "invoke-action", sourceNode: { clientKey: "authored-node" }, sourceLayer: { clientKey: "original-layer" } } } },
        { id: "input", componentId: "product", kind: "capability", host: "textarea", capability: { kind: "input", action: { clientKey: "input-action", sourceNode: { clientKey: "authored-node" }, sourceLayer: { clientKey: "original-layer" } } } },
      ],
      assets: [],
    });
    const node = { id: 7, clientKey: "authored-node", kind: "concept", icon: "box", title: "Authored node", detail: "Legacy fallback", authoredDetail: detail };
    const actions = [
      { id: 11, clientKey: "expand-action", sourceNodeId: 7, sourceLayerId: 10, sourceLayerClientKey: "original-layer", kind: "navigate", relation: "expand", targetLayerId: 91 },
      { id: 12, clientKey: "invoke-action", sourceNodeId: 7, sourceLayerId: 10, sourceLayerClientKey: "original-layer", kind: "invoke", interactionText: "Investigate" },
      { id: 13, clientKey: "input-action", sourceNodeId: 7, sourceLayerId: 10, sourceLayerClientKey: "original-layer", kind: "input", control: "text", prompt: "Draft answer" },
    ];
    const layer = {
      layer: { id: 99, clientKey: "presenting-layer", layout: { version: 1, placements: [{ nodeId: 7, x: 0.5, y: 0.5 }] } },
      nodes: [node],
      edges: [],
      actions,
    };
    const thread = { id: 3, rootInteractionId: 5, title: "Thread", harnessId: "fixture" };
    const state = {
      status: "accepted",
      currentInteractionId: 5,
      interactions: [{ id: 5, threadId: 3, sequence: 1, text: "Question", graphNodeId: 50, completionStatus: "accepted", completionOutput: { rootLayer: layer } }],
      visibleLayer: layer,
      nodes: [node],
      actions,
      projects: [],
      permissionProfiles: [],
      modelSettings: {
        defaults: { harnessId: "fixture" },
        harnesses: [{ id: "fixture", available: true }],
        providers: [],
        families: [],
      },
      modelCatalog: [],
      actionInvocations: [],
      pendingActionInvocations: [],
    };
    const selection = { currentThreadId: 3, currentInteractionId: 5, selectedNodeId: null, layerPath: [] };
    const onNavigateLayer = vi.fn();
    const onInvokeAction = vi.fn();
    const inputDraftApi = {
      get: vi.fn(async () => ({ threadId: 3, revision: 0, attachments: [], updatedAt: "2026-09-01T00:00:00Z" })),
      commit: vi.fn(async (_threadId, occurrence, value) => ({
        threadId: 3,
        revision: 1,
        attachments: [{
          occurrence,
          sourceNodeId: 7,
          action: { control: "text", prompt: "Draft answer" },
          value,
          draftRevision: 1,
          committedAt: "2026-09-01T00:00:01Z",
        }],
        updatedAt: "2026-09-01T00:00:01Z",
      })),
      detach: vi.fn(),
    };
    const workspace = createProductWorkspace({
      root: window.document,
      getState: () => state,
      getThread: () => thread,
      selection,
      showThread: () => {},
      showEmpty: () => {},
      onNavigateLayer,
      onInvokeAction,
      inputDraftApi,
    });

    workspace.render();
    window.document.querySelector('[data-node="7"]').click();
    await window.happyDOM.waitUntilComplete();

    const runtimeHost = window.document.querySelector("#detailContent [data-node-detail-runtime]");
    expect(runtimeHost).not.toBeNull();
    await vi.waitFor(() => expect(runtimeHost.shadowRoot).not.toBeNull());
    expect(runtimeHost.shadowRoot.textContent).toContain("Product-authored detail");
    expect(runtimeHost.shadowRoot.querySelector("[data-gc-mount='expand']").dataset.capabilityState).toBe("ready");
    const preservedInput = runtimeHost.shadowRoot.querySelector("[data-gc-mount='input']");
    const preservedScroll = runtimeHost.shadowRoot.querySelector(".independent-scroll");
    preservedInput.value = "answer still being written";
    preservedInput.focus();
    preservedInput.setSelectionRange(7, 12);
    preservedInput.scrollTop = 17;
    preservedScroll.scrollTop = 31;
    preservedInput.dispatchEvent(new window.Event("input", { bubbles: true }));
    workspace.render();
    await window.happyDOM.waitUntilComplete();
    expect(window.document.querySelector("#detailContent [data-node-detail-runtime]")).toBe(runtimeHost);
    expect(runtimeHost.shadowRoot.querySelector("[data-gc-mount='input']")).toBe(preservedInput);
    expect(runtimeHost.shadowRoot.activeElement).toBe(preservedInput);
    expect(preservedInput.value).toBe("answer still being written");
    expect([preservedInput.selectionStart, preservedInput.selectionEnd]).toEqual([7, 12]);
    expect(preservedInput.scrollTop).toBe(17);
    expect(preservedScroll.scrollTop).toBe(31);
    runtimeHost.shadowRoot.querySelector("[data-gc-mount='expand']").click();
    runtimeHost.shadowRoot.querySelector("[data-gc-mount='invoke']").click();
    await window.happyDOM.waitUntilComplete();
    expect(onNavigateLayer).toHaveBeenCalledWith(91, expect.objectContaining({ action: actions[0], sourceNode: node }));
    expect(onInvokeAction).toHaveBeenCalledWith(actions[1]);
    const input = runtimeHost.shadowRoot.querySelector("[data-gc-mount='input']");
    expect(input.disabled).toBe(false);
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
    await window.happyDOM.waitUntilComplete();
    expect(inputDraftApi.commit).toHaveBeenCalledWith(
      3,
      { presentingInteractionNodeId: 50, presentingLayerId: 99, actionId: 13 },
      { text: "answer still being written" },
      0,
    );
    expect(window.document.querySelector("#detailActions").classList.contains("hidden")).toBe(true);

    node.authoredDetail = compiledPackage({
      version: 1,
      components: [{ id: "incomplete", order: 0, html: "<p>Incomplete authored detail</p>", css: "" }],
      mounts: [],
      assets: [],
    });
    workspace.render();
    await vi.waitFor(() => expect(
      window.document.querySelector("#detailContent [role='status']")?.textContent,
    ).toBe("This authored detail does not bind every accepted node action."));
    expect(window.document.querySelector("#detailContent").textContent).toContain("Legacy fallback");
    expect(window.document.querySelector("#detailActions").classList.contains("hidden")).toBe(false);
    expect(window.document.querySelector("#nodeInputActions").classList.contains("hidden")).toBe(false);

    node.authoredDetail = compiledPackage({
      version: detail.version,
      components: detail.components,
      mounts: detail.mounts.map((mount) => mount.id === "expand"
        ? { ...mount, capability: { ...mount.capability, kind: "invoke" } }
        : mount),
      assets: detail.assets,
    });
    workspace.render();
    await vi.waitFor(() => expect(
      window.document.querySelector("#detailContent [role='status']")?.textContent,
    ).toBe("This authored detail does not bind every accepted node action."));
    expect(window.document.querySelector("#detailActions").classList.contains("hidden")).toBe(false);

    onNavigateLayer.mockClear();
    node.authoredDetail = { ...detail, integritySha256: "0".repeat(64) };
    workspace.render();
    await vi.waitFor(() => expect(
      window.document.querySelector("#detailContent [role='status']")?.textContent,
    ).toBe("Node Detail package integrity check failed."));
    expect(window.document.querySelector("#detailContent").textContent).toContain("Legacy fallback");
    expect(window.document.querySelector("#detailActions").classList.contains("hidden")).toBe(false);
    expect(window.document.querySelector("#nodeInputActions").classList.contains("hidden")).toBe(false);
    window.document.querySelector("#detailActions [data-action-id='11']").click();
    await window.happyDOM.waitUntilComplete();
    expect(onNavigateLayer).toHaveBeenCalledWith(91, expect.objectContaining({ action: actions[0], sourceNode: node }));
    workspace.dispose();
  });
});
