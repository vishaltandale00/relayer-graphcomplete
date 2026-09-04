import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";
import { generate as generateCss, parse as parseCss, tokenTypes, tokenize as tokenizeCss, walk as walkCss } from "css-tree/dist/csstree.esm";
import type { CssNode, SyntaxParseError } from "css-tree";
import { parseFragment, serialize, type DefaultTreeAdapterTypes, type ParserError } from "parse5";
import { isSupportedRelayerIcon } from "./icons.js";
import { LayerObject, NodeObject, type ActionObject, type InputActionObject, type InvokeActionObject, type LayerReference, type NavigateActionObject } from "./objects.js";

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
  maxMountsPerPackage: 128,
  maxAssetReferencesPerPackage: 64,
  maxAssetsPerPackage: 32,
  maxCompiledPackageBytes: 512 * 1024,
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
}

export type DetailCapability = ExternalLinkCapability | GraphDetailCapability;

type MaterializedAction = Readonly<Record<string, unknown>>;

interface MaterializedGraphDetailCapability {
  readonly key: string;
  readonly kind: GraphDetailCapability["kind"];
  readonly action: MaterializedAction;
}

interface MaterializedSourceLayer {
  readonly clientKey: string;
  readonly containsOwner: boolean;
}

interface MaterializedLayerTarget {
  readonly kind: "draft" | "accepted" | "id";
  readonly clientKey?: string;
  readonly id?: number;
}

/** @internal */
export interface AuthenticatedNodeDetailOwnerSnapshot {
  readonly object: NodeObject;
  readonly clientKey: string;
}

type MaterializedDetailCapability = ExternalLinkCapability | MaterializedGraphDetailCapability;

interface DetailCapabilityMaterialization {
  readonly matched: boolean;
  readonly capability?: MaterializedDetailCapability;
}

export interface AssetRef {
  readonly [DETAIL_ASSET]: true;
  readonly logicalId: string;
}

interface ResolvedDetailAsset {
  readonly logicalId: string;
  readonly authority: "current" | "stale";
  readonly availability: "available" | "unavailable" | "revoked";
  readonly digestSha256: string;
  readonly mediaType: string;
  readonly representation: { readonly kind: "image"; readonly sanitized: boolean };
}

interface MaterializedAssetRef {
  readonly logicalId: string;
}

interface MaterializedDetailBinding {
  readonly capability: DetailCapabilityMaterialization;
  readonly asset?: MaterializedAssetRef;
}

interface MaterializedDetailTemplate {
  readonly kind: TemplateKind;
  readonly strings: readonly string[];
  readonly bindings: readonly MaterializedDetailBinding[];
}

interface MaterializedAuthoringComponent {
  readonly id: string;
  readonly markup: MaterializedDetailTemplate;
  readonly styles: MaterializedDetailTemplate;
  readonly order: number;
}

/** @internal */
export interface AuthenticatedNodeDetailProgramSnapshot {
  readonly authoring: NodeDetailAuthoring;
  readonly owner: AuthenticatedNodeDetailOwnerSnapshot | undefined;
  readonly components: readonly MaterializedAuthoringComponent[];
  readonly logicalIds: readonly string[];
}

interface DetailAssetResolver {
  readonly missingAssetCode: "asset_resolution_required" | "asset_unknown";
  resolve(reference: MaterializedAssetRef): ResolvedDetailAsset | undefined;
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

/** Validate and snapshot a canonical package retained by the server for an empty resubmission. @internal */
export function snapshotRetainedCompiledNodeDetail(value: unknown): CompiledNodeDetail | undefined {
  if (!isPlainRecordWithKeys(value, ["assets", "components", "integritySha256", "mounts", "version"])) return undefined;
  if (value.version !== 1 || !Array.isArray(value.components) || !Array.isArray(value.mounts) || !Array.isArray(value.assets)) return undefined;
  if (value.components.length > DETAIL_AUTHORING_LIMITS.maxComponents
    || value.mounts.length > DETAIL_AUTHORING_LIMITS.maxMountsPerPackage
    || value.assets.length > DETAIL_AUTHORING_LIMITS.maxAssetsPerPackage) return undefined;

  const componentIds = new Set<string>();
  for (const [index, component] of value.components.entries()) {
    if (!isPlainRecordWithKeys(component, ["css", "html", "id", "order"])
      || !isBoundedIdentity(component.id)
      || component.order !== index
      || typeof component.html !== "string"
      || typeof component.css !== "string"
      || componentIds.has(component.id)) return undefined;
    componentIds.add(component.id);
  }
  const assetIds = new Set<string>();
  for (const asset of value.assets) {
    if (!isPlainRecordWithKeys(asset, ["digestSha256", "id", "mediaType", "representation"])
      || !isBoundedIdentity(asset.id)
      || !isLowerHexDigest(asset.digestSha256)
      || !["image/jpeg", "image/png", "image/svg+xml"].includes(String(asset.mediaType))
      || asset.representation !== "image"
      || assetIds.has(asset.id)) return undefined;
    assetIds.add(asset.id);
  }
  const mountIds = new Set<string>();
  for (const mount of value.mounts) {
    if (!isPlainRecord(mount)
      || !isBoundedIdentity(mount.id)
      || !isBoundedIdentity(mount.host)
      || typeof mount.componentId !== "string"
      || !componentIds.has(mount.componentId)
      || mountIds.has(mount.id)) return undefined;
    mountIds.add(mount.id);
    if (mount.kind === "asset") {
      if (!hasExactKeys(mount, ["assetId", "componentId", "host", "id", "kind"])
        || typeof mount.assetId !== "string"
        || !assetIds.has(mount.assetId)) return undefined;
    } else if (mount.kind === "capability") {
      if (!hasExactKeys(mount, ["capability", "componentId", "host", "id", "kind"])
        || !isCanonicalCapability(mount.capability)) return undefined;
    } else return undefined;
  }
  if (!isLowerHexDigest(value.integritySha256)) return undefined;
  const content = { version: value.version, components: value.components, mounts: value.mounts, assets: value.assets };
  const canonical = canonicalJson(content);
  if (Buffer.byteLength(canonical, "utf8") > DETAIL_AUTHORING_LIMITS.maxCompiledPackageBytes
    || createHash("sha256").update(canonical).digest("hex") !== value.integritySha256) return undefined;
  return deepFreezeJson(JSON.parse(JSON.stringify(value))) as CompiledNodeDetail;
}

function isCanonicalCapability(value: unknown): boolean {
  if (!isPlainRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "link") return hasExactKeys(value, ["href", "kind"]) && typeof value.href === "string";
  if (!["expand", "reference", "invoke", "input"].includes(value.kind)
    || !hasExactKeys(value, ["action", "kind"])
    || !isPlainRecordWithKeys(value.action, ["clientKey", "sourceLayer", "sourceNode"])
    || !isBoundedIdentity(value.action.clientKey)) return false;
  return isStableReference(value.action.sourceLayer) && isStableReference(value.action.sourceNode);
}

function isStableReference(value: unknown): boolean {
  if (!isPlainRecord(value) || Object.keys(value).length === 0
    || Object.keys(value).some((key) => key !== "id" && key !== "clientKey")) return false;
  return (value.id === undefined || (Number.isSafeInteger(value.id) && (value.id as number) > 0))
    && (value.clientKey === undefined || isBoundedIdentity(value.clientKey));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function isPlainRecordWithKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isPlainRecord(value) && hasExactKeys(value, keys);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isBoundedIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value
    && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= 128;
}

function isLowerHexDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function deepFreezeJson(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  for (const child of Object.values(value)) deepFreezeJson(child);
  return Object.freeze(value);
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
  expand(key: string, action: NavigateActionObject & { readonly relation: "expand" }): GraphDetailCapability {
    return graphCapability(key, "expand", action);
  },
  reference(key: string, action: NavigateActionObject & { readonly relation: "reference" }): GraphDetailCapability {
    return graphCapability(key, "reference", action);
  },
  invoke(key: string, action: InvokeActionObject): GraphDetailCapability {
    return graphCapability(key, "invoke", action);
  },
  input(key: string, action: InputActionObject): GraphDetailCapability {
    return graphCapability(key, "input", action);
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

interface AuthoringComponent {
  readonly markup: DetailTemplate;
  readonly styles: DetailTemplate;
  readonly order: number;
}

interface AuthoringState {
  readonly components: Map<string, AuthoringComponent>;
  readonly owner: NodeObject | undefined;
  frozen: boolean;
  finalization: symbol | undefined;
  finalizedDetail: CompiledNodeDetail | undefined;
  /** The author emptied the builder on purpose; the next submit clears the draft's package. */
  cleared: boolean;
}

interface DomIdentityRecord {
  readonly componentId: string;
  readonly element: HtmlElement;
}

const AUTHORING_STATE = new WeakMap<NodeDetailAuthoring, AuthoringState>();

export class NodeDetailAuthoring {
  constructor() {
    AUTHORING_STATE.set(this, {
      components: new Map(),
      owner: undefined,
      frozen: false,
      finalization: undefined,
      finalizedDetail: undefined,
      cleared: false,
    });
  }

  setComponent(id: string, markup: DetailTemplate, styles: DetailTemplate = emptyCssTemplate()): this {
    const state = authoringState(this);
    if (state.frozen) throw new Error("Node Detail authoring is finalized and cannot be mutated");
    const existing = state.components.get(id);
    state.components.set(id, { markup, styles, order: existing?.order ?? state.components.size });
    state.cleared = false;
    return this;
  }

  /**
   * Remove every component and ask the graph to drop this draft's checkpointed
   * package on the next submit. An untouched empty builder never clears; only an
   * explicit call does. Authoring again after `clear()` submits a package instead.
   */
  clear(): this {
    const state = authoringState(this);
    if (state.frozen) throw new Error("Node Detail authoring is finalized and cannot be mutated");
    state.components.clear();
    state.cleared = true;
    return this;
  }

  checkpoint(): CompiledNodeDetail {
    const state = authoringState(this);
    if (state.finalizedDetail !== undefined) return state.finalizedDetail;
    const program = snapshotAuthoredNodeDetailProgram(this, safeMaterializeOwner(state.owner));
    return compileAuthoring(program, REJECTING_ASSET_RESOLVER);
  }
}

/** @internal */
export function createOwnedNodeDetailAuthoring(owner: NodeObject): NodeDetailAuthoring {
  const authoring = new NodeDetailAuthoring();
  AUTHORING_STATE.set(authoring, {
    components: new Map(),
    owner,
    frozen: false,
    finalization: undefined,
    finalizedDetail: undefined,
    cleared: false,
  });
  return authoring;
}

/** @internal */
export function isNodeDetailAuthoringOwner(authoring: NodeDetailAuthoring, owner: NodeObject): boolean {
  return AUTHORING_STATE.get(authoring)?.owner === owner;
}

/** @internal */
export function snapshotAuthoredNodeDetailProgram(
  authoring: NodeDetailAuthoring,
  owner: AuthenticatedNodeDetailOwnerSnapshot | undefined,
): AuthenticatedNodeDetailProgramSnapshot {
  let state: AuthoringState;
  try {
    state = authoringState(authoring);
  } catch {
    return invalidNodeDetailProgram("node_envelope_invalid", "", "node", "Node Detail authoring must be owned by the submitted node");
  }
  if (owner !== undefined && state.owner !== owner.object) {
    return invalidNodeDetailProgram("node_envelope_invalid", "", "node", "Node Detail authoring must be owned by the submitted node");
  }
  const ids = new Set<string>();
  const referencesByObject = new Map<object, MaterializedAssetRef>();
  const invalidReferences = new Set<object>();
  const issues: DetailCompilationIssue[] = [];
  let references = 0;
  const components = Object.freeze([...state.components.entries()].map(([componentId, component]) => {
    const id = typeof componentId === "string" ? componentId : "";
    const markup = materializeDetailTemplate(id, component.markup, "html", owner, referencesByObject, invalidReferences, ids, issues);
    references += markup.bindings.filter((_binding, index) => bindingKind(markup, index) === "asset").length;
    const styles = materializeDetailTemplate(id, component.styles, "css", owner, referencesByObject, invalidReferences, ids, issues);
    return Object.freeze({ id, markup, styles, order: component.order });
  }));
  if (references > DETAIL_AUTHORING_LIMITS.maxAssetReferencesPerPackage) {
    issues.push(Object.freeze({
      code: "asset_reference_limit_exceeded",
      componentId: "",
      path: "asset",
      line: 1,
      column: 1,
      message: `Node Detail supports at most ${DETAIL_AUTHORING_LIMITS.maxAssetReferencesPerPackage} asset references`,
    }));
  }
  if (ids.size > DETAIL_AUTHORING_LIMITS.maxAssetsPerPackage) {
    issues.push(Object.freeze({
      code: "asset_package_limit_exceeded",
      componentId: "",
      path: "asset",
      line: 1,
      column: 1,
      message: `Node Detail supports at most ${DETAIL_AUTHORING_LIMITS.maxAssetsPerPackage} logical assets`,
    }));
  }
  if (issues.length !== 0) throw new DetailCompilationError(Object.freeze(issues));
  return Object.freeze({
    authoring,
    owner,
    components,
    logicalIds: Object.freeze([...ids]),
  });
}

function invalidNodeDetailProgram(code: string, componentId: string, path: string, message: string): never {
  throw new DetailCompilationError(Object.freeze([Object.freeze({
    code,
    componentId,
    path,
    line: 1,
    column: 1,
    message,
  })]));
}

function materializeDetailTemplate(
  componentId: string,
  value: unknown,
  expectedKind: TemplateKind,
  owner: AuthenticatedNodeDetailOwnerSnapshot | undefined,
  referencesByObject: Map<object, MaterializedAssetRef>,
  invalidReferences: Set<object>,
  assetIds: Set<string>,
  issues: DetailCompilationIssue[],
): MaterializedDetailTemplate {
  try {
    if (typeof value !== "object" || value === null || isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      return invalidDetailTemplate(componentId, expectedKind, issues);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<PropertyKey, PropertyDescriptor>;
    const allowed = new Set<PropertyKey>([DETAIL_TEMPLATE, "strings", "values"]);
    if (Reflect.ownKeys(descriptors).length !== allowed.size || !hasExactDescriptorFields(descriptors, allowed)) {
      return invalidDetailTemplate(componentId, expectedKind, issues);
    }
    const kind = ownCapabilityData(descriptors, DETAIL_TEMPLATE);
    const stringsValue = ownCapabilityData(descriptors, "strings");
    const valuesValue = ownCapabilityData(descriptors, "values");
    if (kind !== expectedKind) return invalidDetailTemplate(componentId, expectedKind, issues);
    const stringItems = materializeOrdinaryArray(stringsValue);
    const valueItems = materializeOrdinaryArray(valuesValue);
    if (stringItems === undefined
      || valueItems === undefined
      || stringItems.length !== valueItems.length + 1
      || stringItems.some((part) => typeof part !== "string")) {
      return invalidDetailTemplate(componentId, expectedKind, issues);
    }
    const strings = Object.freeze(stringItems as string[]);
    const shell = { kind: expectedKind, strings, bindings: Object.freeze([]) } satisfies MaterializedDetailTemplate;
    const bindings = Object.freeze(valueItems.map((bindingValue, index): MaterializedDetailBinding => {
      const kindAtBinding = bindingKind(shell, index);
      if (expectedKind !== "html" || kindAtBinding === undefined) {
        return Object.freeze({ capability: Object.freeze({ matched: false }) });
      }
      if (kindAtBinding === "gc") {
        return Object.freeze({ capability: safeMaterializeDetailCapability(bindingValue, owner?.object) });
      }
      const asset = materializeAssetReference(bindingValue, referencesByObject, invalidReferences);
      const location = bindingLocation(shell, index);
      if (asset === undefined) {
        issues.push(Object.freeze({
          code: "asset_reference_invalid",
          componentId,
          path: `html:${location.line}:${location.column}`,
          line: location.line,
          column: location.column,
          message: "Asset references must contain ordinary own data properties",
        }));
        return Object.freeze({ capability: Object.freeze({ matched: false }) });
      }
      if (!isStableIdentity(asset.logicalId)) {
        issues.push(Object.freeze({
          code: "asset_identity_invalid",
          componentId,
          path: `html:${location.line}:${location.column}`,
          line: location.line,
          column: location.column,
          message: "Asset identity must be trimmed, NUL-free, and at most 128 UTF-8 bytes",
        }));
      } else assetIds.add(asset.logicalId);
      return Object.freeze({ capability: Object.freeze({ matched: false }), asset });
    }));
    return Object.freeze({ kind: expectedKind, strings, bindings });
  } catch {
    return invalidDetailTemplate(componentId, expectedKind, issues);
  }
}

function invalidDetailTemplate(
  componentId: string,
  kind: TemplateKind,
  issues: DetailCompilationIssue[],
): MaterializedDetailTemplate {
  issues.push(Object.freeze({
    code: "template_invalid",
    componentId,
    path: `${kind}:1:1`,
    line: 1,
    column: 1,
    message: `Node Detail ${kind.toUpperCase()} templates must contain exact ordinary own data properties and arrays`,
  }));
  return Object.freeze({ kind, strings: Object.freeze([""]), bindings: Object.freeze([]) });
}

function materializeOrdinaryArray(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>;
  const lengthDescriptor = descriptors.length;
  if (lengthDescriptor === undefined
    || !("value" in lengthDescriptor)
    || typeof lengthDescriptor.value !== "number"
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
    || lengthDescriptor.enumerable !== false) return undefined;
  const expected = new Set<PropertyKey>(["length"]);
  const result: unknown[] = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const field = String(index);
    expected.add(field);
    const descriptor = descriptors[field];
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) return undefined;
    result.push(descriptor.value);
  }
  if (Reflect.ownKeys(descriptors).some((field) => !expected.has(field))) return undefined;
  return result;
}

function materializeAssetReference(
  value: unknown,
  references: Map<object, MaterializedAssetRef>,
  invalidReferences: Set<object>,
): MaterializedAssetRef | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (isProxy(value)) return undefined;
  const existing = references.get(value);
  if (existing !== undefined) return existing;
  if (invalidReferences.has(value)) return undefined;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      invalidReferences.add(value);
      return undefined;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<PropertyKey, PropertyDescriptor>;
    const fields = Reflect.ownKeys(descriptors);
    const brand = descriptors[DETAIL_ASSET];
    const logicalId = descriptors.logicalId;
    if (fields.length !== 2
      || !fields.includes(DETAIL_ASSET)
      || !fields.includes("logicalId")
      || brand === undefined
      || !("value" in brand)
      || brand.value !== true
      || brand.enumerable !== true
      || logicalId === undefined
      || !("value" in logicalId)
      || logicalId.enumerable !== true
      || typeof logicalId.value !== "string") {
      invalidReferences.add(value);
      return undefined;
    }
    const materialized = Object.freeze({ logicalId: logicalId.value });
    references.set(value, materialized);
    return materialized;
  } catch {
    invalidReferences.add(value);
    return undefined;
  }
}

/** @internal */
export function compileAuthenticatedNodeDetail(
  program: AuthenticatedNodeDetailProgramSnapshot,
  assets: readonly (ResolvedDetailAsset | null)[],
): CompiledNodeDetail {
  const logicalIds = program.logicalIds;
  const resolvedByLogicalId = new Map(logicalIds.map((logicalId, index) => [logicalId, assets[index] ?? undefined]));
  return compileAuthoring(program, {
    missingAssetCode: "asset_unknown",
    resolve: (reference) => resolvedByLogicalId.get(reference.logicalId),
  });
}

/** @internal */
export function freezeNodeDetailAuthoring(authoring: NodeDetailAuthoring, detail: CompiledNodeDetail): void {
  const state = authoringState(authoring);
  state.frozen = true;
  state.finalization = undefined;
  state.finalizedDetail = detail;
}

/** Return the immutable package already compiled for this exact builder. @internal */
export function finalizedNodeDetailAuthoring(authoring: NodeDetailAuthoring): CompiledNodeDetail | undefined {
  return authoringState(authoring).finalizedDetail;
}

/** Whether the author explicitly emptied this builder since it last held a component. @internal */
export function isNodeDetailAuthoringCleared(authoring: NodeDetailAuthoring): boolean {
  return authoringState(authoring).cleared;
}

/** @internal */
export function beginNodeDetailAuthoringFinalization(authoring: NodeDetailAuthoring): symbol {
  const state = authoringState(authoring);
  if (state.frozen) throw new Error("Node Detail authoring is finalized and cannot be mutated");
  const finalization = Symbol("node-detail-finalization");
  state.frozen = true;
  state.finalization = finalization;
  return finalization;
}

/** @internal */
export function cancelNodeDetailAuthoringFinalization(
  authoring: NodeDetailAuthoring,
  finalization: symbol,
): void {
  const state = authoringState(authoring);
  if (state.finalization !== finalization) return;
  state.finalization = undefined;
  state.frozen = false;
}

function authoringState(authoring: NodeDetailAuthoring): AuthoringState {
  const state = AUTHORING_STATE.get(authoring);
  if (state === undefined) throw new TypeError("Unknown Node Detail authoring object");
  return state;
}

function compileAuthoring(
  program: AuthenticatedNodeDetailProgramSnapshot,
  assetResolver: DetailAssetResolver,
): CompiledNodeDetail {
  const owner = program.owner;
  const mounts: CompiledDetailMount[] = [];
  const assets = new Map<string, CompiledAsset>();
  const issues: DetailCompilationIssue[] = [];
  const authoredTemplateBytes = program.components.reduce(
    (total, component) => total
      + component.markup.strings.reduce((sum, part) => sum + Buffer.byteLength(part, "utf8"), 0)
      + component.styles.strings.reduce((sum, part) => sum + Buffer.byteLength(part, "utf8"), 0),
    0,
  );
  if (authoredTemplateBytes > DETAIL_AUTHORING_LIMITS.maxCompiledPackageBytes) {
    throw compiledPackageByteLimitError();
  }
  if (program.components.length > DETAIL_AUTHORING_LIMITS.maxComponents) {
    issues.push(Object.freeze({
      code: "component_limit_exceeded",
      componentId: "",
      path: "component",
      line: 1,
      column: 1,
      message: `Node Detail supports at most ${DETAIL_AUTHORING_LIMITS.maxComponents} components`,
    }));
  }
  const domIdentities = collectDomIdentities(program.components, issues);
  const components = Object.freeze([...program.components]
    .sort((left, right) => left.order - right.order)
    .map((component) => {
      const id = component.id;
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
        html: compileHtml(id, component.markup, mounts, assets, issues, assetResolver, owner, domIdentities),
        css: compileCss(id, component.styles, issues),
      });
    }));
  if (mounts.length > DETAIL_AUTHORING_LIMITS.maxMountsPerPackage) {
    issues.push(Object.freeze({
      code: "mount_limit_exceeded",
      componentId: "",
      path: "mount",
      line: 1,
      column: 1,
      message: `Node Detail supports at most ${DETAIL_AUTHORING_LIMITS.maxMountsPerPackage} mounts`,
    }));
  }
  if (issues.length !== 0) throw new DetailCompilationError(Object.freeze(issues));
  const content = Object.freeze({
    version: 1 as const,
    components,
    mounts: Object.freeze(mounts),
    assets: Object.freeze([...assets.values()]),
  });
  const compiled = Object.freeze({
    ...content,
    integritySha256: createHash("sha256").update(canonicalJson(content)).digest("hex"),
  });
  if (Buffer.byteLength(canonicalJson(compiled), "utf8") > DETAIL_AUTHORING_LIMITS.maxCompiledPackageBytes) {
    throw compiledPackageByteLimitError();
  }
  return compiled;
}

function compiledPackageByteLimitError(): DetailCompilationError {
  return new DetailCompilationError(Object.freeze([Object.freeze({
    code: "compiled_package_byte_limit_exceeded",
    componentId: "",
    path: "package",
    line: 1,
    column: 1,
    message: `Compiled Node Detail exceeds ${DETAIL_AUTHORING_LIMITS.maxCompiledPackageBytes} UTF-8 bytes`,
  })]));
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
  template: MaterializedDetailTemplate,
  mounts: CompiledDetailMount[],
  assets: Map<string, CompiledAsset>,
  issues: DetailCompilationIssue[],
  assetResolver: DetailAssetResolver,
  owner: AuthenticatedNodeDetailOwnerSnapshot | undefined,
  domIdentities: ReadonlyMap<string, DomIdentityRecord>,
): string {
  if (template.kind !== "html") return "";
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
  const bindingUses = new Uint16Array(template.bindings.length);
  const assetOccurrences = new Map<string, number>();
  visitElements(fragment, (element) => {
    validateElementSafety(componentId, element, issues);
    element.attrs.sort(compareAttributes);
    const binding = element.attrs.find((attribute) => attribute.name === "data-relayer-binding");
    if (binding === undefined) return;
    const index = Number(binding.value);
    if (Number.isSafeInteger(index) && index >= 0 && index < bindingUses.length) bindingUses[index] = (bindingUses[index] ?? 0) + 1;
    const authoredBinding = template.bindings[index];
    element.attrs = element.attrs.filter((attribute) => attribute !== binding);
    const asset = authoredBinding?.asset;
    const materialization = authoredBinding?.capability ?? Object.freeze({ matched: false });
    if (materialization.matched) {
      const materializedCapability = materialization.capability;
      if (materializedCapability === undefined) {
        issues.push(sourceIssue("capability_invalid", componentId, element, "Invalid capability declaration: capability_invalid"));
        return;
      }
      const validationCodes = safeCapabilityValidationCodes(materializedCapability, owner?.clientKey);
      const validCapability = validationCodes.length === 0;
      if (!validCapability) {
        for (const code of validationCodes) {
          issues.push(sourceIssue(code, componentId, element, `Invalid ${materializedCapability.kind} capability declaration: ${code}`));
        }
      }
      if (validCapability && !isCompatibleCapabilityHost(materializedCapability!, element)) {
        issues.push(sourceIssue(
          "capability_host_incompatible",
          componentId,
          element,
          `${materializedCapability.kind} capability cannot bind to <${element.tagName}>`,
        ));
      }
      if (!hasAccessibleName(element, fragment, domIdentities)) {
        issues.push(sourceIssue(
          "accessibility_name_required",
          componentId,
          element,
          `The <${element.tagName}> capability host needs an authored accessible name`,
        ));
      }
      if (validCapability) normalizeCapabilityHost(componentId, materializedCapability!, element, issues);
      const id = mountId("capability", componentId, materializedCapability.key);
      element.attrs.push({ name: "data-gc-mount", value: id });
      const duplicateMount = mounts.some((mount) => mount.id === id);
      if (duplicateMount) {
        issues.push(sourceIssue("duplicate_mount_identity", componentId, element, `Binding key ${materializedCapability.key} is already used in this component`));
      } else if (validCapability) {
        mounts.push(Object.freeze({
          id,
          componentId,
          kind: "capability",
          host: element.tagName,
          capability: compileCapability(materializedCapability, owner?.clientKey ?? ""),
        }));
      }
    } else {
      if (asset === undefined) {
        issues.push(sourceIssue("binding_type_invalid", componentId, element, "Node Detail binding has the wrong typed value"));
        element.attrs.sort(compareAttributes);
        return;
      }
      const resolved = assetResolver.resolve(asset);
      validateAsset(componentId, element, asset, resolved, assetResolver.missingAssetCode, issues);
      const occurrence = assetOccurrences.get(asset.logicalId) ?? 0;
      assetOccurrences.set(asset.logicalId, occurrence + 1);
      const id = mountId("asset", componentId, asset.logicalId, occurrence);
      element.attrs.push({ name: "data-asset-mount", value: id });
      mounts.push(Object.freeze({ id, componentId, kind: "asset", host: element.tagName, assetId: asset.logicalId }));
      const compiledAsset = resolved === undefined ? undefined : Object.freeze({
        id: resolved.logicalId,
        digestSha256: resolved.digestSha256,
        mediaType: resolved.mediaType,
        representation: resolved.representation.kind,
      });
      const existingAsset = assets.get(asset.logicalId);
      if (compiledAsset !== undefined && existingAsset !== undefined && canonicalJson(existingAsset) !== canonicalJson(compiledAsset)) {
        issues.push(sourceIssue(
          "asset_identity_conflict",
          componentId,
          element,
          `Asset ${asset.logicalId} resolves to conflicting pinned content in this detail`,
        ));
      } else if (compiledAsset !== undefined && existingAsset === undefined) {
        assets.set(asset.logicalId, compiledAsset);
      }
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

function collectDomIdentities(
  components: readonly MaterializedAuthoringComponent[],
  issues: DetailCompilationIssue[],
): ReadonlyMap<string, DomIdentityRecord> {
  const identities = new Map<string, DomIdentityRecord>();
  const duplicates = new Set<string>();
  for (const component of components) {
    const componentId = component.id;
    const scratchIssues: DetailCompilationIssue[] = [];
    const source = bindingSource(componentId, component.markup, scratchIssues);
    const fragment = parseAuthoredHtml(source, componentId, scratchIssues);
    visitElements(fragment, (element) => {
      const id = attributeValue(element, "id");
      if (id === undefined || !isStableDomIdentity(id)) return;
      if (duplicates.has(id) || identities.has(id)) {
        identities.delete(id);
        duplicates.add(id);
        issues.push(sourceIssue(
          "dom_id_duplicate",
          componentId,
          element,
          `DOM id ${id} must be unique across the complete authored detail`,
        ));
        return;
      }
      identities.set(id, Object.freeze({ componentId, element }));
    });
  }
  return identities;
}

function bindingLocation(template: MaterializedDetailTemplate, bindingIndex: number): { readonly line: number; readonly column: number } {
  let source = "";
  for (let index = 0; index <= bindingIndex; index += 1) source += template.strings[index] ?? "";
  return sourceLocationAtEnd(source);
}

function bindingKind(template: MaterializedDetailTemplate, bindingIndex: number): "gc" | "asset" | undefined {
  const match = (template.strings[bindingIndex] ?? "").match(/(?:^|\s)(gc|asset)\s*=\s*$/);
  return match?.[1] === "gc" || match?.[1] === "asset" ? match[1] : undefined;
}

function bindingSource(componentId: string, template: MaterializedDetailTemplate, issues: DetailCompilationIssue[]): string {
  let source = template.strings[0] ?? "";
  for (let index = 0; index < template.bindings.length; index += 1) {
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
    const authoredBinding = template.bindings[index];
    if (match[1] === "gc" && authoredBinding?.capability.matched !== true) {
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

function isStableIdentity(value: unknown): value is string {
  return typeof value === "string"
    && value.trim() === value
    && value !== ""
    && !value.includes("\0")
    && Buffer.byteLength(value, "utf8") <= 128;
}

function compileCss(componentId: string, template: MaterializedDetailTemplate, issues: DetailCompilationIssue[]): string {
  if (template.kind !== "css") return "";
  if (template.bindings.length !== 0) {
    issues.push(Object.freeze({
      code: "css_interpolation_not_allowed",
      componentId,
      path: "css:1:1",
      line: 1,
      column: 1,
      message: "Node Detail CSS does not accept interpolated values",
    }));
    return "";
  }
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
    if (node.type === "PseudoClassSelector" && !SAFE_CSS_PSEUDO_CLASSES.has(decodeCssIdentifier(node.name).toLowerCase())) {
      addCssSelectorIssue(componentId, node, issues, `:${node.name} is not in the authored detail selector allowlist`);
    } else if (node.type === "PseudoElementSelector" && !SAFE_CSS_PSEUDO_ELEMENTS.has(decodeCssIdentifier(node.name).toLowerCase())) {
      addCssSelectorIssue(componentId, node, issues, `::${node.name} is not in the authored detail selector allowlist`);
    } else if (node.type === "Atrule" && !SAFE_CSS_AT_RULES.has(decodeCssIdentifier(node.name).toLowerCase())) {
      addCssIssue(componentId, node, issues, `@${node.name} is not available to authored detail CSS`);
    } else if (node.type === "Url") {
      addCssIssue(componentId, node, issues, "CSS URL resources are not available to authored details");
    } else if (node.type === "Function" && !SAFE_CSS_FUNCTIONS.has(decodeCssIdentifier(node.name).toLowerCase())) {
      addCssIssue(componentId, node, issues, `${node.name}() is not in the authored detail CSS function allowlist`);
    } else if (node.type === "Declaration" && !isSafeCssProperty(node.property)) {
      addCssIssue(componentId, node, issues, `${node.property} is not in the authored detail CSS property allowlist`);
    } else if (node.type === "Raw") {
      addCssIssue(componentId, node, issues, "CSS must parse without opaque recovery tokens");
    }
  });
  return generateCss(ast);
}

const SAFE_CSS_AT_RULES = new Set(["container", "keyframes", "layer", "media", "supports"]);
const SAFE_CSS_PSEUDO_CLASSES = new Set([
  "active", "checked", "disabled", "empty", "enabled", "first-child", "first-of-type", "focus", "focus-visible",
  "focus-within", "hover", "in-range", "indeterminate", "invalid", "is", "last-child", "last-of-type", "not",
  "nth-child", "nth-last-child", "nth-last-of-type", "nth-of-type", "only-child", "only-of-type", "optional",
  "out-of-range", "placeholder-shown", "read-only", "read-write", "required", "root", "valid", "where",
]);
const SAFE_CSS_PSEUDO_ELEMENTS = new Set(["after", "before", "first-letter", "first-line", "marker", "placeholder", "selection"]);
const SAFE_CSS_FUNCTIONS = new Set([
  "calc", "clamp", "max", "min", "minmax", "repeat", "fit-content", "var",
  "rgb", "rgba", "hsl", "hsla", "hwb", "lab", "lch", "oklab", "oklch", "color",
  "matrix", "matrix3d", "perspective", "rotate", "rotate3d", "rotatex", "rotatey", "rotatez",
  "scale", "scale3d", "scalex", "scaley", "scalez", "skew", "skewx", "skewy",
  "translate", "translate3d", "translatex", "translatey", "translatez", "cubic-bezier", "steps",
]);
const SAFE_CSS_PROPERTIES = new Set([
  "align-content", "align-items", "align-self", "animation", "animation-delay", "animation-direction",
  "animation-duration", "animation-fill-mode", "animation-iteration-count", "animation-name", "animation-play-state",
  "animation-timing-function", "aspect-ratio", "background-color", "border", "border-block", "border-block-color",
  "border-block-end", "border-block-start", "border-block-style", "border-block-width", "border-bottom",
  "border-bottom-color", "border-bottom-left-radius", "border-bottom-right-radius", "border-bottom-style",
  "border-bottom-width", "border-color", "border-inline", "border-inline-color", "border-inline-end",
  "border-inline-start", "border-inline-style", "border-inline-width", "border-left", "border-left-color",
  "border-left-style", "border-left-width", "border-radius", "border-right", "border-right-color",
  "border-right-style", "border-right-width", "border-style", "border-top", "border-top-color",
  "border-top-left-radius", "border-top-right-radius", "border-top-style", "border-top-width", "border-width",
  "box-shadow", "box-sizing", "break-after", "break-before", "break-inside", "clear", "color", "column-count",
  "column-gap", "column-rule", "column-rule-color", "column-rule-style", "column-rule-width", "column-width",
  "columns", "contain", "container", "container-name", "container-type", "display", "flex", "flex-basis",
  "flex-direction", "flex-flow", "flex-grow", "flex-shrink", "flex-wrap", "float", "font", "font-family",
  "font-feature-settings", "font-kerning", "font-optical-sizing", "font-size", "font-stretch", "font-style",
  "font-variant", "font-variant-caps", "font-weight", "gap", "grid", "grid-area", "grid-auto-columns",
  "grid-auto-flow", "grid-auto-rows", "grid-column", "grid-column-end", "grid-column-gap", "grid-column-start",
  "grid-gap", "grid-row", "grid-row-end", "grid-row-gap", "grid-row-start", "grid-template",
  "grid-template-areas", "grid-template-columns", "grid-template-rows", "height", "hyphens", "inset",
  "inset-block", "inset-block-end", "inset-block-start", "inset-inline", "inset-inline-end", "inset-inline-start",
  "isolation", "justify-content", "justify-items", "justify-self", "left", "letter-spacing", "line-height",
  "list-style", "list-style-position", "list-style-type", "margin", "margin-block", "margin-block-end",
  "margin-block-start", "margin-bottom", "margin-inline", "margin-inline-end", "margin-inline-start", "margin-left",
  "margin-right", "margin-top", "max-height", "max-width", "min-height", "min-width", "object-fit",
  "object-position", "opacity", "order", "outline", "outline-color", "outline-offset", "outline-style",
  "outline-width", "overflow", "overflow-wrap", "overflow-x", "overflow-y", "padding", "padding-block",
  "padding-block-end", "padding-block-start", "padding-bottom", "padding-inline", "padding-inline-end",
  "padding-inline-start", "padding-left", "padding-right", "padding-top", "place-content", "place-items",
  "place-self", "position", "right", "row-gap", "table-layout", "text-align", "text-decoration",
  "text-decoration-color", "text-decoration-line", "text-decoration-style", "text-indent", "text-overflow",
  "text-transform", "top", "transform", "transform-origin", "transition", "transition-delay", "transition-duration",
  "transition-property", "transition-timing-function", "vertical-align", "visibility", "white-space", "width",
  "word-break", "word-spacing", "writing-mode", "z-index",
]);

function isSafeCssProperty(property: string): boolean {
  const decoded = decodeCssIdentifier(property).toLowerCase();
  return decoded.startsWith("--") || SAFE_CSS_PROPERTIES.has(decoded);
}

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

function addCssSelectorIssue(componentId: string, node: CssNode, issues: DetailCompilationIssue[], message: string): void {
  const line = node.loc?.start.line ?? 1;
  const column = node.loc?.start.column ?? 1;
  issues.push(Object.freeze({
    code: "unsafe_css_selector",
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

function graphCapability(
  key: string,
  kind: GraphDetailCapability["kind"],
  action: ActionObject,
): GraphDetailCapability {
  return Object.freeze({ [DETAIL_CAPABILITY]: true as const, key, kind, action });
}

function compileCapability(capability: MaterializedDetailCapability, ownerClientKey: string): CompiledCapabilityMount["capability"] {
  if (capability.kind === "link") return Object.freeze({ kind: capability.kind, href: new URL(capability.href).href });
  const clientKey = capability.action.clientKey;
  const sourceLayer = capability.action.sourceLayer;
  if (typeof clientKey !== "string" || clientKey.trim() === "") {
    throw new Error(`Node Detail ${capability.kind} capability requires an explicit stable action clientKey`);
  }
  if (!isMaterializedSourceLayer(sourceLayer)) {
    throw new Error(`Node Detail ${capability.kind} capability requires exact source-layer provenance`);
  }
  return Object.freeze({
    kind: capability.kind,
    action: Object.freeze({
      clientKey,
      sourceNode: Object.freeze({ clientKey: ownerClientKey }),
      sourceLayer: Object.freeze({ clientKey: sourceLayer.clientKey }),
    }),
  });
}

function isCompatibleCapabilityHost(capability: MaterializedDetailCapability, element: HtmlElement): boolean {
  const host = element.tagName;
  if (capability.kind === "link") return host === "a";
  if (capability.kind !== "input") return host === "a" || host === "button";
  if (typeof capability.action !== "object" || capability.action === null || capability.action.kind !== "input") return false;
  if (capability.action.control === "text") {
    const inputType = attributeValue(element, "type")?.toLowerCase();
    return host === "textarea" || (host === "input" && (inputType === undefined || inputType === "text"));
  }
  return host === "select";
}

function normalizeCapabilityHost(
  componentId: string,
  capability: MaterializedDetailCapability,
  element: HtmlElement,
  issues: DetailCompilationIssue[],
): void {
  if (capability.kind !== "input" || typeof capability.action !== "object" || capability.action === null || capability.action.kind !== "input") return;
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

function capabilityValidationCodes(capability: MaterializedDetailCapability, ownerClientKey: string | undefined): readonly string[] {
  if (!isStableIdentity(capability.key)) return ["capability_invalid"];
  if (capability.kind !== "link") {
    const actionValue: unknown = capability.action;
    if (ownerClientKey === undefined
      || !isStableIdentity(ownerClientKey)
      || typeof actionValue !== "object"
      || actionValue === null) return ["capability_invalid"];
    const action = actionValue as Record<string, unknown>;
    if (!isStableIdentity(action.clientKey)) return ["capability_invalid"];
    if (!isMaterializedSourceLayer(action.sourceLayer) || !isStableIdentity(action.sourceLayer.clientKey)) {
      return ["capability_invalid"];
    }
    if (!action.sourceLayer.containsOwner) return ["capability_source_layer_mismatch"];
    if (!(action.kind === capability.kind || (action.kind === "navigate" && action.relation === capability.kind))) return ["capability_invalid"];
    if (!hasExactActionFields(action) || !hasValidActionPresentation(action)) return ["capability_invalid"];
    if (typeof action.label !== "string" || action.label.trim() === "") return ["capability_invalid"];
    if (action.kind === "invoke") {
      return typeof action.interactionText !== "string" || action.interactionText.trim() === ""
        ? ["capability_invalid"]
        : [];
    }
    if (action.kind === "navigate") return isStableLayerReference(action.target) ? [] : ["capability_invalid"];
    if (action.kind !== "input"
      || (action.control !== "text" && action.control !== "single_select" && action.control !== "multi_select")
      || typeof action.prompt !== "string") return ["capability_invalid"];
    const codes: string[] = [];
    if (action.prompt.trim() === "") codes.push("input_action_prompt_required");
    else if (Buffer.byteLength(action.prompt, "utf8") > 2_000) codes.push("input_action_prompt_too_long");
    if (action.control === "text") {
      if (action.options !== undefined) codes.push("input_action_options_unexpected");
      if (action.minimumSelections !== undefined) codes.push("input_action_minimum_unexpected");
      return codes;
    }
    if (!Array.isArray(action.options)) return ["capability_invalid"];
    if (action.options.length === 0) {
      codes.push("input_action_options_required");
    } else {
      if (action.options.length > 50) codes.push("input_action_option_count");
      const keys = new Set<string>();
      for (const option of action.options) {
        if (typeof option !== "object" || option === null) return ["capability_invalid"];
        const optionRecord = option as Record<string, unknown>;
        if (!hasOnlyEnumerableFields(optionRecord, ["key", "label"])
          || typeof optionRecord.key !== "string"
          || typeof optionRecord.label !== "string") return ["capability_invalid"];
        const optionKey = optionRecord.key;
        const optionLabel = optionRecord.label;
        if (optionKey === ""
          || optionKey.trim() !== optionKey
          || optionKey.includes("\0")
          || Buffer.byteLength(optionKey, "utf8") > 128) {
          codes.push("input_action_option_key_invalid");
        } else if (keys.has(optionKey)) {
          codes.push("input_action_option_key_duplicate");
        } else {
          keys.add(optionKey);
        }
        if (optionLabel.trim() === "") codes.push("input_action_option_label_required");
        else if (Buffer.byteLength(optionLabel, "utf8") > 512) codes.push("input_action_option_label_too_long");
      }
    }
    if (action.control === "single_select" && action.minimumSelections !== undefined) {
      codes.push("input_action_minimum_unexpected");
    } else if (action.control === "multi_select"
      && action.minimumSelections !== undefined
      && (typeof action.minimumSelections !== "number"
        || !Number.isInteger(action.minimumSelections)
        || action.minimumSelections <= 0
        || action.minimumSelections > action.options.length)) {
      codes.push("input_action_minimum_invalid");
    }
    return codes;
  }
  if (typeof capability.href !== "string") return ["capability_invalid"];
  try {
    const url = new URL(capability.href);
    return (url.protocol === "https:" || url.protocol === "http:")
      && url.username === ""
      && url.password === "" ? [] : ["capability_invalid"];
  } catch {
    return ["capability_invalid"];
  }
}

function safeCapabilityValidationCodes(
  capability: MaterializedDetailCapability,
  ownerClientKey: string | undefined,
): readonly string[] {
  try {
    return capabilityValidationCodes(capability, ownerClientKey);
  } catch {
    return ["capability_invalid"];
  }
}

function safeMaterializeDetailCapability(
  value: unknown,
  owner: NodeObject | undefined,
): DetailCapabilityMaterialization {
  if (typeof value !== "object" || value === null) return Object.freeze({ matched: false });
  try {
    if (isProxy(value)) return Object.freeze({ matched: true });
    if (Object.getPrototypeOf(value) !== Object.prototype) return Object.freeze({ matched: true });
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<PropertyKey, PropertyDescriptor>;
    const brand = descriptors[DETAIL_CAPABILITY];
    if (brand === undefined) return Object.freeze({ matched: false });
    if (!("value" in brand)
      || brand.value !== true
      || brand.enumerable !== true) return Object.freeze({ matched: true });
    const key = ownCapabilityData(descriptors, "key");
    const kind = ownCapabilityData(descriptors, "kind");
    if (typeof key !== "string") return Object.freeze({ matched: true });
    const allowed = new Set<PropertyKey>([DETAIL_CAPABILITY, "key", "kind"]);
    if (kind === "link") {
      allowed.add("href");
      const href = ownCapabilityData(descriptors, "href");
      if (typeof href !== "string" || !hasExactDescriptorFields(descriptors, allowed)) {
        return Object.freeze({ matched: true });
      }
      return Object.freeze({
        matched: true,
        capability: Object.freeze({ [DETAIL_CAPABILITY]: true as const, key, kind, href }),
      });
    }
    if (kind !== "expand" && kind !== "reference" && kind !== "invoke" && kind !== "input") {
      return Object.freeze({ matched: true });
    }
    allowed.add("action");
    const actionValue = ownCapabilityData(descriptors, "action");
    if (actionValue === INVALID_DESCRIPTOR_VALUE || !hasExactDescriptorFields(descriptors, allowed)) {
      return Object.freeze({ matched: true });
    }
    const action = materializeAction(actionValue, owner);
    return Object.freeze({
      matched: true,
      ...(action === undefined ? {} : { capability: Object.freeze({ key, kind, action }) }),
    });
  } catch {
    return Object.freeze({ matched: true });
  }
}

const INVALID_DESCRIPTOR_VALUE = Symbol("invalid-descriptor-value");

function ownCapabilityData(
  descriptors: Record<PropertyKey, PropertyDescriptor>,
  field: PropertyKey,
): unknown | typeof INVALID_DESCRIPTOR_VALUE {
  const descriptor = descriptors[field];
  return descriptor !== undefined && "value" in descriptor && descriptor.enumerable === true
    ? descriptor.value
    : INVALID_DESCRIPTOR_VALUE;
}

function hasExactDescriptorFields(
  descriptors: Record<PropertyKey, PropertyDescriptor>,
  allowed: ReadonlySet<PropertyKey>,
): boolean {
  return Reflect.ownKeys(descriptors).every((field) => {
    const descriptor = descriptors[field]!;
    return allowed.has(field) && "value" in descriptor && descriptor.enumerable === true;
  });
}

function materializeAction(value: unknown, owner: NodeObject | undefined): MaterializedAction | undefined {
  if (!isOrdinaryRecord(value)) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>;
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of Reflect.ownKeys(descriptors)) {
    if (typeof field !== "string") return undefined;
    const descriptor = descriptors[field]!;
    if (!("value" in descriptor) || descriptor.enumerable !== true) return undefined;
    snapshot[field] = field === "options" && descriptor.value !== undefined
      ? materializeOptions(descriptor.value)
      : field === "sourceLayer"
        ? materializeSourceLayer(descriptor.value, owner)
        : field === "target"
          ? materializeLayerTarget(descriptor.value)
        : descriptor.value;
    if (field === "options" && descriptor.value !== undefined && snapshot[field] === undefined) return undefined;
    if (field === "sourceLayer" && snapshot[field] === undefined) return undefined;
    if (field === "target" && snapshot[field] === undefined) return undefined;
  }
  return Object.freeze(snapshot);
}

function materializeOptions(value: unknown): readonly MaterializedAction[] | undefined {
  if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>;
  const lengthDescriptor = descriptors.length;
  if (lengthDescriptor === undefined
    || !("value" in lengthDescriptor)
    || typeof lengthDescriptor.value !== "number"
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
    || lengthDescriptor.value > 51) return undefined;
  const length = lengthDescriptor.value;
  const expected = new Set<string>(["length"]);
  const options: MaterializedAction[] = [];
  for (let index = 0; index < length; index += 1) {
    const field = String(index);
    expected.add(field);
    const descriptor = descriptors[field];
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) return undefined;
    const option = materializeOption(descriptor.value);
    if (option === undefined) return undefined;
    options.push(option);
  }
  if (Reflect.ownKeys(descriptors).some((field) => typeof field !== "string" || !expected.has(field))) return undefined;
  return Object.freeze(options);
}

function materializeOption(value: unknown): MaterializedAction | undefined {
  if (!isOrdinaryRecord(value)) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<PropertyKey, PropertyDescriptor>;
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of Reflect.ownKeys(descriptors)) {
    if (typeof field !== "string") return undefined;
    const descriptor = descriptors[field]!;
    if (!("value" in descriptor) || descriptor.enumerable !== true) return undefined;
    snapshot[field] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function isOrdinaryRecord(value: unknown): value is Record<PropertyKey, unknown> {
  if (typeof value !== "object" || value === null) return false;
  if (isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeMaterializeOwner(owner: NodeObject | undefined): AuthenticatedNodeDetailOwnerSnapshot | undefined {
  if (owner === undefined) return undefined;
  try {
    if (Object.getPrototypeOf(owner) !== NodeObject.prototype) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(owner, "clientKey");
    if (descriptor === undefined
      || !("value" in descriptor)
      || descriptor.enumerable !== true
      || typeof descriptor.value !== "string") return undefined;
    return Object.freeze({ object: owner, clientKey: descriptor.value });
  } catch {
    return undefined;
  }
}

function materializeSourceLayer(value: unknown, owner: NodeObject | undefined): MaterializedSourceLayer | undefined {
  if (typeof value !== "object"
    || value === null
    || isProxy(value)
    || Object.getPrototypeOf(value) !== LayerObject.prototype) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<PropertyKey, PropertyDescriptor>;
  const allowedFields = new Set<PropertyKey>(["clientKey", "edges", "layout", "nodes", "ref"]);
  for (const field of Reflect.ownKeys(descriptors)) {
    if (!allowedFields.has(field)) return undefined;
    const descriptor = descriptors[field]!;
    if (!("value" in descriptor) || descriptor.enumerable !== true) return undefined;
  }
  const clientKeyDescriptor = descriptors.clientKey;
  const nodesDescriptor = descriptors.nodes;
  if (clientKeyDescriptor === undefined
    || !("value" in clientKeyDescriptor)
    || typeof clientKeyDescriptor.value !== "string"
    || nodesDescriptor === undefined
    || !("value" in nodesDescriptor)) return undefined;
  const containsOwner = materializeLayerOwnerMembership(nodesDescriptor.value, owner);
  if (containsOwner === undefined) return undefined;
  return Object.freeze({ clientKey: clientKeyDescriptor.value, containsOwner });
}

function materializeLayerTarget(value: unknown): MaterializedLayerTarget | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? Object.freeze({ kind: "id", id: value }) : undefined;
  }
  if (typeof value !== "object" || value === null || isProxy(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype === LayerObject.prototype) {
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<PropertyKey, PropertyDescriptor>;
    const allowed = new Set<PropertyKey>(["clientKey", "edges", "layout", "nodes", "ref"]);
    if (!hasExactDescriptorFields(descriptors, allowed)) return undefined;
    const clientKey = ownCapabilityData(descriptors, "clientKey");
    return typeof clientKey === "string" ? Object.freeze({ kind: "draft", clientKey }) : undefined;
  }
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<PropertyKey, PropertyDescriptor>;
  const allowed = new Set<PropertyKey>(["edges", "id", "layout", "nodes", "state"]);
  if (!hasExactDescriptorFields(descriptors, allowed)) return undefined;
  const id = ownCapabilityData(descriptors, "id");
  const nodes = ownCapabilityData(descriptors, "nodes");
  const edges = ownCapabilityData(descriptors, "edges");
  const state = ownCapabilityData(descriptors, "state");
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0
    || !Array.isArray(nodes) || !Array.isArray(edges)
    || (state !== "draft" && state !== "accepted" && state !== "stopped")) return undefined;
  return Object.freeze({ kind: "accepted", id });
}

function materializeLayerOwnerMembership(value: unknown, owner: NodeObject | undefined): boolean | undefined {
  if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>;
  const lengthDescriptor = descriptors.length;
  if (lengthDescriptor === undefined
    || !("value" in lengthDescriptor)
    || typeof lengthDescriptor.value !== "number"
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
    || lengthDescriptor.value > 8) return undefined;
  const length = lengthDescriptor.value;
  const expected = new Set<PropertyKey>(["length"]);
  let containsOwner = false;
  for (let index = 0; index < length; index += 1) {
    const field = String(index);
    expected.add(field);
    const descriptor = descriptors[field];
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) return undefined;
    if (descriptor.value === owner) containsOwner = true;
  }
  if (Reflect.ownKeys(descriptors).some((field) => !expected.has(field))) return undefined;
  return containsOwner;
}

function isMaterializedSourceLayer(value: unknown): value is MaterializedSourceLayer {
  return typeof value === "object"
    && value !== null
    && typeof (value as MaterializedSourceLayer).clientKey === "string"
    && typeof (value as MaterializedSourceLayer).containsOwner === "boolean";
}

const ACTION_COMMON_FIELDS = Object.freeze([
  "clientKey", "description", "icon", "kind", "label", "ref", "sourceLayer", "variant",
]);

function hasExactActionFields(action: Record<string, unknown>): boolean {
  if (action.kind === "navigate") {
    return hasOnlyEnumerableFields(action, [...ACTION_COMMON_FIELDS, "relation", "target"]);
  }
  if (action.kind === "invoke") {
    return hasOnlyEnumerableFields(action, [...ACTION_COMMON_FIELDS, "interactionText"]);
  }
  if (action.kind === "input") {
    return hasOnlyEnumerableFields(action, [
      ...ACTION_COMMON_FIELDS, "control", "minimumSelections", "options", "prompt",
    ]);
  }
  return false;
}

function hasOnlyEnumerableFields(value: object, allowed: readonly string[]): boolean {
  const allowedFields = new Set<PropertyKey>(allowed);
  return Reflect.ownKeys(value)
    .filter((key) => Object.prototype.propertyIsEnumerable.call(value, key))
    .every((key) => allowedFields.has(key));
}

function hasValidActionPresentation(action: Record<string, unknown>): boolean {
  const variant = action.variant ?? "pill";
  if (variant !== "pill" && variant !== "chip" && variant !== "wide" && variant !== "card") return false;
  if (action.icon !== undefined
    && (typeof action.icon !== "string" || !isSupportedRelayerIcon(action.icon))) return false;
  if (variant === "card") return typeof action.description === "string" && action.description.trim() !== "";
  return action.description === undefined;
}

function isStableLayerReference(reference: unknown): reference is MaterializedLayerTarget {
  if (typeof reference !== "object" || reference === null) return false;
  const target = reference as MaterializedLayerTarget;
  if (target.kind === "draft") return isStableIdentity(target.clientKey);
  return (target.kind === "accepted" || target.kind === "id")
    && typeof target.id === "number"
    && Number.isSafeInteger(target.id)
    && target.id > 0;
}

function validateElementSafety(
  componentId: string,
  element: HtmlElement,
  issues: DetailCompilationIssue[],
): void {
  const domId = attributeValue(element, "id");
  if (domId !== undefined && !isStableDomIdentity(domId)) {
    issues.push(sourceIssue(
      "dom_id_invalid",
      componentId,
      element,
      "DOM id must be nonempty, trimmed, NUL-free, and at most 128 UTF-8 bytes",
    ));
  }
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

function isStableDomIdentity(value: string): boolean {
  return isStableIdentity(value) && !value.includes("\uFFFD");
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
  asset: MaterializedAssetRef,
  resolved: ResolvedDetailAsset | undefined,
  missingAssetCode: DetailAssetResolver["missingAssetCode"],
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
    issues.push(sourceIssue(
      missingAssetCode,
      componentId,
      element,
      missingAssetCode === "asset_unknown"
        ? `Asset ${asset.logicalId} is unknown to the authenticated host`
        : `Asset ${asset.logicalId} requires authenticated host resolution`,
    ));
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
  const supportedMedia = new Set(["image/png", "image/jpeg", "image/svg+xml"]);
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
  missingAssetCode: "asset_resolution_required",
  resolve: () => undefined,
});

function hasAccessibleName(
  element: HtmlElement,
  root: HtmlRoot,
  domIdentities: ReadonlyMap<string, DomIdentityRecord>,
): boolean {
  if (isAriaHidden(element)) return false;
  const labelledBy = attributeValue(element, "aria-labelledby");
  if (labelledBy !== undefined) {
    const ids = labelledBy.trim().split(/\s+/).filter(Boolean);
    return ids.length > 0 && ids.every((id) => {
      const target = isStableDomIdentity(id) ? domIdentities.get(id)?.element : undefined;
      return target !== undefined && namingText(target, isAriaHidden(target)).trim() !== "";
    });
  }
  if (attributeValue(element, "aria-label")?.trim()) return true;
  if (externalLabelText(element, root).trim() !== "") return true;
  if (visibleDescendantText(element).trim() !== "") return true;
  if (attributeValue(element, "title")?.trim()) return true;
  return false;
}

function attributeValue(element: HtmlElement, name: string): string | undefined {
  return element.attrs.find((attribute) => attribute.name === name)?.value;
}

function namingText(element: HtmlElement, includeHidden: boolean): string {
  return attributeValue(element, "aria-label")?.trim()
    || attributeValue(element, "title")?.trim()
    || visibleDescendantText(element, includeHidden);
}

function visibleDescendantText(element: HtmlElement, includeHidden = false): string {
  return element.childNodes.map((child) => {
    if ("value" in child) return child.value;
    if (!("tagName" in child) || (!includeHidden && isAriaHidden(child))) return "";
    if (child.tagName === "img") return attributeValue(child, "alt") ?? "";
    return visibleDescendantText(child, includeHidden);
  }).join("");
}

function externalLabelText(element: HtmlElement, root: HtmlRoot): string {
  if (element.tagName !== "input" && element.tagName !== "select" && element.tagName !== "textarea") return "";
  const id = attributeValue(element, "id");
  if (id === undefined || id === "") return "";
  const names: string[] = [];
  visitElements(root, (candidate) => {
    if (candidate.tagName === "label" && attributeValue(candidate, "for") === id && !isAriaHidden(candidate)) {
      const name = visibleDescendantText(candidate).trim();
      if (name !== "") names.push(name);
    }
  });
  return names.join(" ");
}

function isAriaHidden(element: HtmlElement): boolean {
  let current: DefaultTreeAdapterTypes.Node | null | undefined = element;
  while (current !== null && current !== undefined) {
    if ("tagName" in current && attributeValue(current, "aria-hidden")?.trim().toLowerCase() === "true") return true;
    current = "parentNode" in current ? current.parentNode : undefined;
  }
  return false;
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

function mountId(kind: "capability" | "asset", componentId: string, key: string, occurrence = 0): string {
  const occurrenceIdentity = occurrence === 0 ? "" : `\0${occurrence}`;
  const digest = createHash("sha256").update(`${kind}\0${componentId}\0${key}${occurrenceIdentity}`).digest("hex").slice(0, 16);
  return `m_${digest}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
