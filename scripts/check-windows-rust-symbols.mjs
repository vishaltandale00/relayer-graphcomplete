#!/usr/bin/env node
// A dependency-free compiler probe before the hour-long Windows native build.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
    + "add_library(probe_c STATIC helper.c)\nadd_library(probe STATIC helper.cpp)\n"
    + "add_dependencies(probe probe_c)\n"
    // Exercise the Windows bundler's lib.exe/rename operation on dependent libraries.
    + 'add_custom_command(TARGET probe POST_BUILD COMMAND ${CMAKE_AR} /OUT:$<TARGET_FILE:probe>.bundled $<TARGET_FILE:probe> $<TARGET_FILE:probe_c> COMMAND ${CMAKE_COMMAND} -E rename $<TARGET_FILE:probe>.bundled $<TARGET_FILE:probe> VERBATIM)\n'
    + "add_executable(probe_app main.cpp)\ntarget_link_libraries(probe_app PRIVATE probe)\n");
  await writeFile(join(cpp, "helper.c"), "int c_helper(void) { return 20; }\n");
  await writeFile(join(cpp, "helper.cpp"), "int cpp_helper() { return 22; }\n");
  await writeFile(join(cpp, "main.cpp"), 'extern "C" int c_helper(void); int cpp_helper(); int main() { return c_helper() + cpp_helper() == 42 ? 0 : 1; }\n');
  const toolchain = join(repositoryRoot, "desktop/packaging/windows-ladybug-toolchain.cmake");
  const configurations = [];
  for (const configuration of ["Debug", "RelWithDebInfo"]) {
    const cppBuild = join(cpp, configuration);
    execFileSync("cmake", ["-S", cpp, "-B", cppBuild, "-G", "Ninja",
      `-DCMAKE_BUILD_TYPE=${configuration}`, "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON",
      `-DCMAKE_TOOLCHAIN_FILE=${toolchain}`], options);
    const compileCommands = JSON.parse(await readFile(join(cppBuild, "compile_commands.json"), "utf8"));
    if (compileCommands.length !== 3 || compileCommands.some(({ command }) =>
      /(?:^|\s)[/-]Z(?:7|i|I)(?:\s|$)/u.test(command))) {
      throw new Error(`Ladybug ${configuration} must omit C/C++ debug-format flags at the CMake 3.15 policy floor`);
    }
    execFileSync("cmake", ["--build", cppBuild, "--parallel", "2"], options);
    execFileSync(join(cppBuild, "probe_app.exe"), [], options);
    const objects = [];
    async function inspect(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await inspect(path);
        else if (entry.name.endsWith(".obj")) {
          const headers = execFileSync("dumpbin", ["/headers", path], { ...options, stdio: "pipe", encoding: "utf8" });
          // Debug runtime checks may emit a small .debug$S metadata section even
          // without symbolic-debug flags. The repeated private types live in .debug$T.
          if (/\.debug\$T/u.test(headers)) throw new Error(`Embedded CodeView type section in ${path}`);
          const bytes = await readFile(path);
          objects.push({ name: entry.name, codeViewSymbolsPresent: /\.debug\$S/u.test(headers), codeViewTypesPresent: false, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
        } else if (/\.pdb$/iu.test(entry.name)) throw new Error(`Shared compiler PDB in ${path}`);
      }
    }
    // CMake compiler-identification objects have their own diagnostic flags.
    // Inspect only the targets governed by the owned Ladybug policy.
    for (const targetName of ["probe_c", "probe", "probe_app"]) await inspect(join(cppBuild, "CMakeFiles", `${targetName}.dir`));
    if (objects.length !== 3) throw new Error(`Expected three compiled C/C++ objects for ${configuration}`);
    const cppFiles = [];
    for (const name of ["probe.lib", "probe_c.lib", "probe_app.exe"]) {
      const path = join(cppBuild, name), info = await lstat(path), bytes = await readFile(path);
      const header = name.endsWith(".exe") ? "MZ" : "!<arch>\n";
      if (!info.isFile() || !info.size || !bytes.subarray(0, header.length).equals(Buffer.from(header))) throw new Error(`Invalid C++ compiler output: ${name}`);
      cppFiles.push({ name, size: info.size, sha256: createHash("sha256").update(bytes).digest("hex") });
    }
    configurations.push({ configuration, compileCommands, objects, files: cppFiles });
  }
  console.log(JSON.stringify({ schema: "relayer.windows-ladybug-debug-probe/v2", minimumCMakePolicyVersion: "3.15",
    toolchainSha256: createHash("sha256").update(await readFile(toolchain)).digest("hex"),
    scope: "Compiler policy, object debug sections and small archive bundling; full Ladybug archive capacity requires the native build",
    configurations }, null, 2));
  console.log(JSON.stringify({ schema: "relayer.windows-rust-symbol-probe/v1", target, files }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
