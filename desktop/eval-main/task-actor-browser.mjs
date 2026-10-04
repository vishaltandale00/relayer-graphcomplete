import { createActorDiagnostics } from "./task-actor-diagnostics.mjs";
import { randomUUID } from "node:crypto";
import { createHumanTaskSurface } from "./web-host.mjs";

// Self-contained because Playwright serializes this production predicate.
export function taskActorPresentationReady({ expected, presentation = globalThis.window?.__taskActorPresentation }) {
  const { threadId, turnId, submittedAt } = expected;
  return String(presentation?.threadId) === String(threadId) && String(presentation?.turnId) === String(turnId)
    && presentation.observedAt >= submittedAt
    && (expected.attemptId == null || String(presentation.attemptId) === String(expected.attemptId))
    && (["accepted", "failed", "stopped"].includes(presentation.completionStatus)
      || (presentation.completionStatus === "not_started" && presentation.attemptOutcome === "model_failed"));
}

// These functions are serialized by Playwright; keep their dependencies local.
export function taskActorControlIdentity(element) {
  const p = element.ownerDocument.defaultView.__taskActorPresentation;
  if (!p?.threadId || !p?.turnId || !p?.layerId) return null;
  let kind; let keys;
  if (element.matches?.(".workspace-layout #nodeLayer .graph-node[data-node]")) {
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
  } else return null;
  return { kind, attributes: Object.fromEntries(keys.map(key => [key, element.getAttribute(key)])),
    text: element.textContent, scope: JSON.stringify([p.threadId, p.turnId, p.layerId, p.attemptId, p.selectedNodeId, p.navigationPath]) };
}
export function taskActorRebindControl(identity, document = globalThis.document) {
  const p = document.defaultView.__taskActorPresentation;
  if (!p || JSON.stringify([p.threadId, p.turnId, p.layerId, p.attemptId, p.selectedNodeId, p.navigationPath]) !== identity.scope) return null;
  const selector = ({ node: ".workspace-layout #nodeLayer .graph-node[data-node]",
    action: ".workspace-layout #detailActions button.action-control[data-action-id]",
    breadcrumb: ".workspace-layout #workspaceBreadcrumb button.breadcrumb-segment[data-review-path-index]" })[identity.kind];
  if (!selector) return null;
  const matches = [...document.querySelectorAll(selector)].filter(element => element.textContent === identity.text
    && Object.entries(identity.attributes).every(([key, value]) => element.getAttribute(key) === value));
  return matches.length === 1 ? matches[0] : null;
}

// Native popup pixels are absent from headless screenshots. This is an explicit
// opened-menu accessibility observation, never a closed DOM inventory.
export function taskActorOpenedSelect(element) {
  if (!element.isConnected || element.tagName !== "SELECT" || !element.matches(":open")
    || element.disabled || element.multiple || element.size > 1) return null;
  const options = [...element.options];
  if (options.length > 32 || options.some(option => option.label.length > 500)) return null;
  const labels = options.map(option => option.label);
  const offered = options.filter(option => {
    for (let node = option; node && node !== element; node = node.parentElement) {
      if (node.disabled || node.hidden || node.getAttribute("aria-hidden") === "true"
        || node.getAttribute("aria-disabled") === "true" || getComputedStyle(node).display === "none"
        || getComputedStyle(node).visibility === "hidden") return false;
    }
    return option.label.length > 0 && labels.filter(label => label === option.label).length === 1;
  });
  const p = element.ownerDocument.defaultView.__taskActorPresentation;
  if (!p?.threadId || !p?.turnId || !p?.layerId) return null;
  return { labels: offered.map(option => option.label),
    signature: JSON.stringify([p?.threadId, p?.turnId, p?.layerId, p?.attemptId, p?.selectedNodeId, p?.navigationPath,
      options.map(option => [option.label, option.value, option.disabled, option.hidden, option.parentElement?.disabled]), offered.map(option => option.index)]) };
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
    const nativeMenuObservation = observationContract?.id === "task-actor-observation-v2"
      && observationContract.optionObservation === "opened-native-select-accessibility";
    let openedSelect = null;
    let openedMenuSignature = null;
    let menuAuthorities = new Map();
    let handles = new Map();
    let controlIdentities = new Map();
    async function observe(expected) {
      signal?.throwIfAborted();
      if (expected) await page.waitForFunction(taskActorPresentationReady, { expected }, { timeout: 30000 });
      for (const handle of handles.values()) await handle.dispose();
      handles = new Map();
      controlIdentities = new Map();
      menuAuthorities = new Map();
      const snapshot = await page.evaluateHandle(async () => {
        const { isVisibleElement, accessibleControlName } = await import("/src/review-tools.js");
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
        const controls = visible.filter((element) => element.matches("button,input:not([type=hidden]):not([type=file]),textarea,select,[role=button],[role=tab],summary") && !element.disabled && element.getAttribute("aria-disabled") !== "true");
        // Pixels are the content observation. Accessible names identify controls;
        // never flatten full DOM paragraphs hidden under scroll/clipping.
        const text = "Use the attached screenshot and these currently visible controls.";
        return { text, elements: controls, controls: controls.map((element) => ({ name: actorControlName(element), role: element.getAttribute("role") || element.tagName.toLowerCase() })) };
      });
      try {
        const text = await (await snapshot.getProperty("text")).jsonValue();
        const controls = await (await snapshot.getProperty("controls")).jsonValue();
        const elements = await snapshot.getProperty("elements");
        for (let index = 0; index < controls.length; index++) {
          const ref = randomUUID();
          const handle = await elements.getProperty(String(index));
          handles.set(ref, handle);
          const identity = await handle.evaluate(taskActorControlIdentity);
          if (identity) controlIdentities.set(ref, identity);
          controls[index].ref = ref;
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
        return { text, controls, screenshot };
      } finally { await snapshot.dispose(); }
    }
    return {
      async observe(expected) { try { return await observe(expected); } catch (error) { await diagnostics?.operationError("observe", error); throw error; } },
      async act(action, correlation = {}) {
        const actionId = randomUUID();
        let stage = "preflight"; let diagnosticTarget = null;
        await diagnostics?.record("action_started", { actionId, actionEventId: correlation.actionEventId ?? null, observationEventId: correlation.observationEventId ?? null, kind: action.kind, ref: action.ref ?? null });
        try {
        signal?.throwIfAborted();
        if (!["click", "select"].includes(action.kind) && openedSelect) {
          await openedSelect.dispose(); openedSelect = null; menuAuthorities.clear();
        }
        if (action.kind === "scroll") {
          if (!["up", "down"].includes(action.value)) throw new Error("Scroll must be up or down.");
          stage = "dispatch_scroll";
          await page.locator("#inspectorContent").hover();
          await page.mouse.wheel(0, action.value === "up" ? -600 : 600);
        } else {
          let handle = handles.get(action.ref)?.asElement();
          stage = "resolve_target";
          // Renderer refresh replaces graph and navigation controls during model latency.
          // Rebind only exact control identity in the same presentation, never by name.
          const identity = controlIdentities.get(action.ref);
          if (handle && identity && !await handle.evaluate(element => element.isConnected)) {
            const replacement = await page.evaluateHandle(taskActorRebindControl, identity);
            const rebound = replacement.asElement();
            if (rebound) { await handle.dispose(); handles.set(action.ref, replacement); handle = rebound; }
            else await replacement.dispose();
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
          else if (action.kind === "select") {
            if (nativeMenuObservation) {
              const authority = menuAuthorities.get(action.ref);
              const current = authority ? await handle.evaluate(taskActorOpenedSelect) : null;
              if (!authority || !current || !openedSelect
                || !await handle.evaluate((element, opened) => element === opened, openedSelect)
                || current.signature !== authority.signature || !authority.labels.includes(action.value)) {
                throw Object.assign(new Error("Actor option is not authorized by the currently observed open menu."), { code: "actor_control_unavailable", actionDispatched: false });
              }
            }
            stage = "dispatch_select";
            await handle.selectOption({ label: action.value }, { timeout: 5000 });
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
