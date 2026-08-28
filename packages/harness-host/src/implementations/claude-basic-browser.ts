import { z } from "zod";

export const CLAUDE_BROWSER_SERVER_NAME = "relayer_browser";
export const CLAUDE_BROWSER_TOOL_NAME = "run";
export const CLAUDE_BROWSER_TOOL = `mcp__${CLAUDE_BROWSER_SERVER_NAME}__${CLAUDE_BROWSER_TOOL_NAME}`;

const DEFAULT_CDP_ENDPOINT = "http://127.0.0.1:9222";
const MAX_OPERATIONS = 8;
const MAX_TEXT_LENGTH = 20_000;
const MAX_VALUE_LENGTH = 10_000;
const MAX_PROTOCOL_MESSAGE_LENGTH = 1_000_000;
const REQUEST_TIMEOUT_MS = 10_000;

const selector = z.string().trim().min(1).max(1_000);
const targetSelector = z.union([
  z.object({ targetId: z.string().trim().min(1).max(256) }).strict(),
  z.object({ urlContains: z.string().min(1).max(2_048) }).strict(),
  z.object({ titleContains: z.string().min(1).max(1_000) }).strict(),
]);
const operation = z.discriminatedUnion("type", [
  z.object({ type: z.literal("navigate"), url: z.url().max(4_096) }).strict(),
  z.object({ type: z.literal("read_text"), selector: selector.optional() }).strict(),
  z.object({ type: z.literal("click"), selector }).strict(),
  z.object({ type: z.literal("fill"), selector, value: z.string().max(MAX_VALUE_LENGTH) }).strict(),
]);
const requestSchema = {
  target: targetSelector.optional(),
  operations: z.array(operation).min(1).max(MAX_OPERATIONS),
};

type BrowserRequest = z.infer<z.ZodObject<typeof requestSchema>>;
type BrowserTargetSelector = z.infer<typeof targetSelector>;

export interface ClaudeBrowserSdk {
  readonly tool: (
    name: string,
    description: string,
    inputSchema: typeof requestSchema,
    handler: (input: BrowserRequest, extra: unknown) => Promise<ClaudeBrowserToolResult>,
  ) => unknown;
  readonly createSdkMcpServer: (options: {
    readonly name: string;
    readonly version: string;
    readonly instructions: string;
    readonly tools: readonly unknown[];
  }) => unknown;
}

export interface ClaudeBrowserToolResult {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly isError?: boolean;
}

interface BrowserSocket {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: { readonly data?: unknown }) => void, options?: { once?: boolean }): void;
  removeEventListener(type: string, listener: (event: { readonly data?: unknown }) => void): void;
  send(data: string): void;
  close(): void;
}

export interface ClaudeBasicBrowserDependencies {
  /** Test-only override. Production always uses the code-owned loopback endpoint. */
  readonly cdpEndpoint?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly createWebSocket?: (url: string) => BrowserSocket;
  readonly timeoutMs?: number;
}

interface CdpTarget {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly url: string;
  readonly webSocketDebuggerUrl: string;
}

interface CdpResponse {
  readonly id?: number;
  readonly method?: string;
  readonly result?: unknown;
  readonly error?: unknown;
}

export function createClaudeBasicBrowserServer(
  sdk: ClaudeBrowserSdk,
  dependencies: ClaudeBasicBrowserDependencies = {},
): unknown {
  const endpoint = validateLoopbackEndpoint(dependencies.cdpEndpoint ?? DEFAULT_CDP_ENDPOINT);
  const tool = sdk.tool(
    CLAUDE_BROWSER_TOOL_NAME,
    "Use the user's already-running Chrome through its loopback DevTools endpoint. Runs one bounded batch of navigation, text observation, click, and fill operations. If Chrome has multiple pages, select exactly one by targetId, URL substring, or title substring. It never starts or stops Chrome.",
    requestSchema,
    async (input, extra) => {
      const signal = signalFromExtra(extra);
      try {
        const output = await runBrowserOperations(input, endpoint, dependencies, signal);
        return { content: [{ type: "text", text: JSON.stringify(output) }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: browserErrorMessage(signal?.aborted ? new BrowserFailure("cancelled") : error) }],
          isError: true,
        };
      }
    },
  );
  return sdk.createSdkMcpServer({
    name: CLAUDE_BROWSER_SERVER_NAME,
    version: "1.0.0",
    instructions: "This server attaches only to the code-owned loopback Chrome DevTools endpoint. Use one run call for a bounded related interaction. A single open page needs no target selector; multiple pages require a selector that matches exactly one. Chrome must already be running with remote debugging enabled.",
    tools: [tool],
  });
}

async function runBrowserOperations(
  request: BrowserRequest,
  endpoint: URL,
  dependencies: ClaudeBasicBrowserDependencies,
  signal?: AbortSignal,
): Promise<{ readonly operations: readonly unknown[] }> {
  throwIfAborted(signal);
  const target = await discoverTarget(endpoint, dependencies, request.target, signal);
  const client = new CdpClient(
    target.webSocketDebuggerUrl,
    dependencies.createWebSocket ?? ((url) => new WebSocket(url) as unknown as BrowserSocket),
    dependencies.timeoutMs ?? REQUEST_TIMEOUT_MS,
    signal,
  );
  try {
    await client.connect();
    const results: unknown[] = [];
    for (const current of request.operations) {
      throwIfAborted(signal);
      switch (current.type) {
        case "navigate": {
          const url = validateNavigationUrl(current.url);
          await client.command("Page.enable");
          const loaded = client.waitForEvent("Page.loadEventFired");
          try {
            const navigation = await client.command("Page.navigate", { url });
            if (isRecord(navigation) && typeof navigation.errorText === "string" && navigation.errorText !== "") {
              throw new BrowserFailure("navigation-failed");
            }
            const loadOutcome = await loaded.promise;
            if (!loadOutcome.ok) throw loadOutcome.error;
          } catch (error) {
            loaded.cancel();
            throw error;
          }
          results.push({ type: current.type, url });
          break;
        }
        case "read_text": {
          const value = await client.evaluate(pageFunction("read_text"), { selector: current.selector ?? "body" });
          const text = typeof value === "string" ? value.slice(0, MAX_TEXT_LENGTH) : "";
          results.push({ type: current.type, text, truncated: typeof value === "string" && value.length > MAX_TEXT_LENGTH });
          break;
        }
        case "click":
          await client.evaluate(pageFunction("click"), { selector: current.selector });
          results.push({ type: current.type, clicked: true });
          break;
        case "fill":
          await client.evaluate(pageFunction("fill"), { selector: current.selector, value: current.value });
          results.push({ type: current.type, filled: true });
          break;
      }
    }
    return { operations: results };
  } finally {
    client.close();
  }
}

async function discoverTarget(
  endpoint: URL,
  dependencies: ClaudeBasicBrowserDependencies,
  selector: BrowserTargetSelector | undefined,
  signal?: AbortSignal,
): Promise<CdpTarget> {
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new BrowserFailure("timeout")), dependencies.timeoutMs ?? REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(new URL("/json/list", endpoint), { signal: controller.signal });
    if (!response.ok) throw new BrowserFailure("unavailable");
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (declaredLength > MAX_PROTOCOL_MESSAGE_LENGTH) throw new BrowserFailure("invalid-response");
    const text = await readBoundedResponse(response, controller);
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw new BrowserFailure("invalid-response"); }
    if (!Array.isArray(body)) throw new BrowserFailure("invalid-response");
    const targets = body.filter((candidate): candidate is CdpTarget => (
      isRecord(candidate)
      && candidate.type === "page"
      && typeof candidate.id === "string"
      && typeof candidate.title === "string"
      && typeof candidate.url === "string"
      && isAllowedSocketUrl(candidate.webSocketDebuggerUrl, endpoint)
    ));
    const matches = selectTargets(targets, selector);
    if (matches.length === 0) throw new BrowserFailure("no-page");
    if (matches.length > 1) throw new BrowserFailure("ambiguous-target");
    return matches[0]!;
  } catch (error) {
    if (signal?.aborted) throw new BrowserFailure("cancelled");
    if (controller.signal.reason instanceof BrowserFailure) throw controller.signal.reason;
    if (error instanceof BrowserFailure) throw error;
    throw new BrowserFailure("unavailable");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}

class CdpClient {
  private readonly socket: BrowserSocket;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private readonly events = new Map<string, Set<{ resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>>();
  private readonly abort = () => this.failAll(abortFailure(this.signal));
  private listening = false;

  constructor(
    url: string,
    createSocket: (url: string) => BrowserSocket,
    private readonly timeoutMs: number,
    private readonly signal?: AbortSignal,
  ) {
    this.socket = createSocket(url);
    signal?.addEventListener("abort", this.abort, { once: true });
  }

  async connect(): Promise<void> {
    if (this.socket.readyState === 1) { this.listen(); return; }
    await this.socketWait("open");
  }

  command(method: string, params: Readonly<Record<string, unknown>> = {}): Promise<unknown> {
    throwIfAborted(this.signal);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BrowserFailure("timeout"));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression: string, argument: Readonly<Record<string, unknown>>): Promise<unknown> {
    const response = await this.command("Runtime.evaluate", {
      expression: `(${expression})(${JSON.stringify(argument)})`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (!isRecord(response) || !isRecord(response.result)) throw new BrowserFailure("operation-failed");
    if (response.exceptionDetails !== undefined) throw new BrowserFailure("operation-failed");
    return response.result.value;
  }

  waitForEvent(method: string): {
    readonly promise: Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: Error }>;
    cancel(): void;
  } {
    let cancel = () => {};
    const pending = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.events.get(method)?.delete(waiter);
        reject(new BrowserFailure("timeout"));
      }, this.timeoutMs);
      const waiter = { resolve, reject, timer };
      const current = this.events.get(method) ?? new Set();
      current.add(waiter);
      this.events.set(method, current);
      cancel = () => {
        clearTimeout(timer);
        this.events.get(method)?.delete(waiter);
        resolve(undefined);
      };
    });
    // Observe rejection immediately. A disconnect or cancellation can reject
    // the CDP command and this event waiter in the same turn; the outcome
    // promise never rejects while the command path unwinds and closes the socket.
    const promise = pending.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error: error instanceof Error ? error : new BrowserFailure("disconnected") }),
    );
    return { promise, cancel };
  }

  close(): void {
    this.signal?.removeEventListener("abort", this.abort);
    this.failAll(new BrowserFailure("disconnected"));
    this.socket.close();
  }

  private socketWait(type: "open"): Promise<void> {
    return new Promise((resolve, reject) => {
      const opened = () => { cleanup(); this.listen(); resolve(); };
      const failed = () => { cleanup(); reject(new BrowserFailure("unavailable")); };
      const cancelled = () => { cleanup(); reject(abortFailure(this.signal)); };
      const cleanup = () => {
        clearTimeout(timer);
        this.socket.removeEventListener("open", opened);
        this.socket.removeEventListener("error", failed);
        this.signal?.removeEventListener("abort", cancelled);
      };
      const timer = setTimeout(() => { cleanup(); reject(new BrowserFailure("timeout")); }, this.timeoutMs);
      this.socket.addEventListener(type, opened, { once: true });
      this.socket.addEventListener("error", failed, { once: true });
      this.signal?.addEventListener("abort", cancelled, { once: true });
    });
  }

  private listen(): void {
    if (this.listening) return;
    this.listening = true;
    this.socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      if (event.data.length > MAX_PROTOCOL_MESSAGE_LENGTH) {
        this.failAll(new BrowserFailure("invalid-response"));
        return;
      }
      let message: CdpResponse;
      try { message = JSON.parse(event.data) as CdpResponse; } catch { return; }
      if (typeof message.id === "number") {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error !== undefined) pending.reject(new BrowserFailure("operation-failed"));
        else pending.resolve(message.result);
      } else if (typeof message.method === "string") {
        const waiters = this.events.get(message.method);
        if (!waiters) return;
        this.events.delete(message.method);
        for (const waiter of waiters) { clearTimeout(waiter.timer); waiter.resolve(message.result); }
      }
    });
    const disconnected = () => this.failAll(new BrowserFailure("disconnected"));
    this.socket.addEventListener("close", disconnected, { once: true });
    this.socket.addEventListener("error", disconnected, { once: true });
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    for (const waiters of this.events.values()) {
      for (const waiter of waiters) { clearTimeout(waiter.timer); waiter.reject(error); }
    }
    this.events.clear();
  }
}

function pageFunction(type: "read_text" | "click" | "fill"): string {
  if (type === "read_text") return `({selector}) => { const element = document.querySelector(selector); if (!element) throw new Error("missing"); return element.textContent ?? ""; }`;
  if (type === "click") return `({selector}) => { const element = document.querySelector(selector); if (!(element instanceof HTMLElement)) throw new Error("missing"); element.click(); return true; }`;
  return `({selector,value}) => { const element = document.querySelector(selector); if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) throw new Error("invalid"); element.focus(); element.value = value; element.dispatchEvent(new Event("input", {bubbles:true})); element.dispatchEvent(new Event("change", {bubbles:true})); return true; }`;
}

function validateLoopbackEndpoint(value: string): URL {
  let endpoint: URL;
  try { endpoint = new URL(value); } catch { throw new BrowserFailure("invalid-endpoint"); }
  if (endpoint.protocol !== "http:"
    || !new Set(["127.0.0.1", "[::1]", "localhost"]).has(endpoint.hostname)
    || endpoint.username !== "" || endpoint.password !== ""
    || endpoint.pathname !== "/" || endpoint.search !== "" || endpoint.hash !== "") {
    throw new BrowserFailure("invalid-endpoint");
  }
  return endpoint;
}

function validateNavigationUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new BrowserFailure("invalid-request");
  return url.href;
}

function isAllowedSocketUrl(value: unknown, endpoint: URL): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (url.protocol === "ws:" || url.protocol === "wss:") && url.hostname === endpoint.hostname && url.port === endpoint.port;
  } catch { return false; }
}

function selectTargets(targets: readonly CdpTarget[], selector: BrowserTargetSelector | undefined): readonly CdpTarget[] {
  if (selector === undefined) return targets;
  if ("targetId" in selector) return targets.filter((target) => target.id === selector.targetId);
  if ("urlContains" in selector) return targets.filter((target) => target.url.includes(selector.urlContains));
  return targets.filter((target) => target.title.includes(selector.titleContains));
}

async function readBoundedResponse(response: Response, controller: AbortController): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PROTOCOL_MESSAGE_LENGTH) {
        const failure = new BrowserFailure("invalid-response");
        controller.abort(failure);
        await reader.cancel(failure).catch(() => {});
        throw failure;
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function signalFromExtra(extra: unknown): AbortSignal | undefined {
  return isRecord(extra) && isAbortSignal(extra.signal) ? extra.signal : undefined;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return isRecord(value) && typeof value.aborted === "boolean" && typeof value.addEventListener === "function";
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortFailure(signal);
}

function abortFailure(signal?: AbortSignal): Error {
  return new BrowserFailure(signal?.aborted ? "cancelled" : "disconnected");
}

class BrowserFailure extends Error {
  constructor(readonly code: string) { super(code); }
}

function browserErrorMessage(error: unknown): string {
  const code = error instanceof BrowserFailure ? error.code : "operation-failed";
  switch (code) {
    case "cancelled": return "Browser operation cancelled.";
    case "timeout": return "Chrome did not respond before the browser operation timed out.";
    case "invalid-endpoint": return "The browser helper is restricted to its loopback Chrome endpoint.";
    case "invalid-request": return "The browser request is not supported.";
    case "no-page": return "No attachable Chrome page is available.";
    case "ambiguous-target": return "More than one Chrome page matches the browser target selection.";
    case "navigation-failed": return "Chrome could not reach the requested page.";
    case "invalid-response": return "Chrome returned an invalid browser discovery response.";
    case "unavailable": return "Chrome is not available at the browser helper endpoint.";
    case "disconnected": return "Chrome disconnected during the browser operation.";
    default: return "The browser operation failed.";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
