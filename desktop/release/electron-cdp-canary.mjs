import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
  }

  async open() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolvePromise, reject) => {
      this.socket.addEventListener("open", resolvePromise, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    this.socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) pending.reject(new Error("Electron DevTools connection closed."));
      this.pending.clear();
    });
  }

  call(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Renderer evaluation failed.");
    }
    return result.result?.value;
  }

  close() {
    this.socket?.close();
  }
}

async function connect(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { cache: "no-store" });
      if (!response.ok) throw new Error(`DevTools target discovery returned ${response.status}.`);
      const targets = await response.json();
      const target = targets.find((candidate) => candidate.type === "page" && candidate.webSocketDebuggerUrl);
      if (!target) throw new Error("No Electron renderer DevTools target is available.");
      const client = new CdpClient(target.webSocketDebuggerUrl);
      await client.open();
      await client.call("Runtime.enable");
      await client.call("Page.enable");
      return client;
    } catch (error) {
      lastError = error;
      await delay(500);
    }
  }
  throw new Error(`Timed out connecting to Electron DevTools: ${lastError?.message || "unknown error"}`);
}

async function waitForUpdater(client, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let state;
  while (Date.now() < deadline) {
    state = await client.evaluate("window.relayerDesktop?.updater?.status?.()");
    if (state && predicate(state)) return state;
    if (state?.phase === "failed") throw new Error(`Updater failed: ${state.error || "unknown error"}`);
    await delay(500);
  }
  throw new Error(`Timed out waiting for updater state; last state=${JSON.stringify(state)}.`);
}

async function capture(client, outputPath) {
  const result = await client.call("Page.captureScreenshot", { format: "png", fromSurface: true });
  await writeFile(resolve(outputPath), Buffer.from(result.data, "base64"), { mode: 0o600 });
}

async function waitForRendererState(client, expression, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let state;
  while (Date.now() < deadline) {
    state = await client.evaluate(expression);
    if (state && predicate(state)) return state;
    await delay(250);
  }
  throw new Error(`Timed out waiting for visible updater evidence; last state=${JSON.stringify(state)}.`);
}

async function showUpdaterPopover(client, { title, detail, timeoutMs }) {
  await waitForRendererState(client, `(() => {
    const popover = document.querySelector("#updatePopover");
    popover?.classList.remove("hidden");
    popover?.style.setProperty("display", "block", "important");
    popover?.style.setProperty("z-index", "1000", "important");
    const bounds = popover?.getBoundingClientRect();
    const style = popover ? getComputedStyle(popover) : null;
    const topmost = bounds ? document.elementFromPoint(
      bounds.left + (bounds.width / 2),
      bounds.top + (bounds.height / 2),
    ) : null;
    return {
      visible: Boolean(
        bounds && bounds.width > 0 && bounds.height > 0 &&
        style?.display !== "none" && style?.visibility !== "hidden" &&
        topmost && popover?.contains(topmost)
      ),
      title: document.querySelector("#updateTitle")?.textContent || "",
      detail: document.querySelector("#updateDetail")?.textContent || "",
    };
  })()`, (state) => state.visible && state.title === title && state.detail === detail, timeoutMs);
}

export async function driveElectronUpdateCanary({
  port,
  targetVersion,
  availableScreenshotPath,
  readyScreenshotPath,
  timeoutMs = 20 * 60 * 1000,
} = {}) {
  const client = await connect(port, timeoutMs);
  try {
    await waitForUpdater(client, () => true, timeoutMs);
    await client.evaluate("window.relayerDesktop.updater.setChannel('preview')");
    await client.evaluate("window.relayerDesktop.updater.check()");
    await waitForUpdater(client, (state) => (
      state.phase === "available" && state.availableVersion === targetVersion && state.channel === "preview"
    ), timeoutMs);
    await showUpdaterPopover(client, {
      title: "Update available",
      detail: `Version ${targetVersion} available`,
      timeoutMs,
    });
    await capture(client, availableScreenshotPath);
    await client.evaluate("window.relayerDesktop.updater.download()");
    await waitForUpdater(client, (state) => (
      state.phase === "ready" && state.availableVersion === targetVersion && state.channel === "preview"
    ), timeoutMs);
    await showUpdaterPopover(client, {
      title: "Ready to restart",
      detail: "Ready to restart",
      timeoutMs,
    });
    await capture(client, readyScreenshotPath);
    try {
      await client.evaluate("window.relayerDesktop.updater.install()");
    } catch (error) {
      if (!/connection closed/i.test(error.message)) throw error;
    }
  } finally {
    client.close();
  }
}

export async function captureElectronRenderer({ port, outputPath, timeoutMs = 60_000 } = {}) {
  const client = await connect(port, timeoutMs);
  try {
    await capture(client, outputPath);
  } finally {
    client.close();
  }
}

export async function captureInstalledUpdateState({ port, outputPath, targetVersion, timeoutMs = 60_000 } = {}) {
  const client = await connect(port, timeoutMs);
  try {
    await waitForUpdater(client, (state) => (
      state.phase === "idle" && state.version === targetVersion && state.channel === "preview" && state.error == null
    ), timeoutMs);
    await waitForRendererState(client, `(() => {
      const auth = document.querySelector("#authScreen");
      const shell = document.querySelector("#appShell");
      const settings = document.querySelector("#settingsView");
      const newThread = document.querySelector("#newThreadView");
      const thread = document.querySelector("#threadView");
      auth?.classList.add("hidden");
      auth?.style.setProperty("display", "none", "important");
      shell?.classList.remove("hidden");
      shell?.style.setProperty("display", "flex", "important");
      document.querySelector("#settingsButton")?.click();
      document.querySelector('[data-settings-tab="updates"]')?.click();
      newThread?.classList.add("hidden");
      newThread?.style.setProperty("display", "none", "important");
      thread?.classList.add("hidden");
      thread?.style.setProperty("display", "none", "important");
      settings?.classList.remove("hidden");
      settings?.style.setProperty("display", "block", "important");
      document.querySelector("#settingsButton")?.classList.add("active");
      const updateSection = [...(settings?.querySelectorAll(".settings-section") || [])].find(
        (section) => section.querySelector("h2")?.textContent === "Application updates",
      );
      updateSection?.classList.remove("hidden");
      updateSection?.style.setProperty("display", "block", "important");
      for (const section of settings?.querySelectorAll(".settings-section") || []) {
        if (section !== updateSection) section.style.setProperty("display", "none", "important");
      }
      updateSection?.scrollIntoView({ block: "center" });
      const bounds = settings?.getBoundingClientRect();
      const updateBounds = updateSection?.getBoundingClientRect();
      const settingsStyle = settings ? getComputedStyle(settings) : null;
      const updateStyle = updateSection ? getComputedStyle(updateSection) : null;
      const shellStyle = shell ? getComputedStyle(shell) : null;
      const topmost = updateBounds ? document.elementFromPoint(
        updateBounds.left + (updateBounds.width / 2),
        updateBounds.top + (updateBounds.height / 2),
      ) : null;
      return {
        visible: Boolean(
          bounds && bounds.width > 0 && bounds.height > 0 &&
          updateBounds && updateBounds.width > 0 && updateBounds.height > 0 &&
          settingsStyle?.display !== "none" && settingsStyle?.visibility !== "hidden" &&
          updateStyle?.display !== "none" && updateStyle?.visibility !== "hidden" &&
          shellStyle?.display !== "none" && shellStyle?.visibility !== "hidden" &&
          topmost && updateSection?.contains(topmost)
        ),
        version: document.querySelector("#currentVersion")?.textContent || "",
        status: document.querySelector("#updateStatus")?.textContent || "",
        channel: document.querySelector("#updateChannel")?.value || "",
        // When the section is present and correct but something sits on top of
        // it, name that element. Otherwise the failure only reports
        // "visible: false" and every candidate overlay stays a guess.
        topmost: topmost
          ? topmost.tagName.toLowerCase() + "#" + (topmost.id || "-") + "." + (topmost.className || "-")
          : "none",
      };
    })()`, (state) => (
      state.visible && state.version === `Current version ${targetVersion}` &&
      state.status === "Up to date" && state.channel === "preview"
    ), timeoutMs);
    await capture(client, outputPath);
  } finally {
    client.close();
  }
}

function argument(name, { optional = false } = {}) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
  if (!value && !optional) throw new Error(`Missing required --${name} argument.`);
  return value || null;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = argument("mode");
  const port = Number(argument("port"));
  const timeoutMs = Number(argument("timeout-seconds", { optional: true }) || "1200") * 1000;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be a valid TCP port.");
  if (mode === "update") {
    await driveElectronUpdateCanary({
      port,
      targetVersion: argument("target-version"),
      availableScreenshotPath: argument("screenshot-available"),
      readyScreenshotPath: argument("screenshot-ready"),
      timeoutMs,
    });
  } else if (mode === "capture") {
    await captureElectronRenderer({ port, outputPath: argument("screenshot"), timeoutMs });
  } else if (mode === "capture-installed") {
    await captureInstalledUpdateState({
      port,
      outputPath: argument("screenshot"),
      targetVersion: argument("target-version"),
      timeoutMs,
    });
  } else {
    throw new Error("--mode must be update, capture, or capture-installed.");
  }
  console.log(JSON.stringify({ ok: true, mode }, null, 2));
}
