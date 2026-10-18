import { createActorDiagnostics } from "./task-actor-diagnostics.mjs";
import { abortable } from "./abortable.mjs";
import { randomUUID } from "node:crypto";
import { createHumanTaskSurface } from "./web-host.mjs";

// Self-contained because Playwright serializes this production predicate.
export function taskActorPresentationReady({ expected, presentation = globalThis.window?.__taskActorPresentation }) {
  const { threadId, turnId, submittedAt } = expected;
  const invocation = expected.invocation;
  const results = invocation && (presentation?.invocationResults ?? []).filter(result =>
    String(result.actionId) === String(invocation.actionId) && String(result.turnId) === String(invocation.turnId));
  return String(presentation?.threadId) === String(threadId) && String(presentation?.turnId) === String(turnId)
    && presentation.observedAt >= submittedAt
    && (expected.attemptId == null || String(presentation.attemptId) === String(expected.attemptId))
    && (!invocation || (results.length > 0 && results.every(result => result.completionStatus === invocation.completionStatus
      && result.attemptOutcome === invocation.attemptOutcome
      && (invocation.attemptId == null || String(result.attemptId) === String(invocation.attemptId)))))
    && (["accepted", "failed", "stopped"].includes(presentation.completionStatus)
      || (presentation.completionStatus === "not_started" && presentation.attemptOutcome === "model_failed"));
}

// Correlation only: never read hidden layers or a child's graph inventory.
export function taskActorCurrentIdentity({ expected, presentation = globalThis.window?.__taskActorPresentation, document = globalThis.document, pinnedObservation = false }) {
  const p = presentation;
  const pointer = p?.currentPointer;
  if (String(p?.threadId) !== String(expected.threadId) || String(p?.turnId) !== String(expected.turnId)
    || p.graphVisible !== true
    || !Number.isFinite(p?.observedAt) || !Number.isFinite(expected.submittedAt)
    || p.observedAt < expected.submittedAt
    || (expected.attemptId != null && String(p.attemptId) !== String(expected.attemptId))
    || !Number.isSafeInteger(pointer?.revision) || pointer.revision < 1 || p.layerId == null
    || !(pointer.mode === "following" && String(pointer.layerId) === String(p.layerId)
      || pinnedObservation && pointer.mode === "pinned")) return null;
  // Delivery can settle without a graph Advance. Only rendered status enters
  // this dedup identity; never field values, hidden content or graph inventory.
  const answers = [];
  let visibleUpdate = null;
  function collect(root) {
    for (const element of root?.querySelectorAll("*") ?? []) {
      if (pinnedObservation && element.tagName === "BUTTON" && element.getRootNode() === element.ownerDocument
        && element === element.ownerDocument.querySelector(".workspace-layout #workspaceBreadcrumb > button#viewLatestUpdate")) {
        const rect = element.getBoundingClientRect();
        const x = Math.max(0, rect.left) + Math.min(rect.width, document.defaultView.innerWidth - Math.max(0, rect.left)) / 2;
        const y = Math.max(0, rect.top) + Math.min(rect.height, document.defaultView.innerHeight - Math.max(0, rect.top)) / 2;
        const hit = element.getRootNode().elementFromPoint?.(x, y);
        if (rect.width > 0 && rect.height > 0 && (hit === element || element.contains(hit))) {
          visibleUpdate = [element.dataset.currentUpdateScope, element.dataset.currentUpdateRevision, element.textContent, element.disabled];
        }
      }
      if (element.matches('[data-input-control-role="answer"]')) {
        const rect = element.getBoundingClientRect();
        const x = Math.max(0, rect.left) + Math.min(rect.width, document.defaultView.innerWidth - Math.max(0, rect.left)) / 2;
        const y = Math.max(0, rect.top) + Math.min(rect.height, document.defaultView.innerHeight - Math.max(0, rect.top)) / 2;
        const hit = element.getRootNode().elementFromPoint?.(x, y);
        if (rect.width > 0 && rect.height > 0 && (hit === element || element.contains(hit))) {
          answers.push([element.closest("[data-live-answer-scope]")?.dataset.liveAnswerScope ?? null,
            element.disabled, element.textContent === "Delivered"]);
        }
      }
      if (element.shadowRoot) collect(element.shadowRoot);
    }
  }
  collect(document?.querySelector(".workspace-layout"));
  return { threadId: p.threadId, turnId: p.turnId, attemptId: p.attemptId ?? null,
    revision: pointer.revision, layerId: p.layerId, observedAt: p.observedAt,
    completionStatus: p.completionStatus, selectedNodeId: p.selectedNodeId, navigationPath: p.navigationPath,
    answerPresentation: JSON.stringify(answers),
    ...(pinnedObservation ? { viewingCurrent: pointer.mode === "following" && String(pointer.layerId) === String(p.layerId),
      visibleUpdate: JSON.stringify(visibleUpdate) } : {}) };
}

export function taskActorCurrentUnchanged(pointer, previous) {
  if (pointer.viewingCurrent === false) return Boolean(previous?.viewingCurrent === false
    && String(pointer.threadId) === String(previous.threadId) && String(pointer.turnId) === String(previous.turnId)
    && String(pointer.attemptId) === String(previous.attemptId) && String(pointer.layerId) === String(previous.layerId)
    && pointer.completionStatus === previous.completionStatus && pointer.visibleUpdate === previous.visibleUpdate
    && String(pointer.selectedNodeId) === String(previous.selectedNodeId)
    && JSON.stringify(pointer.navigationPath) === JSON.stringify(previous.navigationPath)
    && pointer.answerPresentation === previous.answerPresentation);
  return Boolean(previous && pointer.viewingCurrent === previous.viewingCurrent && pointer.revision === previous.revision
    && String(pointer.threadId) === String(previous.threadId)
    && String(pointer.attemptId) === String(previous.attemptId) && String(pointer.turnId) === String(previous.turnId)
    && pointer.completionStatus === previous.completionStatus
    && pointer.answerPresentation === previous.answerPresentation);
}

// These functions are serialized by Playwright; keep their dependencies local.
export function taskActorFillCapability(element) {
  const inputType = element.matches("input") ? element.type : null;
  const supportedInput = ["text", "email", "number", "password", "search", "tel", "url",
    "color", "date", "time", "datetime-local", "month", "range", "week"].includes(inputType);
  return { inputType, canFill: !element.disabled && !element.matches(":disabled") && !element.readOnly
    && (supportedInput || element.matches("textarea") || element.isContentEditable === true) };
}

export function taskActorWorkingControlAllowed(element, kind) {
  if (kind === "scroll") return true;
  if (kind === "click" && element?.tagName === "BUTTON" && element.getRootNode() === element.ownerDocument
    && element === element.ownerDocument.querySelector(".workspace-layout #workspaceBreadcrumb > button#viewLatestUpdate")) return true;
  const live = element?.closest?.("[data-live-answer-scope]");
  if (live) {
    const text = element.matches("textarea") || (element.matches("input")
      && ["text", "search", "url", "tel", "email", "password", "number"].includes(element.type));
    if (kind === "fill") return text && !element.readOnly;
    if (["select", "deselect"].includes(kind)) return element.matches("select");
    if (kind === "click") return text || element.matches("select")
      || element.matches('button[data-input-control-role="answer"],button[data-input-control-role="option"]');
    return false;
  }
  return kind === "click" && Boolean(element?.matches?.("#nodeLayer .graph-node[data-node],#detailActions button[data-review-kind=navigate-action],#workspaceBreadcrumb button[data-review-kind=layer-navigation],#closeInspector"));
}

export function taskActorControlIdentity(element) {
  const p = element.ownerDocument.defaultView.__taskActorPresentation;
  if (!p?.threadId || !p?.turnId || !p?.layerId) return null;
  let kind; let keys;
  if (element.tagName === "BUTTON" && element.getRootNode() === element.ownerDocument
    && element === element.ownerDocument.querySelector(".workspace-layout #workspaceBreadcrumb > button#viewLatestUpdate")) {
    kind = "current-update"; keys = ["data-current-update-scope", "data-current-update-revision", "aria-label"];
  } else if (element.matches?.(".workspace-layout #nodeLayer .graph-node[data-node]")) {
    kind = "node"; keys = ["data-node", "aria-label"];
  } else if (p.selectedNodeId != null && element.matches?.(".workspace-layout #detailActions button.action-control[data-action-id]")) {
    if (!element.dataset.actionId || element.dataset.reviewActionId !== element.dataset.actionId
      || !["navigate-action", "invoke-action"].includes(element.dataset.reviewKind)) return null;
    kind = "action"; keys = ["data-action-id", "data-review-ref", "data-review-kind", "data-review-action-id", "data-review-target-layer-id", "aria-label"];
  } else if (element.matches?.(".workspace-layout #workspaceBreadcrumb button.breadcrumb-segment[data-review-path-index]")) {
    if (!Array.isArray(p.navigationPath)) return null;
    const index = Number(element.dataset.reviewPathIndex);
    const entry = p.navigationPath?.[index];
    if (!Number.isSafeInteger(index) || index < 0 || index >= p.navigationPath.length - 1 || !entry
      || element.dataset.reviewKind !== "layer-navigation"
      || element.dataset.reviewRef !== `breadcrumb-layer:${index}:${entry.layerId}`) return null;
    kind = "breadcrumb"; keys = ["data-review-ref", "data-review-kind", "data-review-path-index", "aria-label", "title", "aria-current"];
  } else if (element.closest?.("[data-live-answer-scope]")) {
    kind = "live-input"; keys = ["data-input-control-role", "data-option-key", "aria-label", "data-gc-mount"];
    const live = element.closest("[data-live-answer-scope]");
    return { kind, attributes: Object.fromEntries(keys.map(key => [key, element.getAttribute(key)])),
      liveScope: live.dataset.liveAnswerScope, tag: element.tagName,
      scope: JSON.stringify([p.threadId, p.turnId, p.layerId, p.attemptId, p.selectedNodeId, p.navigationPath]) };
  } else return null;
  return { kind, attributes: Object.fromEntries(keys.map(key => [key, element.getAttribute(key)])),
    text: element.textContent, scope: JSON.stringify([p.threadId, p.turnId, p.layerId, p.attemptId, p.selectedNodeId, p.navigationPath]) };
}
export function taskActorRebindControl(identity, document = globalThis.document) {
  const p = document.defaultView.__taskActorPresentation;
  if (!p || JSON.stringify([p.threadId, p.turnId, p.layerId, p.attemptId, p.selectedNodeId, p.navigationPath]) !== identity.scope) return null;
  if (identity.kind === "live-input") {
    const elements = [];
    function collect(root) { for (const element of root.querySelectorAll("*")) { elements.push(element); if (element.shadowRoot) collect(element.shadowRoot); } }
    collect(document);
    const matches = elements.filter(element => element.tagName === identity.tag
      && element.closest?.("[data-live-answer-scope]")?.dataset.liveAnswerScope === identity.liveScope
      && Object.entries(identity.attributes).every(([key, value]) => element.getAttribute(key) === value));
    return matches.length === 1 ? matches[0] : null;
  }
  const selector = ({ "current-update": ".workspace-layout #workspaceBreadcrumb > button#viewLatestUpdate", node: ".workspace-layout #nodeLayer .graph-node[data-node]",
    action: ".workspace-layout #detailActions button.action-control[data-action-id]",
    breadcrumb: ".workspace-layout #workspaceBreadcrumb button.breadcrumb-segment[data-review-path-index]" })[identity.kind];
  if (!selector) return null;
  const matches = [...document.querySelectorAll(selector)].filter(element => element.textContent === identity.text
    && Object.entries(identity.attributes).every(([key, value]) => element.getAttribute(key) === value));
  return matches.length === 1 ? matches[0] : null;
}

// Used both to identify a registered authored control and to resolve that exact
// identity after redraw. DOM attributes alone never confer navigation authority.
export async function taskActorAuthoredNavigation(target) {
  const { compiledNodeDetailReviewControls } = await import("/src/product-workspace/node-detail-runtime.js");
  const element = target?.nodeType ? target : null;
  const document = element?.ownerDocument ?? globalThis.document;
  const p = document.defaultView.__taskActorPresentation;
  if (!p?.threadId || !p?.turnId || !p?.layerId || p.selectedNodeId == null) return null;
  const scope = JSON.stringify([p.threadId, p.turnId, p.layerId, p.attemptId, p.selectedNodeId, p.navigationPath]);
  const descriptors = compiledNodeDetailReviewControls(document).filter(control => control.kind === "navigate-action").map(control => ({
    element: control.element,
    identity: { kind: "authored-navigation", scope, actionId: control.actionId, mount: control.element.getAttribute("data-gc-mount"),
      tag: control.element.tagName, text: control.element.textContent, label: control.element.getAttribute("aria-label") },
  }));
  if (element) return descriptors.find(control => control.element === element)?.identity ?? null;
  const matches = descriptors.filter(control => JSON.stringify(control.identity) === JSON.stringify(target));
  return matches.length === 1 ? matches[0].element : null;
}

// Native popup pixels are absent from headless screenshots. This is an explicit
// opened-menu accessibility observation, never a closed DOM inventory.
export function taskActorOpenedSelect(element, { visibleList = false } = {}) {
  const list = visibleList && (element.multiple || element.size > 1);
  if (!element.isConnected || element.tagName !== "SELECT" || element.disabled
    || (!list && (!element.matches(":open") || element.multiple || element.size > 1))) return null;
  const view = element.ownerDocument.defaultView;
  const box = element.getBoundingClientRect();
  const style = view.getComputedStyle(element);
  if (list && (style.display === "none" || style.visibility === "hidden" || Number(style.opacity || 1) === 0)) return null;
  const options = [...element.options];
  if (options.length > 32 || options.some(option => option.label.length > 500)) return null;
  const labels = options.map(option => option.label);
  const offered = options.filter(option => {
    for (let node = option; node && node !== element; node = node.parentElement) {
      if (node.disabled || node.hidden || node.getAttribute("aria-hidden") === "true"
        || node.getAttribute("aria-disabled") === "true" || view.getComputedStyle(node).display === "none"
        || view.getComputedStyle(node).visibility === "hidden"
        || (list && Number(view.getComputedStyle(node).opacity || 1) === 0)) return false;
    }
    if (list) {
      const r = option.getBoundingClientRect();
      if (!r.width || !r.height || r.left < Math.max(0, box.left + element.clientLeft)
        || r.right > Math.min(view.innerWidth, box.right - (parseFloat(style.borderRightWidth) || 0))
        || r.top < Math.max(0, box.top + element.clientTop)
        || r.bottom > Math.min(view.innerHeight, box.bottom - (parseFloat(style.borderBottomWidth) || 0))) return false;
      const root = element.getRootNode();
      // Chromium rounds native option hit tests to device pixels. A half-pixel
      // bottom probe can hit the next row even when this row is fully painted.
      const insetX = Math.min(1, r.width / 4), insetY = Math.min(1, r.height / 4);
      for (const x of [r.left + insetX, (r.left + r.right) / 2, r.right - insetX]) {
        for (const y of [r.top + insetY, (r.top + r.bottom) / 2, r.bottom - insetY]) {
          const hit = root.elementFromPoint?.(x, y);
          if (hit !== element && hit !== option && !option.contains(hit)) return false;
        }
      }
    }
    return option.label.length > 0 && labels.filter(label => label === option.label).length === 1;
  });
  const p = element.ownerDocument.defaultView.__taskActorPresentation;
  if (!p?.threadId || !p?.turnId || !p?.layerId) return null;
  return { labels: offered.map(option => option.label),
    ...(list ? { list: true, multiple: element.multiple, selected: offered.filter(option => option.selected).map(option => option.label),
      indices: offered.map(option => option.index), selectedIndices: options.filter(option => option.selected).map(option => option.index) } : {}),
    signature: JSON.stringify([p?.threadId, p?.turnId, p?.layerId, p?.attemptId, p?.selectedNodeId, p?.navigationPath,
      options.map(option => [option.label, option.value, option.disabled, option.hidden, option.parentElement?.disabled, ...(list ? [option.selected] : [])]), offered.map(option => option.index), ...(list ? [element.multiple, element.size] : [])]) };
}

export async function openTaskActorBrowser({ tasks, sessionId, productSession, browser, signal, observationContract, diagnosticDirectory }) {
  signal?.throwIfAborted();
  const surface = await createHumanTaskSurface({ tasks, sessionId, productSession, actor: true, signal });
  let context;
  let diagnostics;
  const abort = () => {
    // Cancellation authority wins over trace completeness. Do not leave pending
    // browser input alive while diagnostic teardown waits for an archive.
    void context?.close().catch(() => {});
    void diagnostics?.close().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    context = await browser.newContext({ viewport: { width: 1480, height: 920 } });
    signal?.throwIfAborted();
    await context.addInitScript(() => {
      // Installed before application handlers. The counter cannot be reset by page
      // code; any trusted input makes a failed click outcome ambiguous.
      let inputEvents = 0;
      for (const type of ["pointerdown", "pointerup", "pointermove", "pointerover", "pointerout", "pointerenter", "pointerleave", "mousedown", "mouseup", "mousemove", "mouseover", "mouseout", "mouseenter", "mouseleave", "click", "dblclick", "auxclick", "focus", "blur", "focusin", "focusout", "input", "change", "keydown", "keyup", "touchstart", "touchend", "touchmove", "pointercancel", "touchcancel", "wheel", "scroll", "scrollend"]) {
        window.addEventListener(type, event => { if (event.isTrusted) inputEvents++; }, true);
      }
      const probeType = `task-actor-input-${crypto.randomUUID()}`;
      const dispatchProbe = window.dispatchEvent.bind(window);
      const ProbeEvent = Event;
      let pendingProbe = null;
      let probeSeen = false;
      window.addEventListener(probeType, event => { if (event === pendingProbe) probeSeen = true; }, true);
      Object.defineProperty(window, "__taskActorInputEvidence", { value: Object.freeze({
        checkpoint() {
          probeSeen = false; pendingProbe = new ProbeEvent(probeType);
          dispatchProbe(pendingProbe); pendingProbe = null;
          return probeSeen ? inputEvents : null;
        },
      }), configurable: false, writable: false });
      const nativeFetch = window.fetch.bind(window);
      const writes = window.__taskActorWrites = { pending: 0, changedAt: 0 };
      window.fetch = async (input, options = {}) => {
        const method = options.method || (input instanceof Request ? input.method : "GET");
        const path = new URL(input instanceof Request ? input.url : input, location.href).pathname;
        const mutation = path.startsWith("/api/") && (method !== "GET"
          || /\/interactions\/[0-9]+\/(?:layers\/|actions\/[^/]+\/destination|input-children)/.test(path));
        if (mutation) { writes.pending++; writes.changedAt = Date.now(); }
        try { return await nativeFetch(input, options); }
        finally { if (mutation) { writes.pending--; writes.changedAt = Date.now(); } }
      };
    });
    const origin = new URL(surface.url).origin;
    await context.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    try { diagnostics = await createActorDiagnostics({ directory: diagnosticDirectory, context, surfaceUrl: surface.url, sessionId }); } catch { console.error("Eval actor diagnostics unavailable: could not initialize private capture directory. Task execution continues."); }
    const page = await context.newPage();
    diagnostics?.attach(page);
    page.on("popup", (popup) => { void popup.close(); });
    await page.goto(surface.url);
    await page.locator(".workspace-layout").waitFor({ state: "visible" });
    const pinnedObservation = observationContract?.id === "task-actor-observation-v5";
    const listObservation = observationContract?.id === "task-actor-observation-v4";
    const nativeMenuObservation = ["task-actor-observation-v2", "task-actor-observation-v3", "task-actor-observation-v4", "task-actor-observation-v5"].includes(observationContract?.id)
      && observationContract.optionObservation === "opened-native-select-accessibility";
    let openedSelect = null;
    let openedMenuSignature = null;
    let menuAuthorities = new Map();
    let handles = new Map();
    let controlIdentities = new Map();
    async function observe(expected, working = false) {
      signal?.throwIfAborted();
      if (expected) await page.waitForFunction(taskActorPresentationReady, { expected }, { timeout: 30000 });
      for (const handle of handles.values()) await handle.dispose();
      handles = new Map();
      controlIdentities = new Map();
      menuAuthorities = new Map();
      const snapshot = await page.evaluateHandle(async ({ working, pinnedObservation }) => {
        const { isVisibleElement, accessibleControlName } = await import("/src/review-tools.js");
        const { compiledNodeDetailReviewControls } = await import("/src/product-workspace/node-detail-runtime.js");
        const authoredNavigation = new Set(compiledNodeDetailReviewControls(document).filter(control => control.kind === "navigate-action").map(control => control.element));
        const root = document.querySelector(".workspace-layout");
        const elements = [];
        function collect(node) {
          for (const child of node.children || []) {
            elements.push(child);
            collect(child);
            if (child.shadowRoot) collect(child.shadowRoot);
          }
        }
        collect(root);
        function visibleRect(element) {
          if (!isVisibleElement(element)) return false;
          const r = element.getBoundingClientRect();
          const x = Math.max(0, r.left) + Math.min(r.width, window.innerWidth - Math.max(0, r.left)) / 2;
          const y = Math.max(0, r.top) + Math.min(r.height, window.innerHeight - Math.max(0, r.top)) / 2;
          const hit = element.getRootNode().elementFromPoint?.(x, y);
          return hit === element || element.contains(hit);
        }
        function actorControlName(element) {
          if (!element.matches("input,textarea,select")) return accessibleControlName(element);
          // Native field contents (including closed option lists and clipped
          // values) belong to pixels, not the control-name side channel.
          const labels = [...(element.labels || [])].map(label => {
            const copy = label.cloneNode(true);
            copy.querySelectorAll("input,textarea,select,[hidden],[aria-hidden=true]").forEach(child => child.remove());
            return copy.textContent;
          }).join(" ").trim();
          return (element.getAttribute("aria-label") || labels || element.getAttribute("title") || element.getAttribute("placeholder") || "").replace(/\s+/g, " ").trim();
        }
        const visible = elements.filter(visibleRect);
        let controls = visible.filter((element) => (element.matches("button,input:not([type=hidden]):not([type=file]),textarea,select,[role=button],[role=tab],summary") || authoredNavigation.has(element)) && !element.disabled && element.getAttribute("aria-disabled") !== "true");
        if (working) controls = controls.filter(element => {
          const live = element.closest?.("[data-live-answer-scope]");
          return (pinnedObservation && element.tagName === "BUTTON" && element.getRootNode() === element.ownerDocument
            && element === element.ownerDocument.querySelector(".workspace-layout #workspaceBreadcrumb > button#viewLatestUpdate")) || authoredNavigation.has(element) || (live && (element.matches("textarea,input,select") || ["answer", "option"].includes(element.dataset.inputControlRole)))
            || element.matches("#nodeLayer .graph-node[data-node],#detailActions button[data-review-kind=navigate-action],#workspaceBreadcrumb button[data-review-kind=layer-navigation],#closeInspector");
        });
        // Pixels are the content observation. Accessible names identify controls;
        // never flatten full DOM paragraphs hidden under scroll/clipping.
        const text = "Use the attached screenshot and these currently visible controls.";
        const inspector = document.getElementById("inspectorContent");
        return { text, canScroll: Boolean(inspector && visibleRect(inspector) && inspector.scrollHeight > inspector.clientHeight + 1), elements: controls, controls: controls.map((element) => ({ name: actorControlName(element), role: element.getAttribute("role") || element.tagName.toLowerCase() })) };
      }, { working, pinnedObservation });
      try {
        const text = await (await snapshot.getProperty("text")).jsonValue();
        const controls = await (await snapshot.getProperty("controls")).jsonValue();
        const elements = await snapshot.getProperty("elements");
        for (let index = 0; index < controls.length; index++) {
          const ref = randomUUID();
          const handle = await elements.getProperty(String(index));
          handles.set(ref, handle);
          const identity = await handle.evaluate(taskActorAuthoredNavigation) ?? await handle.evaluate(taskActorControlIdentity);
          if (identity) controlIdentities.set(ref, identity);
          controls[index].ref = ref;
          const fill = await handle.evaluate(taskActorFillCapability);
          if (working && fill.canFill) fill.canFill = await handle.evaluate(taskActorWorkingControlAllowed, "fill");
          Object.assign(controls[index], fill);
          if (listObservation) {
            const list = await handle.evaluate(taskActorOpenedSelect, { visibleList: true });
            if (list?.list) {
              Object.assign(controls[index], { options: list.labels, selectedOptions: list.selected, multiple: list.multiple, optionObservation: "visible-native-list-accessibility" });
              menuAuthorities.set(ref, list);
            }
          }
          if (nativeMenuObservation && openedSelect && await handle.evaluate((element, opened) => element === opened, openedSelect)) {
            const menu = await handle.evaluate(taskActorOpenedSelect);
            if (menu && menu.signature === openedMenuSignature) {
              controls[index].options = menu.labels;
              controls[index].optionObservation = "opened-native-select-accessibility";
              menuAuthorities.set(ref, menu);
            } else { await openedSelect.dispose(); openedSelect = null; }
          }
        }
        await elements.dispose();
        const screenshot = (await page.screenshot({ type: "png" })).toString("base64");
        const canScroll = await (await snapshot.getProperty("canScroll")).jsonValue();
        return { text, controls, screenshot, availableActions: ["click", "fill", "select", ...(listObservation ? ["deselect"] : []), ...(canScroll ? ["scroll"] : []), "next_step", "finish"] };
      } finally { await snapshot.dispose(); }
    }
    return {
      async observeCurrent(expected, previous) {
        return abortable(signal, async () => {
          signal?.throwIfAborted();
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          const pointer = await page.evaluate(taskActorCurrentIdentity, { expected, pinnedObservation });
          if (!pointer || (expected.workingOnly && ["accepted", "failed", "stopped", "not_started"].includes(pointer.completionStatus)) || taskActorCurrentUnchanged(pointer, previous)) return null;
          const observation = await observe(undefined, true);
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          const after = await page.evaluate(taskActorCurrentIdentity, { expected, pinnedObservation });
          // A paint, selection or pointer change during capture makes the pixels
          // unbound. Keep the gap; never relabel them as an earlier revision.
          if (JSON.stringify(pointer) !== JSON.stringify(after)) return { kind: "gap", pointer, reason: "presentation_changed_during_capture" };
          return { kind: "observation", pointer, observation: { ...observation,
            text: pointer.viewingCurrent === false
              ? "You are browsing earlier material while work continues. Use the screenshot and visible controls; a visible update announcement does not reveal its contents."
              : "Current working update. You may answer visible questions using the explicit Answer control. Send starts a later interaction after settlement.",
            ...(pointer.viewingCurrent === false ? { displayedView: "historical" }
              : { currentUpdate: { revision: pointer.revision, observedAt: pointer.observedAt, completionStatus: pointer.completionStatus } }),
            availableActions: observation.availableActions.filter(kind => ["click", "fill", "select", ...(listObservation ? ["deselect"] : []), "scroll"].includes(kind)) } };
        });
      },
      async observe(expected) { try { return await observe(expected); } catch (error) { await diagnostics?.operationError("observe", error); throw error; } },
      async act(action, correlation = {}) {
        const actionId = randomUUID();
        let stage = "preflight"; let diagnosticTarget = null; let waitForCurrentNavigation = false;
        await diagnostics?.record("action_started", { actionId, actionEventId: correlation.actionEventId ?? null, observationEventId: correlation.observationEventId ?? null, kind: action.kind, ref: action.ref ?? null });
        try {
        if (correlation.current) {
          const now = await page.evaluate(taskActorCurrentIdentity, { expected: correlation.current.expected, pinnedObservation });
          if (!now || ["revision", "layerId", "attemptId", "selectedNodeId"].some(key => String(now[key]) !== String(correlation.current.pointer[key]))
            || JSON.stringify(now.navigationPath) !== JSON.stringify(correlation.current.pointer.navigationPath)) {
            throw Object.assign(new Error("The working question changed before dispatch."), { code: "actor_control_stale", actionDispatched: false });
          }
        }
        signal?.throwIfAborted();
        if (!["click", "select", "deselect"].includes(action.kind) && openedSelect) {
          await openedSelect.dispose(); openedSelect = null; menuAuthorities.clear();
        }
        if (action.kind === "scroll") {
          if (!["up", "down"].includes(action.value)) throw new Error("Scroll must be up or down.");
          stage = "dispatch_scroll";
          const inspector = page.locator("#inspectorContent");
          if (!await inspector.isVisible()) throw Object.assign(new Error("No visible node detail is available to scroll."), {
            code: "actor_control_unavailable", actionDispatched: false,
          });
          const canMove = await inspector.evaluate((element, direction) => element.scrollHeight > element.clientHeight + 1
            && (direction === "up" ? element.scrollTop > 0 : element.scrollTop + element.clientHeight < element.scrollHeight - 1), action.value);
          if (!canMove) throw Object.assign(new Error("Node detail cannot scroll farther in that direction."), {
            code: "actor_control_unavailable", actionDispatched: false,
          });
          // Visibility can change after observation. Only the checks above prove
          // no input; a failed hover or wheel remains an ambiguous browser failure.
          await inspector.hover({ timeout: 5000 });
          await page.mouse.wheel(0, action.value === "up" ? -600 : 600);
        } else {
          let handle = handles.get(action.ref)?.asElement();
          stage = "resolve_target";
          // Renderer refresh replaces graph and navigation controls during model latency.
          // Rebind only exact control identity in the same presentation, never by name.
          const identity = controlIdentities.get(action.ref);
          waitForCurrentNavigation = pinnedObservation && action.kind === "click" && identity?.kind === "current-update";
          if (handle && identity && !await handle.evaluate(element => element.isConnected)) {
            const replacement = await page.evaluateHandle(identity.kind === "authored-navigation" ? taskActorAuthoredNavigation : taskActorRebindControl, identity);
            const rebound = replacement.asElement();
            if (rebound) { await handle.dispose(); handles.set(action.ref, replacement); handle = rebound; }
            else await replacement.dispose();
          }
          const authoredNavigation = handle && action.kind === "click" && await handle.evaluate(taskActorAuthoredNavigation);
          if (correlation.current && (!handle || (!authoredNavigation && !await handle.evaluate(taskActorWorkingControlAllowed, action.kind)))) {
            throw Object.assign(new Error("This control is unavailable during working observation."), { code: "actor_control_unavailable", actionDispatched: false });
          }
          diagnosticTarget = handle;
          stage = "validate_target";
          if (diagnostics) { try { await diagnostics.record("target_before", { actionId, state: await diagnostics.targetState(handle) }); } catch (error) { await diagnostics.operationError("target_before", error); } }
          if (!handle) throw Object.assign(new Error("Actor control is stale or outside the observed workspace."), { code: "actor_control_stale", actionDispatched: false });
          if (!await handle.evaluate(async (element) => {
            const { isVisibleElement } = await import("/src/review-tools.js");
            let owner = element;
            while (owner && !owner.closest?.(".workspace-layout")) owner = owner.getRootNode()?.host;
            const r = element.getBoundingClientRect();
            const x = Math.max(0, r.left) + Math.min(r.width, window.innerWidth - Math.max(0, r.left)) / 2;
            const y = Math.max(0, r.top) + Math.min(r.height, window.innerHeight - Math.max(0, r.top)) / 2;
            const hit = element.getRootNode().elementFromPoint?.(x, y);
            return Boolean(owner && isVisibleElement(element) && (hit === element || element.contains(hit)) && !element.disabled && element.getAttribute("aria-disabled") !== "true");
          })) throw Object.assign(new Error("Actor control is no longer visible or enabled."), { code: "actor_control_unavailable", actionDispatched: false });
          if (action.kind === "click") {
            menuAuthorities.clear();
            if (openedSelect) { await openedSelect.dispose(); openedSelect = null; }
            const clickEvidence = await handle.evaluateHandle(element => ({
              document: element.ownerDocument, root: element.ownerDocument.documentElement, target: element,
              recorder: window.__taskActorInputEvidence, count: window.__taskActorInputEvidence?.checkpoint(),
            }));
            try {
              stage = "dispatch_click";
              await handle.click({ timeout: 5000 });
            } catch (error) {
              // Text identifies the narrow browser failure, but never establishes
              // nondispatch by itself. A same-document barrier and untouched input
              // recorder are required. No click is replayed here.
              const detached = /Element is not attached to the DOM/.test(error?.message || "");
              let recoveryEvidence = null;
              const untouched = detached && !signal?.aborted && await clickEvidence.evaluate(evidence => {
                const checks = {
                  sameDocument: evidence.document === document,
                  sameRoot: evidence.root === document.documentElement,
                  sameOwner: evidence.target.ownerDocument === document,
                  detachedTarget: !evidence.target.isConnected,
                  sameRecorder: evidence.recorder === window.__taskActorInputEvidence,
                  validInitialCount: Number.isSafeInteger(evidence.count),
                };
                // Preserve short-circuit checkpoint semantics of the authority proof.
                checks.untouchedInput = Object.values(checks).every(Boolean) ? evidence.recorder.checkpoint() === evidence.count : null;
                return checks;
              }).then(checks => { recoveryEvidence = checks; return Object.values(checks).every(value => value === true); }).catch(() => false);
              await diagnostics?.record("click_recovery", { actionId, error: diagnostics.errorInfo(error), detachedError: detached,
                aborted: Boolean(signal?.aborted), checks: recoveryEvidence, eligible: Boolean(untouched && !signal?.aborted),
                reason: !detached ? "not_detached_error" : signal?.aborted ? "aborted" : !recoveryEvidence ? "evidence_unavailable" : untouched ? "proven_nondispatch" : "authority_checks_failed" });
              if (untouched && !signal?.aborted) throw Object.assign(new Error("Actor control detached before browser input dispatch."), {
                code: "actor_control_unavailable", actionDispatched: false,
              });
              throw error;
            } finally { await clickEvidence.dispose().catch(() => {}); }
            stage = "inspect_open_menu";
            if (nativeMenuObservation && await handle.evaluate(element => element.tagName === "SELECT" && element.matches(":open"))) {
              openedSelect = await handle.evaluateHandle(element => element);
              openedMenuSignature = (await handle.evaluate(taskActorOpenedSelect))?.signature;
            }
          }
          else if (action.kind === "fill") { stage = "dispatch_fill"; await handle.fill(action.value, { timeout: 5000 }); }
          else if (["select", "deselect"].includes(action.kind)) {
            let selection = { label: action.value };
            if (nativeMenuObservation) {
              const authority = menuAuthorities.get(action.ref);
              const current = authority ? await handle.evaluate(taskActorOpenedSelect, { visibleList: listObservation }) : null;
              if (!authority || !current || (!current.list && (!openedSelect
                || !await handle.evaluate((element, opened) => element === opened, openedSelect)))
                || current.signature !== authority.signature || !authority.labels.includes(action.value)) {
                throw Object.assign(new Error("Actor option is not authorized by the currently observed open menu."), { code: "actor_control_unavailable", actionDispatched: false });
              }
              if (action.kind === "deselect" && (!current.list || !current.multiple || !current.selected.includes(action.value))) {
                throw Object.assign(new Error("Actor option is not an observed selected list item."), { code: "actor_control_unavailable", actionDispatched: false });
              }
              if (current.list && current.multiple) {
                const index = current.indices[current.labels.indexOf(action.value)];
                const selected = new Set(current.selectedIndices);
                if (action.kind === "deselect") selected.delete(index); else selected.add(index);
                selection = [...selected].map(index => ({ index }));
              }
            } else if (action.kind === "deselect") {
              throw Object.assign(new Error("This actor has no list selection authority."), { code: "actor_control_unavailable", actionDispatched: false });
            }
            stage = "dispatch_select";
            await handle.selectOption(selection, { timeout: 5000 });
            // Playwright dispatches normal input/change but does not dismiss the
            // native popup. Close only this still-open menu before another action.
            if (nativeMenuObservation && await handle.evaluate(element => element.isConnected && element.matches(":open"))) {
              await page.keyboard.press("Escape");
            }
            menuAuthorities.clear();
            if (openedSelect) { await openedSelect.dispose(); openedSelect = null; }
          }
          else throw new Error("Unknown actor browser action.");
        }
        if (waitForCurrentNavigation) {
          stage = "wait_for_current_navigation";
          await page.waitForFunction(() => document.querySelector("#workspaceBreadcrumb")?.getAttribute("aria-busy") !== "true", null, { timeout: 30000 });
        }
        stage = "wait_for_render";
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        stage = "wait_for_writes";
        await page.waitForFunction(() => window.__taskActorWrites.pending === 0 && Date.now() - window.__taskActorWrites.changedAt >= 200, null, { timeout: 30000 });
        await diagnostics?.record("action_completed", { actionId });
        } catch (error) {
          try { await diagnostics?.failure(page, { actionId, stage, error, target: diagnosticTarget }); } catch { /* Preserve the original exception. */ }
          throw error;
        }
      },
      async nextStep() {
        try {
        const url = new URL(surface.url);
        url.searchParams.set("threadId", String(tasks.get(sessionId).currentThreadId));
        await page.goto(url.href);
        await page.locator(".workspace-layout").waitFor({ state: "visible" });
        } catch (error) { await diagnostics?.operationError("next_step", error); throw error; }
      },
      async close() { signal?.removeEventListener("abort", abort); try { await diagnostics?.close(); } finally { try { await context.close(); } finally { await surface.close(); } } },
    };
  } catch (error) { await diagnostics?.operationError("startup", error); signal?.removeEventListener("abort", abort); try { await diagnostics?.close(); } finally { try { await context?.close(); } finally { await surface.close(); } } throw error; }
}
