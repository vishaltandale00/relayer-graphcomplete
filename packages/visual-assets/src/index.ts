import { createHash, randomUUID } from "node:crypto";
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

  return {
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
}
