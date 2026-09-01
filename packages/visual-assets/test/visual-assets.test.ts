import { describe, expect, it } from "vitest";
import {
  createMemoryVisualAssetsLibrary,
  memoryHarnessFile,
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

describe("visual_assets deterministic library interface", () => {
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
    const concurrentAdd = visualAssets.add({
      file: {
        name: "concurrent.svg",
        mediaType: "image/svg+xml",
        async read() {
          await delayedRead;
          return new TextEncoder().encode(validSvg);
        },
      },
      scope: concurrentScope,
      name: "Concurrent",
      tagIds: concurrentTagIds,
    });
    concurrentScope.projectId = 8;
    concurrentTagIds.push("tag_initial");
    releaseRead();
    const concurrent = await concurrentAdd;
    expect(concurrent.scopes).toEqual([{ kind: "project", projectId: 7 }]);
    expect(concurrent.tagIds).toEqual([]);
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
      ["bad-crc.png", "image/png", new Uint8Array(pngBytes.map((byte, index) => index === 50 ? byte ^ 1 : byte)), "media_content_malformed"],
      ["truncated.jpg", "image/jpeg", jpegBytes.slice(0, -2), "media_content_malformed"],
      ["trailing.jpg", "image/jpeg", new Uint8Array([...jpegBytes, 1]), "media_content_malformed"],
      ["trailing.svg", "image/svg+xml", `${validSvg}trailing`, "media_content_malformed"],
      ["import.svg", "image/svg+xml", "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1 1\"><style>@import url(https://example.com/a.css)</style><path d=\"M0 0h1v1H0z\"/></svg>", "media_content_unsafe"],
      ["external.svg", "image/svg+xml", "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1 1\"><image href=https://example.com/a.png /></svg>", "media_content_unsafe"],
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
