import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  digestFilesystemTree,
  digestFilesystemDependencyClosure,
  collectFilesystemDependencyClosureEntries,
  primeRuntimeSourcePathIsPackaged,
  sha256,
  verifySignedDependencyClosureSnapshot,
} from "../../shared/prime-runtime-integrity.mjs";

export const PRIME_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";
export const PRIME_AGENT_SOURCE_COMMIT = "f6130839ad3043f1cd3d5294fe03023035bfcd5c";
export const PRIME_AGENT_PACKAGE_VERSION = "0.8.1";
export const PRIME_AGENT_PACKAGE_SHA256 = Object.freeze({
  "@earendil-works/pi-agent-core": "56d1bc00321a310c9e75c0ca33a6241fec0f559c514a046acc1d68d1c7be4f08",
  "@earendil-works/pi-ai": "7560b021e023be9b39f376ba497cf64b9e54b2adb8be3d73b031f0033c4dd700",
  "@earendil-works/pi-coding-agent": "ac88dfc53a9c737d214eccd81d77a6cd7f0b12a9e3432281b0a1a2a5cdd82e6a",
  "@earendil-works/pi-tui": "40517b0d5600557a31e395a0c344dbb9af7d3f8c000bea65561ef81b83142507",
});
export const PRIME_AGENT_PACKAGE_TREE_SHA256 = Object.freeze({
  "@earendil-works/pi-agent-core": "16223dfa60386a61d143c4cbdd4dcfe0316c2962844219e432426151ef4b8954",
  "@earendil-works/pi-ai": "2bbbd8b3207c9d5c21bfc274023dab7a9fd2755ac6c05c6a9be6d8c19f635704",
  "@earendil-works/pi-coding-agent": "1633b986dd8809ae6fe1013c9cb284bd7f50340dc12c64853b71872f56ea1156",
  "@earendil-works/pi-tui": "f86a8ab553edaf05e1fc4f4d6cb48c313e5a93f2f3490f74e510661c52d74447",
});
export const PRIME_AGENT_DEPENDENCY_CLOSURE_SHA256_BY_TARGET = Object.freeze({
  "darwin-arm64": "da92908f0d08ec84e0481fbb4d5cf9938c6fe9a89fbd8f553defad9c38a14dc7",
  "darwin-x64": "921f4b0394bebdcf87cc88602b65a98777568c3a6c7df8d650196ca33ec9859c",
  "win32-x64": "dd0774fa26307495e71cd2e44239d1521734cd6d0f0e4c64a854df1df22605f4",
});
export const PRIME_AGENT_HARNESS_CONFIGURATIONS = Object.freeze([
  "prime-agent-basic.yaml",
  "prime-agent-deep.yaml",
]);
export const PRIME_AGENT_RUNTIME_CONSTANTS = Object.freeze({
  AGENT_RUN_MODEL_SCOPE_VERSION: 1,
  AGENT_RUN_TOOL_AUTHORITY_SCOPE_VERSION: 1,
  AGENT_RUN_KERNEL_BOUNDARY_SCOPE_VERSION: 1,
});
export const PRIME_AGENT_RUNTIME_FUNCTIONS = Object.freeze([
  "createAgentRunModelScope",
  "createAgentRunToolAuthorityScope",
  "createAgentRunKernelBoundaryScope",
  "createHostRequestHandler",
  "createAgentSessionServices",
  "createAgentSessionFromServices",
]);
export const PRIME_AGENT_SESSION_FUNCTIONS = Object.freeze(["waitForRlmQuiescence"]);
export const PRIME_AGENT_ASSET_SHA256 = Object.freeze({
  harnessConfigurations: Object.freeze({
    "prime-agent-basic.yaml": "55e720e4628a3cab25e149a80325b804f247830b0bc00e5c472400d382fb9775",
    "prime-agent-deep.yaml": "b91e705d99197419deecd5455ce4715b05246f8cc927dc5ba88c1eb4b50acad7",
  }),
  pythonPackageTree: "0971f85b86b8535f85473e75e7962229d0801c0f25462b9ea9910904d242932a",
});

export async function inspectPrimeAgentRuntime({
  appPath,
  harnessDirectory,
  manifestPath,
  pythonClientRoot,
  platform = process.platform,
  architecture = process.arch,
  defaultPermissionProfileId = "auto",
  importPrimeAgent = () => import(PRIME_AGENT_PACKAGE),
  integrityPhase = "unsigned",
  collectDependencyClosure = collectFilesystemDependencyClosureEntries,
  readSignedClosureSnapshot = () => readFile(join(dirname(manifestPath), "signing-closure.json"), "utf8")
    .then((bytes) => JSON.parse(bytes)),
  verifyDependencyClosure = digestFilesystemDependencyClosure,
} = {}) {
  const diagnostics = runtimeDiagnostics();
  if (platform !== "darwin" && (defaultPermissionProfileId === "ask" || defaultPermissionProfileId === "auto")) {
    return unavailable(
      "prime_agent_boundary_unsupported",
      "Prime Agent Ask and Auto require macOS. Choose another available harness on this device.",
      diagnostics,
    );
  }
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    validatePrimeAgentManifest(manifest);
  } catch {
    return unavailable(
      "prime_agent_manifest_invalid",
      "The packaged Prime Agent manifest is invalid. Reinstall or update Relayer.",
      diagnostics,
    );
  }
  try {
    const pythonPackageRoot = join(pythonClientRoot, manifest.pythonPackage);
    await access(join(pythonPackageRoot, "__init__.py"));
    const harnessDigests = await Promise.all(manifest.harnessConfigurations.map(async (name) => ({
      name,
      digest: sha256(await readFile(join(harnessDirectory, name))),
    })));
    if (harnessDigests.some(({ name, digest }) => digest !== manifest.assets.harnessConfigurations[name])) {
      throw new Error("harness integrity mismatch");
    }
    const pythonDigest = await digestFilesystemTree(pythonPackageRoot, (path) => path.endsWith(".py"));
    if (pythonDigest !== manifest.assets.pythonPackageTreeSha256) throw new Error("python integrity mismatch");
  } catch {
    return unavailable(
      "prime_agent_assets_missing",
      "Prime Agent support files are missing. Reinstall or update Relayer.",
      diagnostics,
    );
  }
  try {
    for (const entry of manifest.packages) {
      const packagePath = join(appPath, "node_modules", ...entry.name.split("/"), "package.json");
      const installed = JSON.parse(await readFile(packagePath, "utf8"));
      if (installed.name !== entry.name || installed.version !== entry.version) {
        throw new Error("package mismatch");
      }
      const packageDigest = await digestFilesystemTree(
        join(appPath, "node_modules", ...entry.name.split("/")),
        primeRuntimeSourcePathIsPackaged,
      );
      if (packageDigest !== entry.treeSha256) throw new Error("package integrity mismatch");
    }
    if (appPath.endsWith(".asar")) {
      const rootInstallPaths = manifest.packages.map((entry) => `node_modules/${entry.name}`);
      const targetKey = `${platform}-${architecture}`;
      if (integrityPhase === "signed") {
        verifySignedDependencyClosureSnapshot(
          await collectDependencyClosure(appPath, rootInstallPaths),
          await readSignedClosureSnapshot(),
          targetKey,
        );
      } else {
        const closureDigest = await verifyDependencyClosure(appPath, rootInstallPaths);
        const targetDigest = manifest.dependencyClosureSha256ByTarget[targetKey];
        if (!targetDigest || closureDigest !== targetDigest) throw new Error("dependency closure mismatch");
      }
    }
  } catch {
    return unavailable(
      "prime_agent_packages_invalid",
      "The packaged Prime Agent runtime is incomplete. Reinstall or update Relayer.",
      diagnostics,
    );
  }
  try {
    const runtime = await importPrimeAgent();
    for (const [name, version] of Object.entries(manifest.runtimeContract.constants)) {
      if (runtime[name] !== version) throw new Error(`${name} must equal ${version}`);
    }
    for (const name of manifest.runtimeContract.functions) {
      if (typeof runtime[name] !== "function") throw new Error(`${name} is unavailable`);
    }
    for (const name of manifest.runtimeContract.sessionFunctions) {
      if (typeof runtime.AgentSession?.prototype?.[name] !== "function") {
        throw new Error(`AgentSession.${name} is unavailable`);
      }
    }
    return Object.freeze({
      available: true,
      sourceCommit: manifest.source.commit,
      diagnostics,
      configurationNames: Object.freeze(
        manifest.harnessConfigurations.map((name) => name.replace(/\.yaml$/, "")),
      ),
      pythonClientRoot,
    });
  } catch {
    return unavailable(
      "prime_agent_api_incompatible",
      "This Relayer build cannot use the packaged Prime Agent API. Update Relayer.",
      diagnostics,
    );
  }
}

export function requirePrimeAgentRuntime(result) {
  if (result?.available === true) return result;
  throw new Error(result?.message || "Prime Agent configurations are unavailable.");
}

function runtimeDiagnostics() {
  return Object.freeze({
    sourceCommit: PRIME_AGENT_SOURCE_COMMIT,
    packages: Object.freeze(Object.keys(PRIME_AGENT_PACKAGE_SHA256).sort().map((name) => Object.freeze({
      name,
      version: PRIME_AGENT_PACKAGE_VERSION,
    }))),
  });
}

function unavailable(code, message, diagnostics) {
  return Object.freeze({ available: false, code, message, diagnostics });
}

export function validatePrimeAgentManifest(manifest) {
  if (manifest?.schemaVersion !== 1
    || manifest?.source?.commit !== PRIME_AGENT_SOURCE_COMMIT
    || !Array.isArray(manifest?.packages)
    || manifest.packages.length !== 4
    || !exactArray(manifest?.harnessConfigurations, PRIME_AGENT_HARNESS_CONFIGURATIONS)
    || manifest?.pythonPackage !== "relayer_graph") {
    throw new Error("the bundled manifest does not satisfy schema version 1");
  }
  const names = new Set();
  for (const entry of manifest.packages) {
    if (typeof entry?.name !== "string"
      || entry?.version !== PRIME_AGENT_PACKAGE_VERSION
      || entry.sha256 !== PRIME_AGENT_PACKAGE_SHA256[entry.name]
      || entry.treeSha256 !== PRIME_AGENT_PACKAGE_TREE_SHA256[entry.name]
      || entry.file !== `${entry.name.replace("@", "").replace("/", "-")}-${entry.version}-sha256-${entry.sha256}.tgz`
      || names.has(entry.name)) {
      throw new Error("the bundled manifest contains an invalid package record");
    }
    names.add(entry.name);
  }
  if (names.size !== Object.keys(PRIME_AGENT_PACKAGE_SHA256).length) {
    throw new Error("the bundled manifest omits a required package");
  }
  if (manifest?.runtimeContract?.package !== PRIME_AGENT_PACKAGE
    || manifest?.runtimeContract?.modelScopeAccess !== "upfront-request-access@1"
    || !exactRecord(manifest?.runtimeContract?.constants, PRIME_AGENT_RUNTIME_CONSTANTS)
    || !exactArray(manifest?.runtimeContract?.functions, PRIME_AGENT_RUNTIME_FUNCTIONS)
    || !exactArray(manifest?.runtimeContract?.sessionFunctions, PRIME_AGENT_SESSION_FUNCTIONS)
    || !exactRecord(manifest?.assets?.harnessConfigurations, PRIME_AGENT_ASSET_SHA256.harnessConfigurations)
    || manifest?.assets?.pythonPackageTreeSha256 !== PRIME_AGENT_ASSET_SHA256.pythonPackageTree
    || !exactRecord(
      manifest?.dependencyClosureSha256ByTarget,
      PRIME_AGENT_DEPENDENCY_CLOSURE_SHA256_BY_TARGET,
    )) {
    throw new Error("the bundled manifest contains an invalid runtime contract");
  }
}

function exactArray(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function exactRecord(actual, expected) {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  const keys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return exactArray(keys, expectedKeys) && keys.every((key) => actual[key] === expected[key]);
}
