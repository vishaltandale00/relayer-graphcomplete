import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHarnessConfigurations, digestHarnessConfiguration } from "@relayer/harness-host";
import { afterEach, expect, it, vi } from "vitest";
import { createEvalManagedPrimeRuntime, createEvalPrimeProvider, loadEvalPrimeProfile } from "../desktop/eval-main/prime-provider.mjs";

const directories = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const models = ["openai/gpt-6-luna", "qwen/qwen3.8-flash"];
const profile = { apiKey: "secret-test-value", modelIds: models };

async function setup({ missingModel = false, rejectValidation = false, connectionError = false, mixedReadiness = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "eval-prime-"));
  directories.push(directory);
  let dependencies;
  const requests = [];
  const families = [];
  const unavailableHarnesses = new Set(mixedReadiness ? ["prime-agent-deep"] : []);
  const lease = { release: vi.fn(async () => {}) };
  const composition = {
    start: vi.fn(async () => {}), close: vi.fn(async () => {}),
    providerDefinitions: {
      list: async () => [],
      connect: vi.fn(async ({ fields }) => {
        if (connectionError) throw new Error(`Provider reflected ${fields["api-key"]}`);
        await dependencies.credentialStore.set("provider:eval-openrouter", fields);
      }),
      acquireExecution: vi.fn(async () => lease),
    },
    modelCatalog: { refresh: vi.fn(async () => {}) },
  };
  const provider = createEvalPrimeProvider({
    userDataDirectory: directory,
    productServer: { providerDefinitionStore: () => ({ load: async () => [] }), providerStatuses: async () => new Map() },
    productSession: { origin: "http://localhost:1234", cookie: { name: "session", value: "write-token" } },
    runtimeSession: { configurations: new Map(mixedReadiness ? [["prime-agent-deep", { implementation: "prime.agent" }]] : []), digestConfiguration: () => "digest" },
    graphRuntime: {}, managedPrimeRuntime: {}, managedCodexRuntime: {},
    createComposition: (options) => { dependencies = options; return composition; },
    fetchImpl: async (url, options) => {
      const path = new URL(url).pathname;
      const body = options.body ? JSON.parse(options.body) : undefined;
      requests.push({ path, body });
      if (path === "/api/model-settings") return Response.json({ families, providers: [{
        id: "eval-openrouter", connected: true, models: (missingModel ? models.slice(0, 1) : models).map((id) => ({ id, available: true, visible: true })),
      }] });
      if (path === "/api/model-families") { families.push({ id: 42, ...body }); return Response.json({ id: 42 }); }
      if (path === "/api/model-selection/validate") return rejectValidation || unavailableHarnesses.has(body.harnessId)
        ? Response.json({ error: profile.apiKey }, { status: 400 }) : Response.json(body);
      throw new Error(`Unexpected request ${path}`);
    },
  });
  return { provider, composition, requests, directory, lease, families, unavailableHarnesses, credentials: () => dependencies.credentialStore };
}

it("pins the explicit roster through product validation without persisting provider credentials", async () => {
  const { provider, composition, requests, directory, lease } = await setup();
  await provider.start(profile);
  const selected = await provider.select("prime-agent-basic");
  expect(selected).toEqual({ harnessId: "prime-agent-basic", familyId: 42, providerId: "eval-openrouter", modelId: models[0] });
  expect(requests.find(({ path }) => path === "/api/model-families").body.members).toEqual(models.map((modelId) => ({ providerId: "eval-openrouter", modelId })));
  expect(requests.filter(({ path }) => path === "/api/model-selection/validate").map(({ body }) => body.modelId)).toEqual([...models, ...models]);
  expect(JSON.stringify(requests)).not.toContain(profile.apiKey);
  await expect(readFile(join(directory, "provider-credentials.json"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await provider.acquireExecution("eval-openrouter")).toBe(lease);
  await lease.release();
  await provider.close();
  expect(composition.close).toHaveBeenCalledOnce();
});

it.each([{ missingModel: true }, { rejectValidation: true }, { connectionError: true }])("fails closed without retaining reflected provider credentials: %j", async (options) => {
  const { provider, requests } = await setup(options);
  await expect(provider.start(profile)).rejects.toThrow("Prime Eval provider setup failed; no Prime run was admitted.");
  await expect(provider.select("prime-agent-basic")).rejects.toThrow("requires a connected provider");
  expect(JSON.stringify(requests)).not.toContain(profile.apiKey);
  await provider.close();
});

it("does not initialize the managed installer on fixture-only or unsupported-platform startup", async () => {
  const createInstaller = vi.fn(() => { throw new Error("unsupported platform"); });
  const runtime = createEvalManagedPrimeRuntime({ root: "/unused", createInstaller });
  expect(runtime.installer.activeOperations()).toEqual([]);
  await runtime.installer.cancelAll();
  expect(createInstaller).not.toHaveBeenCalled();
  await expect(runtime.resolve()).rejects.toThrow("unsupported platform");
});

it("loads local credentials only with an explicit development opt-in and sanitizes malformed input", async () => {
  expect(await loadEvalPrimeProfile({ isPackaged: false, environment: {} })).toBeNull();
  const directory = await mkdtemp(join(tmpdir(), "eval-profile-")); directories.push(directory);
  const path = join(directory, "profile.json");
  const environment = { RELAYER_EVAL_PRIME_PROFILE_FILE: path };
  await writeFile(path, JSON.stringify({ runs: { "prime-openrouter": { auth: { kind: "openrouter", apiKey: profile.apiKey }, modelId: models[0], verificationHelperModelId: models[1] } } }));
  expect(await loadEvalPrimeProfile({ isPackaged: false, environment })).toEqual({ ...profile, endpoint: undefined });
  await expect(loadEvalPrimeProfile({ isPackaged: true, environment })).rejects.toThrow("development-only");
  await writeFile(path, `malformed ${profile.apiKey}`);
  await expect(loadEvalPrimeProfile({ isPackaged: false, environment })).rejects.toThrow("Could not read the local Prime Eval profile.");
});

it("rejects family drift instead of silently widening the native helper roster", async () => {
  const { provider, families } = await setup();
  await provider.start(profile);
  families[0].members.push({ providerId: "eval-openrouter", modelId: "unexpected-model" });
  await expect(provider.select("prime-agent-basic")).rejects.toThrow("family roster changed");
  await provider.close();
});

it.each([false, true])("uses production provider composition and credential reopen (failure=%s)", async (failRuntime) => {
  const directory = await mkdtemp(join(tmpdir(), "eval-prime-composition-")); directories.push(directory);
  let definitions = [];
  let readiness = true;
  const prepare = vi.fn(async () => { throw new Error("Managed kernel preparation failed"); });
  const configurations = failRuntime ? await loadHarnessConfigurations([
    join(import.meta.dirname, "../harnesses/prime-agent-basic.yaml"),
  ]) : new Map();
  let catalog;
  const families = [];
  const originalFetch = globalThis.fetch;
  const providerRequests = [];
  globalThis.fetch = async (url) => {
    providerRequests.push(String(url));
    if (String(url).endsWith("/key")) return Response.json({ data: { label: "test-key" } });
    if (String(url).endsWith("/models")) return Response.json({ data: models.map((id) => ({ id,
      architecture: { output_modalities: ["text"] }, top_provider: { context_length: 100000, max_completion_tokens: 8000 },
    })) });
    throw new Error("Unexpected provider request; inference is forbidden in this test.");
  };
  const makeProvider = () => createEvalPrimeProvider({
    userDataDirectory: directory,
    productServer: {
      providerDefinitionStore: () => ({ load: async () => definitions, save: async (next) => { definitions = next; } }),
      providerStatuses: async () => new Map(),
      publishProviderCatalog: async (snapshot) => { catalog = snapshot; },
      publishHarnessReadiness: async (updates) => { readiness = updates.every(({ available }) => available); },
    },
    productSession: { origin: "http://localhost:1234", cookie: { name: "session", value: "write-token" } },
    runtimeSession: { configurations, digestConfiguration: digestHarnessConfiguration },
    graphRuntime: { recordHarnessReadiness: async () => {} }, managedPrimeRuntime: { prepare }, managedCodexRuntime: {},
    fetchImpl: async (url, options) => {
      const path = new URL(url).pathname;
      const body = options.body ? JSON.parse(options.body) : undefined;
      if (path === "/api/model-settings") return Response.json({ families, providers: catalog ? [{ ...catalog, id: catalog.providerId }] : [] });
      if (path === "/api/model-families") { families.push({ id: 12, ...body }); return Response.json(families[0]); }
      if (path === "/api/model-selection/validate") return readiness ? Response.json(body) : Response.json({}, { status: 409 });
      throw new Error("Unexpected product request");
    },
  });
  let provider = makeProvider();
  try {
    if (failRuntime) {
      await expect(provider.start(profile)).rejects.toThrow("no Prime run was admitted");
      expect(prepare).toHaveBeenCalledOnce();
      expect(readiness).toBe(false);
      await expect(provider.select("prime-agent-basic")).rejects.toThrow("requires a connected provider");
      return;
    }
    await provider.start(profile);
    const lease = await provider.acquireExecution("eval-openrouter");
    expect(lease.definition).toMatchObject({ adapterId: "openrouter", accessContract: "secret@1" });
    expect(await lease.runtime.executionAccess()).toMatchObject({ kind: "secret", fields: { "api-key": profile.apiKey } });
    await lease.release();
    expect(JSON.stringify(definitions)).not.toContain(profile.apiKey);
    expect(providerRequests.every((url) => /\/(key|models)$/.test(url))).toBe(true);
    await provider.close();
    provider = makeProvider();
    await provider.start(profile);
    const reopened = await provider.acquireExecution("eval-openrouter");
    expect(await reopened.runtime.executionAccess()).toMatchObject({ kind: "secret", fields: { "api-key": profile.apiKey } });
    await reopened.release();
    await expect(readFile(join(directory, "provider-credentials.json"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await provider.close();
    globalThis.fetch = originalFetch;
  }
});

it("projects mixed route readiness and removes routes when admission changes", async () => {
  const { provider, unavailableHarnesses } = await setup({ mixedReadiness: true });
  await provider.start(profile);
  expect(provider.availability("prime-agent-basic").available).toBe(true);
  expect(provider.availability("prime-agent-deep")).toMatchObject({ available: false, unavailableReason: expect.any(String) });
  unavailableHarnesses.add("prime-agent-basic");
  await provider.refreshAvailability();
  expect(provider.availability("prime-agent-basic").available).toBe(false);
  unavailableHarnesses.delete("prime-agent-basic");
  await provider.refreshAvailability();
  expect(provider.availability("prime-agent-basic").available).toBe(true);
  await provider.close();
});

it("keeps web-host Prime credentials in memory and clears them on shutdown", async () => {
  const { provider, directory, credentials } = await setup();
  await provider.start(profile);
  expect(await credentials().get("provider:eval-openrouter")).toEqual({ "api-key": profile.apiKey });
  await expect(readFile(join(directory, "provider-credentials.json"))).rejects.toMatchObject({ code: "ENOENT" });
  await provider.close();
  expect(await credentials().listReferences()).toEqual([]);
});
