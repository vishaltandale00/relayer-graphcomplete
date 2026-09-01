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
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/AP/EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAQUCf//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8Bf//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8Bf//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEABj8Cf//Z",
);

describe("visual_assets deterministic library interface", () => {
  it("adds identical files as distinct immutable logical assets with one digest", async () => {
    const visualAssets = createMemoryVisualAssetsLibrary();
    const file = memoryHarnessFile("mark.svg", "image/svg+xml", "<svg></svg>");

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
      preview: { mediaType: "image/svg+xml", byteLength: 11 },
    });
  });

  it("searches explicit scopes and includes authorized thread assets in their project", async () => {
    const visualAssets = createMemoryVisualAssetsLibrary({
      authority: { projects: [{ projectId: 7, threadIds: [70, 71] }], standaloneThreadIds: [90] },
    });
    const file = memoryHarnessFile("diagram.png", "image/png", pngBytes);
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
      file: memoryHarnessFile("wordmark.svg", "image/svg+xml", "<svg></svg>"),
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
      file: memoryHarnessFile("chart.png", "image/png", pngBytes),
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
      file: memoryHarnessFile("photo.webp", "image/webp", webpBytes),
      scope: { kind: "library" },
      name: "Photo",
      tagIds: [],
    });

    expect((await visualAssets.archive(asset.id)).archived).toBe(true);
    expect((await visualAssets.listAssets({ scope: { kind: "library" } })).items).toEqual([]);
    const downloaded = await visualAssets.download(asset.id);
    expect(downloaded).toMatchObject({ name: "photo.webp", mediaType: "image/webp" });
    expect([...await downloaded.read()]).toEqual([...webpBytes]);
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
        content: "<svg></svg>",
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
      file: memoryHarnessFile("asset.svg", "image/svg+xml", "<svg></svg>"),
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
    const visualAssets = createMemoryVisualAssetsLibrary({
      authority: {
        projects: [{ projectId: 7, threadIds: [] }, { projectId: 8, threadIds: [] }],
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
        content: "<svg></svg>",
        scopes: [initialAssetScope],
        tagIds: initialTagIds,
      }],
    });
    initialTagScope.projectId = 8;
    initialAssetScope.projectId = 8;
    initialTagIds.length = 0;

    const addScope = { kind: "project" as const, projectId: 7 };
    const added = await visualAssets.add({
      file: memoryHarnessFile("added.svg", "image/svg+xml", "<svg></svg>"),
      scope: addScope,
      name: "Added",
      tagIds: [],
    });
    addScope.projectId = 8;
    const associationScope = { kind: "thread" as const, threadId: 90 };
    const associated = await visualAssets.associate({ assetId: added.id, scope: associationScope });
    associationScope.threadId = 91;

    expect((await visualAssets.listAssets({ scope: { kind: "project", projectId: 7 } })).items)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: "asset_initial" }), expect.objectContaining({ id: added.id })]));
    expect((await visualAssets.listAssets({ scope: { kind: "project", projectId: 8 } })).items).toEqual([]);
    expect((await visualAssets.listAssets({ scope: { kind: "thread", threadId: 90 } })).items)
      .toEqual([associated]);
    expect((await visualAssets.listAssets({ scope: { kind: "thread", threadId: 91 } })).items).toEqual([]);
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
          return new TextEncoder().encode("<svg></svg>");
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
      file: memoryHarnessFile("a.svg", "image/svg+xml", "<svg></svg>"),
      scope: { kind: "library" }, name: "A", tagIds: [],
    });
    const archiveTarget = await archived.add({
      file: memoryHarnessFile("b.svg", "image/svg+xml", "<svg></svg>"),
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

  it("validates the bytes of every supported representation and atomically rejects mismatched or unsafe content", async () => {
    const validRepresentations = [
      ["image/png", pngBytes],
      ["image/webp", webpBytes],
      ["image/jpeg", jpegBytes],
      ["image/gif", gifBytes],
      ["image/avif", new Uint8Array([0, 0, 0, 20, 102, 116, 121, 112, 97, 118, 105, 102, 0, 0, 0, 0, 97, 118, 105, 102])],
      ["image/svg+xml", new TextEncoder().encode("<svg xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M0 0\"/></svg>")],
    ] as const;
    const accepted = createMemoryVisualAssetsLibrary();
    for (const [mediaType, bytes] of validRepresentations) {
      await expect(accepted.add({
        file: memoryHarnessFile(`asset-${mediaType.replaceAll("/", "-")}`, mediaType, bytes),
        scope: { kind: "library" },
        name: mediaType,
        tagIds: [],
      })).resolves.toMatchObject({ mediaType });
    }

    const rejected = createMemoryVisualAssetsLibrary();
    for (const mediaType of ["image/png", "image/webp", "image/jpeg", "image/gif", "image/avif"] as const) {
      await expect(rejected.add({
        file: memoryHarnessFile(`disguised-${mediaType}.bin`, mediaType, "<svg></svg>"),
        scope: { kind: "library" }, name: `Disguised ${mediaType}`, tagIds: [],
      })).rejects.toMatchObject({ code: "media_content_mismatch" });
    }
    await expect(rejected.add({
      file: memoryHarnessFile("active.svg", "image/svg+xml", "<svg><script>alert(1)</script></svg>"),
      scope: { kind: "library" }, name: "Active", tagIds: [],
    })).rejects.toMatchObject({ code: "media_content_unsafe" });
    await expect(rejected.add({
      file: memoryHarnessFile("broken.svg", "image/svg+xml", "<svg><g></svg>"),
      scope: { kind: "library" }, name: "Broken", tagIds: [],
    })).rejects.toMatchObject({ code: "media_content_malformed" });
    expect((await rejected.listAssets({ scope: { kind: "library" } })).items).toEqual([]);
  });

  it("inspects a resolved digest-verified preview and reports unavailable or corrupt persisted content", async () => {
    const visualAssets = createMemoryVisualAssetsLibrary();
    const asset = await visualAssets.add({
      file: memoryHarnessFile("preview.svg", "image/svg+xml", "<svg></svg>"),
      scope: { kind: "library" }, name: "Preview", tagIds: [],
    });

    const inspected = await visualAssets.inspect(asset.id);
    expect(inspected.preview).toMatchObject({
      name: "preview.svg",
      mediaType: "image/svg+xml",
      byteLength: 11,
      digest: asset.digest,
      expectedDigest: asset.digest,
    });
    expect(new TextDecoder().decode(await inspected.preview.read())).toBe("<svg></svg>");
    expect(Object.isFrozen(inspected)).toBe(true);
    expect(Object.isFrozen(inspected.preview)).toBe(true);

    const persisted = createMemoryVisualAssetsLibrary({
      initialAssets: [{
        id: "asset_unavailable",
        registryId: "user",
        name: "Unavailable",
        fileName: "unavailable.svg",
        mediaType: "image/svg+xml",
        digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        byteLength: 11,
        scopes: [{ kind: "library" }],
        tagIds: [],
      }, {
        id: "asset_corrupt",
        registryId: "user",
        name: "Corrupt",
        fileName: "corrupt.svg",
        mediaType: "image/svg+xml",
        content: "<svg></svg>",
        digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        byteLength: 11,
        scopes: [{ kind: "library" }],
        tagIds: [],
      }],
    });
    await expect(persisted.inspect("asset_unavailable"))
      .rejects.toMatchObject({ code: "content_unavailable" });
    await expect(persisted.inspect("asset_corrupt"))
      .rejects.toMatchObject({ code: "digest_mismatch" });
  });

  it("rejects duplicate initial logical asset IDs deterministically", () => {
    const duplicate = {
      id: "asset_duplicate",
      registryId: "user",
      name: "Duplicate",
      fileName: "duplicate.svg",
      mediaType: "image/svg+xml",
      content: "<svg></svg>",
      scopes: [{ kind: "library" as const }],
      tagIds: [],
    };

    expect(() => createMemoryVisualAssetsLibrary({ initialAssets: [duplicate, duplicate] }))
      .toThrow(expect.objectContaining({ code: "asset_conflict" }));
  });
});
