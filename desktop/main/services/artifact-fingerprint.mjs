// Artifact fingerprints (PRD 6.6.5). Must match packages/harness-host/src/artifact-files.ts,
// which takes the fingerprint at submission; the viewer recomputes it to report drift.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

async function hashFile(path, hash) {
  await new Promise((done, fail) => {
    createReadStream(path).on("data", (chunk) => hash.update(chunk)).on("end", done).on("error", fail);
  });
}

/** sha256 of one file, or of every file under a folder (relative path, NUL, bytes; sorted). */
export async function fingerprintPath(path) {
  const hash = createHash("sha256");
  const info = await stat(path);
  if (info.isFile()) {
    await hashFile(path, hash);
    return `sha256:${hash.digest("hex")}`;
  }
  const files = [];
  async function walk(folder) {
    const entries = (await readdir(folder, { withFileTypes: true }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = join(folder, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  await walk(path);
  for (const file of files) {
    hash.update(relative(path, file).split(sep).join("/"));
    hash.update("\0");
    await hashFile(file, hash);
  }
  return `sha256:${hash.digest("hex")}`;
}
