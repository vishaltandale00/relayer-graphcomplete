// Artifact file checks (PRD 11.11, ADR 0014). Graph-core has no filesystem, so the
// graph server asks the host, which owns each session's working directory, to
// resolve an artifact's paths inside the thread folder and fingerprint them.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readlink, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

const EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  website: [".html", ".htm"],
  pdf: [".pdf"],
  video: [".mp4", ".webm", ".mov"],
  image: [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"],
  markdown: [".md", ".markdown"],
  docx: [".docx"],
  xlsx: [".xlsx"],
  pptx: [".pptx"],
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

/**
 * sha256 of one file, or of every entry under a site root in sorted order. Each entry
 * is framed: its kind, its relative path, then a link's target or a file's length and
 * bytes, so two different trees never share hash input and retargeting a link inside
 * the root counts as a change. Desktop recomputes drift with this same function.
 */
export async function fingerprintPath(path: string): Promise<string> {
  const hash = createHash("sha256");
  const info = await stat(path);
  if (info.isFile()) {
    await hashFile(path, hash);
    return `sha256:${hash.digest("hex")}`;
  }
  const entries: { readonly rel: string; readonly full: string; readonly link?: string; readonly size?: number }[] = [];
  let bytes = 0;
  let visited = 0;
  const rootReal = await realpath(path);
  const tooLarge = () => new ArtifactFileError(
    "artifact_too_large",
    "The site root holds more than 5,000 files or 2 GB. Point root at the built site folder, not the whole project.",
    "artifact.source.root",
  );
  async function walk(folder: string): Promise<void> {
    const listed = (await readdir(folder, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of listed) {
      // Every visited entry, folders included, counts toward the bound before recursing.
      visited += 1;
      if (visited > MAX_SITE_FILES) throw tooLarge();
      const full = join(folder, entry.name);
      const rel = relative(path, full).split(sep).join("/");
      if (entry.isSymbolicLink()) {
        // A link inside the site must stay inside it; the viewer serves nothing outside.
        const target = await realpath(full).catch(() => null);
        if (target !== null && !inside(rootReal, target)) {
          throw new ArtifactFileError(
            "artifact_path_outside_thread",
            `"${rel}" in the site root links outside it. Copy the file into the site instead.`,
            "artifact.source.root",
          );
        }
        entries.push({ rel, full, link: await readlink(full) });
      } else if (entry.isDirectory()) {
        await walk(full);
        continue;
      } else if (entry.isFile()) {
        const size = (await lstat(full)).size;
        bytes += size;
        entries.push({ rel, full, size });
      } else {
        continue;
      }
      if (entries.length > MAX_SITE_FILES || bytes > MAX_SITE_BYTES) throw tooLarge();
    }
  }
  await walk(path);
  for (const entry of entries) {
    if (entry.link !== undefined) {
      hash.update(`L\0${entry.rel}\0${entry.link}\0`);
    } else {
      hash.update(`F\0${entry.rel}\0${entry.size}\0`);
      await hashFile(entry.full, hash);
    }
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
  if (kind !== "website") {
    // The viewer serves a file from its own folder; a link out of that folder would not show.
    const folder = await realpath(dirname(resolve(await realpath(workingDirectory), file)));
    if (!inside(folder, real)) {
      throw new ArtifactFileError("artifact_path_outside_folder", `"${file}" is a link to a file in another folder. Point source.file at that file instead.`, "artifact.source.file");
    }
    return { fingerprint: await fingerprintPath(real) };
  }
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
