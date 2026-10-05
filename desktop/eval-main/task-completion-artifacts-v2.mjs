import { constants } from "node:fs";
import { lstat, realpath, open } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { createCompletionGitView } from "./completion-git-view.mjs";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const hidden = path => path.split(/[\\/]/).some(part => part.startsWith(".") || ["node_modules", "target", "dist", "vendor"].includes(part));
const bounded = (value, bytes) => { const buffer = Buffer.from(value); const text = buffer.subarray(0, bytes).toString("utf8"); return { text, truncated: buffer.length > bytes }; };
const exists = async path => { try { return await lstat(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; } };

// Read-only Git evidence. Fixed executable/environment/arguments disable repository
// helpers; repository content never becomes executable code or a command argument.
export async function completionArtifactEvidenceV2(directory, { baseline, signal, generalEvidence } = {}) {
  signal?.throwIfAborted();
  const packet = { source: "bounded_task_workspace_v2", files: [], omissions: [], omitted: 0, complete: true };
  const omit = (path, reason) => { packet.omitted++; packet.complete = false; if (packet.omissions.length < 64) packet.omissions.push({ path: String(path).slice(0, 300), reason }); };
  if (!directory) return { ...packet, complete: false, unavailable: "No task workspace is available." };
  const identity = await lstat(directory);
  if (identity.isSymbolicLink() || !identity.isDirectory()) return { ...packet, complete: false, unavailable: "Task workspace is not an ordinary directory." };
  const root = await realpath(directory);
  const inside = path => { const part = relative(root, path); return part !== ".." && !part.startsWith("../") && !isAbsolute(part); };
  const metadata = await exists(join(root, ".git"));
  let remaining = 64000, before, git, verifySnapshot, view;
  if (!metadata && baseline) { packet.repository = { unavailable: "Repository metadata is missing." }; omit("repository", "Expected repository metadata is missing."); }
  if (metadata) try {
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(join(root, ".git")) !== join(root, ".git")) throw Error("Repository metadata is not local.");
    for (const name of ["HEAD", "index", "config", "objects", "refs"]) {
      const path = join(root, ".git", name), stat = await exists(path);
      if (stat && (stat.isSymbolicLink() || !inside(await realpath(path)))) throw Error("Repository metadata escapes its workspace.");
    }
    if (await exists(join(root, ".git", "commondir")) || await exists(join(root, ".git", "objects", "info", "alternates"))) throw Error("Shared object stores are unsupported.");
    if (!/^[a-f0-9]{40,64}$/.test(baseline ?? "")) throw Error("Trusted baseline is unavailable.");
    view = await createCompletionGitView(root, { signal });
    git = view.git;
    if ((await git(["rev-parse", "--show-toplevel"])).trim() !== root || (await git(["rev-parse", `${baseline}^{commit}`])).trim() !== baseline) throw Error("Repository or baseline identity changed.");
    const snapshot = async () => ({ head: (await git(["rev-parse", "HEAD"])).trim(), status: await git(["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=all"]) });
    before = await snapshot();
    const names = (await git(["diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "--no-renames", "--name-only", "-z", baseline, "--"]) + await git(["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
    const paths = [...new Set(names)];
    const admitted = [];
    for (const path of paths) {
      if (hidden(path) || isAbsolute(path) || path.split(/[\\/]/).includes("..") || path.length > 1000) { omit(path, "Hidden, unsafe or unsupported path."); continue; }
      const absolute = join(root, path), stat = await exists(absolute);
      if (!stat) { admitted.push(path); continue; } // A deletion is evidence in the patch.
      let unsafe = !stat.isFile() || stat.isSymbolicLink();
      let ancestor = root;
      for (const part of path.split("/").slice(0, -1)) { ancestor = join(ancestor, part); const parent = await lstat(ancestor); if (parent.isSymbolicLink() || await exists(join(ancestor, ".git"))) unsafe = true; }
      if (unsafe || !inside(await realpath(absolute))) { omit(path, "Linked or nested-repository path omitted."); continue; }
      admitted.push(path);
    }
    const selected = admitted.slice(0, 32);
    if (admitted.length > selected.length) omit("changed files", "Additional changed paths exceed the file budget.");
    const diff = selected.length ? await git(["diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "--no-renames", "--unified=3", baseline, "--", ...selected]) : "";
    packet.repository = { source: "host_read_git_state_not_test_results", baseline, head: before.head,
      commitCount: Number((await git(["rev-list", "--count", `${baseline}..HEAD`])).trim()),
      status: bounded(before.status, 8000), log: bounded(await git(["log", "--no-show-signature", "--format=%H %s", "-10", `${baseline}..HEAD`]), 4000),
      changedPaths: selected, diff: { ...bounded(diff, 24000), fullSha256: sha(diff) }, stable: false };
    if (packet.repository.status.truncated || packet.repository.log.truncated || packet.repository.diff.truncated) omit("repository", "Repository evidence is truncated.");
    // A clean porcelain string is convenient while truncation is recorded separately.
    packet.repository.statusTruncated = packet.repository.status.truncated; packet.repository.status = packet.repository.status.text;
    for (const path of selected) {
      signal?.throwIfAborted();
      const absolute = join(root, path), stat = await exists(absolute);
      if (!stat) continue;
      let handle;
      try {
        handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
        const first = await handle.stat();
        if (!first.isFile() || first.size > 2000000 || remaining <= 0) { omit(path, "File exceeds read or evidence budget."); continue; }
        const buffer = Buffer.alloc(Math.min(first.size, 2000000) + 1);
        let length = 0;
        while (length < buffer.length) {
          signal?.throwIfAborted();
          const read = await handle.read(buffer, length, buffer.length - length, length);
          if (!read.bytesRead) break;
          length += read.bytesRead;
        }
        const bytes = buffer.subarray(0, length); const after = await handle.stat(); const current = await lstat(absolute);
        if (first.ino !== current.ino || first.dev !== current.dev || current.isSymbolicLink() || bytes.length !== first.size || first.size !== after.size || first.mtimeMs !== after.mtimeMs || !inside(await realpath(absolute))) { omit(path, "File changed during capture."); continue; }
        const text = new TextDecoder("utf8", { fatal: true }).decode(bytes);
        if (text.includes("\0")) { omit(path, "Binary file omitted."); continue; }
        const excerpt = bounded(text, Math.min(16000, remaining));
        packet.files.push({ path, ...excerpt, fullSha256: sha(bytes), ...(excerpt.truncated ? { excerptSha256: sha(excerpt.text) } : { sha256: sha(bytes) }) });
        remaining -= Buffer.byteLength(excerpt.text);
        if (excerpt.truncated) omit(path, "File excerpt only; changed hunks are in the repository diff.");
      } catch (error) { signal?.throwIfAborted(); omit(path, "File could not be read safely."); }
      finally { await handle?.close(); }
    }
    verifySnapshot = async () => {
      const after = await snapshot();
      const finalDiff = selected.length ? await git(["diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "--no-renames", "--unified=3", baseline, "--", ...selected]) : "";
      let stable = await view.unchanged() && after.head === before.head && after.status === before.status && sha(finalDiff) === sha(diff);
      for (const file of packet.files.filter(file => file.fullSha256)) {
        let handle;
        try {
          const path = join(root, file.path), stat = await lstat(path);
          if (!stat.isFile() || stat.isSymbolicLink() || !inside(await realpath(path)) || stat.size > 2000000) { stable = false; continue; }
          handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
          const buffer = Buffer.alloc(stat.size + 1); let length = 0;
          while (length < buffer.length) { signal?.throwIfAborted(); const read = await handle.read(buffer, length, buffer.length - length, length); if (!read.bytesRead) break; length += read.bytesRead; }
          if (sha(buffer.subarray(0, length)) !== file.fullSha256) stable = false;
        } finally { await handle?.close(); }
      }
      packet.repository.stable = stable;
      if (!stable) omit("repository", "Repository changed during capture; state is not a consistent snapshot.");
    };
  } catch (error) { await view?.close(); view = undefined; signal?.throwIfAborted(); packet.repository = { unavailable: "Repository evidence could not be captured safely." }; omit("repository", "Repository metadata, baseline, command limit or identity is unavailable."); }
  let general;
  try { general = await generalEvidence(root, { signal }); } catch (error) { await view?.close(); throw error; }
  for (const file of general.files) {
    if (packet.files.some(selected => selected.path === file.path)) continue;
    if (packet.files.length >= 32 || Buffer.byteLength(file.text) > remaining) { omit(file.path, "General evidence budget exceeded."); continue; }
    packet.files.push(file); remaining -= Buffer.byteLength(file.text);
  }
  if (!general.complete) omit("general workspace", "General artifact traversal omitted files.");
  try { await verifySnapshot?.(); } catch { signal?.throwIfAborted(); if (packet.repository) packet.repository.stable = false; omit("repository", "Repository could not be rechecked."); } finally { await view?.close(); }
  const final = await lstat(directory);
  if (final.isSymbolicLink() || identity.ino !== final.ino || identity.dev !== final.dev || await realpath(directory) !== root) return { source: packet.source, files: [], complete: false, unavailable: "Task workspace changed during inspection." };
  return packet;
}
