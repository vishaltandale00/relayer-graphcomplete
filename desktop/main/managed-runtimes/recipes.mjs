import { createHash } from "node:crypto";
import { join } from "node:path";

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

export function resolveManagedRuntimeRecipe(recipeId, target) {
  const recipe = recipeId === "claude@0.3.250"
    ? claudeRecipe(target)
    : recipeId === "codex@0.147.0"
      ? codexRecipe(target)
      : null;
  if (!recipe) throw new Error(`Unknown managed runtime recipe: ${recipeId} for ${target}.`);
  return recipe;
}
