import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileVisualAssetsLibrary,
  createFileVisualDetailPersistence,
  createMemoryVisualAssetsLibrary,
  createMemoryVisualDetailPersistence,
  memoryHarnessFile,
  validateVisualAssetImportContent,
} from "../src/index.js";

function base64Bytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

const pngBytes = base64Bytes(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
);
const webpBytes = base64Bytes("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/vuU");
const gifBytes = base64Bytes("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==");
const jpegBytes = base64Bytes(
  "/9j/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABQj/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCPgDFmv//Z",
);
const validSvg = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1 1\"><path d=\"M0 0h1v1H0z\"/></svg>";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function packageFor(assetIds: readonly string[]) {
  const content = {
    version: 1 as const,
    components: [],
    mounts: [],
    assets: assetIds.map((id) => ({
      id,
      digestSha256: "f3d75f6c038e2bf3902613e46943545a1a8adf4c56e6db49cf3045eef716bece",
      mediaType: "image/svg+xml",
      representation: "image" as const,
    })),
  };
  return {
    ...content,
    integritySha256: createHash("sha256").update(canonicalJson(content)).digest("hex"),
  };
}

describe("visual_assets deterministic library interface", () => {
  it("validates one imported content record through the library media seam", async () => {
    const library = createMemoryVisualAssetsLibrary({ authority: { projects: [], standaloneThreadIds: [1] } });
    createMemoryVisualDetailPersistence(library);
    const scope = { kind: "thread" as const, threadId: 1 };
    for (const svg of [
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'><rect width='1' height='1'/></svg>",
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><defs><linearGradient id="g"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient></defs><rect width="1" height="1" fill="url(#g)"/></svg>',
    ]) {
      const bytes = Buffer.from(svg);
      await expect(validateVisualAssetImportContent({
        library,
        scope,
        content: {
          digestSha256: createHash("sha256").update(bytes).digest("hex"),
          mediaType: "image/svg+xml",
          byteLength: bytes.length,
          contentBase64: bytes.toString("base64"),
        },
      })).resolves.toBeUndefined();
    }
    const invalidPng = Buffer.from("not a PNG");
    await expect(validateVisualAssetImportContent({
      library,
      scope,
      content: {
        digestSha256: createHash("sha256").update(invalidPng).digest("hex"),
        mediaType: "image/png",
        byteLength: invalidPng.length,
        contentBase64: invalidPng.toString("base64"),
      },
    })).rejects.toMatchObject({ code: "media_content_malformed" });
  });

  it("reopens durable scope authority, tags, relationships, bytes, and archival state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-visual-assets-catalog-"));
    try {
      const storagePath = join(directory, "visual-assets.json");
      const first = await createFileVisualAssetsLibrary({}, storagePath);
      await first.authorizeScope({ kind: "project", projectId: 7, threadId: 70 });
      await first.authorizeScope({ kind: "thread", threadId: 90 });
      const projectTag = await first.createTag({ scope: { kind: "thread", threadId: 70 }, name: "Project" });
      const standaloneTag = await first.createTag({ scope: { kind: "thread", threadId: 90 }, name: "Standalone" });
      const added = await first.add({
        file: memoryHarnessFile("durable.svg", "image/svg+xml", validSvg),
        scope: { kind: "project", projectId: 7 }, name: "Durable", tagIds: [projectTag.id],
      });
      await first.associate({ assetId: added.id, scope: { kind: "thread", threadId: 90 } });
      const organized = await first.organize({ assetId: added.id, addTagIds: [standaloneTag.id], removeTagIds: [] });
      const archived = await first.archive(organized.id);

      const reopened = await createFileVisualAssetsLibrary({}, storagePath);
      expect((await reopened.inspect(archived.id)).asset).toEqual(archived);
      expect((await reopened.listTags({ scope: { kind: "thread", threadId: 70 } })).items).toEqual([projectTag]);
      expect((await reopened.listTags({ scope: { kind: "thread", threadId: 90 } })).items).toEqual([standaloneTag]);
      expect((await reopened.listAssets({ scope: { kind: "project", projectId: 7 } })).items).toEqual([]);
      expect(await (await reopened.download(archived.id)).read()).toEqual(new TextEncoder().encode(validSvg));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("stores shared bytes once by digest and leaves them untouched during metadata mutations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-visual-assets-content-store-"));
    try {
      const storagePath = join(directory, "visual-assets.json");
      const library = await createFileVisualAssetsLibrary({}, storagePath);
      const tag = await library.createTag({ scope: { kind: "library" }, name: "Shared" });
      const first = await library.add({
        file: memoryHarnessFile("first.svg", "image/svg+xml", validSvg),
        scope: { kind: "library" }, name: "First", tagIds: [],
      });
      await library.add({
        file: memoryHarnessFile("second.svg", "image/svg+xml", validSvg),
        scope: { kind: "library" }, name: "Second", tagIds: [],
      });
      const stored = JSON.parse(await readFile(storagePath, "utf8")) as { version: number; assets: unknown[] };
      expect(stored.version).toBe(3);
      expect(stored.assets).toHaveLength(2);
      expect(JSON.stringify(stored)).not.toContain("contentBase64");
      const contentFiles = await readdir(`${storagePath}.content`);
      expect(contentFiles).toHaveLength(1);
      const contentPath = join(`${storagePath}.content`, contentFiles[0]!);
      const before = await stat(contentPath, { bigint: true });

      await library.organize({ assetId: first.id, addTagIds: [tag.id], removeTagIds: [] });
      const after = await stat(contentPath, { bigint: true });
      expect(after.ino).toBe(before.ino);
      expect(after.mtimeNs).toBe(before.mtimeNs);
      const reopened = await createFileVisualAssetsLibrary({}, storagePath);
      expect(await (await reopened.download(first.id)).read()).toEqual(new TextEncoder().encode(validSvg));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("persists bootstrap asset content before the first metadata-only publication", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-visual-assets-bootstrap-content-"));
    try {
      const storagePath = join(directory, "visual-assets.json");
      const library = await createFileVisualAssetsLibrary({
        registries: [{
          id: "system", name: "System", source: "relayer", contentAuthority: "read-only",
          defaultRelationshipAuthority: "read-only",
        }],
        initialAssets: [{
          id: "asset_bootstrap", registryId: "system", name: "Bootstrap", fileName: "bootstrap.svg",
          mediaType: "image/svg+xml", content: validSvg, scopes: [{ kind: "library" }], tagIds: [],
        }],
      }, storagePath);
      await library.createTag({ scope: { kind: "library" }, name: "Metadata only" });
      const reopened = await createFileVisualAssetsLibrary({}, storagePath);
      expect(await (await reopened.download("asset_bootstrap")).read()).toEqual(new TextEncoder().encode(validSvg));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("migrates the embedded v1 catalog into digest-addressed content without changing logical assets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-visual-assets-v1-migration-"));
    try {
      const storagePath = join(directory, "visual-assets.json");
      const bytes = new TextEncoder().encode(validSvg);
      const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      const asset = {
        id: "asset_legacy", registryId: "user", name: "Legacy", mediaType: "image/svg+xml",
        byteLength: bytes.byteLength, digest, scopes: [{ kind: "library" }], tagIds: [], archived: false,
        provenance: { source: "user", fileName: "legacy.svg" },
      };
      await writeFile(storagePath, `${JSON.stringify({
        version: 1, revision: 7, authority: { projects: [], standaloneThreadIds: [] },
        registries: [], tags: [], assets: [{ asset, contentBase64: Buffer.from(bytes).toString("base64") }],
      })}\n`);

      const library = await createFileVisualAssetsLibrary({}, storagePath);
      expect((await library.inspect(asset.id)).asset).toEqual(asset);
      expect(await (await library.download(asset.id)).read()).toEqual(bytes);
      const migrated = JSON.parse(await readFile(storagePath, "utf8")) as { version: number; revision: number };
      expect(migrated).toMatchObject({ version: 3, revision: 7 });
      expect(await readdir(`${storagePath}.content`)).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when digest-addressed catalog content is missing or corrupt on reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-visual-assets-corrupt-content-"));
    try {
      const storagePath = join(directory, "visual-assets.json");
      const library = await createFileVisualAssetsLibrary({}, storagePath);
      await library.add({
        file: memoryHarnessFile("corrupt.svg", "image/svg+xml", validSvg),
        scope: { kind: "library" }, name: "Corrupt", tagIds: [],
      });
      const [contentFile] = await readdir(`${storagePath}.content`);
      await writeFile(join(`${storagePath}.content`, contentFile!), "corrupt");
      await expect(createFileVisualAssetsLibrary({}, storagePath))
        .rejects.toMatchObject({ code: "catalog_store_corrupt" });
      await rm(join(`${storagePath}.content`, contentFile!));
      await expect(createFileVisualAssetsLibrary({}, storagePath))
        .rejects.toMatchObject({ code: "catalog_store_corrupt" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("snapshots nested create-tag and association scopes before queued mutation work", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-visual-assets-scope-snapshot-"));
    try {
      const library = await createFileVisualAssetsLibrary({}, join(directory, "visual-assets.json"));
      await library.authorizeScope({ kind: "project", projectId: 7, threadId: 70 });
      await library.authorizeScope({ kind: "project", projectId: 8, threadId: 80 });
      const asset = await library.add({
        file: memoryHarnessFile("asset.svg", "image/svg+xml", validSvg),
        scope: { kind: "project", projectId: 7 }, name: "Asset", tagIds: [],
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const blocker = library.add({
        file: { name: "blocker.svg", mediaType: "image/svg+xml", async read() { await gate; return new TextEncoder().encode(validSvg); } },
        scope: { kind: "library" }, name: "Blocker", tagIds: [],
      });
      const tagScope: { kind: "project"; projectId: number } = { kind: "project", projectId: 7 };
      const associationScope: { kind: "project"; projectId: number } = { kind: "project", projectId: 7 };
      const tag = library.createTag({ scope: tagScope, name: "Queued" });
      const association = library.associate({ assetId: asset.id, scope: associationScope });
      tagScope.projectId = 8;
      associationScope.projectId = 8;
      release();
      await blocker;
      expect((await tag).scope).toEqual({ kind: "project", projectId: 7 });
      expect((await association).scopes).toContainEqual({ kind: "project", projectId: 7 });
      expect((await association).scopes).not.toContainEqual({ kind: "project", projectId: 8 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps recorded user-added relationships mutable across publication and reopen but preserves ambiguous v2 defaults", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-visual-assets-relationship-defaults-"));
    try {
      const storagePath = join(directory, "visual-assets.json");
      const registry = {
        id: "curated-user", name: "Curated user", source: "user" as const,
        contentAuthority: "user" as const, defaultRelationshipAuthority: "read-only" as const,
      };
      const library = await createFileVisualAssetsLibrary({ registries: [registry] }, storagePath);
      const tag = await library.createTag({ scope: { kind: "library" }, name: "Mutable" });
      const asset = await library.add({
        file: memoryHarnessFile("mutable.svg", "image/svg+xml", validSvg),
        scope: { kind: "library" }, name: "Mutable", registryId: registry.id, tagIds: [tag.id],
      });
      expect((await library.organize({ assetId: asset.id, addTagIds: [], removeTagIds: [tag.id] })).tagIds).toEqual([]);
      await library.organize({ assetId: asset.id, addTagIds: [tag.id], removeTagIds: [] });

      const reopened = await createFileVisualAssetsLibrary({}, storagePath);
      expect((await reopened.organize({ assetId: asset.id, addTagIds: [], removeTagIds: [tag.id] })).tagIds).toEqual([]);
      await reopened.organize({ assetId: asset.id, addTagIds: [tag.id], removeTagIds: [] });

      const v3 = JSON.parse(await readFile(storagePath, "utf8")) as {
        version: number;
        assets: { asset: unknown; defaultTagIds: string[] }[];
      };
      await writeFile(storagePath, `${JSON.stringify({
        ...v3,
        version: 2,
        assets: v3.assets.map(({ asset: logicalAsset }) => logicalAsset),
      })}\n`);
      const migrated = await createFileVisualAssetsLibrary({}, storagePath);
      await expect(migrated.organize({
        assetId: asset.id, addTagIds: [], removeTagIds: [tag.id],
      })).rejects.toMatchObject({ code: "tag_relationship_read_only" });
      expect((JSON.parse(await readFile(storagePath, "utf8")) as { version: number }).version).toBe(3);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves writable bootstrap defaults and user-provenance legacy defaults across reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-visual-assets-writable-defaults-"));
    try {
      const storagePath = join(directory, "visual-assets.json");
      const registry = {
        id: "writable-defaults", name: "Writable defaults", source: "relayer" as const,
        contentAuthority: "read-only" as const, defaultRelationshipAuthority: "user" as const,
      };
      const tag = {
        id: "tag_default", scope: { kind: "library" as const }, name: "Default", parentTagId: null,
        authority: "system" as const,
      };
      const library = await createFileVisualAssetsLibrary({
        registries: [registry],
        initialTags: [tag],
        initialAssets: [{
          id: "asset_default", registryId: registry.id, name: "Default", fileName: "default.svg",
          mediaType: "image/svg+xml", content: validSvg, scopes: [{ kind: "library" }], tagIds: [tag.id],
          provenance: { source: "user", fileName: "default.svg" },
        }],
      }, storagePath);
      expect((await library.organize({ assetId: "asset_default", addTagIds: [], removeTagIds: [tag.id] })).tagIds).toEqual([]);
      await library.organize({ assetId: "asset_default", addTagIds: [tag.id], removeTagIds: [] });
      const reopened = await createFileVisualAssetsLibrary({}, storagePath);
      expect((await reopened.organize({ assetId: "asset_default", addTagIds: [], removeTagIds: [tag.id] })).tagIds).toEqual([]);
      await reopened.organize({ assetId: "asset_default", addTagIds: [tag.id], removeTagIds: [] });

      const stored = JSON.parse(await readFile(storagePath, "utf8")) as {
        version: number;
        assets: { asset: Record<string, unknown>; defaultTagIds: string[] }[];
      };
      const legacyAsset = { ...stored.assets[0]!.asset };
      legacyAsset.provenance = { fileName: "default.svg" };
      await writeFile(storagePath, `${JSON.stringify({
        ...stored,
        version: 2,
        registries: [{ ...registry, defaultRelationshipAuthority: "read-only" }],
        assets: [legacyAsset],
      })}\n`);
      const migrated = await createFileVisualAssetsLibrary({}, storagePath);
      await expect(migrated.organize({
        assetId: "asset_default", addTagIds: [], removeTagIds: [tag.id],
      })).rejects.toMatchObject({ code: "tag_relationship_read_only" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("snapshots bootstrap default relationships before asynchronous file-library creation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-visual-assets-bootstrap-default-snapshot-"));
    try {
      const defaults = ["tag_default"];
      const creating = createFileVisualAssetsLibrary({
        registries: [{
          id: "readonly-defaults", name: "Read-only defaults", source: "relayer",
          contentAuthority: "read-only", defaultRelationshipAuthority: "read-only",
        }],
        initialTags: [{
          id: "tag_default", scope: { kind: "library" }, name: "Default", parentTagId: null, authority: "system",
        }],
        initialAssets: [{
          id: "asset_default", registryId: "readonly-defaults", name: "Default", fileName: "default.svg",
          mediaType: "image/svg+xml", content: validSvg, scopes: [{ kind: "library" }],
          tagIds: ["tag_default"], defaultTagIds: defaults,
        }],
      }, join(directory, "visual-assets.json"));
      defaults.splice(0);
      const library = await creating;
      await expect(library.organize({
        assetId: "asset_default", addTagIds: [], removeTagIds: ["tag_default"],
      })).rejects.toMatchObject({ code: "tag_relationship_read_only" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reconciles memory with a catalog rename when parent-directory syncing fails afterward", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-visual-assets-post-rename-sync-"));
    try {
      const storagePath = join(directory, "visual-assets.json");
      const library = await createFileVisualAssetsLibrary({}, storagePath);
      await chmod(directory, 0o300);
      const adding = library.add({
        file: memoryHarnessFile("committed.svg", "image/svg+xml", validSvg),
        scope: { kind: "library" }, name: "Committed", tagIds: [],
      });
      await expect(adding).rejects.toBeDefined();
      expect((await library.listAssets({ scope: { kind: "library" } })).items.map(({ name }) => name)).toEqual(["Committed"]);
      await chmod(directory, 0o700);
      const reopened = await createFileVisualAssetsLibrary({}, storagePath);
      expect((await reopened.listAssets({ scope: { kind: "library" } })).items.map(({ name }) => name)).toEqual(["Committed"]);
    } finally {
      await chmod(directory, 0o700).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not publish a candidate asset when its durable catalog write fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-visual-assets-write-failure-"));
    try {
      const storagePath = join(directory, "visual-assets.json");
      const library = await createFileVisualAssetsLibrary({}, storagePath);
      await mkdir(storagePath);
      await expect(library.add({
        file: memoryHarnessFile("unpublished.svg", "image/svg+xml", validSvg),
        scope: { kind: "library" }, name: "Unpublished", tagIds: [],
      })).rejects.toBeDefined();
      expect((await library.listAssets({ scope: { kind: "library" } })).items).toEqual([]);
      expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rechecks completion authority immediately before the atomic catalog rename", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-visual-assets-revoked-write-"));
    try {
      const storagePath = join(directory, "visual-assets.json");
      const library = await createFileVisualAssetsLibrary({}, storagePath);
      let checks = 0;
      await expect(library.add({
        file: memoryHarnessFile("revoked.svg", "image/svg+xml", validSvg),
        scope: { kind: "library" }, name: "Revoked", tagIds: [],
      }, () => ++checks < 2)).rejects.toMatchObject({ code: "completion_inactive" });
      expect(checks).toBe(2);
      expect((await library.listAssets({ scope: { kind: "library" } })).items).toEqual([]);
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("invalidates a durable cursor after a same-count catalog mutation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-visual-assets-stale-cursor-"));
    try {
      const library = await createFileVisualAssetsLibrary({}, join(directory, "visual-assets.json"));
      const tag = await library.createTag({ scope: { kind: "library" }, name: "Later" });
      const first = await library.add({
        file: memoryHarnessFile("first.svg", "image/svg+xml", validSvg),
        scope: { kind: "library" }, name: "First", tagIds: [],
      });
      await library.add({
        file: memoryHarnessFile("second.svg", "image/svg+xml", validSvg),
        scope: { kind: "library" }, name: "Second", tagIds: [],
      });
      const page = await library.listAssets({ scope: { kind: "library" }, limit: 1 });
      await library.organize({ assetId: first.id, addTagIds: [tag.id], removeTagIds: [] });
      await expect(library.listAssets({
        scope: { kind: "library" }, limit: 1, cursor: page.nextCursor!,
      })).rejects.toMatchObject({ code: "page_snapshot_stale" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("snapshots mutable queued add inputs synchronously", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-visual-assets-add-snapshot-"));
    try {
      const library = await createFileVisualAssetsLibrary({}, join(directory, "visual-assets.json"));
      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
      const first = library.add({
        file: { name: "first.svg", mediaType: "image/svg+xml", async read() { await firstGate; return new TextEncoder().encode(validSvg); } },
        scope: { kind: "library" }, name: "First", tagIds: [],
      });
      let input!: {
        file: { name: string; mediaType: string; expectedDigest: string; read(): Promise<Uint8Array> };
        scope: { kind: "library" | "project"; projectId?: number };
        name: string;
        tagIds: string[];
        registryId?: string;
      };
      const file = {
        name: "queued.svg",
        mediaType: "image/svg+xml",
        expectedDigest: `sha256:${createHash("sha256").update(validSvg).digest("hex")}`,
        async read() {
          input.name = "Reentered";
          input.tagIds.push("reentered-tag");
          input.registryId = "reentered-registry";
          return new TextEncoder().encode(fileContent);
        },
      };
      let fileContent = validSvg;
      const scope: { kind: "library" | "project"; projectId?: number } = { kind: "library" };
      input = { file, scope, name: "Queued", tagIds: [] as string[] };
      const queued = library.add(input as Parameters<typeof library.add>[0]);
      fileContent = "<svg><script/></svg>";
      file.name = "mutated.txt";
      file.mediaType = "text/plain";
      file.expectedDigest = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
      file.read = async () => { throw new Error("mutated"); };
      scope.kind = "project";
      scope.projectId = 999;
      input.name = "";
      input.tagIds.push("mutated-tag");
      releaseFirst();

      await first;
      const added = await queued;
      expect(added).toMatchObject({
        name: "Queued", mediaType: "image/svg+xml", scopes: [{ kind: "library" }],
        provenance: { fileName: "queued.svg" },
      });
      expect(new TextDecoder().decode(await (await library.download(added.id)).read())).toBe(validSvg);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps durable cursors valid across observable no-op mutations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-visual-assets-durable-no-op-"));
    try {
      const library = await createFileVisualAssetsLibrary({}, join(directory, "visual-assets.json"));
      const root = await library.createTag({ scope: { kind: "library" }, name: "Root" });
      const other = await library.createTag({ scope: { kind: "library" }, name: "Other" });
      const first = await library.add({
        file: memoryHarnessFile("first.svg", "image/svg+xml", validSvg),
        scope: { kind: "library" }, name: "First", tagIds: [root.id],
      });
      await library.add({
        file: memoryHarnessFile("second.svg", "image/svg+xml", validSvg),
        scope: { kind: "library" }, name: "Second", tagIds: [],
      });
      const archived = await library.add({
        file: memoryHarnessFile("archived.svg", "image/svg+xml", validSvg),
        scope: { kind: "library" }, name: "Archived", tagIds: [],
      });
      await library.archive(archived.id);

      async function assetCursorSurvives(operation: () => Promise<unknown>): Promise<void> {
        const page = await library.listAssets({ scope: { kind: "library" }, limit: 1 });
        await operation();
        await expect(library.listAssets({
          scope: { kind: "library" }, limit: 1, cursor: page.nextCursor!,
        })).resolves.toBeDefined();
      }
      await assetCursorSurvives(() => library.associate({ assetId: first.id, scope: { kind: "library" } }));
      await assetCursorSurvives(() => library.organize({
        assetId: first.id, addTagIds: [root.id], removeTagIds: [other.id],
      }));
      await assetCursorSurvives(() => library.archive(archived.id));

      const tagPage = await library.listTags({ scope: { kind: "library" }, limit: 1 });
      await library.moveTag({ tagId: root.id, parentTagId: null });
      await expect(library.listTags({
        scope: { kind: "library" }, limit: 1, cursor: tagPage.nextCursor!,
      })).resolves.toBeDefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves a queued file expectedDigest instead of dropping the integrity check", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-visual-assets-expected-digest-"));
    try {
      const library = await createFileVisualAssetsLibrary({}, join(directory, "visual-assets.json"));
      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
      const first = library.add({
        file: { name: "first.svg", mediaType: "image/svg+xml", async read() { await firstGate; return new TextEncoder().encode(validSvg); } },
        scope: { kind: "library" }, name: "First", tagIds: [],
      });
      const file = {
        name: "wrong.svg", mediaType: "image/svg+xml",
        expectedDigest: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        async read() { return new TextEncoder().encode(validSvg); },
      };
      const queued = library.add({ file, scope: { kind: "library" }, name: "Wrong", tagIds: [] });
      file.expectedDigest = `sha256:${createHash("sha256").update(validSvg).digest("hex")}`;
      releaseFirst();

      await first;
      await expect(queued).rejects.toMatchObject({ code: "digest_mismatch" });
      expect((await library.listAssets({ scope: { kind: "library" } })).items.map(({ name }) => name)).toEqual(["First"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("handles an eager queued read rejection until its mutation turn without swallowing it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-visual-assets-queued-read-failure-"));
    const unhandled: unknown[] = [];
    const recordUnhandled = (error: unknown) => { unhandled.push(error); };
    process.on("unhandledRejection", recordUnhandled);
    try {
      const library = await createFileVisualAssetsLibrary({}, join(directory, "visual-assets.json"));
      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
      const first = library.add({
        file: { name: "first.svg", mediaType: "image/svg+xml", async read() { await firstGate; return new TextEncoder().encode(validSvg); } },
        scope: { kind: "library" }, name: "First", tagIds: [],
      });
      const readFailure = new Error("queued read failed");
      const queued = library.add({
        file: { name: "failed.svg", mediaType: "image/svg+xml", async read() { throw readFailure; } },
        scope: { kind: "library" }, name: "Failed", tagIds: [],
      });
      const observed = queued.catch((error: unknown) => error);
      const detached = new Uint8Array([1]);
      structuredClone(detached.buffer, { transfer: [detached.buffer] });
      const detachedRead = library.add({
        file: { name: "detached.svg", mediaType: "image/svg+xml", async read() { return detached; } },
        scope: { kind: "library" }, name: "Detached", tagIds: [],
      }).catch((error: unknown) => error);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
      releaseFirst();
      await first;
      await expect(observed).resolves.toBe(readFailure);
      await expect(detachedRead).resolves.toBeInstanceOf(TypeError);
      expect((await library.listAssets({ scope: { kind: "library" } })).items.map(({ name }) => name)).toEqual(["First"]);
    } finally {
      process.off("unhandledRejection", recordUnhandled);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects forged handles, cross-scope reads, and partial failed acceptance", async () => {
    const initial = (id: string, scopes: readonly ({ kind: "project"; projectId: number })[]) => ({
      id,
      registryId: "user",
      name: id,
      fileName: `${id}.svg`,
      mediaType: "image/svg+xml",
      content: validSvg,
      scopes,
      tagIds: [],
      provenance: { source: "user" as const, fileName: `${id}.svg` },
    });
    const library = createMemoryVisualAssetsLibrary({
      authority: {
        projects: [{ projectId: 1, threadIds: [] }, { projectId: 2, threadIds: [] }],
        standaloneThreadIds: [],
      },
      initialAssets: [initial("asset-a", [{ kind: "project", projectId: 1 }])],
    });
    const persistence = createMemoryVisualDetailPersistence(library);
    const accepted = await persistence.accept({ package: packageFor(["asset-a"]), scope: { kind: "project", projectId: 1 } });
    const forged = JSON.parse(JSON.stringify(accepted)) as typeof accepted;

    await expect(persistence.resolve({ detail: forged, scope: { kind: "project", projectId: 1 } }))
      .rejects.toMatchObject({ code: "accepted_detail_not_authorized" });
    await expect(persistence.resolve({ detail: accepted, scope: { kind: "project", projectId: 2 } }))
      .rejects.toMatchObject({ code: "accepted_detail_not_authorized" });
    expect(() => persistence.read({ package: accepted.package, scope: { kind: "project", projectId: 2 } }))
      .toThrowError(expect.objectContaining({ code: "accepted_detail_not_found" }));

    await expect(persistence.accept({ package: packageFor(["asset-a", "asset-missing"]), scope: { kind: "project", projectId: 1 } }))
      .rejects.toMatchObject({ code: "asset_not_found" });
    expect(() => persistence.exportArchive({ details: [forged], scope: { kind: "project", projectId: 1 } }))
      .toThrowError(expect.objectContaining({ code: "accepted_detail_not_authorized" }));
  });

  it("does not publish memory state when a durable rename fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-visual-detail-failure-"));
    try {
      const storagePath = join(directory, "accepted-details.json");
      const library = createMemoryVisualAssetsLibrary({ initialAssets: [{
        id: "asset-a", registryId: "user", name: "Asset", fileName: "asset.svg",
        mediaType: "image/svg+xml", content: validSvg, scopes: [{ kind: "library" }], tagIds: [],
        provenance: { source: "user", fileName: "asset.svg" },
      }] });
      const persistence = await createFileVisualDetailPersistence(library, storagePath);
      await mkdir(storagePath);

      await expect(persistence.accept({ package: packageFor(["asset-a"]), scope: { kind: "library" } }))
        .rejects.toBeDefined();
      expect(() => persistence.read({ package: packageFor(["asset-a"]), scope: { kind: "library" } }))
        .toThrowError(expect.objectContaining({ code: "accepted_detail_not_found" }));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("snapshots a portable archive before asynchronous media validation", async () => {
    const source = createMemoryVisualAssetsLibrary({ initialAssets: [{
      id: "asset-a", registryId: "user", name: "Asset", fileName: "asset.svg",
      mediaType: "image/svg+xml", content: validSvg, scopes: [{ kind: "library" }], tagIds: [],
      provenance: { source: "user", fileName: "asset.svg" },
    }] });
    const sourcePersistence = createMemoryVisualDetailPersistence(source);
    const accepted = await sourcePersistence.accept({ package: packageFor(["asset-a"]), scope: { kind: "library" } });
    const exported = await sourcePersistence.exportArchive({ details: [accepted], scope: { kind: "library" } });
    const mutable = JSON.parse(JSON.stringify(exported)) as typeof exported;
    const target = createMemoryVisualDetailPersistence(createMemoryVisualAssetsLibrary());

    const importing = target.importArchive({ archive: mutable, scope: { kind: "library" } });
    (mutable.contents[0] as { contentBase64: string }).contentBase64 = Buffer.from("mutated").toString("base64");

    await expect(importing).resolves.toHaveLength(1);
  });

  it("reopens accepted visual content from durable storage by canonical package identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-visual-detail-"));
    try {
      const storagePath = join(directory, "accepted-details.json");
      const initialAsset = {
        id: "asset-a",
        registryId: "user",
        name: "Asset",
        fileName: "asset.svg",
        mediaType: "image/svg+xml",
        content: validSvg,
        scopes: [{ kind: "library" as const }],
        tagIds: [],
        provenance: { source: "user" as const, fileName: "asset.svg" },
      };
      const package_ = {
        version: 1 as const,
        components: [],
        mounts: [],
        assets: [{
          id: "asset-a",
          digestSha256: "f3d75f6c038e2bf3902613e46943545a1a8adf4c56e6db49cf3045eef716bece",
          mediaType: "image/svg+xml",
          representation: "image" as const,
        }],
        integritySha256: "66d1174682577a01b866fa14ecf6a85d4fdfcca54ff6d3a1f98519b242cc5c6f",
      };
      const first = await createFileVisualDetailPersistence(
        createMemoryVisualAssetsLibrary({ initialAssets: [initialAsset] }),
        storagePath,
      );
      await first.accept({ package: package_, scope: { kind: "library" } });
      await first.accept({ package: package_, scope: { kind: "library" } });

      const reopened = await createFileVisualDetailPersistence(
        createMemoryVisualAssetsLibrary(),
        storagePath,
      );
      const persisted = await reopened.read({ package: package_, scope: { kind: "library" } });
      const resolved = await reopened.resolve({ detail: persisted, scope: { kind: "library" } });

      expect(resolved.package).toEqual(package_);
      expect(await resolved.assets[0]!.file.read()).toEqual(new TextEncoder().encode(validSvg));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("pins accepted history and exports one shared digest for deterministic import reconnection", async () => {
    const initial = (id: string) => ({
      id,
      registryId: "user",
      name: id,
      fileName: `${id}.svg`,
      mediaType: "image/svg+xml",
      content: validSvg,
      scopes: [{ kind: "library" as const }],
      tagIds: [],
      provenance: { source: "user" as const, fileName: `${id}.svg` },
    });
    const library = createMemoryVisualAssetsLibrary({ initialAssets: [initial("asset-a"), initial("asset-b")] });
    const persistence = createMemoryVisualDetailPersistence(library);
    const package_ = {
      version: 1 as const,
      components: [{
        id: "visuals",
        order: 0,
        html: "<img data-gc-asset=\"mount-a\"><img data-gc-asset=\"mount-b\">",
        css: "",
      }],
      mounts: [
        { id: "mount-a", componentId: "visuals", kind: "asset" as const, host: "img", assetId: "asset-a" },
        { id: "mount-b", componentId: "visuals", kind: "asset" as const, host: "img", assetId: "asset-b" },
      ],
      assets: [
        { id: "asset-a", digestSha256: "f3d75f6c038e2bf3902613e46943545a1a8adf4c56e6db49cf3045eef716bece", mediaType: "image/svg+xml", representation: "image" as const },
        { id: "asset-b", digestSha256: "f3d75f6c038e2bf3902613e46943545a1a8adf4c56e6db49cf3045eef716bece", mediaType: "image/svg+xml", representation: "image" as const },
      ],
      integritySha256: "dd65c5952f5a51797ce3e17e9789e8b8613fa521ed22c8c2bdd7711e99d07f0c",
    };

    const accepted = await persistence.accept({ package: package_, scope: { kind: "library" } });
    await library.archive("asset-a");
    const reorganized = await library.createTag({ scope: { kind: "library" }, name: "Later catalog" });
    await library.organize({ assetId: "asset-b", addTagIds: [reorganized.id], removeTagIds: [] });
    const archive = await persistence.exportArchive({ details: [accepted], scope: { kind: "library" } });

    expect(archive.contents).toHaveLength(1);
    expect(archive.details[0]!.assets.map((asset) => asset.assetId)).toEqual(["asset-a", "asset-b"]);
    expect((await persistence.resolve({ detail: accepted, scope: { kind: "library" } })).assets.map((asset) => asset.provenance.fileName))
      .toEqual(["asset-a.svg", "asset-b.svg"]);

    const importedPersistence = createMemoryVisualDetailPersistence(createMemoryVisualAssetsLibrary());
    const [imported] = await importedPersistence.importArchive({ archive, scope: { kind: "library" } });
    const resolved = await importedPersistence.resolve({ detail: imported!, scope: { kind: "library" } });
    expect(resolved.package).toEqual(package_);
    expect(await resolved.assets[0]!.file.read()).toEqual(new TextEncoder().encode(validSvg));
    expect(await resolved.assets[1]!.file.read()).toEqual(new TextEncoder().encode(validSvg));
  });

  it("rejects missing, corrupt, unsupported, and unauthorized accepted visual imports", async () => {
    const source = createMemoryVisualAssetsLibrary({ initialAssets: [{
      id: "asset-a",
      registryId: "user",
      name: "Asset",
      fileName: "asset.svg",
      mediaType: "image/svg+xml",
      content: validSvg,
      scopes: [{ kind: "library" }],
      tagIds: [],
      provenance: { source: "user", fileName: "asset.svg" },
    }] });
    const persistence = createMemoryVisualDetailPersistence(source);
    const package_ = {
      version: 1 as const,
      components: [],
      mounts: [],
      assets: [{
        id: "asset-a",
        digestSha256: "f3d75f6c038e2bf3902613e46943545a1a8adf4c56e6db49cf3045eef716bece",
        mediaType: "image/svg+xml",
        representation: "image" as const,
      }],
      integritySha256: "66d1174682577a01b866fa14ecf6a85d4fdfcca54ff6d3a1f98519b242cc5c6f",
    };
    const accepted = await persistence.accept({ package: package_, scope: { kind: "library" } });
    const archive = await persistence.exportArchive({ details: [accepted], scope: { kind: "library" } });
    const target = createMemoryVisualDetailPersistence(createMemoryVisualAssetsLibrary());
    const missing = { ...archive, contents: [] };
    await expect(target.importArchive({ archive: missing, scope: { kind: "library" } }))
      .rejects.toMatchObject({ code: "accepted_content_missing" });

    const corrupt = {
      ...archive,
      contents: archive.contents.map((content, index) => index === 0
        ? { ...content, contentBase64: Buffer.from("corrupt").toString("base64") }
        : content),
    };
    await expect(target.importArchive({ archive: corrupt, scope: { kind: "library" } }))
      .rejects.toMatchObject({ code: "archive_content_corrupt" });

    const unsupported = {
      ...archive,
      contents: archive.contents.map((content, index) => index === 0
        ? { ...content, mediaType: "image/gif" as "image/svg+xml" }
        : content),
    };
    await expect(target.importArchive({ archive: unsupported, scope: { kind: "library" } }))
      .rejects.toMatchObject({ code: "media_type_unsupported" });

    await target.importArchive({ archive, scope: { kind: "library" } });
    const conflicting = JSON.parse(JSON.stringify(archive)) as typeof archive;
    (conflicting.details[0]!.assets[0]!.provenance as { fileName: string }).fileName = "rewritten.svg";
    await expect(target.importArchive({ archive: conflicting, scope: { kind: "library" } }))
      .rejects.toMatchObject({ code: "accepted_detail_conflict" });

    const oversizedContent = {
      version: 1 as const,
      components: [{ id: "oversized", order: 0, html: "x".repeat(512 * 1024), css: "" }],
      mounts: [],
      assets: [],
    };
    const oversizedPackage = {
      ...oversizedContent,
      integritySha256: createHash("sha256").update(canonicalJson(oversizedContent)).digest("hex"),
    };
    await expect(target.importArchive({
      archive: { version: 1, details: [{ package: oversizedPackage, assets: [] }], contents: [] },
      scope: { kind: "library" },
    })).rejects.toMatchObject({ code: "detail_package_too_large" });

    expect(() => target.importArchive({ archive, scope: { kind: "project", projectId: 999 } }))
      .toThrowError(expect.objectContaining({ code: "scope_not_authorized" }));
  });

  it("adds identical files as distinct immutable logical assets with one digest", async () => {
    const visualAssets = createMemoryVisualAssetsLibrary();
    const file = memoryHarnessFile("mark.svg", "image/svg+xml", validSvg);

    const first = await visualAssets.add({
      file,
      scope: { kind: "library" },
      name: "Primary mark",
      tagIds: [],
    });
    const second = await visualAssets.add({
      file,
      scope: { kind: "library" },
      name: "Alternate placement",
      tagIds: [],
    });

    expect(first.id).not.toBe(second.id);
    expect(first.digest).toBe(second.digest);
    expect(await visualAssets.inspect(first.id)).toMatchObject({
      asset: first,
      preview: { mediaType: "image/svg+xml", byteLength: Buffer.byteLength(validSvg) },
    });
  });

  it("searches explicit scopes and includes authorized thread assets in their project", async () => {
    const visualAssets = createMemoryVisualAssetsLibrary({
      authority: { projects: [{ projectId: 7, threadIds: [70, 71] }], standaloneThreadIds: [90] },
    });
    const file = memoryHarnessFile("diagram.svg", "image/svg+xml", validSvg);
    const projectAsset = await visualAssets.add({
      file,
      scope: { kind: "project", projectId: 7 },
      name: "Project diagram",
      tagIds: [],
    });
    const threadAsset = await visualAssets.add({
      file,
      scope: { kind: "thread", threadId: 70 },
      name: "Thread sketch",
      tagIds: [],
    });
    await visualAssets.add({
      file,
      scope: { kind: "thread", threadId: 90 },
      name: "Standalone sketch",
      tagIds: [],
    });

    expect((await visualAssets.listAssets({ scope: { kind: "project", projectId: 7 } })).items)
      .toEqual([projectAsset, threadAsset]);
    expect((await visualAssets.listAssets({ scope: { kind: "thread", threadId: 70 } })).items)
      .toEqual([projectAsset, threadAsset]);
  });

  it("shares a one-parent project tag tree and finds only direct assets plus immediate subtags", async () => {
    const visualAssets = createMemoryVisualAssetsLibrary({
      authority: { projects: [{ projectId: 7, threadIds: [70] }], standaloneThreadIds: [] },
    });
    const root = await visualAssets.createTag({
      scope: { kind: "thread", threadId: 70 },
      name: "Brand",
    });
    const child = await visualAssets.createTag({
      scope: { kind: "project", projectId: 7 },
      name: "Marks",
      parentTagId: root.id,
    });
    await visualAssets.createTag({
      scope: { kind: "project", projectId: 7 },
      name: "Dark",
      parentTagId: child.id,
    });
    const direct = await visualAssets.add({
      file: memoryHarnessFile("wordmark.svg", "image/svg+xml", validSvg),
      scope: { kind: "project", projectId: 7 },
      name: "Wordmark",
      tagIds: [root.id, child.id],
    });

    expect(root.scope).toEqual({ kind: "project", projectId: 7 });
    expect(await visualAssets.find({ scope: { kind: "thread", threadId: 70 }, tagId: root.id }))
      .toMatchObject({ items: [
        { kind: "tag", tag: child },
        { kind: "asset", asset: direct },
      ], nextCursor: null });
  });

  it("organizes one asset under many tags and associates it with another allowed scope", async () => {
    const visualAssets = createMemoryVisualAssetsLibrary({
      authority: { projects: [{ projectId: 7, threadIds: [70] }], standaloneThreadIds: [90] },
    });
    const projectTag = await visualAssets.createTag({ scope: { kind: "project", projectId: 7 }, name: "Project" });
    const threadTag = await visualAssets.createTag({ scope: { kind: "thread", threadId: 90 }, name: "Standalone" });
    const asset = await visualAssets.add({
      file: memoryHarnessFile("chart.svg", "image/svg+xml", validSvg),
      scope: { kind: "project", projectId: 7 },
      name: "Chart",
      tagIds: [projectTag.id],
    });

    const associated = await visualAssets.associate({ assetId: asset.id, scope: { kind: "thread", threadId: 90 } });
    const organized = await visualAssets.organize({ assetId: asset.id, addTagIds: [threadTag.id], removeTagIds: [] });

    expect(associated.scopes).toEqual([
      { kind: "project", projectId: 7 },
      { kind: "thread", threadId: 90 },
    ]);
    expect(organized.tagIds).toEqual([projectTag.id, threadTag.id]);
    expect((await visualAssets.find({ scope: { kind: "thread", threadId: 90 }, tagId: threadTag.id })).items)
      .toEqual([{ kind: "asset", asset: organized }]);
  });

  it("archives assets from normal discovery without invalidating their accepted content", async () => {
    const visualAssets = createMemoryVisualAssetsLibrary();
    const asset = await visualAssets.add({
      file: memoryHarnessFile("photo.svg", "image/svg+xml", validSvg),
      scope: { kind: "library" },
      name: "Photo",
      tagIds: [],
    });

    expect((await visualAssets.archive(asset.id)).archived).toBe(true);
    expect((await visualAssets.listAssets({ scope: { kind: "library" } })).items).toEqual([]);
    const downloaded = await visualAssets.download(asset.id);
    expect(downloaded).toMatchObject({ name: "photo.svg", mediaType: "image/svg+xml" });
    expect(new TextDecoder().decode(await downloaded.read())).toBe(validSvg);
  });

  it("discovers registry authority while allowing user organization of read-only system assets", async () => {
    const visualAssets = createMemoryVisualAssetsLibrary({
      authority: { projects: [{ projectId: 7, threadIds: [] }], standaloneThreadIds: [] },
      registries: [{
        id: "system-icons",
        name: "System icons",
        source: "relayer",
        contentAuthority: "read-only",
        defaultRelationshipAuthority: "read-only",
      }],
      initialTags: [{
        id: "tag_system_navigation",
        name: "Navigation",
        scope: { kind: "library" },
        parentTagId: null,
        authority: "system",
      }],
      initialAssets: [{
        id: "asset_system_link",
        registryId: "system-icons",
        name: "External link",
        fileName: "external-link.svg",
        mediaType: "image/svg+xml",
        content: validSvg,
        scopes: [{ kind: "library" }],
        tagIds: ["tag_system_navigation"],
      }],
    });
    const projectTag = await visualAssets.createTag({ scope: { kind: "project", projectId: 7 }, name: "Favorites" });

    expect((await visualAssets.listRegistries({ scope: { kind: "library" } })).items)
      .toMatchObject([
        { id: "system-icons", contentAuthority: "read-only" },
        { id: "user", contentAuthority: "user" },
      ]);
    await visualAssets.associate({ assetId: "asset_system_link", scope: { kind: "project", projectId: 7 } });
    const organized = await visualAssets.organize({
      assetId: "asset_system_link",
      addTagIds: [projectTag.id],
      removeTagIds: [],
    });
    expect(organized.tagIds).toEqual(["tag_system_navigation", projectTag.id]);
    await expect(visualAssets.organize({
      assetId: organized.id,
      addTagIds: [],
      removeTagIds: ["tag_system_navigation"],
    })).rejects.toMatchObject({ code: "tag_relationship_read_only" });
    await expect(visualAssets.archive(organized.id)).rejects.toMatchObject({ code: "asset_content_read_only" });
  });

  it("discovers tags and paginates a stable one-layer find result", async () => {
    const visualAssets = createMemoryVisualAssetsLibrary();
    const root = await visualAssets.createTag({ scope: { kind: "library" }, name: "Root" });
    const child = await visualAssets.createTag({ scope: { kind: "library" }, name: "Child", parentTagId: root.id });
    const asset = await visualAssets.add({
      file: memoryHarnessFile("asset.svg", "image/svg+xml", validSvg),
      scope: { kind: "library" },
      name: "Asset",
      tagIds: [root.id],
    });

    expect((await visualAssets.listTags({ scope: { kind: "library" } })).items).toEqual([root]);
    const first = await visualAssets.find({ scope: { kind: "library" }, tagId: root.id, limit: 1 });
    expect(first.items).toEqual([{ kind: "tag", tag: child }]);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(await visualAssets.find({
      scope: { kind: "library" },
      tagId: root.id,
      limit: 1,
      cursor: first.nextCursor!,
    })).toEqual({ items: [{ kind: "asset", asset }], nextCursor: null });
  });

  it("orders canonical and paginated results by locale-independent UTF-16 code units", async () => {
    const visualAssets = createMemoryVisualAssetsLibrary();
    for (const name of ["ä", "a", "Á", "Z", "A"]) {
      await visualAssets.createTag({ scope: { kind: "library" }, name });
      await visualAssets.add({
        file: memoryHarnessFile(`${name}.svg`, "image/svg+xml", validSvg),
        scope: { kind: "library" }, name, tagIds: [],
      });
    }
    const expected = ["A", "Z", "a", "Á", "ä"];
    expect((await visualAssets.listTags({ scope: { kind: "library" } })).items.map((tag) => tag.name))
      .toEqual(expected);
    expect((await visualAssets.listAssets({ scope: { kind: "library" } })).items.map((asset) => asset.name))
      .toEqual(expected);

    const names: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await visualAssets.listAssets({
        scope: { kind: "library" }, limit: 2, ...(cursor === undefined ? {} : { cursor }),
      });
      names.push(...result.items.map((asset) => asset.name));
      cursor = result.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(names).toEqual(expected);
  });

  it("binds find cursors to the caller's explicit query scope", async () => {
    const visualAssets = createMemoryVisualAssetsLibrary({
      authority: { projects: [{ projectId: 7, threadIds: [70] }], standaloneThreadIds: [] },
    });
    const root = await visualAssets.createTag({ scope: { kind: "project", projectId: 7 }, name: "Root" });
    await visualAssets.createTag({
      scope: { kind: "project", projectId: 7 }, name: "Child", parentTagId: root.id,
    });
    await visualAssets.add({
      file: memoryHarnessFile("asset.svg", "image/svg+xml", validSvg),
      scope: { kind: "project", projectId: 7 }, name: "Asset", tagIds: [root.id],
    });

    const projectPage = await visualAssets.find({
      scope: { kind: "project", projectId: 7 }, tagId: root.id, limit: 1,
    });
    await expect(visualAssets.find({
      scope: { kind: "thread", threadId: 70 },
      tagId: root.id,
      limit: 1,
      cursor: projectPage.nextCursor!,
    })).rejects.toMatchObject({ code: "page_cursor_invalid" });
  });

  it("fails unsupported, unavailable, and digest-mismatched file additions atomically", async () => {
    const visualAssets = createMemoryVisualAssetsLibrary();
    await expect(visualAssets.add({
      file: memoryHarnessFile("notes.txt", "text/plain", "notes"),
      scope: { kind: "library" },
      name: "Notes",
      tagIds: [],
    })).rejects.toMatchObject({ code: "media_type_unsupported" });
    await expect(visualAssets.add({
      file: {
        name: "missing.png",
        mediaType: "image/png",
        async read() { throw new Error("gone"); },
      },
      scope: { kind: "library" },
      name: "Missing",
      tagIds: [],
    })).rejects.toMatchObject({ code: "file_unavailable" });
    await expect(visualAssets.add({
      file: {
        ...memoryHarnessFile("wrong.png", "image/png", new Uint8Array([1])),
        expectedDigest: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      },
      scope: { kind: "library" },
      name: "Wrong digest",
      tagIds: [],
    })).rejects.toMatchObject({ code: "digest_mismatch" });
    expect((await visualAssets.listAssets({ scope: { kind: "library" } })).items).toEqual([]);
  });

  it("owns harness bytes immediately after read despite a queued caller mutation", async () => {
    const visualAssets = createMemoryVisualAssetsLibrary();
    const callerBytes = jpegBytes.slice();
    const asset = await visualAssets.add({
      file: {
        name: "owned.jpg",
        mediaType: "image/jpeg",
        read() {
          return new Promise((resolve) => {
            resolve(callerBytes);
            queueMicrotask(() => queueMicrotask(() => callerBytes.fill(0)));
          });
        },
      },
      scope: { kind: "library" },
      name: "Owned",
      tagIds: [],
    });

    expect(callerBytes.every((byte) => byte === 0)).toBe(true);
    expect(await (await visualAssets.inspect(asset.id)).preview.read()).toEqual(jpegBytes);
    expect(await (await visualAssets.download(asset.id)).read()).toEqual(jpegBytes);
  });

  it("moves a tag under at most one parent and rejects hierarchy cycles", async () => {
    const visualAssets = createMemoryVisualAssetsLibrary();
    const root = await visualAssets.createTag({ scope: { kind: "library" }, name: "Root" });
    const child = await visualAssets.createTag({
      scope: { kind: "library" },
      name: "Child",
      parentTagId: root.id,
    });

    await expect(visualAssets.moveTag({ tagId: root.id, parentTagId: child.id }))
      .rejects.toMatchObject({ code: "tag_hierarchy_cycle" });
    expect(await visualAssets.moveTag({ tagId: child.id, parentTagId: null }))
      .toMatchObject({ id: child.id, parentTagId: null });
    expect((await visualAssets.find({ scope: { kind: "library" }, tagId: root.id })).items).toEqual([]);
  });

  it("validates and normalizes bootstrap tags before resolving order-independent parent trees", async () => {
    const visualAssets = createMemoryVisualAssetsLibrary({
      initialTags: [{
        id: "tag_child",
        name: " Child ",
        scope: { kind: "library" },
        parentTagId: "tag_parent",
        authority: "system",
      }, {
        id: "tag_parent",
        name: " Parent ",
        scope: { kind: "library" },
        parentTagId: null,
        authority: "system",
      }],
    });
    const roots = await visualAssets.listTags({ scope: { kind: "library" } });
    expect(roots.items).toEqual([expect.objectContaining({ id: "tag_parent", name: "Parent" })]);
    expect((await visualAssets.listTags({
      scope: { kind: "library" }, parentTagId: "tag_parent",
    })).items).toEqual([expect.objectContaining({ id: "tag_child", name: "Child" })]);

    expect(() => createMemoryVisualAssetsLibrary({
      initialTags: [{
        id: "tag_blank", name: "   ", scope: { kind: "library" }, parentTagId: null, authority: "system",
      }],
    })).toThrow(expect.objectContaining({ code: "tag_name_invalid" }));
    expect(() => createMemoryVisualAssetsLibrary({
      initialTags: [{
        id: "tag_child", name: "Child", scope: { kind: "library" }, parentTagId: " tag_parent", authority: "system",
      }],
    })).toThrow(expect.objectContaining({ code: "tag_id_invalid" }));
    expect(() => createMemoryVisualAssetsLibrary({
      initialTags: [
        { id: "tag_a", name: "A", scope: { kind: "library" }, parentTagId: "tag_b", authority: "system" },
        { id: "tag_b", name: "B", scope: { kind: "library" }, parentTagId: "tag_a", authority: "system" },
      ],
    })).toThrow(expect.objectContaining({ code: "tag_hierarchy_cycle" }));
  });

  it("canonicalizes and freezes authority-bearing ingress before callers can mutate it", async () => {
    const initialTagScope = { kind: "project" as const, projectId: 7 };
    const initialAssetScope = { kind: "project" as const, projectId: 7 };
    const initialTagIds = ["tag_initial"];
    const initialProvenance = { source: "system" as const, fileName: "initial.svg" };
    const initialBytes = new TextEncoder().encode(validSvg);
    const projectThreadIds = [70];
    const visualAssets = createMemoryVisualAssetsLibrary({
      authority: {
        projects: [{ projectId: 7, threadIds: projectThreadIds }, { projectId: 8, threadIds: [] }],
        standaloneThreadIds: [90, 91],
      },
      initialTags: [{
        id: "tag_initial",
        name: "Initial",
        scope: initialTagScope,
        parentTagId: null,
        authority: "system",
      }],
      initialAssets: [{
        id: "asset_initial",
        registryId: "user",
        name: "Initial asset",
        fileName: "initial.svg",
        mediaType: "image/svg+xml",
        content: initialBytes,
        scopes: [initialAssetScope],
        tagIds: initialTagIds,
        provenance: initialProvenance,
      }],
    });
    initialTagScope.projectId = 8;
    initialAssetScope.projectId = 8;
    initialTagIds.length = 0;
    initialProvenance.fileName = "mutated.svg";
    initialBytes.fill(0);
    projectThreadIds[0] = 71;

    const addScope = { kind: "project" as const, projectId: 7 };
    const added = await visualAssets.add({
      file: memoryHarnessFile("added.svg", "image/svg+xml", validSvg),
      scope: addScope,
      name: "Added",
      tagIds: [],
    });
    addScope.projectId = 8;
    const associationScope = { kind: "thread" as const, threadId: 90 };
    const association = visualAssets.associate({ assetId: added.id, scope: associationScope });
    associationScope.threadId = 91;
    const associated = await association;

    expect((await visualAssets.listAssets({ scope: { kind: "project", projectId: 7 } })).items)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: "asset_initial" }), expect.objectContaining({ id: added.id })]));
    expect((await visualAssets.listAssets({ scope: { kind: "project", projectId: 8 } })).items).toEqual([]);
    expect((await visualAssets.listAssets({ scope: { kind: "thread", threadId: 90 } })).items)
      .toEqual([associated]);
    expect((await visualAssets.listAssets({ scope: { kind: "thread", threadId: 91 } })).items).toEqual([]);
    expect((await visualAssets.listAssets({ scope: { kind: "thread", threadId: 70 } })).items)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "asset_initial" }), expect.objectContaining({ id: added.id }),
      ]));
    await expect(visualAssets.listAssets({ scope: { kind: "thread", threadId: 71 } }))
      .rejects.toMatchObject({ code: "scope_not_authorized" });
    const initialInspection = await visualAssets.inspect("asset_initial");
    expect(initialInspection.asset.provenance).toEqual({ source: "system", fileName: "initial.svg" });
    expect(new TextDecoder().decode(await initialInspection.preview.read())).toBe(validSvg);
    expect((await visualAssets.listTags({ scope: { kind: "project", projectId: 7 } })).items)
      .toEqual([expect.objectContaining({ id: "tag_initial" })]);
    expect(Object.isFrozen(associated)).toBe(true);
    expect(Object.isFrozen(associated.scopes)).toBe(true);
    expect(associated.scopes.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(associated.tagIds)).toBe(true);
    expect(Object.isFrozen(associated.provenance)).toBe(true);

    let releaseRead!: () => void;
    const delayedRead = new Promise<void>((resolve) => { releaseRead = resolve; });
    const concurrentScope = { kind: "project" as const, projectId: 7 };
    const concurrentTagIds: string[] = [];
    const concurrentFile = {
      name: "concurrent.svg",
      mediaType: "image/svg+xml",
      async read() {
        await delayedRead;
        return new TextEncoder().encode(validSvg);
      },
    };
    const concurrentInput = {
      file: concurrentFile,
      scope: concurrentScope,
      name: "Concurrent",
      tagIds: concurrentTagIds,
      registryId: "user",
    };
    const concurrentAdd = visualAssets.add(concurrentInput);
    concurrentScope.projectId = 8;
    concurrentTagIds.push("tag_initial");
    concurrentInput.name = "Mutated";
    concurrentInput.registryId = "mutated";
    concurrentFile.name = "mutated.svg";
    concurrentFile.mediaType = "text/plain";
    concurrentFile.read = async () => new Uint8Array();
    releaseRead();
    const concurrent = await concurrentAdd;
    expect(concurrent.scopes).toEqual([{ kind: "project", projectId: 7 }]);
    expect(concurrent.tagIds).toEqual([]);
    expect(concurrent).toMatchObject({
      name: "Concurrent",
      registryId: "user",
      mediaType: "image/svg+xml",
      provenance: { fileName: "concurrent.svg" },
    });
  });

  it("snapshots every structured public async input before its first suspension", async () => {
    const visualAssets = createMemoryVisualAssetsLibrary({
      authority: {
        projects: [{ projectId: 7, threadIds: [] }, { projectId: 8, threadIds: [] }],
        standaloneThreadIds: [90, 91],
      },
    });
    const createInput = { scope: { kind: "project" as const, projectId: 7 }, name: "Root" };
    const rootPromise = visualAssets.createTag(createInput);
    createInput.scope.projectId = 8;
    createInput.name = "Mutated";
    const root = await rootPromise;
    expect(root).toMatchObject({ name: "Root", scope: { kind: "project", projectId: 7 } });

    const child = await visualAssets.createTag({ scope: { kind: "project", projectId: 7 }, name: "Child" });
    const moveInput = { tagId: child.id, parentTagId: root.id as string | null };
    const movePromise = visualAssets.moveTag(moveInput);
    moveInput.tagId = root.id;
    moveInput.parentTagId = child.id;
    expect(await movePromise).toMatchObject({ id: child.id, parentTagId: root.id });

    const asset = await visualAssets.add({
      file: memoryHarnessFile("asset.svg", "image/svg+xml", validSvg),
      scope: { kind: "project", projectId: 7 }, name: "Asset", tagIds: [],
    });
    await visualAssets.add({
      file: memoryHarnessFile("second.svg", "image/svg+xml", validSvg),
      scope: { kind: "project", projectId: 7 }, name: "Second", tagIds: [],
    });
    const associateInput = { assetId: asset.id, scope: { kind: "thread" as const, threadId: 90 } };
    const associatePromise = visualAssets.associate(associateInput);
    associateInput.assetId = "asset_mutated";
    associateInput.scope.threadId = 91;
    expect((await associatePromise).scopes).toContainEqual({ kind: "thread", threadId: 90 });

    const organizeInput = { assetId: asset.id, addTagIds: [root.id], removeTagIds: [] as string[] };
    const organizePromise = visualAssets.organize(organizeInput);
    organizeInput.assetId = "asset_mutated";
    organizeInput.addTagIds.length = 0;
    organizeInput.removeTagIds.push(root.id);
    expect((await organizePromise).tagIds).toContain(root.id);

    const findInput: {
      scope: { kind: "project"; projectId: number }; tagId: string; limit: number; cursor?: string;
    } = {
      scope: { kind: "project", projectId: 7 }, tagId: root.id, limit: 1,
    };
    const findPromise = visualAssets.find(findInput);
    findInput.scope.projectId = 8;
    findInput.tagId = "tag_mutated";
    findInput.limit = 100;
    findInput.cursor = "mutated";
    expect((await findPromise).items).toHaveLength(1);

    const tagsInput: {
      scope: { kind: "project"; projectId: number }; parentTagId: string | null; limit: number; cursor?: string;
    } = {
      scope: { kind: "project", projectId: 7 }, parentTagId: root.id, limit: 1,
    };
    const tagsPromise = visualAssets.listTags(tagsInput);
    tagsInput.scope.projectId = 8;
    tagsInput.parentTagId = null;
    tagsInput.limit = 100;
    tagsInput.cursor = "mutated";
    expect((await tagsPromise).items).toEqual([expect.objectContaining({ id: child.id, parentTagId: root.id })]);

    for (const method of ["listAssets", "listRegistries"] as const) {
      const input: {
        scope: { kind: "project"; projectId: number }; limit: number; cursor?: string;
      } = {
        scope: { kind: "project", projectId: 7 }, limit: 1,
      };
      const result = visualAssets[method](input);
      input.scope.projectId = 8;
      input.limit = 100;
      input.cursor = "mutated";
      expect((await result).items).toHaveLength(1);
    }
  });

  it("invalidates revision-bound cursors before inserts, archives, or reorganization can duplicate or skip entries", async () => {
    const inserted = createMemoryVisualAssetsLibrary();
    await inserted.createTag({ scope: { kind: "library" }, name: "A" });
    await inserted.createTag({ scope: { kind: "library" }, name: "B" });
    const insertPage = await inserted.listTags({ scope: { kind: "library" }, limit: 1 });
    await inserted.createTag({ scope: { kind: "library" }, name: "AA" });
    await expect(inserted.listTags({
      scope: { kind: "library" },
      limit: 1,
      cursor: insertPage.nextCursor!,
    })).rejects.toMatchObject({ code: "page_snapshot_stale" });

    const archived = createMemoryVisualAssetsLibrary();
    await archived.add({
      file: memoryHarnessFile("a.svg", "image/svg+xml", validSvg),
      scope: { kind: "library" }, name: "A", tagIds: [],
    });
    const archiveTarget = await archived.add({
      file: memoryHarnessFile("b.svg", "image/svg+xml", validSvg),
      scope: { kind: "library" }, name: "B", tagIds: [],
    });
    const archivePage = await archived.listAssets({ scope: { kind: "library" }, limit: 1 });
    await archived.archive(archiveTarget.id);
    await expect(archived.listAssets({
      scope: { kind: "library" },
      limit: 1,
      cursor: archivePage.nextCursor!,
    })).rejects.toMatchObject({ code: "page_snapshot_stale" });

    const reorganized = createMemoryVisualAssetsLibrary();
    const root = await reorganized.createTag({ scope: { kind: "library" }, name: "Root" });
    await reorganized.createTag({ scope: { kind: "library" }, name: "A", parentTagId: root.id });
    const moved = await reorganized.createTag({ scope: { kind: "library" }, name: "B", parentTagId: root.id });
    const findPage = await reorganized.find({ scope: { kind: "library" }, tagId: root.id, limit: 1 });
    await reorganized.moveTag({ tagId: moved.id, parentTagId: null });
    await expect(reorganized.find({
      scope: { kind: "library" },
      tagId: root.id,
      limit: 1,
      cursor: findPage.nextCursor!,
    })).rejects.toMatchObject({ code: "page_snapshot_stale" });
  });

  it("keeps cursors valid when organize, associate, and archive are observable no-ops", async () => {
    const visualAssets = createMemoryVisualAssetsLibrary();
    const present = await visualAssets.createTag({ scope: { kind: "library" }, name: "Present" });
    const absent = await visualAssets.createTag({ scope: { kind: "library" }, name: "Absent" });
    const firstAsset = await visualAssets.add({
      file: memoryHarnessFile("a.svg", "image/svg+xml", validSvg),
      scope: { kind: "library" }, name: "A", tagIds: [present.id],
    });
    await visualAssets.add({
      file: memoryHarnessFile("b.svg", "image/svg+xml", validSvg),
      scope: { kind: "library" }, name: "B", tagIds: [],
    });
    const archived = await visualAssets.add({
      file: memoryHarnessFile("c.svg", "image/svg+xml", validSvg),
      scope: { kind: "library" }, name: "C", tagIds: [],
    });
    await visualAssets.archive(archived.id);

    async function cursorSurvives(operation: () => Promise<unknown>): Promise<void> {
      const page = await visualAssets.listAssets({ scope: { kind: "library" }, limit: 1 });
      await operation();
      await expect(visualAssets.listAssets({
        scope: { kind: "library" }, limit: 1, cursor: page.nextCursor!,
      })).resolves.toMatchObject({ nextCursor: null });
    }

    await cursorSurvives(() => visualAssets.organize({
      assetId: firstAsset.id, addTagIds: [present.id], removeTagIds: [absent.id],
    }));
    await cursorSurvives(() => visualAssets.associate({
      assetId: firstAsset.id, scope: { kind: "library" },
    }));
    await cursorSurvives(() => visualAssets.archive(archived.id));
  });

  it("fully decodes PNG and JPEG, strictly sanitizes SVG, and rejects unsupported or incomplete representations", async () => {
    const visualAssets = createMemoryVisualAssetsLibrary();
    await expect(visualAssets.add({
      file: memoryHarnessFile("shape.svg", "image/svg+xml", validSvg),
      scope: { kind: "library" }, name: "Shape", tagIds: [],
    })).resolves.toMatchObject({ mediaType: "image/svg+xml" });

    for (const [mediaType, bytes] of [["image/png", pngBytes], ["image/jpeg", jpegBytes]] as const) {
      await expect(visualAssets.add({
        file: memoryHarnessFile(`asset-${mediaType}.bin`, mediaType, bytes),
        scope: { kind: "library" }, name: mediaType, tagIds: [],
      })).resolves.toMatchObject({ mediaType });
    }

    const unsupportedRaster = [
      ["image/webp", webpBytes],
      ["image/gif", gifBytes],
      ["image/avif", new Uint8Array([0, 0, 0, 20, 102, 116, 121, 112, 97, 118, 105, 102, 0, 0, 0, 0, 97, 118, 105, 102])],
    ] as const;
    for (const [mediaType, bytes] of unsupportedRaster) {
      await expect(visualAssets.add({
        file: memoryHarnessFile(`asset-${mediaType}.bin`, mediaType, bytes),
        scope: { kind: "library" }, name: mediaType, tagIds: [],
      })).rejects.toMatchObject({ code: "media_type_unsupported" });
    }

    for (const [name, mediaType, content, code] of [
      ["truncated.png", "image/png", pngBytes.slice(0, -12), "media_content_malformed"],
      ["trailing.png", "image/png", new Uint8Array([...pngBytes, 1]), "media_content_malformed"],
      ["fake-iend.png", "image/png", new Uint8Array([
        ...pngBytes, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
      ]), "media_content_malformed"],
      ["bad-crc.png", "image/png", new Uint8Array(pngBytes.map((byte, index) => index === 50 ? byte ^ 1 : byte)), "media_content_malformed"],
      ["truncated.jpg", "image/jpeg", jpegBytes.slice(0, -2), "media_content_malformed"],
      ["trailing.jpg", "image/jpeg", new Uint8Array([...jpegBytes, 1]), "media_content_malformed"],
      ["fake-eoi.jpg", "image/jpeg", new Uint8Array([...jpegBytes, 74, 85, 78, 75, 255, 217]), "media_content_malformed"],
      ["trailing.svg", "image/svg+xml", `${validSvg}trailing`, "media_content_malformed"],
      ["import.svg", "image/svg+xml", "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1 1\"><style>@import url(https://example.com/a.css)</style><path d=\"M0 0h1v1H0z\"/></svg>", "media_content_unsafe"],
      ["external.svg", "image/svg+xml", "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1 1\"><image href=https://example.com/a.png /></svg>", "media_content_unsafe"],
      ["escaped-url.svg", "image/svg+xml", "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1 1\"><path fill=\"u\\72l(\\68ttps\\3a\\2f\\2fevil.example/a)\" d=\"M0 0h1v1H0z\"/></svg>", "media_content_unsafe"],
      ["escaped-scheme.svg", "image/svg+xml", "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1 1\"><path stroke=\"\\6a\\61vascript\\3a alert(1)\" d=\"M0 0h1v1H0z\"/></svg>", "media_content_unsafe"],
      ["empty.svg", "image/svg+xml", "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1 1\"></svg>", "media_content_malformed"],
    ] as const) {
      await expect(visualAssets.add({
        file: memoryHarnessFile(name, mediaType, content),
        scope: { kind: "library" }, name, tagIds: [],
      })).rejects.toMatchObject({ code });
    }
    expect((await visualAssets.listAssets({ scope: { kind: "library" } })).items)
      .toHaveLength(3);
  });

  it("enforces deterministic encoded, decoded-pixel, decoded-byte, and raster-concurrency limits", async () => {
    const visualAssets = createMemoryVisualAssetsLibrary();
    await expect(visualAssets.add({
      file: memoryHarnessFile("encoded.png", "image/png", new Uint8Array(8 * 1024 * 1024 + 1)),
      scope: { kind: "library" }, name: "Encoded", tagIds: [],
    })).rejects.toMatchObject({ code: "media_encoded_bytes_limit" });

    const tooManyPixels = await sharp({
      create: { width: 4097, height: 4097, channels: 3, background: { r: 1, g: 2, b: 3 } },
    }).jpeg({ quality: 1 }).toBuffer();
    await expect(visualAssets.add({
      file: memoryHarnessFile("pixels.jpg", "image/jpeg", tooManyPixels),
      scope: { kind: "library" }, name: "Pixels", tagIds: [],
    })).rejects.toMatchObject({ code: "media_decoded_pixels_limit" });

    const tooManyDecodedBytes = await sharp({
      create: { width: 3000, height: 3000, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } },
    }).png().toBuffer();
    await expect(visualAssets.add({
      file: memoryHarnessFile("decoded.png", "image/png", tooManyDecodedBytes),
      scope: { kind: "library" }, name: "Decoded", tagIds: [],
    })).rejects.toMatchObject({ code: "media_decoded_bytes_limit" });

    const concurrent = await Promise.allSettled(["A", "B", "C"].map((name) => visualAssets.add({
      file: memoryHarnessFile(`${name}.jpg`, "image/jpeg", jpegBytes),
      scope: { kind: "library" }, name, tagIds: [],
    })));
    expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    expect(concurrent.filter((result) => result.status === "rejected").map((result) => result.reason))
      .toEqual([expect.objectContaining({ code: "media_validation_concurrency_limit" })]);
  });

  it("inspects a resolved digest-verified preview", async () => {
    const visualAssets = createMemoryVisualAssetsLibrary();
    const asset = await visualAssets.add({
      file: memoryHarnessFile("preview.svg", "image/svg+xml", validSvg),
      scope: { kind: "library" }, name: "Preview", tagIds: [],
    });

    const inspected = await visualAssets.inspect(asset.id);
    expect(inspected.preview).toMatchObject({
      name: "preview.svg",
      mediaType: "image/svg+xml",
      byteLength: Buffer.byteLength(validSvg),
      digest: asset.digest,
      expectedDigest: asset.digest,
    });
    expect(new TextDecoder().decode(await inspected.preview.read())).toBe(validSvg);
    expect(Object.isFrozen(inspected)).toBe(true);
    expect(Object.isFrozen(inspected.preview)).toBe(true);

  });

  it("validates all bootstrap media, bytes, length, and supplied digests before publishing any asset", async () => {
    const unsupported = createMemoryVisualAssetsLibrary({
      initialAssets: [{
        id: "asset_raster",
        registryId: "user",
        name: "Raster",
        fileName: "raster.webp",
        mediaType: "image/webp",
        content: webpBytes,
        scopes: [{ kind: "library" }],
        tagIds: [],
      }],
    });
    await expect(unsupported.listAssets({ scope: { kind: "library" } }))
      .rejects.toMatchObject({ code: "media_type_unsupported" });

    const unsafe = createMemoryVisualAssetsLibrary({
      initialAssets: [{
        id: "asset_valid_first",
        registryId: "user",
        name: "Valid first",
        fileName: "valid.svg",
        mediaType: "image/svg+xml",
        content: validSvg,
        scopes: [{ kind: "library" }],
        tagIds: [],
      }, {
        id: "asset_unsafe",
        registryId: "user",
        name: "Unsafe",
        fileName: "unsafe.svg",
        mediaType: "image/svg+xml",
        content: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1 1\"><script/></svg>",
        scopes: [{ kind: "library" }],
        tagIds: [],
      }],
    });
    await expect(unsafe.listAssets({ scope: { kind: "library" } }))
      .rejects.toMatchObject({ code: "media_content_unsafe" });
    await expect(unsafe.inspect("asset_valid_first"))
      .rejects.toMatchObject({ code: "media_content_unsafe" });

    const wrongDigest = createMemoryVisualAssetsLibrary({
      initialAssets: [{
        id: "asset_wrong_digest",
        registryId: "user",
        name: "Wrong digest",
        fileName: "wrong.svg",
        mediaType: "image/svg+xml",
        content: validSvg,
        digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        byteLength: Buffer.byteLength(validSvg) + 1,
        scopes: [{ kind: "library" }],
        tagIds: [],
      }],
    });
    await expect(wrongDigest.listAssets({ scope: { kind: "library" } }))
      .rejects.toMatchObject({ code: "digest_mismatch" });
  });

  it("round-trips provenance and archival state through the validated bootstrap seam", async () => {
    const first = createMemoryVisualAssetsLibrary();
    const added = await first.add({
      file: memoryHarnessFile("portrait.jpg", "image/jpeg", jpegBytes),
      scope: { kind: "library" }, name: "Portrait", tagIds: [],
    });
    const archived = await first.archive(added.id);
    const downloaded = await first.download(archived.id);
    const reopened = createMemoryVisualAssetsLibrary({
      initialAssets: [{
        id: archived.id,
        registryId: archived.registryId,
        name: archived.name,
        fileName: archived.provenance.fileName,
        mediaType: archived.mediaType,
        content: await downloaded.read(),
        digest: archived.digest,
        byteLength: archived.byteLength,
        scopes: archived.scopes,
        tagIds: archived.tagIds,
        archived: archived.archived,
        provenance: archived.provenance,
      }],
    });

    expect((await reopened.inspect(archived.id)).asset).toEqual(archived);
    expect((await reopened.listAssets({ scope: { kind: "library" } })).items).toEqual([]);
    expect(await (await reopened.download(archived.id)).read()).toEqual(jpegBytes);
  });

  it("rejects duplicate initial logical asset IDs deterministically", () => {
    const duplicate = {
      id: "asset_duplicate",
      registryId: "user",
      name: "Duplicate",
      fileName: "duplicate.svg",
      mediaType: "image/svg+xml",
      content: validSvg,
      scopes: [{ kind: "library" as const }],
      tagIds: [],
    };

    expect(() => createMemoryVisualAssetsLibrary({ initialAssets: [duplicate, duplicate] }))
      .toThrow(expect.objectContaining({ code: "asset_conflict" }));
  });
});
