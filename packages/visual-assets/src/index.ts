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
  readonly preview: {
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
  download(input: { readonly assetId: string } | { readonly digest: string }): Promise<HarnessFileHandle>;
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

  function assertScope(scope: VisualAssetScope): void {
    if (scope.kind === "library") return;
    if (scope.kind === "project" && projectIds.has(scope.projectId)) return;
    if (scope.kind === "thread"
      && (projectByThread.has(scope.threadId) || standaloneThreadIds.has(scope.threadId))) return;
    throw new VisualAssetsError("scope_not_authorized", `Visual asset ${scope.kind} scope is not authorized`);
  }

  function tagScope(scope: VisualAssetScope): VisualAssetScope {
    assertScope(scope);
    if (scope.kind !== "thread") return scope;
    const projectId = projectByThread.get(scope.threadId);
    return projectId === undefined ? scope : { kind: "project", projectId };
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
      try {
        const decoded = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")) as {
          readonly v?: unknown;
          readonly context?: unknown;
          readonly offset?: unknown;
        };
        if (decoded.v !== 1 || decoded.context !== context
          || !Number.isSafeInteger(decoded.offset) || (decoded.offset as number) < 1) throw new Error("invalid");
        offset = decoded.offset as number;
      } catch {
        throw new VisualAssetsError("page_cursor_invalid", "Page cursor is invalid for this visual-assets query");
      }
    }
    const selected = items.slice(offset, offset + limit);
    const nextOffset = offset + selected.length;
    return {
      items: selected,
      nextCursor: nextOffset < items.length
        ? Buffer.from(JSON.stringify({ v: 1, context, offset: nextOffset })).toString("base64url")
        : null,
    };
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
    const replacement = Object.freeze({ ...asset, ...changes });
    assets.set(asset.id, replacement);
    return replacement;
  }

  for (const initial of options.initialTags ?? []) {
    const scope = tagScope(initial.scope);
    if (!sameScope(scope, initial.scope)) {
      throw new VisualAssetsError("tag_scope_mismatch", "Initial tag must use its owning project tag scope");
    }
    if (tags.has(initial.id)) throw new VisualAssetsError("tag_conflict", `Duplicate visual asset tag: ${initial.id}`);
    if (initial.parentTagId !== null) tagForScope(initial.parentTagId, initial.scope);
    tags.set(initial.id, Object.freeze({ ...initial }));
  }

  for (const initial of options.initialAssets ?? []) {
    const registry = registries.get(initial.registryId);
    if (registry === undefined) throw new VisualAssetsError("registry_not_found", `Unknown registry: ${initial.registryId}`);
    for (const scope of initial.scopes) assertScope(scope);
    const bytes = typeof initial.content === "string"
      ? new TextEncoder().encode(initial.content)
      : initial.content.slice();
    const digest = content.index(bytes);
    for (const tagId of initial.tagIds) {
      const tag = tags.get(tagId);
      if (tag === undefined) throw new VisualAssetsError("tag_not_found", `Unknown visual asset tag: ${tagId}`);
      if (!initial.scopes.map(tagScope).some((scope) => sameScope(scope, tag.scope))) {
        throw new VisualAssetsError("tag_scope_mismatch", "Initial asset is not associated with the tag scope");
      }
    }
    assets.set(initial.id, Object.freeze({
      id: initial.id,
      registryId: initial.registryId,
      name: initial.name,
      mediaType: initial.mediaType,
      byteLength: bytes.byteLength,
      digest,
      scopes: Object.freeze([...initial.scopes]),
      tagIds: Object.freeze([...initial.tagIds]),
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
      const name = input.name.trim();
      if (name.length === 0) throw new VisualAssetsError("asset_name_invalid", "Visual asset name is required");
      if (!supportedMediaTypes.has(input.file.mediaType)) {
        throw new VisualAssetsError("media_type_unsupported", `Unsupported visual asset media type: ${input.file.mediaType}`);
      }
      if (new Set(input.tagIds).size !== input.tagIds.length) {
        throw new VisualAssetsError("tag_relationship_malformed", "Visual asset tag relationships must be unique");
      }
      for (const tagId of input.tagIds) tagForScope(tagId, input.scope);
      const registry = registries.get(input.registryId ?? "user");
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
      if (input.file.expectedDigest !== undefined && input.file.expectedDigest !== digest) {
        throw new VisualAssetsError("digest_mismatch", "Harness file digest does not match its expected digest");
      }
      content.index(bytes);
      const asset: VisualAsset = Object.freeze({
        id: `asset_${randomUUID()}`,
        registryId: input.registryId ?? "user",
        name,
        mediaType: input.file.mediaType,
        byteLength: bytes.byteLength,
        digest,
        scopes: Object.freeze([input.scope]),
        tagIds: Object.freeze([...input.tagIds]),
        archived: false,
        provenance: Object.freeze({ source: "user", fileName: input.file.name }),
      });
      assets.set(asset.id, asset);
      return asset;
    },
    async inspect(assetId) {
      const asset = assetById(assetId);
      return {
        asset,
        preview: {
          mediaType: asset.mediaType,
          byteLength: asset.byteLength,
          digest: asset.digest,
        },
      };
    },
    async createTag(input) {
      const scope = tagScope(input.scope);
      const parent = input.parentTagId === undefined ? undefined : tagForScope(input.parentTagId, scope);
      const name = input.name.trim();
      if (name.length === 0) throw new VisualAssetsError("tag_name_invalid", "Visual asset tag name is required");
      const tag: VisualAssetTag = Object.freeze({
        id: `tag_${randomUUID()}`,
        name,
        scope,
        parentTagId: parent?.id ?? null,
        authority: "user",
      });
      tags.set(tag.id, tag);
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
      const moved = Object.freeze({ ...tag, parentTagId: parent?.id ?? null });
      tags.set(tag.id, moved);
      return moved;
    },
    async find(input) {
      assertScope(input.scope);
      const tag = tagForScope(input.tagId, input.scope);
      const items: VisualAssetFindItem[] = [
        ...[...tags.values()]
          .filter((candidate) => candidate.parentTagId === tag.id)
          .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
          .map((candidate): VisualAssetFindItem => ({ kind: "tag", tag: candidate })),
        ...[...assets.values()]
          .filter((asset) => !asset.archived && asset.tagIds.includes(tag.id) && visibleIn(asset, input.scope))
          .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
          .map((asset): VisualAssetFindItem => ({ kind: "asset", asset })),
      ];
      return page(items, input, `find:${scopeKey(tag.scope)}:${tag.id}`);
    },
    async associate(input) {
      const asset = assetById(input.assetId);
      assertScope(input.scope);
      if (asset.scopes.some((scope) => sameScope(scope, input.scope))) return asset;
      return replaceAsset(asset, { scopes: Object.freeze([...asset.scopes, input.scope]) });
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
      return replaceAsset(asset, { tagIds: Object.freeze(tagIds) });
    },
    async archive(assetId) {
      const asset = assetById(assetId);
      if (registries.get(asset.registryId)?.contentAuthority !== "user") {
        throw new VisualAssetsError("asset_content_read_only", "Visual asset content is read-only");
      }
      if (asset.archived) return asset;
      return replaceAsset(asset, { archived: true });
    },
    async download(input) {
      const asset = "assetId" in input
        ? assetById(input.assetId)
        : [...assets.values()].find((candidate) => candidate.digest === input.digest);
      if (asset === undefined) throw new VisualAssetsError("digest_not_found", "Visual asset digest is not indexed");
      const bytes = content.read(asset.digest);
      if (bytes === undefined) throw new VisualAssetsError("content_unavailable", "Visual asset content is unavailable");
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
