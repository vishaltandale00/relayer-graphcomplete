// Artifact file checks (PRD 11.11, ADR 0014). Graph-core has no filesystem, so the
// graph server asks the host, which owns each session's working directory, to
// resolve an artifact's paths inside the thread folder and fingerprint them.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  website: [".html", ".htm"],
  pdf: [".pdf"],
  video: [".mp4", ".webm", ".mov"],
  image: [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"],
  markdown: [".md", ".markdown"],
};

/** A site root is fingerprinted file by file; these bounds keep that honest. */
const MAX_SITE_FILES = 5_000;
const MAX_SITE_BYTES = 2 * 1024 * 1024 * 1024;

export class ArtifactFileError extends Error {
  constructor(readonly code: string, message: string, readonly path = "artifact.source.file") {
    super(message);
    this.name = "ArtifactFileError";
  }
}

export interface ArtifactFileCheck {
  readonly fingerprint: string;
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

/**
 * Resolve a relative path inside the working directory, following links.
 * The returned path is the real path; anything outside, missing or of the
 * wrong type is a repairable error for the agent.
 */
async function resolveInside(workingDirectory: string, relativePath: string, path: string): Promise<string> {
  const root = await realpath(workingDirectory);
  const lexical = resolve(root, relativePath);
  if (!inside(root, lexical)) {
    throw new ArtifactFileError("artifact_path_outside_thread", `"${relativePath}" resolves outside the thread folder.`, path);
  }
  let real: string;
  try {
    real = await realpath(lexical);
  } catch {
    throw new ArtifactFileError("artifact_file_missing", `"${relativePath}" does not exist in the thread folder. Create it first, then submit the node.`, path);
  }
  if (!inside(root, real)) {
    throw new ArtifactFileError(
      "artifact_path_outside_thread",
      `"${relativePath}" is a link that resolves outside the thread folder. Copy the file into the thread folder instead.`,
      path,
    );
  }
  return real;
}

async function hashFile(path: string, hash: ReturnType<typeof createHash>): Promise<void> {
  await new Promise<void>((done, fail) => {
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => done())
      .on("error", fail);
  });
}

/** sha256 of one file, or of every file under a folder (relative path, NUL, bytes; sorted). */
export async function fingerprintPath(path: string): Promise<string> {
  const hash = createHash("sha256");
  const info = await stat(path);
  if (info.isFile()) {
    await hashFile(path, hash);
    return `sha256:${hash.digest("hex")}`;
  }
  const files: string[] = [];
  let bytes = 0;
  async function walk(folder: string): Promise<void> {
    const entries = (await readdir(folder, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = join(folder, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        files.push(full);
        bytes += (await lstat(full)).size;
        if (files.length > MAX_SITE_FILES || bytes > MAX_SITE_BYTES) {
          throw new ArtifactFileError(
            "artifact_too_large",
            "The site root holds more than 5,000 files or 2 GB. Point root at the built site folder, not the whole project.",
            "artifact.source.root",
          );
        }
      }
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

/** Check one artifact record's files against the working directory and fingerprint them. */
export async function checkArtifactFiles(workingDirectory: string, artifact: unknown): Promise<ArtifactFileCheck> {
  if (typeof artifact !== "object" || artifact === null) {
    throw new ArtifactFileError("artifact_invalid", "Artifact details must be one object with kind and source.", "artifact");
  }
  const record = artifact as { kind?: unknown; source?: { file?: unknown; root?: unknown } };
  const kind = typeof record.kind === "string" ? record.kind : "";
  const extensions = EXTENSIONS[kind];
  const file = record.source?.file;
  if (extensions === undefined || typeof file !== "string") {
    throw new ArtifactFileError("artifact_invalid", "Only file artifacts are checked against the thread folder.", "artifact");
  }
  const real = await resolveInside(workingDirectory, file, "artifact.source.file");
  const info = await stat(real);
  if (!info.isFile()) {
    throw new ArtifactFileError("artifact_file_missing", `"${file}" is a folder, not a file.`);
  }
  if (!extensions.some((extension) => real.toLowerCase().endsWith(extension))) {
    throw new ArtifactFileError("artifact_type_unsupported", `"${file}" resolves to a file that is not a supported ${kind} file (${extensions.join(", ")}).`);
  }
  if (kind !== "website") return { fingerprint: await fingerprintPath(real) };
  const rootPath = record.source?.root;
  if (typeof rootPath !== "string") {
    throw new ArtifactFileError("artifact_root_required", "A website names its site root folder.", "artifact.source.root");
  }
  const root = await resolveInside(workingDirectory, rootPath, "artifact.source.root");
  if (!(await stat(root)).isDirectory()) {
    throw new ArtifactFileError("artifact_root_invalid", `"${rootPath}" is not a folder.`, "artifact.source.root");
  }
  if (!inside(root, real)) {
    throw new ArtifactFileError("artifact_entry_outside_root", "The website's entry file must sit inside its site root.");
  }
  return { fingerprint: await fingerprintPath(root) };
}
