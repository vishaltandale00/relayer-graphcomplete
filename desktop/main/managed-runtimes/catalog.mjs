const TARGETS = Object.freeze({
  "darwin-arm64": Object.freeze({
    key: "macos-arm64",
    claudePackage: "@anthropic-ai/claude-agent-sdk-darwin-arm64",
    claudeExecutable: "claude",
    codexAlias: "@openai/codex-darwin-arm64",
    codexSuffix: "darwin-arm64",
    codexVendor: "aarch64-apple-darwin",
    codexExecutable: "codex",
  }),
  "darwin-x64": Object.freeze({
    key: "macos-x64",
    claudePackage: "@anthropic-ai/claude-agent-sdk-darwin-x64",
    claudeExecutable: "claude",
    codexAlias: "@openai/codex-darwin-x64",
    codexSuffix: "darwin-x64",
    codexVendor: "x86_64-apple-darwin",
    codexExecutable: "codex",
  }),
  "win32-x64": Object.freeze({
    key: "windows-x64",
    claudePackage: "@anthropic-ai/claude-agent-sdk-win32-x64",
    claudeExecutable: "claude.exe",
    codexAlias: "@openai/codex-win32-x64",
    codexSuffix: "win32-x64",
    codexVendor: "x86_64-pc-windows-msvc",
    codexExecutable: "codex.exe",
  }),
});

export function managedRuntimeTarget({ platform = process.platform, architecture = process.arch } = {}) {
  const target = TARGETS[`${platform}-${architecture}`];
  if (!target) throw new Error(`Unsupported managed runtime target: ${platform}-${architecture}.`);
  return target;
}

export const MANAGED_RUNTIME_IDS = Object.freeze(["claude", "codex"]);

