#!/usr/bin/env node
// A dependency-free compiler probe before the hour-long Windows native build.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  // Use Ladybug's actual policy floor, not 3.25: a newer floor silently enables
  // CMP0141 and would miss a toolchain that applies the policy too late.
  const cpp = join(root, "cpp");
  await mkdir(cpp);
  await writeFile(join(cpp, "CMakeLists.txt"), "cmake_minimum_required(VERSION 3.15)\n"
    + "project(RelayerCppSymbols LANGUAGES CXX C)\n"
    + "add_library(probe STATIC helper.c helper.cpp)\n"
    + "add_executable(probe_app main.cpp)\ntarget_link_libraries(probe_app PRIVATE probe)\n");
  await writeFile(join(cpp, "helper.c"), "int c_helper(void) { return 20; }\n");
  await writeFile(join(cpp, "helper.cpp"), "int cpp_helper() { return 22; }\n");
  await writeFile(join(cpp, "main.cpp"), 'extern "C" int c_helper(void); int cpp_helper(); int main() { return c_helper() + cpp_helper() == 42 ? 0 : 1; }\n');
  const toolchain = join(repositoryRoot, "desktop/packaging/windows-ladybug-toolchain.cmake");
  const cppBuild = join(cpp, "build");
  execFileSync("cmake", ["-S", cpp, "-B", cppBuild, "-G", "Ninja",
    "-DCMAKE_BUILD_TYPE=RelWithDebInfo", "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON",
    `-DCMAKE_TOOLCHAIN_FILE=${toolchain}`], options);
  const compileCommands = JSON.parse(await readFile(join(cppBuild, "compile_commands.json"), "utf8"));
  if (compileCommands.length !== 3 || compileCommands.some(({ command }) =>
    !/(?:^|\s)[/-]Z7(?:\s|$)/u.test(command) || /(?:^|\s)[/-]Z[iI](?:\s|$)/u.test(command))) {
    throw new Error("Ladybug CMake 3.15 policy floor must embed C and C++ debug information with /Z7, without /Zi");
  }
  execFileSync("cmake", ["--build", cppBuild, "--parallel", "2"], options);
  execFileSync(join(cppBuild, "probe_app.exe"), [], options);
  const cppFiles = [];
  for (const name of ["probe_app.exe", "probe_app.pdb"]) {
    const path = join(cppBuild, name), info = await lstat(path), bytes = await readFile(path);
    const header = name.endsWith(".exe") ? "MZ" : "Microsoft C/C++ MSF 7.00";
    if (!info.isFile() || !info.size || !bytes.subarray(0, header.length).equals(Buffer.from(header))) throw new Error(`Invalid C++ compiler output: ${name}`);
    cppFiles.push({ name, size: info.size, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  console.log(JSON.stringify({ schema: "relayer.windows-ladybug-debug-probe/v1", minimumCMakePolicyVersion: "3.15",
    toolchainSha256: createHash("sha256").update(await readFile(toolchain)).digest("hex"), compileCommands, files: cppFiles }, null, 2));
  console.log(JSON.stringify({ schema: "relayer.windows-rust-symbol-probe/v1", target, files }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
