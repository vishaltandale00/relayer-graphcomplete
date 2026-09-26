import { chromium } from "playwright";
import { ReviewSession } from "./review-session.mjs";

// Every judge gets a fresh context: no dashboard or human annotation authority.
export async function openBrowserReview({ productSession, context, executionId, threadId, turnId,
  rootLayerId, artifactDirectory, inputOperatorAvailable = false, browser }) {
  const execution = context.cases.find((item) => item.executionId === executionId);
  if (!context.readOnly || !execution?.threadIds?.some((id) => String(id) === String(threadId))) {
    throw new Error("The review thread does not belong to its execution.");
  }
  const isolated = await browser.newContext({ viewport: { width: 1480, height: 920 }, deviceScaleFactor: 1 });
  try {
    const cookie = productSession.readOnlyCookie;
    if (!cookie) throw new Error("Review requires read-only authority.");
    await isolated.addCookies([{ name: cookie.name, value: cookie.value, url: productSession.origin, httpOnly: true, sameSite: "Strict" }]);
    await isolated.addInitScript((reviewContext) => {
      window.relayerEvalReview = {
        context: async () => reviewContext,
        registerPresentationAdapter: (adapter) => { window.__evalPresentation = adapter; },
      };
    }, context);
    const page = await isolated.newPage();
    const url = new URL("/", productSession.origin);
    url.search = new URLSearchParams({ threadId: String(threadId), interactionId: String(turnId), review: "1", ...(inputOperatorAvailable ? { inputOperator: "1" } : {}) });
    await page.goto(url.href);
    await page.waitForFunction(({ executionId, threadId, turnId }) => {
      const state = window.__evalPresentation?.snapshot();
      return state?.executionId === executionId && String(state.threadId) === String(threadId) && String(state.turnId) === String(turnId);
    }, { executionId, threadId, turnId }, { timeout: 30_000 });
    const transport = {
      url: () => page.url(),
      isClosed: () => page.isClosed(),
      command: (command, payload) => page.evaluate(async ({ command, payload }) => {
        const adapter = window.__evalPresentation;
        if (!adapter || !Object.hasOwn(adapter, command) || typeof adapter[command] !== "function") throw new Error("Unknown review command.");
        return adapter[command](payload);
      }, { command, payload }),
      capture: async (clip) => {
        const bytes = await page.screenshot({ type: "png", clip });
        return { bytes, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
      },
    };
    const session = new ReviewSession({ executionId, readOnly: true, transport, artifactDirectory,
      loadInputDraftRevision: async (id) => {
        const response = await fetch(new URL(`/api/state?threadId=${encodeURIComponent(id)}`, productSession.origin), {
          headers: { Cookie: `${cookie.name}=${cookie.value}` },
        });
        if (!response.ok) throw new Error("Could not read the input draft revision.");
        return (await response.json()).inputDraftRevision;
      },
    });
    const state = await session.open();
    if (String(state.layerId) !== String(rootLayerId)) throw new Error("Review did not open the accepted root layer.");
    return { session, state, release: () => isolated.close() };
  } catch (error) { await isolated.close(); throw error; }
}

export function createJudgeBrowser() {
  let pending;
  return {
    get: () => pending ??= chromium.launch({ headless: true }).catch((error) => { pending = undefined; throw error; }),
    close: async () => { if (pending) await (await pending).close(); },
  };
}
