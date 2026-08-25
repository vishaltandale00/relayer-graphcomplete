import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "..");
const outputArgumentIndex = process.argv.indexOf("--output-dir");
const outputDirectory = resolve(outputArgumentIndex >= 0
  ? process.argv[outputArgumentIndex + 1]
  : join(repositoryRoot, "docs/evidence/issue-157-provider-ux"));
const chrome = process.env.RELAYER_EVIDENCE_CHROME
  ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ffmpeg = process.env.RELAYER_EVIDENCE_FFMPEG ?? "/opt/homebrew/bin/ffmpeg";
const framesDirectory = join(outputDirectory, "frames");
const variantsDirectory = join(outputDirectory, "variants");
const motionDirectory = join(outputDirectory, "motion");
const browserProfile = await mkdtemp(join(tmpdir(), "relayer-provider-evidence-"));
const scenes = [
  ["onboarding", "Choose a provider"],
  ["endpoint", "Configure an editable API endpoint"],
  ["family", "Choose the default model family"],
  ["providers", "Manage independent provider connections"],
  ["families", "Configure harness-agnostic model families"],
  ["harnesses", "Inspect separate harness rules"],
  ["recovery", "Recover the same unsent turn with an explicit model choice"],
];
const variants = [
  { scene: "light", caption: "Light appearance", width: 1280, required: ["OpenAI Work", "data-theme=\"light\""] },
  { scene: "narrow", caption: "Narrow responsive settings", width: 620, required: ["OpenAI Work", "Providers"] },
  { scene: "long-label", caption: "Long provider identity", width: 1280, required: ["North America Platform Engineering and Applied Research"] },
  { scene: "loading", caption: "Connecting and discovering models", width: 1280, required: ["Connecting and discovering models"] },
  { scene: "error", caption: "Authentication error", width: 1280, required: ["Authentication failed", "Check the API key"] },
  { scene: "unavailable", caption: "Unavailable provider", width: 1280, required: ["Connection unavailable", "OpenAI Work"] },
  { scene: "authorization", caption: "Authorization pending", width: 1280, required: ["Complete sign-in in your browser", "Claude subscription"] },
];

async function fileEvidence(path) {
  const bytes = await readFile(path);
  return {
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function motionEvidence(directory) {
  const files = (await readdir(directory)).filter((name) => name.endsWith(".png")).sort();
  const hash = createHash("sha256");
  let bytes = 0;
  for (const file of files) {
    const frame = await readFile(join(directory, file));
    hash.update(frame);
    bytes += frame.byteLength;
  }
  return { frameBytes: bytes, framesSha256: hash.digest("hex") };
}

function devtoolsEndpoint(child, timeoutMs = 15_000) {
  return new Promise((resolvePromise, reject) => {
    let stderr = "";
    const timeout = setTimeout(() => reject(new Error(`Chrome DevTools startup timed out: ${stderr}`)), timeoutMs);
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) reject(new Error(`Chrome exited ${code}: ${stderr}`));
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      const endpoint = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1];
      if (!endpoint) return;
      clearTimeout(timeout);
      resolvePromise(endpoint);
    });
  });
}

function cdpClient(webSocketUrl) {
  return new Promise((resolvePromise, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const pending = new Map();
    let nextId = 0;
    socket.addEventListener("open", () => resolvePromise({
      call(method, params = {}) {
        return new Promise((resolveCall, rejectCall) => {
          const id = ++nextId;
          pending.set(id, { resolveCall, rejectCall });
          socket.send(JSON.stringify({ id, method, params }));
        });
      },
      close: () => socket.close(),
    }));
    socket.addEventListener("error", reject);
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      if (!message.id || !pending.has(message.id)) return;
      const { resolveCall, rejectCall } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) rejectCall(new Error(`${message.error.message} (${message.error.code})`));
      else resolveCall(message.result);
    });
  });
}

async function captureBrowserScene(url, frame, profile, width = 1280) {
  await mkdir(profile, { recursive: true });
  const child = spawn(chrome, [
    "--headless=new",
    "--hide-scrollbars",
    "--disable-gpu",
    "--disable-background-networking",
    "--disable-component-update",
    "--no-first-run",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    `--window-size=${width},800`,
    "--force-device-scale-factor=1",
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  try {
    const browserEndpoint = new URL(await devtoolsEndpoint(child));
    const target = await fetch(
      `${browserEndpoint.protocol === "wss:" ? "https:" : "http:"}//${browserEndpoint.host}/json/new?${encodeURIComponent(url)}`,
      { method: "PUT" },
    ).then((response) => response.json());
    const cdp = await cdpClient(target.webSocketDebuggerUrl);
    try {
      await cdp.call("Runtime.enable");
      await cdp.call("Page.enable");
      await cdp.call("Emulation.setDeviceMetricsOverride", {
        width,
        height: 800,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await cdp.call("Page.reload", { ignoreCache: true });
      const deadline = Date.now() + 12_000;
      let readiness = "pending";
      while (readiness === "pending" && Date.now() < deadline) {
        const evaluated = await cdp.call("Runtime.evaluate", {
          expression: "document.body?.dataset.evidenceReady === 'true' ? 'ready' : document.body?.dataset.evidenceError ? `error:${document.body.dataset.evidenceError}` : 'pending'",
          returnByValue: true,
        });
        readiness = evaluated.result.value;
        if (readiness === "pending") await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      }
      if (readiness !== "ready") throw new Error(`Evidence page did not become ready (${readiness}).`);
      const screenshot = await cdp.call("Page.captureScreenshot", { format: "png", fromSurface: true });
      await writeFile(frame, Buffer.from(screenshot.data, "base64"));
      const dom = await cdp.call("Runtime.evaluate", {
        expression: "document.documentElement.outerHTML",
        returnByValue: true,
      });
      const audit = await cdp.call("Runtime.evaluate", {
        expression: `(() => {
          const visible = (selector) => {
            const element = document.querySelector(selector);
            if (!element) return false;
            const rect = element.getBoundingClientRect();
            return getComputedStyle(element).display !== "none" && rect.width > 0 && rect.height > 0;
          };
          const compactSelect = document.querySelector("#settingsCompactSelect");
          const invalidInputs = [...document.querySelectorAll('[aria-invalid="true"]')];
          return {
            compactBackVisible: visible("#settingsCompactBackButton"),
            compactSelectVisible: visible("#settingsCompactSelect"),
            compactSelectValue: compactSelect?.value ?? null,
            errorAssociationsValid: invalidInputs.every((input) => {
              const error = document.getElementById(input.getAttribute("aria-describedby"));
              return error?.getAttribute("role") === "alert" && visible("#" + CSS.escape(error.id));
            }),
            providerOptionsUseRovingRadio: (() => {
              const options = [...document.querySelectorAll("[data-provider-adapter]")];
              return options.length > 0
                && options.every((button) => button.tagName === "BUTTON" && button.getAttribute("role") === "radio")
                && options.filter((button) => button.tabIndex === 0).length === 1
                && options.filter((button) => button.getAttribute("aria-checked") === "true").length === 1;
            })(),
            onboardingUsesOnlyTrustedHarness: !document.querySelector("#onboardingHarnessSelect")
              && document.querySelector(".onboarding-trusted-harness")?.textContent.includes("Relayer app default"),
          };
        })()`,
        returnByValue: true,
      });
      return { dom: dom.result.value, audit: audit.result.value };
    } finally {
      cdp.close();
    }
  } finally {
    child.kill("SIGKILL");
  }
}

async function recordBrowserFlow(url, directory, profile) {
  const child = spawn(chrome, [
    "--headless=new", "--hide-scrollbars", "--disable-gpu", "--disable-background-networking",
    "--disable-component-update", "--no-first-run", "--remote-debugging-port=0",
    `--user-data-dir=${profile}`, "--window-size=1280,800", "--force-device-scale-factor=1", "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let frameIndex = 0;
  try {
    const browserEndpoint = new URL(await devtoolsEndpoint(child));
    const target = await fetch(
      `${browserEndpoint.protocol === "wss:" ? "https:" : "http:"}//${browserEndpoint.host}/json/new?${encodeURIComponent(url)}`,
      { method: "PUT" },
    ).then((response) => response.json());
    const cdp = await cdpClient(target.webSocketDebuggerUrl);
    const evaluate = async (expression) => {
      const result = await cdp.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "Flow evaluation failed.");
      return result.result.value;
    };
    const waitFor = async (expression, description, timeoutMs = 8_000, diagnosticExpression = null) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await evaluate(`Boolean(${expression})`)) return;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      }
      const diagnostic = diagnosticExpression ? await evaluate(diagnosticExpression) : null;
      throw new Error(`Timed out waiting for recorded flow: ${description}${diagnostic ? ` (${JSON.stringify(diagnostic)})` : ""}`);
    };
    const capture = async (count = 1) => {
      for (let index = 0; index < count; index += 1) {
        const screenshot = await cdp.call("Page.captureScreenshot", { format: "png", fromSurface: true });
        frameIndex += 1;
        await writeFile(join(directory, `${String(frameIndex).padStart(4, "0")}.png`), Buffer.from(screenshot.data, "base64"));
      }
    };
    const caption = async (value) => {
      await evaluate(`document.querySelector('.evidence-caption').textContent = ${JSON.stringify(value)}`);
      await capture(2);
    };
    const click = async (selector) => {
      await evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) throw new Error('Missing ${selector}'); element.focus(); })()`);
      await capture(2);
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 80));
      await capture(2);
    };
    const type = async (selector, chunks) => {
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus(); document.querySelector(${JSON.stringify(selector)}).select?.()`);
      for (const [index, chunk] of chunks.entries()) {
        if (index === 0) await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace" });
        await cdp.call("Input.insertText", { text: chunk });
        await capture();
      }
      await capture();
    };

    try {
      await cdp.call("Runtime.enable");
      await cdp.call("Page.enable");
      await cdp.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
      await cdp.call("Page.reload", { ignoreCache: true });
      await waitFor("document.body?.dataset.evidenceReady === 'true'", "initial onboarding");
      await caption("1 · Connect an API provider");
      await click('[data-provider-adapter="openai-api"]');
      await type("#providerField-label", ["OpenAI ", "Work"]);
      await type("#providerField-endpoint", ["https://gateway.example.com/", "openai/v1"]);
      await type('[data-provider-field="api-key"]', ["evidence-", "secret"]);
      await click("#connectProvider");
      await waitFor("!document.querySelector('#providerFamilyStep').classList.contains('hidden')", "default family step");
      await caption("2 · Use the trusted default harness and choose a family model");
      await click('[data-onboarding-model="gpt-5.2-mini"]');
      await click("#finishProviderSetup");
      await waitFor("!document.querySelector('#appShell').classList.contains('hidden')", "desktop application");

      await caption("3 · Add and sign out a managed subscription");
      await click("#settingsButton");
      await waitFor("document.querySelector('[data-provider-definition=\"openai-work\"]')", "provider settings");
      await click('[data-settings-tab="providers"]');
      await click("#newProviderDefinition");
      await waitFor("document.querySelector('#providerDialog')?.open", "provider dialog");
      await click('#providerDialogContent [data-provider-adapter="claude-subscription"]');
      await waitFor("document.querySelector('[data-provider-dialog-connect]')", "managed provider connection form");
      await type("#providerField-label", ["Claude ", "Work"]);
      await click("[data-provider-dialog-connect]");
      await waitFor("document.querySelector('[data-provider-definition=\"claude-work\"]')", "managed provider card");
      await click('[data-provider-logout="claude-work"]');
      await waitFor("document.querySelector('[data-provider-definition=\"claude-work\"]')?.textContent.includes('Connection unavailable')", "managed logout status");
      await click("#refreshProviderCatalogs");
      await waitFor("document.querySelector('#providerSettingsStatus')?.textContent.includes('refreshed')", "manual provider refresh");

      await caption("4 · Validate and save harness model rules");
      await click('[data-settings-tab="harnesses"]');
      await click('[data-harness-rules-edit="codex-basic"]');
      await click('[data-harness-rule-add="deny"]');
      await click("#saveHarnessRules");
      await waitFor(`(() => {
        const invalid = [...document.querySelectorAll('[aria-invalid="true"]')];
        return invalid.length > 0
          && document.activeElement === invalid[0]
          && invalid.every((input) => document.getElementById(input.getAttribute('aria-describedby'))?.getAttribute('role') === 'alert');
      })()`, "focused, described invalid harness rule");
      await capture(3);
      await type('[data-harness-rule-adapter="deny.1"]', ["openai-", "api"]);
      await type('[data-harness-rule-pattern="deny.1"]', ["gpt-5.2-", "legacy"]);
      await click("#saveHarnessRules");
      await waitFor(`(() => {
        const editor = document.querySelector('.harness-rules-editor-card[aria-busy="true"]');
        return editor && [...editor.querySelectorAll('input, select, button')].every((control) => control.disabled);
      })()`, "locked harness controls during save");
      await capture(2);
      await waitFor("document.querySelector('#harnessSettingsStatus')?.textContent.includes('saved')", "saved harness rules");
      await capture(3);

      await caption("5 · Edit, reselect, and retry the same unsent turn");
      await click("#settingsBackButton");
      await click('[data-thread="1"]');
      await waitFor("document.querySelector('#composerRetryMessage:not(.hidden)') && !document.querySelector('#threadPrompt').disabled", "editable restored draft");
      await type("#threadPrompt", ["Review the provider adapter architecture ", "and verify retry safety"]);
      await click('[data-model-picker="ongoing"] [data-model-picker-trigger]');
      await waitFor(`(() => {
        const picker = document.querySelector('[data-model-picker="ongoing"]');
        return picker?.querySelector('[data-model-picker-label]')?.textContent === 'Choose model'
          && picker.querySelector('[data-model-family]')
          && [...picker.querySelectorAll('[data-model-option]')].every((option) => option.getAttribute('aria-checked') === 'false');
      })()`, "invalid prior family requires explicit model choice", 8_000, `(() => {
        const picker = document.querySelector('[data-model-picker="ongoing"]');
        return {
          label: picker?.querySelector('[data-model-picker-label]')?.textContent,
          family: picker?.querySelector('[data-model-family]')?.value,
          options: [...(picker?.querySelectorAll('[data-model-option]') ?? [])].map((option) => ({
            providerId: option.dataset.providerId,
            modelId: option.dataset.modelId,
            checked: option.getAttribute('aria-checked'),
          })),
        };
      })()`);
      await click('[data-model-picker="ongoing"] [data-model-option][data-provider-id="codex"][data-model-id="gpt-5.6-sol"]');
      await waitFor("document.querySelector('[data-model-picker=\"ongoing\"] [data-model-option][data-provider-id=\"codex\"][data-model-id=\"gpt-5.6-sol\"]')?.getAttribute('aria-checked') === 'true'", "explicit retry model selection");
      await click("#sendInteraction");
      await waitFor("document.querySelector('#composerRetryMessage').classList.contains('hidden') && document.querySelector('#threadPrompt').value === ''", "same-turn retry submission");
      await caption("Complete · The retry was admitted without creating a new turn");
      await capture(5);
      return frameIndex;
    } finally {
      cdp.close();
    }
  } finally {
    child.kill("SIGKILL");
  }
}

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

const flowState = {
  defaults: { harnessId: "codex-basic", providerId: null, familyId: null },
  retrySubmitted: false,
  retryRequest: null,
};

const modelSettings = (scene) => ({
  defaults: scene === "flow" ? { ...flowState.defaults } : {
    harnessId: "codex-basic",
    providerId: scene === "family" ? null : "openai-work",
    familyId: ["onboarding", "endpoint", "family"].includes(scene) ? null : 11,
  },
  providers: [
    {
      id: "openai-work",
      adapterId: "openai-api",
      label: scene === "long-label"
        ? "OpenAI Work — North America Platform Engineering and Applied Research"
        : "OpenAI Work",
      connected: scene !== "unavailable",
      models: [
        { id: "gpt-5.2", label: "GPT-5.2", visible: true, available: true, providerDefault: true },
        { id: "gpt-5.2-mini", label: "GPT-5.2 mini", visible: true, available: true },
      ],
    },
    {
      id: "codex",
      adapterId: "codex-subscription",
      label: "Codex",
      connected: true,
      models: [{ id: "gpt-5.6-sol", label: "GPT-5.6 Sol", visible: true, available: true, providerDefault: true }],
    },
  ],
  families: [
    {
      id: 11,
      name: "Work coding",
      kind: "custom",
      enabled: true,
      position: 0,
      revision: 3,
      members: [
        { providerId: "openai-work", modelId: "gpt-5.2", position: 0 },
        { providerId: "codex", modelId: "gpt-5.6-sol", position: 1 },
      ],
    },
    {
      id: 12,
      name: "Fast review",
      kind: "custom",
      enabled: true,
      position: 1,
      revision: 1,
      members: [{ providerId: "openai-work", modelId: "gpt-5.2-mini", position: 0 }],
    },
  ],
  harnesses: [
    {
      id: "codex-basic",
      label: "Codex basic",
      available: true,
      revision: 7,
      executionAccessContracts: ["secret@1", "managed-runtime@1"],
      compatibleProviderIds: ["openai-work", "codex"],
      modelRules: {
        allow: [
          { adapterId: "openai-api", modelIdRegex: "^gpt-5\\." },
          { adapterId: "codex-subscription", modelIdRegex: "^gpt-5\\." },
        ],
        deny: [{ adapterId: "openai-api", modelIdRegex: "-deprecated$" }],
      },
    },
    {
      id: "claude-basic",
      label: "Claude basic",
      available: true,
      revision: 2,
      executionAccessContracts: ["managed-runtime@1"],
      compatibleProviderIds: [],
      modelRules: { allow: [{ adapterId: "anthropic-api", modelIdRegex: "^claude-" }], deny: [] },
    },
  ],
});

function sceneFromRequest(request) {
  const referer = request.headers.referer;
  if (!referer) return "providers";
  return new URL(referer).searchParams.get("scene") ?? "providers";
}

function json(response, body, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

async function requestJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function productState(scene) {
  const recovery = scene === "recovery" || scene === "flow";
  const retryAccepted = scene === "flow" && flowState.retrySubmitted;
  const failedSelection = {
    familyId: scene === "flow" ? 404 : 11,
    providerId: "openai-work",
    modelId: "gpt-5.2",
  };
  const acceptedSelection = { familyId: 11, providerId: "codex", modelId: "gpt-5.6-sol" };
  return {
    projects: [],
    threads: recovery ? [{
      id: 1,
      title: "Provider fallback review",
      rootInteractionId: 91,
      harnessId: "codex-basic",
      harnessConfigurationName: "codex-basic",
      permissionProfileId: "auto",
      active: true,
    }] : [],
    interactions: recovery ? [{
      id: 91,
      threadId: 1,
      sequence: 1,
      text: "Review the provider adapter architecture",
      completionStatus: retryAccepted ? "accepted" : "not_started",
      permissionProfileId: "auto",
      modelSelection: retryAccepted ? acceptedSelection : failedSelection,
      latestAttempt: retryAccepted ? {
        id: 45,
        attemptNumber: 2,
        outcome: "accepted",
        effectBoundary: "graph_write",
        modelSelection: acceptedSelection,
      } : {
        id: 44,
        attemptNumber: 1,
        outcome: "model_failed",
        failureCategory: "rate_limit",
        failureMessage: "OpenAI Work is rate limited. Choose another model or try again later.",
        effectBoundary: "none",
        modelSelection: failedSelection,
      },
    }] : [],
    actionInvocations: [],
    capabilities: { projects: true, threads: true, interactions: true, graph: true, harness: true, credentials: true },
  };
}

const indexHtml = await readFile(join(repositoryRoot, "desktop/renderer/index.html"), "utf8");
const evidenceHtml = indexHtml.replace(
  '<script type="module" src="./src/main.js"></script>',
  '<script type="module" src="/scripts/provider-ux-evidence-browser.mjs"></script><script type="module" src="/desktop/renderer/src/main.js"></script>',
).replaceAll('href="./', 'href="/desktop/renderer/').replaceAll('src="./', 'src="/desktop/renderer/');

const mimeTypes = new Map([
  [".css", "text/css"],
  [".html", "text/html"],
  [".js", "text/javascript"],
  [".mjs", "text/javascript"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
]);

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    const scene = sceneFromRequest(request);
    if (url.pathname === "/evidence.html") {
      response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      response.end(evidenceHtml);
      return;
    }
    if (url.pathname === "/api/model-settings") return json(response, modelSettings(scene));
    if (url.pathname === "/api/model-settings/defaults") {
      if (scene === "flow" && request.method === "PUT") {
        flowState.defaults = { ...flowState.defaults, ...await requestJson(request) };
      }
      return json(response, modelSettings(scene));
    }
    if (url.pathname === "/api/model-selection/default") {
      return json(response, { harnessId: "codex-basic", familyId: 11, providerId: "openai-work", modelId: "gpt-5.2" });
    }
    if (url.pathname === "/api/model-families" && request.method === "POST") {
      return json(response, { id: 21, name: "OpenAI Work default", kind: "custom", enabled: true, position: 0, revision: 1 }, 201);
    }
    if (url.pathname.endsWith("/model-rules") && request.method === "PUT") {
      await requestJson(request);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 800));
      response.writeHead(204, { "Cache-Control": "no-store" });
      response.end();
      return;
    }
    if (url.pathname.endsWith("/retry") && request.method === "POST") {
      flowState.retryRequest = await requestJson(request);
      flowState.retrySubmitted = true;
      return json(response, { interaction: productState(scene).interactions[0] });
    }
    if (url.pathname === "/api/permission-profiles") {
      return json(response, {
        defaultProfile: "auto",
        profiles: [
          { id: "ask", label: "Ask first", available: true },
          { id: "auto", label: "Auto", available: true },
          { id: "full", label: "Full access", available: true },
        ],
      });
    }
    if (url.pathname === "/api/state") return json(response, productState(scene));
    const target = resolve(repositoryRoot, `.${decodeURIComponent(url.pathname)}`);
    if (!target.startsWith(repositoryRoot)) return json(response, { error: "not found" }, 404);
    const body = await readFile(target);
    response.writeHead(200, { "Content-Type": mimeTypes.get(extname(target)) ?? "application/octet-stream" });
    response.end(body);
  } catch (error) {
    json(response, { error: error.message }, 404);
  }
});

await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
const { port } = server.address();
await rm(framesDirectory, { recursive: true, force: true });
await rm(variantsDirectory, { recursive: true, force: true });
await rm(motionDirectory, { recursive: true, force: true });
await mkdir(framesDirectory, { recursive: true });
await mkdir(variantsDirectory, { recursive: true });
await mkdir(motionDirectory, { recursive: true });

try {
  for (const [scene, caption] of scenes) {
    const url = `http://127.0.0.1:${port}/evidence.html?scene=${encodeURIComponent(scene)}&caption=${encodeURIComponent(caption)}${scene === "recovery" ? "&threadId=1" : ""}`;
    const frame = join(framesDirectory, `${scene}.png`);
    await rm(frame, { force: true });
    const { dom, audit } = await captureBrowserScene(url, frame, join(browserProfile, scene));
    const { size } = await stat(frame);
    if (size < 20_000) throw new Error(`Evidence frame ${scene} is unexpectedly small (${size} bytes).`);
    if (!dom.includes('data-evidence-ready="true"')) {
      await writeFile(join(framesDirectory, `${scene}.html`), dom);
      const reported = dom.match(/data-evidence-error="([^"]+)"/)?.[1];
      const familyName = dom.match(/id="currentFamilyName"[^>]*>([^<]*)/)?.[1];
      throw new Error(`Evidence scene ${scene} did not become ready${reported ? `: ${reported}` : ` (family=${familyName ?? "missing"}).`}`);
    }
    const required = {
      onboarding: ["Codex subscription", "Claude subscription", "Vercel AI Router"],
      endpoint: ["Endpoint", "gateway.example.com/openai/v1"],
      family: ["Choose your default model family", "GPT-5.2"],
      providers: ["OpenAI Work", "gateway.example.com/openai/v1", "Default provider"],
      families: ["Work coding", "Fast review", "GPT-5.6 Sol"],
      harnesses: ["Harnesses", "Codex basic", "openai-api"],
      recovery: ["OpenAI Work is rate limited", "Review the provider adapter architecture"],
    }[scene];
    for (const text of required) {
      if (!dom.includes(text)) throw new Error(`Evidence scene ${scene} is missing ${text}.`);
    }
    if (scene === "onboarding" && !audit.providerOptionsUseRovingRadio) {
      throw new Error("Provider choices do not use a single-tab-stop roving radio group.");
    }
    if (scene === "family" && !audit.onboardingUsesOnlyTrustedHarness) {
      throw new Error("Onboarding exposes an alternate harness instead of the trusted app default.");
    }
  }

  for (const { scene, caption, width, required } of variants) {
    const url = `http://127.0.0.1:${port}/evidence.html?scene=${encodeURIComponent(scene)}&caption=${encodeURIComponent(caption)}`;
    const frame = join(variantsDirectory, `${scene}.png`);
    const { dom, audit } = await captureBrowserScene(url, frame, join(browserProfile, `variant-${scene}`), width);
    const { size } = await stat(frame);
    if (size < 15_000) throw new Error(`Evidence variant ${scene} is unexpectedly small (${size} bytes).`);
    if (!dom.includes('data-evidence-ready="true"')) {
      await writeFile(join(variantsDirectory, `${scene}.html`), dom);
      const reported = dom.match(/data-evidence-error="([^"]+)"/)?.[1];
      throw new Error(`Evidence variant ${scene} did not become ready${reported ? `: ${reported}` : "."}`);
    }
    for (const text of required) {
      if (!dom.includes(text)) throw new Error(`Evidence variant ${scene} is missing ${text}.`);
    }
    if (scene === "narrow" && (!audit.compactBackVisible || !audit.compactSelectVisible || audit.compactSelectValue !== "providers")) {
      throw new Error(`Narrow Settings navigation is not usable: ${JSON.stringify(audit)}`);
    }
    if (scene === "error" && !audit.errorAssociationsValid) {
      throw new Error("Authentication errors are not visibly associated ARIA alerts.");
    }
  }

  const motionFrameCount = await recordBrowserFlow(
    `http://127.0.0.1:${port}/evidence.html?scene=flow&caption=${encodeURIComponent("Provider setup · deterministic interactive recording")}`,
    motionDirectory,
    join(browserProfile, "interactive-flow"),
  );
  if (motionFrameCount < 60) throw new Error(`Interactive evidence recording is unexpectedly short (${motionFrameCount} frames).`);
  if (flowState.retryRequest?.modelSelection?.providerId !== "codex"
    || flowState.retryRequest?.modelSelection?.modelId !== "gpt-5.6-sol"
    || !flowState.retryRequest?.text?.includes("verify retry safety")) {
    throw new Error(`Interactive retry did not preserve the edited prompt and explicit model selection: ${JSON.stringify(flowState.retryRequest)}`);
  }
  const recordedFrames = await motionEvidence(motionDirectory);
  const video = join(outputDirectory, "provider-ux-demo.mp4");
  await run(ffmpeg, [
    "-y", "-framerate", "6", "-i", join(motionDirectory, "%04d.png"),
    "-vf", "fps=30,scale=1280:800:flags=lanczos,format=yuv420p",
    "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-movflags", "+faststart", video,
  ], { maxBuffer: 1024 * 1024 * 8 });
  await copyFile(join(framesDirectory, "providers.png"), join(outputDirectory, "provider-ux-poster.png"));
  const videoStats = await stat(video);
  if (videoStats.size < 100_000) throw new Error(`Evidence video is unexpectedly small (${videoStats.size} bytes).`);
  const manifest = {
    schemaVersion: 1,
    generator: "scripts/capture-provider-ux-video.mjs",
    inference: false,
    viewport: { width: 1280, height: 800 },
    recording: {
      kind: "cdp-interaction-frames",
      frameCount: motionFrameCount,
      captureFps: 6,
      frameWidth: 1280,
      frameHeight: 800,
      ...recordedFrames,
      interactions: ["click", "type", "validate", "save", "logout", "refresh", "select", "retry"],
      mockedBoundaries: ["provider registry", "provider authentication", "model catalog", "product API", "retry execution"],
    },
    scenes: Object.fromEntries(await Promise.all(scenes.map(async ([scene, caption]) => [
      scene,
      {
        caption,
        file: `frames/${scene}.png`,
        width: 1280,
        height: 800,
        ...await fileEvidence(join(framesDirectory, `${scene}.png`)),
      },
    ]))),
    variants: Object.fromEntries(await Promise.all(variants.map(async ({ scene, caption, width }) => [
      scene,
      {
        caption,
        file: `variants/${scene}.png`,
        width,
        height: 800,
        ...await fileEvidence(join(variantsDirectory, `${scene}.png`)),
      },
    ]))),
    poster: {
      file: "provider-ux-poster.png",
      width: 1280,
      height: 800,
      ...await fileEvidence(join(outputDirectory, "provider-ux-poster.png")),
    },
    video: {
      file: "provider-ux-demo.mp4",
      codec: "h264",
      width: 1280,
      height: 800,
      ...await fileEvidence(video),
    },
  };
  await writeFile(join(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ outputDirectory, video, scenes: scenes.map(([scene]) => scene), bytes: videoStats.size })}\n`);
} finally {
  server.close();
  await rm(browserProfile, { recursive: true, force: true });
}
