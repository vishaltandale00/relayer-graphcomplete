import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, constants as fsConstants, copyFileSync, existsSync, fchmodSync, fsyncSync, fstatSync, ftruncateSync, lstatSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { lstat, readFile, readdir, readlink, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export function fixedGitEnvironment(environment = process.env) {
  const safe = Object.fromEntries(Object.entries(environment).filter(([key, value]) => {
    const normalizedKey = key.toUpperCase();
    return value !== undefined
      && !normalizedKey.startsWith("GIT_")
      && !normalizedKey.startsWith("DYLD_")
      && !normalizedKey.startsWith("OPENSSL_")
      && normalizedKey !== "LD_PRELOAD";
  }));
  return {
    ...safe,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
  };
}

export function sanitizeElectronBootstrapEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([key, value]) => {
    const normalizedKey = key.toUpperCase();
    return value !== undefined
      && !normalizedKey.startsWith("DYLD_")
      && !normalizedKey.startsWith("LD_")
      && !normalizedKey.startsWith("NODE_")
      && !normalizedKey.startsWith("ELECTRON_")
      && !normalizedKey.startsWith("OPENSSL_");
  }));
}

export function fixedGitArguments(repositoryRoot, args) {
  return [
    "--no-optional-locks",
    "-c", "core.attributesFile=/dev/null",
    "-c", "core.fsmonitor=false",
    "-c", `core.worktree=${repositoryRoot}`,
    ...args,
  ];
}

export function isFixedSystemGit(gitPath, platform = process.platform) {
  return platform === "darwin" && gitPath === "/usr/bin/git";
}

export function rejectAncestorCargoConfiguration(startDirectory) {
  if (typeof startDirectory !== "string" || !isAbsolute(startDirectory) || startDirectory.includes("\0")) {
    throw new Error("Cargo configuration inspection requires an absolute directory.");
  }
  const discovered = [];
  let directory = resolve(startDirectory);
  while (true) {
    for (const name of ["config", "config.toml"]) {
      const candidate = resolve(directory, ".cargo", name);
      if (existsSync(candidate)) discovered.push(candidate);
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  if (discovered.length > 0) {
    throw new Error(`Fresh build rejects ancestor Cargo configuration: ${JSON.stringify(discovered)}`);
  }
}

function sandboxLiteral(path) {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0") || path.includes("\n") || path.includes("\r") || path.includes('"')) {
    throw new Error("Fresh build sandbox paths must be safe absolute paths.");
  }
  return JSON.stringify(path);
}

export function createPinnedFreshBuildSandboxProfile({ readPaths, writePaths, executablePaths, executableDirectories = [] }) {
  for (const values of [readPaths, writePaths, executablePaths]) {
    if (!Array.isArray(values) || values.length === 0) throw new Error("Fresh build sandbox requires explicit path sets.");
  }
  if (!Array.isArray(executableDirectories)) throw new Error("Fresh build sandbox executable directories must be an array.");
  const clauses = (operation, paths) => paths.map((path) => `  (${operation} (subpath ${sandboxLiteral(path)}))`);
  const ancestorDirectories = new Set(["/"]);
  for (const path of [...readPaths, ...writePaths, ...executablePaths, ...executableDirectories]) {
    sandboxLiteral(path);
    let ancestor = dirname(path);
    while (true) {
      ancestorDirectories.add(ancestor);
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
  }
  return [
    "(version 1)",
    "(deny default)",
    "(deny network*)",
    "(allow process*)",
    "(deny process-exec)",
    "(allow signal (target self))",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow file-read-metadata)",
    ...[...ancestorDirectories].sort().map((path) => `  (allow file-read-data (literal ${sandboxLiteral(path)}))`),
    ...clauses("allow file-read*", readPaths),
    ...clauses("allow file-write*", writePaths),
    ...executablePaths.map((path) => `  (allow process-exec (literal ${sandboxLiteral(path)}))`),
    ...executableDirectories.map((path) => `  (allow process-exec (subpath ${sandboxLiteral(path)}))`),
    "",
  ].join("\n");
}

export async function inventoryRegularArtifactTree({
  root,
  label,
  allowContainedSymlinks = false,
  recordSymlinks = false,
  allowHardlinks = false,
  allowExternalCopySourceHardlinks = false,
}) {
  if (typeof root !== "string" || !isAbsolute(root) || typeof label !== "string" || label === "") {
    throw new Error("Artifact inventory requires an absolute root and non-empty label.");
  }
  const rootLinkDetails = await lstat(root);
  if (allowExternalCopySourceHardlinks
    && (allowHardlinks || allowContainedSymlinks || recordSymlinks || !rootLinkDetails.isFile())) {
    throw new Error(`External hardlink copy authority requires one exact regular source file: ${label}`);
  }
  if (rootLinkDetails.isSymbolicLink() && !allowContainedSymlinks && !recordSymlinks) {
    throw new Error(`Runtime artifact tree contains a symbolic link: ${label}`);
  }
  const rootPath = await realpath(root);
  const sealedHardlinkRoots = [
    "/bin", "/sbin", "/usr/bin", "/usr/lib", "/usr/sbin", "/System",
    "/Applications/Xcode.app/Contents/Developer",
  ];
  const sealedHardlinkAuthority = sealedHardlinkRoots.some((authorityRoot) => (
    rootPath === authorityRoot || rootPath.startsWith(`${authorityRoot}${sep}`)
  ));
  if (allowHardlinks && !sealedHardlinkAuthority) {
    throw new Error(`Hardlink inventory authority is restricted to sealed system and Xcode inputs: ${label}`);
  }
  const artifacts = [];
  const visit = async (path, artifactLabel, ancestorDirectories = new Set()) => {
    const linkDetails = await lstat(path);
    if (linkDetails.isSymbolicLink() && recordSymlinks) {
      const target = await readlink(path);
      const resolvedTarget = resolve(dirname(path), target);
      const targetRelative = relative(rootPath, resolvedTarget);
      if (isAbsolute(target) || targetRelative === ".." || targetRelative.startsWith(`..${sep}`) || isAbsolute(targetRelative)) {
        throw new Error(`Runtime artifact symlink escapes its declared root: ${artifactLabel}`);
      }
      const content = Buffer.from(target);
      artifacts.push({
        file: artifactLabel,
        bytes: content.byteLength,
        sha256: createHash("sha256").update(content).digest("hex"),
        symlink: true,
      });
      return;
    }
    if (linkDetails.isSymbolicLink() && !allowContainedSymlinks) {
      throw new Error(`Runtime artifact tree contains a symbolic link: ${artifactLabel}`);
    }
    const resolvedPath = await realpath(path);
    const resolvedRelative = relative(rootPath, resolvedPath);
    if (resolvedRelative === ".." || resolvedRelative.startsWith(`..${sep}`) || isAbsolute(resolvedRelative)) {
      throw new Error(`Runtime artifact escapes its declared root: ${artifactLabel}`);
    }
    const details = linkDetails.isSymbolicLink() ? await stat(path) : linkDetails;
    if (details.isDirectory()) {
      const directoryIdentity = `${details.dev}:${details.ino}`;
      if (ancestorDirectories.has(directoryIdentity)) {
        throw new Error(`Runtime artifact tree contains a directory cycle: ${artifactLabel}`);
      }
      const descendants = new Set(ancestorDirectories);
      descendants.add(directoryIdentity);
      for (const name of (await readdir(path)).sort()) {
        await visit(`${path}${sep}${name}`, `${artifactLabel}/${name}`, descendants);
      }
      return;
    }
    if (!details.isFile()) {
      throw new Error(`Runtime artifact is not a regular file: ${artifactLabel}`);
    }
    if (allowHardlinks && (details.uid !== 0 || (details.mode & 0o022) !== 0)) {
      throw new Error(`Hardlink inventory authority requires root-owned non-writable inputs: ${artifactLabel}`);
    }
    if (!allowHardlinks && !allowExternalCopySourceHardlinks && details.nlink !== 1) {
      throw new Error(`Runtime artifact tree contains a multiply-linked regular file: ${artifactLabel}`);
    }
    const content = await readFile(path);
    const finalLinkDetails = await lstat(path);
    const finalDetails = finalLinkDetails.isSymbolicLink() ? await stat(path) : finalLinkDetails;
    const finalResolvedPath = await realpath(path);
    if (finalLinkDetails.dev !== linkDetails.dev
      || finalLinkDetails.ino !== linkDetails.ino
      || finalLinkDetails.isSymbolicLink() !== linkDetails.isSymbolicLink()
      || finalDetails.dev !== details.dev
      || finalDetails.ino !== details.ino
      || finalDetails.size !== details.size
      || finalDetails.mtimeMs !== details.mtimeMs
      || finalDetails.ctimeMs !== details.ctimeMs
      || finalDetails.uid !== details.uid
      || finalDetails.gid !== details.gid
      || finalDetails.mode !== details.mode
      || finalDetails.nlink !== details.nlink
      || (!allowHardlinks && !allowExternalCopySourceHardlinks && finalDetails.nlink !== 1)
      || finalResolvedPath !== resolvedPath) {
      throw new Error(`Runtime artifact changed while it was inventoried: ${artifactLabel}`);
    }
    artifacts.push({
      file: artifactLabel,
      bytes: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  };
  await visit(root, label);
  return artifacts.sort((left, right) => left.file.localeCompare(right.file));
}

export function parseOtoolLibraryDependencySections(output, executable) {
  if (typeof output !== "string" || output.includes("\0")
    || typeof executable !== "string" || !isAbsolute(executable)) {
    throw new Error("otool library parsing requires text output and an absolute executable path.");
  }
  const lines = output.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) throw new Error(`otool -L returned no sections for ${executable}`);
  let sectionMode;
  let activeSection = false;
  const architectures = new Set();
  const sections = [];
  let activeDependencies;
  let seenDependencies;
  for (const line of lines) {
    if (line === "") throw new Error(`otool -L returned an empty line inside a section for ${executable}`);
    if (!line.startsWith(" ") && !line.startsWith("\t")) {
      let architecture = null;
      if (line === `${executable}:`) {
        architecture = undefined;
      } else {
        const prefix = `${executable} (architecture `;
        const alternatePrefix = `${executable} (for architecture `;
        const selectedPrefix = line.startsWith(prefix) ? prefix : line.startsWith(alternatePrefix) ? alternatePrefix : undefined;
        if (!selectedPrefix || !line.endsWith("):") || line.length <= selectedPrefix.length + 2) {
          throw new Error(`Malformed otool -L section header for ${executable}: ${line}`);
        }
        architecture = line.slice(selectedPrefix.length, -2);
        if (!/^[A-Za-z0-9_]+$/.test(architecture) || architectures.has(architecture)) {
          throw new Error(`Invalid or duplicate otool -L architecture for ${executable}: ${architecture}`);
        }
      }
      const nextMode = architecture === undefined ? "thin" : "fat";
      if (sectionMode !== undefined && sectionMode !== nextMode) {
        throw new Error(`otool -L mixed thin and architecture sections for ${executable}`);
      }
      if (sectionMode === "thin") {
        throw new Error(`otool -L returned duplicate thin sections for ${executable}`);
      }
      sectionMode = nextMode;
      if (architecture !== undefined) architectures.add(architecture);
      activeDependencies = [];
      seenDependencies = new Set();
      sections.push({ architecture: architecture ?? null, dependencies: activeDependencies });
      activeSection = true;
      continue;
    }
    if (!activeSection) throw new Error(`otool -L returned a dependency before its section header for ${executable}`);
    const match = line.match(/^[ \t]+(.+) \(compatibility version [^(),\n]+, current version [^(),\n]+(?:, [^()\n]+)*\)$/);
    const dependency = match?.[1];
    if (!dependency || dependency.trim() !== dependency) {
      throw new Error(`Malformed otool -L dependency for ${executable}: ${line}`);
    }
    if (!seenDependencies.has(dependency)) {
      seenDependencies.add(dependency);
      activeDependencies.push(dependency);
    } else {
      throw new Error(`Duplicate otool -L dependency within one architecture for ${executable}: ${dependency}`);
    }
  }
  if (!activeSection) throw new Error(`otool -L returned no valid sections for ${executable}`);
  return sections;
}

export function resolvePinnedXcodeTool(name, { xcrunPath = "/usr/bin/xcrun", timeoutMs = 30_000 } = {}) {
  if (!/^[a-z_]+$/.test(name) || xcrunPath !== "/usr/bin/xcrun") {
    throw new Error("Pinned Xcode tool resolution requires fixed xcrun and one literal tool name.");
  }
  const selected = execFileSync(xcrunPath, ["--find", name], {
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    encoding: "utf8",
    timeout: typeof timeoutMs === "function" ? timeoutMs() : timeoutMs,
  }).trim();
  if (!isAbsolute(selected)) throw new Error(`Fixed xcrun returned a non-absolute Xcode tool: ${name}`);
  const resolved = realpathSync(selected);
  const details = lstatSync(resolved);
  if (!details.isFile() || details.isSymbolicLink() || !resolved.includes("/Contents/Developer/")) {
    throw new Error(`Fixed xcrun did not resolve an exact Xcode tool implementation: ${name}`);
  }
  return resolved;
}

export function captureExactRegularFileIdentity(path) {
  if (!isAbsolute(path)) throw new Error("Exact file identity requires an absolute path.");
  const details = lstatSync(path, { bigint: true });
  const expectedResolved = join(realpathSync(dirname(path)), basename(path));
  if (!details.isFile() || details.isSymbolicLink() || realpathSync(path) !== expectedResolved) {
    throw new Error(`Path is not one exact regular file: ${path}`);
  }
  return {
    dev: details.dev, ino: details.ino, size: details.size,
    mtimeNs: details.mtimeNs, ctimeNs: details.ctimeNs,
  };
}

export function requireExactSealedMachOSections({ sourceSections, sealedSections, sourceId, targetNames, targetName }) {
  if (!Array.isArray(sourceSections) || sourceSections.length === 0 || !Array.isArray(sealedSections)
    || !(targetNames instanceof Set) || typeof targetName !== "string"
    || sourceSections.length !== sealedSections.length
    || JSON.stringify(sourceSections.map((section) => section.architecture))
      !== JSON.stringify(sealedSections.map((section) => section.architecture))) {
    throw new Error("Sealed Mach-O validation requires matching architecture inventories.");
  }
  const expectedId = sourceId === null ? null : `@loader_path/${targetName}`;
  const transform = (dependency) => {
    if (dependency === sourceId) return expectedId;
    if (dependency.startsWith("/System/Library/") || dependency.startsWith("/usr/lib/")) return dependency;
    const name = basename(dependency);
    if (!targetNames.has(name)) throw new Error(`Private Mach-O runtime omitted an authenticated dependency copy: ${dependency}`);
    return `@loader_path/${name}`;
  };
  for (let index = 0; index < sourceSections.length; index += 1) {
    const expected = sourceSections[index].dependencies.map(transform);
    const observed = sealedSections[index].dependencies;
    if (JSON.stringify(observed) !== JSON.stringify(expected)
      || new Set(observed).size !== observed.length) {
      throw new Error(`Sealed Mach-O dependency inventory differs from its authenticated source architecture: ${targetName}`);
    }
  }
  return expectedId;
}

export function authenticateSealedMachOPayload(sourceBytes, sealedBytes, { requirePrivateRewrite = false } = {}) {
  if (!Buffer.isBuffer(sourceBytes) || !Buffer.isBuffer(sealedBytes)) {
    throw new Error("Mach-O payload authentication requires source and sealed bytes.");
  }
  const slices = (bytes) => {
    if (bytes.length < 4) throw new Error("Mach-O payload is truncated.");
    const fatMagic = bytes.readUInt32BE(0);
    if (fatMagic !== 0xcafebabe && fatMagic !== 0xcafebabf) return [{ key: "thin", bytes, fatAuthority: null }];
    if (bytes.length < 8) throw new Error("Fat Mach-O header is truncated.");
    const count = bytes.readUInt32BE(4);
    const is64 = fatMagic === 0xcafebabf;
    const entrySize = is64 ? 32 : 20;
    if (count === 0 || count > 32 || 8 + count * entrySize > bytes.length) throw new Error("Fat Mach-O architecture table is invalid.");
    const result = [];
    for (let index = 0; index < count; index += 1) {
      const entry = 8 + index * entrySize;
      const cpu = bytes.readUInt32BE(entry);
      const subtype = bytes.readUInt32BE(entry + 4);
      const offset = is64 ? Number(bytes.readBigUInt64BE(entry + 8)) : bytes.readUInt32BE(entry + 8);
      const size = is64 ? Number(bytes.readBigUInt64BE(entry + 16)) : bytes.readUInt32BE(entry + 12);
      const align = bytes.readUInt32BE(entry + (is64 ? 24 : 16));
      const reserved = is64 ? bytes.readUInt32BE(entry + 28) : null;
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || size < 28 || offset + size > bytes.length) {
        throw new Error("Fat Mach-O slice bounds are invalid.");
      }
      if (align > 30 || offset % (2 ** align) !== 0) throw new Error("Fat Mach-O slice alignment is invalid.");
      result.push({ key: `${cpu}:${subtype}`, bytes: bytes.subarray(offset, offset + size), fatAuthority: { cpu, subtype, align, reserved } });
    }
    return result;
  };
  const analyze = (slice) => {
    const magic = slice.readUInt32LE(0);
    const little = magic === 0xfeedface || magic === 0xfeedfacf;
    const bigMagic = slice.readUInt32BE(0);
    const big = bigMagic === 0xfeedface || bigMagic === 0xfeedfacf;
    if (!little && !big) throw new Error("Unsupported Mach-O slice magic.");
    const read32 = little ? (offset) => slice.readUInt32LE(offset) : (offset) => slice.readUInt32BE(offset);
    const is64 = (little ? magic : bigMagic) === 0xfeedfacf;
    const headerSize = is64 ? 32 : 28;
    const commands = read32(16);
    const commandBytes = read32(20);
    const commandEnd = headerSize + commandBytes;
    if (commands > 4096 || commandEnd > slice.length) throw new Error("Mach-O load-command inventory is invalid.");
    let cursor = headerSize;
    let signatureOffset = slice.length;
    const immutableSegments = [];
    const commandRecords = [];
    let firstSectionOffset = slice.length;
    let linkedit = null;
    for (let index = 0; index < commands; index += 1) {
      if (cursor + 8 > commandEnd) throw new Error("Mach-O load command is truncated.");
      const command = read32(cursor);
      const size = read32(cursor + 4);
      if (size < 8 || cursor + size > commandEnd) throw new Error("Mach-O load command size is invalid.");
      if (command === 0x1d) {
        if (size < 16 || signatureOffset !== slice.length) throw new Error("Mach-O code-signature command is invalid or duplicated.");
        signatureOffset = read32(cursor + 8);
        const signatureSize = read32(cursor + 12);
        if (signatureOffset < commandEnd || signatureOffset + signatureSize > slice.length) {
          throw new Error("Mach-O code-signature bounds are invalid.");
        }
      }
      if (command === (is64 ? 0x19 : 0x1)) {
        const name = slice.subarray(cursor + 8, cursor + 24).toString("ascii").replace(/\0.*$/, "");
        const fileOffset = is64 ? Number(little ? slice.readBigUInt64LE(cursor + 40) : slice.readBigUInt64BE(cursor + 40)) : read32(cursor + 32);
        const fileSize = is64 ? Number(little ? slice.readBigUInt64LE(cursor + 48) : slice.readBigUInt64BE(cursor + 48)) : read32(cursor + 36);
        if (!Number.isSafeInteger(fileOffset) || !Number.isSafeInteger(fileSize) || fileOffset + fileSize > slice.length) {
          throw new Error("Mach-O segment bounds are invalid.");
        }
        const sectionCountOffset = cursor + (is64 ? 64 : 48);
        const sectionsOffset = cursor + (is64 ? 72 : 56);
        const sectionSize = is64 ? 80 : 68;
        if (sectionCountOffset + 4 > cursor + size) throw new Error("Mach-O segment command is truncated.");
        const sectionCount = read32(sectionCountOffset);
        if (sectionCount > 4096 || sectionsOffset + sectionCount * sectionSize > cursor + size) {
          throw new Error("Mach-O section inventory is invalid.");
        }
        for (let sectionIndex = 0; sectionIndex < sectionCount; sectionIndex += 1) {
          const sectionOffset = read32(sectionsOffset + sectionIndex * sectionSize + (is64 ? 48 : 40));
          if (sectionOffset > 0) firstSectionOffset = Math.min(firstSectionOffset, sectionOffset);
        }
        if (name === "__LINKEDIT") {
          if (linkedit !== null) throw new Error("Mach-O contains duplicate __LINKEDIT segments.");
          linkedit = { fileOffset, fileSize };
        } else if (fileSize > 0) immutableSegments.push({ name, fileOffset, fileSize });
      }
      commandRecords.push({ command, size, bytes: Buffer.from(slice.subarray(cursor, cursor + size)) });
      cursor += size;
    }
    if (cursor !== commandEnd) throw new Error("Mach-O load-command sizes do not match their header.");
    if (firstSectionOffset === slice.length || commandEnd > firstSectionOffset) {
      throw new Error("Mach-O load commands overlap or lack an authenticated first section boundary.");
    }
    if (linkedit === null || linkedit.fileOffset > signatureOffset
      || signatureOffset > linkedit.fileOffset + linkedit.fileSize) {
      throw new Error("Mach-O __LINKEDIT does not contain its authenticated code-signature boundary.");
    }
    if (immutableSegments.length === 0) throw new Error("Mach-O contains no immutable program segments.");
    return {
      headerPrefix: Buffer.from(slice.subarray(0, 16)),
      headerSuffix: Buffer.from(slice.subarray(24, headerSize)),
      cpu: read32(4),
      little,
      ncmds: commands,
      sizeofcmds: commandBytes,
      commandEnd,
      firstSectionOffset,
      signatureOffset,
      linkedit,
      commands: commandRecords,
      signatureEnd: signatureOffset === slice.length ? slice.length : (() => {
        const signature = commandRecords.find(({ command }) => command === 0x1d)?.bytes;
        if (!signature) return slice.length;
        const readCommand32 = little ? (offset) => signature.readUInt32LE(offset) : (offset) => signature.readUInt32BE(offset);
        return readCommand32(8) + readCommand32(12);
      })(),
      payload: immutableSegments.map(({ name, fileOffset, fileSize }) => ({
        name, fileOffset, fileSize, commandEnd,
        bytes: slice.subarray(fileOffset, fileOffset + fileSize),
      })),
    };
  };
  const sourceSlices = slices(sourceBytes);
  const sealedSlices = slices(sealedBytes);
  if (JSON.stringify(sourceSlices.map(({ key }) => key)) !== JSON.stringify(sealedSlices.map(({ key }) => key))) {
    throw new Error("Sealed Mach-O architecture vector differs from its authenticated source.");
  }
  if (sourceSlices.some((slice, index) => JSON.stringify(slice.fatAuthority) !== JSON.stringify(sealedSlices[index].fatAuthority))) {
    throw new Error("Sealed fat Mach-O architecture authority differs from its authenticated source.");
  }
  for (let index = 0; index < sourceSlices.length; index += 1) {
    const sourceAnalysis = analyze(sourceSlices[index].bytes);
    const sealedAnalysis = analyze(sealedSlices[index].bytes);
    if (!sourceAnalysis.headerPrefix.equals(sealedAnalysis.headerPrefix)
      || !sourceAnalysis.headerSuffix.equals(sealedAnalysis.headerSuffix)
      || sourceAnalysis.ncmds !== sealedAnalysis.ncmds
      || sourceAnalysis.firstSectionOffset !== sealedAnalysis.firstSectionOffset) {
      throw new Error(`Sealed Mach-O fixed header differs from its authenticated source architecture: ${sourceSlices[index].key}`);
    }
    if (sealedAnalysis.commandEnd > sourceAnalysis.firstSectionOffset
      || sealedSlices[index].bytes.subarray(sealedAnalysis.commandEnd, sourceAnalysis.firstSectionOffset).some((byte) => byte !== 0)) {
      throw new Error(`Sealed Mach-O command region exceeds or hides bytes before its authenticated first section: ${sourceSlices[index].key}`);
    }
    if (sourceAnalysis.linkedit.fileOffset !== sealedAnalysis.linkedit.fileOffset
      || sourceAnalysis.signatureOffset !== sealedAnalysis.signatureOffset
      || !sourceSlices[index].bytes.subarray(sourceAnalysis.linkedit.fileOffset, sourceAnalysis.signatureOffset)
        .equals(sealedSlices[index].bytes.subarray(sealedAnalysis.linkedit.fileOffset, sealedAnalysis.signatureOffset))) {
      throw new Error(`Sealed Mach-O __LINKEDIT semantic payload differs from its authenticated source architecture: ${sourceSlices[index].key}`);
    }
    const codeSignature = 0x1d;
    const sourceCommands = sourceAnalysis.commands;
    const sealedCommands = sealedAnalysis.commands;
    if (sourceCommands.length !== sealedCommands.length
      || sourceCommands.some(({ command }, commandIndex) => command !== sealedCommands[commandIndex]?.command)) {
      throw new Error(`Sealed Mach-O load-command vector differs from its authenticated source architecture: ${sourceSlices[index].key}`);
    }
    const dylibCommands = new Set([0xc, 0xd, 0x18, 0x80000018, 0x1f, 0x8000001f, 0x20, 0x80000020, 0x23, 0x80000023]);
    const dylibMutation = sourceCommands.some((sourceCommand, commandIndex) => dylibCommands.has(sourceCommand.command)
      && !sourceCommand.bytes.equals(sealedCommands[commandIndex].bytes));
    for (let commandIndex = 0; commandIndex < sourceCommands.length; commandIndex += 1) {
      const sourceCommand = sourceCommands[commandIndex];
      const sealedCommand = sealedCommands[commandIndex];
      if (sourceCommand.command === codeSignature) {
        if (sourceCommand.bytes.length !== 16 || sealedCommand.bytes.length !== 16
          || !sourceCommand.bytes.subarray(0, 8).equals(sealedCommand.bytes.subarray(0, 8))) {
          throw new Error(`Sealed Mach-O code-signature command authority differs from authenticated source: ${sourceSlices[index].key}`);
        }
        continue;
      }
      if (dylibCommands.has(sourceCommand.command)) {
        if (sourceCommand.bytes.length < 25 || sealedCommand.bytes.length < 25) {
          throw new Error(`Sealed Mach-O dylib command metadata differs from authenticated source: ${sourceSlices[index].key}`);
        }
        const readCommand32 = sourceAnalysis.little
          ? (buffer, offset) => buffer.readUInt32LE(offset)
          : (buffer, offset) => buffer.readUInt32BE(offset);
        const sourceNameOffset = readCommand32(sourceCommand.bytes, 8);
        const sealedNameOffset = readCommand32(sealedCommand.bytes, 8);
        if (sourceNameOffset !== sealedNameOffset || sourceNameOffset < 24
          || sourceNameOffset >= sourceCommand.bytes.length
          || sealedNameOffset >= sealedCommand.bytes.length
          || !sourceCommand.bytes.subarray(0, 4).equals(sealedCommand.bytes.subarray(0, 4))
          || !sourceCommand.bytes.subarray(8, sourceNameOffset).equals(sealedCommand.bytes.subarray(8, sealedNameOffset))) {
          throw new Error(`Sealed Mach-O dylib command metadata differs from authenticated source: ${sourceSlices[index].key}`);
        }
        const readName = (bytes, offset) => {
          const terminator = bytes.indexOf(0, offset);
          if (terminator < 0) throw new Error("Mach-O dylib install name is not NUL-terminated inside its authenticated command slot.");
          return { value: bytes.subarray(offset, terminator).toString("utf8"), terminator };
        };
        const sourceName = readName(sourceCommand.bytes, sourceNameOffset);
        const sealedName = readName(sealedCommand.bytes, sealedNameOffset);
        const expectedName = !requirePrivateRewrite || sourceName.value.startsWith("/System/Library/") || sourceName.value.startsWith("/usr/lib/")
          ? sourceName.value : `@loader_path/${basename(sourceName.value)}`;
        const expectedSize = Math.ceil((sealedNameOffset + Buffer.byteLength(expectedName, "utf8") + 1) / 8) * 8;
        if (sealedName.value !== expectedName
          || sealedCommand.size !== expectedSize
          || sealedCommand.bytes.subarray(sealedName.terminator + 1).some((byte) => byte !== 0)) {
          throw new Error(`Sealed Mach-O dylib install name differs from authenticated transformation authority: ${sourceSlices[index].key}`);
        }
        continue;
      }
      if (sourceCommand.command === 0x19) {
        const segmentName = sourceCommand.bytes.subarray(8, 24).toString("ascii").replace(/\0.*$/, "");
        if (segmentName === "__LINKEDIT") {
          if (sourceCommand.bytes.length !== sealedCommand.bytes.length) throw new Error("Sealed __LINKEDIT command size changed.");
          const read64 = sealedAnalysis.little
            ? (buffer, offset) => buffer.readBigUInt64LE(offset)
            : (buffer, offset) => buffer.readBigUInt64BE(offset);
          const sourceVmAddress = read64(sourceCommand.bytes, 24);
          const sealedVmAddress = read64(sealedCommand.bytes, 24);
          const sourceFileOffset = read64(sourceCommand.bytes, 40);
          const sealedFileOffset = read64(sealedCommand.bytes, 40);
          if (sourceVmAddress !== sealedVmAddress || sourceFileOffset !== sealedFileOffset) {
            throw new Error(`Sealed __LINKEDIT address authority differs from authenticated source: ${sourceSlices[index].key}`);
          }
          const sealedFileSize = read64(sealedCommand.bytes, 48);
          const sealedVmSize = read64(sealedCommand.bytes, 32);
          const sourceFileSize = read64(sourceCommand.bytes, 48);
          const sourceVmSize = read64(sourceCommand.bytes, 32);
          const expectedFileSize = BigInt(sealedAnalysis.signatureEnd) - sealedFileOffset;
          const pageSize = sealedAnalysis.cpu === 0x0100000c ? 16384n
            : sealedAnalysis.cpu === 0x01000007 ? 4096n : 0n;
          const sourceAlignedSize = pageSize === 0n ? 0n : ((sourceFileSize + pageSize - 1n) / pageSize) * pageSize;
          const authenticatedVmSlack = sourceVmSize - sourceAlignedSize;
          const expectedVmSize = pageSize === 0n ? 0n : dylibMutation
            ? ((expectedFileSize + pageSize - 1n) / pageSize) * pageSize
            : sourceVmSize;
          if (pageSize === 0n || expectedFileSize < 0n || sealedFileSize !== expectedFileSize
            || authenticatedVmSlack < 0n || authenticatedVmSlack % pageSize !== 0n
            || sealedVmSize !== expectedVmSize) {
            throw new Error(`Sealed __LINKEDIT sizes do not match authenticated signature and architecture authority: ${sourceSlices[index].key} ${[
              sourceFileSize, sourceVmSize, authenticatedVmSlack, sealedFileSize, expectedFileSize, sealedVmSize, expectedVmSize,
            ].map(String).join(":")}`);
          }
          const left = Buffer.from(sourceCommand.bytes);
          const right = Buffer.from(sealedCommand.bytes);
          for (const [offset, length] of [[32, 8], [48, 8]]) {
            left.fill(0, offset, offset + length);
            right.fill(0, offset, offset + length);
          }
          if (!left.equals(right)) throw new Error(`Sealed __LINKEDIT authority differs from authenticated source: ${sourceSlices[index].key}`);
          continue;
        }
      }
      if (!sourceCommand.bytes.equals(sealedCommand.bytes)) {
        throw new Error(`Sealed Mach-O load command differs from authenticated source: ${sourceSlices[index].key}`);
      }
    }
    const sourcePayload = sourceAnalysis.payload;
    const sealedPayload = sealedAnalysis.payload;
    if (JSON.stringify(sourcePayload.map(({ name, fileOffset, fileSize }) => [name, fileOffset, fileSize]))
        !== JSON.stringify(sealedPayload.map(({ name, fileOffset, fileSize }) => [name, fileOffset, fileSize]))
      || sourcePayload.some((sourceSegment, payloadIndex) => {
        const sealedSegment = sealedPayload[payloadIndex];
        const start = sourceSegment.name === "__TEXT"
          ? sourceAnalysis.firstSectionOffset - sourceSegment.fileOffset
          : 0;
        return !sourceSegment.bytes.subarray(start).equals(sealedSegment.bytes.subarray(start));
      })) {
      throw new Error(`Sealed Mach-O content payload differs from its authenticated source architecture: ${sourceSlices[index].key}`);
    }
  }
}

export function requireIdenticalMachODependencySlices(sections, resolveDependency) {
  if (!Array.isArray(sections) || sections.length === 0 || typeof resolveDependency !== "function") {
    throw new Error("Mach-O slice validation requires dependency sections and a resolver.");
  }
  const canonicalDependencies = [...sections[0].dependencies].sort();
  const resolvedSections = sections.map((section) => {
    const dependencies = [...section.dependencies].sort();
    if (JSON.stringify(dependencies) !== JSON.stringify(canonicalDependencies)) {
      throw new Error("Universal Mach-O slices have different dependency install-name sets.");
    }
    return dependencies.map((dependency) => {
      const authority = resolveDependency(dependency, section.architecture);
      if (!authority || typeof authority !== "object"
        || typeof authority.system !== "boolean"
        || authority.name !== basename(dependency)
        || typeof authority.source !== "string" || !isAbsolute(authority.source)
        || (authority.system ? authority.sha256 !== null : !/^[a-f0-9]{64}$/.test(authority.sha256 ?? ""))) {
        throw new Error(`Mach-O slice resolver returned incomplete basename, source, or digest authority: ${dependency}`);
      }
      return { dependency, ...authority };
    });
  });
  const canonicalResolution = JSON.stringify(resolvedSections[0]);
  if (resolvedSections.some((resolved) => JSON.stringify(resolved) !== canonicalResolution)) {
    throw new Error("Universal Mach-O slices resolve a dependency to different runtime authority.");
  }
  return resolvedSections[0];
}

export function parseOtoolLibraryDependencies(output, executable) {
  const sections = parseOtoolLibraryDependencySections(output, executable);
  const canonical = [...sections[0].dependencies].sort();
  if (sections.some((section) => JSON.stringify([...section.dependencies].sort()) !== JSON.stringify(canonical))) {
    throw new Error("Universal Mach-O slices have different dependency install-name sets.");
  }
  return canonical;
}

export function parseOtoolRpaths(output, executable) {
  if (typeof output !== "string" || output.includes("\0") || typeof executable !== "string" || !isAbsolute(executable)) {
    throw new Error("otool load-command parsing requires text output and an absolute executable path.");
  }
  const lines = output.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.shift() !== `${executable}:`) {
    throw new Error(`otool -l returned an unexpected executable header for ${executable}`);
  }
  const rpaths = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== "cmd LC_RPATH") continue;
    let path;
    for (let cursor = index + 1; cursor < lines.length && !/^Load command \d+$/.test(lines[cursor]); cursor += 1) {
      const match = lines[cursor].match(/^\s*path (\S+) \(offset \d+\)$/);
      if (match) {
        if (path !== undefined) throw new Error(`otool -l returned multiple paths for one LC_RPATH in ${executable}`);
        path = match[1];
      }
    }
    if (path === undefined) throw new Error(`otool -l returned LC_RPATH without a structural path for ${executable}`);
    rpaths.push(path);
  }
  return rpaths;
}

export function parseOtoolDylibId(output, executable) {
  if (typeof output !== "string" || output.includes("\0") || typeof executable !== "string" || !isAbsolute(executable)) {
    throw new Error("otool dylib-ID parsing requires text output and an absolute executable path.");
  }
  const lines = output.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.shift() !== `${executable}:` || lines.length > 1
    || (lines.length === 1 && (lines[0] === "" || lines[0].trim() !== lines[0]))) {
    throw new Error(`otool -D returned a malformed dylib ID for ${executable}`);
  }
  return lines[0] ?? null;
}

export function authenticateMachODylibIdSlices({ sections, dylibIds, expectedSource, expectedSha256, resolveId }) {
  if (!Array.isArray(sections) || sections.length === 0 || !Array.isArray(dylibIds)
    || dylibIds.length !== sections.length || !isAbsolute(expectedSource)
    || !/^[a-f0-9]{64}$/.test(expectedSha256 ?? "") || typeof resolveId !== "function") {
    throw new Error("Mach-O dylib-ID authentication requires complete slice and expected-image authority.");
  }
  if (dylibIds.every((id) => id === null)) return null;
  if (dylibIds.some((id) => typeof id !== "string" || id === "")
    || dylibIds.some((id) => id !== dylibIds[0])) {
    throw new Error("Universal Mach-O slices have missing or different LC_ID_DYLIB authority.");
  }
  const dylibId = dylibIds[0];
  const canonicalExpectedSource = realpathSync(expectedSource);
  const authorities = sections.map((section, index) => {
    if (!section.dependencies.includes(dylibIds[index])) {
      throw new Error("Mach-O LC_ID_DYLIB is not present in its architecture dependency records.");
    }
    return resolveId(dylibIds[index], section.architecture);
  });
  if (authorities.some((authority) => !authority || realpathSync(authority.source) !== canonicalExpectedSource
    || authority.sha256 !== expectedSha256)
    || authorities.some((authority) => authority.source !== authorities[0].source
      || authority.sha256 !== authorities[0].sha256)) {
    throw new Error(`Mach-O LC_ID_DYLIB does not resolve to the authenticated image: ${expectedSource}`);
  }
  return dylibId;
}

export function expandMachORuntimePath(path, { loaderPath, executablePath }) {
  if (typeof path !== "string" || path === "" || path.includes("\0")
    || typeof loaderPath !== "string" || !isAbsolute(loaderPath)
    || typeof executablePath !== "string" || !isAbsolute(executablePath)) {
    throw new Error("Mach-O runtime path expansion requires exact absolute loader and executable paths.");
  }
  if (isAbsolute(path)) return resolve(path);
  for (const [anchor, root] of [["@loader_path", dirname(loaderPath)], ["@executable_path", dirname(executablePath)]]) {
    if (path === anchor) return root;
    if (path.startsWith(`${anchor}/`)) return resolve(root, path.slice(anchor.length + 1));
  }
  throw new Error(`Unsupported relative Mach-O runtime path: ${path}`);
}

export function resolveMachORpathDependency(dependency, runpathChain, pathExists = existsSync) {
  if (typeof dependency !== "string" || !dependency.startsWith("@rpath/")
    || !Array.isArray(runpathChain) || runpathChain.some((path) => !isAbsolute(path))
    || typeof pathExists !== "function") {
    throw new Error("Mach-O @rpath resolution requires an install name and authenticated absolute run-path chain.");
  }
  const suffix = dependency.slice("@rpath/".length);
  const match = runpathChain.map((root) => resolve(root, suffix)).find(pathExists);
  if (!match) throw new Error(`Unable to resolve Mach-O @rpath dependency: ${dependency}`);
  return match;
}

export function discoverNonSystemMachODependencies({
  executables,
  dependencyRoot,
  executableDigests = new Map(),
  timeoutMs = 30_000,
  otoolPath = "/usr/bin/otool",
}) {
  if (!Array.isArray(executables) || executables.length === 0 || executables.some((path) => !isAbsolute(path))
    || (dependencyRoot !== undefined && !isAbsolute(dependencyRoot))
    || !(executableDigests instanceof Map) || !isAbsolute(otoolPath)) {
    throw new Error("Mach-O closure discovery requires absolute roots and pinned otool authority.");
  }
  const otoolDetails = lstatSync(otoolPath);
  if (!otoolDetails.isFile() || otoolDetails.isSymbolicLink() || realpathSync(otoolPath) !== otoolPath) {
    throw new Error("Mach-O closure discovery requires an exact regular pinned otool executable.");
  }
  const operationTimeout = () => typeof timeoutMs === "function" ? timeoutMs() : timeoutMs;
  const toolEnvironment = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" };
  const fileSha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const pending = executables.map((executable) => ({ executable, mainExecutable: executable, inheritedRunpaths: {} }));
  const dependencies = new Map();
  const scanned = new Set();
  const loaderPaths = (executable, mainExecutable, architecture) => parseOtoolRpaths(execFileSync(otoolPath, [
    "-l", ...(architecture ? ["-arch", architecture] : []), executable,
  ], { encoding: "utf8", env: toolEnvironment, timeout: operationTimeout() }), executable).map((path) => expandMachORuntimePath(path, {
    loaderPath: executable,
    executablePath: mainExecutable,
  }));
  const resolveDependency = (dependency, executable, mainExecutable, runpathChain) => {
    if (dependencyRoot !== undefined) {
      const copiedDependency = join(dependencyRoot, basename(dependency));
      if (existsSync(copiedDependency)) return copiedDependency;
    }
    if (dependency.startsWith("/")) return dependency;
    if (dependency.startsWith("@loader_path/") || dependency.startsWith("@executable_path/")) {
      return expandMachORuntimePath(dependency, { loaderPath: executable, executablePath: mainExecutable });
    }
    if (dependency.startsWith("@rpath/")) return resolveMachORpathDependency(dependency, runpathChain);
    throw new Error(`Unable to resolve Mach-O dependency ${dependency} for immutable evidence runtime ${executable}.`);
  };
  while (pending.length > 0) {
    const { executable, mainExecutable, inheritedRunpaths } = pending.pop();
    const resolvedExecutable = realpathSync(executable);
    const resolvedMainExecutable = realpathSync(mainExecutable);
    const scanAuthority = `${resolvedMainExecutable}\0${resolvedExecutable}\0${JSON.stringify(inheritedRunpaths)}`;
    if (scanned.has(scanAuthority)) continue;
    scanned.add(scanAuthority);
    const beforeSha256 = fileSha256(resolvedExecutable);
    const sections = parseOtoolLibraryDependencySections(execFileSync(otoolPath, ["-L", executable], {
      encoding: "utf8", env: toolEnvironment, timeout: operationTimeout(),
    }), executable);
    const dylibIds = sections.map((section) => parseOtoolDylibId(execFileSync(otoolPath, [
      "-D", ...(section.architecture ? ["-arch", section.architecture] : []), executable,
    ], { encoding: "utf8", env: toolEnvironment, timeout: operationTimeout() }), executable));
    const runpathsByArchitecture = Object.fromEntries(sections.map((section) => {
      const architecture = section.architecture ?? "thin";
      let inherited = inheritedRunpaths[architecture];
      if (inherited === undefined && section.architecture === null) {
        const inheritedChains = Object.values(inheritedRunpaths);
        if (inheritedChains.length > 0 && inheritedChains.some((chain) => JSON.stringify(chain) !== JSON.stringify(inheritedChains[0]))) {
          throw new Error(`A thin Mach-O image inherited divergent universal run-path stacks: ${resolvedExecutable}`);
        }
        inherited = inheritedChains[0];
      }
      inherited ??= inheritedRunpaths.thin ?? [];
      return [architecture, [...new Set([...loaderPaths(executable, mainExecutable, section.architecture), ...inherited])]];
    }));
    const dylibId = authenticateMachODylibIdSlices({
      sections,
      dylibIds,
      expectedSource: resolvedExecutable,
      expectedSha256: beforeSha256,
      resolveId: (id, architecture) => {
        const source = realpathSync(resolveDependency(
          id, executable, mainExecutable, runpathsByArchitecture[architecture ?? "thin"],
        ));
        return { source, sha256: fileSha256(source) };
      },
    });
    const dependencySections = sections.map((section) => ({
      ...section,
      dependencies: section.dependencies.filter((dependency) => dependency !== dylibId),
    }));
    const resolvedSlice = requireIdenticalMachODependencySlices(dependencySections, (dependency, architecture) => {
      if (dependency.startsWith("/System/Library/") || dependency.startsWith("/usr/lib/")) {
        return { system: true, source: dependency, sha256: null, name: basename(dependency) };
      }
      const resolvedDependency = realpathSync(resolveDependency(
        dependency, executable, mainExecutable, runpathsByArchitecture[architecture ?? "thin"],
      ));
      return { system: false, source: resolvedDependency, sha256: fileSha256(resolvedDependency), name: basename(dependency) };
    });
    for (const { system, source, sha256, name } of resolvedSlice) {
      if (system) continue;
      const collision = dependencies.get(name);
      if (collision && (collision.source !== source || collision.sha256 !== sha256)) {
        throw new Error(`Immutable runtime dependency basename collision: ${name}`);
      }
      if (!collision) dependencies.set(name, { source, sha256 });
      pending.push({ executable: source, mainExecutable, inheritedRunpaths: runpathsByArchitecture });
    }
    const afterSha256 = fileSha256(resolvedExecutable);
    if (beforeSha256 !== afterSha256) {
      throw new Error(`Mach-O runtime artifact changed during dependency discovery: ${resolvedExecutable}`);
    }
    executableDigests.set(resolvedExecutable, afterSha256);
  }
  return [...dependencies.entries()].sort(([left], [right]) => left.localeCompare(right));
}

export function sealMachORuntimeCopies({
  sourceSpecs,
  runtimeRoot,
  rootExecutable,
  timeoutMs = 30_000,
  otoolPath,
  installNameToolPath,
  codesignPath = "/usr/bin/codesign",
  afterInstallNameTool,
  afterCodesign,
  beforeTargetPublication,
  afterTargetPublication,
}) {
  if (!Array.isArray(sourceSpecs) || sourceSpecs.length === 0 || !isAbsolute(runtimeRoot)
    || !isAbsolute(rootExecutable) || !isAbsolute(otoolPath) || !isAbsolute(installNameToolPath)
    || codesignPath !== "/usr/bin/codesign") {
    throw new Error("Mach-O runtime sealing requires private copies and pinned mutation tools.");
  }
  const timeout = () => typeof timeoutMs === "function" ? timeoutMs() : timeoutMs;
  const toolEnvironment = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" };
  for (const tool of [otoolPath, installNameToolPath, codesignPath]) {
    const details = lstatSync(tool);
    if (!details.isFile() || details.isSymbolicLink() || realpathSync(tool) !== tool) {
      throw new Error(`Mach-O runtime sealing tool is not one exact regular executable: ${tool}`);
    }
  }
  const rootDetails = lstatSync(runtimeRoot);
  const canonicalRuntimeRoot = realpathSync(runtimeRoot);
  if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) {
    throw new Error("Mach-O runtime sealing requires an exact private runtime root.");
  }
  const identity = captureExactRegularFileIdentity;
  const sameIdentity = (left, right, includeMutationFields = true) => left.dev === right.dev && left.ino === right.ino
    && (!includeMutationFields || (left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs));
  const assertIdentity = (path, expected, includeMutationFields = true) => {
    const observed = identity(path);
    if (!sameIdentity(observed, expected, includeMutationFields)) {
      throw new Error(`Mach-O runtime sealing target changed during mutation: ${path}`);
    }
    return observed;
  };
  const pathMatchesFd = (path, fd, expected) => {
    const descriptor = fstatSync(fd, { bigint: true });
    const pathDetails = lstatSync(path, { bigint: true });
    if (!descriptor.isFile() || !pathDetails.isFile() || pathDetails.isSymbolicLink()
      || descriptor.dev !== pathDetails.dev || descriptor.ino !== pathDetails.ino
      || (expected && !sameIdentity(descriptor, expected))) {
      throw new Error(`Mach-O runtime sealing path no longer resolves to its held file: ${path}`);
    }
    return descriptor;
  };
  const writeAll = (fd, bytes) => {
    ftruncateSync(fd, 0);
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset, offset);
    fsyncSync(fd);
  };
  const readAll = (fd) => {
    const size = Number(fstatSync(fd, { bigint: true }).size);
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) offset += readSync(fd, bytes, offset, size - offset, offset);
    return bytes;
  };
  const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const targetByBasename = new Map(sourceSpecs.map((spec) => [basename(spec.target), spec.target]));
  if (targetByBasename.size !== sourceSpecs.length
    || sourceSpecs.some((spec) => !isAbsolute(spec.source) || !isAbsolute(spec.target)
      || realpathSync(dirname(spec.target)) !== canonicalRuntimeRoot)) {
    throw new Error("Mach-O runtime sealing requires unique flat targets inside the private runtime root.");
  }
  const targetStates = sourceSpecs.map((spec) => {
    const originalIdentity = assertIdentity(spec.target, spec.targetAuthority);
    const fd = openSync(spec.target, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW);
    pathMatchesFd(spec.target, fd, originalIdentity);
    return { spec, fd, originalIdentity, originalBytes: readAll(fd), originalMode: Number(fstatSync(fd, { bigint: true }).mode) & 0o777 };
  });
  try {
  for (const spec of sourceSpecs) {
    const sourceDetails = lstatSync(spec.source);
    if (!sourceDetails.isFile() || sourceDetails.isSymbolicLink() || realpathSync(spec.source) !== spec.source) {
      throw new Error(`Mach-O runtime source is not one exact authenticated file: ${spec.source}`);
    }
    if (!/^[a-f0-9]{64}$/.test(spec.sourceSha256 ?? "") || !spec.targetAuthority
      || typeof spec.targetAuthority !== "object") {
      throw new Error(`Mach-O runtime sealing lacks captured source and target authority: ${spec.target}`);
    }
    const targetState = targetStates.find((state) => state.spec === spec);
    let targetIdentity = targetState.originalIdentity;
    const targetFd = targetState.fd;
    pathMatchesFd(spec.target, targetFd, targetIdentity);
    if (sha256(spec.source) !== spec.sourceSha256 || sha256(spec.target) !== spec.sourceSha256) {
      throw new Error(`Private Mach-O target does not match its authenticated source bytes: ${spec.target}`);
    }
    targetIdentity = assertIdentity(spec.target, targetIdentity);
    const sections = parseOtoolLibraryDependencySections(execFileSync(otoolPath, ["-L", spec.source], {
      encoding: "utf8", env: toolEnvironment, timeout: timeout(),
    }), spec.source);
    const dependencies = parseOtoolLibraryDependencies(execFileSync(otoolPath, ["-L", spec.source], {
      encoding: "utf8", env: toolEnvironment, timeout: timeout(),
    }), spec.source);
    const changes = [];
    for (const dependency of dependencies) {
      if (dependency.startsWith("/System/Library/") || dependency.startsWith("/usr/lib/")) continue;
      const target = targetByBasename.get(basename(dependency));
      if (!target) throw new Error(`Private Mach-O runtime omitted an authenticated dependency copy: ${dependency}`);
      changes.push("-change", dependency, `@loader_path/${basename(target)}`);
    }
    const ids = sections.map((section) => parseOtoolDylibId(execFileSync(otoolPath, [
      "-D", ...(section.architecture ? ["-arch", section.architecture] : []), spec.source,
    ], { encoding: "utf8", env: toolEnvironment, timeout: timeout() }), spec.source));
    if (ids.some((id) => id !== ids[0])) {
      throw new Error(`Universal Mach-O slices have different source IDs during private sealing: ${spec.source}`);
    }
    if (ids[0] !== null) changes.push("-id", `@loader_path/${basename(spec.target)}`);
    const workTarget = `${spec.target}.relayer-seal-work`;
    if (existsSync(workTarget)) throw new Error(`Mach-O sealing work target already exists: ${workTarget}`);
    let workFd;
    try {
      workFd = openSync(workTarget, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW, 0o700);
      writeAll(workFd, readFileSync(spec.target));
      let workIdentity = fstatSync(workFd, { bigint: true });
      pathMatchesFd(workTarget, workFd, workIdentity);
      if (changes.length > 0) {
        const installScratch = `${workTarget}.install`;
        const installFd = openSync(installScratch, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW, 0o700);
        writeAll(installFd, readAll(workFd));
        closeSync(installFd);
        let mutatedFd;
        try {
          execFileSync(installNameToolPath, [...changes, installScratch], { env: toolEnvironment, timeout: timeout() });
          afterInstallNameTool?.(spec.target, installScratch);
          pathMatchesFd(spec.target, targetFd, targetIdentity);
          pathMatchesFd(workTarget, workFd, workIdentity);
          mutatedFd = openSync(installScratch, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
          const mutatedIdentity = fstatSync(mutatedFd, { bigint: true });
          pathMatchesFd(installScratch, mutatedFd, mutatedIdentity);
          writeAll(workFd, readAll(mutatedFd));
          workIdentity = fstatSync(workFd, { bigint: true });
          pathMatchesFd(workTarget, workFd, workIdentity);
        } finally {
          if (mutatedFd !== undefined) {
            try {
              pathMatchesFd(installScratch, mutatedFd);
              rmSync(installScratch, { force: true });
            } finally {
              closeSync(mutatedFd);
            }
          }
        }
      }
      const signScratch = `${workTarget}.sign`;
      const signFd = openSync(signScratch, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW, 0o700);
      writeAll(signFd, readAll(workFd));
      closeSync(signFd);
      let signedFd;
      try {
        execFileSync(codesignPath, ["--force", "--sign", "-", signScratch], { env: toolEnvironment, timeout: timeout() });
        afterCodesign?.(spec.target, signScratch);
        pathMatchesFd(spec.target, targetFd, targetIdentity);
        pathMatchesFd(workTarget, workFd, workIdentity);
        signedFd = openSync(signScratch, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        const signedIdentity = fstatSync(signedFd, { bigint: true });
        pathMatchesFd(signScratch, signedFd, signedIdentity);
        execFileSync(codesignPath, ["--verify", "--strict", signScratch], { env: toolEnvironment, timeout: timeout() });
        pathMatchesFd(signScratch, signedFd, signedIdentity);
        writeAll(workFd, readAll(signedFd));
        workIdentity = fstatSync(workFd, { bigint: true });
        pathMatchesFd(workTarget, workFd, workIdentity);
      } finally {
        if (signedFd !== undefined) {
          try {
            pathMatchesFd(signScratch, signedFd);
            rmSync(signScratch, { force: true });
          } finally {
            closeSync(signedFd);
          }
        }
      }
      const workSections = parseOtoolLibraryDependencySections(execFileSync(otoolPath, ["-L", workTarget], {
        encoding: "utf8", env: toolEnvironment, timeout: timeout(),
      }), workTarget);
      const workIds = workSections.map((section) => parseOtoolDylibId(execFileSync(otoolPath, [
        "-D", ...(section.architecture ? ["-arch", section.architecture] : []), workTarget,
      ], { encoding: "utf8", env: toolEnvironment, timeout: timeout() }), workTarget));
      const expectedWorkId = requireExactSealedMachOSections({
        sourceSections: sections, sealedSections: workSections, sourceId: ids[0],
        targetNames: new Set(targetByBasename.keys()), targetName: basename(spec.target),
      });
      if (workIds.some((id) => id !== expectedWorkId)) {
        throw new Error(`Sealed Mach-O work LC_ID_DYLIB differs from authenticated source: ${spec.target}`);
      }
      pathMatchesFd(workTarget, workFd, workIdentity);
      execFileSync(codesignPath, ["--verify", "--strict", workTarget], { env: toolEnvironment, timeout: timeout() });
      pathMatchesFd(workTarget, workFd, workIdentity);
      const sealedBytes = readAll(workFd);
      authenticateSealedMachOPayload(readFileSync(spec.source), sealedBytes, { requirePrivateRewrite: true });
      beforeTargetPublication?.(spec.target);
      pathMatchesFd(spec.target, targetFd, targetIdentity);
      fchmodSync(targetFd, 0o700);
      writeAll(targetFd, sealedBytes);
      fchmodSync(targetFd, statSync(spec.source).mode & 0o111 ? 0o500 : 0o400);
      fsyncSync(targetFd);
      targetIdentity = fstatSync(targetFd, { bigint: true });
      pathMatchesFd(spec.target, targetFd, targetIdentity);
      afterTargetPublication?.(spec.target);
    } finally {
      if (workFd !== undefined) {
        try {
          pathMatchesFd(workTarget, workFd);
          rmSync(workTarget, { force: true });
        } finally {
          closeSync(workFd);
        }
      }
    }
    const sealedSections = parseOtoolLibraryDependencySections(execFileSync(otoolPath, ["-L", spec.target], {
      encoding: "utf8", env: toolEnvironment, timeout: timeout(),
    }), spec.target);
    const sealedIds = sealedSections.map((section) => parseOtoolDylibId(execFileSync(otoolPath, [
      "-D", ...(section.architecture ? ["-arch", section.architecture] : []), spec.target,
    ], { encoding: "utf8", env: toolEnvironment, timeout: timeout() }), spec.target));
    const expectedId = requireExactSealedMachOSections({
      sourceSections: sections,
      sealedSections,
      sourceId: ids[0],
      targetNames: new Set(targetByBasename.keys()),
      targetName: basename(spec.target),
    });
    if (sealedIds.some((id) => id !== expectedId)) {
      throw new Error(`Sealed Mach-O LC_ID_DYLIB escaped its private runtime: ${spec.target}`);
    }
    assertIdentity(spec.target, targetIdentity);
  }
  const closure = discoverNonSystemMachODependencies({
    executables: [rootExecutable],
    dependencyRoot: runtimeRoot,
    timeoutMs,
    otoolPath,
  });
  const expectedNames = [...targetByBasename.keys()].filter((name) => name !== basename(rootExecutable)).sort();
  if (JSON.stringify(closure.map(([name]) => name)) !== JSON.stringify(expectedNames)
    || closure.some(([, authority]) => dirname(authority.source) !== canonicalRuntimeRoot)) {
    throw new Error("Rewritten private Mach-O closure is incomplete or escapes its runtime root.");
  }
  return closure;
  } catch (error) {
    const rollbackErrors = [];
    for (const state of targetStates) {
      try {
        fchmodSync(state.fd, 0o700);
        writeAll(state.fd, state.originalBytes);
        fchmodSync(state.fd, state.originalMode);
        fsyncSync(state.fd);
        const restored = fstatSync(state.fd, { bigint: true });
        if (restored.dev !== state.originalIdentity.dev || restored.ino !== state.originalIdentity.ino
          || createHash("sha256").update(readAll(state.fd)).digest("hex")
            !== createHash("sha256").update(state.originalBytes).digest("hex")) {
          throw new Error(`Mach-O rollback did not restore its authenticated target: ${state.spec.target}`);
        }
        try { pathMatchesFd(state.spec.target, state.fd); } catch { /* A hostile substituted pathname is never modified. */ }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) throw new AggregateError([error, ...rollbackErrors], "Mach-O sealing and rollback both failed.");
    throw error;
  } finally {
    for (const state of targetStates) closeSync(state.fd);
  }
}

export function restoreDirectoryWritesSync(authorities) {
  if (!Array.isArray(authorities) || authorities.some((authority) => !authority
    || !isAbsolute(authority.path) || typeof authority.dev !== "bigint" || typeof authority.ino !== "bigint")) return false;
  const opened = [];
  try {
    for (const authority of authorities) {
      const fd = openSync(authority.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      opened.push({ fd, authority });
      const details = fstatSync(fd, { bigint: true });
      const pathDetails = lstatSync(authority.path, { bigint: true });
      const expectedResolved = join(realpathSync(dirname(authority.path)), basename(authority.path));
      if (!details.isDirectory() || details.dev !== authority.dev || details.ino !== authority.ino
        || !pathDetails.isDirectory() || pathDetails.isSymbolicLink()
        || pathDetails.dev !== authority.dev || pathDetails.ino !== authority.ino
        || realpathSync(authority.path) !== expectedResolved) return false;
    }
    for (const { fd } of opened) {
      const details = fstatSync(fd, { bigint: true });
      fchmodSync(fd, Number(details.mode) | 0o700);
    }
    return opened.every(({ fd, authority }) => {
      const details = fstatSync(fd, { bigint: true });
      return details.isDirectory() && details.dev === authority.dev && details.ino === authority.ino;
    });
  } catch {
    return false;
  } finally {
    for (const { fd } of opened) closeSync(fd);
  }
}

export function readCommittedGitBytes({ gitPath, repositoryRoot, commit, path, timeoutMs = 30_000 }) {
  if (!isFixedSystemGit(gitPath) || !isAbsolute(repositoryRoot ?? "") || !/^[a-f0-9]{40,64}$/.test(commit ?? "")
    || typeof path !== "string" || isAbsolute(path) || path.includes(":") || path.includes("\0")
    || path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("Committed Git bytes require fixed system Git and an exact commit-relative path.");
  }
  return execFileSync(gitPath, fixedGitArguments(repositoryRoot, ["show", `${commit}:${path}`]), {
    cwd: repositoryRoot,
    env: fixedGitEnvironment(),
    encoding: null,
    maxBuffer: 16 * 1024 * 1024,
    timeout: timeoutMs,
  });
}

export function readGitCommitTree({ gitPath, repositoryRoot, commit, timeoutMs = 30_000 }) {
  if (!isFixedSystemGit(gitPath) || !isAbsolute(repositoryRoot ?? "") || !/^[a-f0-9]{40,64}$/.test(commit ?? "")) {
    throw new Error("Git tree identity requires fixed system Git and an exact commit.");
  }
  const tree = execFileSync(gitPath, fixedGitArguments(repositoryRoot, ["rev-parse", `${commit}^{tree}`]), {
    cwd: repositoryRoot,
    env: fixedGitEnvironment(),
    encoding: "utf8",
    timeout: timeoutMs,
  }).trim();
  if (!/^[a-f0-9]{40,64}$/.test(tree)) throw new Error("Git returned an invalid tree identity.");
  return tree;
}

export function readCommittedGitInventory({
  gitPath,
  repositoryRoot,
  commit,
  path,
  label = path,
  timeoutMs = 30_000,
}) {
  const wholeTree = path === ".";
  if (!isFixedSystemGit(gitPath) || !isAbsolute(repositoryRoot ?? "") || !/^[a-f0-9]{40,64}$/.test(commit ?? "")
    || typeof path !== "string" || isAbsolute(path) || path.includes(":") || path.includes("\0")
    || (!wholeTree && path.split("/").some((segment) => segment === "" || segment === "." || segment === ".."))
    || typeof label !== "string" || label === "" || label.includes("\0")) {
    throw new Error("Committed Git inventory requires fixed system Git, an exact commit, and safe relative paths.");
  }
  const treeArguments = ["ls-tree", "-r", "-z", "--full-tree", commit];
  if (!wholeTree) treeArguments.push("--", path);
  const output = execFileSync(gitPath, fixedGitArguments(repositoryRoot, treeArguments), {
    cwd: repositoryRoot,
    env: fixedGitEnvironment(),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: timeoutMs,
  });
  const artifacts = [];
  for (const record of output.split("\0")) {
    if (record === "") continue;
    const match = /^(100644|100755|120000) blob ([a-f0-9]{40,64})\t(.+)$/.exec(record);
    if (!match) throw new Error(`Unsupported committed runtime tree entry: ${record}`);
    const committedPath = match[3];
    if (!wholeTree && committedPath !== path && !committedPath.startsWith(`${path}/`)) {
      throw new Error(`Git returned a runtime path outside the requested subtree: ${committedPath}`);
    }
    const bytes = readCommittedGitBytes({ gitPath, repositoryRoot, commit, path: committedPath, timeoutMs });
    const suffix = wholeTree ? committedPath : committedPath === path ? "" : committedPath.slice(path.length + 1);
    artifacts.push({
      file: suffix === "" ? label : `${label}/${suffix}`,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  if (artifacts.length === 0) throw new Error(`Committed runtime path is absent from ${commit}: ${path}`);
  return artifacts.sort((left, right) => left.file.localeCompare(right.file));
}

export function verifyRepositoryGitAuthority({
  gitPath,
  repositoryRoot,
  revisionPaths = [],
  timeoutMs = 30_000,
}) {
  if (!isFixedSystemGit(gitPath) || !isAbsolute(repositoryRoot ?? "")
    || !Array.isArray(revisionPaths)
    || revisionPaths.some((path) => typeof path !== "string" || isAbsolute(path) || path.includes("\0"))) {
    throw new Error("Repository Git authority requires fixed system Git and safe revision paths.");
  }
  let forbiddenConfig = "";
  try {
    forbiddenConfig = execFileSync(gitPath, [
      "config", "--local", "--no-includes", "--name-only", "--get-regexp",
      "^(filter\\.|core\\.attributesfile$|core\\.excludesfile$|core\\.worktree$|include\\.|includeif\\.)",
    ], {
      cwd: repositoryRoot,
      env: fixedGitEnvironment(),
      encoding: "utf8",
      timeout: timeoutMs,
    }).trim();
  } catch (error) {
    if (error?.status !== 1) throw error;
  }
  const worktreeConfigPath = execFileSync(gitPath, fixedGitArguments(repositoryRoot, [
    "rev-parse", "--git-path", "config.worktree",
  ]), {
    cwd: repositoryRoot,
    env: fixedGitEnvironment(),
    encoding: "utf8",
    timeout: timeoutMs,
  }).trim();
  const infoExcludePath = execFileSync(gitPath, fixedGitArguments(repositoryRoot, [
    "rev-parse", "--git-path", "info/exclude",
  ]), {
    cwd: repositoryRoot,
    env: fixedGitEnvironment(),
    encoding: "utf8",
    timeout: timeoutMs,
  }).trim();
  const infoExcludePatterns = existsSync(resolve(repositoryRoot, infoExcludePath))
    ? readFileSync(resolve(repositoryRoot, infoExcludePath), "utf8")
      .split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"))
    : [];
  if (forbiddenConfig !== "" || existsSync(resolve(repositoryRoot, worktreeConfigPath)) || infoExcludePatterns.length > 0) {
    throw new Error(`Repository Git authority rejects local filters, attributes, excludes, includes, and worktree redirects: ${JSON.stringify({ forbiddenConfig, worktreeConfigPath, infoExcludePatterns })}`);
  }
  if (revisionPaths.length === 0) return;
  const entries = execFileSync(gitPath, fixedGitArguments(repositoryRoot, [
    "ls-files", "-v", "-z", "--", ...revisionPaths,
  ]), {
    cwd: repositoryRoot,
    env: fixedGitEnvironment(),
    encoding: "utf8",
    timeout: timeoutMs,
  }).split("\0").filter(Boolean);
  const mutable = entries.filter((entry) => /^[a-zS] /.test(entry));
  if (mutable.length > 0) {
    throw new Error(`Repository Git authority rejects assume-unchanged and skip-worktree entries: ${JSON.stringify(mutable)}`);
  }
}

export function createPinnedProviderWrapperScript({ nodePath, codexPath, pidFile }) {
  for (const [label, value] of Object.entries({ nodePath, codexPath, pidFile })) {
    if (typeof value !== "string" || !value.startsWith("/") || value.includes("\0") || value.includes("\n") || value.includes("\r")) {
      throw new Error(`Pinned provider wrapper ${label} must be an absolute single-line path.`);
    }
  }
  if (/\s/.test(nodePath)) {
    throw new Error("Pinned provider wrapper nodePath cannot contain whitespace because it is used as the shebang interpreter.");
  }
  return [
    `#!${nodePath}`,
    'const { spawn } = require("node:child_process");',
    'const { writeFileSync } = require("node:fs");',
    `const child = spawn(${JSON.stringify(codexPath)}, process.argv.slice(2), { stdio: "inherit", env: process.env });`,
    "let forwardedSignals = 0;",
    "let pidPublicationError;",
    "const forward = (signal) => {",
    "  forwardedSignals += 1;",
    "  try { child.kill(forwardedSignals === 1 ? signal : \"SIGKILL\"); } catch {}",
    "};",
    'const onSigint = () => forward("SIGINT");',
    'const onSigterm = () => forward("SIGTERM");',
    'const onForceClose = () => { try { child.kill("SIGKILL"); } catch {} };',
    'process.on("SIGINT", onSigint);',
    'process.on("SIGTERM", onSigterm);',
    'process.on("SIGUSR2", onForceClose);',
    "child.once(\"spawn\", () => {",
    "  try {",
    `    writeFileSync(${JSON.stringify(pidFile)}, \`\${child.pid}\\n\`, { encoding: "utf8", mode: 0o600 });`,
    "  } catch (error) {",
    "    pidPublicationError = error;",
    '    process.stderr.write(`Failed to publish Codex provider PID ${child.pid}: ${error.stack || error.message}\\n`);',
    '    try { child.kill("SIGKILL"); } catch (killError) {',
    '      process.stderr.write(`Failed to kill Codex provider PID ${child.pid}: ${killError.stack || killError.message}\\n`);',
    "    }",
    "  }",
    "});",
    "child.once(\"error\", (error) => {",
    '  process.stderr.write(`${error.stack || error.message}\\n`);',
    "  process.exit(1);",
    "});",
    "child.once(\"exit\", (code, signal) => {",
    '  process.removeListener("SIGINT", onSigint);',
    '  process.removeListener("SIGTERM", onSigterm);',
    '  process.removeListener("SIGUSR2", onForceClose);',
    "  if (pidPublicationError) process.exit(1);",
    "  else if (signal) process.kill(process.pid, signal);",
    "  else process.exit(code ?? 1);",
    "});",
    "",
  ].join("\n");
}

export function createPinnedGraphAuthoringNetworkProfile() {
  return [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    '(allow network-outbound (require-all (remote tcp (param "GRAPH_ENDPOINT")) (socket-domain AF_INET)))',
    "",
  ].join("\n");
}

export function createPinnedGraphAuthoringExecPolicy(launcherPath) {
  if (typeof launcherPath !== "string"
    || !isAbsolute(launcherPath)
    || launcherPath.includes("\0")
    || launcherPath.includes("\n")
    || launcherPath.includes("\r")) {
    throw new Error("Pinned graph-authoring exec policy requires a safe absolute launcher path.");
  }
  return `prefix_rule(pattern=[${JSON.stringify(launcherPath)}], decision="allow")\n`;
}

export function createPinnedGraphAuthoringLauncherScript({
  nodePath,
  graphClientRoot,
  sandboxExecPath,
  networkProfilePath,
}) {
  for (const [label, value] of Object.entries({ nodePath, graphClientRoot, sandboxExecPath, networkProfilePath })) {
    if (typeof value !== "string" || !/^\/[A-Za-z0-9._/@+-]+$/.test(value)) {
      throw new Error(`Pinned graph-authoring launcher ${label} must be a shell-safe absolute path.`);
    }
  }
  return [
    "#!/bin/zsh -f",
    "set -eu",
    'if (( $# != 0 )); then print -u2 "graph-authoring launcher accepts no arguments"; exit 64; fi',
    ': "${RELAYER_GRAPH_URL:?missing graph URL}"',
    ': "${RELAYER_GRAPH_TOKEN:?missing graph token}"',
    ': "${RELAYER_NODE_ID:?missing graph node ID}"',
    'case "$RELAYER_GRAPH_URL" in',
    '  http://127.0.0.1:<->) ;;',
    '  *) print -u2 "graph URL must be an explicit 127.0.0.1 port"; exit 64 ;;',
    "esac",
    '[[ "$RELAYER_NODE_ID" == <-> ]] || { print -u2 "graph node ID must be numeric"; exit 64; }',
    'graph_port="${RELAYER_GRAPH_URL##*:}"',
    '(( graph_port >= 1 && graph_port <= 65535 )) || { print -u2 "graph port is out of range"; exit 64; }',
    "exec /usr/bin/env -i \\",
    "  LANG=C LC_ALL=C \\",
    "  RELAYER_GRAPH_URL=\"$RELAYER_GRAPH_URL\" \\",
    "  RELAYER_GRAPH_TOKEN=\"$RELAYER_GRAPH_TOKEN\" \\",
    "  RELAYER_NODE_ID=\"$RELAYER_NODE_ID\" \\",
    `  ${sandboxExecPath} -D "GRAPH_ENDPOINT=localhost:$graph_port" -f ${networkProfilePath} \\`,
    `  ${nodePath} --permission --allow-fs-read=${graphClientRoot} --allow-net --input-type=module`,
    "",
  ].join("\n");
}

export class EvidenceWaitDeadlineError extends Error {
  constructor(label, timeoutMs) {
    super(`${label} exceeded its ${timeoutMs}ms wait deadline.`);
    this.name = "EvidenceWaitDeadlineError";
    this.code = "RELAYER_WAIT_DEADLINE";
  }
}

export class EvidenceWaitInterruptedError extends Error {
  constructor(label) {
    super(`${label} was interrupted.`);
    this.name = "EvidenceWaitInterruptedError";
    this.code = "RELAYER_WAIT_INTERRUPTED";
  }
}

export class EvidenceMediaDeadlineError extends Error {
  constructor(label, timeoutMs, diagnostics = "", options = {}) {
    const suffix = diagnostics.trim() === "" ? "" : ` ${diagnostics.trim()}`;
    super(`${label} exceeded its ${timeoutMs}ms media deadline.${suffix}`, options);
    this.name = "EvidenceMediaDeadlineError";
    this.code = "RELAYER_MEDIA_DEADLINE";
  }
}

export class EvidenceMediaCloseDeadlineError extends Error {
  constructor(label, timeoutMs, diagnostics = "", options = {}) {
    const suffix = diagnostics.trim() === "" ? "" : ` ${diagnostics.trim()}`;
    super(`${label} did not close within ${timeoutMs}ms after forced termination.${suffix}`, options);
    this.name = "EvidenceMediaCloseDeadlineError";
    this.code = "RELAYER_MEDIA_CLOSE_DEADLINE";
  }
}

export async function settleBeforeDeadline(operation, {
  label,
  deadline,
  timeoutMs,
  now = Date.now,
  schedule = setTimeout,
  cancel = clearTimeout,
  interruption,
}) {
  const remainingMs = deadline - now();
  if (remainingMs <= 0) throw new EvidenceWaitDeadlineError(label, timeoutMs);
  let timer;
  try {
    const outcomes = [
      Promise.resolve().then(operation),
      new Promise((_resolve, reject) => {
        timer = schedule(() => reject(new EvidenceWaitDeadlineError(label, timeoutMs)), remainingMs);
      }),
    ];
    if (interruption) {
      outcomes.push(Promise.resolve(interruption).then(() => {
        throw new EvidenceWaitInterruptedError(label);
      }));
    }
    return await Promise.race(outcomes);
  } finally {
    cancel(timer);
  }
}

export function bytePin(content) {
  return {
    bytes: content.byteLength,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

export function pinUniqueBytes(pins, key, content) {
  if (pins.has(key)) throw new Error(`Captured bytes were pinned more than once: ${key}`);
  const pin = { file: key, ...bytePin(content) };
  pins.set(key, pin);
  return pin;
}

export function verifyPinnedByteInventory(pins, observed) {
  const expected = [...pins.values()].sort((left, right) => left.file.localeCompare(right.file));
  const actual = [...observed].sort((left, right) => left.file.localeCompare(right.file));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Captured bytes changed after they were pinned.");
  }
  return expected;
}

export function pinnedSequenceSha256(pins) {
  const ordered = [...pins.values()].sort((left, right) => left.file.localeCompare(right.file));
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}

export function pinnedBuffersInFileOrder(pins, buffers) {
  const observed = [...buffers].map(([file, content]) => ({ file, ...bytePin(content) }));
  const orderedPins = verifyPinnedByteInventory(pins, observed);
  return orderedPins.map((pin) => buffers.get(pin.file));
}

export function pipeByteChunks(writable, chunks, signal) {
  return pipeline(Readable.from(chunks), writable, { signal });
}

export async function settleMediaCompletion(operation, {
  label,
  timeoutMs,
  abort,
  force = abort,
  closed,
  diagnostics = () => "",
  abortCloseTimeoutMs = 2_000,
  forceCloseTimeoutMs = 2_000,
  schedule = setTimeout,
  cancel = clearTimeout,
}) {
  const deadlineMarker = {};
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_resolve, reject) => {
        timer = schedule(() => reject(deadlineMarker), timeoutMs);
      }),
    ]);
  } catch (error) {
    abort();
    if (!await settlesWithin(closed, abortCloseTimeoutMs, schedule, cancel)) {
      force();
      if (!await settlesWithin(closed, forceCloseTimeoutMs, schedule, cancel)) {
        throw new EvidenceMediaCloseDeadlineError(
          label,
          abortCloseTimeoutMs + forceCloseTimeoutMs,
          diagnostics(),
          { cause: error === deadlineMarker ? undefined : error },
        );
      }
    }
    if (error === deadlineMarker) {
      throw new EvidenceMediaDeadlineError(label, timeoutMs, diagnostics());
    }
    const diagnosticTail = diagnostics().trim();
    const detail = error instanceof Error ? error.message : String(error);
    const suffix = diagnosticTail === "" || detail.includes(diagnosticTail) ? "" : ` ${diagnosticTail}`;
    throw new Error(`${label} failed: ${detail}${suffix}`, { cause: error });
  } finally {
    cancel(timer);
  }
}

async function settlesWithin(operation, timeoutMs, schedule, cancel) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(operation).then(() => true),
      new Promise((resolveTimeout) => {
        timer = schedule(() => resolveTimeout(false), timeoutMs);
      }),
    ]);
  } finally {
    cancel(timer);
  }
}

export function validatePinnedGraphAuthoringCommands(events, {
  allowedInspectionRoots = [],
  allowedGraphAuthoringLauncher,
  allowedGraphAuthoringLauncherSha256,
  allowedInspectionRawRoots = [],
  allowedSedExecutable,
  allowedSedExecutableSha256,
  allowedRipgrepExecutable,
  allowedRipgrepExecutableSha256,
  requirePinnedGraph = true,
  requireCommandCompletions = false,
} = {}) {
  if (requirePinnedGraph && !absolutePathSegments(allowedGraphAuthoringLauncher)) {
    throw new Error("The permitted graph-authoring launcher must be one exact absolute inventoried path.");
  }
  if (requirePinnedGraph && !/^[a-f0-9]{64}$/.test(allowedGraphAuthoringLauncherSha256 ?? "")) {
    throw new Error("The permitted graph-authoring launcher requires its authenticated pre-redaction SHA-256 digest.");
  }
  if (allowedInspectionRoots.length !== allowedInspectionRawRoots.length
    || allowedInspectionRoots.some((root) => !absolutePathSegments(root))
    || allowedInspectionRawRoots.some((root) => !absolutePathSegments(root))) {
    throw new Error("Inspection roots require aligned exact redacted and raw absolute paths.");
  }
  for (const [label, executable, digest] of [
    ["sed", allowedSedExecutable, allowedSedExecutableSha256],
    ["ripgrep", allowedRipgrepExecutable, allowedRipgrepExecutableSha256],
  ]) {
    if (executable !== undefined && !absolutePathSegments(executable)) {
      throw new Error(`The permitted ${label} executable must be one exact absolute inventoried path.`);
    }
    if (executable !== undefined && !/^[a-f0-9]{64}$/.test(digest ?? "")) {
      throw new Error(`The permitted ${label} executable requires its authenticated pre-redaction SHA-256 digest.`);
    }
  }
  let validated = 0;
  const starts = new Map();
  const completed = new Set();
  for (const event of events) {
    const phase = event?.data?.method;
    const item = event?.type === "provider.event"
      && (phase === "item/started" || phase === "item/completed")
      && event.data?.params?.item?.type === "commandExecution"
      ? event.data.params.item
      : undefined;
    if (!item) continue;
    const actions = Array.isArray(item.commandActions) ? item.commandActions : [];
    if (actions.length === 0 || actions.some((action) => typeof action?.command !== "string")) {
      throw new Error("Every evidence command execution must contain permitted shell actions.");
    }
    const pinnedActions = actions.filter((action) => isExactPinnedGraphLauncherHeredoc(
      action,
      allowedGraphAuthoringLauncher,
      allowedGraphAuthoringLauncherSha256,
    ));
    let pinned = false;
    if (pinnedActions.length > 0) {
      if (actions.length !== 1 || pinnedActions.length !== 1) {
        throw new Error("A pinned graph-authoring execution must contain exactly one launcher heredoc and no other shell action.");
      }
      pinned = true;
    } else if (actions.some((action) => !isReadOnlyInspectionCommand(action, {
      allowedInspectionRoots,
      allowedInspectionRawRoots,
      allowedSedExecutable,
      allowedSedExecutableSha256,
      allowedRipgrepExecutable,
      allowedRipgrepExecutableSha256,
    }))) {
      throw new Error("Evidence command executions may only inspect source read-only or invoke the exact pinned graph-authoring launcher heredoc.");
    }
    const itemId = typeof item.id === "string" && item.id.trim() !== "" ? item.id : undefined;
    if (requireCommandCompletions && itemId === undefined) {
      throw new Error("Every command in a complete evidence trace requires a provider item ID.");
    }
    const fingerprint = commandActionFingerprint(actions);
    if (phase === "item/started") {
      if (itemId !== undefined) {
        if (starts.has(itemId)) throw new Error(`Duplicate command start for provider item ${itemId}.`);
        starts.set(itemId, { fingerprint, pinned });
      }
      if (pinned) validated += 1;
    } else {
      if (itemId === undefined) throw new Error("Every completed evidence command requires a provider item ID.");
      if (completed.has(itemId)) throw new Error(`Duplicate command completion for provider item ${itemId}.`);
      const started = starts.get(itemId);
      if (started === undefined) throw new Error(`Completed command ${itemId} has no matching validated start.`);
      if (started.fingerprint !== fingerprint) throw new Error(`Completed command ${itemId} does not match its validated start actions.`);
      completed.add(itemId);
    }
  }
  if (requireCommandCompletions) {
    for (const itemId of starts.keys()) {
      if (!completed.has(itemId)) throw new Error(`Started command ${itemId} has no matching validated completion.`);
    }
  }
  if (requirePinnedGraph && validated === 0) {
    throw new Error("Graph authoring did not invoke the pinned graph-authoring launcher.");
  }
  return validated;
}

function commandActionFingerprint(actions) {
  return JSON.stringify(actions.map((action) => ({
    command: action.command,
    relayerExecutableAuthoritySha256: action.relayerExecutableAuthoritySha256,
    relayerCommandWordAuthoritySha256: action.relayerCommandWordAuthoritySha256,
    relayerGraphAuthoringLauncherSha256: action.relayerGraphAuthoringLauncherSha256,
  })));
}

function isReadOnlyInspectionCommand(action, authority) {
  const command = action.command;
  const words = inspectionCommandWords(command);
  if (!words) return false;
  const [program, ...args] = words;
  if (program === authority.allowedSedExecutable) {
    return args.length >= 3
      && args[0] === "-n"
      && /^\d+(?:,\d+)?p$/.test(args[1])
      && action.relayerExecutableAuthoritySha256 === authority.allowedSedExecutableSha256
      && args.slice(2).every((argument, index) => authenticateInspectionPath(
        action,
        index + 3,
        argument,
        authority.allowedInspectionRoots,
        authority.allowedInspectionRawRoots,
      ));
  }
  if (typeof authority.allowedRipgrepExecutable === "string" && program === authority.allowedRipgrepExecutable) {
    if (action.relayerExecutableAuthoritySha256 !== authority.allowedRipgrepExecutableSha256) return false;
    const safeFlags = new Set([
      "-n", "--line-number",
      "-i", "--ignore-case",
      "-S", "--smart-case",
      "-F", "--fixed-strings",
      "-w", "--word-regexp",
      "-x", "--line-regexp",
      "-l", "--files-with-matches",
      "--files-without-match",
      "-c", "--count", "--count-matches",
      "--hidden", "--no-ignore",
    ]);
    const safeValueFlags = new Set(["-g", "--glob"]);
    const safeNumericValueFlags = new Set(["-C", "--context"]);
    let optionsEnded = false;
    const operands = [];
    for (let index = 0; index < args.length; index += 1) {
      const argument = args[index];
      if (!optionsEnded && argument === "--") {
        optionsEnded = true;
      } else if (!optionsEnded && argument.startsWith("-")) {
        if (safeFlags.has(argument)) continue;
        if (safeValueFlags.has(argument)) {
          const value = args[index + 1];
          if (value === undefined || value === "") return false;
          index += 1;
          continue;
        }
        if (safeNumericValueFlags.has(argument)) {
          const value = args[index + 1];
          if (value === undefined || !/^\d+$/.test(value)) return false;
          index += 1;
          continue;
        }
        if (argument.startsWith("--glob=") && argument.length > "--glob=".length) continue;
        if (/^--context=\d+$/.test(argument)) continue;
        return false;
      } else {
        if (argument === "") return false;
        operands.push({ argument, wordIndex: index + 1 });
      }
    }
    return operands.length >= 2
      && operands.slice(1).every(({ argument, wordIndex }) => authenticateInspectionPath(
        action,
        wordIndex,
        argument,
        authority.allowedInspectionRoots,
        authority.allowedInspectionRawRoots,
      ));
  }
  return false;
}

function authenticateInspectionPath(action, wordIndex, observedPath, allowedRoots, rawRoots) {
  const hashes = action.relayerCommandWordAuthoritySha256;
  if (!Array.isArray(hashes) || !/^[a-f0-9]{64}$/.test(hashes[wordIndex] ?? "")) return false;
  const observed = absolutePathSegments(observedPath);
  if (!observed) return false;
  for (let index = 0; index < allowedRoots.length; index += 1) {
    const expected = absolutePathSegments(allowedRoots[index]);
    const raw = absolutePathSegments(rawRoots[index]);
    if (!expected || !raw || observed.length < expected.length
      || !expected.every((segment, segmentIndex) => observed[segmentIndex] === segment)) continue;
    const rawPath = `/${[...raw, ...observed.slice(expected.length)].join("/")}`;
    return hashes[wordIndex] === createHash("sha256").update(rawPath).digest("hex");
  }
  return false;
}

function isInventoriedInspectionPath(observedPath, allowedRoots) {
  const observed = absolutePathSegments(observedPath);
  if (!observed) return false;
  return allowedRoots.some((root) => {
    const expected = absolutePathSegments(root);
    if (!expected || observed.length < expected.length) return false;
    return expected.every((segment, index) => observed[index] === segment);
  });
}

function absolutePathSegments(path) {
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("\0")) return undefined;
  const segments = path.split("/").slice(1);
  if (segments.length === 0 || segments.some((segment) => (
    segment === ""
    || segment === "."
    || segment === ".."
  ))) return undefined;
  return segments;
}

function inspectionCommandWords(command) {
  if (typeof command !== "string"
    || command.trim() === ""
    || /[\r\n]/.test(command)) return undefined;
  const words = [];
  let word = "";
  let quote;
  let started = false;
  const normalized = command.trim();
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (quote) {
      if (character === quote) quote = undefined;
      else {
        if (quote === '"' && /[$`\\!]/.test(character)) return undefined;
        word += character;
      }
      started = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (/\s/.test(character)) {
      if (started) {
        words.push(word);
        word = "";
        started = false;
      }
    } else {
      const redactionEnd = index + "[redacted]".length;
      if (character === "["
        && normalized.startsWith("[redacted]", index)
        && normalized[index - 1] === "/"
        && (redactionEnd === normalized.length || normalized[redactionEnd] === "/" || /\s/.test(normalized[redactionEnd]))) {
        word += "[redacted]";
        started = true;
        index += "[redacted]".length - 1;
        continue;
      }
      if (/[;|&<>(){}!$`\\*?\[\]#]/.test(character)) return undefined;
      word += character;
      started = true;
    }
  }
  if (quote) return undefined;
  if (started) words.push(word);
  return words;
}

export function commandWordAuthoritySha256(command) {
  const words = inspectionCommandWords(command);
  return words?.map((word) => (
    word.startsWith("/") ? createHash("sha256").update(word).digest("hex") : null
  ));
}

function isExactPinnedGraphLauncherHeredoc(action, allowedGraphAuthoringLauncher, allowedGraphAuthoringLauncherSha256) {
  if (!absolutePathSegments(allowedGraphAuthoringLauncher)) return false;
  if (action.relayerGraphAuthoringLauncherSha256 !== allowedGraphAuthoringLauncherSha256) return false;
  const command = action.command;
  const normalized = command.trim();
  const expectedPrefix = [JSON.stringify(allowedGraphAuthoringLauncher), allowedGraphAuthoringLauncher]
    .map((candidate) => `${candidate} `)
    .find((candidate) => normalized.startsWith(candidate));
  if (expectedPrefix === undefined) return false;
  const opening = normalized.slice(expectedPrefix.length).match(/^<<'([A-Za-z_][A-Za-z0-9_]*)'[ \t]*\r?\n/);
  if (!opening) return false;
  const delimiter = opening[1];
  const bodyAndClose = normalized.slice(expectedPrefix.length + opening[0].length);
  const lines = bodyAndClose.split(/\r?\n/);
  const closingLine = lines.pop();
  const earlierDelimiter = lines.some((line) => line.trimEnd() === delimiter);
  const hasNonemptyBody = lines.some((line) => line.length > 0)
    || (closingLine !== undefined && closingLine !== "" && closingLine.trimEnd() !== delimiter);
  if (earlierDelimiter || !hasNonemptyBody) return false;
  // A shell-valid EOF-terminated heredoc is safe here: the exact launcher has
  // no arguments and all remaining bytes are its stdin, not another action.
  return closingLine?.trimEnd() === delimiter
    || !bodyAndClose.split(/\r?\n/).some((line) => line.trimEnd() === delimiter);
}
