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
