import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Codex, type CodexOptions, type ModelReasoningEffort, type UserInput } from "@openai/codex-sdk";

// Native Codex owns inference. Eval only supplies successive visible user states;
// it does not schedule candidate agents or recursively execute graph work.
export async function createRestrictedCodexActor({ runtime, config, prompt, outputSchema, createCodex = (options) => new Codex(options) }: {
  runtime: { executable: string; environment: Record<string, string | undefined> };
  config: { model: string; modelReasoningEffort: ModelReasoningEffort };
  prompt: string;
  outputSchema: Record<string, unknown>;
  createCodex?: (options: CodexOptions) => Pick<Codex, "startThread">;
}) {
  const cwd = await mkdtemp(join(tmpdir(), "relayer-task-actor-"));
  try {
    const environment: Record<string, string> = {};
    for (const [key, value] of Object.entries(runtime.environment)) {
      if (value !== undefined && ["CODEX_HOME", "HOME", "PATH", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP", "SSL_CERT_DIR", "SSL_CERT_FILE"].includes(key)) environment[key] = value;
    }
    const codex = createCodex({ codexPathOverride: runtime.executable, env: environment, config: {
      features: { apps: false, browser_use: false, computer_use: false, image_generation: false, shell_tool: false, unified_exec: false, skill_search: false, view_image: false, multi_agent: false },
      mcp_servers: {},
    } });
    const thread = codex.startThread({ model: config.model, modelReasoningEffort: config.modelReasoningEffort,
      workingDirectory: cwd, skipGitRepoCheck: true, sandboxMode: "read-only", approvalPolicy: "never", networkAccessEnabled: false, webSearchMode: "disabled", additionalDirectories: [] });
    let first = true;
    let capture = 0;
    return {
      async decide(observation: { screenshot?: string; [key: string]: unknown }, signal?: AbortSignal, options?: { outputSchema: Record<string, unknown> }) {
        const { screenshot, ...visible } = observation;
        const input: UserInput[] = [{ type: "text", text: `${first ? `${prompt}\n\n` : ""}Current workspace:\n${JSON.stringify(visible)}` }];
        if (screenshot) {
          const path = join(cwd, `view-${++capture}.png`);
          await writeFile(path, Buffer.from(screenshot, "base64"), { mode: 0o600 });
          input.push({ type: "local_image", path });
        }
        signal?.throwIfAborted();
        const result = await thread.run(input, { ...(signal ? { signal } : {}), outputSchema: options?.outputSchema ?? outputSchema });
        first = false;
        if (result.items?.some((item) => ["command_execution", "file_change", "mcp_tool_call", "web_search"].includes(item.type))) throw new Error("Actor attempted a forbidden tool.");
        return { action: JSON.parse(result.finalResponse), usage: result.usage ?? null };
      },
      close: () => rm(cwd, { recursive: true, force: true }),
    };
  } catch (error) { await rm(cwd, { recursive: true, force: true }); throw error; }
}
