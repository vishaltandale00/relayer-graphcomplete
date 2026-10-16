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
    async function run(observation: { screenshot?: string; [key: string]: unknown }, schema: Record<string, unknown>, instruction: string, signal?: AbortSignal) {
      const { screenshot, ...visible } = observation;
      const input: UserInput[] = [{ type: "text", text: `${first ? `${prompt}\n\n` : ""}${instruction}\n${JSON.stringify(visible)}` }];
      if (screenshot) {
        const path = join(cwd, `view-${++capture}.png`);
        await writeFile(path, Buffer.from(screenshot, "base64"), { mode: 0o600 });
        input.push({ type: "local_image", path });
      }
      signal?.throwIfAborted();
      const result = await thread.run(input, { ...(signal ? { signal } : {}), outputSchema: schema });
      first = false;
      if (result.items?.some((item) => ["command_execution", "file_change", "mcp_tool_call", "web_search"].includes(item.type))) throw new Error("Actor attempted a forbidden tool.");
      return { result: JSON.parse(result.finalResponse), usage: result.usage ?? null };
    }
    return {
      async observe(observation: { screenshot?: string; [key: string]: unknown }, signal?: AbortSignal, options?: { actionSchema: Record<string, unknown> }) {
        const canAct = Array.isArray(observation.availableActions) && observation.availableActions.length > 0 && options?.actionSchema;
        const schema = { type: "object", additionalProperties: false,
          properties: { comment: { type: "string" }, ...(canAct ? { action: { anyOf: [options.actionSchema, { type: "null" }] } } : {}) },
          required: canAct ? ["comment", "action"] : ["comment"] };
        const { result, usage } = await run(observation, schema,
        "The response is still working. Look at this update as the user, remembering only earlier observations. Briefly say what it tells you, what is unclear, or whether it changes your understanding. This is your experience, not a grade or advice to the agent. " + (canAct
          ? "You may choose one available visible-control action to answer a question using its Answer button, or action:null to keep watching. Do not use Send, start another completion, finish, or click Stop while answering. A working update is not the final result. Return {comment, action}."
          : "No action is available for this observation. Return only {comment: string}."), signal);
        if (!result || typeof result.comment !== "string" || result.comment.length > 8000 || Object.keys(result).some(key => !["comment", ...(canAct ? ["action"] : [])].includes(key))) throw new Error("Actor returned an invalid current-update reaction.");
        return { comment: result.comment, ...(canAct ? { action: result.action } : {}), usage };
      },
      async decide(observation: { screenshot?: string; [key: string]: unknown }, signal?: AbortSignal, options?: { outputSchema: Record<string, unknown> }) {
        const { result, usage } = await run(observation, options?.outputSchema ?? outputSchema, "Current workspace:", signal);
        return { action: result, usage };
      },
      close: () => rm(cwd, { recursive: true, force: true }),
    };
  } catch (error) { await rm(cwd, { recursive: true, force: true }); throw error; }
}
