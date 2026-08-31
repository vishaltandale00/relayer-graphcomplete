import { describe, expect, it } from "vitest";
import {
  createMemoryVisualAssetsLibrary,
  memoryHarnessFile,
} from "../src/index.js";

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
    const file = memoryHarnessFile("diagram.png", "image/png", new Uint8Array([1, 2, 3]));
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
      file: memoryHarnessFile("chart.png", "image/png", new Uint8Array([1, 2, 3])),
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

  it("archives assets from normal discovery without invalidating digest-backed downloads", async () => {
    const visualAssets = createMemoryVisualAssetsLibrary();
    const asset = await visualAssets.add({
      file: memoryHarnessFile("photo.webp", "image/webp", new Uint8Array([8, 6, 7, 5, 3, 0, 9])),
      scope: { kind: "library" },
      name: "Photo",
      tagIds: [],
    });

    expect((await visualAssets.archive(asset.id)).archived).toBe(true);
    expect((await visualAssets.listAssets({ scope: { kind: "library" } })).items).toEqual([]);
    const downloaded = await visualAssets.download({ digest: asset.digest });
    expect(downloaded).toMatchObject({ name: "photo.webp", mediaType: "image/webp" });
    expect([...await downloaded.read()]).toEqual([8, 6, 7, 5, 3, 0, 9]);
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
});
