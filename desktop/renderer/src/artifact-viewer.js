// The artifact viewer's chrome (PRD 6.6). In Relayer Desktop the artifact itself
// renders in an isolated native view that main places inside `.artifact-stage`;
// this module only draws the strip, toolbar and status around it. Where no native
// view exists (Eval review, shared snapshots) local artifacts show a card and
// https sites play in a sandboxed frame.
import { createRelayerIcon } from "./product-workspace/icons.js";

const KIND_LABELS = Object.freeze({
  website: "Website", pdf: "PDF", video: "Video", image: "Image", markdown: "Markdown", url: "Deployed site", app: "Web app",
});
const STRIP_HEIGHT = 26;
const TOOLBAR_HEIGHT = 46;
const TOOLBAR_HIDE_MS = 3000;
const VIEWPORTS = Object.freeze({ phone: [390, 844], tablet: [820, 1180] });

export function artifactLayerNode(layer) {
  if (layer?.layer?.renderer !== "artifact") return null;
  const node = layer.nodes?.[0];
  return node && typeof node.artifact === "object" && node.artifact !== null ? node : null;
}

const addressedByUrl = (kind) => kind === "url" || kind === "app";

export function artifactAddress(artifact) {
  if (addressedByUrl(artifact?.kind)) return `${String(artifact.source?.url ?? "")}${artifact.kind === "app" ? artifact.part?.route ?? "" : ""}`;
  const file = String(artifact?.source?.file ?? "");
  const route = artifact?.part?.route ?? "";
  const part = artifact?.part ?? {};
  const time = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
  const detail = artifact?.kind === "pdf" && part.page ? ` · page ${part.page}`
    : artifact?.kind === "video" && Number.isFinite(part.start) && Number.isFinite(part.end) ? ` · ${time(part.start)}–${time(part.end)}`
      : artifact?.kind === "markdown" && part.heading ? ` · ${part.heading}`
        : "";
  return `${file}${artifact?.kind === "website" ? route : ""}${detail}`;
}

function element(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node[key] = value;
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) if (child) node.append(child);
  return node;
}

function iconFor(name) {
  try { return createRelayerIcon(name); } catch { return element("span", { "aria-hidden": "true" }); }
}

/**
 * Create one viewer for a document. `native` is window.relayerDesktop.artifactViewer
 * when available. `onAddToChat(text)` puts a message in the thread composer.
 */
export function createArtifactViewer({ root = document.body, native = null, onAddToChat = null, onClose = () => {}, liveUrls = true } = {}) {
  let current = null;
  let unsubscribe = () => {};
  let hideTimer = null;
  let resizeObserver = null;

  function stageBounds(stage) {
    const rect = stage.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  }

  function placeView() {
    if (!current?.nativeOpen) return;
    void native.setBounds(stageBounds(current.device ?? current.stage));
  }

  function showToolbar() {
    if (!current) return;
    current.overlay.classList.remove("artifact-toolbar-hidden");
    placeView();
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!current) return;
      if (current.toolbar.contains(document.activeElement)) return showToolbar();
      current.overlay.classList.add("artifact-toolbar-hidden");
      placeView();
    }, TOOLBAR_HIDE_MS);
  }

  function setBadge(name, label, tone = "") {
    if (!current) return;
    let badge = current.badges.querySelector(`[data-badge="${name}"]`);
    if (!label) { badge?.remove(); return; }
    if (!badge) {
      badge = element("span", { class: `artifact-badge ${tone}`, "data-badge": name });
      current.badges.append(badge);
    }
    badge.textContent = label;
  }

  function showCard({ icon, title, body, code = null, note, log = null, action, actions = action ? [action] : [] }) {
    current.log = log === null ? null : element("pre", { class: "artifact-card-log", text: log });
    current.card.replaceChildren(...[
      iconFor(icon),
      element("h2", { text: title }),
      body ? element("p", { text: body }) : null,
      code ? element("code", { class: "artifact-card-command", text: code }) : null,
      note ? element("p", { class: "artifact-card-note", text: note }) : null,
      current.log,
      actions.some(Boolean) ? element("div", { class: "artifact-card-actions" }, actions.filter(Boolean).map((item, index) => (
        element("button", { type: "button", class: index === 0 ? "artifact-card-action" : "artifact-card-action artifact-card-secondary", text: item.label, onclick: item.run })
      ))) : null,
    ].filter(Boolean));
    current.card.hidden = false;
  }

  function addToChat(text) {
    if (!onAddToChat) return null;
    return { label: "Add to chat", run: () => { const message = text; close(); onAddToChat(message); } };
  }

  function onEvent(event) {
    if (!current) return;
    if (event?.type === "escape") close();
    // Only sites navigate; other kinds keep the address of the file they show.
    else if (event?.type === "address" && typeof event.url === "string" && ["website", "url"].includes(current.artifact.kind)) {
      const address = current.artifact.kind === "url" ? event.url : current.fileAddress(event.url);
      current.address.textContent = address;
      current.strip.textContent = address;
    } else if (event?.type === "page-error") {
      current.errors.push(event.message);
      setBadge("errors", `${current.errors.length} page error${current.errors.length === 1 ? "" : "s"}`, "artifact-badge-error");
      const badge = current.badges.querySelector('[data-badge="errors"]');
      badge.title = `${current.errors.join("\n")}${onAddToChat ? "\n\nClick to add these errors to the chat." : ""}`;
      if (onAddToChat && !badge.onclick) {
        badge.setAttribute("role", "button");
        badge.tabIndex = 0;
        badge.onclick = () => {
          const errors = [...new Set(current.errors)].join("\n");
          addToChat(`The artifact "${current.title}" shows page errors:\n${errors}`)?.run();
        };
      }
    } else if (event?.type === "load-failed") {
      setBadge("load", "Did not load", "artifact-badge-error");
      current.badges.querySelector('[data-badge="load"]').title = event.message ?? "";
    } else if (event?.type === "server-starting") {
      showCard({ icon: "loader", title: "Starting the app", code: event.command, note: "Running in the thread folder. The log appears below.", log: "" });
    } else if (event?.type === "server-log" && current.log) {
      current.log.textContent = `${current.log.textContent}${event.text}`.slice(-20_000);
      current.log.scrollTop = current.log.scrollHeight;
    } else if (event?.type === "external") {
      setBadge("external", "Opened a link in your browser");
      setTimeout(() => setBadge("external", null), 3500);
    }
  }

  function close() {
    if (!current) return;
    const closing = current;
    current = null;
    clearTimeout(hideTimer);
    resizeObserver?.disconnect();
    unsubscribe();
    unsubscribe = () => {};
    document.removeEventListener("keydown", onKeyDown, true);
    // Always tell main, so an open still in flight there is dropped too.
    if (native) void native.close();
    closing.overlay.remove();
    onClose();
  }

  function onKeyDown(event) {
    if (event.key !== "Escape" || !current) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  }

  async function open({ threadId, node, approveServer = false }) {
    close();
    const artifact = node.artifact;
    const kindLabel = KIND_LABELS[artifact.kind] ?? "Artifact";
    // Only an https site can play without Relayer; shares and Eval show nothing of a local path.
    const liveSite = artifact.kind === "url" && /^https:\/\//u.test(artifactAddress(artifact));
    const shown = native || liveSite ? artifactAddress(artifact) : node.title;
    const address = element("span", { class: "artifact-address-text", text: shown });
    const strip = element("div", { class: "artifact-strip-text", text: shown });
    const badges = element("div", { class: "artifact-badges" });
    const back = element("button", { type: "button", class: "artifact-tool", title: "Back to the graph (Esc)", onclick: () => close() },
      iconFor("arrow-left"), element("span", { text: "Graph" }));
    const more = element("button", { type: "button", class: "artifact-tool artifact-icon-tool", title: "More", "aria-label": "More" }, iconFor("ellipsis"));
    const toolbar = element("header", { class: "artifact-toolbar", role: "toolbar", "aria-label": "Artifact viewer" },
      back,
      element("div", { class: "artifact-title" }, iconFor(node.icon || "file"), element("b", { text: node.title }), element("small", { text: kindLabel })),
      native || liveSite ? element("div", { class: "artifact-address", title: "Where this artifact comes from" }, iconFor(artifact.kind === "url" ? "lock" : artifact.kind === "app" ? "server" : "file"), address) : null,
      badges,
      element("span", { class: "artifact-spacer" }),
      native ? more : null);
    const stripRow = element("div", { class: "artifact-strip", title: "Move the pointer here for the toolbar · Esc returns to the graph" }, strip);
    const stage = element("div", { class: "artifact-stage" });
    // A website or URL may ask for a phone or tablet screen; the view then sits in a device-sized frame.
    const viewport = ["website", "url", "app"].includes(artifact.kind) ? VIEWPORTS[artifact.viewport] : undefined;
    const device = viewport ? element("div", { class: `artifact-device artifact-device-${artifact.viewport}` }) : null;
    // The renderer CSP blocks style attributes; CSSOM properties are allowed.
    if (device) Object.assign(device.style, { width: `${viewport[0]}px`, height: `${viewport[1]}px` });
    if (device) stage.append(device, element("span", { class: "artifact-device-label", text: `${artifact.viewport} · ${viewport[0]}×${viewport[1]}` }));
    const card = element("section", { class: "artifact-card", hidden: true, "aria-live": "polite" });
    const overlay = element("section", { class: "artifact-viewer", role: "dialog", "aria-modal": "true", "aria-label": `${node.title} (${kindLabel})`, tabindex: "-1" },
      stripRow, toolbar, stage, card);
    current = {
      overlay, toolbar, stage, device, card, badges, address, strip, artifact, title: node.title, errors: [], nativeOpen: false,
      fileAddress: (url) => {
        try {
          const parsed = new URL(url);
          return `${artifact.source.root.replace(/\/$/u, "")}${decodeURIComponent(parsed.pathname)}${parsed.search}${parsed.hash}`.replace(/^\//u, "");
        } catch { return artifactAddress(artifact); }
      },
    };
    root.append(overlay);
    stripRow.addEventListener("mouseenter", showToolbar);
    toolbar.addEventListener("mousemove", showToolbar);
    toolbar.addEventListener("focusin", showToolbar);
    document.addEventListener("keydown", onKeyDown, true);
    // Focus the dialog, not a toolbar button, so the toolbar can hide; Tab reaches the tools.
    overlay.focus({ preventScroll: true });
    showToolbar();

    if (!native) {
      if (liveSite && liveUrls) {
        (device ?? stage).append(element("iframe", {
          class: "artifact-frame",
          src: artifactAddress(artifact) + (artifact.part?.route ?? ""),
          title: node.title,
          sandbox: "allow-scripts allow-same-origin allow-forms",
          allow: "camera 'none'; microphone 'none'; geolocation 'none'",
          referrerpolicy: "no-referrer",
        }));
      } else {
        showCard({
          icon: node.icon || "file",
          title: node.title,
          body: kindLabel,
          note: artifact.kind === "url"
            ? "Open this site in your browser to view it."
            : "Available in Relayer on the machine that made it.",
        });
      }
      return;
    }

    unsubscribe = native.onEvent(onEvent);
    resizeObserver = new ResizeObserver(() => placeView());
    resizeObserver.observe(stage);
    more.onclick = () => {
      const rect = more.getBoundingClientRect();
      void native.showMenu({ x: rect.left, y: rect.bottom + 4 });
    };
    const opening = current;
    let result;
    try {
      result = await native.open({ threadId: Number(threadId), nodeId: Number(node.id), artifact, bounds: stageBounds(device ?? stage), approveServer });
    } catch (error) {
      if (current !== opening) return;
      showCard({ icon: "triangle-alert", title: "This artifact could not open", body: String(error?.message ?? error) });
      return;
    }
    // A newer open or a close overtook this one; main has already dropped its view.
    if (current !== opening || result?.status?.state === "superseded") return;
    // A web app's server invoke (PRD 6.6.6): approve once per thread, or see why it failed.
    if (result?.status?.state === "approval-required") {
      const confined = result.status.permissionProfileId !== "full";
      showCard({
        icon: "server",
        title: "Start this web app?",
        body: `${node.title} runs from the thread folder with:`,
        code: result.status.command,
        note: `${confined ? "It can write only inside the thread folder." : "This thread has full access, so the command is not confined."} Relayer asks once per thread, and stops a server it started after it sits unused.`,
        actions: [
          { label: "Run", run: () => void open({ threadId, node, approveServer: true }) },
          { label: "Cancel", run: () => close() },
        ],
      });
      return;
    }
    if (result?.status?.state === "server-failed") {
      const log = String(result.status.log ?? "");
      showCard({
        icon: "triangle-alert",
        title: "The app did not start",
        code: artifact.server?.command ?? null,
        log,
        actions: [
          { label: "Retry", run: () => void open({ threadId, node }) },
          addToChat(`The web app "${node.title}" did not start. Its log:\n${log.slice(-4000)}`),
        ],
      });
      return;
    }
    if (result?.status?.state === "missing") {
      showCard({
        icon: "file-x",
        title: "This file is no longer in the thread folder",
        body: artifactAddress(artifact),
        note: "It existed when this answer was accepted. Nothing was started, and no agent turn runs by itself.",
        action: addToChat(`The artifact "${node.title}" (${artifactAddress(artifact)}) is no longer in the thread folder. Please recreate it.`),
      });
      return;
    }
    current.card.hidden = true;
    current.nativeOpen = true;
    placeView();
    if (result?.status?.state === "changed") {
      setBadge("changed", "Changed since this was accepted", "artifact-badge-warning");
      current.badges.querySelector('[data-badge="changed"]').title = "The file was edited after this answer was accepted. The viewer shows the current file.";
    }
  }

  return Object.freeze({ open, close, isOpen: () => current !== null });
}

export const artifactViewerLayout = Object.freeze({ STRIP_HEIGHT, TOOLBAR_HEIGHT, TOOLBAR_HIDE_MS });
