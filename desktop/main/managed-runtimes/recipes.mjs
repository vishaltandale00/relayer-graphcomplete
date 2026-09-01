import { createHash } from "node:crypto";
import { join } from "node:path";

import { PRIME_WHEEL_MANIFEST as PRIME_WHEELS } from "./prime-wheels.mjs";

const CLAUDE_SDK = Object.freeze({
  role: "sdk",
  package: "@anthropic-ai/claude-agent-sdk",
  version: "0.3.250",
  tarball: "https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.250.tgz",
  integrity: "sha512-qT/1cBZs0+xPsQfqVOnwIk6pNW8XBkTpQS5RAXKHYb2XYCKqYc0UmOaeiYU2WeI6HEZKORa5iCaAZyKWGluShw==",
});

const CLAUDE_NATIVE = Object.freeze({
  "macos-arm64": Object.freeze({
    package: "@anthropic-ai/claude-agent-sdk-darwin-arm64",
    tarball: "https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-darwin-arm64/-/claude-agent-sdk-darwin-arm64-0.3.250.tgz",
    integrity: "sha512-tcekW4gR2UH0Q3COBaNPQIdud2lKEbs0HfG2yNKC18hXFPpgbuLCdjq0ndS1lcvC1q8ncPW3oQPUutQt3StICQ==",
    executable: "claude",
  }),
  "macos-x64": Object.freeze({
    package: "@anthropic-ai/claude-agent-sdk-darwin-x64",
    tarball: "https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-darwin-x64/-/claude-agent-sdk-darwin-x64-0.3.250.tgz",
    integrity: "sha512-8Yxmmi76oVEIam+oRgxcL2RtqEkKX9Gp4rh500HmMltjX3Tk/ryjCoJEHoaUdU/LU6vWvfQU5W+dB/SJCQQb2A==",
    executable: "claude",
  }),
  "windows-x64": Object.freeze({
    package: "@anthropic-ai/claude-agent-sdk-win32-x64",
    tarball: "https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-win32-x64/-/claude-agent-sdk-win32-x64-0.3.250.tgz",
    integrity: "sha512-PjJRbJwDHccSUWls5gTiuXMgERit1WrrMQzzRqhhBHGzrlQueHVodrpg7HaN5gtirADJzfINcc7azq8j3qcEYw==",
    executable: "claude.exe",
  }),
});

const CODEX_NATIVE = Object.freeze({
  "macos-arm64": Object.freeze({
    version: "0.147.0-darwin-arm64",
    tarball: "https://registry.npmjs.org/@openai/codex/-/codex-0.147.0-darwin-arm64.tgz",
    integrity: "sha512-BEUVkiOW7kLcRyrMLfAr/h9wF8sRVJyZDy6OHtVn6QGDXiv3BvAZVTY1Pu9xF7KdIdkYXbp4uayN0aDQQaAUJw==",
    vendor: "aarch64-apple-darwin",
    executable: "codex",
  }),
  "macos-x64": Object.freeze({
    version: "0.147.0-darwin-x64",
    tarball: "https://registry.npmjs.org/@openai/codex/-/codex-0.147.0-darwin-x64.tgz",
    integrity: "sha512-Tb8McE5SvJIH0Vs5R6sq7u+quiC931yan2KOOl6km1OdZ82+Wi7eF5XrSFPs5CF7xCgoIK4Vs+byMbT5hN+ZUw==",
    vendor: "x86_64-apple-darwin",
    executable: "codex",
  }),
  "windows-x64": Object.freeze({
    version: "0.147.0-win32-x64",
    tarball: "https://registry.npmjs.org/@openai/codex/-/codex-0.147.0-win32-x64.tgz",
    integrity: "sha512-oT7Ss5fAPf2fiWE9QNURqZcQGAAawSVxmIUdgPzckq4KFZAM+pRz9JbM4Rr498CjtbNgTOjWvDJ+DXvIBSfOPA==",
    vendor: "x86_64-pc-windows-msvc",
    executable: "codex.exe",
  }),
});

function seal(recipe) {
  const recipeDigest = createHash("sha256").update(JSON.stringify(recipe)).digest("hex");
  return Object.freeze({
    ...recipe,
    artifacts: Object.freeze(recipe.artifacts.map((artifact) => Object.freeze({ ...artifact }))),
    recipeDigest,
  });
}

function claudeRecipe(target) {
  const native = CLAUDE_NATIVE[target];
  if (!native) return null;
  return seal({
    schemaVersion: 1,
    recipeId: "claude@0.3.250",
    runtimeId: "claude",
    version: "0.3.250",
    target,
    assembler: "npm-archives-v1",
    readinessContractVersion: 1,
    executableRelativePath: join("native", native.executable),
    moduleRelativePath: join("sdk", "sdk.mjs"),
    artifacts: [CLAUDE_SDK, {
      role: "native",
      package: native.package,
      version: "0.3.250",
      tarball: native.tarball,
      integrity: native.integrity,
    }],
  });
}

function codexRecipe(target) {
  const native = CODEX_NATIVE[target];
  if (!native) return null;
  return seal({
    schemaVersion: 1,
    recipeId: "codex@0.147.0",
    runtimeId: "codex",
    version: "0.147.0",
    target,
    assembler: "npm-archives-v1",
    readinessContractVersion: 1,
    executableRelativePath: join("native", "vendor", native.vendor, "bin", native.executable),
    moduleRelativePath: null,
    artifacts: [{
      role: "native",
      package: "@openai/codex",
      version: native.version,
      tarball: native.tarball,
      integrity: native.integrity,
    }],
  });
}

function primeRecipe(target) {
  if (target !== "macos-arm64") return null;
  const wheels = PRIME_WHEELS.wheels.map((wheel, index) => ({
    role: `wheel-${String(index).padStart(2, "0")}`,
    artifactId: `wheel:${wheel.filename}`,
    package: wheel.package,
    version: wheel.version,
    kind: "wheel",
    filename: wheel.filename,
    tarball: wheel.url,
    sha256: wheel.sha256,
    size: wheel.size,
  }));
  const wheelArtifactIds = wheels.map(({ artifactId }) => artifactId);
  const requirements = PRIME_WHEELS.wheels.map(({ package: name, version }) => `${name}==${version}`);
  return seal({
    schemaVersion: 1,
    recipeId: "prime@0.8.1",
    runtimeId: "prime",
    version: "0.8.1",
    target,
    assembler: "prime-managed-kernel-v1",
    readinessContractVersion: 1,
    executableRelativePath: join("bin", "python"),
    moduleRelativePath: join("js", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js"),
    runtimeContract: {
      primeSourceCommit: "f6130839ad3043f1cd3d5294fe03023035bfcd5c",
      primeBridgeCommit: "8f33cfc30a3ce5f52f158122f34d523418aeca3e",
      javascript: {
        dependencyClosureSha256: "8c86ed5c66b6022559fb9903426fec212a757bd4837eff2f7dafea6fe1f54062",
        repositoryDependencyClosureSha256: "afd4e30957510486bc8ca473a41a616313783a4243000bb32f5f2536797b5af6",
        packages: [{
          name: "@earendil-works/pi-agent-core", version: "0.8.1",
          archiveSha256: "56d1bc00321a310c9e75c0ca33a6241fec0f559c514a046acc1d68d1c7be4f08",
          treeSha256: "16223dfa60386a61d143c4cbdd4dcfe0316c2962844219e432426151ef4b8954",
        }, {
          name: "@earendil-works/pi-ai", version: "0.8.1",
          archiveSha256: "7560b021e023be9b39f376ba497cf64b9e54b2adb8be3d73b031f0033c4dd700",
          treeSha256: "2bbbd8b3207c9d5c21bfc274023dab7a9fd2755ac6c05c6a9be6d8c19f635704",
        }, {
          name: "@earendil-works/pi-coding-agent", version: "0.8.1",
          archiveSha256: "a5608c3d617d345a4f1315e9f314c61dfb047c0741d41d0d3eb918ba2c082aaf",
          treeSha256: "93cf3da2c0777fd7cf88db0e7a524895625c6c2507541eaeb3d6f325ab4ee89f",
        }, {
          name: "@earendil-works/pi-tui", version: "0.8.1",
          archiveSha256: "40517b0d5600557a31e395a0c344dbb9af7d3f8c000bea65561ef81b83142507",
          treeSha256: "f86a8ab553edaf05e1fc4f4d6cb48c313e5a93f2f3490f74e510661c52d74447",
        }],
      },
      uv: { version: "0.12.0", artifactId: "uv", executableRelativePath: "uv/uv" },
      python: {
        version: "3.11.16+20260825",
        artifactId: "python",
        executableRelativePath: "python/bin/python3",
        onlyBinary: true,
        wheelArtifactIds,
        requirements,
        client: {
          sha256: "4b959d81101a456c1e69ff5ad810944648a438f7934b52847247e34ef2093c75",
          installRule: "copy-package-v1",
        },
      },
    },
    artifacts: [{
      role: "uv", artifactId: "uv", package: "uv", version: "0.12.0", kind: "tar.gz",
      filename: "uv-aarch64-apple-darwin.tar.gz",
      tarball: "https://github.com/astral-sh/uv/releases/download/0.12.0/uv-aarch64-apple-darwin.tar.gz",
      sha256: "2b9e582af54f84fa50c115427451a6c13e80f43b52f8282b8af5791077317bbf", size: 17387877,
    }, {
      role: "python", artifactId: "python", package: "cpython", version: "3.11.16+20260825", kind: "tar.gz",
      filename: "cpython-3.11.16+20260825-aarch64-apple-darwin-install_only.tar.gz",
      tarball: "https://github.com/astral-sh/python-build-standalone/releases/download/20260825/cpython-3.11.16%2B20260825-aarch64-apple-darwin-install_only.tar.gz",
      sha256: "2e50ed6ec49d8714a83c093e9ce74e1b8b21a2c64a49c3b603471d9c4caac76b", size: 27239363,
    }, ...wheels],
  });
}

export function resolveManagedRuntimeRecipe(recipeId, target) {
  const recipe = recipeId === "claude@0.3.250"
    ? claudeRecipe(target)
    : recipeId === "codex@0.147.0"
      ? codexRecipe(target)
      : recipeId === "prime@0.8.1"
        ? primeRecipe(target)
      : null;
  if (!recipe) throw new Error(`Unknown managed runtime recipe: ${recipeId} for ${target}.`);
  return recipe;
}
