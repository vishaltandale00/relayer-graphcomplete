import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, resolve } from "node:path";

// Cargo keeps the binary target name in the EXE, but uses its Rust crate name
// (hyphens replaced by underscores) for the MSVC PDB. Keep this allowlist exact.
const PDB_NAMES = new Map([
  ["relayer-app-server.exe", "relayer_app_server.pdb"],
  ["relayer-graph-server.exe", "relayer_graph_server.pdb"],
]);

export function windowsRustPdbPath(binary) {
  const name = PDB_NAMES.get(basename(binary));
  if (!name) throw new Error(`Unsupported Windows Rust binary: ${basename(binary)}`);
  return resolve(dirname(binary), name);
}

export function parseWindowsDebugId(output) {
  const text = String(output || "");
  const guid = /(?:PDB)?GUID:\s*[({]?([a-f0-9-]{36})[)}]?/iu.exec(text)?.[1]?.toLowerCase();
  const age = /(?:PDB)?Age:\s*(\d+)/iu.exec(text)?.[1];
  return guid && age ? `${guid}-${age}` : null;
}

export async function verifyWindowsRustDebugIdentity(binary, pdb, capture = promisify(execFile)) {
  const options = { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 };
  const [executable, symbols] = await Promise.all([
    capture("llvm-readobj", ["--coff-debug-directory", binary], options),
    capture("llvm-pdbutil", ["dump", "-summary", pdb], options),
  ]);
  const debugId = parseWindowsDebugId(executable.stdout);
  if (!debugId || debugId !== parseWindowsDebugId(symbols.stdout)) throw Error("Desktop telemetry PDB identity does not match the packaged Rust executable.");
  return debugId;
}
