import { createHash } from "node:crypto";
import { join } from "node:path";

import { PRIME_WHEEL_MANIFEST as PRIME_WHEELS } from "./prime-wheels.mjs";

const CLAUDE_SDK = Object.freeze({
  role: "sdk",
  package: "@anthropic-ai/claude-agent-sdk",
  version: "0.3.286",
  tarball: "https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.286.tgz",
  integrity: "sha512-InL/UNmRGSwBM/81PME0J0TZDsDBBlweWqRZgq2XSViSIg2hBi8nIL8j9Hm6MHRH85wgDJQE5n6Vo/r9hIO0NQ==",
});

const CLAUDE_NATIVE = Object.freeze({
  "macos-arm64": Object.freeze({
    package: "@anthropic-ai/claude-agent-sdk-darwin-arm64",
    tarball: "https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-darwin-arm64/-/claude-agent-sdk-darwin-arm64-0.3.286.tgz",
    integrity: "sha512-gkxWcJ+Z23UxwghI1V3dL09PkELIZmB2vPelR8XsdfhS+yP1KvoW7FThvRLojcxXb3fj0ddYawjQSQYIkXFbxw==",
    executable: "claude",
  }),
  "macos-x64": Object.freeze({
    package: "@anthropic-ai/claude-agent-sdk-darwin-x64",
    tarball: "https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-darwin-x64/-/claude-agent-sdk-darwin-x64-0.3.286.tgz",
    integrity: "sha512-eMdni7sy1ud2IISI4QSsfVBCxotzSe62zCGdXISejL9MxDIwcRgEGZpO5OV+j7t8mNGMTe6Opl1t/3Z/1RUJaQ==",
    executable: "claude",
  }),
  "windows-x64": Object.freeze({
    package: "@anthropic-ai/claude-agent-sdk-win32-x64",
    tarball: "https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-win32-x64/-/claude-agent-sdk-win32-x64-0.3.286.tgz",
    integrity: "sha512-pg35GRPBKyviod0i8Z3EVMzDnTiiiucuWUbyH1bVIFFN0UWCQQ+PRUJ15qrPKjL6+vlFxOX2ei9FfsWYjGYZwA==",
    executable: "claude.exe",
  }),
});

const CODEX_NATIVE = Object.freeze({
  "macos-arm64": Object.freeze({
    version: "0.159.3-darwin-arm64",
    tarball: "https://registry.npmjs.org/@openai/codex/-/codex-0.159.3-darwin-arm64.tgz",
    integrity: "sha512-aI4UY14YURYxJxnRK+AE4QU+aek0mgtyyo7Rw9rNbCQUYETRQ0NYdJzU9ytljERGpPlht3dHHI1u4NhqHoDJDQ==",
    vendor: "aarch64-apple-darwin",
    executable: "codex",
  }),
  "macos-x64": Object.freeze({
    version: "0.159.3-darwin-x64",
    tarball: "https://registry.npmjs.org/@openai/codex/-/codex-0.159.3-darwin-x64.tgz",
    integrity: "sha512-KTOQOD184DMXpR3TqnDUnLsgad14WJn+x3XmjBaXRHchKYGttjREwqrwzC61xQYFeh6VkogAceybR+SMbbgvYQ==",
    vendor: "x86_64-apple-darwin",
    executable: "codex",
  }),
  "windows-x64": Object.freeze({
    version: "0.159.3-win32-x64",
    tarball: "https://registry.npmjs.org/@openai/codex/-/codex-0.159.3-win32-x64.tgz",
    integrity: "sha512-h8w5nslfQyoYbonZaRlLwvPKFS9Mcxz5vUeCeoHKF5SsZUP9jSBH7hxUdc8RWJffJtfbV2qxdnImVAj9zy2fwA==",
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
    recipeId: "claude@0.3.286",
    runtimeId: "claude",
    version: "0.3.286",
    target,
    assembler: "npm-archives-v1",
    readinessContractVersion: 1,
    executableRelativePath: join("native", native.executable),
    moduleRelativePath: join("sdk", "sdk.mjs"),
    artifacts: [CLAUDE_SDK, {
      role: "native",
      package: native.package,
      version: "0.3.286",
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
    recipeId: "codex@0.159.3",
    runtimeId: "codex",
    version: "0.159.3",
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
      primeBridgeCommit: "3635b59066ebf4facf1a6d0285b005056644226b",
      javascript: {
        dependencyClosureSha256: "1253fd136c0d63e751fffdae68327a1b5cbb3176f2b9780de372744f8b83ef41",
        repositoryDependencyClosureSha256: "02f15fb2ce6366f1e9709e66336a94476dc6605bb8618885afea9e7d2e19766f",
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
          archiveSha256: "e1aaf66cb2c79c42f12920a4bc3faf02db34e42a26ac144571f2f987e8bbde9e",
          treeSha256: "7e6d1580a6b08b0ad37f52f5b38902705a93374def95bb603fbd7bbc33a3be6f",
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
          sha256: "486273b4697a08006ee4f03c616fdeb8c5e4489597762b74a150bed0ad457956",
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
  const recipe = recipeId === "claude@0.3.286"
    ? claudeRecipe(target)
    : recipeId === "codex@0.159.3"
      ? codexRecipe(target)
      : recipeId === "prime@0.8.1"
        ? primeRecipe(target)
      : null;
  if (!recipe) {
    throw Object.assign(new Error(`Unknown managed runtime recipe: ${recipeId} for ${target}.`), {
      code: "managed_runtime_unsupported_target",
    });
  }
  return recipe;
}
