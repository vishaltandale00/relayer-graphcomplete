// PRD AGT-013 to AGT-017: an API-key provider keeps a new conversation's native state in its own
// private home. A conversation saved before these homes keeps the home it already used (#584).
//
// Each case runs the production chain: provider runtime dependencies, the adapter registry, the
// execution access broker, the harness host with its state file, and the harness with the
// production runtime descriptor. Only the native process is fake: Codex's spawn and Claude's SDK
// query record what they would have run, and fail the turn there.
import { access, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  productionHarnessRuntimeDescriptor,
  productionProviderAdapterRegistry,
  productionProviderRuntimeDependencies,
} from "../desktop/main/providers/provider-adapter-registry.mjs";
import { createProviderRuntimeStateRemover } from "../desktop/main/providers/provider-runtime-state.mjs";
import { createProviderExecutionAccessBroker } from "../desktop/main/services/graphcomplete-runtime.mjs";
import { HarnessHost } from "../packages/harness-host/src/host.ts";
import { runCodexAppServerTurn } from "../packages/harness-host/src/implementations/codex-app-server.ts";
import { CodexBasicHarness } from "../packages/harness-host/src/implementations/codex-basic.ts";
import { ClaudeBasicHarness } from "../packages/harness-host/src/implementations/claude-basic.ts";

// Any regular file: the fake spawn and SDK query never run it.
const FAKE_EXECUTABLE = fileURLToPath(import.meta.url);
const CODEX_ADAPTERS = ["openai-api", "openrouter", "vercel-ai-router"];

let profile;
let userHome;
let runtimeRoot;
let processEnvironment;
let spawns;
let codexTurns;
let claudeQueries;

beforeEach(async () => {
  profile = await mkdtemp(join(tmpdir(), "relayer-api-key-homes-"));
  userHome = join(profile, "user-home");
  runtimeRoot = join(profile, "userData", "provider-runtimes");
  // The user's own native homes, each holding a conversation Relayer must never touch.
  await mkdir(join(userHome, ".codex", "sessions"), { recursive: true });
  await writeFile(join(userHome, ".codex", "sessions", "rollout.jsonl"), "user-codex-history");
  await mkdir(join(userHome, ".claude", "projects"), { recursive: true });
  await writeFile(join(userHome, ".claude", "projects", "session.jsonl"), "user-claude-history");
  // What Electron main's process.env may hold, including stray native home overrides.
  processEnvironment = {
    HOME: userHome,
    PATH: "/usr/bin:/bin",
    TMPDIR: tmpdir(),
    CODEX_HOME: join(userHome, ".codex-custom"),
    CLAUDE_CONFIG_DIR: join(userHome, ".claude-custom"),
  };
  spawns = [];
  codexTurns = [];
  claudeQueries = [];
  stubGraph();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(profile, { recursive: true, force: true });
});

describe("API-key provider native homes", () => {
  it.each(CODEX_ADAPTERS)("runs a new %s conversation in the provider's private CODEX_HOME", async (adapterId) => {
    const provider = await connectProvider(adapterId, { runtimeRoot });
    const host = await startHost(provider);
    await host.createSession(codexSession());

    await runRootTurn(host, provider, 1);
    await host.close();

    const home = join(runtimeRoot, provider.definition.id, "codex-home");
    // Access carries only the provider's home. The harness resolves the managed runtime itself.
    const acquired = await provider.broker.acquire(
      { providerId: provider.definition.id, adapterId, modelId: "model-test" },
      ["secret@1"],
      new AbortController().signal,
    );
    expect(acquired.access.environment).toEqual({ CODEX_HOME: home });
    expect(acquired.access).not.toHaveProperty("runtime");
    await acquired.release();
    expect(spawns).toHaveLength(1);
    const [{ executable, env }] = spawns;
    expect(executable).toBe(FAKE_EXECUTABLE);
    expect(env.CODEX_HOME).toBe(home);
    expect(relative(userHome, env.CODEX_HOME).startsWith("..")).toBe(true);
    // The native credential store still resolves through the real user home.
    expect(env.HOME).toBe(userHome);
    expect(env.OPENAI_API_KEY).toBe("sk-provider-secret");
    // Codex authenticates from the environment: nothing is written into the home (AGT-017).
    await expect(readdir(home)).resolves.toEqual([]);
    await expectUserHomesUntouched();
  });

  it("runs a new anthropic-api conversation in the provider's private CLAUDE_CONFIG_DIR", async () => {
    const provider = await connectProvider("anthropic-api", { runtimeRoot });
    const host = await startHost(provider);
    await host.createSession(claudeSession());

    await runRootTurn(host, provider, 1);
    await host.close();

    const home = join(runtimeRoot, provider.definition.id, "claude-home");
    expect(claudeQueries).toHaveLength(1);
    const [{ options }] = claudeQueries;
    expect(options.pathToClaudeCodeExecutable).toBe(FAKE_EXECUTABLE);
    expect(options.env.CLAUDE_CONFIG_DIR).toBe(home);
    expect(options.env.HOME).toBe(userHome);
    expect(options.env.ANTHROPIC_API_KEY).toBe("sk-provider-secret");
    await expect(access(home)).resolves.toBeUndefined();
    await expectUserHomesUntouched();
  });

  it("keeps a legacy Codex conversation in the shared default home and resumes its thread", async () => {
    const provider = await connectProvider("openai-api", { runtimeRoot });
    // An earlier release saved this conversation, whose rollout is in the user's ~/.codex.
    await saveEarlierReleaseState(provider, codexSession(), {
      codexThreadId: "legacy-thread",
      codexThreadPersonalPresentationVersionId: null,
      codexThreadProviderDefinitionId: provider.definition.id,
    });

    const host = await startHost(provider);
    await host.createSession(codexSession());
    await runRootTurn(host, provider, 2);
    await host.close();

    expect(codexTurns.map(({ savedThreadId }) => savedThreadId)).toEqual(["legacy-thread"]);
    expect(spawns[0].env).not.toHaveProperty("CODEX_HOME");
    expect(spawns[0].env.HOME).toBe(userHome);
    await expectUserHomesUntouched();
  });

  it("keeps a legacy Claude conversation in the shared default home and resumes its session", async () => {
    const provider = await connectProvider("anthropic-api", { runtimeRoot });
    await saveEarlierReleaseState(provider, claudeSession(), {
      claudeSessionId: "legacy-session",
      claudeSessionProviderDefinitionId: provider.definition.id,
      claudeSessionPersonalPresentationVersionId: null,
    });

    const host = await startHost(provider);
    await host.createSession(claudeSession());
    await runRootTurn(host, provider, 2);
    await host.close();

    expect(claudeQueries.map(({ options }) => options.resume)).toEqual(["legacy-session"]);
    expect(claudeQueries[0].options.env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
    expect(claudeQueries[0].options.env.HOME).toBe(userHome);
  });

  it("keeps each conversation's home across restarts, including one that never ran a turn", async () => {
    const provider = await connectProvider("openai-api", { runtimeRoot });
    const newConversation = codexSession(1);
    const legacyConversation = codexSession(2);
    await saveEarlierReleaseState(provider, legacyConversation, {
      codexThreadId: "legacy-thread",
      codexThreadPersonalPresentationVersionId: null,
      codexThreadProviderDefinitionId: provider.definition.id,
    });

    // The new conversation is created, then the app quits before its first turn.
    const first = await startHost(provider);
    await first.createSession(newConversation);
    await first.createSession(legacyConversation);
    await runRootTurn(first, provider, 20, legacyConversation.threadId);
    await first.close();
    expect(await persistedStates()).toEqual({
      1: { codexProviderHome: "isolated" },
      2: expect.objectContaining({ codexThreadId: "legacy-thread" }),
    });
    // The legacy conversation's state gains no marker: a missing one is what keeps it legacy.
    expect((await persistedStates())[2]).not.toHaveProperty("codexProviderHome");

    const restarted = await startHost(provider);
    await restarted.createSession(newConversation);
    await restarted.createSession(legacyConversation);
    await runRootTurn(restarted, provider, 10, newConversation.threadId);
    await runRootTurn(restarted, provider, 21, legacyConversation.threadId);
    await restarted.close();

    expect(spawns.map(({ env }) => env.CODEX_HOME ?? "default")).toEqual([
      "default",
      join(runtimeRoot, provider.definition.id, "codex-home"),
      "default",
    ]);
    expect(codexTurns.map(({ savedThreadId }) => savedThreadId)).toEqual(["legacy-thread", undefined, "legacy-thread"]);
  });

  it.each([
    ["openai-api", "CODEX_HOME"],
    ["anthropic-api", "CLAUDE_CONFIG_DIR"],
  ])("refuses a new %s conversation when the composition gave the provider no private home", async (adapterId, variable) => {
    // A composition that passes no provider runtime root gives the provider no home.
    const provider = await connectProvider(adapterId, {});
    const host = await startHost(provider);
    await host.createSession(adapterId === "anthropic-api" ? claudeSession() : codexSession());

    const failure = await runRootTurn(host, provider, 1);
    await host.close();

    const harness = adapterId === "anthropic-api" ? "claude.basic" : "codex.basic";
    expect(failure?.message).toBe(`${harness} requires the API-key provider's private ${variable}`);
    expect(spawns).toEqual([]);
    expect(claudeQueries).toEqual([]);
    await expectUserHomesUntouched();
  });

  it.each(["runtime root", "provider directory", "home"])("refuses a private home whose %s is a symlink out of Relayer's data", async (linked) => {
    const providerRoot = join(runtimeRoot, "openai-api-work");
    if (linked === "runtime root") {
      await mkdir(join(profile, "userData"), { recursive: true });
      await symlink(userHome, runtimeRoot);
    } else if (linked === "provider directory") {
      await mkdir(runtimeRoot, { recursive: true });
      await symlink(userHome, providerRoot);
    } else {
      await mkdir(providerRoot, { recursive: true });
      await symlink(join(userHome, ".codex"), join(providerRoot, "codex-home"));
    }

    await expect(connectProvider("openai-api", { runtimeRoot }))
      .rejects.toThrow("private native home must stay inside the provider runtime directory");
    await expectUserHomesUntouched();
    // Nothing was created through the link.
    await expect(access(join(userHome, "codex-home"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(userHome, "openai-api-work"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(join(userHome, ".codex"))).resolves.toEqual(["sessions"]);
  });

  it("refuses to remove provider state through a symlinked runtime root", async () => {
    // Restored or tampered data: the runtime root points into the user's home.
    await mkdir(join(userHome, "openai-api-work", "codex-home"), { recursive: true });
    await mkdir(join(profile, "userData"), { recursive: true });
    await symlink(userHome, runtimeRoot);
    const removeRuntimeState = createProviderRuntimeStateRemover({
      runtimeRoot,
      registry: productionProviderAdapterRegistry,
    });

    await expect(removeRuntimeState({ id: "openai-api-work", adapterId: "openai-api", accessContract: "secret@1" }))
      .rejects.toThrow("provider runtime root must be a real directory");
    await expect(removeRuntimeState.reconcile([])).rejects.toThrow("provider runtime root must be a real directory");
    await expect(access(join(userHome, "openai-api-work", "codex-home"))).resolves.toBeUndefined();
    await expectUserHomesUntouched();
  });

  it("deletes only the provider's private homes when the provider is removed", async () => {
    const codexProvider = await connectProvider("openai-api", { runtimeRoot });
    const claudeProvider = await connectProvider("anthropic-api", { runtimeRoot });
    const kept = await connectProvider("openrouter", { runtimeRoot });
    const removeRuntimeState = createProviderRuntimeStateRemover({
      runtimeRoot,
      registry: productionProviderAdapterRegistry,
    });
    for (const provider of [codexProvider, claudeProvider, kept]) {
      await expect(access(provider.home)).resolves.toBeUndefined();
    }

    await expect(removeRuntimeState(codexProvider.definition)).resolves.toBe(true);
    await expect(removeRuntimeState(claudeProvider.definition)).resolves.toBe(true);

    await expect(access(join(runtimeRoot, codexProvider.definition.id))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(runtimeRoot, claudeProvider.definition.id))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(kept.home)).resolves.toBeUndefined();
    await expectUserHomesUntouched();
  });
});

async function connectProvider(adapterId, context) {
  const id = `${adapterId}-work`;
  const definition = {
    id,
    adapterId,
    label: `${adapterId} work`,
    endpoint: "https://api.provider.test/v1",
    accessContract: "secret@1",
    credentialReference: `provider:${id}`,
    lifecycleState: "active",
    removedAt: null,
  };
  // desktop/main/index.mjs passes this context for every secret@1 definition.
  const dependencies = await productionProviderRuntimeDependencies(definition, {
    ...context,
    environment: processEnvironment,
  });
  const adapter = productionProviderAdapterRegistry.create(definition, {
    ...dependencies,
    fetch: vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{
        id: "model-test",
        type: "language",
        architecture: { output_modalities: ["text"] },
        top_provider: { context_length: 128_000, max_completion_tokens: 8_192 },
        context_window: 128_000,
        max_tokens: 8_192,
      }] }),
    })),
    secrets: { "api-key": "sk-provider-secret" },
  });
  const broker = createProviderExecutionAccessBroker(async () => ({
    definition,
    descriptor: productionProviderAdapterRegistry.get(adapterId),
    runtime: adapter,
    release: async () => {},
  }));
  const homeName = adapterId === "anthropic-api" ? "claude-home" : "codex-home";
  return { definition, broker, home: join(runtimeRoot, id, homeName) };
}

async function startHost(provider) {
  const host = new HarnessHost({
    stateFile: join(profile, "harness-sessions.json"),
    controlToken: "control",
    accessBroker: provider.broker,
    implementations: {
      "codex.basic": (context) => new CodexBasicHarness(context, {
        // Exactly as desktop/main/index.mjs resolves the managed Codex runtime.
        resolveCodexRuntime: async () => productionHarnessRuntimeDescriptor(
          { runtimeId: "codex", version: "0.147.0", executable: FAKE_EXECUTABLE },
          { environment: processEnvironment },
        ),
        runAppServerTurn: (options) => {
          codexTurns.push(options);
          return runCodexAppServerTurn({
            ...options,
            spawnProcess: (executable, args, spawnOptions) => {
              spawns.push({ executable, args, env: spawnOptions.env });
              throw new Error("The fake Codex process stops here.");
            },
          });
        },
      }),
      "claude.basic": (context) => new ClaudeBasicHarness(context, {
        resolveClaudeRuntime: async () => productionHarnessRuntimeDescriptor(
          { runtimeId: "claude", version: "2.1.0", executable: FAKE_EXECUTABLE, modulePath: FAKE_EXECUTABLE },
          { environment: processEnvironment },
        ),
        query: (input) => {
          claudeQueries.push(input);
          throw new Error("The fake Claude SDK stops here.");
        },
        browserSdk: {
          tool: (name, description, inputSchema, handler) => ({ name, description, inputSchema, handler }),
          createSdkMcpServer: (options) => ({ type: "sdk", options }),
        },
      }),
    },
  });
  await host.initialize();
  return host;
}

/** Saves a conversation's state the way an earlier release's harness recorded it. */
async function saveEarlierReleaseState(provider, session, state) {
  const earlier = new HarnessHost({
    stateFile: join(profile, "harness-sessions.json"),
    controlToken: "control",
    accessBroker: provider.broker,
    implementations: {
      [session.configuration.implementation]: () => ({ complete: async () => undefined, state: () => state }),
    },
  });
  await earlier.initialize();
  await earlier.createSession(session);
  await earlier.close();
}

function codexSession(threadId = 1) {
  return {
    threadId,
    permissionProfileId: "full",
    workingDirectory: profile,
    configuration: {
      schemaVersion: 1,
      name: "codex-basic",
      implementation: "codex.basic",
      implementationVersion: 1,
      permissionBindings: { full: { sandboxMode: "danger-full-access", approvalPolicy: "never" } },
      modelRules: { allow: CODEX_ADAPTERS.map((adapterId) => ({ adapterId, modelIdExact: "model-test" })), deny: [] },
      executionAccessContracts: ["managed-runtime@1", "secret@1"],
      settings: { skipGitRepoCheck: true },
    },
  };
}

function claudeSession(threadId = 1) {
  return {
    threadId,
    permissionProfileId: "full",
    workingDirectory: profile,
    configuration: {
      schemaVersion: 1,
      name: "claude-basic",
      implementation: "claude.basic",
      implementationVersion: 1,
      permissionBindings: { full: { approvalMode: "full" } },
      modelRules: { allow: [{ adapterId: "anthropic-api", modelIdExact: "model-test" }], deny: [] },
      executionAccessContracts: ["managed-runtime@1", "secret@1"],
      settings: {},
    },
  };
}

/** Runs one root turn to the fake native process. Returns the turn's failure. */
async function runRootTurn(host, provider, interactionId, threadId = 1) {
  const model = {
    providerId: provider.definition.id,
    adapterId: provider.definition.adapterId,
    modelId: "model-test",
  };
  return host.complete(threadId, interactionId, graph(interactionId), model).then(
    () => { throw new Error("The fake native process should have failed the turn."); },
    (error) => error,
  );
}

async function persistedStates() {
  const saved = JSON.parse(await readFile(join(profile, "harness-sessions.json"), "utf8"));
  return Object.fromEntries(saved.sessions.map(({ threadId, state }) => [threadId, state]));
}

async function expectUserHomesUntouched() {
  await expect(readFile(join(userHome, ".codex", "sessions", "rollout.jsonl"), "utf8")).resolves.toBe("user-codex-history");
  await expect(readFile(join(userHome, ".claude", "projects", "session.jsonl"), "utf8")).resolves.toBe("user-claude-history");
  await expect(access(processEnvironment.CODEX_HOME)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(access(processEnvironment.CLAUDE_CONFIG_DIR)).rejects.toMatchObject({ code: "ENOENT" });
}

function graph(nodeId) {
  return { url: "http://127.0.0.1:43123", token: `token-${nodeId}`, nodeId };
}

function stubGraph() {
  const node = (id) => ({ id, kind: "user-interaction", icon: "user", title: "Q", detail: "Q", state: "accepted" });
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const nodeId = Number(new Headers(init?.headers).get("authorization")?.replace("Bearer token-", ""));
    const json = (body, status = 200) => new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
    if (url.endsWith("/output")) return json({ error: { code: "completion_not_found" } }, 404);
    if (url.endsWith("/neighbors")) return json({ nodes: [] });
    if (url.endsWith("/personal-presentation")) return json({ error: { code: "personal_presentation_not_attached" } }, 404);
    if (url.endsWith("/input")) return json({ interaction: node(nodeId), contexts: [] });
    return json({ node: node(nodeId) });
  }));
}
