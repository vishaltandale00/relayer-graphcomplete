import { constants } from "node:fs";
import { readdir, realpath, open, lstat } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";

// Host-read, bounded task artifacts. No tools or workspace path are given to the judge.
export async function completionArtifactEvidence(directory, { signal } = {}) {
  const packet = { source: "bounded_task_workspace", files: [], omitted: 0, complete: true };
  if (!directory) return { ...packet, complete: false, unavailable: "No task workspace is available." };
  const rootIdentity = await lstat(directory);
  if (rootIdentity.isSymbolicLink() || !rootIdentity.isDirectory()) return { ...packet, complete: false, unavailable: "Task workspace is not an ordinary directory." };
  const root = await realpath(directory);
  let remaining = 64000;
  let visited = 0;
  const inside = path => { const part = relative(root, path); return part !== ".." && !part.startsWith("../") && !isAbsolute(part); };
  async function walk(path, depth) {
    signal?.throwIfAborted();
    if (depth > 5 || visited >= 256 || packet.files.length >= 32 || remaining <= 0) { packet.omitted++; return; }
    const entries = (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      signal?.throwIfAborted();
      if (++visited > 256 || packet.files.length >= 32 || remaining <= 0) { packet.omitted++; break; }
      if (entry.name.startsWith(".") || ["node_modules", "target", "dist", "vendor"].includes(entry.name)) { packet.omitted++; continue; }
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) { packet.omitted++; continue; }
      const canonical = await realpath(child);
      if (!inside(canonical)) { packet.omitted++; continue; }
      if (entry.isDirectory()) { await walk(canonical, depth + 1); continue; }
      if (!entry.isFile()) { packet.omitted++; continue; }
      let handle;
      try {
        handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
        const before = await handle.stat();
        if (!before.isFile() || before.size > Math.min(32000, remaining)) { packet.omitted++; continue; }
        const buffer = Buffer.alloc(Math.min(32000, remaining) + 1);
        let length = 0;
        while (length < buffer.length) {
          signal?.throwIfAborted();
          const read = await handle.read(buffer, length, buffer.length - length, length);
          if (read.bytesRead === 0) break;
          length += read.bytesRead;
        }
        const bytes = buffer.subarray(0, length);
        const after = await handle.stat();
        const current = await lstat(canonical);
        if (!inside(await realpath(canonical)) || current.isSymbolicLink() || current.ino !== before.ino || current.dev !== before.dev
          || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length > Math.min(32000, remaining)) { packet.omitted++; continue; }
        let text;
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { packet.omitted++; continue; }
        if (text.includes("\0")) { packet.omitted++; continue; }
        packet.files.push({ path: relative(root, canonical), text, sha256: createHash("sha256").update(bytes).digest("hex") });
        remaining -= bytes.length;
      } catch (error) { if (signal?.aborted) throw error; packet.omitted++; }
      finally { await handle?.close(); }
    }
  }
  try { await walk(root, 0); } catch (error) { signal?.throwIfAborted(); packet.complete = false; packet.unavailable = "Some task artifacts could not be read."; }
  const rootAfter = await lstat(directory);
  if (rootAfter.isSymbolicLink() || rootAfter.ino !== rootIdentity.ino || rootAfter.dev !== rootIdentity.dev || await realpath(directory) !== root) {
    return { source: packet.source, files: [], omitted: packet.omitted, complete: false, unavailable: "Task workspace changed during inspection." };
  }
  packet.complete = packet.complete && packet.omitted === 0;
  return packet;
}
