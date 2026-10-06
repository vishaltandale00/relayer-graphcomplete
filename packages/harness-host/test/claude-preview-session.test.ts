import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HarnessHost } from "../src/host.js";
import { digestHarnessConfiguration } from "../src/configuration.js";
import {
  CLAUDE_PREVIEW_TOOL,
  createClaudeBasicFactory,
  type ClaudeSdkModule,
  type ClaudeSdkQuery,
} from "../src/implementations/claude-basic.js";
import type { ClaudeSdkToolResult } from "../src/implementations/claude-basic-browser.js";
import type { HarnessConfiguration, HarnessExecutionAccess } from "../src/types.js";

const oldConfiguration: HarnessConfiguration = {
  schemaVersion: 1,
  name: "claude-basic",
  implementation: "claude.basic",
  implementationVersion: 1,
  revision: 3,
  permissionBindings: { auto: { approvalMode: "acceptEdits" }, full: { approvalMode: "bypassPermissions" } },
  executionAccessContracts: ["managed-runtime@1"],
  graphCapabilityProfile: { search: "query-v1" },
  settings: {},
};
const previewConfiguration: HarnessConfiguration = {
  ...oldConfiguration,
  revision: 4,
  graphCapabilityProfile: { search: "query-v1", preview: "enabled" },
};
const model = { providerId: "claude-work", adapterId: "claude-subscription", modelId: "opus" };
const access: HarnessExecutionAccess = {
  kind: "managed-runtime",
  contract: "managed-runtime@1",
  providerId: model.providerId,
  adapterId: model.adapterId,
  adapterImplementationVersion: "1",
  runtimeId: "claude-code", version: "0.3.286", executable: "/managed/claude",
  moduleUrl: "file:///managed/sdk.mjs", environment: { CLAUDE_CONFIG_DIR: "/isolated/claude-work" },
};
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);

afterEach(() => vi.unstubAllGlobals());

describe("Claude session preview compatibility", () => {
  it.each(["live", "saved"] as const)("keeps the %s native session while enabling previews, then reopens it", async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-claude-preview-session-"));
    const stateFile = join(directory, "sessions.json");
    let accepted = false;
    let factoryCalls = 0;
    const calls: Parameters<ClaudeSdkQuery>[0][] = [];
    const folders: string[] = [];
    const viewed: ClaudeSdkToolResult[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
        status, headers: { "content-type": "application/json" },
      });
      if (url.endsWith("/output")) return accepted
        ? json({ nodeId: 1, rootAction: null, rootLayer: { layer: { id: 3, nodes: [], edges: [], state: "accepted" }, nodes: [], edges: [], actions: [] } })
        : json({ error: { code: "completion_not_found" } }, 404);
      if (url.endsWith("/personal-presentation")) return json({ error: { code: "personal_presentation_not_attached" } }, 404);
      const node = { id: 1, kind: "user-interaction", icon: "user", title: "Question", detail: "Explain", state: "accepted" };
      return json(url.endsWith("/input") ? { interaction: node, contexts: [] } : { node });
    }));
    const browserSdk: Pick<ClaudeSdkModule, "tool" | "createSdkMcpServer"> = {
      tool: ((name: string, description: string, inputSchema: unknown, handler: unknown) => ({ name, description, inputSchema, handler })) as ClaudeSdkModule["tool"],
      createSdkMcpServer: ((options: unknown) => ({ type: "sdk", options })) as ClaudeSdkModule["createSdkMcpServer"],
    };
    const query: ClaudeSdkQuery = ((input) => {
      calls.push(input);
      return (async function* () {
        const folder = input.options.env.RELAYER_GRAPH_PREVIEW_DIR;
        if (folder !== undefined) {
          folders.push(folder);
          expect((await stat(folder)).isDirectory()).toBe(true);
          const path = join(folder, "layer-3.png");
          await writeFile(path, PNG);
          const server = input.options.mcpServers.relayer_graph_preview as {
            options: { tools: { handler: (input: { path: string }, extra: unknown) => Promise<ClaudeSdkToolResult> }[] };
          };
          viewed.push(await server.options.tools[0]!.handler({ path }, {}));
        }
        accepted = true;
        yield { type: "result", subtype: "success", result: "done", session_id: "existing-claude-session" };
      })();
    }) as ClaudeSdkQuery;
    const factory = createClaudeBasicFactory({ query, browserSdk });
    const openHost = async () => {
      const host = new HarnessHost({
        stateFile, controlToken: "control",
        draftPreviews: { token: "p".repeat(32), renderer: { render: async () => ({ png: PNG, width: 1, height: 1 }) } },
        accessBroker: { acquire: async () => ({ access, release: async () => {} }) },
        implementations: { "claude.basic": (context) => { factoryCalls += 1; return factory(context); } },
      });
      await host.initialize();
      return host;
    };
    const register = (host: HarnessHost, configuration: HarnessConfiguration) => host.createSession({
      threadId: 1, permissionProfileId: "auto", workingDirectory: directory, configuration,
    });
    const complete = async (host: HarnessHost, requireNativeContinuity = false) => {
      accepted = false;
      await host.complete(1, calls.length + 1, { url: "http://127.0.0.1:43123", token: "token", nodeId: 1 }, model, undefined, { productInteractionId: calls.length + 1, requireNativeContinuity });
    };
    let host = await openHost();
    try {
      await register(host, oldConfiguration);
      await complete(host);
      const originalState = JSON.parse(await readFile(stateFile, "utf8")).sessions[0].state;
      expect(originalState.claudeSessionId).toBe("existing-claude-session");
      expect(calls[0]!.options.resume).toBeUndefined();
      expect(calls[0]!.options.mcpServers).not.toHaveProperty("relayer_graph_preview");
      if (mode === "saved") {
        await host.close();
        host = await openHost();
      }
      const beforeUpgrade = await readFile(stateFile, "utf8");
      for (const changed of [
        { configuration: previewConfiguration, permissionProfileId: "full", workingDirectory: directory },
        { configuration: previewConfiguration, permissionProfileId: "auto", workingDirectory: join(directory, "other") },
        { configuration: { ...previewConfiguration, graphCapabilityProfile: { search: "disabled" as const, preview: "enabled" as const } }, permissionProfileId: "auto", workingDirectory: directory },
      ]) {
        await expect(host.createSession({ threadId: 1, ...changed })).rejects.toThrow("already pinned");
        expect(await readFile(stateFile, "utf8")).toBe(beforeUpgrade);
        expect(calls).toHaveLength(1);
      }
      await register(host, previewConfiguration);
      expect(factoryCalls).toBe(mode === "live" ? 1 : 2);
      expect(JSON.parse(await readFile(stateFile, "utf8")).sessions[0]).toMatchObject({
        configuration: previewConfiguration, state: originalState,
      });
      expect(digestHarnessConfiguration(previewConfiguration)).not.toBe(digestHarnessConfiguration(oldConfiguration));
      await complete(host, true);
      await host.close();
      host = await openHost();
      await register(host, previewConfiguration);
      await complete(host, true);
      expect(calls).toHaveLength(3);
      for (const call of calls.slice(1)) {
        expect(call.options.resume).toBe("existing-claude-session");
        expect(call.options.allowedTools).toContain(CLAUDE_PREVIEW_TOOL);
        expect(call.prompt).toContain("Draft previews are on");
      }
      expect(viewed).toEqual(Array(2).fill({ content: [{ type: "image", data: Buffer.from(PNG).toString("base64"), mimeType: "image/png" }] }));
      expect(new Set(folders).size).toBe(2);
      for (const folder of folders) await expect(stat(folder)).rejects.toThrow();
      expect(JSON.parse(await readFile(stateFile, "utf8")).sessions[0].state).toEqual(originalState);
    } finally {
      await host.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
