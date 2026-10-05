import { constants } from "node:fs";
import { mkdtemp, mkdir, lstat, open, writeFile, symlink, rm, access, realpath } from "node:fs/promises";
import { join, delimiter, isAbsolute, relative, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
// Snapshot the host environment before any candidate runs; repository paths never
// select tooling. Resolve an absolute host Git once per capture, outside the workspace.
const hostPath = process.env.PATH ?? "";
export async function trustedGitExecutable(root, { platform = process.platform, path = hostPath } = {}) {
  root = await realpath(root);
  for (const directory of path.split(platform === "win32" ? ";" : delimiter)) {
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, platform === "win32" ? "git.exe" : "git");
    try {
      const executable = await realpath(candidate);
      const part = relative(root, executable);
      if (part === "" || (part.split(/[\\/]/)[0] !== ".." && !isAbsolute(part))) continue;
      if (!(await lstat(executable)).isFile()) continue;
      await access(executable, constants.X_OK);
      return executable;
    } catch { /* Missing host path entry is not a repository fallback. */ }
  }
  throw Error("Trusted host Git is unavailable.");
}
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

// Normalization commands see only host-owned config. A candidate changing its
// filter config after preflight cannot turn a later diff/status into execution.
export async function createCompletionGitView(root, { signal } = {}) {
  const metadata = join(root, ".git"); const identity = await lstat(metadata);
  const executable = await trustedGitExecutable(root);
  const directory = await mkdtemp(join(tmpdir(), "completion-git-"));
  const emptyConfig = join(directory, "empty-config");
  const hooks = join(directory, "empty-hooks");
  try {
  await writeFile(emptyConfig, "", { mode: 0o600 });
  await mkdir(hooks);
  const run = async (gitDirectory, args) => {
    signal?.throwIfAborted();
    const { stdout } = await execute(executable, ["--no-pager", "--literal-pathspecs", `--git-dir=${gitDirectory}`, `--work-tree=${root}`, "-c", "core.fsmonitor=false", "-c", `core.hooksPath=${hooks}`, "-c", "core.untrackedCache=false", ...args], {
      cwd: root, signal, timeout: 2000, maxBuffer: 256000, encoding: "utf8",
      env: { PATH: dirname(executable), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: emptyConfig, GIT_CONFIG_GLOBAL: emptyConfig, GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
    });
    return stdout;
  };
  // These source commands only inspect configuration/identity; neither performs
  // working-tree normalization, invokes hooks, nor displays repository messages.
  try { if ((await run(metadata, ["config", "--includes", "--get-regexp", "^filter\\."])).trim()) throw Error("Repository filters are unsupported."); }
  catch (error) { if (error.code !== 1) throw error; }
  async function sourceState() {
    const current = await lstat(metadata);
    if (current.isSymbolicLink() || !current.isDirectory() || current.ino !== identity.ino || current.dev !== identity.dev) throw Error("Repository metadata changed.");
    let handle;
    let bytes = Buffer.alloc(0);
    try {
      handle = await open(join(metadata, "index"), constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = await handle.stat(); if (!before.isFile() || before.size > 16000000) throw Error("Repository index is unsupported.");
      const buffer = Buffer.alloc(before.size + 1); let length = 0;
      while (length < buffer.length) { signal?.throwIfAborted(); const read = await handle.read(buffer, length, buffer.length - length, length); if (!read.bytesRead) break; length += read.bytesRead; }
      const after = await handle.stat();
      if (length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw Error("Repository index changed.");
      bytes = buffer.subarray(0, length);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    finally { await handle?.close(); }
    const head = (await run(metadata, ["rev-parse", "--verify", "HEAD"])).trim();
    if (!/^[a-f0-9]{40,64}$/.test(head)) throw Error("Repository HEAD is unavailable.");
    return { head, indexDigest: hash(bytes), bytes };
  }
  const initial = await sourceState();
    await mkdir(join(directory, "refs"));
    await writeFile(join(directory, "config"), "[core]\nrepositoryformatversion = 0\nbare = false\n", { mode: 0o600 });
    await writeFile(join(directory, "HEAD"), initial.head + "\n", { mode: 0o600 });
    if (initial.bytes.length) await writeFile(join(directory, "index"), initial.bytes, { mode: 0o600 });
    await symlink(join(metadata, "objects"), join(directory, "objects"), process.platform === "win32" ? "junction" : "dir");
    return { git: args => run(directory, args),
      async unchanged() { const current = await sourceState(); return current.head === initial.head && current.indexDigest === initial.indexDigest; },
      close: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}
