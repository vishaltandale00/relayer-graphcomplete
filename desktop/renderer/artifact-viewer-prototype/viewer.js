// PROTOTYPE — throwaway (issue #684). The full-screen artifact viewer.
// One artifact layer = renderer "artifact" + one node holding everything about the
// content. Agent content runs only in an iframe on its own origin
// (n-<node>.localhost), which stands in for an isolated Electron partition.

const KIND_LABEL = { website: "Website", app: "Web app", url: "Deployed site", pdf: "PDF", video: "Video", image: "Image", markdown: "Markdown", docx: "Word", xlsx: "Excel", pptx: "PowerPoint" };
const WEB_KINDS = new Set(["website", "app", "url"]);
const VIEWPORTS = { phone: [390, 844], tablet: [820, 1100] };

function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node[key] = value;
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) if (child != null) node.append(child);
  return node;
}

function icon(name) {
  const span = el("span", { class: "av-icon", "aria-hidden": "true" });
  const lucide = globalThis.lucide;
  const pascal = name.replace(/(^|-)(\w)/g, (_, __, c) => c.toUpperCase());
  const definition = lucide?.icons?.[pascal];
  if (definition) span.append(lucide.createElement(definition));
  return span;
}

function slug(nodeId) { return nodeId.replace(/^node:/, ""); }

export function createArtifactViewer({ root, config, surface, variant, annotateMode = "a", drafts, layerFor, onNavigateGraph, onSend, onClose }) {
  let stack = [];
  let current = null;
  let toolbarTimer = null;
  let heartbeat = null;
  let pollTimer = null;
  let annotateOpen = false;
  let closeAnnotation = null;
  let revealToolbar = () => {};
  let drawerOpen = variant === "D";
  let bubbleOpen = false;
  const externalOpens = [];
  const readOnly = surface !== "product";

  root.className = "av-root";
  root.hidden = true;

  // ------------------------------------------------------------- frame + origin

  function originFor(node) { return `http://n-${slug(node.id)}.localhost:${config.artifactPort}`; }

  function routePath(route) {
    if (!route || route === "/") return "/";
    return route.startsWith("#") ? `/${route}` : route;
  }

  function frameUrl(node, artifact) {
    if (artifact.kind === "url") return artifact.source.url;
    const origin = originFor(node);
    if (WEB_KINDS.has(artifact.kind)) return `${origin}/__relayer/open?to=${encodeURIComponent(routePath(artifact.part?.route))}`;
    return `${origin}/__relayer/view`;
  }

  function displayAddress(artifact) {
    if (artifact.kind === "url") return artifact.source.url;
    // Shares and Eval never show local folders or loopback addresses.
    if (readOnly) return KIND_LABEL[artifact.kind];
    if (artifact.kind === "app") return new URL(routePath(artifact.part?.route), artifact.source.app.readyUrl).href.replace(/\/$/, "") + (current?.location?.href && current.location.href !== "/" ? current.location.href : "");
    if (artifact.kind === "website") return `tidewater-launch/${artifact.source.root}${current?.location?.href && current.location.href !== "/" ? current.location.href : routePath(artifact.part?.route) === "/" ? "/" : routePath(artifact.part?.route)}`;
    return `tidewater-launch/${artifact.source.file}`;
  }

  // ------------------------------------------------------------- open / close

  function open(resolved, { via, replace = false } = {}) {
    if (replace) stack.pop();
    stack.push(resolved);
    show(resolved, via);
  }

  function back() {
    stack.pop();
    if (stack.length) show(stack.at(-1), "back");
    else close();
  }

  function close() {
    teardown();
    stack = [];
    current = null;
    root.hidden = true;
    root.replaceChildren();
    document.body.classList.remove("av-open");
    onClose?.();
  }

  function teardown() {
    clearInterval(heartbeat);
    clearTimeout(pollTimer);
    clearTimeout(toolbarTimer);
    annotateOpen = false;
  }

  function show(resolved, via) {
    teardown();
    const node = resolved.nodes[0];
    const artifact = node.artifact;
    current = {
      resolved, node, artifact, layerId: resolved.layer.id, via,
      origin: artifact.kind === "url" ? new URL(artifact.source.url).origin : originFor(node),
      location: { label: initialLocation(artifact), href: routePath(artifact.part?.route) },
      errors: [], status: null, server: null, frameReady: false,
    };
    document.body.classList.add("av-open");
    root.hidden = false;
    renderShell();
    void prepare();
  }

  function initialLocation(artifact) {
    if (artifact.kind === "pdf") return `Page ${artifact.part?.page ?? 1}`;
    if (artifact.kind === "video") return artifact.part?.start != null ? `${fmt(artifact.part.start)}–${fmt(artifact.part.end)}` : "Start of video";
    if (artifact.kind === "markdown") return artifact.part?.anchor ? `Section: ${artifact.part.anchor}` : "Top of document";
    if (WEB_KINDS.has(artifact.kind)) return `Route ${routePath(artifact.part?.route)}`;
    return "Whole file";
  }

  // ------------------------------------------------------------- lifecycle per kind

  async function prepare() {
    const opened = current;
    const { artifact, node } = opened;
    const local = artifact.kind !== "url";
    if (readOnly && local) { renderStage(); return; }
    if (artifact.source.file) {
      const status = await fetch(`/proto/status?node=${encodeURIComponent(node.id)}`).then((r) => r.json());
      if (current !== opened) return; // the user moved on while we checked
      current.status = status;
      if (!current.status.exists) { renderStage(); renderBanner(); return; }
    }
    if (artifact.kind === "app") { await ensureServer(); return; }
    renderStage();
    renderBanner();
  }

  async function ensureServer({ retry = false, approve = false, poll = false } = {}) {
    const nodeId = current.node.id;
    const response = await fetch(approve ? "/proto/invoke/approve" : "/proto/invoke/ensure", { method: "POST", body: JSON.stringify({ nodeId, retry, poll }) });
    if (current?.node.id !== nodeId) return;
    current.server = await response.json();
    if (current.server.status === "starting") pollTimer = setTimeout(() => ensureServer({ poll: true }), 400);
    if (current.server.status === "ready") {
      clearInterval(heartbeat);
      heartbeat = setInterval(() => fetch("/proto/invoke/heartbeat", { method: "POST", body: JSON.stringify({ nodeId }) }), 5_000);
    }
    renderStage();
    renderBanner();
  }

  // ------------------------------------------------------------- messages from the artifact

  addEventListener("message", (event) => {
    if (!current || event.origin !== current.origin || event.data?.source !== "relayer-artifact") return;
    const data = event.data;
    if (data.openExternal) {
      // In Relayer, main calls shell.openExternal (http/https only). Here the
      // browser's popup blocker may stop window.open, so the request is also recorded.
      externalOpens.push(data.openExternal);
      window.open(data.openExternal, "_blank", "noopener");
      toast(`Opened ${new URL(data.openExternal).host} in your browser — the artifact stayed put`);
      return;
    }
    if (data.error) {
      current.errors.push(data.error);
      renderBanner();
    }
    const location = { ...current.location, href: data.href ?? current.location.href, scrollY: data.scrollY ?? 0, page: data.page, time: data.time, anchor: data.anchor, slide: data.slide };
    location.label = data.location ?? (WEB_KINDS.has(current.artifact.kind) ? `Route ${location.href}${location.scrollY ? ` · scrolled ${location.scrollY}px` : ""}` : current.location.label);
    current.location = location;
    const address = root.querySelector(".av-address-text");
    if (address) address.textContent = displayAddress(current.artifact);
    const where = root.querySelector(".av-where");
    if (where) where.textContent = location.label;
  });

  // ------------------------------------------------------------- rendering

  function renderShell() {
    const { node, artifact } = current;
    const showAddress = WEB_KINDS.has(artifact.kind);
    const overflowMenu = el("div", { class: "av-menu av-menu-narrow", hidden: true, role: "menu" },
      el("button", { type: "button", role: "menuitem", class: "av-menu-item", onclick: () => { overflowMenu.hidden = true; openExternally(); } },
        icon("external-link"), el("span", { text: "Open externally" }), el("small", { text: artifact.kind === "url" || artifact.kind === "app" ? "In your browser" : "In its default app" })));

    // The artifact node's own navigate actions and references stay in the graph's
    // Node Details; the viewer shows none of them (decided 2026-10-06).
    const toolbar = el("header", { class: "av-toolbar", role: "toolbar", "aria-label": "Artifact viewer" },
      el("button", { type: "button", class: "av-tool", title: "Back (Esc)", onclick: back }, icon("arrow-left"), el("span", { text: stack.length > 1 ? "Back" : "Graph" })),
      el("div", { class: "av-title" }, icon(node.icon || "file"), el("b", { text: node.title }), el("small", { text: KIND_LABEL[artifact.kind] })),
      showAddress ? el("div", { class: "av-address", title: "The page address is always shown so a page cannot pretend to be somewhere else." },
        icon(artifact.kind === "url" ? "lock" : "house"), el("span", { class: "av-address-text", text: displayAddress(artifact) })) : el("div", { class: "av-address av-file", title: "File in the thread folder" }, icon("file"), el("span", { class: "av-address-text", text: displayAddress(artifact) })),
      el("div", { class: "av-badges" }),
      el("div", { class: "av-spacer" }),
      readOnly ? null : el("button", { type: "button", class: "av-tool av-icon-tool av-annotate", title: "Annotate (A)", "aria-label": "Annotate", onclick: () => (annotateOpen ? closeAnnotation?.() : startAnnotation()) }, icon("message-square-plus"), el("span", { class: "av-count", hidden: true })),
      readOnly && artifact.kind !== "url" ? null : el("div", { class: "av-menu-wrap" },
        el("button", { type: "button", class: "av-tool av-icon-tool", title: "More", "aria-label": "More", "aria-haspopup": "menu", onclick: () => { overflowMenu.hidden = !overflowMenu.hidden; } }, icon("ellipsis")),
        overflowMenu),
    );

    // The slim strip stays when the toolbar hides: it keeps the address visible
    // (D21) and is where the pointer goes to bring the toolbar back.
    const pinnedAddress = el("div", { class: "av-pinned-address", title: showAddress ? "The address is always visible" : "File in the thread folder" },
      icon(artifact.kind === "url" ? "lock" : showAddress ? "house" : "file"), el("span", { class: "av-address-text", text: displayAddress(artifact) }),
      el("small", { class: "av-strip-hint", text: "Move here for the toolbar · Esc exits" }));

    root.replaceChildren(el("div", { class: `av-overlay av-variant-${variant}` },
      toolbar,
      pinnedAddress,
      el("div", { class: "av-banner", hidden: true }),
      el("div", { class: "av-body" },
        el("div", { class: "av-stage" }),
        variant === "D" && !readOnly ? renderDrawer() : null),
      readOnly ? null : renderComposerForVariant(),
      el("div", { class: "av-toast", hidden: true, role: "status" }),
    ));
    wireToolbarAutoHide();
    updateCount();
  }

  function wireToolbarAutoHide() {
    const overlay = root.querySelector(".av-overlay");
    const showToolbar = () => {
      overlay.classList.remove("av-toolbar-hidden");
      clearTimeout(toolbarTimer);
      toolbarTimer = setTimeout(() => {
        if (root.querySelector(".av-menu:not([hidden])") || overlay.matches(":focus-within .av-toolbar *") || annotateOpen) return;
        overlay.classList.add("av-toolbar-hidden");
      }, 2600);
    };
    revealToolbar = showToolbar;
    const toolbar = root.querySelector(".av-toolbar");
    root.querySelector(".av-pinned-address").addEventListener("mouseenter", showToolbar);
    toolbar.addEventListener("mousemove", showToolbar);
    toolbar.addEventListener("focusin", showToolbar);
    showToolbar();
  }

  function renderStage() {
    const stage = root.querySelector(".av-stage");
    if (!stage) return;
    const { artifact, node, status, server } = current;
    stage.replaceChildren();
    const local = artifact.kind !== "url";
    if (readOnly && local) {
      stage.append(el("div", { class: "av-card" }, icon(node.icon || "file"),
        el("h2", { text: node.title }),
        el("p", { text: KIND_LABEL[artifact.kind] }),
        el("p", { class: "av-card-note", text: "Available in Relayer on the machine that made it." }),
        el("small", { text: surface === "share" ? "Shared view: local files are not uploaded with the share (v1)." : "Eval: imported conversations do not carry the thread folder." })));
      return;
    }
    if (status && !status.exists) {
      stage.append(el("div", { class: "av-card av-card-error" }, icon("file-x"),
        el("h2", { text: "This file is no longer in the thread folder" }),
        el("p", { text: status.error }),
        el("p", { class: "av-card-note", text: "It existed when the agent's answer was accepted. Nothing was started; no agent turn runs automatically." }),
        readOnly ? null : el("button", { type: "button", class: "av-primary", onclick: () => addSystemChip("Missing file", status.error) }, "Add to chat")));
      return;
    }
    if (artifact.kind === "app" && server?.status !== "ready") {
      stage.append(renderServerCard(server));
      return;
    }
    const [width, height] = VIEWPORTS[artifact.viewport] ?? [];
    const frame = el("iframe", {
      class: "av-frame",
      src: frameUrl(node, artifact),
      title: `${node.title} (${KIND_LABEL[artifact.kind]})`,
      // Agent content: own origin, no popups, no downloads, no top navigation, no device permissions.
      sandbox: "allow-scripts allow-same-origin allow-forms",
      allow: "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'",
      referrerpolicy: "no-referrer",
    });
    const wrap = el("div", { class: `av-frame-wrap${width ? ` av-device av-device-${artifact.viewport}` : ""}` }, frame);
    if (width) { wrap.style.setProperty("--device-w", `${width}px`); wrap.style.setProperty("--device-h", `${height}px`); }
    if (width) wrap.append(el("div", { class: "av-device-label", text: `${artifact.viewport} · ${width}×${height}` }));
    stage.append(wrap);
  }

  function renderServerCard(server) {
    const status = server?.status ?? "checking";
    const log = el("pre", { class: "av-log" }, (server?.log ?? []).slice(-12).join("\n"));
    if (status === "needs_approval") {
      return el("div", { class: "av-card" }, icon("shield-check"),
        el("h2", { text: "Run this app?" }),
        el("p", {}, "To show ", el("b", { text: current.node.title }), ", Relayer will run this command in the thread folder:"),
        el("code", { class: "av-command", text: `${server.command}   ·   ${server.folder}` }),
        el("p", { class: "av-card-note", text: `Ready when ${server.readyUrl} answers. You approve each command once per thread; it runs under the thread's sandbox and permissions.` }),
        el("div", { class: "av-row" },
          el("button", { type: "button", class: "av-primary", onclick: () => ensureServer({ approve: true }) }, "Allow and run"),
          el("button", { type: "button", class: "av-secondary", onclick: back }, "Not now")));
    }
    if (status === "failed" || status === "exited" || status === "stopped") {
      return el("div", { class: "av-card av-card-error" }, icon("triangle-alert"),
        el("h2", { text: status === "stopped" ? "The app was stopped" : "The app failed to start" }),
        el("p", { text: status === "stopped" ? "Relayer stopped it after it sat idle." : `${server.command} exited before ${server.readyUrl} answered.` }),
        log,
        el("div", { class: "av-row" },
          el("button", { type: "button", class: "av-primary", onclick: () => { current.server = { status: "starting", log: [] }; renderStage(); ensureServer({ retry: true }); } }, "Retry"),
          readOnly ? null : el("button", { type: "button", class: "av-secondary", onclick: () => addSystemChip("Startup log", (server.log ?? []).slice(-8).join("\n")) }, "Add log to chat")));
    }
    return el("div", { class: "av-card" }, el("div", { class: "av-spinner", "aria-hidden": "true" }),
      el("h2", { text: status === "checking" ? "Checking whether the app is running…" : "Starting the app…" }),
      el("p", { class: "av-card-note", text: server?.command ? `${server.command} → waiting for ${server.readyUrl}` : "Looking for the declared ready URL." }),
      log);
  }

  function renderBanner() {
    const banner = root.querySelector(".av-banner");
    const badges = root.querySelector(".av-badges");
    if (!banner || !badges) return;
    badges.replaceChildren();
    const { status, server, errors, artifact } = current;
    if (status?.exists && status.matches === false) {
      badges.append(el("span", { class: "av-badge av-badge-warn", title: `Accepted ${status.fingerprint.slice(0, 19)}…\nNow ${status.current.slice(0, 19)}…` }, icon("history"), "Changed since this was accepted"));
    }
    if (artifact.kind === "app" && server?.status === "ready") {
      badges.append(el("span", { class: "av-badge", title: (server.log ?? []).join("\n") }, icon("server"),
        server.startedBy === "relayer" ? `Started by Relayer · stops after ${Math.round(server.idleMs / 1000)} s idle` : "Using the server the agent left running"));
    }
    if (artifact.state && (artifact.state.localStorage || artifact.state.cookies)) {
      badges.append(el("span", { class: "av-badge", title: JSON.stringify(artifact.state, null, 2) }, icon("rotate-ccw"), "Fresh state each open"));
    }
    if (errors.length) {
      const button = el("button", { type: "button", class: "av-badge av-badge-error", onclick: () => { banner.hidden = !banner.hidden; } }, icon("bug"), `${errors.length} page error${errors.length === 1 ? "" : "s"}`);
      badges.append(button);
      banner.replaceChildren(el("div", { class: "av-banner-body" },
        el("pre", { text: [...new Set(errors)].join("\n") }),
        readOnly ? null : el("button", { type: "button", class: "av-secondary", onclick: () => addSystemChip("Page error", [...new Set(errors)].join("\n")) }, "Add to chat")));
    }
  }

  // ------------------------------------------------------------- annotations

  async function captureScreenshot() {
    const { artifact, node, location } = current;
    const frame = root.querySelector(".av-frame");
    if (!frame) return null;
    let url = frameUrl(node, artifact);
    if (WEB_KINDS.has(artifact.kind) && artifact.kind !== "url") url = `${originFor(node)}/__relayer/open?to=${encodeURIComponent(location.href || "/")}`;
    const query = new URLSearchParams({ snap: "1" });
    if (artifact.kind === "pdf" && location.page) query.set("page", location.page);
    if (artifact.kind === "video" && location.time != null) query.set("t", location.time);
    if (artifact.kind === "markdown" && location.anchor) query.set("anchor", location.anchor);
    if (artifact.kind === "pptx" && location.slide) query.set("slide", location.slide);
    if (!WEB_KINDS.has(artifact.kind)) url += `?${query}`;
    const response = await fetch("/proto/screenshot", { method: "POST", body: JSON.stringify({ url, width: frame.clientWidth, height: frame.clientHeight, scrollY: location.scrollY ?? 0 }) });
    return response.ok ? (await response.json()).image : null;
  }

  // Pause any playing media in the artifact while a note is being written (Q5).
  function mediaCommand(command) {
    root.querySelector(".av-frame")?.contentWindow?.postMessage({ source: "relayer-viewer", command }, current.origin);
  }

  // Three ways Annotate can look (Q3): a = panel drops from the icon,
  // b = larger popover at the bottom, c = drag a box around a spot first.
  function startAnnotation() {
    if (readOnly || !current || annotateOpen) return;
    if (!root.querySelector(".av-frame")) { addSystemChip("Note", ""); return; }
    annotateOpen = true;
    revealToolbar();
    const toastNode = root.querySelector(".av-toast");
    if (toastNode) toastNode.hidden = true;
    mediaCommand("pause");
    if (annotateMode === "c") startBoxMode();
    else if (annotateMode === "d") openInlineNote();
    else if (annotateMode === "e") openStripNote();
    else if (annotateMode === "f") startPinMode();
    else openNotePanel({ placement: annotateMode === "a" ? "dropdown" : "bottom" });
  }

  function endAnnotation() {
    annotateOpen = false;
    closeAnnotation = null;
    root.querySelectorAll(".av-note-panel, .av-box-layer, .av-inline-note, .av-strip-note, .av-pin-layer, .av-mini-list").forEach((node) => node.remove());
    root.querySelector(".av-overlay")?.classList.remove("av-strip-open", "av-inline-open");
    mediaCommand("resume");
  }

  function frameBox() {
    const frame = root.querySelector(".av-frame").getBoundingClientRect();
    const overlay = root.querySelector(".av-overlay").getBoundingClientRect();
    return { left: frame.left - overlay.left, top: frame.top - overlay.top, width: frame.width, height: frame.height };
  }

  function startBoxMode() {
    const area = frameBox();
    const layer = el("div", { class: "av-box-layer", style: `left:${area.left}px;top:${area.top}px;width:${area.width}px;height:${area.height}px` },
      el("div", { class: "av-box-hint" }, icon("square-dashed-mouse-pointer"), el("span", { text: "Drag around what you mean · click marks a point · Esc cancels" })));
    const rect = el("div", { class: "av-box-rect", hidden: true });
    layer.append(rect);
    let start = null;
    const place = (x, y, w, h) => { Object.assign(rect.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` }); rect.hidden = false; };
    layer.addEventListener("pointerdown", (event) => {
      if (event.target.closest(".av-note-panel")) return;
      const bounds = layer.getBoundingClientRect();
      start = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
      layer.setPointerCapture(event.pointerId);
      place(start.x, start.y, 0, 0);
      layer.querySelector(".av-box-hint").hidden = true;
      layer.querySelector(".av-note-panel")?.remove();
    });
    layer.addEventListener("pointermove", (event) => {
      if (!start) return;
      const bounds = layer.getBoundingClientRect();
      const x = event.clientX - bounds.left;
      const y = event.clientY - bounds.top;
      place(Math.min(start.x, x), Math.min(start.y, y), Math.abs(x - start.x), Math.abs(y - start.y));
    });
    layer.addEventListener("pointerup", () => {
      if (!start) return;
      let box = { x: parseFloat(rect.style.left), y: parseFloat(rect.style.top), w: parseFloat(rect.style.width), h: parseFloat(rect.style.height) };
      if (box.w < 8 && box.h < 8) { box = { x: box.x - 24, y: box.y - 24, w: 48, h: 48 }; place(box.x, box.y, box.w, box.h); }
      start = null;
      layer.classList.add("av-box-done");
      openNotePanel({ placement: "box", box, area, layer });
    });
    root.querySelector(".av-overlay").append(layer);
    closeAnnotation = endAnnotation;
  }

  // Crop the view screenshot around the marked box and outline it.
  async function markScreenshot(image, box, area) {
    const picture = await new Promise((done, fail) => { const i = new Image(); i.onload = () => done(i); i.onerror = fail; i.src = image; });
    const scale = picture.naturalWidth / area.width;
    const pad = Math.max(box.w, box.h, 120) * 0.6;
    const sx = Math.max(0, box.x - pad), sy = Math.max(0, box.y - pad);
    const sw = Math.min(area.width - sx, box.w + pad * 2), sh = Math.min(area.height - sy, box.h + pad * 2);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(sw * scale); canvas.height = Math.round(sh * scale);
    const context = canvas.getContext("2d");
    context.drawImage(picture, sx * scale, sy * scale, sw * scale, sh * scale, 0, 0, canvas.width, canvas.height);
    context.strokeStyle = "#ff5a36"; context.lineWidth = Math.max(3, 3 * scale);
    context.strokeRect((box.x - sx) * scale, (box.y - sy) * scale, box.w * scale, box.h * scale);
    return canvas.toDataURL("image/jpeg", 0.8);
  }

  // ---- Low-profile options (d, e, f): the screenshot is taken silently; a small
  // camera mark shows when it is captured. Nothing covers the artifact for long.

  function silentDraft(extra = {}) {
    return { nodeId: current.node.id, nodeTitle: current.node.title, layerId: current.layerId, location: current.location.label, href: current.location.href, text: "", screenshot: null, ...extra };
  }

  function captureInto(draft, mark, { box = null, area = null } = {}) {
    captureScreenshot()
      .then(async (image) => (image && box ? markScreenshot(image, box, area) : image))
      .then((image) => { draft.screenshot = image; mark?.classList.add("av-captured"); if (mark) mark.title = image ? "Screenshot captured" : "No screenshot"; })
      .catch(() => { if (mark) mark.title = "No screenshot"; });
  }

  function cameraMark() {
    return el("span", { class: "av-cam", title: "Capturing what you see…", "aria-hidden": "true" }, icon("camera"));
  }

  // A small list of earlier notes that opens from a "N notes" chip.
  function miniListToggle(anchorClass) {
    const n = drafts.list().length;
    if (!n) return null;
    return el("button", { type: "button", class: "av-notes-chip", onclick: (event) => {
      event.stopPropagation();
      const existing = root.querySelector(".av-mini-list");
      if (existing) { existing.remove(); return; }
      const list = noteList();
      if (!list) return;
      const box = el("div", { class: `av-mini-list ${anchorClass}` }, list);
      root.querySelector(".av-overlay").append(box);
    } }, `${n} note${n === 1 ? "" : "s"}`);
  }

  function noteKeys(input, add) {
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); add(); }
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); endAnnotation(); }
    });
  }

  // d: the note field opens inside the toolbar itself. One line, no panel.
  function openInlineNote() {
    const draft = silentDraft();
    const mark = cameraMark();
    const input = el("input", { type: "text", class: "av-inline-input", placeholder: "Note about what you see… Enter adds · Esc closes" });
    const add = () => { draft.text = input.value.trim(); drafts.add(draft); endAnnotation(); toast("Note added"); };
    noteKeys(input, add);
    const field = el("div", { class: "av-inline-note", role: "dialog", "aria-label": "Add a note" },
      el("span", { class: "av-where-chip" }, icon("map-pin"), el("span", { class: "av-where", text: draft.location })), input, mark, miniListToggle("av-mini-under-toolbar"));
    root.querySelector(".av-toolbar").append(field);
    root.querySelector(".av-overlay").classList.add("av-inline-open");
    closeAnnotation = endAnnotation;
    input.focus();
    captureInto(draft, mark);
  }

  // e: a thin note bar along the bottom edge; the artifact shrinks to make room, so nothing is covered.
  function openStripNote() {
    const draft = silentDraft();
    const mark = cameraMark();
    const input = el("input", { type: "text", class: "av-strip-input", placeholder: "Add a note about this moment… Enter adds · Esc closes" });
    const add = () => { draft.text = input.value.trim(); drafts.add(draft); endAnnotation(); toast("Note added"); };
    noteKeys(input, add);
    const strip = el("div", { class: "av-strip-note", role: "dialog", "aria-label": "Add a note" },
      el("span", { class: "av-where-chip" }, icon("map-pin"), el("span", { class: "av-where", text: draft.location })), input, mark, miniListToggle("av-mini-above-strip"),
      el("kbd", { text: "↵" }));
    root.querySelector(".av-overlay").classList.add("av-strip-open");
    root.querySelector(".av-overlay").append(strip);
    closeAnnotation = endAnnotation;
    input.focus();
    captureInto(draft, mark);
  }

  // f: click a spot to drop a numbered pin; a tooltip-sized field sits next to it.
  // Existing pins on this artifact show while pinning; hover one to see or remove it.
  function startPinMode() {
    const area = frameBox();
    const layer = el("div", { class: "av-pin-layer", style: `left:${area.left}px;top:${area.top}px;width:${area.width}px;height:${area.height}px` },
      el("div", { class: "av-pin-hint" }, icon("map-pin"), el("span", { text: "Click where you mean · Esc cancels" })));
    const mine = drafts.list().filter((item) => item.nodeId === current.node.id && item.point);
    mine.forEach((item, index) => layer.append(el("div", { class: "av-pin av-pin-old", style: `left:${item.point.x * area.width}px;top:${item.point.y * area.height}px`, title: item.text },
      el("span", { text: String(index + 1) }),
      el("div", { class: "av-pin-tip" }, el("b", { text: item.location }), el("span", { text: item.text || "(no note)" }),
        el("button", { type: "button", "aria-label": "Remove note", onclick: (event) => { event.stopPropagation(); drafts.remove(item.id); event.target.closest(".av-pin").remove(); } }, "×")))));
    layer.addEventListener("click", (event) => {
      if (event.target.closest(".av-pin-bubble, .av-pin-old")) return;
      layer.querySelector(".av-pin-new")?.remove();
      layer.querySelector(".av-pin-bubble")?.remove();
      layer.querySelector(".av-pin-hint").hidden = true;
      const bounds = layer.getBoundingClientRect();
      const x = event.clientX - bounds.left, y = event.clientY - bounds.top;
      const draft = silentDraft({ point: { x: +(x / area.width).toFixed(3), y: +(y / area.height).toFixed(3) }, location: `${current.location.label} · pinned spot` });
      const pin = el("div", { class: "av-pin av-pin-new", style: `left:${x}px;top:${y}px` }, el("span", { text: String(mine.length + 1) }));
      const mark = cameraMark();
      const input = el("input", { type: "text", class: "av-pin-input", placeholder: "Note… Enter adds" });
      const add = () => { draft.text = input.value.trim(); drafts.add(draft); endAnnotation(); toast("Note pinned"); };
      noteKeys(input, add);
      const flip = x + 300 > area.width;
      const bubble = el("div", { class: "av-pin-bubble", style: `${flip ? `right:${area.width - x + 16}px` : `left:${x + 16}px`};top:${Math.max(8, Math.min(y - 18, area.height - 48))}px` }, input, mark);
      layer.append(pin, bubble);
      input.focus();
      captureInto(draft, mark, { box: { x: x - 20, y: y - 20, w: 40, h: 40 }, area });
    });
    root.querySelector(".av-overlay").append(layer);
    closeAnnotation = endAnnotation;
  }

  function noteList() {
    const items = drafts.list();
    if (!items.length) return null;
    return el("div", { class: "av-note-list" },
      el("div", { class: "av-note-list-head", text: `${items.length} note${items.length === 1 ? "" : "s"} in the chat draft` }),
      items.map((item) => el("div", { class: "av-note-row" },
        item.screenshot ? el("img", { src: item.screenshot, alt: "" }) : icon("sticky-note"),
        el("span", { class: "av-note-row-copy" }, el("b", { text: item.location }), el("span", { text: item.text || "(no note)" })),
        el("button", { type: "button", "aria-label": "Remove note", onclick: () => { drafts.remove(item.id); const list = root.querySelector(".av-note-list"); const next = noteList(); if (list) next ? list.replaceWith(next) : list.remove(); } }, "×"))));
  }

  function openNotePanel({ placement, box = null, area = null, layer = null }) {
    const location = box ? `${current.location.label} · marked area` : current.location.label;
    const draft = { nodeId: current.node.id, nodeTitle: current.node.title, layerId: current.layerId, location, href: current.location.href, text: "", screenshot: null, box: box && area ? { x: +(box.x / area.width).toFixed(3), y: +(box.y / area.height).toFixed(3), w: +(box.w / area.width).toFixed(3), h: +(box.h / area.height).toFixed(3) } : null };
    const compact = placement === "dropdown";
    const thumb = el("div", { class: `av-thumb${compact ? " av-thumb-small" : ""} av-thumb-loading`, text: compact ? "" : "Capturing what you see…" });
    const input = compact
      ? el("textarea", { rows: "2", class: "av-note-input", placeholder: "Note · Enter adds · Esc closes" })
      : el("textarea", { rows: placement === "box" ? "2" : "3", class: "av-note-input", placeholder: "What should change here? Enter adds · Esc cancels" });
    const add = () => {
      draft.text = input.value.trim();
      drafts.add(draft);
      endAnnotation();
      toast(variant === "C" ? "Note added. Press Esc to go back and send from the thread composer." : "Note added to the chat draft.");
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); add(); }
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); endAnnotation(); }
    });
    const head = el("div", { class: "av-annotate-head" }, icon(box ? "square-dashed" : "map-pin"), el("b", { class: "av-where", text: location }));
    const panel = compact
      ? el("div", { class: "av-note-panel av-note-dropdown", role: "dialog", "aria-label": "Add a note" },
        noteList(),
        el("div", { class: "av-note-compose" }, thumb, el("div", { class: "av-note-compose-main" }, head, input)))
      : el("div", { class: `av-note-panel av-note-${placement}`, role: "dialog", "aria-label": "Add a note" },
        noteList(), head, thumb, input,
        el("div", { class: "av-row" },
          el("button", { type: "button", class: "av-secondary", onclick: endAnnotation }, "Cancel"),
          el("button", { type: "button", class: "av-primary", onclick: add }, "Add note")));
    if (placement === "dropdown") {
      const anchor = root.querySelector(".av-annotate").getBoundingClientRect();
      const overlay = root.querySelector(".av-overlay").getBoundingClientRect();
      panel.style.right = `${Math.max(12, overlay.right - anchor.right - 8)}px`;
    }
    if (placement === "box") {
      // Beside the box when there is room, otherwise below it.
      const right = box.x + box.w + 16;
      const fitsRight = right + 340 < area.width;
      panel.style.left = `${fitsRight ? right : Math.max(12, Math.min(box.x, area.width - 352))}px`;
      panel.style.top = `${fitsRight ? Math.max(12, Math.min(box.y, area.height - 300)) : Math.min(box.y + box.h + 12, area.height - 300)}px`;
      layer.append(panel);
    } else {
      root.querySelector(".av-overlay").append(panel);
    }
    // Keep the whole box panel on screen, again once its screenshot has grown it.
    const keepOnScreen = () => { if (placement === "box") panel.style.top = `${Math.max(12, Math.min(parseFloat(panel.style.top), area.height - panel.offsetHeight - 12))}px`; };
    requestAnimationFrame(keepOnScreen);
    closeAnnotation = endAnnotation;
    input.focus();
    captureScreenshot()
      .then(async (image) => (image && box ? markScreenshot(image, box, area) : image))
      .then((image) => {
        draft.screenshot = image;
        thumb.classList.remove("av-thumb-loading");
        const picture = image ? el("img", { src: image, alt: "What you are looking at" }) : el("span", { text: "No screenshot" });
        if (image) picture.onload = keepOnScreen;
        thumb.replaceChildren(picture);
      })
      .catch(() => { thumb.classList.remove("av-thumb-loading"); thumb.textContent = "No screenshot"; });
  }

  function addSystemChip(kind, text) {
    if (readOnly) return;
    drafts.add({ nodeId: current.node.id, nodeTitle: current.node.title, layerId: current.layerId, location: kind, href: current.location.href, text, screenshot: null });
    if (variant === "B") { bubbleOpen = true; }
    toast(`${kind} added to the chat draft`);
  }

  function updateCount() {
    const count = root.querySelector(".av-count");
    if (!count) return;
    const n = drafts.list().length;
    count.hidden = n === 0;
    count.textContent = String(n);
  }

  drafts.subscribe(() => {
    if (!current) return;
    updateCount();
    const composer = root.querySelector(".av-composer-slot");
    if (composer) composer.replaceWith(renderComposerForVariant());
    const drawer = root.querySelector(".av-drawer");
    if (drawer) drawer.replaceWith(renderDrawer());
  });

  // ------------------------------------------------------------- the four chat-input variants (O1)

  function chipList({ large = false } = {}) {
    const items = drafts.list();
    return el("div", { class: `av-chips${large ? " av-chips-large" : ""}` }, items.map((item) => el("div", { class: "av-chip", title: `${item.nodeTitle} · ${item.location}\n${item.text}` },
      item.screenshot ? el("img", { src: item.screenshot, alt: "" }) : icon(item.location === "Startup log" ? "terminal" : item.location === "Page error" ? "bug" : "sticky-note"),
      el("span", { class: "av-chip-copy" }, el("b", { text: item.location }), el("span", { text: item.text || item.nodeTitle })),
      el("button", { type: "button", "aria-label": "Remove", onclick: () => drafts.remove(item.id) }, "×"))));
  }

  function chatInput({ placeholder = "Message the agent… (Enter sends)", autofocus = false } = {}) {
    const textarea = el("textarea", { rows: "1", placeholder, class: "av-chat-text" });
    textarea.value = drafts.text();
    textarea.addEventListener("input", () => drafts.setText(textarea.value));
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); }
    });
    if (autofocus) queueMicrotask(() => textarea.focus());
    // Send is never disabled (D27); an empty send with no chips is simply ignored.
    return el("div", { class: "av-chat" }, textarea, el("button", { type: "button", class: "send-button", "aria-label": "Send", onclick: send }, "↑"));
  }

  function send() {
    const annotations = drafts.list();
    const text = drafts.text().trim();
    if (!annotations.length && !text) return;
    drafts.take();
    const interaction = onSend({ text, annotations });
    toast(`Sent as interaction ${interaction.sequence}: one turn, ${annotations.length} annotation${annotations.length === 1 ? "" : "s"}. Esc to see it in the graph.`);
    const slot = root.querySelector(".av-composer-slot");
    if (slot) slot.replaceWith(renderComposerForVariant());
  }

  function renderComposerForVariant() {
    if (variant === "A") {
      return el("div", { class: "av-composer-slot av-docked" }, drafts.list().length ? chipList() : null, chatInput());
    }
    if (variant === "B") {
      const n = drafts.list().length;
      if (!bubbleOpen) {
        return el("div", { class: "av-composer-slot av-bubble-wrap" },
          el("button", { type: "button", class: "av-bubble", onclick: () => { bubbleOpen = true; root.querySelector(".av-composer-slot").replaceWith(renderComposerForVariant()); } },
            icon("message-circle"), el("span", { text: n ? `${n} note${n === 1 ? "" : "s"} · Chat` : "Chat" })));
      }
      return el("div", { class: "av-composer-slot av-floating" },
        el("div", { class: "av-floating-head" }, el("b", { text: "Chat with the agent" }),
          el("button", { type: "button", class: "av-icon-button", "aria-label": "Minimise", onclick: () => { bubbleOpen = false; root.querySelector(".av-composer-slot").replaceWith(renderComposerForVariant()); } }, "–")),
        drafts.list().length ? chipList() : el("p", { class: "av-hint", text: "Press Annotate (A) to add what you see." }),
        chatInput({ autofocus: true }));
    }
    if (variant === "C") {
      const n = drafts.list().length;
      return el("div", { class: "av-composer-slot av-exit-hint", hidden: n === 0 },
        icon("corner-down-left"), el("span", { text: `${n} note${n === 1 ? "" : "s"} in the chat draft · press Esc to go back and send from the thread composer` }));
    }
    return el("div", { class: "av-composer-slot", hidden: true });
  }

  function renderDrawer() {
    const items = drafts.list();
    return el("aside", { class: `av-drawer${drawerOpen ? "" : " av-drawer-closed"}`, "aria-label": "Review notes" },
      el("div", { class: "av-drawer-head" }, el("b", { text: "Review" }), el("small", { text: `${items.length} note${items.length === 1 ? "" : "s"} · sent together as one message` }),
        el("button", { type: "button", class: "av-icon-button", "aria-label": "Collapse", onclick: () => { drawerOpen = !drawerOpen; root.querySelector(".av-drawer").replaceWith(renderDrawer()); } }, drawerOpen ? "›" : "‹")),
      drawerOpen ? el("div", { class: "av-drawer-list" }, items.length
        ? items.map((item, index) => el("article", { class: "av-note" },
          el("div", { class: "av-note-head" }, el("span", { class: "av-note-n", text: String(index + 1) }), el("b", { text: item.location }), el("small", { text: item.nodeTitle }),
            el("button", { type: "button", "aria-label": "Remove", onclick: () => drafts.remove(item.id) }, "×")),
          item.screenshot ? el("img", { src: item.screenshot, alt: "" }) : null,
          el("p", { text: item.text || "(no note)" })))
        : el("p", { class: "av-hint", text: "Annotate (A) adds what you are looking at, with a screenshot, as a note here." })) : null,
      drawerOpen ? chatInput({ placeholder: "Overall message (optional) · Enter sends everything" }) : null);
  }

  // ------------------------------------------------------------- misc

  function openExternally() {
    const { artifact, node } = current;
    const target = artifact.kind === "url" ? artifact.source.url : artifact.kind === "app" ? artifact.source.app.readyUrl : `${originFor(node)}/__relayer/file`;
    window.open(target, "_blank", "noopener");
    toast(artifact.kind === "url" || artifact.kind === "app" ? "Opened in your browser" : "In Relayer this opens the file in its default app (shell.openPath)");
  }

  let toastTimer = null;
  function toast(message) {
    const node = root.querySelector(".av-toast");
    if (!node) return;
    node.textContent = message;
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, 3600);
  }

  addEventListener("keydown", (event) => {
    if (root.hidden || !current) return;
    const typing = event.target.closest?.("input, textarea, [contenteditable]");
    if (event.key === "Escape" && annotateOpen && !typing) { endAnnotation(); return; }
    if (event.key === "Escape" && !annotateOpen) {
      const menu = root.querySelector(".av-menu:not([hidden])");
      if (menu) { menu.hidden = true; return; }
      if (typing) { event.target.blur(); return; }
      back();
    }
    if (!typing && (event.key === "a" || event.key === "A") && !event.metaKey && !event.ctrlKey) { event.preventDefault(); startAnnotation(); }
  });

  return {
    open,
    close,
    state: () => current && {
      layerId: current.layerId,
      renderer: current.resolved.layer.renderer,
      node: current.node,
      location: current.location,
      errors: current.errors,
      fingerprint: current.status,
      server: current.server && { ...current.server, log: (current.server.log ?? []).slice(-6) },
      annotateMode,
      stack: stack.map((entry) => entry.layer.id),
      externalOpens,
      isolation: { origin: current.origin, sandbox: "allow-scripts allow-same-origin allow-forms", note: "Own origin per artifact node; the workspace origin and its API are cross-site." },
    },
  };
}

function fmt(seconds) { return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`; }
