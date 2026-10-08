// ART-002: artifact paths stay inside the thread folder, links included; missing
// files and unsupported types reject; fingerprints follow the bytes (PRD 6.6.5, 11.11).
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactFileError, checkArtifactFiles, fingerprintPath } from "../src/artifact-files.js";

let root: string;
let thread: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "artifact-files-"));
  thread = join(root, "thread");
  await mkdir(join(thread, "site/css"), { recursive: true });
  await mkdir(join(thread, "docs"), { recursive: true });
  await mkdir(join(root, "outside"), { recursive: true });
  await writeFile(join(thread, "site/index.html"), "<h1>Tidewater</h1>");
  await writeFile(join(thread, "site/css/styles.css"), "h1{color:teal}");
  await writeFile(join(thread, "docs/brief.pdf"), "%PDF-1.4 fixture");
  await writeFile(join(thread, "docs/notes.txt"), "not markdown");
  await writeFile(join(root, "outside/secret.pdf"), "%PDF private");
  await symlink(join(root, "outside"), join(thread, "shared"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function rejection(artifact: unknown): Promise<{ code: string; path: string }> {
  const error = await checkArtifactFiles(thread, artifact).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ArtifactFileError);
  return { code: (error as ArtifactFileError).code, path: (error as ArtifactFileError).path };
}

describe("checkArtifactFiles", () => {
  it("fingerprints a file inside the thread folder", async () => {
    const first = await checkArtifactFiles(thread, { kind: "pdf", source: { file: "docs/brief.pdf" } });
    expect(first.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(await checkArtifactFiles(thread, { kind: "pdf", source: { file: "docs/brief.pdf" } })).toEqual(first);
    await writeFile(join(thread, "docs/brief.pdf"), "%PDF-1.4 edited");
    expect((await checkArtifactFiles(thread, { kind: "pdf", source: { file: "docs/brief.pdf" } })).fingerprint).not.toBe(first.fingerprint);
  });

  it("fingerprints every file under a website's site root", async () => {
    const site = { kind: "website", source: { file: "site/index.html", root: "site" } };
    const before = await checkArtifactFiles(thread, site);
    await writeFile(join(thread, "site/css/styles.css"), "h1{color:coral}");
    const after = await checkArtifactFiles(thread, site);
    expect(after.fingerprint).not.toBe(before.fingerprint);
    await writeFile(join(thread, "docs/notes.txt"), "outside the site root");
    expect(await checkArtifactFiles(thread, site)).toEqual(after);
  });

  it("fingerprints Office documents by their extension (ART-012)", async () => {
    await writeFile(join(thread, "docs/proposal.docx"), "PK word");
    await writeFile(join(thread, "docs/pitch.key"), "keynote");
    expect((await checkArtifactFiles(thread, { kind: "docx", source: { file: "docs/proposal.docx" } })).fingerprint).toMatch(/^sha256:/u);
    expect((await rejection({ kind: "pptx", source: { file: "docs/pitch.key" } })).code).toBe("artifact_type_unsupported");
  });

  it("rejects paths and links that leave the thread folder", async () => {
    expect(await rejection({ kind: "pdf", source: { file: "../outside/secret.pdf" } })).toEqual({ code: "artifact_path_outside_thread", path: "artifact.source.file" });
    expect(await rejection({ kind: "pdf", source: { file: "shared/secret.pdf" } })).toEqual({ code: "artifact_path_outside_thread", path: "artifact.source.file" });
    expect(await rejection({ kind: "website", source: { file: "site/index.html", root: "shared" } })).toEqual({ code: "artifact_path_outside_thread", path: "artifact.source.root" });
  });

  it("accepts a file link only where the viewer can serve it, inside the file's own folder", async () => {
    await symlink("../docs/brief.pdf", join(thread, "site/brief.pdf"));
    expect(await rejection({ kind: "pdf", source: { file: "site/brief.pdf" } })).toEqual({ code: "artifact_path_outside_folder", path: "artifact.source.file" });
    await symlink("brief.pdf", join(thread, "docs/latest.pdf"));
    expect((await checkArtifactFiles(thread, { kind: "pdf", source: { file: "docs/latest.pdf" } })).fingerprint).toMatch(/^sha256:/u);
  });

  it("rejects missing files, folders, unsupported types and entries outside the root", async () => {
    expect((await rejection({ kind: "pdf", source: { file: "docs/q3-forecast.pdf" } })).code).toBe("artifact_file_missing");
    expect((await rejection({ kind: "markdown", source: { file: "docs" } })).code).toBe("artifact_file_missing");
    expect((await rejection({ kind: "markdown", source: { file: "docs/notes.txt" } })).code).toBe("artifact_type_unsupported");
    expect((await rejection({ kind: "website", source: { file: "site/index.html", root: "docs" } })).code).toBe("artifact_entry_outside_root");
    expect((await rejection({ kind: "url", source: { url: "https://example.com" } })).code).toBe("artifact_invalid");
  });
});

describe("site fingerprints", () => {
  it("frame each entry so different trees never share hash input", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-fingerprint-"));
    try {
      await mkdir(join(root, "one"));
      await writeFile(join(root, "one", "a"), "b");
      await writeFile(join(root, "one", "c"), "");
      await mkdir(join(root, "two"));
      await writeFile(join(root, "two", "a"), "");
      await writeFile(join(root, "two", "bc"), "");
      expect(await fingerprintPath(join(root, "one"))).not.toBe(await fingerprintPath(join(root, "two")));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("links inside a site root", () => {
  it("reject a nested link that leaves the site", async () => {
    const base = await mkdtemp(join(tmpdir(), "relayer-site-link-"));
    try {
      await mkdir(join(base, "thread", "site"), { recursive: true });
      await writeFile(join(base, "thread", "site", "index.html"), "<h1>Hi</h1>");
      await writeFile(join(base, "secret.txt"), "outside");
      await symlink(join(base, "secret.txt"), join(base, "thread", "site", "data.txt"));
      await expect(checkArtifactFiles(join(base, "thread"), { kind: "website", source: { file: "site/index.html", root: "site" } }))
        .rejects.toMatchObject({ code: "artifact_path_outside_thread" });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
