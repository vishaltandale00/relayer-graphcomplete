import { randomUUID } from "node:crypto";

const PROVIDERS = Object.freeze({
  "codex-subscription": "openai-codex",
  "claude-subscription": "anthropic",
});

function providerFor(adapterId) {
  const provider = PROVIDERS[adapterId];
  if (!provider) throw new Error("Prime subscription profile does not support this provider adapter.");
  return provider;
}

function storageKey(providerDefinitionId) {
  if (typeof providerDefinitionId !== "string"
    || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(providerDefinitionId)) {
    throw new Error("Prime subscription profile requires a stable provider definition id.");
  }
  return `prime-subscription:${providerDefinitionId}`;
}

function validCredential(value) {
  return value?.type === "oauth"
    && typeof value.access === "string" && value.access.trim() !== ""
    && typeof value.refresh === "string" && value.refresh.trim() !== ""
    && Number.isFinite(value.expires);
}

export function createPrimeSubscriptionProfile({
  credentialStore,
  loadPrimeModule = () => import("@earendil-works/pi-coding-agent"),
} = {}) {
  if (!credentialStore
    || typeof credentialStore.get !== "function"
    || typeof credentialStore.set !== "function"
    || typeof credentialStore.delete !== "function") {
    throw new Error("Prime subscription profile requires a credential store.");
  }
  const pending = new Map();
  const generations = new Map();
  const requestOperations = new Map();
  const nextGeneration = (id) => {
    const generation = (generations.get(id) ?? 0) + 1;
    generations.set(id, generation);
    return generation;
  };

  async function saved(id) {
    const entry = await credentialStore.get(storageKey(id));
    if (entry === null) return null;
    if (!PROVIDERS[entry?.adapterId] || !validCredential(entry?.credential)) {
      throw new Error("Prime subscription profile credential is invalid.");
    }
    return entry;
  }

  function serializeRequest(id, operation) {
    const prior = requestOperations.get(id) ?? Promise.resolve();
    const current = prior.catch(() => undefined).then(operation);
    requestOperations.set(id, current);
    void current.finally(() => {
      if (requestOperations.get(id) === current) requestOperations.delete(id);
    }).catch(() => undefined);
    return current;
  }

  return Object.freeze({
    async login(definition, { signal } = {}) {
      const id = definition?.id;
      const adapterId = definition?.adapterId;
      const provider = providerFor(adapterId);
      storageKey(id);
      signal?.throwIfAborted();
      const generation = nextGeneration(id);
      const prime = await loadPrimeModule();
      if (typeof prime?.AuthStorage?.inMemory !== "function") {
        throw new Error("Prime subscription authentication is unavailable.");
      }
      let prior;
      try {
        prior = await saved(id);
      } catch {
        await credentialStore.delete(storageKey(id));
        prior = null;
      }
      const authStorage = prime.AuthStorage.inMemory(prior ? { [provider]: prior.credential } : {});
      let resolveAuth;
      const auth = new Promise((resolve) => { resolveAuth = resolve; });
      const record = { generation, state: "pending", error: null, operation: null };
      const operation = Promise.resolve().then(() => authStorage.login(provider, {
        signal,
        onAuth: (info) => resolveAuth?.(info),
        onProgress: () => undefined,
        onPrompt: async () => { throw new Error("Manual subscription code entry is unavailable."); },
      })).then(async () => {
        const credential = authStorage.get(provider);
        if (!validCredential(credential)) throw new Error("Prime subscription login returned invalid credentials.");
        if (generations.get(id) !== generation) return;
        await credentialStore.set(storageKey(id), { adapterId, provider, credential });
        record.state = "connected";
      }).catch((error) => {
        record.state = "failed";
        record.error = error;
      });
      record.operation = operation;
      pending.set(id, record);
      const info = await Promise.race([
        auth,
        operation.then(() => {
          if (record.state === "failed") throw new Error("Prime subscription login is unavailable.");
          throw new Error("Prime subscription login did not provide an authorization URL.");
        }),
      ]);
      if (typeof info?.url !== "string" || info.url.trim() === "") {
        throw new Error("Prime subscription login did not provide an authorization URL.");
      }
      return Object.freeze({ loginId: randomUUID(), authUrl: info.url });
    },

    async account(id) {
      const entry = await saved(id);
      if (entry) return Object.freeze({ status: "connected", account: Object.freeze({ provider: entry.provider }) });
      const record = pending.get(id);
      if (record?.state === "failed") return Object.freeze({ status: "unavailable", account: null, error: "Subscription login is unavailable." });
      return Object.freeze({ status: "disconnected", account: null });
    },

    async nativeRequestAccess(id, adapterId) {
      return serializeRequest(id, async () => {
        const generation = generations.get(id) ?? 0;
        const provider = providerFor(adapterId);
        const entry = await saved(id);
        if (!entry || entry.adapterId !== adapterId || entry.provider !== provider) {
          throw new Error("Prime subscription connection is unavailable.");
        }
        const prime = await loadPrimeModule();
        if (typeof prime?.AuthStorage?.inMemory !== "function") {
          throw new Error("Prime subscription authentication is unavailable.");
        }
        const authStorage = prime.AuthStorage.inMemory({ [provider]: entry.credential });
        const apiKey = await authStorage.getApiKey(provider, { includeFallback: false });
        const credential = authStorage.get(provider);
        if (typeof apiKey !== "string" || apiKey.trim() === "" || !validCredential(credential)
          || (generations.get(id) ?? 0) !== generation) {
          throw new Error("Prime subscription connection is unavailable.");
        }
        await credentialStore.set(storageKey(id), { adapterId, provider, credential });
        return Object.freeze({ kind: "secret", contract: "secret@1", apiKey });
      });
    },

    async logout(id) {
      nextGeneration(id);
      pending.delete(id);
      await credentialStore.delete(storageKey(id));
      return Object.freeze({ status: "disconnected", account: null });
    },

    async reconcile(definitions) {
      if (typeof credentialStore.listReferences !== "function") return [];
      const retained = new Set((definitions ?? []).flatMap((definition) => (
        definition?.lifecycleState !== "tombstoned" && PROVIDERS[definition?.adapterId]
          ? [storageKey(definition.id)]
          : []
      )));
      const removed = [];
      for (const reference of await credentialStore.listReferences()) {
        if (!reference.startsWith("prime-subscription:") || retained.has(reference)) continue;
        await credentialStore.delete(reference);
        removed.push(reference.slice("prime-subscription:".length));
      }
      return removed;
    },

    async close() {
      for (const id of pending.keys()) nextGeneration(id);
      for (const id of requestOperations.keys()) nextGeneration(id);
      pending.clear();
    },
  });
}
