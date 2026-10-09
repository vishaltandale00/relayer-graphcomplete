import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "..");

async function sourceFixture() {
  const source = await mkdtemp(join(tmpdir(), "relayer-share-source-"));
  await mkdir(join(source, "scripts"));
  await mkdir(join(source, "desktop"));
  await cp(join(repositoryRoot, "scripts/build-public-share-viewer-artifact.mjs"), join(source, "scripts/build-public-share-viewer-artifact.mjs"));
  await cp(join(repositoryRoot, "desktop/renderer"), join(source, "desktop/renderer"), { recursive: true });
  await cp(join(repositoryRoot, "contracts"), join(source, "contracts"), { recursive: true });
  // The builder regenerates the committed default design (tokens and fonts) itself.
  await cp(join(repositoryRoot, "scripts/design"), join(source, "scripts/design"), { recursive: true });
  await cp(join(repositoryRoot, "designs"), join(source, "designs"), { recursive: true });
  await execFileAsync("git", ["init", "--quiet"], { cwd: source });
  await execFileAsync("git", ["add", "."], { cwd: source });
  await execFileAsync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Fixture source"], { cwd: source });
  return source;
}

describe("public share viewer artifact", () => {
  it("builds an immutable source-bound artifact for private hosting", async () => {
    const output = await mkdtemp(join(tmpdir(), "relayer-share-viewer-"));
    const source = await sourceFixture();
    await execFileAsync("node", [
      "scripts/build-public-share-viewer-artifact.mjs",
      "--output",
      output,
    ], { cwd: source });

    const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({
      version: 1,
      contractVersion: 1,
      builder: "scripts/build-public-share-viewer-artifact.mjs@1",
      snapshotVersions: [1, 2, 3, 4],
      sourceDirty: false,
    });
    expect(manifest.productCommit).toMatch(/^[a-f0-9]{40}$/u);
    expect(manifest.artifactSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(manifest.csp).toContain("connect-src 'none'");
    for (const key of ["logo", "ogImage", "viewerScript", "viewerStyles", "workspaceStyles", "lucideScript", "markedScript"]) {
      expect(manifest.assets[key]).toMatch(new RegExp(`^assets/${manifest.productCommit}/`));
      expect(manifest.resources[key].sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(manifest.resources[key].bytes).toBeGreaterThan(0);
    }
    expect(manifest.files["server/template.js"].sha256).toMatch(/^[a-f0-9]{64}$/u);

    const prefix = `assets/${manifest.productCommit}`;
    const declared = new Set(Object.keys(manifest.files));
    for (const artifactPath of [...declared].filter((path) => path.startsWith(`${prefix}/`) && path.endsWith(".js"))) {
      const source = await readFile(join(output, artifactPath), "utf8");
      for (const match of source.matchAll(/(?:\bfrom\s+|\bimport\s*\()\s*["'](\.[^"']+)["']/gu)) {
        const dependency = posix.normalize(posix.join(posix.dirname(artifactPath), match[1]));
        expect(declared.has(dependency), `${artifactPath} imports missing ${dependency}`).toBe(true);
      }
    }
    for (const artifactPath of [...declared].filter((path) => path.startsWith(`${prefix}/`) && path.endsWith(".css"))) {
      const source = await readFile(join(output, artifactPath), "utf8");
      for (const match of source.matchAll(/url\(["']?(\.[^"')]+)["']?\)/gu)) {
        const dependency = posix.normalize(posix.join(posix.dirname(artifactPath), match[1]));
        expect(declared.has(dependency), `${artifactPath} references missing ${dependency}`).toBe(true);
      }
    }
  });

  it.each([false, true])("refuses %s staged source changes before emitting an artifact", async (staged) => {
    const source = await sourceFixture();
    const output = join(await mkdtemp(join(tmpdir(), "relayer-share-rejected-")), "artifact");
    await writeFile(join(source, "desktop/renderer/styles.css"), "/* changed source */");
    if (staged) await execFileAsync("git", ["add", "."], { cwd: source });
    await expect(execFileAsync("node", ["scripts/build-public-share-viewer-artifact.mjs", "--output", output], { cwd: source }))
      .rejects.toThrow("clean committed source tree");
    await expect(access(output)).rejects.toThrow();
  });
});
