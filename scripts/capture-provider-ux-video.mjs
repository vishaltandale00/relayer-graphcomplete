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
  ["alternate-harness", "Explicitly choose a compatible alternate harness"],
  ["providers", "Manage independent provider connections"],
  ["families", "Configure harness-agnostic model families"],
  ["harnesses", "Inspect currently usable harnesses"],
  ["recovery", "Recover the same unsent turn with an explicit model choice"],
];
const variants = [
  { scene: "light", caption: "Light appearance", width: 1280, required: ["OpenAI Work", "data-theme=\"light\""] },
  { scene: "narrow", caption: "Narrow responsive settings", width: 620, required: ["OpenAI Work", "Providers"] },
  { scene: "long-label", caption: "Long provider identity", width: 1280, required: ["North America Platform Engineering and Applied Research"] },
  { scene: "loading", caption: "Connecting and discovering models", width: 1280, required: ["Connecting and discovering models"] },
  { scene: "invalid", caption: "Invalid connection details", width: 1280, required: ["Use an HTTPS endpoint", "Enter API key"] },
  { scene: "error", caption: "Authentication error", width: 1280, required: ["Authentication failed", "Check the API key"] },
  { scene: "unavailable", caption: "Unavailable provider", width: 1280, required: ["Connection unavailable", "OpenAI Work"] },
  { scene: "stale", caption: "Stale catalog member", width: 1280, required: ["This model is no longer in the provider catalog", "Work coding"] },
  { scene: "removed", caption: "Provider removal in progress", width: 1280, required: ["Finishing removal", "Removing"] },
  { scene: "no-compatible", caption: "No compatible harness recovery", width: 1280, required: ["No compatible harness", "Connect another provider", "OpenAI Work"] },
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
            authErrorAnnounced: document.querySelector("#authStatus")?.getAttribute("role") === "alert"
              && document.querySelector("#authStatus")?.textContent.trim().length > 0,
            onboardingBusyLocksControls: (() => {
              const card = document.querySelector(".provider-setup-card");
              const controls = [...(card?.querySelectorAll("button,input,select,textarea") ?? [])];
              const cancel = controls.find((control) => control.id === "cancelProviderConnection");
              return card?.getAttribute("aria-busy") === "true"
                && controls.length > 0
                && cancel?.disabled === false
                && controls.filter((control) => control !== cancel).every((control) => control.disabled);
            })(),
            customFamilyHasNoImplicitMembers: [...document.querySelectorAll("[data-onboarding-member-model]")]
              .every((input) => !input.checked),
            providerOptionsUseRovingRadio: (() => {
              const options = [...document.querySelectorAll("[data-provider-adapter]")];
              return options.length > 0
                && options.every((button) => button.tagName === "BUTTON" && button.getAttribute("role") === "radio")
                && options.filter((button) => button.tabIndex === 0).length === 1
                && options.filter((button) => button.getAttribute("aria-checked") === "true").length === 1;
            })(),
            onboardingHarnessChoiceIsExplicit: (() => {
              const choices = [...document.querySelectorAll("[data-onboarding-harness]")];
              return choices.length > 1
                && choices.every((choice) => choice.getAttribute("role") === "radio")
                && choices.filter((choice) => choice.getAttribute("aria-checked") === "true").length <= 1;
            })(),
            firstInvalidFocused: invalidInputs.length > 0 && document.activeElement === invalidInputs[0],
            connectedProviderRetained: Boolean(window.__providerEvidence?.definitions?.some((definition) => definition.id === "openai-work")),
            harnessMarkup: document.querySelector("#harnessConfigurationList")?.innerHTML ?? "",
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
      await caption("2 · Confirm a compatible harness and explicitly create a family");
      await click('[data-onboarding-family-kind="create"]');
      await click('[data-onboarding-member-model="gpt-5.2-mini"]');
      await click("#finishProviderSetup");
      await waitFor(`(() => {
        const accountStep = document.querySelector('#desktopAccountOnboarding');
        return !accountStep.classList.contains('hidden')
          && document.querySelector('#authScreen').classList.contains('hidden')
          && !document.querySelector('#appShell').classList.contains('hidden')
          && document.body.classList.contains('desktop-account-pending');
      })()`, "isolated optional account step");
      await caption("3 · Choose optional Relayer account sign-in before entering the workspace");
      await click("#desktopAccountOnboardingNotNow");
      await waitFor("!document.querySelector('#appShell').classList.contains('hidden') && !document.body.classList.contains('desktop-account-pending')", "desktop application");
      await evaluate(`(() => {
        const control = document.querySelector('#desktopAccountButton');
        const style = getComputedStyle(control);
        if (!control.closest('.sidebar-footer')) {
          throw new Error('Account control is not seated in the sidebar footer.');
        }
        // Computed, not asserted from source: jsdom has no layout engine, so
        // the footer's fit and its accessible names can only be proven here.
        const footer = document.querySelector('.sidebar-footer');
        const settings = document.querySelector('#settingsButton');
        const indicator = document.querySelector('#updateButton');
        const label = document.querySelector('#desktopAccountLabel');
        const wasHidden = indicator.classList.contains('hidden');
        const previousLabel = label.textContent;
        indicator.classList.remove('hidden');
        label.textContent = 'Signing in…';
        const probe = document.createElement('span');
        probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font:' + getComputedStyle(label).font;
        probe.textContent = label.textContent;
        document.body.appendChild(probe);
        const naturalWidth = probe.getBoundingClientRect().width;
        probe.remove();
        const overflowed = footer.scrollWidth > footer.clientWidth;
        const indicatorWidth = indicator.getBoundingClientRect().width;
        const labelVisible = label.getClientRects().length > 0;
        const wrapped = labelVisible && naturalWidth > label.getBoundingClientRect().width + 0.5;
        const settingsName = settings.getAttribute('aria-label');
        const indicatorName = indicator.getAttribute('aria-label');
        if (wasHidden) indicator.classList.add('hidden');
        label.textContent = previousLabel;
        if (overflowed) throw new Error('Sidebar footer overflows with the update indicator visible.');
        if (indicatorWidth < 30.5) throw new Error('Update indicator was shrunk to ' + indicatorWidth + 'px.');
        if (wrapped) throw new Error('A busy account label wraps inside the footer control.');
        if (settingsName !== 'Settings') throw new Error('Settings is named ' + JSON.stringify(settingsName) + '.');
        if (!indicatorName || /available/i.test(indicatorName)) {
          throw new Error('Update indicator claims a state it may not be in: ' + JSON.stringify(indicatorName));
        }
        if (style.position === 'fixed') {
          throw new Error('Account control still floats over the workspace.');
        }
        if (!document.querySelector('.sidebar-footer #settingsButton')) {
          throw new Error('Account control did not join Settings in the sidebar footer.');
        }
        if (/preview|stable/i.test(control.textContent)) {
          throw new Error('Everyday account control leaked release-channel presentation.');
        }
        return true;
      })()`);
      await caption("4 · Start Relayer sign-in directly from the sidebar footer control");
      await click("#desktopAccountButton");
      await waitFor("window.__providerEvidence.accountLoginCalls === 1 && document.querySelector('#desktopAccountButton').textContent === 'Signing in…'", "direct sidebar-footer account sign-in");
      await click('[data-model-picker="new"] [data-model-picker-trigger]');
      await waitFor(`(() => {
        const picker = document.querySelector('[data-model-picker="new"]');
        return picker?.querySelector('[data-model-family]')?.value === '21'
          && picker.querySelector('[data-model-option][data-provider-id="openai-work"][data-model-id="gpt-5.2-mini"]')?.getAttribute('aria-checked') === 'true';
      })()`, "onboarded family available in chat before opening Settings");

      await caption("5 · Add and sign out a managed subscription");
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

      await caption("6 · Confirm the currently usable harnesses");
      await click('[data-settings-tab="harnesses"]');
      await waitFor(`(() => {
        const list = document.querySelector('#harnessConfigurationList');
        return list?.querySelector('[data-harness-configuration="codex-basic"]')
          && !list.querySelector('button')
          && !list.textContent.includes('Advanced configuration')
          && !list.textContent.includes('Claude basic');
      })()`, "read-only usable harness list");
      await capture(8);

      await caption("7 · Edit, reselect, and retry the same unsent turn");
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
  family: null,
  retrySubmitted: false,
  retryRequest: null,
};

const modelSettings = (scene) => ({
  defaults: scene === "flow" ? { ...flowState.defaults } : {
    harnessId: "codex-basic",
    providerId: ["family", "no-compatible"].includes(scene) ? null : "openai-work",
    familyId: ["onboarding", "endpoint", "family", "no-compatible"].includes(scene) ? null : 11,
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
        {
          id: "gpt-5.2",
          label: "GPT-5.2",
          visible: true,
          available: scene !== "stale",
          unavailableReason: scene === "stale" ? "This model is no longer in the provider catalog." : null,
          providerDefault: true,
        },
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
    ...(scene === "flow" && flowState.family ? [flowState.family] : []),
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
      usableNow: true,
      usableProviderIds: ["openai-work", "codex"],
      usableFamilyIds: [11, 12],
    },
    {
      id: "claude-basic",
      label: "Claude basic",
      available: true,
      revision: 2,
      executionAccessContracts: ["managed-runtime@1"],
      compatibleProviderIds: [],
      modelRules: { allow: [{ adapterId: "anthropic-api", modelIdRegex: "^claude-" }], deny: [] },
      usableNow: false,
      usableProviderIds: [],
      usableFamilyIds: [],
    },
  ],
});

const onboardingProjection = (scene, providerId = "openai-work") => ({
  provider: scene === "alternate-harness"
    ? { id: providerId, label: "Claude Work", adapterId: "claude-subscription", accessContract: "managed-runtime@1" }
    : { id: providerId, label: "OpenAI Work", adapterId: "openai-api", accessContract: "secret@1" },
  appDefaultHarnessId: "codex-basic",
  initialHarnessId: ["family", "no-compatible", "alternate-harness"].includes(scene) ? null : "codex-basic",
  harnesses: [
    {
      id: "codex-basic",
      label: "Codex basic",
      configurationRevision: 7,
      selectable: !["family", "no-compatible", "alternate-harness"].includes(scene),
      selectedInitially: !["family", "no-compatible", "alternate-harness"].includes(scene),
      ...(["family", "no-compatible", "alternate-harness"].includes(scene)
        ? { incompatibilityReason: { code: "model_rules_denied", message: "The app default does not allow this provider's models." } }
        : { matchingAccessContract: "secret@1" }),
      existingCustomFamilies: [],
      existingManagedFamilies: [],
      eligibleModels: [
        { providerId, modelId: "gpt-5.2", label: "GPT-5.2" },
        { providerId, modelId: "gpt-5.2-mini", label: "GPT-5.2 mini" },
      ],
    },
    ...(scene === "family" ? [{
      id: "universal-coding",
      label: "Universal coding",
      configurationRevision: 3,
      selectable: true,
      selectedInitially: false,
      matchingAccessContract: "secret@1",
      existingCustomFamilies: [],
      existingManagedFamilies: [],
      eligibleModels: [
        { providerId, modelId: "gpt-5.2", label: "GPT-5.2" },
        { providerId, modelId: "gpt-5.2-mini", label: "GPT-5.2 mini" },
      ],
    }] : []),
    {
      id: "claude-basic",
      label: "Claude basic",
      configurationRevision: 2,
      selectable: scene === "alternate-harness",
      selectedInitially: false,
      ...(scene === "alternate-harness"
        ? { matchingAccessContract: "managed-runtime@1" }
        : { incompatibilityReason: { code: "access_contract_mismatch", message: "This harness requires managed runtime access." } }),
      existingCustomFamilies: [],
      existingManagedFamilies: [],
      eligibleModels: scene === "alternate-harness"
        ? [{ providerId, modelId: "claude-sonnet-4", label: "Claude Sonnet" }]
        : [],
    },
  ],
  projectionRevision: "sha256:evidence-projection",
  ...(scene === "no-compatible" ? {
    blockingReason: { code: "no_compatible_harness", message: "No compatible harness is available. Connect another provider to continue." },
  } : {}),
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
    if (url.pathname === "/api/provider-onboarding/projection") {
      return json(response, onboardingProjection(scene, url.searchParams.get("providerId") ?? "openai-work"));
    }
    if (url.pathname === "/api/provider-onboarding/default" && request.method === "POST") {
      await requestJson(request);
      return json(response, null);
    }
    if (url.pathname === "/api/provider-onboarding/complete" && request.method === "POST") {
      const intent = await requestJson(request);
      const member = intent.family?.members?.[0] ?? { providerId: intent.providerId, modelId: "gpt-5.2" };
      flowState.defaults = { harnessId: intent.harnessId, providerId: intent.providerId, familyId: 21 };
      flowState.family = {
        id: 21,
        name: intent.family?.name ?? "OpenAI Work default",
        kind: intent.family?.kind === "managed" ? "system" : "custom",
        enabled: true,
        position: 2,
        revision: 1,
        members: (intent.family?.members ?? [member]).map((value, position) => ({ ...value, position })),
      };
      return json(response, {
        defaults: { providerId: intent.providerId, harnessId: intent.harnessId, familyId: 21 },
        resolution: { familyId: 21, familyRevision: 1, resolvableMembers: [{ ...member, position: 0 }] },
      });
    }
    if (url.pathname === "/api/provider-onboarding/status") {
      return json(response, { complete: flowState.defaults.familyId != null, defaults: flowState.defaults });
    }
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
    if (/^\/api\/threads\/[^/]+\/context-drafts$/.test(url.pathname)) {
      return json(response, { drafts: [] });
    }
    const inputDraftMatch = /^\/api\/threads\/([^/]+)\/input-draft$/.exec(url.pathname);
    if (inputDraftMatch && request.method === "GET") {
      return json(response, {
        threadId: Number(decodeURIComponent(inputDraftMatch[1])),
        revision: 0,
        attachments: [],
        updatedAt: "2026-08-31T00:00:00.000Z",
      });
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
      onboarding: [
        "Codex subscription", "Claude subscription", "OpenAI API", "Anthropic API", "OpenRouter", "Vercel AI Router",
      ],
      endpoint: ["Endpoint", "gateway.example.com/openai/v1"],
      family: ["Choose your default model family", "GPT-5.2"],
      "alternate-harness": ["Choose your default model family", "Claude basic", "Claude Sonnet"],
      providers: ["OpenAI Work", "gateway.example.com/openai/v1", "Default provider"],
      families: ["Work coding", "Fast review", "GPT-5.6 Sol"],
      harnesses: ["Harnesses", "Codex basic", "Default harness"],
      recovery: ["OpenAI Work is rate limited", "Review the provider adapter architecture"],
    }[scene];
    for (const text of required) {
      if (!dom.includes(text)) throw new Error(`Evidence scene ${scene} is missing ${text}.`);
    }
    if (scene === "harnesses") {
      for (const internal of ["Claude basic", "OpenAI Work", "Work coding", "Fast review", "Advanced configuration", "Configure other harnesses", "Execution access", "Revision", "managed-runtime@1", "openai-api", "Available"]) {
        if (audit.harnessMarkup.includes(internal)) throw new Error(`Evidence scene harnesses exposes ${internal}.`);
      }
    }
    if (scene === "onboarding" && !audit.providerOptionsUseRovingRadio) {
      throw new Error("Provider choices do not use a single-tab-stop roving radio group.");
    }
    if (scene === "family" && !audit.onboardingHarnessChoiceIsExplicit) {
      throw new Error("Onboarding harness choices do not expose explicit radio semantics.");
    }
    if (scene === "family" && !audit.customFamilyHasNoImplicitMembers) {
      throw new Error("Onboarding silently selected a custom-family member.");
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
    if (["error", "invalid"].includes(scene) && !audit.errorAssociationsValid) {
      throw new Error("Authentication errors are not visibly associated ARIA alerts.");
    }
    if (scene === "error" && !audit.authErrorAnnounced) {
      throw new Error("Authentication failure is not announced as an alert.");
    }
    if (scene === "loading" && !audit.onboardingBusyLocksControls) {
      throw new Error("Provider onboarding controls are editable while connection is busy.");
    }
    if (scene === "invalid" && !audit.firstInvalidFocused) {
      throw new Error("Invalid connection details do not focus the first invalid field.");
    }
    if (scene === "no-compatible" && !audit.connectedProviderRetained) {
      throw new Error("No-compatible recovery discarded the connected provider definition.");
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
    activeAdapters: adapters.map(({ adapterId }) => adapterId),
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
