import { readFile } from "node:fs/promises";

// Match both rustc's temporary liblbug.a and native objects bundled into its
// Rust rlib. Rust-generated rcgu objects have their own Rust compilation units.
const nativeObject = (path) => /(?:^|\/)liblbug(?:\.a|-[^/]+\.rlib)\([^()]+\.o\)$/.test(path) && !/\.rcgu\.o\)$/.test(path);

// Read the executable's Mach-O STABS debug map directly. dsymutil's map
// dumper opens referenced archives and omits missing objects, so it cannot be
// the coverage authority after rustc/native-owner cleanup.
export function nativeFunctionInventory(bytes) {
  const invalid = () => { throw Error("native Mach-O debug-map inventory mismatch"); };
  if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== 0x0100000c) invalid();
  const count = bytes.readUInt32LE(16), commandEnd = 32 + bytes.readUInt32LE(20);
  if (commandEnd > bytes.length || count > 10000) invalid();
  let position = 32, table;
  for (let index = 0; index < count; index++) {
    if (position + 8 > commandEnd) invalid();
    const command = bytes.readUInt32LE(position), size = bytes.readUInt32LE(position + 4);
    if (size < 8 || position + size > commandEnd) invalid();
    if (command === 2) {
      if (table || size !== 24) invalid();
      table = [8, 12, 16, 20].map((offset) => bytes.readUInt32LE(position + offset));
    }
    position += size;
  }
  if (position !== commandEnd || !table) invalid();
  const [offset, length, strings, stringSize] = table;
  if (offset < commandEnd || strings < commandEnd || offset + length * 16 > bytes.length || strings + stringSize > bytes.length) invalid();
  let object, pending;
  const functions = [];
  for (let index = 0; index < length; index++) {
    const entry = offset + index * 16, type = bytes[entry + 4];
    if (![0x66, 0x64, 0x24].includes(type)) continue;
    const str = bytes.readUInt32LE(entry);
    if (str >= stringSize) invalid();
    const end = bytes.indexOf(0, strings + str);
    if (end < 0 || end >= strings + stringSize) invalid();
    const name = bytes.subarray(strings + str, end).toString("utf8");
    const value = bytes.readBigUInt64LE(entry + 8);
    if (type === 0x66 || type === 0x64) {
      if (pending) invalid();
      object = type === 0x66 ? name : undefined;
    } else if (nativeObject(object ?? "")) {
      if (name) { if (pending || value === 0n) invalid(); pending = { object, name, low: value }; }
      else { if (!pending || value === 0n) invalid(); functions.push({ ...pending, high: pending.low + value }); pending = undefined; }
    }
  }
  if (pending) invalid();
  if (!functions.length) throw Error("native debug map contains no Ladybug code symbols");
  return functions;
}

export async function validateNativeCoverage(binary, symbols, units, capture) {
  const functions = nativeFunctionInventory(await readFile(binary));
  const nativeUnits = new Set();
  for (const unit of String(units).split(/(?=0x[a-f0-9]+: Compile Unit:)/i)) {
    const offset = unit.match(/^(0x[a-f0-9]+): Compile Unit:/i)?.[1];
    if (offset && /DW_AT_language\s*\(DW_LANG_(?:C\d*|C_plus_plus(?:_\d+)?)\)/.test(unit)) nativeUnits.add(BigInt(offset).toString());
  }
  // aranges supplies the actual disjoint code ranges (a CU's low/high PC may
  // span unrelated Rust code). Accept only ranges belonging to C/C++ units.
  const ranges = [];
  for (const block of String(await capture("/usr/bin/dwarfdump", ["--debug-aranges", symbols])).split("Address Range Header:")) {
    const offset = block.match(/cu_offset = (0x[a-f0-9]+)/i)?.[1];
    if (!offset || !nativeUnits.has(BigInt(offset).toString())) continue;
    for (const match of block.matchAll(/\[(0x[a-f0-9]+), (0x[a-f0-9]+)\)/gi)) {
      const low = BigInt(match[1]), high = BigInt(match[2]);
      if (high <= low) throw Error("invalid native DWARF code range");
      ranges.push([low, high]);
    }
  }
  ranges.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const merged = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) { if (range[1] > last[1]) last[1] = range[1]; }
    else merged.push([...range]);
  }
  for (const { object, name, low, high } of functions) {
    let left = 0, right = merged.length;
    while (left < right) { const mid = (left + right) >>> 1; if (merged[mid][0] <= low) left = mid + 1; else right = mid; }
    const range = merged[left - 1];
    if (!range || range[1] < high) throw Error(`incomplete native symbol coverage: ${object.split("/").at(-1)} ${name}`);
  }
  return { objects: new Set(functions.map((item) => item.object)).size, codeSymbols: functions.length };
}
