import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
const IMPORT_DETAIL_LIMIT = 128;
const IMPORT_CONTENT_LIMIT = 512;
const IMPORT_TOTAL_INSERT_LIMIT = 1 << 28;


import sax from "sax";
import sharp from "sharp";

export type VisualAssetScope =
  | { readonly kind: "library" }
  | { readonly kind: "project"; readonly projectId: number }
  | { readonly kind: "thread"; readonly threadId: number };

export type VisualAssetMediaType = "image/jpeg" | "image/png" | "image/svg+xml";

export interface HarnessFileHandle {
  readonly name: string;
  readonly mediaType: string;
  readonly expectedDigest?: string;
  read(): Promise<Uint8Array>;
}

export interface VisualAsset {
  readonly id: string;
  readonly registryId: string;
  readonly name: string;
  readonly mediaType: VisualAssetMediaType;
  readonly byteLength: number;
  readonly digest: string;
  readonly scopes: readonly VisualAssetScope[];
  readonly tagIds: readonly string[];
  readonly archived: boolean;
  readonly provenance: {
    readonly source: "user" | "system";
    readonly fileName: string;
  };
}

export interface VisualAssetInspection {
  readonly asset: VisualAsset;
  readonly preview: HarnessFileHandle & {
    readonly mediaType: VisualAssetMediaType;
    readonly byteLength: number;
    readonly digest: string;
  };
}

export interface VisualAssetTag {
  readonly id: string;
  readonly name: string;
  readonly scope: VisualAssetScope;
  readonly parentTagId: string | null;
  readonly authority: "user" | "system";
}

export type VisualAssetFindItem =
  | { readonly kind: "tag"; readonly tag: VisualAssetTag }
  | { readonly kind: "asset"; readonly asset: VisualAsset };

export interface VisualAssetRegistry {
  readonly id: string;
  readonly name: string;
  readonly source: string;
  readonly contentAuthority: "user" | "read-only";
  readonly defaultRelationshipAuthority: "user" | "read-only";
}

export interface VisualAssetsLibrary {
  add(input: {
    readonly file: HarnessFileHandle;
    readonly scope: VisualAssetScope;
    readonly name: string;
    readonly tagIds: readonly string[];
    readonly registryId?: string;
  }): Promise<VisualAsset>;
  inspect(assetId: string): Promise<VisualAssetInspection>;
  createTag(input: {
    readonly scope: VisualAssetScope;
    readonly name: string;
    readonly parentTagId?: string;
  }): Promise<VisualAssetTag>;
  moveTag(input: { readonly tagId: string; readonly parentTagId: string | null }): Promise<VisualAssetTag>;
  find(input: {
    readonly scope: VisualAssetScope;
    readonly tagId: string;
    readonly limit?: number;
    readonly cursor?: string;
  }): Promise<{ readonly items: readonly VisualAssetFindItem[]; readonly nextCursor: string | null }>;
  associate(input: { readonly assetId: string; readonly scope: VisualAssetScope }): Promise<VisualAsset>;
  organize(input: {
    readonly assetId: string;
    readonly addTagIds: readonly string[];
    readonly removeTagIds: readonly string[];
  }): Promise<VisualAsset>;
  archive(assetId: string): Promise<VisualAsset>;
  download(assetId: string): Promise<HarnessFileHandle>;
  listRegistries(input: {
    readonly scope: VisualAssetScope;
    readonly limit?: number;
    readonly cursor?: string;
  }): Promise<{ readonly items: readonly VisualAssetRegistry[]; readonly nextCursor: string | null }>;
  listAssets(input: {
    readonly scope: VisualAssetScope;
    readonly limit?: number;
    readonly cursor?: string;
  }): Promise<{ readonly items: readonly VisualAsset[]; readonly nextCursor: string | null }>;
  listTags(input: {
    readonly scope: VisualAssetScope;
    readonly parentTagId?: string | null;
    readonly limit?: number;
    readonly cursor?: string;
  }): Promise<{ readonly items: readonly VisualAssetTag[]; readonly nextCursor: string | null }>;
}

export interface VisualAssetAuthority {
  readonly projects: readonly { readonly projectId: number; readonly threadIds: readonly number[] }[];
  readonly standaloneThreadIds: readonly number[];
}

export interface CanonicalNodeDetailPackage {
  readonly version: 1;
  readonly components: readonly Readonly<Record<string, unknown>>[];
  readonly mounts: readonly Readonly<Record<string, unknown>>[];
  readonly assets: readonly {
    readonly id: string;
    readonly digestSha256: string;
    readonly mediaType: string;
    readonly representation: "image";
  }[];
  readonly integritySha256: string;
}

export interface AcceptedVisualDetail {
  readonly package: CanonicalNodeDetailPackage;
  readonly assets: readonly {
    readonly assetId: string;
    readonly digestSha256: string;
    readonly mediaType: VisualAssetMediaType;
    readonly byteLength: number;
    readonly provenance: VisualAsset["provenance"];
  }[];
}

export interface VisualDetailArchive {
  readonly version: 1;
  readonly details: readonly AcceptedVisualDetail[];
  readonly contents: readonly {
    readonly digestSha256: string;
    readonly mediaType: VisualAssetMediaType;
    readonly byteLength: number;
    readonly contentBase64: string;
  }[];
}

export interface VisualDetailPersistence {
  accept(input: {
    readonly package: CanonicalNodeDetailPackage;
    readonly scope: VisualAssetScope;
  }): Promise<AcceptedVisualDetail>;
  resolve(input: {
    readonly detail: AcceptedVisualDetail;
    readonly scope: VisualAssetScope;
  }): Promise<{
    readonly package: CanonicalNodeDetailPackage;
    readonly assets: readonly {
      readonly assetId: string;
      readonly digestSha256: string;
      readonly provenance: VisualAsset["provenance"];
      readonly file: HarnessFileHandle;
    }[];
  }>;
  read(input: {
    readonly package: CanonicalNodeDetailPackage;
    readonly scope: VisualAssetScope;
  }): Promise<AcceptedVisualDetail>;
  exportArchive(input: {
    readonly details: readonly AcceptedVisualDetail[];
    readonly scope: VisualAssetScope;
  }): Promise<VisualDetailArchive>;
  importArchive(input: {
    readonly archive: VisualDetailArchive;
    readonly scope: VisualAssetScope;
  }): Promise<readonly AcceptedVisualDetail[]>;
}

export class VisualAssetsError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "VisualAssetsError";
  }
}

interface GenericContentModule {
  index(bytes: Uint8Array): string;
  read(digest: string): Uint8Array | undefined;
}

interface VisualAssetsPersistenceBridge {
  readonly ready: () => Promise<void>;
  readonly assertScope: (scope: VisualAssetScope) => void;
  readonly visibleIn: (asset: VisualAsset, scope: VisualAssetScope) => boolean;
  readonly assetById: (assetId: string) => VisualAsset;
  readonly readContent: (digest: string) => Uint8Array | undefined;
  readonly validateBytes: (mediaType: VisualAssetMediaType, bytes: Uint8Array) => Promise<void>;
}

const PERSISTENCE_BRIDGES = new WeakMap<VisualAssetsLibrary, VisualAssetsPersistenceBridge>();
const ACCEPTED_DETAIL_SCOPES = new WeakMap<object, VisualAssetScope>();

class MemoryGenericContentModule implements GenericContentModule {
  readonly #contentByDigest = new Map<string, Uint8Array>();

  index(bytes: Uint8Array): string {
    const digest = sha256(bytes);
    if (!this.#contentByDigest.has(digest)) this.#contentByDigest.set(digest, bytes.slice());
    return digest;
  }

  read(digest: string): Uint8Array | undefined {
    const bytes = this.#contentByDigest.get(digest);
    if (bytes === undefined) return undefined;
    if (sha256(bytes) !== digest) {
      throw new VisualAssetsError("digest_mismatch", "Indexed visual asset content failed digest verification");
    }
    return bytes.slice();
  }
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function malformed(message: string): never {
  throw new VisualAssetsError("media_content_malformed", message);
}

function unsafeSvg(message: string): never {
  throw new VisualAssetsError("media_content_unsafe", message);
}

function uint32be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! * 0x1000000)
    + (bytes[offset + 1]! << 16)
    + (bytes[offset + 2]! << 8)
    + bytes[offset + 3]!) >>> 0;
}

function assertCompletePng(bytes: Uint8Array): void {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.byteLength < 20 || !signature.every((byte, index) => bytes[index] === byte)) {
    malformed("PNG signature is invalid");
  }
  let offset = 8;
  let chunkIndex = 0;
  while (offset < bytes.byteLength) {
    if (offset + 12 > bytes.byteLength) malformed("PNG chunk is truncated");
    const length = uint32be(bytes, offset);
    const end = offset + 12 + length;
    if (!Number.isSafeInteger(end) || end > bytes.byteLength) malformed("PNG chunk is truncated");
    const type = Buffer.from(bytes.subarray(offset + 4, offset + 8)).toString("ascii");
    if (chunkIndex === 0 && (type !== "IHDR" || length !== 13)) malformed("PNG must begin with IHDR");
    offset = end;
    chunkIndex += 1;
    if (type === "IEND") {
      if (length !== 0 || offset !== bytes.byteLength) malformed("PNG contains bytes after its actual IEND chunk");
      return;
    }
  }
  malformed("PNG is missing its IEND chunk");
}

function assertCompleteJpeg(bytes: Uint8Array): void {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) malformed("JPEG SOI marker is invalid");
  let offset = 2;
  let inScan = false;
  while (offset < bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      if (!inScan) malformed("JPEG marker framing is invalid");
      offset += 1;
      continue;
    }
    while (bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.byteLength) malformed("JPEG marker is truncated");
    const marker = bytes[offset++]!;
    if (inScan && marker === 0x00) continue;
    if (marker >= 0xd0 && marker <= 0xd7) {
      if (!inScan) malformed("JPEG restart marker occurs outside scan data");
      continue;
    }
    if (marker === 0xd9) {
      if (offset !== bytes.byteLength) malformed("JPEG contains bytes after its actual EOI marker");
      return;
    }
    if (marker === 0xd8) malformed("JPEG contains an unexpected SOI marker");
    if (marker === 0x01) continue;
    if (offset + 2 > bytes.byteLength) malformed("JPEG segment length is truncated");
    const length = (bytes[offset]! << 8) + bytes[offset + 1]!;
    if (length < 2 || offset + length > bytes.byteLength) malformed("JPEG segment is truncated");
    offset += length;
    inScan = marker === 0xda;
  }
  malformed("JPEG is missing its EOI marker");
}

function validateSvg(bytes: Uint8Array): void {
  if (bytes.byteLength === 0 || bytes.byteLength > 256 * 1024) {
    malformed("SVG content must contain at most 256 KiB");
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    malformed("SVG content must be valid UTF-8");
  }

  const allowedElements = new Set([
    "svg", "g", "defs", "title", "desc", "path", "rect", "circle", "ellipse", "line", "polyline",
    "polygon", "linearGradient", "radialGradient", "stop", "clipPath", "mask",
  ]);
  const renderableElements = new Set(["path", "rect", "circle", "ellipse", "line", "polyline", "polygon"]);
  const allowedAttributes = new Set([
    "xmlns", "viewBox", "width", "height", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry",
    "d", "points", "transform", "opacity", "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width",
    "stroke-opacity", "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "stroke-dashoffset", "vector-effect",
    "id", "class", "role", "aria-label", "aria-hidden", "focusable", "clip-path", "mask", "offset", "stop-color",
    "stop-opacity", "gradientUnits", "gradientTransform", "spreadMethod", "fx", "fy", "fr", "href", "xlink:href",
  ]);
  const parser = sax.parser(true, { lowercase: false, normalize: false, trim: false });
  const elementStack: string[] = [];
  let elementCount = 0;
  let rootSeen = false;
  let rootValid = false;
  let renderableSeen = false;
  parser.ondoctype = () => unsafeSvg("SVG document types and entities are not allowed");
  parser.onprocessinginstruction = () => unsafeSvg("SVG processing instructions are not allowed");
  parser.oncdata = () => unsafeSvg("SVG CDATA is not allowed");
  parser.onopentag = (element) => {
    elementCount += 1;
    if (elementCount > 10_000) unsafeSvg("SVG contains too many elements");
    if (!allowedElements.has(element.name)) unsafeSvg(`SVG element is not allowed: ${element.name}`);
    if (elementStack.length === 0) {
      if (rootSeen || element.name !== "svg") malformed("SVG must contain exactly one svg root");
      rootSeen = true;
    }
    elementStack.push(element.name);
    const attributes = Object.fromEntries(Object.entries(element.attributes).map(([name, value]) => [name, String(value)]));
    for (const [name, value] of Object.entries(attributes)) {
      if (/^on/i.test(name) || name === "style" || !allowedAttributes.has(name)) {
        unsafeSvg(`SVG attribute is not allowed: ${name}`);
      }
      if (name === "xmlns") {
        if (element.name !== "svg" || elementStack.length !== 1 || value !== "http://www.w3.org/2000/svg") {
          unsafeSvg("SVG namespace must be the canonical namespace on the root");
        }
        continue;
      }
      if (value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) {
        unsafeSvg(`SVG attribute contains an escaped or control value: ${name}`);
      }
      if (/[@]|javascript:|data:|https?:|file:/i.test(value) || value.includes("//")) {
        unsafeSvg(`SVG attribute contains an external or active value: ${name}`);
      }
      if (/url\s*\(/i.test(value) && !/^url\(#[A-Za-z_][\w:.-]*\)$/.test(value)) {
        unsafeSvg(`SVG URL reference must be an internal fragment: ${name}`);
      }
      if ((name === "href" || name === "xlink:href") && !/^#[A-Za-z_][\w:.-]*$/.test(value)) {
        unsafeSvg("SVG href must be an internal fragment");
      }
      if ((name === "fill" || name === "stroke" || name === "stop-color")
        && !/^(?:none|currentColor|transparent|#[0-9A-Fa-f]{3,8}|(?:rgb|rgba|hsl|hsla)\([0-9.,% +\-]+\)|url\(#[A-Za-z_][\w:.-]*\))$/.test(value)) {
        unsafeSvg(`SVG presentation value is outside the safe grammar: ${name}`);
      }
      if ((name === "clip-path" || name === "mask")
        && value !== "none" && !/^url\(#[A-Za-z_][\w:.-]*\)$/.test(value)) {
        unsafeSvg(`SVG resource value must be an internal fragment: ${name}`);
      }
    }
    if (element.name === "svg") {
      const viewBox = attributes.viewBox?.trim().split(/[ ,]+/).map(Number);
      rootValid = attributes.xmlns === "http://www.w3.org/2000/svg"
        && viewBox?.length === 4
        && viewBox.every(Number.isFinite)
        && viewBox[2]! > 0
        && viewBox[3]! > 0;
    }
    if (renderableElements.has(element.name)) renderableSeen = true;
  };
  parser.onclosetag = () => {
    elementStack.pop();
  };
  parser.ontext = (text) => {
    const parent = elementStack.at(-1);
    if (text.trim().length > 0 && parent === undefined) {
      malformed("SVG contains text outside its root");
    }
    if (text.trim().length > 0 && parent !== "title" && parent !== "desc") {
      unsafeSvg("SVG text is allowed only inside title or desc");
    }
  };
  try {
    parser.write(source).close();
  } catch (error) {
    if (error instanceof VisualAssetsError) throw error;
    malformed("SVG must be a complete well-formed XML document");
  }
  if (!rootSeen || !rootValid || !renderableSeen) {
    malformed("SVG requires one namespaced root with a positive viewBox and renderable geometry");
  }
}

async function validateVisualBytes(mediaType: VisualAssetMediaType, bytes: Uint8Array): Promise<void> {
  if (mediaType === "image/svg+xml") {
    validateSvg(bytes);
    return;
  }
  if (mediaType !== "image/png" && mediaType !== "image/jpeg") {
    throw new VisualAssetsError("media_type_unsupported", `Unsupported visual asset media type: ${mediaType}`);
  }
  if (bytes.byteLength > 8 * 1024 * 1024) {
    throw new VisualAssetsError("media_encoded_bytes_limit", "Raster representation exceeds the 8 MiB encoded-byte limit");
  }
  if (mediaType === "image/png") {
    assertCompletePng(bytes);
  } else assertCompleteJpeg(bytes);
  try {
    const decoderOptions = { failOn: "warning" as const, limitInputPixels: false as const };
    const metadata = await sharp(bytes, decoderOptions).metadata();
    if (metadata.format !== (mediaType === "image/png" ? "png" : "jpeg")) {
      malformed(`Visual asset bytes do not decode as ${mediaType}`);
    }
    const pixels = (metadata.width ?? 0) * (metadata.height ?? 0);
    if (!Number.isSafeInteger(pixels) || pixels > 16_777_216) {
      throw new VisualAssetsError("media_decoded_pixels_limit", "Raster exceeds the 16,777,216 decoded-pixel limit");
    }
    const decodedBytes = pixels * (metadata.channels ?? 4);
    if (!Number.isSafeInteger(decodedBytes) || decodedBytes > 32 * 1024 * 1024) {
      throw new VisualAssetsError("media_decoded_bytes_limit", "Raster exceeds the 32 MiB decoded-byte limit");
    }
    const decoded = await sharp(bytes, decoderOptions).raw().toBuffer({ resolveWithObject: true });
    if (decoded.info.width < 1 || decoded.info.height < 1 || decoded.data.byteLength < 1) {
      malformed("Visual asset decoder produced no pixels");
    }
  } catch (error) {
    if (error instanceof VisualAssetsError) throw error;
    malformed(`Visual asset bytes are not a complete decodable ${mediaType} image`);
  }
}

export function memoryHarnessFile(
  name: string,
  mediaType: string,
  content: string | Uint8Array,
): HarnessFileHandle {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content.slice();
  return Object.freeze({
    name,
    mediaType,
    async read() {
      return bytes.slice();
    },
  });
}

export function createMemoryVisualAssetsLibrary(options: {
  readonly authority?: VisualAssetAuthority;
  readonly registries?: readonly VisualAssetRegistry[];
  readonly initialTags?: readonly VisualAssetTag[];
  readonly initialAssets?: readonly {
    readonly id: string;
    readonly registryId: string;
    readonly name: string;
    readonly fileName: string;
    readonly mediaType: string;
    readonly content: string | Uint8Array;
    readonly digest?: string;
    readonly byteLength?: number;
    readonly scopes: readonly VisualAssetScope[];
    readonly tagIds: readonly string[];
    readonly archived?: boolean;
    readonly provenance?: VisualAsset["provenance"];
  }[];
} = {}): VisualAssetsLibrary {
  function assertSupportedMediaType(mediaType: string): asserts mediaType is VisualAssetMediaType {
    if (mediaType !== "image/jpeg" && mediaType !== "image/png" && mediaType !== "image/svg+xml") {
      throw new VisualAssetsError("media_type_unsupported", `Unsupported visual asset media type: ${mediaType}`);
    }
  }
  let activeRasterValidations = 0;
  async function validateBytes(mediaType: VisualAssetMediaType, bytes: Uint8Array): Promise<void> {
    if (mediaType === "image/svg+xml") return validateVisualBytes(mediaType, bytes);
    if (activeRasterValidations >= 2) {
      throw new VisualAssetsError(
        "media_validation_concurrency_limit",
        "At most two raster representations may be validated concurrently per visual-assets library",
      );
    }
    activeRasterValidations += 1;
    try {
      await validateVisualBytes(mediaType, bytes);
    } finally {
      activeRasterValidations -= 1;
    }
  }
  const assets = new Map<string, VisualAsset>();
  const tags = new Map<string, VisualAssetTag>();
  const defaultTagIdsByAsset = new Map<string, ReadonlySet<string>>();
  const content = new MemoryGenericContentModule();
  let revision = 0;
  const authority = options.authority ?? { projects: [], standaloneThreadIds: [] };
  const projectByThread = new Map(authority.projects.flatMap((project) => (
    project.threadIds.map((threadId) => [threadId, project.projectId] as const)
  )));
  const projectIds = new Set(authority.projects.map((project) => project.projectId));
  const standaloneThreadIds = new Set(authority.standaloneThreadIds);
  const registries = new Map<string, VisualAssetRegistry>();
  registries.set("user", Object.freeze({
    id: "user",
    name: "User assets",
    source: "user",
    contentAuthority: "user",
    defaultRelationshipAuthority: "user",
  }));
  for (const registry of options.registries ?? []) {
    if (registries.has(registry.id)) throw new VisualAssetsError("registry_conflict", `Duplicate registry: ${registry.id}`);
    registries.set(registry.id, Object.freeze({ ...registry }));
  }

  function canonicalScope(scope: VisualAssetScope): VisualAssetScope {
    if (scope.kind === "library") return Object.freeze({ kind: "library" });
    if (scope.kind === "project") return Object.freeze({ kind: "project", projectId: scope.projectId });
    return Object.freeze({ kind: "thread", threadId: scope.threadId });
  }

  function immutableTag(tag: VisualAssetTag): VisualAssetTag {
    return Object.freeze({ ...tag, scope: canonicalScope(tag.scope) });
  }

  function immutableAsset(asset: VisualAsset): VisualAsset {
    return Object.freeze({
      ...asset,
      scopes: Object.freeze(asset.scopes.map(canonicalScope)),
      tagIds: Object.freeze([...asset.tagIds]),
      provenance: Object.freeze({ ...asset.provenance }),
    });
  }

  function assertScope(scope: VisualAssetScope): void {
    if (scope.kind === "library") return;
    if (scope.kind === "project" && projectIds.has(scope.projectId)) return;
    if (scope.kind === "thread"
      && (projectByThread.has(scope.threadId) || standaloneThreadIds.has(scope.threadId))) return;
    throw new VisualAssetsError("scope_not_authorized", `Visual asset ${scope.kind} scope is not authorized`);
  }

  function tagScope(scope: VisualAssetScope): VisualAssetScope {
    assertScope(scope);
    if (scope.kind !== "thread") return canonicalScope(scope);
    const projectId = projectByThread.get(scope.threadId);
    return projectId === undefined
      ? canonicalScope(scope)
      : canonicalScope({ kind: "project", projectId });
  }

  function sameScope(left: VisualAssetScope, right: VisualAssetScope): boolean {
    return left.kind === "library" && right.kind === "library"
      || left.kind === "project" && right.kind === "project" && left.projectId === right.projectId
      || left.kind === "thread" && right.kind === "thread" && left.threadId === right.threadId;
  }

  function scopeKey(scope: VisualAssetScope): string {
    if (scope.kind === "library") return "library";
    return `${scope.kind}:${scope.kind === "project" ? scope.projectId : scope.threadId}`;
  }

  function page<T>(
    items: readonly T[],
    input: { readonly limit?: number; readonly cursor?: string },
    context: string,
  ): { readonly items: readonly T[]; readonly nextCursor: string | null } {
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new VisualAssetsError("page_limit_invalid", "Page limit must be an integer from 1 to 100");
    }
    let offset = 0;
    if (input.cursor !== undefined) {
      let decoded: { readonly v?: unknown; readonly context?: unknown; readonly revision?: unknown; readonly offset?: unknown };
      try {
        decoded = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")) as typeof decoded;
        if (decoded.v !== 2 || decoded.context !== context
          || !Number.isSafeInteger(decoded.revision) || (decoded.revision as number) < 0
          || !Number.isSafeInteger(decoded.offset) || (decoded.offset as number) < 1) throw new Error("invalid");
      } catch {
        throw new VisualAssetsError("page_cursor_invalid", "Page cursor is invalid for this visual-assets query");
      }
      if (decoded.revision !== revision) {
        throw new VisualAssetsError(
          "page_snapshot_stale",
          "Visual-assets results changed after this page cursor was issued; restart the query",
        );
      }
      offset = decoded.offset as number;
    }
    const selected = Object.freeze(items.slice(offset, offset + limit));
    const nextOffset = offset + selected.length;
    return Object.freeze({
      items: selected,
      nextCursor: nextOffset < items.length
        ? Buffer.from(JSON.stringify({ v: 2, context, revision, offset: nextOffset })).toString("base64url")
        : null,
    });
  }

  function snapshotPageInput(input: { readonly limit?: number; readonly cursor?: string }): {
    readonly limit?: number;
    readonly cursor?: string;
  } {
    return Object.freeze({
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    });
  }

  function tagForScope(tagId: string, scope: VisualAssetScope): VisualAssetTag {
    const tag = tags.get(tagId);
    if (tag === undefined) throw new VisualAssetsError("tag_not_found", `Unknown visual asset tag: ${tagId}`);
    if (!sameScope(tag.scope, tagScope(scope))) {
      throw new VisualAssetsError("tag_scope_mismatch", "Visual asset tag belongs to another scope");
    }
    return tag;
  }

  function assetById(assetId: string): VisualAsset {
    const asset = assets.get(assetId);
    if (asset === undefined) throw new VisualAssetsError("asset_not_found", `Unknown visual asset: ${assetId}`);
    return asset;
  }

  function replaceAsset(asset: VisualAsset, changes: Partial<Pick<VisualAsset, "scopes" | "tagIds" | "archived">>): VisualAsset {
    const replacement = immutableAsset({ ...asset, ...changes });
    assets.set(asset.id, replacement);
    revision += 1;
    return replacement;
  }

  const initialTags = new Map<string, VisualAssetTag>();
  for (const initial of options.initialTags ?? []) {
    const id = initial.id.trim();
    const name = initial.name.trim();
    if (id.length === 0 || id !== initial.id) {
      throw new VisualAssetsError("tag_id_invalid", "Initial visual asset tag ID must be non-empty and canonical");
    }
    if (name.length === 0) throw new VisualAssetsError("tag_name_invalid", "Visual asset tag name is required");
    if (initial.parentTagId !== null
      && (initial.parentTagId.length === 0 || initial.parentTagId.trim() !== initial.parentTagId)) {
      throw new VisualAssetsError("tag_id_invalid", "Initial visual asset parent tag ID must be non-empty and canonical");
    }
    if (initial.authority !== "user" && initial.authority !== "system") {
      throw new VisualAssetsError("tag_authority_invalid", "Initial visual asset tag authority is invalid");
    }
    const requestedScope = canonicalScope(initial.scope);
    const scope = tagScope(requestedScope);
    if (!sameScope(scope, requestedScope)) {
      throw new VisualAssetsError("tag_scope_mismatch", "Initial tag must use its owning project tag scope");
    }
    if (initialTags.has(id)) throw new VisualAssetsError("tag_conflict", `Duplicate visual asset tag: ${id}`);
    initialTags.set(id, immutableTag({
      id,
      name,
      scope,
      parentTagId: initial.parentTagId,
      authority: initial.authority,
    }));
  }
  for (const tag of initialTags.values()) {
    if (tag.parentTagId === null) continue;
    const parent = initialTags.get(tag.parentTagId);
    if (parent === undefined) throw new VisualAssetsError("tag_not_found", `Unknown visual asset tag: ${tag.parentTagId}`);
    if (!sameScope(tag.scope, parent.scope)) {
      throw new VisualAssetsError("tag_scope_mismatch", "Initial visual asset parent tag belongs to another scope");
    }
  }
  const tagVisit = new Map<string, "visiting" | "visited">();
  function visitInitialTag(tag: VisualAssetTag): void {
    const state = tagVisit.get(tag.id);
    if (state === "visiting") throw new VisualAssetsError("tag_hierarchy_cycle", "Visual asset tag hierarchy cannot contain a cycle");
    if (state === "visited") return;
    tagVisit.set(tag.id, "visiting");
    if (tag.parentTagId !== null) visitInitialTag(initialTags.get(tag.parentTagId)!);
    tagVisit.set(tag.id, "visited");
  }
  for (const tag of initialTags.values()) visitInitialTag(tag);
  for (const tag of initialTags.values()) tags.set(tag.id, tag);

  const initialAssetIds = new Set<string>();
  for (const initial of options.initialAssets ?? []) {
    if (initialAssetIds.has(initial.id)) {
      throw new VisualAssetsError("asset_conflict", `Duplicate visual asset: ${initial.id}`);
    }
    initialAssetIds.add(initial.id);
  }

  const initialAssetInputs = (options.initialAssets ?? []).map((initial) => Object.freeze({
    ...initial,
    content: typeof initial.content === "string" ? initial.content : initial.content.slice(),
    scopes: Object.freeze(initial.scopes.map(canonicalScope)),
    tagIds: Object.freeze([...initial.tagIds]),
    provenance: initial.provenance === undefined
      ? undefined
      : Object.freeze({ ...initial.provenance }),
  }));

  async function initializeAssets(): Promise<void> {
    const prepared: { readonly asset: VisualAsset; readonly bytes: Uint8Array }[] = [];
    for (const initial of initialAssetInputs) {
      const registry = registries.get(initial.registryId);
      if (registry === undefined) throw new VisualAssetsError("registry_not_found", `Unknown registry: ${initial.registryId}`);
      assertSupportedMediaType(initial.mediaType);
      if (new Set(initial.tagIds).size !== initial.tagIds.length) {
        throw new VisualAssetsError("tag_relationship_malformed", "Initial visual asset tag relationships must be unique");
      }
      const scopes = Object.freeze(initial.scopes.map((scope) => {
        assertScope(scope);
        return canonicalScope(scope);
      }));
      const bytes = typeof initial.content === "string"
        ? new TextEncoder().encode(initial.content)
        : initial.content.slice();
      if (initial.digest !== undefined && !/^sha256:[0-9a-f]{64}$/.test(initial.digest)) {
        throw new VisualAssetsError("digest_invalid", "Initial visual asset digest is invalid");
      }
      const actualDigest = sha256(bytes);
      if (initial.digest !== undefined && initial.digest !== actualDigest) {
        throw new VisualAssetsError("digest_mismatch", "Initial visual asset digest does not match its content");
      }
      if (initial.byteLength !== undefined && initial.byteLength !== bytes.byteLength) {
        throw new VisualAssetsError("content_length_invalid", "Initial visual asset byte length does not match its content");
      }
      await validateBytes(initial.mediaType, bytes);
      for (const tagId of initial.tagIds) {
        const tag = tags.get(tagId);
        if (tag === undefined) throw new VisualAssetsError("tag_not_found", `Unknown visual asset tag: ${tagId}`);
        if (!scopes.map(tagScope).some((scope) => sameScope(scope, tag.scope))) {
          throw new VisualAssetsError("tag_scope_mismatch", "Initial asset is not associated with the tag scope");
        }
      }
      prepared.push({
        bytes,
        asset: immutableAsset({
          id: initial.id,
          registryId: initial.registryId,
          name: initial.name,
          mediaType: initial.mediaType,
          byteLength: bytes.byteLength,
          digest: actualDigest,
          scopes,
          tagIds: initial.tagIds,
          archived: initial.archived ?? false,
          provenance: initial.provenance ?? Object.freeze({ source: "system", fileName: initial.fileName }),
        }),
      });
    }
    for (const entry of prepared) {
      content.index(entry.bytes);
      assets.set(entry.asset.id, entry.asset);
      defaultTagIdsByAsset.set(entry.asset.id, new Set(entry.asset.tagIds));
    }
  }

  let initialization: Promise<void> | undefined;
  function ready(): Promise<void> {
    initialization ??= initializeAssets();
    return initialization;
  }

  function visibleIn(asset: VisualAsset, scope: VisualAssetScope): boolean {
    return asset.scopes.some((associated) => {
      if (scope.kind === "library") return associated.kind === "library";
      if (scope.kind === "thread") {
        return (associated.kind === "thread" && associated.threadId === scope.threadId)
          || (associated.kind === "project" && projectByThread.get(scope.threadId) === associated.projectId);
      }
      return (associated.kind === "project" && associated.projectId === scope.projectId)
        || (associated.kind === "thread" && projectByThread.get(associated.threadId) === scope.projectId);
    });
  }

  const library: VisualAssetsLibrary = {
    async add(input) {
      assertScope(input.scope);
      const scope = canonicalScope(input.scope);
      const tagIds = Object.freeze([...input.tagIds]);
      const fileName = input.file.name;
      const mediaType = input.file.mediaType;
      const expectedDigest = input.file.expectedDigest;
      const readFile = input.file.read.bind(input.file);
      const registryId = input.registryId ?? "user";
      const name = input.name.trim();
      await ready();
      if (name.length === 0) throw new VisualAssetsError("asset_name_invalid", "Visual asset name is required");
      assertSupportedMediaType(mediaType);
      if (new Set(tagIds).size !== tagIds.length) {
        throw new VisualAssetsError("tag_relationship_malformed", "Visual asset tag relationships must be unique");
      }
      for (const tagId of tagIds) tagForScope(tagId, scope);
      const registry = registries.get(registryId);
      if (registry === undefined) throw new VisualAssetsError("registry_not_found", "Visual asset registry does not exist");
      if (registry.contentAuthority !== "user") {
        throw new VisualAssetsError("asset_content_read_only", "Registry content is read-only");
      }
      let bytes: Uint8Array;
      try {
        bytes = (await readFile()).slice();
      } catch {
        throw new VisualAssetsError("file_unavailable", "Harness file is unavailable");
      }
      const digest = sha256(bytes);
      if (expectedDigest !== undefined && expectedDigest !== digest) {
        throw new VisualAssetsError("digest_mismatch", "Harness file digest does not match its expected digest");
      }
      await validateBytes(mediaType, bytes);
      const indexedDigest = content.index(bytes);
      if (indexedDigest !== digest) {
        throw new VisualAssetsError("digest_mismatch", "Indexed visual asset digest does not match its logical record");
      }
      const asset: VisualAsset = immutableAsset({
        id: `asset_${randomUUID()}`,
        registryId,
        name,
        mediaType,
        byteLength: bytes.byteLength,
        digest,
        scopes: [scope],
        tagIds,
        archived: false,
        provenance: Object.freeze({ source: "user", fileName }),
      });
      assets.set(asset.id, asset);
      revision += 1;
      return asset;
    },
    async inspect(assetId) {
      const requestedAssetId = assetId;
      await ready();
      const asset = assetById(requestedAssetId);
      const bytes = content.read(asset.digest);
      if (bytes === undefined) throw new VisualAssetsError("content_unavailable", "Visual asset content is unavailable");
      if (bytes.byteLength !== asset.byteLength) {
        throw new VisualAssetsError("content_corrupt", "Visual asset content length does not match its logical record");
      }
      await validateBytes(asset.mediaType, bytes);
      const preview = Object.freeze({
        name: asset.provenance.fileName,
        mediaType: asset.mediaType,
        byteLength: asset.byteLength,
        digest: asset.digest,
        expectedDigest: asset.digest,
        async read() {
          return bytes.slice();
        },
      });
      return Object.freeze({
        asset,
        preview,
      });
    },
    async createTag(input) {
      const requestedScope = canonicalScope(input.scope);
      const requestedName = input.name;
      const requestedParentTagId = input.parentTagId;
      const scope = tagScope(requestedScope);
      await ready();
      const parent = requestedParentTagId === undefined ? undefined : tagForScope(requestedParentTagId, scope);
      const name = requestedName.trim();
      if (name.length === 0) throw new VisualAssetsError("tag_name_invalid", "Visual asset tag name is required");
      const tag: VisualAssetTag = immutableTag({
        id: `tag_${randomUUID()}`,
        name,
        scope,
        parentTagId: parent?.id ?? null,
        authority: "user",
      });
      tags.set(tag.id, tag);
      revision += 1;
      return tag;
    },
    async moveTag(input) {
      const requestedTagId = input.tagId;
      const requestedParentTagId = input.parentTagId;
      await ready();
      const tag = tags.get(requestedTagId);
      if (tag === undefined) throw new VisualAssetsError("tag_not_found", `Unknown visual asset tag: ${requestedTagId}`);
      if (tag.authority !== "user") throw new VisualAssetsError("tag_read_only", "Visual asset tag is read-only");
      const parent = requestedParentTagId === null ? null : tagForScope(requestedParentTagId, tag.scope);
      let ancestor = parent;
      while (ancestor !== null) {
        if (ancestor.id === tag.id) throw new VisualAssetsError("tag_hierarchy_cycle", "Visual asset tag hierarchy cannot contain a cycle");
        ancestor = ancestor.parentTagId === null ? null : tags.get(ancestor.parentTagId) ?? null;
      }
      const parentTagId = parent?.id ?? null;
      if (tag.parentTagId === parentTagId) return tag;
      const moved = immutableTag({ ...tag, parentTagId });
      tags.set(tag.id, moved);
      revision += 1;
      return moved;
    },
    async find(input) {
      const requestedScope = canonicalScope(input.scope);
      const requestedTagId = input.tagId;
      const pageInput = snapshotPageInput(input);
      assertScope(requestedScope);
      await ready();
      const tag = tagForScope(requestedTagId, requestedScope);
      const items: VisualAssetFindItem[] = [
        ...[...tags.values()]
          .filter((candidate) => candidate.parentTagId === tag.id)
          .sort((left, right) => compareCodeUnits(left.name, right.name) || compareCodeUnits(left.id, right.id))
          .map((candidate): VisualAssetFindItem => Object.freeze({ kind: "tag", tag: candidate })),
        ...[...assets.values()]
          .filter((asset) => !asset.archived && asset.tagIds.includes(tag.id) && visibleIn(asset, requestedScope))
          .sort((left, right) => compareCodeUnits(left.name, right.name) || compareCodeUnits(left.id, right.id))
          .map((asset): VisualAssetFindItem => Object.freeze({ kind: "asset", asset })),
      ];
      return page(items, pageInput, `find:${scopeKey(requestedScope)}:${scopeKey(tag.scope)}:${tag.id}:sort:kind-name-id:utf16-v1`);
    },
    async associate(input) {
      assertScope(input.scope);
      const scope = canonicalScope(input.scope);
      const requestedAssetId = input.assetId;
      await ready();
      const asset = assetById(requestedAssetId);
      if (asset.scopes.some((associated) => sameScope(associated, scope))) return asset;
      return replaceAsset(asset, { scopes: [...asset.scopes, scope] });
    },
    async organize(input) {
      const requestedAssetId = input.assetId;
      const addTagIds = Object.freeze([...input.addTagIds]);
      const removeTagIds = Object.freeze([...input.removeTagIds]);
      await ready();
      const asset = assetById(requestedAssetId);
      const associatedTagScopes = asset.scopes.map(tagScope);
      const added = addTagIds.map((tagId) => {
        const tag = tags.get(tagId);
        if (tag === undefined) throw new VisualAssetsError("tag_not_found", `Unknown visual asset tag: ${tagId}`);
        if (!associatedTagScopes.some((scope) => sameScope(scope, tag.scope))) {
          throw new VisualAssetsError("tag_scope_mismatch", "Asset is not associated with the tag scope");
        }
        return tag.id;
      });
      for (const tagId of removeTagIds) {
        if (!tags.has(tagId)) throw new VisualAssetsError("tag_not_found", `Unknown visual asset tag: ${tagId}`);
        if (defaultTagIdsByAsset.get(asset.id)?.has(tagId)
          && registries.get(asset.registryId)?.defaultRelationshipAuthority === "read-only") {
          throw new VisualAssetsError("tag_relationship_read_only", "Default visual asset tag relationship is read-only");
        }
      }
      const removed = new Set(removeTagIds);
      const tagIds = [...asset.tagIds.filter((tagId) => !removed.has(tagId))];
      for (const tagId of added) if (!tagIds.includes(tagId)) tagIds.push(tagId);
      if (tagIds.length === asset.tagIds.length
        && tagIds.every((tagId, index) => tagId === asset.tagIds[index])) return asset;
      return replaceAsset(asset, { tagIds });
    },
    async archive(assetId) {
      const requestedAssetId = assetId;
      await ready();
      const asset = assetById(requestedAssetId);
      if (registries.get(asset.registryId)?.contentAuthority !== "user") {
        throw new VisualAssetsError("asset_content_read_only", "Visual asset content is read-only");
      }
      if (asset.archived) return asset;
      return replaceAsset(asset, { archived: true });
    },
    async download(assetId) {
      const requestedAssetId = assetId;
      await ready();
      const asset = assetById(requestedAssetId);
      const bytes = content.read(asset.digest);
      if (bytes === undefined) throw new VisualAssetsError("content_unavailable", "Visual asset content is unavailable");
      if (bytes.byteLength !== asset.byteLength) {
        throw new VisualAssetsError("content_corrupt", "Visual asset content length does not match its logical record");
      }
      await validateBytes(asset.mediaType, bytes);
      return memoryHarnessFile(asset.provenance.fileName, asset.mediaType, bytes);
    },
    async listRegistries(input) {
      const requestedScope = canonicalScope(input.scope);
      const pageInput = snapshotPageInput(input);
      assertScope(requestedScope);
      await ready();
      return page(
        [...registries.values()].sort((left, right) => compareCodeUnits(left.id, right.id)),
        pageInput,
        `registries:${scopeKey(requestedScope)}:sort:id:utf16-v1`,
      );
    },
    async listAssets(input) {
      const requestedScope = canonicalScope(input.scope);
      const pageInput = snapshotPageInput(input);
      assertScope(requestedScope);
      await ready();
      return page(
        [...assets.values()]
          .filter((asset) => !asset.archived && visibleIn(asset, requestedScope))
          .sort((left, right) => compareCodeUnits(left.name, right.name) || compareCodeUnits(left.id, right.id)),
        pageInput,
        `assets:${scopeKey(requestedScope)}:sort:name-id:utf16-v1`,
      );
    },
    async listTags(input) {
      const requestedScope = canonicalScope(input.scope);
      const parentTagId = input.parentTagId ?? null;
      const pageInput = snapshotPageInput(input);
      const scope = tagScope(requestedScope);
      await ready();
      if (parentTagId !== null) tagForScope(parentTagId, scope);
      return page(
        [...tags.values()]
          .filter((tag) => sameScope(tag.scope, scope) && tag.parentTagId === parentTagId)
          .sort((left, right) => compareCodeUnits(left.name, right.name) || compareCodeUnits(left.id, right.id)),
        pageInput,
        `tags:${scopeKey(requestedScope)}:${scopeKey(scope)}:${parentTagId ?? "root"}:sort:name-id:utf16-v1`,
      );
    },
  };
  PERSISTENCE_BRIDGES.set(library, {
    ready,
    assertScope,
    visibleIn,
    assetById,
    readContent: (digest) => content.read(digest),
    validateBytes,
  });
  return library;
}

export function createMemoryVisualDetailPersistence(library: VisualAssetsLibrary): VisualDetailPersistence {
  const bridge = PERSISTENCE_BRIDGES.get(library);
  if (bridge === undefined) {
    throw new VisualAssetsError(
      "persistence_adapter_invalid",
      "Visual Detail persistence requires a visual-assets library created by this Module",
    );
  }
  const acceptedContent = new Map<string, { readonly mediaType: VisualAssetMediaType; readonly bytes: Uint8Array }>();
  const detailsByIntegrity = new Map<string, AcceptedVisualDetail>();
  const ownedDetails = new WeakSet<object>();

  function acceptedDetail(
    package_: CanonicalNodeDetailPackage,
    assets: AcceptedVisualDetail["assets"],
    scope: VisualAssetScope,
  ): AcceptedVisualDetail {
    const detail = deepFreeze({ package: package_, assets: [...assets] });
    ACCEPTED_DETAIL_SCOPES.set(detail, scope);
    ownedDetails.add(detail);
    return detail;
  }

  function validateAcceptedDetail(value: unknown): AcceptedVisualDetail {
    if (!plainRecord(value)) throw new VisualAssetsError("accepted_detail_invalid", "Accepted Visual Detail is invalid");
    const keys = Object.keys(value).sort();
    if (keys.join(",") !== "assets,package" || !Array.isArray(value.assets)) {
      throw new VisualAssetsError("accepted_detail_invalid", "Accepted Visual Detail must use the exact portable fields");
    }
    const package_ = validateCanonicalDetailPackage(value.package);
    const packageAssets = new Map(package_.assets.map((asset) => [asset.id, asset]));
    if (value.assets.length !== packageAssets.size) {
      throw new VisualAssetsError("accepted_detail_invalid", "Accepted Visual Detail asset inventory does not match its package");
    }
    const seen = new Set<string>();
    const assets = value.assets.map((candidate, index) => {
      if (!plainRecord(candidate)
        || Object.keys(candidate).sort().join(",") !== "assetId,byteLength,digestSha256,mediaType,provenance"
        || typeof candidate.assetId !== "string"
        || typeof candidate.digestSha256 !== "string"
        || typeof candidate.mediaType !== "string"
        || !Number.isSafeInteger(candidate.byteLength) || (candidate.byteLength as number) < 1
        || !plainRecord(candidate.provenance)
        || Object.keys(candidate.provenance).sort().join(",") !== "fileName,source"
        || (candidate.provenance.source !== "user" && candidate.provenance.source !== "system")
        || typeof candidate.provenance.fileName !== "string"
        || normalizeProvenanceFileName(candidate.provenance.fileName) === "") {
        throw new VisualAssetsError("accepted_detail_invalid", `Accepted Visual Detail asset ${index} is invalid`);
      }
      const packageAsset = packageAssets.get(candidate.assetId);
      if (packageAsset === undefined || seen.has(candidate.assetId)
        || packageAsset.digestSha256 !== candidate.digestSha256
        || packageAsset.mediaType !== candidate.mediaType) {
        throw new VisualAssetsError("accepted_detail_invalid", "Accepted Visual Detail assets do not reconnect to package identities");
      }
      seen.add(candidate.assetId);
      return deepFreeze({
        assetId: candidate.assetId,
        digestSha256: candidate.digestSha256,
        mediaType: supportedMediaType(candidate.mediaType),
        byteLength: candidate.byteLength as number,
        provenance: {
          source: candidate.provenance.source as "user" | "system",
          fileName: normalizeProvenanceFileName(candidate.provenance.fileName),
        },
      });
    });
    return deepFreeze({ package: package_, assets: [...assets] });
  }

  function ownedDetail(detail: AcceptedVisualDetail, scope: VisualAssetScope): AcceptedVisualDetail {
    const validated = validateAcceptedDetail(detail);
    const owner = ACCEPTED_DETAIL_SCOPES.get(detail);
    if (!ownedDetails.has(detail) || owner === undefined || persistenceScopeKey(owner) !== persistenceScopeKey(scope)) {
      throw new VisualAssetsError("accepted_detail_not_authorized", "Accepted Visual Detail is not authorized in this scope");
    }
    return validated;
  }

  async function resolve(detail: AcceptedVisualDetail, scope: VisualAssetScope) {
    const validated = ownedDetail(detail, scope);
    const assets = validated.assets.map((asset) => {
      const content = acceptedContent.get(asset.digestSha256);
      if (content === undefined) {
        throw new VisualAssetsError("accepted_content_missing", `Accepted visual content is missing: ${asset.digestSha256}`);
      }
      if (content.mediaType !== asset.mediaType || content.bytes.byteLength !== asset.byteLength
        || sha256(content.bytes).slice("sha256:".length) !== asset.digestSha256) {
        throw new VisualAssetsError("accepted_content_corrupt", `Accepted visual content is corrupt: ${asset.digestSha256}`);
      }
      return deepFreeze({
        assetId: asset.assetId,
        digestSha256: asset.digestSha256,
        provenance: { ...asset.provenance },
        file: memoryHarnessFile(asset.provenance.fileName, asset.mediaType, content.bytes),
      });
    });
    return deepFreeze({ package: validated.package, assets });
  }

  const persistence: VisualDetailPersistence = {
    accept(input) {
      const scope = canonicalPersistenceScope(input.scope);
      bridge.assertScope(scope);
      const package_ = validateCanonicalDetailPackage(input.package);
      return (async () => {
        await bridge.ready();
        const assets = [] as Array<AcceptedVisualDetail["assets"][number]>;
        const stagedContent = new Map<string, { readonly mediaType: VisualAssetMediaType; readonly bytes: Uint8Array }>();
        for (const packageAsset of package_.assets) {
          const asset = bridge.assetById(packageAsset.id);
          if (!bridge.visibleIn(asset, scope)) {
            throw new VisualAssetsError("asset_not_authorized", `Visual asset is not authorized in this scope: ${packageAsset.id}`);
          }
          if (asset.archived) {
            throw new VisualAssetsError("asset_unavailable", `Visual asset is unavailable: ${packageAsset.id}`);
          }
          if (asset.digest.slice("sha256:".length) !== packageAsset.digestSha256
            || asset.mediaType !== packageAsset.mediaType) {
            throw new VisualAssetsError("digest_mismatch", `Pinned visual asset does not match its logical record: ${packageAsset.id}`);
          }
          const bytes = bridge.readContent(asset.digest);
          if (bytes === undefined) throw new VisualAssetsError("content_unavailable", `Visual asset content is unavailable: ${packageAsset.id}`);
          const snapshot = bytes.slice();
          await bridge.validateBytes(asset.mediaType, snapshot);
          stagedContent.set(packageAsset.digestSha256, { mediaType: asset.mediaType, bytes: snapshot });
          assets.push(deepFreeze({
            assetId: asset.id,
            digestSha256: packageAsset.digestSha256,
            mediaType: asset.mediaType,
            byteLength: snapshot.byteLength,
            provenance: { ...asset.provenance },
          }));
        }
        const detail = acceptedDetail(package_, assets, scope);
        const key = persistenceDetailKey(scope, package_.integritySha256);
        const existing = detailsByIntegrity.get(key);
        if (existing !== undefined) {
          if (canonicalDetailJson(existing) !== canonicalDetailJson(detail)) {
            throw new VisualAssetsError("accepted_detail_conflict", "Accepted Visual Detail provenance conflicts with immutable history");
          }
          return existing;
        }
        for (const [digest, content] of stagedContent) acceptedContent.set(digest, content);
        detailsByIntegrity.set(key, detail);
        return detail;
      })();
    },
    resolve(input) {
      const scope = canonicalPersistenceScope(input.scope);
      bridge.assertScope(scope);
      return resolve(input.detail, scope);
    },
    read(input) {
      const scope = canonicalPersistenceScope(input.scope);
      bridge.assertScope(scope);
      const canonical = validateCanonicalDetailPackage(input.package);
      const detail = detailsByIntegrity.get(persistenceDetailKey(scope, canonical.integritySha256));
      if (detail === undefined || canonicalDetailJson(detail.package) !== canonicalDetailJson(canonical)) {
        throw new VisualAssetsError("accepted_detail_not_found", "Accepted Visual Detail is not present in this persistence scope");
      }
      return Promise.resolve(detail);
    },
    exportArchive(input) {
      const scope = canonicalPersistenceScope(input.scope);
      bridge.assertScope(scope);
      const details = [...input.details];
      const validated = details.map((detail) => ownedDetail(detail, scope));
      const required = new Map<string, VisualAssetMediaType>();
      for (const detail of validated) {
        for (const asset of detail.assets) {
          const existing = required.get(asset.digestSha256);
          if (existing !== undefined && existing !== asset.mediaType) {
            throw new VisualAssetsError("accepted_content_corrupt", "One accepted digest has conflicting media types");
          }
          required.set(asset.digestSha256, asset.mediaType);
        }
      }
      const contents = [...required]
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([digestSha256, mediaType]) => {
          const content = acceptedContent.get(digestSha256);
          if (content === undefined) throw new VisualAssetsError("accepted_content_missing", `Accepted visual content is missing: ${digestSha256}`);
          if (content.mediaType !== mediaType || sha256(content.bytes).slice("sha256:".length) !== digestSha256) {
            throw new VisualAssetsError("accepted_content_corrupt", `Accepted visual content is corrupt: ${digestSha256}`);
          }
          return deepFreeze({
            digestSha256,
            mediaType,
            byteLength: content.bytes.byteLength,
            contentBase64: Buffer.from(content.bytes).toString("base64"),
          });
        });
      return Promise.resolve(deepFreeze({ version: 1 as const, details: validated, contents }));
    },
    importArchive(input) {
      const scope = canonicalPersistenceScope(input.scope);
      bridge.assertScope(scope);
      const archive = snapshotVisualDetailArchive(throttleImportArchive(input.archive));
      return (async () => {
        const importedContent = new Map<string, { readonly mediaType: VisualAssetMediaType; readonly bytes: Uint8Array }>();
        for (const [index, candidate] of archive.contents.entries()) {
        if (!plainRecord(candidate)
          || Object.keys(candidate).sort().join(",") !== "byteLength,contentBase64,digestSha256,mediaType"
          || typeof candidate.digestSha256 !== "string" || !isPlainSha256(candidate.digestSha256)
          || typeof candidate.contentBase64 !== "string"
          || !Number.isSafeInteger(candidate.byteLength) || (candidate.byteLength as number) < 1) {
          throw new VisualAssetsError("archive_content_invalid", `Visual Detail archive content ${index} is invalid`);
        }
        if (importedContent.has(candidate.digestSha256)) {
          throw new VisualAssetsError("archive_content_duplicate", `Visual Detail archive repeats content: ${candidate.digestSha256}`);
        }
        const bytes = new Uint8Array(Buffer.from(candidate.contentBase64, "base64"));
        if (Buffer.from(bytes).toString("base64") !== candidate.contentBase64
          || bytes.byteLength !== candidate.byteLength
          || sha256(bytes).slice("sha256:".length) !== candidate.digestSha256) {
          throw new VisualAssetsError("archive_content_corrupt", `Visual Detail archive content ${index} failed integrity verification`);
        }
        const mediaType = supportedMediaType(candidate.mediaType);
        await bridge.validateBytes(mediaType, bytes);
        importedContent.set(candidate.digestSha256, { mediaType, bytes });
        }
        const portableDetails = archive.details.map(validateAcceptedDetail);
        const detailKeys = new Set<string>();
        if (portableDetails.some((detail) => !detailKeys.add(detail.package.integritySha256))) {
          throw new VisualAssetsError("archive_detail_duplicate", "Visual Detail archive repeats one canonical package");
        }
        const reachable = new Set(portableDetails.flatMap((detail) => detail.assets.map((asset) => asset.digestSha256)));
        for (const detail of portableDetails) {
          for (const asset of detail.assets) {
            const content = importedContent.get(asset.digestSha256);
            if (content === undefined) throw new VisualAssetsError("accepted_content_missing", `Accepted visual content is missing: ${asset.digestSha256}`);
            if (content.mediaType !== asset.mediaType || content.bytes.byteLength !== asset.byteLength) {
              throw new VisualAssetsError("archive_content_corrupt", `Accepted visual content metadata is corrupt: ${asset.digestSha256}`);
            }
          }
        }
        if ([...importedContent.keys()].some((digest) => !reachable.has(digest))) {
          throw new VisualAssetsError("archive_content_unreachable", "Visual Detail archive contains unreachable content");
        }
        const details = portableDetails.map((detail) => {
          const key = persistenceDetailKey(scope, detail.package.integritySha256);
          const existing = detailsByIntegrity.get(key);
          if (existing !== undefined) {
            if (canonicalDetailJson(existing) !== canonicalDetailJson(detail)) {
              throw new VisualAssetsError("accepted_detail_conflict", "Imported Visual Detail provenance conflicts with immutable history");
            }
            return existing;
          }
          return acceptedDetail(detail.package, detail.assets, scope);
        });
        for (const [digest, content] of importedContent) {
          acceptedContent.set(digest, { mediaType: content.mediaType, bytes: content.bytes.slice() });
        }
        for (const detail of details) {
          detailsByIntegrity.set(persistenceDetailKey(scope, detail.package.integritySha256), detail);
        }
        return Object.freeze(details);
      })();
    },
  };
  return persistence;
}

export async function createFileVisualDetailPersistence(
  library: VisualAssetsLibrary,
  storagePath: string,
): Promise<VisualDetailPersistence> {
  if (typeof storagePath !== "string" || storagePath.length === 0) {
    throw new VisualAssetsError("persistence_path_invalid", "Visual Detail persistence path is required");
  }
  let memory = createMemoryVisualDetailPersistence(library);
  let details: AcceptedVisualDetail[] = [];
  try {
    const stored = JSON.parse(await readFile(storagePath, "utf8")) as unknown;
    if (!plainRecord(stored) || stored.version !== 1 || !Array.isArray(stored.scopes)
      || Object.keys(stored).sort().join(",") !== "scopes,version") {
      throw new VisualAssetsError("persistence_store_corrupt", "Durable Visual Detail persistence is invalid");
    }
    const storedScopes = new Set<string>();
    for (const entry of stored.scopes) {
      if (!plainRecord(entry) || Object.keys(entry).sort().join(",") !== "archive,scope") {
        throw new VisualAssetsError("persistence_store_corrupt", "Durable Visual Detail scope entry is invalid");
      }
      const scope = canonicalPersistenceScope(entry.scope as VisualAssetScope);
      if (!storedScopes.add(persistenceScopeKey(scope))) {
        throw new VisualAssetsError("persistence_store_corrupt", "Durable Visual Detail scope is duplicated");
      }
      const imported = await memory.importArchive({ archive: entry.archive as VisualDetailArchive, scope });
      details.push(...imported);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      if (error instanceof VisualAssetsError) throw error;
      throw new VisualAssetsError("persistence_store_corrupt", "Durable Visual Detail persistence could not be read");
    }
  }

  let tail: Promise<void> = Promise.resolve();
  function serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = tail.then(work, work);
    tail = result.then(() => undefined, () => undefined);
    return result;
  }
  async function groupedArchives(
    candidate: VisualDetailPersistence,
    candidateDetails: readonly AcceptedVisualDetail[],
  ): Promise<readonly { readonly scope: VisualAssetScope; readonly archive: VisualDetailArchive }[]> {
    const groups = new Map<string, { scope: VisualAssetScope; details: AcceptedVisualDetail[] }>();
    for (const detail of candidateDetails) {
      const scope = ACCEPTED_DETAIL_SCOPES.get(detail);
      if (scope === undefined) throw new VisualAssetsError("accepted_detail_invalid", "Accepted Visual Detail owner is missing");
      const key = persistenceScopeKey(scope);
      const group = groups.get(key) ?? { scope, details: [] };
      group.details.push(detail);
      groups.set(key, group);
    }
    return Promise.all([...groups.values()]
      .sort((left, right) => compareCodeUnits(persistenceScopeKey(left.scope), persistenceScopeKey(right.scope)))
      .map(async (group) => ({
        scope: group.scope,
        archive: await candidate.exportArchive({ details: group.details, scope: group.scope }),
      })));
  }
  async function cloneState(): Promise<{ persistence: VisualDetailPersistence; details: AcceptedVisualDetail[] }> {
    const candidate = createMemoryVisualDetailPersistence(library);
    const cloned: AcceptedVisualDetail[] = [];
    for (const entry of await groupedArchives(memory, details)) {
      cloned.push(...await candidate.importArchive(entry));
    }
    return { persistence: candidate, details: cloned };
  }
  function upsertDetails(
    existing: readonly AcceptedVisualDetail[],
    incoming: readonly AcceptedVisualDetail[],
  ): AcceptedVisualDetail[] {
    const merged = new Map<string, AcceptedVisualDetail>();
    for (const detail of [...existing, ...incoming]) {
      const scope = ACCEPTED_DETAIL_SCOPES.get(detail);
      if (scope === undefined) throw new VisualAssetsError("accepted_detail_invalid", "Accepted Visual Detail owner is missing");
      merged.set(persistenceDetailKey(scope, detail.package.integritySha256), detail);
    }
    return [...merged]
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([, detail]) => detail);
  }
  async function persist(
    candidate: VisualDetailPersistence,
    candidateDetails: readonly AcceptedVisualDetail[],
  ): Promise<void> {
    const scopes = await groupedArchives(candidate, candidateDetails);
    const directory = dirname(storagePath);
    await mkdir(directory, { recursive: true });
    const temporary = `${storagePath}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify({ version: 1, scopes })}\n`, "utf8");
      await file.sync();
          } finally {
      await file.close();
    }
    try {
      await rename(temporary, storagePath);
    } catch (error) {
      try {
        await unlink(temporary);
      } catch {
        // best-effort staging cleanup; failure to unlink must still surface the primary error
      }
      throw error;
    }
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  }

  return {
    accept(input) {
      const prepared = {
        package: validateCanonicalDetailPackage(input.package),
        scope: canonicalPersistenceScope(input.scope),
      };
      return serialize(async () => {
        const candidate = await cloneState();
        const detail = await candidate.persistence.accept(prepared);
        candidate.details = upsertDetails(candidate.details, [detail]);
        await persist(candidate.persistence, candidate.details);
        memory = candidate.persistence;
        details = candidate.details;
        return detail;
      });
    },
    async resolve(input) {
      const scope = canonicalPersistenceScope(input.scope);
      if (persistenceScopeKey(ACCEPTED_DETAIL_SCOPES.get(input.detail) ?? { kind: "library" }) !== persistenceScopeKey(scope)
        || !ACCEPTED_DETAIL_SCOPES.has(input.detail)) {
        throw new VisualAssetsError("accepted_detail_not_authorized", "Accepted Visual Detail is not authorized in this scope");
      }
      const current = await memory.read({ package: input.detail.package, scope });
      return memory.resolve({ detail: current, scope });
    },
    read(input) {
      return memory.read(input);
    },
    async exportArchive(input) {
      const scope = canonicalPersistenceScope(input.scope);
      if (input.details.some((detail) => !ACCEPTED_DETAIL_SCOPES.has(detail)
        || persistenceScopeKey(ACCEPTED_DETAIL_SCOPES.get(detail)!) !== persistenceScopeKey(scope))) {
        throw new VisualAssetsError("accepted_detail_not_authorized", "Accepted Visual Detail is not authorized in this scope");
      }
      const current = await Promise.all(input.details.map((detail) => memory.read({ package: detail.package, scope })));
      return memory.exportArchive({ details: current, scope });
    },
    importArchive(input) {
      const prepared = {
        archive: snapshotVisualDetailArchive(throttleImportArchive(input.archive)),
        scope: canonicalPersistenceScope(input.scope),
      };
      return serialize(async () => {
        const candidate = await cloneState();
        const imported = await candidate.persistence.importArchive(prepared);
        candidate.details = upsertDetails(candidate.details, imported);
        await persist(candidate.persistence, candidate.details);
        memory = candidate.persistence;
        details = candidate.details;
        return imported;
      });
    },
  };
}


function normalizeProvenanceFileName(value: string): string {
  const tail = value.split(/[\\/]/).pop() ?? "";
  if (tail.length === 0 || tail === "." || tail === ".." || tail.includes("\0")) {
    throw new VisualAssetsError("accepted_detail_invalid", "Accepted Visual Detail provenance filename is invalid");
  }
  return tail;
}

function throttleImportArchive(archive: VisualDetailArchive): VisualDetailArchive {
  if (!plainRecord(archive) || Object.keys(archive).sort().join(",") !== "contents,details,version"
    || archive.version !== 1 || !Array.isArray(archive.details) || !Array.isArray(archive.contents)) {
    throw new VisualAssetsError("archive_content_invalid", "Visual Detail archive is invalid");
  }
  if (archive.details.length > IMPORT_DETAIL_LIMIT) {
    throw new VisualAssetsError("archive_detail_invalid", `Visual Detail archive details exceed ${IMPORT_DETAIL_LIMIT}`);
  }
  if (archive.contents.length > IMPORT_CONTENT_LIMIT) {
    throw new VisualAssetsError("archive_content_invalid", `Visual Detail archive contents exceed ${IMPORT_CONTENT_LIMIT}`);
  }
  let totalBytes = 0;
  for (const content of archive.contents as { byteLength: number }[]) {
    totalBytes += content.byteLength;
    if (totalBytes > IMPORT_TOTAL_INSERT_LIMIT) {
      throw new VisualAssetsError("archive_content_invalid", "Visual Detail archive total bytes exceed limits");
    }
  }
  return archive;
}

function validateCanonicalDetailPackage(value: unknown): CanonicalNodeDetailPackage {
  if (!plainRecord(value)
    || Object.keys(value).sort().join(",") !== "assets,components,integritySha256,mounts,version"
    || value.version !== 1 || !Array.isArray(value.components) || !Array.isArray(value.mounts)
    || !Array.isArray(value.assets) || typeof value.integritySha256 !== "string"
    || !isPlainSha256(value.integritySha256)) {
    throw new VisualAssetsError("detail_package_invalid", "Canonical Node Detail package is invalid");
  }
  if (value.components.length > 64 || value.mounts.length > 128 || value.assets.length > 32) {
    throw new VisualAssetsError("detail_package_invalid", "Canonical Node Detail package counts exceed V1 limits");
  }
  const componentIds = new Set<string>();
  for (const [index, component] of value.components.entries()) {
    if (!plainRecord(component) || Object.keys(component).sort().join(",") !== "css,html,id,order"
      || !boundedPersistenceIdentity(component.id) || component.order !== index
      || typeof component.html !== "string" || typeof component.css !== "string"
      || componentIds.has(component.id as string)) {
      throw new VisualAssetsError("detail_package_invalid", `Canonical Node Detail component ${index} is invalid`);
    }
    componentIds.add(component.id as string);
  }
  const assetIds = new Set<string>();
  for (const [index, asset] of value.assets.entries()) {
    if (!plainRecord(asset)
      || Object.keys(asset).sort().join(",") !== "digestSha256,id,mediaType,representation"
      || !boundedPersistenceIdentity(asset.id) || typeof asset.digestSha256 !== "string"
      || !isPlainSha256(asset.digestSha256) || asset.representation !== "image"
      || assetIds.has(asset.id as string)) {
      throw new VisualAssetsError("detail_package_invalid", `Canonical Node Detail asset ${index} is invalid`);
    }
    supportedMediaType(asset.mediaType);
    assetIds.add(asset.id as string);
  }
  const mountIds = new Set<string>();
  for (const [index, mount] of value.mounts.entries()) {
    if (!plainRecord(mount) || !boundedPersistenceIdentity(mount.id)
      || !boundedPersistenceIdentity(mount.componentId) || !componentIds.has(mount.componentId as string)
      || !boundedPersistenceIdentity(mount.host) || mountIds.has(mount.id as string)) {
      throw new VisualAssetsError("detail_package_invalid", `Canonical Node Detail mount ${index} is invalid`);
    }
    if (mount.kind === "asset") {
      if (Object.keys(mount).sort().join(",") !== "assetId,componentId,host,id,kind"
        || !boundedPersistenceIdentity(mount.assetId) || !assetIds.has(mount.assetId as string)) {
        throw new VisualAssetsError("detail_package_invalid", `Canonical Node Detail asset mount ${index} is invalid`);
      }
    } else if (mount.kind === "capability") {
      if (Object.keys(mount).sort().join(",") !== "capability,componentId,host,id,kind"
        || !validPersistenceCapability(mount.capability)) {
        throw new VisualAssetsError("detail_package_invalid", `Canonical Node Detail capability mount ${index} is invalid`);
      }
    } else {
      throw new VisualAssetsError("detail_package_invalid", `Canonical Node Detail mount ${index} kind is invalid`);
    }
    mountIds.add(mount.id as string);
  }
  const { integritySha256, ...content } = value;
  const canonical = canonicalDetailJson(content);
  if (Buffer.byteLength(canonical, "utf8") > 512 * 1024) {
    throw new VisualAssetsError("detail_package_too_large", "Canonical Node Detail package exceeds the V1 byte limit");
  }
  const actual = createHash("sha256").update(canonical).digest("hex");
  if (integritySha256 !== actual) {
    throw new VisualAssetsError("detail_package_integrity_mismatch", "Canonical Node Detail package integrity does not match its content");
  }
  return deepFreeze(JSON.parse(JSON.stringify(value)) as CanonicalNodeDetailPackage);
}

function validPersistenceCapability(value: unknown): boolean {
  if (!plainRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "link") {
    return Object.keys(value).sort().join(",") === "href,kind" && typeof value.href === "string";
  }
  if (value.kind !== "expand" && value.kind !== "reference" && value.kind !== "invoke" && value.kind !== "input"
    || Object.keys(value).sort().join(",") !== "action,kind" || !plainRecord(value.action)
    || Object.keys(value.action).sort().join(",") !== "clientKey,sourceLayer,sourceNode"
    || !boundedPersistenceIdentity(value.action.clientKey)) return false;
  return validPersistenceReference(value.action.sourceLayer) && validPersistenceReference(value.action.sourceNode);
}

function validPersistenceReference(value: unknown): boolean {
  return plainRecord(value) && Object.keys(value).length > 0
    && Object.keys(value).every((key) => key === "id" || key === "clientKey")
    && (value.id === undefined || (Number.isSafeInteger(value.id) && (value.id as number) > 0))
    && (value.clientKey === undefined || boundedPersistenceIdentity(value.clientKey));
}

function boundedPersistenceIdentity(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value.trim() === value && !value.includes("\0")
    && Buffer.byteLength(value, "utf8") <= 128;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function isPlainSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function supportedMediaType(value: unknown): VisualAssetMediaType {
  if (value !== "image/jpeg" && value !== "image/png" && value !== "image/svg+xml") {
    throw new VisualAssetsError("media_type_unsupported", `Unsupported visual asset media type: ${String(value)}`);
  }
  return value;
}

function canonicalPersistenceScope(scope: VisualAssetScope): VisualAssetScope {
  if (!plainRecord(scope)) throw new VisualAssetsError("scope_invalid", "Visual Detail scope is invalid");
  if (scope.kind === "library" && Object.keys(scope).sort().join(",") === "kind") {
    return Object.freeze({ kind: "library" });
  }
  if (scope.kind === "project" && Object.keys(scope).sort().join(",") === "kind,projectId"
    && Number.isSafeInteger(scope.projectId) && (scope.projectId as number) > 0) {
    return Object.freeze({ kind: "project", projectId: scope.projectId as number });
  }
  if (scope.kind === "thread" && Object.keys(scope).sort().join(",") === "kind,threadId"
    && Number.isSafeInteger(scope.threadId) && (scope.threadId as number) > 0) {
    return Object.freeze({ kind: "thread", threadId: scope.threadId as number });
  }
  throw new VisualAssetsError("scope_invalid", "Visual Detail scope is invalid");
}

function persistenceScopeKey(scope: VisualAssetScope): string {
  if (scope.kind === "library") return "library";
  if (scope.kind === "project") return `project:${scope.projectId}`;
  return `thread:${scope.threadId}`;
}

function persistenceDetailKey(scope: VisualAssetScope, integritySha256: string): string {
  return `${persistenceScopeKey(scope)}:${integritySha256}`;
}

function snapshotVisualDetailArchive(value: unknown): VisualDetailArchive {
  let snapshot: unknown;
  try {
    snapshot = structuredClone(value);
  } catch {
    throw new VisualAssetsError("archive_invalid", "Visual Detail archive must be snapshot-safe data");
  }
  if (!plainRecord(snapshot) || Object.keys(snapshot).sort().join(",") !== "contents,details,version"
    || snapshot.version !== 1 || !Array.isArray(snapshot.details) || !Array.isArray(snapshot.contents)) {
    throw new VisualAssetsError("archive_invalid", "Visual Detail archive is invalid");
  }
  return snapshot as unknown as VisualDetailArchive;
}

function canonicalDetailJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalDetailJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalDetailJson(record[key])}`).join(",")}}`;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
