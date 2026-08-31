import { createHash } from "node:crypto";
import { LayerObject, NodeObject, type ActionObject, type InputActionObject, type InvokeActionObject, type LayerReference, type NavigateActionObject, type NodeReference } from "./objects.js";

const DETAIL_TEMPLATE = Symbol("detail-template");
const DETAIL_CAPABILITY = Symbol("detail-capability");
const DETAIL_ASSET = Symbol("detail-asset");

type TemplateKind = "html" | "css";

interface HtmlRoot {
  readonly childNodes: HtmlNode[];
}

interface HtmlElement {
  readonly tagName: string;
  attrs: { name: string; value: string }[];
  readonly childNodes: HtmlNode[];
  readonly line: number;
  readonly column: number;
}

interface HtmlText {
  readonly text: string;
}

interface HtmlComment {
  readonly comment: string;
}

type HtmlNode = HtmlElement | HtmlText | HtmlComment;

export interface DetailTemplate {
  readonly [DETAIL_TEMPLATE]: TemplateKind;
  readonly strings: readonly string[];
  readonly values: readonly unknown[];
}

export interface ExternalLinkCapability {
  readonly [DETAIL_CAPABILITY]: true;
  readonly key: string;
  readonly kind: "link";
  readonly href: string;
}

export interface StableAuthoringReference {
  readonly id?: number;
  readonly clientKey?: string;
}

export interface CompiledGraphActionReference {
  readonly clientKey: string;
  readonly sourceNode: StableAuthoringReference;
  readonly sourceLayer: StableAuthoringReference;
}

export interface GraphDetailCapability {
  readonly [DETAIL_CAPABILITY]: true;
  readonly key: string;
  readonly kind: "expand" | "reference" | "invoke" | "input";
  readonly action: ActionObject;
  readonly sourceNode: NodeReference;
}

export type DetailCapability = ExternalLinkCapability | GraphDetailCapability;

export interface AssetRefInput {
  readonly id: string;
  readonly digestSha256: string;
  readonly mediaType: string;
  readonly representation: "image";
  readonly available: boolean;
  readonly sanitized: boolean;
}

export interface AssetRef extends AssetRefInput {
  readonly [DETAIL_ASSET]: true;
}

export interface CompiledDetailComponent {
  readonly id: string;
  readonly order: number;
  readonly html: string;
  readonly css: string;
}

export interface CompiledCapabilityMount {
  readonly id: string;
  readonly componentId: string;
  readonly kind: "capability";
  readonly host: string;
  readonly capability:
    | { readonly kind: "link"; readonly href: string }
    | { readonly kind: "expand" | "reference" | "invoke" | "input"; readonly action: CompiledGraphActionReference };
}

export interface CompiledAssetMount {
  readonly id: string;
  readonly componentId: string;
  readonly kind: "asset";
  readonly host: string;
  readonly assetId: string;
}

export type CompiledDetailMount = CompiledCapabilityMount | CompiledAssetMount;

export interface CompiledAsset {
  readonly id: string;
  readonly digestSha256: string;
  readonly mediaType: string;
  readonly representation: "image";
}

export interface CompiledNodeDetail {
  readonly version: 1;
  readonly components: readonly CompiledDetailComponent[];
  readonly mounts: readonly CompiledDetailMount[];
  readonly assets: readonly CompiledAsset[];
  readonly integritySha256: string;
}

export interface DetailCompilationIssue {
  readonly code: string;
  readonly componentId: string;
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

export class DetailCompilationError extends Error {
  constructor(readonly issues: readonly DetailCompilationIssue[]) {
    super(`Node Detail checkpoint failed with ${issues.length} validation issue${issues.length === 1 ? "" : "s"}`);
    this.name = "DetailCompilationError";
  }
}

export const detailCapability = Object.freeze({
  externalLink(key: string, href: string): ExternalLinkCapability {
    return Object.freeze({ [DETAIL_CAPABILITY]: true as const, key, kind: "link" as const, href });
  },
  expand(key: string, sourceNode: NodeReference, action: NavigateActionObject & { readonly relation: "expand" }): GraphDetailCapability {
    return graphCapability(key, "expand", sourceNode, action);
  },
  reference(key: string, sourceNode: NodeReference, action: NavigateActionObject & { readonly relation: "reference" }): GraphDetailCapability {
    return graphCapability(key, "reference", sourceNode, action);
  },
  invoke(key: string, sourceNode: NodeReference, action: InvokeActionObject): GraphDetailCapability {
    return graphCapability(key, "invoke", sourceNode, action);
  },
  input(key: string, sourceNode: NodeReference, action: InputActionObject): GraphDetailCapability {
    return graphCapability(key, "input", sourceNode, action);
  },
});

export function assetRef(input: AssetRefInput): AssetRef {
  return Object.freeze({ [DETAIL_ASSET]: true as const, ...input });
}

export function html(strings: TemplateStringsArray, ...values: readonly unknown[]): DetailTemplate {
  return template("html", strings, values);
}

export function css(strings: TemplateStringsArray, ...values: readonly unknown[]): DetailTemplate {
  return template("css", strings, values);
}

export class NodeDetailAuthoring {
  readonly #components = new Map<string, { markup: DetailTemplate; styles: DetailTemplate; order: number }>();
  #finalized?: CompiledNodeDetail;

  setComponent(id: string, markup: DetailTemplate, styles: DetailTemplate = emptyCssTemplate()): this {
    if (this.#finalized !== undefined) throw new Error("Node Detail authoring is finalized and cannot be mutated");
    const existing = this.#components.get(id);
    this.#components.set(id, { markup, styles, order: existing?.order ?? this.#components.size });
    return this;
  }

  checkpoint(): CompiledNodeDetail {
    if (this.#finalized !== undefined) return this.#finalized;
    const mounts: CompiledDetailMount[] = [];
    const assets = new Map<string, CompiledAsset>();
    const issues: DetailCompilationIssue[] = [];
    const components = Object.freeze([...this.#components.entries()]
      .sort((left, right) => left[1].order - right[1].order)
      .map(([id, component]) => {
        if (!isStableIdentity(id)) {
          issues.push(Object.freeze({
            code: "component_identity_invalid",
            componentId: id,
            path: "component",
            line: 1,
            column: 1,
            message: "Node Detail component identity must be stable, non-whitespace, and at most 128 UTF-8 bytes",
          }));
        }
        return Object.freeze({
          id,
          order: component.order,
          html: compileHtml(id, component.markup, mounts, assets, issues),
          css: compileCss(id, component.styles, issues),
        });
      }));
    if (issues.length !== 0) throw new DetailCompilationError(Object.freeze(issues));
    const content = Object.freeze({
      version: 1 as const,
      components,
      mounts: Object.freeze(mounts),
      assets: Object.freeze([...assets.values()]),
    });
    return Object.freeze({
      ...content,
      integritySha256: createHash("sha256").update(canonicalJson(content)).digest("hex"),
    });
  }

  finalize(): CompiledNodeDetail {
    return this.#finalized ??= this.checkpoint();
  }
}

function template(kind: TemplateKind, strings: TemplateStringsArray, values: readonly unknown[]): DetailTemplate {
  return Object.freeze({
    [DETAIL_TEMPLATE]: kind,
    strings: Object.freeze([...strings]),
    values: Object.freeze([...values]),
  });
}

function emptyCssTemplate(): DetailTemplate {
  return Object.freeze({ [DETAIL_TEMPLATE]: "css" as const, strings: Object.freeze([""]), values: Object.freeze([]) });
}

function compileHtml(
  componentId: string,
  template: DetailTemplate,
  mounts: CompiledDetailMount[],
  assets: Map<string, CompiledAsset>,
  issues: DetailCompilationIssue[],
): string {
  if (template[DETAIL_TEMPLATE] !== "html") throw new Error("Node Detail component markup must use html``");
  const source = bindingSource(componentId, template, issues);
  const fragment = parseAuthoredHtml(source, componentId, issues);
  visitElements(fragment, (element) => {
    validateElementSafety(componentId, element, issues);
    element.attrs.sort((left, right) => left.name.localeCompare(right.name));
    const binding = element.attrs.find((attribute) => attribute.name === "data-relayer-binding");
    if (binding === undefined) return;
    const index = Number(binding.value);
    const value = template.values[index];
    element.attrs = element.attrs.filter((attribute) => attribute !== binding);
    if (isDetailCapability(value)) {
      const validCapability = isValidCapability(value);
      if (!validCapability) {
        issues.push(sourceIssue("capability_invalid", componentId, element, `Invalid ${value.kind} capability declaration`));
      }
      if (!isCompatibleCapabilityHost(value, element)) {
        issues.push(sourceIssue(
          "capability_host_incompatible",
          componentId,
          element,
          `${value.kind} capability cannot bind to <${element.tagName}>`,
        ));
      }
      if (!hasAccessibleName(element)) {
        issues.push(sourceIssue(
          "accessibility_name_required",
          componentId,
          element,
          `The <${element.tagName}> capability host needs an authored accessible name`,
        ));
      }
      const id = mountId("capability", componentId, value.key);
      element.attrs.push({ name: "data-gc-mount", value: id });
      const duplicateMount = mounts.some((mount) => mount.id === id);
      if (duplicateMount) {
        issues.push(sourceIssue("duplicate_mount_identity", componentId, element, `Binding key ${value.key} is already used in this component`));
      } else if (validCapability) {
        mounts.push(Object.freeze({
          id,
          componentId,
          kind: "capability",
          host: element.tagName,
          capability: compileCapability(value),
        }));
      }
    } else if (isAssetRef(value)) {
      validateAsset(componentId, element, value, issues);
      const id = mountId("asset", componentId, value.id);
      element.attrs.push({ name: "data-asset-mount", value: id });
      if (mounts.some((mount) => mount.id === id)) {
        issues.push(sourceIssue("duplicate_mount_identity", componentId, element, `Asset ${value.id} is already bound in this component`));
      } else {
        mounts.push(Object.freeze({ id, componentId, kind: "asset", host: element.tagName, assetId: value.id }));
      }
      const compiledAsset = Object.freeze({
        id: value.id,
        digestSha256: value.digestSha256,
        mediaType: value.mediaType,
        representation: value.representation,
      });
      const existingAsset = assets.get(value.id);
      if (existingAsset !== undefined && canonicalJson(existingAsset) !== canonicalJson(compiledAsset)) {
        issues.push(sourceIssue(
          "asset_identity_conflict",
          componentId,
          element,
          `Asset ${value.id} resolves to conflicting pinned content in this detail`,
        ));
      } else if (existingAsset === undefined) {
        assets.set(value.id, compiledAsset);
      }
    } else {
      issues.push(sourceIssue("binding_type_invalid", componentId, element, "Node Detail binding has the wrong typed value"));
    }
    element.attrs.sort((left, right) => left.name.localeCompare(right.name));
  });
  return serializeHtml(fragment).replace(/\r\n?/g, "\n").trim();
}

function bindingSource(componentId: string, template: DetailTemplate, issues: DetailCompilationIssue[]): string {
  let source = template.strings[0] ?? "";
  for (let index = 0; index < template.values.length; index += 1) {
    const match = source.match(/\b(gc|asset)\s*=\s*$/);
    if (match === null) {
      const location = sourceLocationAtEnd(source);
      issues.push(Object.freeze({
        code: "binding_not_allowed",
        componentId,
        path: `html:${location.line}:${location.column}`,
        line: location.line,
        column: location.column,
        message: "Node Detail interpolation must be an unquoted gc= or asset= binding",
      }));
      source += template.strings[index + 1] ?? "";
      continue;
    }
    const value = template.values[index];
    if ((match[1] === "gc" && !isDetailCapability(value)) || (match[1] === "asset" && !isAssetRef(value))) {
      const location = sourceLocationAtEnd(source);
      issues.push(Object.freeze({
        code: "binding_type_invalid",
        componentId,
        path: `html:${location.line}:${location.column}`,
        line: location.line,
        column: location.column,
        message: `Node Detail ${match[1]} binding has the wrong typed value`,
      }));
    }
    source = `${source.slice(0, match.index)}data-relayer-binding="${index}"${template.strings[index + 1] ?? ""}`;
  }
  return source;
}

function sourceLocationAtEnd(source: string): { readonly line: number; readonly column: number } {
  const lines = source.split(/\r\n?|\n/);
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

function isStableIdentity(value: string): boolean {
  return value.trim() === value && value !== "" && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= 128;
}

function compileCss(componentId: string, template: DetailTemplate, issues: DetailCompilationIssue[]): string {
  if (template[DETAIL_TEMPLATE] !== "css") throw new Error("Node Detail component styles must use css``");
  if (template.values.length !== 0) throw new Error("Node Detail CSS does not accept interpolated values");
  const source = template.strings.join("").replace(/\r\n?/g, "\n").trim();
  if (!hasValidCssStructure(source)) {
    issues.push(Object.freeze({
      code: "invalid_css",
      componentId,
      path: "css",
      line: 1,
      column: 1,
      message: "Node Detail CSS contains an unclosed string, comment, or delimiter",
    }));
  }
  if (/(?:\\|@import\b|@namespace\b|url\s*\(|expression\s*\(|javascript\s*:|behavior\s*:|-moz-binding\s*:)/i.test(source)) {
    issues.push(Object.freeze({
      code: "unsafe_css",
      componentId,
      path: "css",
      line: 1,
      column: 1,
      message: "Node Detail CSS cannot import or address external or privileged resources",
    }));
  }
  return source;
}

function hasValidCssStructure(source: string): boolean {
  const expectedClosers: string[] = [];
  let quote: '"' | "'" | undefined;
  let inComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    const next = source[index + 1];
    if (inComment) {
      if (character === "*" && next === "/") {
        inComment = false;
        index += 1;
      }
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "/" && next === "*") {
      inComment = true;
      index += 1;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "{") {
      expectedClosers.push("}");
    } else if (character === "(") {
      expectedClosers.push(")");
    } else if (character === "[") {
      expectedClosers.push("]");
    } else if (character === "}" || character === ")" || character === "]") {
      if (expectedClosers.pop() !== character) return false;
    }
  }
  return !inComment && quote === undefined && expectedClosers.length === 0;
}

function visitElements(node: HtmlRoot | HtmlElement, visitor: (element: HtmlElement) => void): void {
  for (const child of node.childNodes) {
    if (!("tagName" in child)) continue;
    visitor(child);
    visitElements(child, visitor);
  }
}

function isDetailCapability(value: unknown): value is DetailCapability {
  return typeof value === "object" && value !== null && DETAIL_CAPABILITY in value;
}

function graphCapability(
  key: string,
  kind: GraphDetailCapability["kind"],
  sourceNode: NodeReference,
  action: ActionObject,
): GraphDetailCapability {
  return Object.freeze({ [DETAIL_CAPABILITY]: true as const, key, kind, sourceNode, action });
}

function compileCapability(capability: DetailCapability): CompiledCapabilityMount["capability"] {
  if (capability.kind === "link") return Object.freeze({ kind: capability.kind, href: new URL(capability.href).href });
  const clientKey = capability.action.clientKey;
  const sourceLayer = capability.action.sourceLayer;
  if (clientKey === undefined || clientKey.trim() === "") {
    throw new Error(`Node Detail ${capability.kind} capability requires an explicit stable action clientKey`);
  }
  if (sourceLayer === undefined) {
    throw new Error(`Node Detail ${capability.kind} capability requires exact source-layer provenance`);
  }
  return Object.freeze({
    kind: capability.kind,
    action: Object.freeze({
      clientKey,
      sourceNode: stableReference(capability.sourceNode),
      sourceLayer: stableReference(sourceLayer),
    }),
  });
}

function stableReference(reference: NodeReference | LayerReference): StableAuthoringReference {
  if (typeof reference === "number") return Object.freeze({ id: reference });
  if (reference instanceof NodeObject || reference instanceof LayerObject) {
    return Object.freeze({ clientKey: reference.clientKey });
  }
  return Object.freeze({ id: reference.id });
}

function isCompatibleCapabilityHost(capability: DetailCapability, element: HtmlElement): boolean {
  const host = element.tagName;
  if (capability.kind === "link") return host === "a";
  if (capability.kind !== "input") return host === "a" || host === "button";
  if (capability.action.kind !== "input") return false;
  const multiple = element.attrs.some((attribute) => attribute.name === "multiple");
  if (capability.action.control === "text") {
    const inputType = attributeValue(element, "type")?.toLowerCase();
    return host === "textarea" || (host === "input" && (inputType === undefined || inputType === "text"));
  }
  return host === "select" && (capability.action.control === "multi_select" ? multiple : !multiple);
}

function isValidCapability(capability: DetailCapability): boolean {
  if (capability.key.trim() === "" || capability.key.includes("\0")) return false;
  if (capability.kind !== "link") {
    const action = capability.action;
    if (action.clientKey === undefined || action.clientKey.trim() === "" || action.clientKey.includes("\0")) return false;
    if (action.sourceLayer === undefined || !isStableReference(capability.sourceNode) || !isStableReference(action.sourceLayer)) return false;
    if (!(action.kind === capability.kind || (action.kind === "navigate" && action.relation === capability.kind))) return false;
    if (action.label.trim() === "") return false;
    if (action.kind === "invoke") return action.interactionText.trim() !== "";
    if (action.kind === "navigate") return true;
    if (action.control === "text") return action.prompt.trim() !== "" && action.options === undefined && action.minimumSelections === undefined;
    if (action.prompt.trim() === "" || action.options === undefined || action.options.length === 0) return false;
    if (action.control === "single_select") return action.minimumSelections === undefined;
    return action.minimumSelections === undefined
      || (Number.isInteger(action.minimumSelections)
        && action.minimumSelections > 0
        && action.minimumSelections <= action.options.length);
  }
  try {
    const url = new URL(capability.href);
    return (url.protocol === "https:" || url.protocol === "http:")
      && url.username === ""
      && url.password === "";
  } catch {
    return false;
  }
}

function isStableReference(reference: NodeReference | LayerReference): boolean {
  if (typeof reference === "number") return Number.isSafeInteger(reference) && reference > 0;
  if (reference instanceof NodeObject || reference instanceof LayerObject) {
    return reference.clientKey.trim() !== "" && !reference.clientKey.includes("\0");
  }
  return Number.isSafeInteger(reference.id) && reference.id > 0;
}

function validateElementSafety(
  componentId: string,
  element: HtmlElement,
  issues: DetailCompilationIssue[],
): void {
  if (new Set(["script", "iframe", "object", "embed", "base", "link", "meta", "form", "style", "template", "svg", "math", "foreignobject", "video", "audio", "source", "track", "picture"]).has(element.tagName)) {
    issues.push(sourceIssue("unsafe_html_element", componentId, element, `<${element.tagName}> is not allowed in Node Detail HTML`));
  }
  const forbiddenAttributes = new Set([
    "href", "src", "srcset", "action", "formaction", "poster", "data", "ping", "background",
    "longdesc", "usemap", "profile", "manifest", "codebase", "archive", "classid",
  ]);
  const reservedAttributes = new Set(["gc", "asset", "data-gc-mount", "data-asset-mount"]);
  for (const attribute of element.attrs) {
    if (reservedAttributes.has(attribute.name)) {
      issues.push(sourceIssue(
        "reserved_binding_attribute",
        componentId,
        element,
        `${attribute.name} is compiler-owned and must be authored through a typed template binding`,
      ));
    }
    if (/^on/i.test(attribute.name) || forbiddenAttributes.has(attribute.name) || attribute.name === "style") {
      issues.push(sourceIssue(
        "unsafe_html_attribute",
        componentId,
        element,
        attribute.name === "style"
          ? "Inline style is not allowed; author component CSS through css``"
          : `${attribute.name} must use a typed gc or asset binding`,
      ));
    }
  }
}

function sourceIssue(
  code: string,
  componentId: string,
  element: HtmlElement,
  message: string,
): DetailCompilationIssue {
  const line = element.line;
  const column = element.column;
  return Object.freeze({ code, componentId, path: `html:${line}:${column}`, line, column, message });
}

function validateAsset(
  componentId: string,
  element: HtmlElement,
  asset: AssetRef,
  issues: DetailCompilationIssue[],
): void {
  if (!isStableIdentity(asset.id)) {
    issues.push(sourceIssue("asset_identity_invalid", componentId, element, "Asset identity must be stable and non-whitespace"));
  }
  if (element.tagName !== "img" && element.tagName !== "span") {
    issues.push(sourceIssue(
      "asset_host_incompatible",
      componentId,
      element,
      `Image asset cannot bind to <${element.tagName}>; use <img> or an explicit inline <span> visual host`,
    ));
  }
  if (!asset.available) {
    issues.push(sourceIssue("asset_unavailable", componentId, element, `Asset ${asset.id} is unavailable`));
  }
  if (!/^[a-f0-9]{64}$/.test(asset.digestSha256)) {
    issues.push(sourceIssue("asset_integrity_invalid", componentId, element, `Asset ${asset.id} needs a lowercase SHA-256 digest`));
  }
  const supportedMedia = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"]);
  if (!asset.sanitized || !supportedMedia.has(asset.mediaType)) {
    issues.push(sourceIssue("asset_representation_unsafe", componentId, element, `Asset ${asset.id} has no supported sanitized representation`));
  }
  const ariaHidden = attributeValue(element, "aria-hidden") === "true";
  const ariaLabel = attributeValue(element, "aria-label")?.trim();
  const hasImageAlt = element.tagName === "img" && element.attrs.some((attribute) => attribute.name === "alt");
  if (!ariaHidden && !ariaLabel && !hasImageAlt) {
    issues.push(sourceIssue(
      "asset_accessibility_required",
      componentId,
      element,
      "An asset host needs alt text, an accessible label, or aria-hidden=\"true\"",
    ));
  }
}

function hasAccessibleName(element: HtmlElement): boolean {
  if (attributeValue(element, "aria-label")?.trim()) return true;
  if (attributeValue(element, "aria-labelledby")?.trim()) return true;
  if (attributeValue(element, "title")?.trim()) return true;
  return descendantText(element).trim() !== "";
}

function attributeValue(element: HtmlElement, name: string): string | undefined {
  return element.attrs.find((attribute) => attribute.name === name)?.value;
}

function descendantText(element: HtmlElement): string {
  return element.childNodes.map((child) => {
    if ("text" in child) return child.text;
    return "tagName" in child ? descendantText(child) : "";
  }).join("");
}

function parseAuthoredHtml(source: string, componentId: string, issues: DetailCompilationIssue[]): HtmlRoot {
  const root: HtmlRoot = { childNodes: [] };
  const stack: (HtmlRoot | HtmlElement)[] = [root];
  const voidElements = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  let cursor = 0;
  while (cursor < source.length) {
    if (source.startsWith("<!--", cursor)) {
      const end = source.indexOf("-->", cursor + 4);
      if (end < 0) {
        addHtmlParseIssue(componentId, source, cursor, "Unclosed HTML comment", issues);
        break;
      }
      currentParent(stack).childNodes.push({ comment: source.slice(cursor + 4, end) });
      cursor = end + 3;
      continue;
    }
    if (source[cursor] !== "<") {
      const next = source.indexOf("<", cursor);
      const end = next < 0 ? source.length : next;
      currentParent(stack).childNodes.push({ text: source.slice(cursor, end) });
      cursor = end;
      continue;
    }
    if (source.startsWith("</", cursor)) {
      const close = source.slice(cursor).match(/^<\/\s*([A-Za-z][A-Za-z0-9:-]*)\s*>/);
      if (close === null) {
        addHtmlParseIssue(componentId, source, cursor, "Malformed closing tag", issues);
        cursor += 1;
        continue;
      }
      const expected = stack.at(-1);
      const tagName = close[1]!.toLowerCase();
      if (expected === undefined || !("tagName" in expected) || expected.tagName !== tagName) {
        addHtmlParseIssue(componentId, source, cursor, `Unexpected closing tag </${tagName}>`, issues);
      } else {
        stack.pop();
      }
      cursor += close[0].length;
      continue;
    }
    if (source.startsWith("<!", cursor) || source.startsWith("<?", cursor)) {
      const end = findTagEnd(source, cursor + 2);
      addHtmlParseIssue(componentId, source, cursor, "Document declarations are not allowed in a Node Detail fragment", issues);
      cursor = end < 0 ? source.length : end + 1;
      continue;
    }
    const end = findTagEnd(source, cursor + 1);
    if (end < 0) {
      addHtmlParseIssue(componentId, source, cursor, "Unclosed opening tag", issues);
      break;
    }
    const raw = source.slice(cursor + 1, end);
    const selfClosing = /\/\s*$/.test(raw);
    const body = selfClosing ? raw.replace(/\/\s*$/, "") : raw;
    const name = body.match(/^\s*([A-Za-z][A-Za-z0-9:-]*)/);
    if (name === null) {
      addHtmlParseIssue(componentId, source, cursor, "Malformed opening tag", issues);
      cursor = end + 1;
      continue;
    }
    const location = sourceLocationAt(source, cursor);
    const tagName = name[1]!.toLowerCase();
    const attrs = parseHtmlAttributes(body.slice(name[0].length), componentId, source, cursor + 1 + name[0].length, issues);
    const element: HtmlElement = { tagName, attrs, childNodes: [], line: location.line, column: location.column };
    currentParent(stack).childNodes.push(element);
    if (!selfClosing && !voidElements.has(tagName)) stack.push(element);
    cursor = end + 1;
  }
  for (const unclosed of stack.slice(1).reverse()) {
    if ("tagName" in unclosed) {
      issues.push(Object.freeze({
        code: "invalid_html",
        componentId,
        path: `html:${unclosed.line}:${unclosed.column}`,
        line: unclosed.line,
        column: unclosed.column,
        message: `Unclosed <${unclosed.tagName}> element`,
      }));
    }
  }
  return root;
}

function findTagEnd(source: string, start: number): number {
  let quote: '"' | "'" | undefined;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  return -1;
}

function parseHtmlAttributes(
  source: string,
  componentId: string,
  fullSource: string,
  sourceOffset: number,
  issues: DetailCompilationIssue[],
): { name: string; value: string }[] {
  const attrs: { name: string; value: string }[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    if (cursor >= source.length) break;
    const nameMatch = source.slice(cursor).match(/^([^\s=<>/"']+)/);
    if (nameMatch === null) {
      addHtmlParseIssue(componentId, fullSource, sourceOffset + cursor, "Malformed HTML attribute", issues);
      cursor += 1;
      continue;
    }
    const name = nameMatch[1]!.toLowerCase();
    cursor += nameMatch[0].length;
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    let value = "";
    if (source[cursor] === "=") {
      cursor += 1;
      while (/\s/.test(source[cursor] ?? "")) cursor += 1;
      const quote = source[cursor];
      if (quote === '"' || quote === "'") {
        const end = source.indexOf(quote, cursor + 1);
        if (end < 0) {
          addHtmlParseIssue(componentId, fullSource, sourceOffset + cursor, `Unclosed ${name} attribute`, issues);
          break;
        }
        value = source.slice(cursor + 1, end);
        cursor = end + 1;
      } else {
        const valueMatch = source.slice(cursor).match(/^([^\s<>`"']+)/);
        if (valueMatch === null) {
          addHtmlParseIssue(componentId, fullSource, sourceOffset + cursor, `Missing ${name} attribute value`, issues);
        } else {
          value = valueMatch[1]!;
          cursor += valueMatch[0].length;
        }
      }
    }
    if (attrs.some((attribute) => attribute.name === name)) {
      addHtmlParseIssue(componentId, fullSource, sourceOffset + cursor, `Duplicate ${name} attribute`, issues);
    } else {
      attrs.push({ name, value });
    }
  }
  return attrs;
}

function currentParent(stack: readonly (HtmlRoot | HtmlElement)[]): HtmlRoot | HtmlElement {
  return stack.at(-1) ?? { childNodes: [] };
}

function serializeHtml(node: HtmlRoot | HtmlElement): string {
  return node.childNodes.map((child) => {
    if ("text" in child) return child.text;
    if ("comment" in child) return `<!--${child.comment}-->`;
    const attrs = child.attrs.map((attribute) => ` ${attribute.name}="${escapeAttribute(attribute.value)}"`).join("");
    const open = `<${child.tagName}${attrs}>`;
    return new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]).has(child.tagName)
      ? open
      : `${open}${serializeHtml(child)}</${child.tagName}>`;
  }).join("");
}

function escapeAttribute(value: string): string {
  return value.replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function addHtmlParseIssue(
  componentId: string,
  source: string,
  offset: number,
  message: string,
  issues: DetailCompilationIssue[],
): void {
  const location = sourceLocationAt(source, offset);
  issues.push(Object.freeze({
    code: "invalid_html",
    componentId,
    path: `html:${location.line}:${location.column}`,
    line: location.line,
    column: location.column,
    message,
  }));
}

function sourceLocationAt(source: string, offset: number): { readonly line: number; readonly column: number } {
  return sourceLocationAtEnd(source.slice(0, offset));
}

function isAssetRef(value: unknown): value is AssetRef {
  return typeof value === "object" && value !== null && DETAIL_ASSET in value;
}

function mountId(kind: "capability" | "asset", componentId: string, key: string): string {
  const digest = createHash("sha256").update(`${kind}\0${componentId}\0${key}`).digest("hex").slice(0, 16);
  return `m_${digest}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
