import { readFile } from "node:fs/promises";

function requireBufferRange(bytes, offset, length, label) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + length > bytes.length) {
    throw new Error(`packaged graph server has an invalid PE ${label}`);
  }
}

function peCString(bytes, offset, maximumLength) {
  requireBufferRange(bytes, offset, 1, "import name");
  const end = bytes.indexOf(0, offset);
  if (end === -1 || end >= offset + maximumLength) {
    throw new Error("packaged graph server has an unterminated PE import name");
  }
  return bytes.toString("ascii", offset, end);
}

export function inspectPortableExecutable(bytes) {
  if (!Buffer.isBuffer(bytes)) throw new Error("PE inspection requires executable bytes");
  requireBufferRange(bytes, 0, 0x40, "DOS header");
  if (bytes.toString("ascii", 0, 2) !== "MZ") {
    throw new Error("packaged graph server is not a PE executable");
  }
  const peOffset = bytes.readUInt32LE(0x3c);
  requireBufferRange(bytes, peOffset, 24, "COFF header");
  if (bytes.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") {
    throw new Error("packaged graph server has no PE signature");
  }
  const machine = bytes.readUInt16LE(peOffset + 4);
  const architecture = new Map([
    [0x8664, "x86_64"],
    [0xaa64, "arm64"],
  ]).get(machine);
  if (!architecture) throw new Error(`unsupported packaged PE machine: 0x${machine.toString(16)}`);
  const sectionCount = bytes.readUInt16LE(peOffset + 6);
  const optionalHeaderSize = bytes.readUInt16LE(peOffset + 20);
  const optionalHeader = peOffset + 24;
  requireBufferRange(bytes, optionalHeader, optionalHeaderSize, "optional header");
  const magic = bytes.readUInt16LE(optionalHeader);
  if (magic !== 0x20b) throw new Error(`unsupported packaged PE optional header: 0x${magic.toString(16)}`);
  const dataDirectoryOffset = 112;
  if (optionalHeaderSize < dataDirectoryOffset + 16) {
    throw new Error("packaged graph server omits the PE import directory");
  }
  const numberOfDataDirectories = bytes.readUInt32LE(optionalHeader + dataDirectoryOffset - 4);
  const dataDirectory = (index) => {
    if (numberOfDataDirectories <= index || optionalHeaderSize < dataDirectoryOffset + (index + 1) * 8) {
      return { rva: 0, size: 0 };
    }
    return {
      rva: bytes.readUInt32LE(optionalHeader + dataDirectoryOffset + index * 8),
      size: bytes.readUInt32LE(optionalHeader + dataDirectoryOffset + index * 8 + 4),
    };
  };
  const sizeOfHeaders = bytes.readUInt32LE(optionalHeader + 60);
  const sectionTable = optionalHeader + optionalHeaderSize;
  requireBufferRange(bytes, sectionTable, sectionCount * 40, "section table");
  const sections = Array.from({ length: sectionCount }, (_, index) => {
    const offset = sectionTable + index * 40;
    return {
      virtualSize: bytes.readUInt32LE(offset + 8),
      virtualAddress: bytes.readUInt32LE(offset + 12),
      rawSize: bytes.readUInt32LE(offset + 16),
      rawOffset: bytes.readUInt32LE(offset + 20),
    };
  });
  for (const section of sections) {
    if (section.rawSize > 0) {
      requireBufferRange(bytes, section.rawOffset, section.rawSize, "section raw data");
    }
  }
  const fileRangeForRva = (rva, label) => {
    if (rva < sizeOfHeaders) {
      requireBufferRange(bytes, rva, 1, label);
      return { offset: rva, maximumLength: Math.min(sizeOfHeaders, bytes.length) - rva };
    }
    const section = sections.find(({ virtualAddress, virtualSize, rawSize }) => (
      rva >= virtualAddress && rva < virtualAddress + Math.max(virtualSize, rawSize)
    ));
    if (!section) throw new Error(`packaged graph server has an unmapped PE ${label}`);
    const delta = rva - section.virtualAddress;
    if (delta >= section.rawSize) {
      throw new Error(`packaged graph server maps PE ${label} into a virtual-only section range`);
    }
    const offset = section.rawOffset + delta;
    requireBufferRange(bytes, offset, 1, label);
    return { offset, maximumLength: section.rawSize - delta };
  };
  const imports = [];
  const parseImports = ({ rva, size }, { descriptorSize, label, nameField, validateDescriptor }) => {
    if (rva === 0 && size === 0) return;
    if (rva === 0 || size < descriptorSize) throw new Error(`packaged graph server has an invalid PE ${label}`);
    const { offset: importOffset, maximumLength } = fileRangeForRva(rva, label);
    if (size > maximumLength) throw new Error(`packaged graph server has an oversized PE ${label}`);
    const maximumDescriptors = Math.floor(size / descriptorSize);
    let terminated = false;
    for (let index = 0; index < maximumDescriptors; index += 1) {
      const descriptor = importOffset + index * descriptorSize;
      requireBufferRange(bytes, descriptor, descriptorSize, `${label} descriptor`);
      const fields = Array.from(
        { length: descriptorSize / 4 },
        (_, field) => bytes.readUInt32LE(descriptor + field * 4),
      );
      if (fields.every((value) => value === 0)) {
        terminated = true;
        break;
      }
      validateDescriptor?.(fields);
      if (fields[nameField] === 0) throw new Error(`packaged graph server has a nameless PE ${label} descriptor`);
      const name = fileRangeForRva(fields[nameField], `${label} name`);
      imports.push(peCString(bytes, name.offset, name.maximumLength));
    }
    if (!terminated) throw new Error(`packaged graph server has an unterminated PE ${label}`);
  };
  parseImports(dataDirectory(1), {
    descriptorSize: 20,
    label: "import directory",
    nameField: 3,
  });
  parseImports(dataDirectory(13), {
    descriptorSize: 32,
    label: "delay-import directory",
    nameField: 1,
    validateDescriptor: (fields) => {
      if ((fields[0] & 1) !== 1) {
        throw new Error("packaged graph server uses unsupported VA-based PE delay imports");
      }
    },
  });
  return { architecture, imports };
}

export function verifyNoBundledWindowsNativeLibraries(libraries) {
  const forbidden = libraries.filter((library) => {
    const name = String(library).split(/[\\/]/u).at(-1);
    return (
      /^(?:lib)?(?:lbug|ladybug)(?:[-._].*)?\.dll$/iu.test(name)
      || /^(?:lib)?(?:ssl|crypto)(?:[-._].*)?\.dll$/iu.test(name)
    );
  });
  if (forbidden.length > 0) {
    throw new Error(`packaged graph server imports forbidden native libraries: ${forbidden.join(", ")}`);
  }
  return libraries;
}

export async function verifyWindowsNativeExecutable(path) {
  const inspected = inspectPortableExecutable(await readFile(path));
  if (inspected.architecture !== "x86_64") throw new Error(`Bundled Windows executable must be x64: ${path}.`);
  verifyNoBundledWindowsNativeLibraries(inspected.imports);
  return inspected;
}
