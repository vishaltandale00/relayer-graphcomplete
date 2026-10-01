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

export async function openTaskActorBrowser({ tasks, sessionId, productSession, browser, signal }) {
  signal?.throwIfAborted();
  const surface = await createHumanTaskSurface({ tasks, sessionId, productSession, actor: true, signal });
  let context;
  const abort = () => { void context?.close().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    context = await browser.newContext({ viewport: { width: 1480, height: 920 } });
    signal?.throwIfAborted();
    await context.addInitScript(() => {
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
    const page = await context.newPage();
    page.on("popup", (popup) => { void popup.close(); });
    await page.goto(surface.url);
    await page.locator(".workspace-layout").waitFor({ state: "visible" });
    let handles = new Map();
    async function observe(expected) {
      signal?.throwIfAborted();
      if (expected) await page.waitForFunction(taskActorPresentationReady, { expected }, { timeout: 30000 });
      for (const handle of handles.values()) await handle.dispose();
      handles = new Map();
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
          handles.set(ref, await elements.getProperty(String(index)));
          controls[index].ref = ref;
        }
        await elements.dispose();
        const screenshot = (await page.screenshot({ type: "png" })).toString("base64");
        return { text, controls, screenshot };
      } finally { await snapshot.dispose(); }
    }
    return {
      observe,
      async act(action) {
        signal?.throwIfAborted();
        if (action.kind === "scroll") {
          if (!["up", "down"].includes(action.value)) throw new Error("Scroll must be up or down.");
          await page.locator("#inspectorContent").hover();
          await page.mouse.wheel(0, action.value === "up" ? -600 : 600);
        } else {
          const handle = handles.get(action.ref)?.asElement();
          if (!handle) throw new Error("Actor control is stale or outside the observed workspace.");
          if (!await handle.evaluate(async (element) => {
            const { isVisibleElement } = await import("/src/review-tools.js");
            let owner = element;
            while (owner && !owner.closest?.(".workspace-layout")) owner = owner.getRootNode()?.host;
            const r = element.getBoundingClientRect();
            const x = Math.max(0, r.left) + Math.min(r.width, window.innerWidth - Math.max(0, r.left)) / 2;
            const y = Math.max(0, r.top) + Math.min(r.height, window.innerHeight - Math.max(0, r.top)) / 2;
            const hit = element.getRootNode().elementFromPoint?.(x, y);
            return Boolean(owner && isVisibleElement(element) && (hit === element || element.contains(hit)) && !element.disabled && element.getAttribute("aria-disabled") !== "true");
          })) throw new Error("Actor control is no longer visible or enabled.");
          if (action.kind === "click") await handle.click({ timeout: 5000 });
          else if (action.kind === "fill") await handle.fill(action.value, { timeout: 5000 });
          else if (action.kind === "select") await handle.selectOption({ label: action.value }, { timeout: 5000 });
          else throw new Error("Unknown actor browser action.");
        }
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.waitForFunction(() => window.__taskActorWrites.pending === 0 && Date.now() - window.__taskActorWrites.changedAt >= 200, null, { timeout: 30000 });
      },
      async nextStep() {
        const url = new URL(surface.url);
        url.searchParams.set("threadId", String(tasks.get(sessionId).currentThreadId));
        await page.goto(url.href);
        await page.locator(".workspace-layout").waitFor({ state: "visible" });
      },
      async close() { signal?.removeEventListener("abort", abort); try { await context.close(); } finally { await surface.close(); } },
    };
  } catch (error) { signal?.removeEventListener("abort", abort); try { await context?.close(); } finally { await surface.close(); } throw error; }
}
