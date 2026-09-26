import { createHash } from "node:crypto";

export type VisualAssetScope =
  | { readonly kind: "library" }
  | { readonly kind: "project"; readonly projectId: number }
  | { readonly kind: "thread"; readonly threadId: number };
export type WritableVisualAssetScope = Exclude<VisualAssetScope, { readonly kind: "library" }>;
export type VisualAssetMediaType = "image/jpeg" | "image/png" | "image/svg+xml";
export interface VisualAssetFile {
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
  readonly provenance: { readonly source: "user" | "system"; readonly fileName: string };
}
export interface VisualAssetTag {
  readonly id: string;
  readonly name: string;
  readonly scope: VisualAssetScope;
  readonly parentTagId: string | null;
  readonly authority: "user" | "system";
}
export interface VisualAssetRegistry {
  readonly id: string;
  readonly name: string;
  readonly source: string;
  readonly contentAuthority: "user" | "read-only";
  readonly defaultRelationshipAuthority: "user" | "read-only";
}
export type VisualAssetFindItem =
  | { readonly kind: "tag"; readonly tag: VisualAssetTag }
  | { readonly kind: "asset"; readonly asset: VisualAsset };
export interface VisualAssetPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}
export interface VisualAssetInspection {
  readonly asset: VisualAsset;
  readonly preview: VisualAssetFile;
}
interface PageRequest {
  readonly scope: VisualAssetScope;
  readonly limit?: number;
  readonly cursor?: string;
}
type Request = (path: string, init?: RequestInit) => Promise<unknown>;

export class GraphVisualAssets {
  constructor(private readonly send: Request) {}

  async scope(): Promise<WritableVisualAssetScope> {
    const body = await this.send("/api/graph/visual-assets/scope");
    if (!record(body) || !writableScope(body.scope)) throw new Error("Graph returned an invalid visual-assets scope");
    return body.scope;
  }

  async add(input: {
    readonly file: VisualAssetFile;
    readonly scope: WritableVisualAssetScope;
    readonly name: string;
    readonly tagIds?: readonly string[];
    readonly registryId?: string;
  }): Promise<VisualAsset> {
    const { file, name, registryId } = input;
    const scope = { ...input.scope };
    const tagIds = [...(input.tagIds ?? [])];
    const { name: fileName, mediaType, expectedDigest } = file;
    const bytes = (await file.read()).slice();
    const result = await this.operation<VisualAsset>({
      kind: "add", scope, name, tagIds,
      ...(registryId === undefined ? {} : { registryId }),
      file: {
        name: fileName, mediaType,
        ...(expectedDigest === undefined ? {} : { expectedDigest }),
        contentBase64: Buffer.from(bytes).toString("base64"),
      },
    });
    if (!record(result) || typeof result.id !== "string" || typeof result.digest !== "string") {
      throw new Error("Graph returned an invalid visual asset");
    }
    return result;
  }

  listAssets(input: PageRequest): Promise<VisualAssetPage<VisualAsset>> {
    return this.operation({ kind: "list-assets", ...input });
  }
  listTags(input: PageRequest & { readonly parentTagId?: string | null }): Promise<VisualAssetPage<VisualAssetTag>> {
    return this.operation({ kind: "list-tags", ...input });
  }
  listRegistries(input: PageRequest): Promise<VisualAssetPage<VisualAssetRegistry>> {
    return this.operation({ kind: "list-registries", ...input });
  }
  find(input: PageRequest & { readonly tagId: string }): Promise<VisualAssetPage<VisualAssetFindItem>> {
    return this.operation({ kind: "find", ...input });
  }
  async inspect(assetId: string, scope: VisualAssetScope): Promise<VisualAssetInspection> {
    const result = await this.operation<{ asset: VisualAsset; preview: unknown }>({ kind: "inspect", assetId, scope });
    return { asset: result.asset, preview: decodedFile(result.preview) };
  }
  async download(assetId: string, scope: VisualAssetScope): Promise<VisualAssetFile> {
    return decodedFile(await this.operation({ kind: "download", assetId, scope }));
  }
  createTag(input: { readonly scope: WritableVisualAssetScope; readonly name: string; readonly parentTagId?: string }): Promise<VisualAssetTag> {
    return this.operation({ kind: "create-tag", ...input });
  }
  moveTag(input: { readonly scope: WritableVisualAssetScope; readonly tagId: string; readonly parentTagId: string | null }): Promise<VisualAssetTag> {
    return this.operation({ kind: "move-tag", ...input });
  }
  associate(input: { readonly scope: WritableVisualAssetScope; readonly assetId: string }): Promise<VisualAsset> {
    return this.operation({ kind: "associate", ...input });
  }
  organize(input: {
    readonly scope: WritableVisualAssetScope;
    readonly assetId: string;
    readonly addTagIds: readonly string[];
    readonly removeTagIds: readonly string[];
  }): Promise<VisualAsset> {
    return this.operation({ kind: "organize", ...input });
  }
  archive(assetId: string, scope: WritableVisualAssetScope): Promise<VisualAsset> {
    return this.operation({ kind: "archive", assetId, scope });
  }
  private async operation<T>(operation: Record<string, unknown>): Promise<T> {
    return await this.send("/api/graph/visual-assets/operations", {
      method: "POST", body: JSON.stringify({ operation }),
    }) as T;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function writableScope(value: unknown): value is WritableVisualAssetScope {
  if (!record(value)) return false;
  const id = value.kind === "project" ? value.projectId : value.kind === "thread" ? value.threadId : undefined;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0;
}
function decodedFile(value: unknown): VisualAssetFile {
  if (!record(value) || typeof value.name !== "string" || typeof value.mediaType !== "string"
    || typeof value.contentBase64 !== "string" || value.contentBase64.length > 4 * Math.ceil(8 * 1024 * 1024 / 3)
    || (value.expectedDigest !== undefined && typeof value.expectedDigest !== "string")) {
    throw new Error("Graph returned an invalid visual asset file");
  }
  const bytes = Buffer.from(value.contentBase64, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== value.contentBase64
    || (value.expectedDigest !== undefined
      && `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== value.expectedDigest)) {
    throw new Error("Graph returned corrupt visual asset bytes");
  }
  return Object.freeze({
    name: value.name,
    mediaType: value.mediaType,
    ...(value.expectedDigest === undefined ? {} : { expectedDigest: value.expectedDigest }),
    async read() { return new Uint8Array(bytes); },
  });
}
