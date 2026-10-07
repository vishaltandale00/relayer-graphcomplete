import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HarnessHost } from "../src/host.js";
import { digestHarnessConfiguration } from "../src/configuration.js";
import { createCodexBasicFactory } from "../src/implementations/codex-basic.js";
import { createPrimeAgentFactory } from "../src/implementations/prime-agent.js";
import type { HarnessConfiguration, HarnessExecutionAccess, HarnessModelPlan, HarnessRunContext } from "../src/types.js";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
afterEach(() => vi.unstubAllGlobals());

// The production host and adapters run; their native dependency seams do no paid inference.
describe("native session preview compatibility", () => {
  it.each([
    ["codex", "live"], ["codex", "saved"], ["prime", "live"], ["prime", "saved"],
  ] as const)("keeps the %s %s conversation while enabling previews and reopening", async (provider, mode) => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-native-preview-session-"));
    const stateFile = join(directory, "sessions.json");
    const implementation = provider === "codex" ? "codex.basic" : "prime.agent";
    const oldConfiguration: HarnessConfiguration = {
      schemaVersion: 1, name: provider === "codex" ? "codex-basic" : "prime-agent-basic", implementation, implementationVersion: 1, revision: 5,
      permissionBindings: { auto: {}, full: provider === "codex" ? { sandboxMode: "danger-full-access", approvalPolicy: "never" } : {} },
      executionAccessContracts: [provider === "codex" ? "managed-runtime@1" : "secret@1"],
      graphCapabilityProfile: { search: "query-v1" },
      settings: provider === "codex" ? { promptProfile: "layered-navigation-multi-agent-v1" } : {},
    };
    const previewConfiguration: HarnessConfiguration = {
      ...oldConfiguration, revision: 6, graphCapabilityProfile: { search: "query-v1", preview: "enabled" },
    };
    const model = { providerId: `${provider}-work`, adapterId: provider === "codex" ? "codex-subscription" : "openai-api", modelId: "model" };
    const access: HarnessExecutionAccess = provider === "codex" ? {
      kind: "managed-runtime", contract: "managed-runtime@1", ...model,
      adapterImplementationVersion: "1", runtimeId: "codex", version: "1", executable: "/managed/codex",
      environment: { CODEX_HOME: join(directory, "codex-home") },
    } : {
      kind: "secret", contract: "secret@1", ...model, adapterImplementationVersion: "2",
      endpoint: "https://api.openai.test/v1", fields: { "api-key": "fixture-only" },
    };
    const route = { ...model, accessContract: access.contract };
    const plan: HarnessModelPlan = { familyId: 1, familyRevision: 1, orchestrator: route, roster: [route] };
    const calls: { prompt: string; previewDirectory: string | undefined; nativeIdentity: string | undefined }[] = [];
    const scopes: HarnessRunContext["graph"][] = [];
    const openedFiles: string[] = [];
    let createdManagers = 0;
    let factoryCalls = 0;
    let accepted = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
      if (url.endsWith("/output")) return accepted
        ? json({ nodeId: 1, rootAction: null, rootLayer: { layer: { id: 3, nodes: [], edges: [], state: "accepted" }, nodes: [], edges: [], actions: [] } })
        : json({ error: { code: "completion_not_found" } }, 404);
      if (url.endsWith("/personal-presentation")) return json({ error: { code: "personal_presentation_not_attached" } }, 404);
      const node = { id: 1, kind: "user-interaction", icon: "user", title: "Question", detail: "Explain", state: "accepted" };
      return json(url.endsWith("/input") ? { interaction: node, contexts: [] } : { node });
    }));
    const record = async (call: typeof calls[number]) => {
      if (call.previewDirectory !== undefined) expect((await stat(call.previewDirectory)).isDirectory()).toBe(true);
      calls.push(call);
      accepted = true;
    };
    const factory = provider === "codex" ? createCodexBasicFactory({
      runAppServerTurn: async (options) => {
        await record({ prompt: options.prompt, previewDirectory: options.environment.RELAYER_GRAPH_PREVIEW_DIR, nativeIdentity: options.savedThreadId });
        const threadId = options.savedThreadId ?? "existing-codex-thread";
        await options.onThreadId(threadId);
        options.onTurnStarting?.(threadId);
        await options.onTurnId?.(threadId, `turn-${calls.length}`);
        return { threadId, turnId: `turn-${calls.length}`, status: "completed" };
      },
    }) : createPrimeAgentFactory({
      loadModule: async () => ({
        AGENT_RUN_MODEL_SCOPE_VERSION: 1, createAgentRunModelScope: (input: unknown) => input,
        SessionManager: {
          create: () => {
            const file = join(directory, `prime-session-${++createdManagers}.jsonl`);
            writeFileSync(file, "native fixture conversation\n");
            return file;
          },
          open: (file: string) => { openedFiles.push(file); return file; },
        },
        createHostRequestHandler: (handler: unknown) => handler,
        createAgentSessionServices: async () => ({ resourceLoader: { getAppendSystemPrompt: () => [] } }),
        createAgentSessionFromServices: async ({ sessionManager }: { sessionManager: string }) => ({ session: {
          sessionFile: sessionManager,
          promptAndWait: async (prompt: string, options: { runContext: { graph: HarnessRunContext["graph"] } }) => {
            const graph = options.runContext.graph;
            scopes.push(graph);
            await record({ prompt, previewDirectory: graph.acquireCapability().previewDirectory, nativeIdentity: sessionManager });
          },
          waitForRlmQuiescence: async () => {}, reload: async () => {}, abort: async () => {}, dispose: () => {}, disposeAsync: async () => {},
        } }),
      }) as never,
    });
    const openHost = async () => {
      const host = new HarnessHost({
        stateFile, controlToken: "control",
        draftPreviews: { token: "p".repeat(32), renderer: { render: async () => ({ png: PNG, width: 1, height: 1 }) } },
        accessBroker: { acquire: async () => ({ access, release: async () => {} }) },
        implementations: { [implementation]: (context) => { factoryCalls++; return factory(context); } },
      });
      await host.initialize();
      return host;
    };
    const register = (host: HarnessHost, configuration: HarnessConfiguration) => host.createSession({ threadId: 1, permissionProfileId: "full", workingDirectory: directory, configuration });
    const complete = async (host: HarnessHost, configuration: HarnessConfiguration, requireNativeContinuity = false) => {
      accepted = false;
      const id = calls.length + 1;
      const policy = { configurationRevision: configuration.revision!, configurationDigest: digestHarnessConfiguration(configuration), executionAccessContracts: configuration.executionAccessContracts! };
      const admissionId = `attempt-preview-${id}`;
      const admission = provider === "prime" ? await host.admitModelPlanExecution(1, id, admissionId, plan, new AbortController().signal, policy) : undefined;
      await host.complete(1, id, { url: "http://127.0.0.1:43123", token: "token", nodeId: 1 }, model, undefined,
        { productInteractionId: id, requireNativeContinuity }, admission?.executionLeaseId, provider === "prime" ? policy : undefined,
        provider === "prime" ? plan : undefined, admission === undefined ? undefined : admissionId);
      if (admission) await host.releaseProviderExecution(admission.executionLeaseId);
    };
    let host = await openHost();
    try {
      await register(host, oldConfiguration);
      await complete(host, oldConfiguration);
      const originalState = JSON.parse(await readFile(stateFile, "utf8")).sessions[0].state;
      const nativeIdentity = provider === "codex" ? originalState.codexThreadId : originalState.primeAgentSessionFile;
      expect(nativeIdentity).toBeTruthy();
      const nativeFile = provider === "prime" ? await readFile(nativeIdentity, "utf8") : undefined;
      const freshManagers = createdManagers;
      expect(calls[0]!.previewDirectory).toBeUndefined();
      expect(calls[0]!.prompt).not.toContain("Draft previews are on");
      if (provider === "codex") expect(calls[0]!.nativeIdentity).toBeUndefined();
      if (mode === "saved") { await host.close(); host = await openHost(); }
      const beforeUpgrade = await readFile(stateFile, "utf8");
      for (const changed of [
        { configuration: previewConfiguration, permissionProfileId: "auto", workingDirectory: directory },
        { configuration: previewConfiguration, permissionProfileId: "full", workingDirectory: join(directory, "other") },
        { configuration: { ...previewConfiguration, graphCapabilityProfile: { search: "disabled" as const, preview: "enabled" as const } }, permissionProfileId: "full", workingDirectory: directory },
      ]) {
        await expect(host.createSession({ threadId: 1, ...changed })).rejects.toThrow("already pinned");
        expect(await readFile(stateFile, "utf8")).toBe(beforeUpgrade);
        expect(calls).toHaveLength(1);
      }
      await register(host, previewConfiguration);
      expect(factoryCalls).toBe(mode === "live" ? 1 : 2);
      expect(JSON.parse(await readFile(stateFile, "utf8")).sessions[0]).toMatchObject({ configuration: previewConfiguration, state: originalState });
      await complete(host, previewConfiguration, true);
      const enabledState = await readFile(stateFile, "utf8");
      await expect(register(host, oldConfiguration)).rejects.toThrow("already pinned");
      expect(await readFile(stateFile, "utf8")).toBe(enabledState);
      await host.close(); host = await openHost();
      await register(host, previewConfiguration);
      await complete(host, previewConfiguration, true);
      expect(calls).toHaveLength(3);
      for (const call of calls.slice(1)) {
        expect(call.nativeIdentity).toBe(nativeIdentity);
        expect(call.prompt).toContain("Draft previews are on");
        expect(call.prompt).toContain(provider === "codex" ? "image viewing tool" : "attach_image");
        expect(call.previewDirectory).toBeTruthy();
        await expect(stat(call.previewDirectory!)).rejects.toThrow();
      }
      expect(new Set(calls.slice(1).map((call) => call.previewDirectory)).size).toBe(2);
      expect(JSON.parse(await readFile(stateFile, "utf8")).sessions[0].state).toEqual(originalState);
      if (provider === "prime") {
        expect(createdManagers).toBe(freshManagers);
        expect(openedFiles).toEqual(Array(mode === "saved" ? 2 : 1).fill(nativeIdentity));
        expect(await readFile(nativeIdentity, "utf8")).toBe(nativeFile);
        for (const scope of scopes) expect(() => scope.acquireCapability()).toThrow();
      }
    } finally { await host.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
