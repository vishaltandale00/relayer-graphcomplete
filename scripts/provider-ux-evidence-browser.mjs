const scene = new URLSearchParams(location.search).get("scene") ?? "onboarding";
const caption = new URLSearchParams(location.search).get("caption") ?? "Provider and model setup";

const adapters = [
  ["codex-subscription", "Codex subscription", "existing-runtime-auth", null],
  ["claude-subscription", "Claude subscription", "managed-login", null],
  ["openai-api", "OpenAI API", "secret-fields", "https://api.openai.com/v1"],
  ["anthropic-api", "Anthropic API", "secret-fields", "https://api.anthropic.com/v1"],
  ["openrouter", "OpenRouter", "secret-fields", "https://openrouter.ai/api/v1"],
  ["vercel-ai-router", "Vercel AI Router", "secret-fields", "https://ai-gateway.vercel.sh/v1"],
].map(([adapterId, label, mode, defaultEndpoint]) => ({
  adapterId,
  implementationVersion: 1,
  label,
  accessContract: mode === "secret-fields" ? "secret@1" : "managed-runtime@1",
  defaultEndpoint,
  endpointEditableDuringCreation: mode === "secret-fields",
  connection: {
    mode,
    fields: mode === "secret-fields"
      ? [{ id: "api-key", label: "API key", kind: "secret", required: true }]
      : [],
  },
}));

const connectedDefinitions = [
  {
    id: "openai-work",
    adapterId: "openai-api",
    adapterLabel: "OpenAI API",
    label: "OpenAI Work",
    endpoint: "https://gateway.example.com/openai/v1",
    accessContract: "secret@1",
    lifecycleState: "active",
  },
  {
    id: "codex",
    adapterId: "codex-subscription",
    adapterLabel: "Codex subscription",
    label: "Codex",
    endpoint: null,
    accessContract: "managed-runtime@1",
    lifecycleState: "active",
  },
];

const onboardingScenes = new Set(["onboarding", "endpoint", "family", "alternate-harness", "loading", "invalid", "error", "no-compatible", "authorization", "flow"]);
let definitions = onboardingScenes.has(scene) ? [] : structuredClone(connectedDefinitions);
let onboardingComplete = !onboardingScenes.has(scene);
if (scene === "long-label") {
  definitions[0].label = "OpenAI Work — North America Platform Engineering and Applied Research";
}
if (scene === "unavailable") {
  definitions[0].connected = false;
  delete definitions[0].lifecycleState;
}
if (scene === "removed") {
  definitions[0].lifecycleState = "removal_pending";
}
window.__providerEvidence = { get definitions() { return definitions; } };
let accountLoginCalls = 0;
Object.defineProperty(window.__providerEvidence, "accountLoginCalls", { get: () => accountLoginCalls });
const listeners = new Set();
const noopSubscription = (callback) => {
  listeners.add(callback);
  return () => listeners.delete(callback);
};

window.relayerDesktop = {
  platform: "darwin",
  account: {
    read: async () => ({ status: "signed-out", channel: "stable" }),
    login: async () => {
      accountLoginCalls += 1;
      return { status: "signing-in", channel: "stable" };
    },
    logout: async () => ({}),
    onChanged: noopSubscription,
  },
  folder: { choose: async () => null },
  models: { settingsOpened: async () => ({}), refresh: async () => ({ refreshed: true }) },
  providers: {
    status: async () => ({
      adapters,
      definitions,
      hasCompletedOnboarding: onboardingComplete,
    }),
    connect: async (input) => {
      if (scene === "loading") return new Promise(() => {});
      if (scene === "error") throw new Error("Authentication failed. Check the API key and endpoint, then try again.");
      if (scene === "authorization") {
        return { status: "pending", connectionId: "authorization-1", login: { kind: "browser" } };
      }
      const managed = input.adapterId === "claude-subscription";
      const definition = {
        id: managed ? "claude-work" : "openai-work",
        adapterId: input.adapterId,
        adapterLabel: managed ? "Claude subscription" : "OpenAI API",
        label: input.label,
        endpoint: input.endpoint,
        accessContract: managed ? "managed-runtime@1" : "secret@1",
        lifecycleState: "active",
        connected: true,
      };
      definitions = scene === "flow" ? [...definitions.filter(({ id }) => id !== definition.id), definition] : [definition];
      return { status: "connected", providerDefinition: definition };
    },
    completeConnection: async () => scene === "authorization"
      ? { status: "pending", connectionId: "authorization-1", login: { kind: "browser" } }
      : { status: "connected", providerDefinition: definitions[0] },
    cancelConnection: async () => ({ cancelled: true }),
    rename: async (id, label) => ({ ...definitions.find((item) => item.id === id), label }),
    logout: async (id) => {
      definitions = definitions.map((definition) => definition.id === id
        ? { ...definition, connected: false, unavailableReason: { code: "provider_logged_out", message: "The provider is signed out." } }
        : definition);
      for (const listener of listeners) listener({ kind: "logged_out", providerId: id });
      return { status: "disconnected" };
    },
    remove: async (id) => ({ ...definitions.find((item) => item.id === id), lifecycleState: "removal_pending" }),
    completeOnboarding: async () => {
      onboardingComplete = true;
      return { hasCompletedOnboarding: true };
    },
    onChanged: noopSubscription,
  },
  appearance: {
    read: async () => ({ appearance: scene === "light" ? "light" : "dark" }),
    set: async (appearance) => ({ appearance }),
  },
  updater: {
    status: async () => ({ phase: "idle", channel: "stable", currentVersion: "evidence" }),
    check: async () => ({ phase: "idle", channel: "stable", currentVersion: "evidence" }),
    download: async () => ({}),
    install: async () => ({}),
    setChannel: async (channel) => ({ phase: "idle", channel, currentVersion: "evidence" }),
    onChanged: noopSubscription,
  },
};

function waitFor(selector, timeout = 5000) {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      const target = document.querySelector(selector);
      if (target) return resolve(target);
      if (performance.now() - started > timeout) return reject(new Error(`Timed out waiting for ${selector}`));
      requestAnimationFrame(poll);
    };
    poll();
  });
}

function waitForCondition(predicate, description, timeout = 5000) {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (performance.now() - started > timeout) return reject(new Error(`Timed out waiting for ${description}`));
      requestAnimationFrame(poll);
    };
    poll();
  });
}

async function prepareScene() {
  const style = document.createElement("style");
  style.textContent = ".evidence-caption{position:fixed;z-index:1000;right:22px;top:18px;max-width:520px;padding:9px 14px;border:1px solid rgba(126,231,191,.42);border-radius:999px;background:rgba(13,18,18,.9);box-shadow:0 10px 32px rgba(0,0,0,.34);color:#dffbef;font:600 13px/1.3 -apple-system,BlinkMacSystemFont,sans-serif;letter-spacing:.01em;pointer-events:none}";
  document.head.append(style);
  const label = document.createElement("div");
  label.className = "evidence-caption";
  label.textContent = caption;
  document.body.append(label);
  if (scene === "flow") {
    await waitFor('[data-provider-adapter="openai-api"]');
    document.body.dataset.evidenceReady = "true";
    return;
  }
  if (["endpoint", "family", "loading", "invalid", "error", "no-compatible"].includes(scene)) {
    (await waitFor('[data-provider-adapter="openai-api"]')).click();
    const endpoint = await waitFor("#providerField-endpoint");
    endpoint.value = "https://gateway.example.com/openai/v1";
    endpoint.setAttribute("value", endpoint.value);
    endpoint.dispatchEvent(new Event("input", { bubbles: true }));
  }
  if (scene === "alternate-harness") {
    (await waitFor('[data-provider-adapter="claude-subscription"]')).click();
    document.querySelector("#providerSetupForm").requestSubmit();
    await waitFor("#providerFamilyStep:not(.hidden)");
    (await waitFor('[data-onboarding-harness="claude-basic"]')).click();
    (await waitFor('[data-onboarding-family-kind="create"]')).click();
    await waitFor('[data-onboarding-member-model="claude-sonnet-4"]');
  }
  if (["family", "loading", "error", "no-compatible"].includes(scene)) {
    document.querySelector("#providerField-label").value = "OpenAI Work";
    document.querySelector('[data-provider-field="api-key"]').value = "evidence-secret";
    document.querySelector("#providerSetupForm").requestSubmit();
    if (["family", "no-compatible"].includes(scene)) {
      await waitForCondition(
        () => document.querySelector("#providerFamilyStep:not(.hidden)")
          || document.querySelector("#authStatus.error")?.textContent,
        "default family step",
      );
      const setupError = document.querySelector("#authStatus.error")?.textContent;
      if (setupError) throw new Error(`Family setup failed: ${setupError}`);
      if (scene === "family") {
        (await waitFor('[data-onboarding-harness="universal-coding"]')).click();
        (await waitFor('[data-onboarding-family-kind="create"]')).click();
        await waitFor('[data-onboarding-member-model="gpt-5.2"]');
      }
    }
    if (scene === "loading") {
      await waitForCondition(
        () => document.querySelector("#authStatus")?.textContent.includes("Preparing OpenAI API runtime and connecting"),
        "connecting status",
      );
    }
    if (scene === "error") {
      await waitForCondition(
        () => document.querySelector("#authStatus")?.textContent.includes("Authentication failed"),
        "authentication error",
      );
    }
  }
  if (scene === "invalid") {
    const endpoint = await waitFor("#providerField-endpoint");
    endpoint.value = "http://example.com/v1";
    endpoint.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector('[data-provider-field="api-key"]').value = "";
    document.querySelector("#providerSetupForm").requestSubmit();
    await waitFor('[aria-invalid="true"]');
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }
  if (scene === "authorization") {
    (await waitFor('[data-provider-adapter="claude-subscription"]')).click();
    document.querySelector("#providerSetupForm").requestSubmit();
    await waitForCondition(
      () => document.querySelector("#authStatus")?.textContent.includes("Complete sign-in in your browser"),
      "authorization pending status",
    );
  }
  if (["providers", "families", "harnesses", "light", "narrow", "long-label", "unavailable", "stale", "removed"].includes(scene)) {
    await waitFor("#appShell:not(.hidden)");
    await waitForCondition(
      () => document.querySelector("#currentFamilyName")?.textContent === "Work coding",
      "model settings",
    );
    (await waitFor("#settingsButton")).click();
    const tab = ["families", "stale"].includes(scene) ? "models" : scene === "harnesses" ? "harnesses" : "providers";
    (await waitFor(`[data-settings-tab="${tab}"]`)).click();
    document.activeElement?.blur();
  }
  if (scene === "recovery") {
    await waitFor("#threadPrompt");
    await waitFor("#composerRetryMessage:not(.hidden)");
  }
  document.body.dataset.evidenceReady = "true";
}

void prepareScene().catch((error) => {
  document.body.dataset.evidenceError = error.message;
});
