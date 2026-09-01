import { createHash } from "node:crypto";
import { generate as generateCss, parse as parseCss, tokenTypes, tokenize as tokenizeCss, walk as walkCss, type CssNode, type SyntaxParseError } from "css-tree";
import { parseFragment, serialize, type DefaultTreeAdapterTypes, type ParserError } from "parse5";
import { LayerObject, NodeObject, type ActionObject, type InputActionObject, type InvokeActionObject, type LayerReference, type NavigateActionObject, type NodeReference } from "./objects.js";

const DETAIL_TEMPLATE = Symbol("detail-template");
const DETAIL_CAPABILITY = Symbol("detail-capability");
const DETAIL_ASSET = Symbol("detail-asset");

type TemplateKind = "html" | "css";

export const DETAIL_AUTHORING_LIMITS = Object.freeze({
  maxComponents: 64,
  maxHtmlBytesPerComponent: 256 * 1024,
  maxCssBytesPerComponent: 128 * 1024,
  maxElementsPerComponent: 4_096,
  maxElementDepth: 64,
});

type HtmlRoot = DefaultTreeAdapterTypes.DocumentFragment;
type HtmlElement = DefaultTreeAdapterTypes.Element;

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

export interface AssetRef {
  readonly [DETAIL_ASSET]: true;
  readonly logicalId: string;
}

export interface ResolvedDetailAsset {
  readonly logicalId: string;
  readonly authority: "current" | "stale";
  readonly availability: "available" | "unavailable" | "revoked";
  readonly digestSha256: string;
  readonly mediaType: string;
  readonly representation: { readonly kind: "image"; readonly sanitized: boolean };
}

export interface DetailAssetResolver {
  resolve(reference: AssetRef): ResolvedDetailAsset | undefined;
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

export function assetRef(logicalId: string): AssetRef {
  if (typeof logicalId !== "string") throw new TypeError("assetRef requires one opaque logical asset identity string");
  return Object.freeze({ [DETAIL_ASSET]: true as const, logicalId });
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

  constructor(private readonly assetResolver: DetailAssetResolver = REJECTING_ASSET_RESOLVER) {}

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
    if (this.#components.size > DETAIL_AUTHORING_LIMITS.maxComponents) {
      issues.push(Object.freeze({
        code: "component_limit_exceeded",
        componentId: "",
        path: "component",
        line: 1,
        column: 1,
        message: `Node Detail supports at most ${DETAIL_AUTHORING_LIMITS.maxComponents} components`,
      }));
    }
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
          html: compileHtml(id, component.markup, mounts, assets, issues, this.assetResolver),
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
    strings: Object.freeze([...(kind === "css" ? strings.raw : strings)]),
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
  assetResolver: DetailAssetResolver,
): string {
  if (template[DETAIL_TEMPLATE] !== "html") throw new Error("Node Detail component markup must use html``");
  const source = bindingSource(componentId, template, issues);
  if (Buffer.byteLength(source, "utf8") > DETAIL_AUTHORING_LIMITS.maxHtmlBytesPerComponent) {
    issues.push(Object.freeze({
      code: "html_byte_limit_exceeded",
      componentId,
      path: "html:1:1",
      line: 1,
      column: 1,
      message: `Node Detail component HTML exceeds ${DETAIL_AUTHORING_LIMITS.maxHtmlBytesPerComponent} UTF-8 bytes`,
    }));
    return "";
  }
  const fragment = parseAuthoredHtml(source, componentId, issues);
  if (!validateHtmlTreeLimits(componentId, fragment, issues)) return "";
  const bindingUses = new Uint16Array(template.values.length);
  visitElements(fragment, (element) => {
    validateElementSafety(componentId, element, issues);
    element.attrs.sort(compareAttributes);
    const binding = element.attrs.find((attribute) => attribute.name === "data-relayer-binding");
    if (binding === undefined) return;
    const index = Number(binding.value);
    if (Number.isSafeInteger(index) && index >= 0 && index < bindingUses.length) bindingUses[index] = (bindingUses[index] ?? 0) + 1;
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
      normalizeCapabilityHost(componentId, value, element, issues);
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
      const resolved = assetResolver.resolve(value);
      validateAsset(componentId, element, value, resolved, issues);
      const id = mountId("asset", componentId, value.logicalId);
      element.attrs.push({ name: "data-asset-mount", value: id });
      if (mounts.some((mount) => mount.id === id)) {
        issues.push(sourceIssue("duplicate_mount_identity", componentId, element, `Asset ${value.logicalId} is already bound in this component`));
      } else {
        mounts.push(Object.freeze({ id, componentId, kind: "asset", host: element.tagName, assetId: value.logicalId }));
      }
      const compiledAsset = resolved === undefined ? undefined : Object.freeze({
        id: resolved.logicalId,
        digestSha256: resolved.digestSha256,
        mediaType: resolved.mediaType,
        representation: resolved.representation.kind,
      });
      const existingAsset = assets.get(value.logicalId);
      if (compiledAsset !== undefined && existingAsset !== undefined && canonicalJson(existingAsset) !== canonicalJson(compiledAsset)) {
        issues.push(sourceIssue(
          "asset_identity_conflict",
          componentId,
          element,
          `Asset ${value.logicalId} resolves to conflicting pinned content in this detail`,
        ));
      } else if (compiledAsset !== undefined && existingAsset === undefined) {
        assets.set(value.logicalId, compiledAsset);
      }
    } else {
      issues.push(sourceIssue("binding_type_invalid", componentId, element, "Node Detail binding has the wrong typed value"));
    }
    element.attrs.sort(compareAttributes);
  });
  for (let index = 0; index < bindingUses.length; index += 1) {
    if (bindingUses[index] === 1) continue;
    const location = bindingLocation(template, index);
    issues.push(Object.freeze({
      code: "binding_consumption_invalid",
      componentId,
      path: `html:${location.line}:${location.column}`,
      line: location.line,
      column: location.column,
      message: `Node Detail interpolation ${index + 1} must be consumed by exactly one eligible runtime host`,
    }));
  }
  return serializeHtml(fragment).replace(/\r\n?/g, "\n").trim();
}

function bindingLocation(template: DetailTemplate, bindingIndex: number): { readonly line: number; readonly column: number } {
  let source = "";
  for (let index = 0; index <= bindingIndex; index += 1) source += template.strings[index] ?? "";
  return sourceLocationAtEnd(source);
}

function bindingSource(componentId: string, template: DetailTemplate, issues: DetailCompilationIssue[]): string {
  let source = template.strings[0] ?? "";
  for (let index = 0; index < template.values.length; index += 1) {
    const openTagStart = source.lastIndexOf("<");
    const openTagEnd = source.lastIndexOf(">");
    const openTag = openTagStart > openTagEnd ? source.slice(openTagStart) : "";
    const match = openTag.match(/(?:^|\s)(gc|asset)\s*=\s*$/);
    if (match === null || openTag.startsWith("</") || openTag.startsWith("<!") || htmlAttributeQuote(openTag) !== undefined) {
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
    const absoluteMatch = openTagStart + (match.index ?? 0);
    const leadingWhitespace = match[0].match(/^\s/)?.[0] ?? "";
    source = `${source.slice(0, absoluteMatch)}${leadingWhitespace}data-relayer-binding="${index}"${template.strings[index + 1] ?? ""}`;
  }
  return source;
}

function htmlAttributeQuote(openTag: string): '"' | "'" | undefined {
  let quote: '"' | "'" | undefined;
  for (let index = 1; index < openTag.length; index += 1) {
    const character = openTag[index];
    if (quote === undefined && (character === '"' || character === "'")) quote = character;
    else if (quote === character) quote = undefined;
  }
  return quote;
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
  if (Buffer.byteLength(source, "utf8") > DETAIL_AUTHORING_LIMITS.maxCssBytesPerComponent) {
    issues.push(Object.freeze({
      code: "css_byte_limit_exceeded",
      componentId,
      path: "css:1:1",
      line: 1,
      column: 1,
      message: `Node Detail component CSS exceeds ${DETAIL_AUTHORING_LIMITS.maxCssBytesPerComponent} UTF-8 bytes`,
    }));
    return "";
  }
  if (source === "") return "";
  const structuralError = cssStructuralError(source);
  if (structuralError !== undefined) {
    const location = sourceLocationAt(source, structuralError.offset);
    issues.push(Object.freeze({
      code: "invalid_css",
      componentId,
      path: `css:${location.line}:${location.column}`,
      line: location.line,
      column: location.column,
      message: structuralError.message,
    }));
    return source;
  }
  let ast: CssNode;
  const parseErrors: SyntaxParseError[] = [];
  try {
    ast = parseCss(source, {
      positions: true,
      parseCustomProperty: true,
      onParseError(error) {
        parseErrors.push(error);
      },
    });
  } catch (error) {
    const parsed = error as Partial<SyntaxParseError>;
    const line = parsed.line ?? 1;
    const column = parsed.column ?? 1;
    issues.push(Object.freeze({
      code: "invalid_css",
      componentId,
      path: `css:${line}:${column}`,
      line,
      column,
      message: parsed.message ?? "Node Detail CSS is invalid",
    }));
    return source;
  }
  for (const error of parseErrors) {
    issues.push(Object.freeze({
      code: "invalid_css",
      componentId,
      path: `css:${error.line}:${error.column}`,
      line: error.line,
      column: error.column,
      message: error.message,
    }));
  }
  walkCss(ast, (node) => {
    if (node.type === "Atrule" && !SAFE_CSS_AT_RULES.has(decodeCssIdentifier(node.name).toLowerCase())) {
      addCssIssue(componentId, node, issues, `@${node.name} is not available to authored detail CSS`);
    } else if (node.type === "Url") {
      addCssIssue(componentId, node, issues, "CSS URL resources are not available to authored details");
    } else if (node.type === "Function" && UNSAFE_CSS_FUNCTIONS.has(decodeCssIdentifier(node.name).toLowerCase())) {
      addCssIssue(componentId, node, issues, `${node.name}() can address an external resource or host API`);
    } else if (node.type === "Declaration" && UNSAFE_CSS_PROPERTIES.has(decodeCssIdentifier(node.property).toLowerCase())) {
      addCssIssue(componentId, node, issues, `${node.property} can address an external resource or privileged host behavior`);
    } else if (node.type === "Raw") {
      addCssIssue(componentId, node, issues, "CSS must parse without opaque recovery tokens");
    }
  });
  return generateCss(ast);
}

const SAFE_CSS_AT_RULES = new Set(["container", "keyframes", "layer", "media", "supports"]);
const UNSAFE_CSS_FUNCTIONS = new Set(["element", "env", "expression", "image-set", "paint", "url", "-webkit-image-set"]);
const UNSAFE_CSS_PROPERTIES = new Set(["behavior", "src", "-moz-binding"]);

function decodeCssIdentifier(value: string): string {
  return value.replace(/\\([0-9a-f]{1,6})(?:\s)?|\\(.)/gi, (_match, hex: string | undefined, escaped: string | undefined) => {
    if (hex !== undefined) return String.fromCodePoint(Number.parseInt(hex, 16));
    return escaped ?? "";
  });
}

function cssStructuralError(source: string): { readonly offset: number; readonly message: string } | undefined {
  const expected: { readonly token: number; readonly offset: number }[] = [];
  let failure: { readonly offset: number; readonly message: string } | undefined;
  tokenizeCss(source, (type, start) => {
    if (failure !== undefined) return;
    if (type === tokenTypes.LeftCurlyBracket) expected.push({ token: tokenTypes.RightCurlyBracket, offset: start });
    else if (type === tokenTypes.LeftParenthesis || type === tokenTypes.Function) expected.push({ token: tokenTypes.RightParenthesis, offset: start });
    else if (type === tokenTypes.LeftSquareBracket) expected.push({ token: tokenTypes.RightSquareBracket, offset: start });
    else if (type === tokenTypes.BadString || type === tokenTypes.BadUrl) failure = { offset: start, message: "Node Detail CSS contains an invalid string or URL token" };
    else if (type === tokenTypes.RightCurlyBracket || type === tokenTypes.RightParenthesis || type === tokenTypes.RightSquareBracket) {
      if (expected.pop()?.token !== type) failure = { offset: start, message: "Node Detail CSS contains an unmatched closing delimiter" };
    }
  });
  const unclosed = expected.at(-1);
  return failure ?? (unclosed === undefined ? undefined : { offset: unclosed.offset, message: "Node Detail CSS contains an unclosed delimiter" });
}

function addCssIssue(componentId: string, node: CssNode, issues: DetailCompilationIssue[], message: string): void {
  const line = node.loc?.start.line ?? 1;
  const column = node.loc?.start.column ?? 1;
  issues.push(Object.freeze({
    code: "unsafe_css",
    componentId,
    path: `css:${line}:${column}`,
    line,
    column,
    message,
  }));
}

function visitElements(node: HtmlRoot | HtmlElement, visitor: (element: HtmlElement) => void): void {
  const pending = [...node.childNodes].reverse().map((child) => ({ child, depth: 1 }));
  while (pending.length !== 0) {
    const current = pending.pop()!;
    if (!("tagName" in current.child)) continue;
    visitor(current.child);
    for (let index = current.child.childNodes.length - 1; index >= 0; index -= 1) {
      pending.push({ child: current.child.childNodes[index]!, depth: current.depth + 1 });
    }
  }
}

function validateHtmlTreeLimits(componentId: string, root: HtmlRoot, issues: DetailCompilationIssue[]): boolean {
  const pending = [...root.childNodes].reverse().map((child) => ({ child, depth: 1 }));
  let elements = 0;
  let reportedElements = false;
  let reportedDepth = false;
  while (pending.length !== 0) {
    const current = pending.pop()!;
    if (!("tagName" in current.child)) continue;
    elements += 1;
    if (!reportedElements && elements > DETAIL_AUTHORING_LIMITS.maxElementsPerComponent) {
      issues.push(sourceIssue(
        "html_element_limit_exceeded",
        componentId,
        current.child,
        `Node Detail component exceeds ${DETAIL_AUTHORING_LIMITS.maxElementsPerComponent} elements`,
      ));
      reportedElements = true;
    }
    if (!reportedDepth && current.depth > DETAIL_AUTHORING_LIMITS.maxElementDepth) {
      issues.push(sourceIssue(
        "html_depth_limit_exceeded",
        componentId,
        current.child,
        `Node Detail component exceeds element depth ${DETAIL_AUTHORING_LIMITS.maxElementDepth}`,
      ));
      reportedDepth = true;
    }
    for (let index = current.child.childNodes.length - 1; index >= 0; index -= 1) {
      pending.push({ child: current.child.childNodes[index]!, depth: current.depth + 1 });
    }
  }
  return !reportedElements && !reportedDepth;
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
  if (capability.action.control === "text") {
    const inputType = attributeValue(element, "type")?.toLowerCase();
    return host === "textarea" || (host === "input" && (inputType === undefined || inputType === "text"));
  }
  return host === "select";
}

function normalizeCapabilityHost(
  componentId: string,
  capability: DetailCapability,
  element: HtmlElement,
  issues: DetailCompilationIssue[],
): void {
  if (capability.kind !== "input" || capability.action.kind !== "input") return;
  const hasAuthoredValue = element.childNodes.some((child) => !("value" in child) || child.value.trim() !== "");
  if ((element.tagName === "select" || element.tagName === "textarea") && hasAuthoredValue) {
    issues.push(sourceIssue(
      "runtime_controlled_children",
      componentId,
      element,
      `The ${capability.action.control} input runtime owns this host's value and options`,
    ));
  }
  if (element.tagName === "input") {
    element.attrs = element.attrs.filter((attribute) => attribute.name !== "type");
    element.attrs.push({ name: "type", value: "text" });
  }
  if (element.tagName === "select") {
    element.attrs = element.attrs.filter((attribute) => attribute.name !== "multiple");
    if (capability.action.control === "multi_select") element.attrs.push({ name: "multiple", value: "" });
    element.childNodes.splice(0, element.childNodes.length);
  }
  if (element.tagName === "textarea") element.childNodes.splice(0, element.childNodes.length);
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
  if (!SAFE_HTML_ELEMENTS.has(element.tagName)) {
    issues.push(sourceIssue("unsafe_html_element", componentId, element, `<${element.tagName}> is not allowed in Node Detail HTML`));
  }
  if (INTERACTIVE_HTML_ELEMENTS.has(element.tagName)
    && !element.attrs.some((attribute) => attribute.name === "data-relayer-binding")) {
    issues.push(sourceIssue(
      "interactive_host_requires_capability",
      componentId,
      element,
      `<${element.tagName}> must host one typed gc capability`,
    ));
  }
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
    if (RUNTIME_STATE_ATTRIBUTES.has(attribute.name)) {
      issues.push(sourceIssue(
        "runtime_state_attribute",
        componentId,
        element,
        `${attribute.name} is owned by the typed capability runtime`,
      ));
    } else if (!isAllowedHtmlAttribute(element.tagName, attribute.name)) {
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

const SAFE_HTML_ELEMENTS = new Set([
  "a", "abbr", "article", "aside", "b", "bdi", "bdo", "blockquote", "br", "button", "caption", "cite", "code",
  "col", "colgroup", "data", "dd", "del", "details", "dfn", "div", "dl", "dt", "em", "fieldset", "figcaption",
  "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "i", "img", "input",
  "ins", "kbd", "label", "legend", "li", "main", "mark", "menu", "meter", "nav", "ol", "p", "pre", "q", "rp",
  "rt", "ruby", "s", "samp", "section", "select", "small", "span", "strong", "sub", "summary", "sup", "table",
  "tbody", "td", "textarea", "tfoot", "th", "thead", "time", "tr", "u", "ul", "var", "wbr",
]);

const INTERACTIVE_HTML_ELEMENTS = new Set(["a", "button", "input", "select", "textarea"]);

const GLOBAL_HTML_ATTRIBUTES = new Set([
  "class", "id", "lang", "dir", "role", "title",
  "aria-label", "aria-labelledby", "aria-describedby", "aria-hidden", "aria-current",
]);

const ELEMENT_HTML_ATTRIBUTES: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  col: new Set(["span"]),
  colgroup: new Set(["span"]),
  data: new Set(["value"]),
  img: new Set(["alt", "height", "width"]),
  input: new Set(["type"]),
  label: new Set(["for"]),
  meter: new Set(["min", "max", "low", "high", "optimum", "value"]),
  ol: new Set(["reversed", "start", "type"]),
  q: new Set([]),
  select: new Set(["multiple"]),
  td: new Set(["colspan", "rowspan", "headers"]),
  th: new Set(["colspan", "rowspan", "headers", "scope", "abbr"]),
  time: new Set(["datetime"]),
});

const RUNTIME_STATE_ATTRIBUTES = new Set([
  "autofocus", "checked", "disabled", "download", "form", "formaction", "formenctype", "formmethod", "formnovalidate",
  "formtarget", "name", "option", "options", "readonly", "required", "selected", "target", "value",
  "aria-checked", "aria-disabled", "aria-expanded", "aria-pressed", "aria-selected",
]);

function isAllowedHtmlAttribute(tagName: string, name: string): boolean {
  return name === "data-relayer-binding"
    || GLOBAL_HTML_ATTRIBUTES.has(name)
    || ELEMENT_HTML_ATTRIBUTES[tagName]?.has(name) === true;
}

function sourceIssue(
  code: string,
  componentId: string,
  element: HtmlElement,
  message: string,
): DetailCompilationIssue {
  const line = element.sourceCodeLocation?.startLine ?? 1;
  const column = element.sourceCodeLocation?.startCol ?? 1;
  return Object.freeze({ code, componentId, path: `html:${line}:${column}`, line, column, message });
}

function validateAsset(
  componentId: string,
  element: HtmlElement,
  asset: AssetRef,
  resolved: ResolvedDetailAsset | undefined,
  issues: DetailCompilationIssue[],
): void {
  if (!isStableIdentity(asset.logicalId)) {
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
  if (resolved === undefined) {
    issues.push(sourceIssue("asset_unknown", componentId, element, `Asset ${asset.logicalId} is unknown to the current resolver`));
    return;
  }
  if (resolved.logicalId !== asset.logicalId || resolved.authority !== "current") {
    issues.push(sourceIssue("asset_authority_mismatch", componentId, element, `Asset ${asset.logicalId} is not resolved by current matching authority`));
  }
  if (resolved.availability !== "available") {
    issues.push(sourceIssue("asset_unavailable", componentId, element, `Asset ${asset.logicalId} is ${resolved.availability}`));
  }
  if (!/^[a-f0-9]{64}$/.test(resolved.digestSha256)) {
    issues.push(sourceIssue("asset_integrity_invalid", componentId, element, `Asset ${asset.logicalId} needs a resolver-pinned lowercase SHA-256 digest`));
  }
  const supportedMedia = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"]);
  if (!resolved.representation.sanitized || !supportedMedia.has(resolved.mediaType)) {
    issues.push(sourceIssue("asset_representation_unsafe", componentId, element, `Asset ${asset.logicalId} has no supported sanitized representation`));
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

const REJECTING_ASSET_RESOLVER: DetailAssetResolver = Object.freeze({
  resolve: () => undefined,
});

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
    if ("value" in child) return child.value;
    return "tagName" in child ? descendantText(child) : "";
  }).join("");
}

function parseAuthoredHtml(source: string, componentId: string, issues: DetailCompilationIssue[]): HtmlRoot {
  return parseFragment(source, {
    sourceCodeLocationInfo: true,
    onParseError(error: ParserError) {
      issues.push(Object.freeze({
        code: "invalid_html",
        componentId,
        path: `html:${error.startLine}:${error.startCol}`,
        line: error.startLine,
        column: error.startCol,
        message: `HTML parser rejected ${error.code}`,
      }));
    },
  });
}

function serializeHtml(node: HtmlRoot | HtmlElement): string {
  return serialize(node);
}

function compareAttributes(left: { readonly name: string }, right: { readonly name: string }): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
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
