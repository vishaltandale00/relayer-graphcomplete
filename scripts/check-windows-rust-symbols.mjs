#!/usr/bin/env node
// A dependency-free compiler probe before the hour-long Windows native build.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { windowsRustPdbPath } from "../desktop/release/windows-rust-debug.mjs";

if (process.platform !== "win32") throw new Error("Windows Rust symbol proof requires a native Windows MSVC runner.");
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = await mkdtemp(join(tmpdir(), "relayer-windows-symbol-probe-"));
const names = ["relayer-app-server", "relayer-graph-server"];
try {
  const manifest = join(root, "Cargo.toml");
  await writeFile(manifest, '[package]\nname = "relayer-symbol-probe"\nversion = "0.0.0"\nedition = "2021"\n'
    + names.map(name => `\n[[bin]]\nname = "${name}"\npath = "${name}.rs"\n`).join(""));
  for (const name of names) await writeFile(join(root, `${name}.rs`), "fn main() {}\n");
  const options = { cwd: repositoryRoot, stdio: "inherit", env: { ...process.env, CARGO_PROFILE_RELEASE_DEBUG: "1" } };
  execFileSync("cargo", ["generate-lockfile", "--manifest-path", manifest, "--offline"], options);
  const target = "x86_64-pc-windows-msvc";
  execFileSync("cargo", ["build", "--manifest-path", manifest, "--target-dir", join(root, "target"),
    "--target", target, "--release", "--locked", "--offline"], options);
  const files = [];
  for (const name of names) {
    const binary = join(root, "target", target, "release", `${name}.exe`);
    for (const path of [binary, windowsRustPdbPath(binary)]) {
      const info = await lstat(path);
      if (!info.isFile() || !info.size) throw new Error(`Missing regular compiler output: ${path}`);
      const bytes = await readFile(path);
      const header = path.endsWith(".exe") ? "MZ" : "Microsoft C/C++ MSF 7.00";
      if (!bytes.subarray(0, header.length).equals(Buffer.from(header))) throw new Error(`Invalid compiler output: ${path}`);
      files.push({ name: path.split(/[\\/]/u).at(-1), size: info.size, sha256: createHash("sha256").update(bytes).digest("hex") });
    }
  }
  console.log(JSON.stringify({ schema: "relayer.windows-rust-symbol-probe/v1", target, files }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
