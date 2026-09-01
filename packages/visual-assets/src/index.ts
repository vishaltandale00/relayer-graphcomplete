import { createHash, randomUUID } from "node:crypto";

export type VisualAssetScope =
  | { readonly kind: "library" }
  | { readonly kind: "project"; readonly projectId: number }
  | { readonly kind: "thread"; readonly threadId: number };

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
  readonly mediaType: string;
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
    readonly mediaType: string;
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
  seed(digest: string, bytes: Uint8Array | undefined): void;
  read(digest: string): Uint8Array | undefined;
}

class MemoryGenericContentModule implements GenericContentModule {
  readonly #contentByDigest = new Map<string, Uint8Array>();

  index(bytes: Uint8Array): string {
    const digest = sha256(bytes);
    if (!this.#contentByDigest.has(digest)) this.#contentByDigest.set(digest, bytes.slice());
    return digest;
  }

  seed(digest: string, bytes: Uint8Array | undefined): void {
    if (bytes !== undefined) this.#contentByDigest.set(digest, bytes.slice());
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

function hasPrefix(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function uint32be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! * 0x1000000)
    + (bytes[offset + 1]! << 16)
    + (bytes[offset + 2]! << 8)
    + bytes[offset + 3]!) >>> 0;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.slice(start, end));
}

function malformed(message: string): never {
  throw new VisualAssetsError("media_content_malformed", message);
}

function mismatch(mediaType: string): never {
  throw new VisualAssetsError("media_content_mismatch", `Visual asset bytes do not match ${mediaType}`);
}

function validateSvg(bytes: Uint8Array): void {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  } catch {
    mismatch("image/svg+xml");
  }
  if (!/^(?:<\?xml\s[^>]*>\s*)?<svg\b/i.test(source)) mismatch("image/svg+xml");
  if (/<!doctype|<!entity|<\s*(?:script|foreignObject|iframe|object|embed)\b|\son[a-z]+\s*=/i.test(source)
    || /\b(?:href|xlink:href|src)\s*=\s*["']\s*(?!#)/i.test(source)
    || /url\s*\(\s*["']?\s*(?!#)/i.test(source)) {
    throw new VisualAssetsError("media_content_unsafe", "SVG contains active or externally resolved content");
  }
  const withoutComments = source.replace(/<!--[\s\S]*?-->/g, "");
  const tokens = withoutComments.match(/<[^>]+>/g);
  if (tokens === null || tokens.join("").length === 0) malformed("SVG markup is incomplete");
  const stack: string[] = [];
  for (const token of tokens) {
    if (/^<\?|^<!/.test(token)) continue;
    const closing = token.match(/^<\/\s*([A-Za-z_][\w:.-]*)\s*>$/);
    if (closing !== null) {
      if (stack.pop() !== closing[1]) malformed("SVG elements are not properly nested");
      continue;
    }
    const opening = token.match(/^<\s*([A-Za-z_][\w:.-]*)\b[^>]*>$/);
    if (opening === null) malformed("SVG contains malformed markup");
    if (!/\/\s*>$/.test(token)) stack.push(opening[1]!);
  }
  if (stack.length !== 0) malformed("SVG elements are not properly closed");
}

function validateVisualBytes(mediaType: string, bytes: Uint8Array): void {
  if (mediaType === "image/svg+xml") {
    validateSvg(bytes);
    return;
  }
  if (mediaType === "image/png") {
    if (!hasPrefix(bytes, [137, 80, 78, 71, 13, 10, 26, 10])) mismatch(mediaType);
    let offset = 8;
    let chunk = 0;
    let ended = false;
    while (offset + 12 <= bytes.length) {
      const length = uint32be(bytes, offset);
      const type = ascii(bytes, offset + 4, offset + 8);
      if (offset + 12 + length > bytes.length) malformed("PNG chunk extends beyond the file");
      if (chunk === 0 && (type !== "IHDR" || length !== 13)) malformed("PNG must begin with a complete IHDR chunk");
      if (chunk === 0 && (uint32be(bytes, offset + 8) === 0 || uint32be(bytes, offset + 12) === 0)) {
        malformed("PNG dimensions must be non-zero");
      }
      offset += 12 + length;
      chunk += 1;
      if (type === "IEND") {
        if (length !== 0 || offset !== bytes.length) malformed("PNG IEND chunk is malformed");
        ended = true;
        break;
      }
    }
    if (!ended) malformed("PNG is missing its IEND chunk");
    return;
  }
  if (mediaType === "image/webp") {
    if (!hasPrefix(bytes, [82, 73, 70, 70]) || ascii(bytes, 8, 12) !== "WEBP") mismatch(mediaType);
    if (bytes.length < 20) malformed("WebP container is incomplete");
    const declaredSize = bytes[4]! + (bytes[5]! << 8) + (bytes[6]! << 16) + (bytes[7]! * 0x1000000);
    if (declaredSize + 8 !== bytes.length) malformed("WebP RIFF structure is invalid");
    let offset = 12;
    let sawImage = false;
    while (offset + 8 <= bytes.length) {
      const type = ascii(bytes, offset, offset + 4);
      const chunkSize = bytes[offset + 4]! + (bytes[offset + 5]! << 8)
        + (bytes[offset + 6]! << 16) + (bytes[offset + 7]! * 0x1000000);
      const next = offset + 8 + chunkSize + (chunkSize % 2);
      if (next > bytes.length) malformed("WebP image chunk is incomplete");
      if (["VP8 ", "VP8L", "ANMF"].includes(type)) sawImage = true;
      if (type === "VP8X" && chunkSize < 10) malformed("WebP extended header is incomplete");
      offset = next;
    }
    if (offset !== bytes.length || !sawImage) malformed("WebP has no complete image payload");
    return;
  }
  if (mediaType === "image/gif") {
    if (ascii(bytes, 0, 6) !== "GIF87a" && ascii(bytes, 0, 6) !== "GIF89a") mismatch(mediaType);
    if (bytes.length < 14 || (bytes[6] === 0 && bytes[7] === 0) || (bytes[8] === 0 && bytes[9] === 0)) {
      malformed("GIF logical screen descriptor is incomplete");
    }
    let offset = 13;
    if ((bytes[10]! & 0x80) !== 0) offset += 3 * (2 ** ((bytes[10]! & 0x07) + 1));
    let sawImage = false;
    while (offset < bytes.length) {
      const marker = bytes[offset++]!;
      if (marker === 0x3b) {
        if (!sawImage || offset !== bytes.length) malformed("GIF trailer is misplaced");
        return;
      }
      if (marker === 0x21) {
        if (offset >= bytes.length) malformed("GIF extension is incomplete");
        offset += 1;
      } else if (marker === 0x2c) {
        if (offset + 9 > bytes.length) malformed("GIF image descriptor is incomplete");
        const packed = bytes[offset + 8]!;
        offset += 9;
        if ((packed & 0x80) !== 0) offset += 3 * (2 ** ((packed & 0x07) + 1));
        if (offset >= bytes.length) malformed("GIF image data is incomplete");
        offset += 1;
        sawImage = true;
      } else {
        malformed("GIF contains an unknown block marker");
      }
      while (offset < bytes.length) {
        const blockSize = bytes[offset++]!;
        if (blockSize === 0) break;
        offset += blockSize;
        if (offset > bytes.length) malformed("GIF data sub-block is incomplete");
      }
    }
    malformed("GIF is missing its trailer");
  }
  if (mediaType === "image/jpeg") {
    if (!hasPrefix(bytes, [0xff, 0xd8])) mismatch(mediaType);
    if (bytes.length < 8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) malformed("JPEG is missing its end marker");
    let offset = 2;
    let sawFrame = false;
    let sawScan = false;
    while (offset < bytes.length - 2) {
      if (bytes[offset] !== 0xff) malformed("JPEG marker structure is invalid");
      while (bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset++]!;
      if (marker === 0x00 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
        malformed("JPEG contains a misplaced standalone marker");
      }
      if (offset + 1 >= bytes.length) malformed("JPEG segment is incomplete");
      const segmentStart = offset;
      const segmentLength = (bytes[segmentStart]! << 8) + bytes[segmentStart + 1]!;
      if (segmentLength < 2 || segmentStart + segmentLength > bytes.length) malformed("JPEG segment is incomplete");
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        if (segmentLength < 8 || (bytes[segmentStart + 3] === 0 && bytes[segmentStart + 4] === 0)
          || (bytes[segmentStart + 5] === 0 && bytes[segmentStart + 6] === 0)) {
          malformed("JPEG frame header is invalid");
        }
        sawFrame = true;
      }
      offset = segmentStart + segmentLength;
      if (marker === 0xda) {
        sawScan = true;
        while (offset < bytes.length - 1) {
          if (bytes[offset] !== 0xff) {
            offset += 1;
            continue;
          }
          const next = bytes[offset + 1]!;
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
            offset += 2;
            continue;
          }
          break;
        }
      }
    }
    if (!sawFrame || !sawScan || offset !== bytes.length - 2) malformed("JPEG frame structure is invalid");
    return;
  }
  if (mediaType === "image/avif") {
    if (bytes.length < 16 || ascii(bytes, 4, 8) !== "ftyp") mismatch(mediaType);
    const boxSize = uint32be(bytes, 0);
    if (boxSize < 16 || boxSize > bytes.length || (boxSize - 8) % 4 !== 0) malformed("AVIF file-type box is invalid");
    const brands: string[] = [];
    for (let offset = 8; offset + 4 <= boxSize; offset += 4) brands.push(ascii(bytes, offset, offset + 4));
    if (!brands.includes("avif") && !brands.includes("avis")) mismatch(mediaType);
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
    readonly content?: string | Uint8Array;
    readonly digest?: string;
    readonly byteLength?: number;
    readonly scopes: readonly VisualAssetScope[];
    readonly tagIds: readonly string[];
  }[];
} = {}): VisualAssetsLibrary {
  const supportedMediaTypes = new Set([
    "image/avif",
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/svg+xml",
    "image/webp",
  ]);
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

  for (const initial of options.initialTags ?? []) {
    const scope = tagScope(initial.scope);
    if (!sameScope(scope, initial.scope)) {
      throw new VisualAssetsError("tag_scope_mismatch", "Initial tag must use its owning project tag scope");
    }
    if (tags.has(initial.id)) throw new VisualAssetsError("tag_conflict", `Duplicate visual asset tag: ${initial.id}`);
    if (initial.parentTagId !== null) tagForScope(initial.parentTagId, initial.scope);
    tags.set(initial.id, immutableTag({ ...initial, scope }));
  }

  const initialAssetIds = new Set<string>();
  for (const initial of options.initialAssets ?? []) {
    if (initialAssetIds.has(initial.id)) {
      throw new VisualAssetsError("asset_conflict", `Duplicate visual asset: ${initial.id}`);
    }
    initialAssetIds.add(initial.id);
  }

  for (const initial of options.initialAssets ?? []) {
    const registry = registries.get(initial.registryId);
    if (registry === undefined) throw new VisualAssetsError("registry_not_found", `Unknown registry: ${initial.registryId}`);
    if (!supportedMediaTypes.has(initial.mediaType)) {
      throw new VisualAssetsError("media_type_unsupported", `Unsupported visual asset media type: ${initial.mediaType}`);
    }
    if (new Set(initial.tagIds).size !== initial.tagIds.length) {
      throw new VisualAssetsError("tag_relationship_malformed", "Initial visual asset tag relationships must be unique");
    }
    const scopes = Object.freeze(initial.scopes.map((scope) => {
      assertScope(scope);
      return canonicalScope(scope);
    }));
    const bytes = typeof initial.content === "string"
      ? new TextEncoder().encode(initial.content)
      : initial.content?.slice();
    if (bytes === undefined && initial.digest === undefined) {
      throw new VisualAssetsError("content_unavailable", "Initial visual asset requires content or a persisted digest");
    }
    if (initial.digest !== undefined
      && !/^sha256:[0-9a-f]{64}$/.test(initial.digest)) {
      throw new VisualAssetsError("digest_invalid", "Initial visual asset digest is invalid");
    }
    if (bytes === undefined
      && (!Number.isSafeInteger(initial.byteLength) || (initial.byteLength as number) < 0)) {
      throw new VisualAssetsError("content_length_invalid", "Persisted visual asset byte length is invalid");
    }
    if (bytes !== undefined && initial.digest === undefined) validateVisualBytes(initial.mediaType, bytes);
    const digest = initial.digest ?? content.index(bytes!);
    if (initial.digest !== undefined) content.seed(digest, bytes);
    for (const tagId of initial.tagIds) {
      const tag = tags.get(tagId);
      if (tag === undefined) throw new VisualAssetsError("tag_not_found", `Unknown visual asset tag: ${tagId}`);
      if (!scopes.map(tagScope).some((scope) => sameScope(scope, tag.scope))) {
        throw new VisualAssetsError("tag_scope_mismatch", "Initial asset is not associated with the tag scope");
      }
    }
    assets.set(initial.id, immutableAsset({
      id: initial.id,
      registryId: initial.registryId,
      name: initial.name,
      mediaType: initial.mediaType,
      byteLength: initial.byteLength ?? bytes!.byteLength,
      digest,
      scopes,
      tagIds: initial.tagIds,
      archived: false,
      provenance: Object.freeze({ source: "system", fileName: initial.fileName }),
    }));
    defaultTagIdsByAsset.set(initial.id, new Set(initial.tagIds));
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
      const registryId = input.registryId ?? "user";
      const name = input.name.trim();
      if (name.length === 0) throw new VisualAssetsError("asset_name_invalid", "Visual asset name is required");
      if (!supportedMediaTypes.has(mediaType)) {
        throw new VisualAssetsError("media_type_unsupported", `Unsupported visual asset media type: ${mediaType}`);
      }
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
        bytes = await input.file.read();
      } catch {
        throw new VisualAssetsError("file_unavailable", "Harness file is unavailable");
      }
      const digest = sha256(bytes);
      if (expectedDigest !== undefined && expectedDigest !== digest) {
        throw new VisualAssetsError("digest_mismatch", "Harness file digest does not match its expected digest");
      }
      validateVisualBytes(mediaType, bytes);
      content.index(bytes);
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
      const asset = assetById(assetId);
      const bytes = content.read(asset.digest);
      if (bytes === undefined) throw new VisualAssetsError("content_unavailable", "Visual asset content is unavailable");
      if (bytes.byteLength !== asset.byteLength) {
        throw new VisualAssetsError("content_corrupt", "Visual asset content length does not match its logical record");
      }
      validateVisualBytes(asset.mediaType, bytes);
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
      const scope = tagScope(input.scope);
      const parent = input.parentTagId === undefined ? undefined : tagForScope(input.parentTagId, scope);
      const name = input.name.trim();
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
      const tag = tags.get(input.tagId);
      if (tag === undefined) throw new VisualAssetsError("tag_not_found", `Unknown visual asset tag: ${input.tagId}`);
      if (tag.authority !== "user") throw new VisualAssetsError("tag_read_only", "Visual asset tag is read-only");
      const parent = input.parentTagId === null ? null : tagForScope(input.parentTagId, tag.scope);
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
      assertScope(input.scope);
      const tag = tagForScope(input.tagId, input.scope);
      const items: VisualAssetFindItem[] = [
        ...[...tags.values()]
          .filter((candidate) => candidate.parentTagId === tag.id)
          .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
          .map((candidate): VisualAssetFindItem => Object.freeze({ kind: "tag", tag: candidate })),
        ...[...assets.values()]
          .filter((asset) => !asset.archived && asset.tagIds.includes(tag.id) && visibleIn(asset, input.scope))
          .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
          .map((asset): VisualAssetFindItem => Object.freeze({ kind: "asset", asset })),
      ];
      return page(items, input, `find:${scopeKey(tag.scope)}:${tag.id}`);
    },
    async associate(input) {
      const asset = assetById(input.assetId);
      assertScope(input.scope);
      const scope = canonicalScope(input.scope);
      if (asset.scopes.some((associated) => sameScope(associated, scope))) return asset;
      return replaceAsset(asset, { scopes: [...asset.scopes, scope] });
    },
    async organize(input) {
      const asset = assetById(input.assetId);
      const associatedTagScopes = asset.scopes.map(tagScope);
      const added = input.addTagIds.map((tagId) => {
        const tag = tags.get(tagId);
        if (tag === undefined) throw new VisualAssetsError("tag_not_found", `Unknown visual asset tag: ${tagId}`);
        if (!associatedTagScopes.some((scope) => sameScope(scope, tag.scope))) {
          throw new VisualAssetsError("tag_scope_mismatch", "Asset is not associated with the tag scope");
        }
        return tag.id;
      });
      for (const tagId of input.removeTagIds) {
        if (!tags.has(tagId)) throw new VisualAssetsError("tag_not_found", `Unknown visual asset tag: ${tagId}`);
        if (defaultTagIdsByAsset.get(asset.id)?.has(tagId)
          && registries.get(asset.registryId)?.defaultRelationshipAuthority === "read-only") {
          throw new VisualAssetsError("tag_relationship_read_only", "Default visual asset tag relationship is read-only");
        }
      }
      const removed = new Set(input.removeTagIds);
      const tagIds = [...asset.tagIds.filter((tagId) => !removed.has(tagId))];
      for (const tagId of added) if (!tagIds.includes(tagId)) tagIds.push(tagId);
      return replaceAsset(asset, { tagIds });
    },
    async archive(assetId) {
      const asset = assetById(assetId);
      if (registries.get(asset.registryId)?.contentAuthority !== "user") {
        throw new VisualAssetsError("asset_content_read_only", "Visual asset content is read-only");
      }
      if (asset.archived) return asset;
      return replaceAsset(asset, { archived: true });
    },
    async download(assetId) {
      const asset = assetById(assetId);
      const bytes = content.read(asset.digest);
      if (bytes === undefined) throw new VisualAssetsError("content_unavailable", "Visual asset content is unavailable");
      if (bytes.byteLength !== asset.byteLength) {
        throw new VisualAssetsError("content_corrupt", "Visual asset content length does not match its logical record");
      }
      validateVisualBytes(asset.mediaType, bytes);
      return memoryHarnessFile(asset.provenance.fileName, asset.mediaType, bytes);
    },
    async listRegistries(input) {
      assertScope(input.scope);
      return page(
        [...registries.values()].sort((left, right) => left.id.localeCompare(right.id)),
        input,
        `registries:${scopeKey(input.scope)}`,
      );
    },
    async listAssets(input) {
      assertScope(input.scope);
      return page(
        [...assets.values()]
          .filter((asset) => !asset.archived && visibleIn(asset, input.scope))
          .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)),
        input,
        `assets:${scopeKey(input.scope)}`,
      );
    },
    async listTags(input) {
      const scope = tagScope(input.scope);
      const parentTagId = input.parentTagId ?? null;
      if (parentTagId !== null) tagForScope(parentTagId, scope);
      return page(
        [...tags.values()]
          .filter((tag) => sameScope(tag.scope, scope) && tag.parentTagId === parentTagId)
          .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)),
        input,
        `tags:${scopeKey(scope)}:${parentTagId ?? "root"}`,
      );
    },
  };
}
