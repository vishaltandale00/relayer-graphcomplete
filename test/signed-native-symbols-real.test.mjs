import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { generateSignedSymbols, installSignedNative, sealSignedNative, verifySignedNative } from "../desktop/packaging/signed-native-cache.mjs";

// No registry/native dependency downloads: this fixture compiles only its own
// Rust + two C archive members. Other platforms cannot certify the macOS seam.
test.runIf(process.platform === "darwin" && process.arch === "arm64")("post-Cargo packed symbols retain every linked native member after object cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "signed-native-real-"));
  try {
    await cp(new URL("./fixtures/signed-native-symbols/", import.meta.url), root, { recursive: true });
    const environment = { ...process.env, CARGO_BUILD_JOBS: "2", CARGO_PROFILE_RELEASE_DEBUG: "1" };
    for (const key of Object.keys(environment)) if (/^(RUSTFLAGS|CARGO_ENCODED_RUSTFLAGS|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER|CARGO_TARGET_DIR)$/.test(key)) delete environment[key];
    const build = (extra) => execFileSync("cargo", ["build", "--release", "--offline"], { cwd: root, env: { ...environment, ...extra }, encoding: "utf8", stdio: "pipe" });
    build({ CARGO_PROFILE_RELEASE_SPLIT_DEBUGINFO: "unpacked" });
    const outputDirectory = join(root, "target/release");
    await expect(readFile(join(outputDirectory, "relayer-app-server.dSYM/Contents/Info.plist"))).rejects.toThrow();
    build({ CARGO_PROFILE_RELEASE_SPLIT_DEBUGINFO: "packed" });
    const binary = join(outputDirectory, "relayer-app-server");
    const units = execFileSync("/usr/bin/dwarfdump", ["--debug-info", "--recurse-depth=0", `${binary}.dSYM`], { encoding: "utf8" });
    expect(units).toContain('("first.c")'); expect(units).toContain('("second.c")'); expect(units).toContain("DW_LANG_Rust");
    // Match both Cargo temporary cleanup and the native preparation owner's
    // finally disposal. Regeneration must now fail; compiler output must work.
    for (const name of await readdir(join(outputDirectory, "deps"))) {
      if (!name.endsWith(".dSYM")) await rm(join(outputDirectory, "deps", name), { recursive: true, force: true });
    }
    await rm(join(outputDirectory, "build"), { recursive: true });
    await expect(generateSignedSymbols(binary, join(root, "late.dSYM"))).rejects.toThrow(/incomplete dSYM.*diagnostics/s);
    const options = { directory: join(root, "sealed"), outputDirectory, identity: "b".repeat(64), producer: { fixture: true } };
    const artifact = await sealSignedNative(options);
    expect(await verifySignedNative(options)).toEqual(artifact);
    await expect(sealSignedNative({ ...options, directory: join(root, "incomplete"),
      generateSymbols: async (source, destination) => { execFileSync("dsymutil", [source, "-o", destination], { stdio: "pipe" }); },
    })).rejects.toThrow("incomplete native symbol coverage");
    await installSignedNative(artifact, join(root, "installed"));
    // A partial native dSYM remains valid UUID/DWARF. Remove one C CU's
    // coverage from the real dump to prove the production verifier catches it.
    const capture = (command, args) => {
      const output = execFileSync(command, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
      if (args[0] !== "--debug-aranges") return output;
      const info = execFileSync("/usr/bin/dwarfdump", ["--debug-info", "--recurse-depth=0", args.at(-1)], { encoding: "utf8" });
      const unit = info.split(/(?=0x[a-f0-9]+: Compile Unit:)/i).find((part) => part.includes('("second.c")'));
      const offset = BigInt(unit.match(/^(0x[a-f0-9]+)/i)[1]);
      return output.split(/(?=Address Range Header:)/).filter((part) => { const id = part.match(/cu_offset = (0x[a-f0-9]+)/i)?.[1]; return !id || BigInt(id) !== offset; }).join("");
    };
    await expect(verifySignedNative({ ...options, capture })).rejects.toThrow("incomplete native symbol coverage");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 60_000);
