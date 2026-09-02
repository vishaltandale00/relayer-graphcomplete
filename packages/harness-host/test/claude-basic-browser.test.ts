import { describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import { z } from "zod";
import {
  CLAUDE_BROWSER_TOOL,
  createClaudeBasicBrowserServer,
  type ClaudeBrowserSdk,
  type ClaudeBrowserToolResult,
} from "../src/implementations/claude-basic-browser.js";

type ToolHandler = (input: {
  target?: Record<string, unknown>;
  operations: readonly Record<string, unknown>[];
}, extra: unknown) => Promise<ClaudeBrowserToolResult>;

class FakeSocket {
  readonly sent: Record<string, unknown>[] = [];
  closed = false;
  respond = true;
  stallNavigate = false;
  navigateErrorText: string | undefined;
  navigationCompletion: "cross-document" | "same-document" | "unrelated-load" = "cross-document";
  evaluateExpression: ((expression: string) => { readonly value?: unknown; readonly exception?: boolean }) | undefined;
  private readonly listeners = new Map<string, Set<(event: { data?: unknown }) => void>>();

  constructor(readonly readyState = 1) {}

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    const request = JSON.parse(data) as { id: number; method: string; params?: Record<string, unknown> };
    this.sent.push(request);
    if (!this.respond) return;
    if (request.method === "Page.navigate") {
      if (this.stallNavigate) return;
      if (this.navigationCompletion === "same-document") {
        this.emit("message", { data: JSON.stringify({
          method: "Page.navigatedWithinDocument",
          params: { frameId: "frame", url: request.params?.url, navigationType: "fragment" },
        }) });
        this.emit("message", { data: JSON.stringify({ id: request.id, result: { frameId: "frame" } }) });
        return;
      }
      if (this.navigationCompletion === "unrelated-load") {
        this.emitProtocol("Page.lifecycleEvent", { frameId: "frame", loaderId: "old-loader", name: "load" });
      }
      this.emit("message", { data: JSON.stringify({
        id: request.id,
        result: { frameId: "frame", loaderId: "new-loader", ...(this.navigateErrorText === undefined ? {} : { errorText: this.navigateErrorText }) },
      }) });
      if (this.navigationCompletion === "cross-document") {
        queueMicrotask(() => this.emitProtocol("Page.lifecycleEvent", { frameId: "frame", loaderId: "new-loader", name: "load" }));
      }
      return;
    }
    if (request.method === "Runtime.evaluate") {
      const expression = String(request.params?.expression);
      const evaluated = this.evaluateExpression?.(expression);
      const marker = "existing-session-marker";
      const result = {
        result: {
          value: evaluated?.value ?? (expression.includes("textContent")
            ? { text: marker, originalLength: marker.length }
            : true),
        },
        ...(evaluated?.exception ? { exceptionDetails: {} } : {}),
      };
      this.emit("message", { data: JSON.stringify({ id: request.id, result }) });
      return;
    }
    const result = {};
    this.emit("message", { data: JSON.stringify({ id: request.id, result }) });
  }

  close(): void {
    this.closed = true;
    this.emit("close", {});
  }

  emitProtocol(method: string, params: Record<string, unknown>): void {
    this.emit("message", { data: JSON.stringify({ method, params }) });
  }

  private emit(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class DomHTMLElement {
  disabled = false;
  readOnly = false;
  ariaDisabled = false;
  textContent: string | null = null;
  clickCount = 0;
  readonly events: string[] = [];
  onDispatch: ((type: string) => void) | undefined;

  matches(selector: string): boolean {
    return selector === ":disabled" && this.disabled;
  }

  getAttribute(name: string): string | null {
    return name === "aria-disabled" && this.ariaDisabled ? "true" : null;
  }

  click(): void { this.clickCount += 1; }
  focus(): void {}
  dispatchEvent(event: { readonly type: string }): boolean {
    this.events.push(event.type);
    this.onDispatch?.(event.type);
    return true;
  }
}

class DomInputElement extends DomHTMLElement {
  private currentValue = "";
  type = "text";
  get value(): string { return this.currentValue; }
  set value(value: string) {
    this.currentValue = this.type === "number" && value !== "" && !Number.isFinite(Number(value)) ? "" : value;
  }
}

class DomTextAreaElement extends DomInputElement {}

class DomEvent {
  constructor(readonly type: string, readonly options: unknown) {}
}

function evaluateInDom(expression: string, element: DomHTMLElement): { readonly value?: unknown; readonly exception?: boolean } {
  try {
    return {
      value: runInNewContext(expression, {
        document: { querySelector: () => element },
        HTMLElement: DomHTMLElement,
        HTMLInputElement: DomInputElement,
        HTMLTextAreaElement: DomTextAreaElement,
        Event: DomEvent,
      }),
    };
  } catch {
    return { exception: true };
  }
}

function fixture(options: {
  endpoint?: string;
  socket?: FakeSocket;
  targets?: readonly Record<string, unknown>[];
  fetch?: typeof globalThis.fetch;
  createWebSocket?: (url: string, socket: FakeSocket) => FakeSocket;
  timeoutMs?: number;
} = {}): {
  handler: ToolHandler;
  socket: FakeSocket;
  socketUrls: string[];
  server: unknown;
  inputSchema: Parameters<ClaudeBrowserSdk["tool"]>[2];
} {
  let handler: ToolHandler | undefined;
  let inputSchema: Parameters<ClaudeBrowserSdk["tool"]>[2] | undefined;
  let fullName = "";
  const sdk: ClaudeBrowserSdk = {
    tool: ((name: string, _description: string, schema: Parameters<ClaudeBrowserSdk["tool"]>[2], candidate: ToolHandler) => {
      fullName = `mcp__relayer_browser__${name}`;
      inputSchema = schema;
      handler = candidate;
      return { name };
    }) as ClaudeBrowserSdk["tool"],
    createSdkMcpServer: ((input: unknown) => input) as ClaudeBrowserSdk["createSdkMcpServer"],
  };
  const socket = options.socket ?? new FakeSocket();
  const socketUrls: string[] = [];
  const endpoint = options.endpoint ?? "http://127.0.0.1:9333";
  const server = createClaudeBasicBrowserServer(sdk, {
    cdpEndpoint: endpoint,
    fetch: options.fetch ?? vi.fn(async () => new Response(JSON.stringify(options.targets ?? [{
      id: "existing-page",
      type: "page",
      title: "Existing page",
      url: "https://existing.test/marker",
      webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/existing-page",
    }]), { status: 200 })),
    createWebSocket: (url) => { socketUrls.push(url); return options.createWebSocket?.(url, socket) ?? socket; },
    timeoutMs: options.timeoutMs ?? 100,
  });
  expect(fullName).toBe(CLAUDE_BROWSER_TOOL);
  if (!handler) throw new Error("tool handler was not registered");
  if (!inputSchema) throw new Error("tool input schema was not registered");
  return { handler, socket, socketUrls, server, inputSchema };
}

describe("claude.basic browser MCP tool", () => {
  it("attaches to a uniquely selected page and runs bounded batches without launching Chrome", async () => {
    expect(() => fixture({ endpoint: "http://example.test:9222" }), "non-loopback dependency override").toThrow(/invalid-endpoint/);

    const targets = [
      { id: "private", type: "page", title: "Private", url: "https://private.test/", webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/private" },
      { id: "marker", type: "page", title: "Benign marker", url: "https://example.test/marker", webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/marker" },
    ];
    const ambiguous = fixture({ targets });
    await expect(ambiguous.handler({ operations: [{ type: "read_text" }] }, {}), "ambiguous target selection").resolves.toMatchObject({
      isError: true,
      content: [{ text: "More than one Chrome page matches the browser target selection." }],
    });
    expect(ambiguous.socket.sent, "ambiguous selection opens no socket traffic").toHaveLength(0);

    const selected = fixture({ targets });
    await expect(selected.handler({
      target: { targetId: "marker" },
      operations: [{ type: "read_text", selector: "#marker" }],
    }, {}), "explicit target id").resolves.not.toHaveProperty("isError");
    expect(selected.socket.sent, "selected page traffic").toHaveLength(1);
    expect(selected.socketUrls, "selected page socket").toEqual(["ws://127.0.0.1:9333/devtools/page/marker"]);

    const absent = fixture({ targets });
    await expect(absent.handler({
      target: { urlContains: "missing.test" },
      operations: [{ type: "read_text" }],
    }, {}), "absent url filter").resolves.toMatchObject({ isError: true, content: [{ text: "No attachable Chrome page is available." }] });

    const bound = fixture({
      targets: [{
        id: "marker",
        type: "page",
        title: "Benign marker",
        url: "https://example.test/marker",
        webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/private",
      }],
    });
    await expect(bound.handler({
      target: { targetId: "marker" },
      operations: [{ type: "read_text" }],
    }, {}), "discovery metadata bound to the exact page socket").resolves.toMatchObject({
      isError: true,
      content: [{ text: "No attachable Chrome page is available." }],
    });
    expect(bound.socketUrls, "mismatched metadata opens no socket").toHaveLength(0);
    expect(bound.socket.sent, "mismatched metadata sends nothing").toHaveLength(0);

    const { handler, socket, server } = fixture();
    const result = await handler({ operations: [
      { type: "read_text", selector: "#marker" },
      { type: "navigate", url: "https://example.test/next" },
      { type: "click", selector: "#continue" },
    ] }, {});

    expect(result.isError, "bounded batch succeeds").toBeUndefined();
    expect(JSON.parse(result.content[0]!.text), "bounded batch results").toMatchObject({ operations: [
      { type: "read_text", text: "existing-session-marker", truncated: false },
      { type: "navigate", url: "https://example.test/next" },
      { type: "click", clicked: true },
    ] });
    expect(socket.sent.map((entry) => entry.method), "exact CDP sequence").toEqual([
      "Runtime.evaluate", "Page.enable", "Page.setLifecycleEventsEnabled", "Page.navigate", "Runtime.evaluate",
    ]);
    expect(socket.closed, "socket closed after the batch").toBe(true);
    expect(server, "server metadata").toMatchObject({
      name: "relayer_browser",
      version: "1.0.0",
      instructions: expect.stringContaining("Click and fill must be final"),
    });
  });

  it("waits only for the requested navigation and reports CDP failures honestly", async () => {
    const errored = new FakeSocket();
    errored.navigateErrorText = "net::ERR_CONNECTION_REFUSED private-upstream.test";
    const failedNavigation = fixture({ socket: errored });

    const failed = await failedNavigation.handler({ operations: [{ type: "navigate", url: "https://unavailable.test/" }] }, {});

    expect(failed, "CDP navigation error reported honestly").toMatchObject({ isError: true, content: [{ text: "Chrome could not reach the requested page." }] });
    expect(failed.content[0]!.text, "upstream details stay hidden").not.toContain("private-upstream");
    expect(errored.closed, "socket closed after navigation failure").toBe(true);

    const sameDocumentSocket = new FakeSocket();
    sameDocumentSocket.navigationCompletion = "same-document";
    const sameDocument = fixture({ socket: sameDocumentSocket });

    const fragmentResult = await sameDocument.handler({ operations: [
      { type: "navigate", url: "https://existing.test/marker#details" },
      { type: "read_text", selector: "body" },
    ] }, {});

    expect(fragmentResult.isError, "same-document navigation succeeds").toBeUndefined();
    expect(sameDocumentSocket.sent.map((entry) => entry.method), "same-document navigation skips load waiting").toEqual([
      "Page.enable", "Page.setLifecycleEventsEnabled", "Page.navigate", "Runtime.evaluate",
    ]);
    expect(sameDocumentSocket.closed, "socket closed after same-document navigation").toBe(true);

    const unrelatedSocket = new FakeSocket();
    unrelatedSocket.navigationCompletion = "unrelated-load";
    const unrelated = fixture({ socket: unrelatedSocket, timeoutMs: 1_000 });
    const operation = unrelated.handler({ operations: [
      { type: "navigate", url: "https://example.test/requested" },
      { type: "read_text", selector: "body" },
    ] }, {});

    await vi.waitFor(() => expect(unrelatedSocket.sent.map((entry) => entry.method)).toContain("Page.navigate"));
    await Promise.resolve();
    expect(unrelatedSocket.sent.map((entry) => entry.method), "unrelated load does not release the follow-up read").not.toContain("Runtime.evaluate");

    unrelatedSocket.emitProtocol("Page.lifecycleEvent", { frameId: "frame", loaderId: "new-loader", name: "load" });
    await expect(operation, "requested loader completion releases the batch").resolves.not.toHaveProperty("isError");
    expect(unrelatedSocket.sent.map((entry) => entry.method), "follow-up read runs after the requested loader").toContain("Runtime.evaluate");
    expect(unrelatedSocket.closed, "socket closed after the requested loader").toBe(true);
  });

  it("enforces terminal click and fill and reports DOM failures honestly", async () => {
    const terminalRequests = [
      ["click must be terminal", { operations: [{ type: "click", selector: "#continue" }, { type: "read_text", selector: "body" }] }],
      ["fill must be terminal", { operations: [{ type: "fill", selector: "#name", value: "Ada" }, { type: "read_text", selector: "body" }] }],
    ] as const;
    expect(terminalRequests, "terminal request inventory").toHaveLength(2);
    for (const [label, request] of terminalRequests) {
      const { handler, inputSchema, socket } = fixture();
      expect(z.object(inputSchema).safeParse(request), `${label} schema`).toMatchObject({ success: false });
      await expect(handler(request, {}), label).resolves.toMatchObject({
        isError: true,
        content: [{ text: "The browser request is not supported." }],
      });
      expect(socket.sent, `${label} sends nothing`).toHaveLength(0);
    }

    const navigatingSocket = new FakeSocket();
    const navigatingInput = new DomInputElement();
    let navigationTriggered = false;
    navigatingInput.onDispatch = () => {
      navigationTriggered = true;
      navigatingSocket.emitProtocol("Page.frameNavigated", { frame: { id: "replacement-frame" } });
    };
    navigatingSocket.evaluateExpression = (expression) => evaluateInDom(expression, navigatingInput);
    const navigating = fixture({ socket: navigatingSocket });

    await expect(navigating.handler({
      operations: [{ type: "fill", selector: "#name", value: "Ada" }],
    }, {}), "fill whose DOM events navigate").resolves.not.toHaveProperty("isError");
    expect(navigationTriggered, "fill dispatched DOM events").toBe(true);
    expect(navigatingSocket.sent.map((entry) => entry.method), "no command follows a fill-triggered navigation").toEqual(["Runtime.evaluate"]);
    expect(navigatingSocket.closed, "socket closed after fill-triggered navigation").toBe(true);

    const filledSocket = new FakeSocket();
    const input = new DomInputElement();
    let interceptedAssignments = 0;
    Object.defineProperty(input, "value", {
      configurable: true,
      get() { return Reflect.get(DomInputElement.prototype, "value", this); },
      set() { interceptedAssignments += 1; },
    });
    filledSocket.evaluateExpression = (expression) => evaluateInDom(expression, input);
    const filled = fixture({ socket: filledSocket });

    const fillResult = await filled.handler({ operations: [{ type: "fill", selector: "#name", value: "Ada" }] }, {});

    expect(fillResult.isError, "native setter fill succeeds").toBeUndefined();
    expect(input.value, "fill value verified").toBe("Ada");
    expect(interceptedAssignments, "native value setter used").toBe(0);
    expect(input.events, "fill dispatches input and change").toEqual(["input", "change"]);

    const failureCases: readonly {
      label: string;
      hidden: string;
      request: { operations: readonly Record<string, unknown>[] };
      build: () => { socket: FakeSocket; verify: () => void };
    }[] = [
      {
        label: "disabled control is never clicked",
        hidden: "#disabled",
        request: { operations: [{ type: "click", selector: "#disabled" }] },
        build: () => {
          const socket = new FakeSocket();
          const button = new DomHTMLElement();
          button.disabled = true;
          socket.evaluateExpression = (expression) => evaluateInDom(expression, button);
          return { socket, verify: () => expect(button.clickCount, "disabled control click count").toBe(0) };
        },
      },
      {
        label: "framework handling that rewrites the fill value",
        hidden: "framework-normalized",
        request: { operations: [{ type: "fill", selector: "#name", value: "Ada" }] },
        build: () => {
          const socket = new FakeSocket();
          const rewritten = new DomInputElement();
          rewritten.onDispatch = (type) => { if (type === "input") rewritten.value = "framework-normalized"; };
          socket.evaluateExpression = (expression) => evaluateInDom(expression, rewritten);
          return {
            socket,
            verify: () => {
              expect(rewritten.value, "framework-normalized value observed").toBe("framework-normalized");
            },
          };
        },
      },
      {
        label: "number input sanitizer empties the fill value",
        hidden: "not-a-number",
        request: { operations: [{ type: "fill", selector: "#age", value: "not-a-number" }] },
        build: () => {
          const socket = new FakeSocket();
          const numberInput = new DomInputElement();
          numberInput.type = "number";
          socket.evaluateExpression = (expression) => evaluateInDom(expression, numberInput);
          return { socket, verify: () => expect(numberInput.value, "sanitized number value").toBe("") };
        },
      },
    ];
    expect(failureCases, "DOM failure inventory").toHaveLength(3);
    for (const { label, hidden, request, build } of failureCases) {
      const { socket, verify } = build();
      const failedCase = fixture({ socket });
      const result = await failedCase.handler(request, {});
      expect(result, label).toMatchObject({ isError: true, content: [{ text: "The browser operation failed." }] });
      expect(result.content[0]!.text, `${label} hides page details`).not.toContain(hidden);
      verify();
      expect(socket.closed, `${label} closes the socket`).toBe(true);
    }

    const truncatedSocket = new FakeSocket();
    const element = new DomHTMLElement();
    element.textContent = "\u0000\"\\\n".repeat(100_000);
    truncatedSocket.evaluateExpression = (expression) => evaluateInDom(expression, element);
    const truncated = fixture({ socket: truncatedSocket });

    const truncatedResult = await truncated.handler({ operations: [{ type: "read_text", selector: "#large" }] }, {});

    expect(truncatedResult.isError, "truncated read succeeds").toBeUndefined();
    expect(JSON.parse(truncatedResult.content[0]!.text), "highly escaped text truncated before serialization").toEqual({ operations: [{
      type: "read_text",
      text: element.textContent.slice(0, 20_000),
      truncated: true,
    }] });
    expect(truncatedSocket.closed, "socket closed after truncated read").toBe(true);
  });

  it("cancels cleanly and hides Chrome discovery failures", async () => {
    const stalledSocket = new FakeSocket();
    stalledSocket.respond = false;
    const stalled = fixture({ socket: stalledSocket });
    const toolController = new AbortController();
    const toolOperation = stalled.handler({ operations: [{ type: "read_text", selector: "body" }] }, { signal: toolController.signal });
    await vi.waitFor(() => expect(stalledSocket.sent).toHaveLength(1));
    toolController.abort(new Error("stop"));

    await expect(toolOperation, "SDK cancellation of the enclosing tool").resolves.toMatchObject({
      isError: true,
      content: [{ text: "Browser operation cancelled." }],
    });
    expect(stalledSocket.closed, "socket closed on tool cancellation").toBe(true);

    const constructionController = new AbortController();
    const constructionSocket = new FakeSocket(0);
    const construction = fixture({
      socket: constructionSocket,
      createWebSocket: (_url, created) => {
        constructionController.abort(new Error("cancel during socket construction"));
        return created;
      },
    });

    await expect(construction.handler({ operations: [{ type: "read_text" }] }, { signal: constructionController.signal }), "abort during socket creation").resolves.toMatchObject({
      isError: true,
      content: [{ text: "Browser operation cancelled." }],
    });
    expect(constructionSocket.closed, "socket closed after construction abort").toBe(true);
    expect(constructionSocket.sent, "no traffic after construction abort").toHaveLength(0);

    const navigationSocket = new FakeSocket();
    navigationSocket.stallNavigate = true;
    const navigationCancellation = fixture({ socket: navigationSocket });
    const navigationController = new AbortController();
    const navigationOperation = navigationCancellation.handler({ operations: [{ type: "navigate", url: "https://example.test/slow" }] }, { signal: navigationController.signal });
    await vi.waitFor(() => expect(navigationSocket.sent.map((entry) => entry.method)).toContain("Page.navigate"));
    navigationController.abort(new Error("cancel navigation"));

    await expect(navigationOperation, "abort while navigation waiters are pending").resolves.toMatchObject({
      isError: true,
      content: [{ text: "Browser operation cancelled." }],
    });
    expect(navigationSocket.closed, "socket closed on navigation cancellation").toBe(true);

    let discoveryHandler: ToolHandler | undefined;
    const sdk: ClaudeBrowserSdk = {
      tool: ((_name: string, _description: string, _schema: unknown, candidate: ToolHandler) => {
        discoveryHandler = candidate;
        return {};
      }) as ClaudeBrowserSdk["tool"],
      createSdkMcpServer: ((input: unknown) => input) as ClaudeBrowserSdk["createSdkMcpServer"],
    };
    createClaudeBasicBrowserServer(sdk, {
      fetch: vi.fn(async () => new Response("private browser details", { status: 503 })),
    });
    if (!discoveryHandler) throw new Error("tool handler was not registered");

    const unavailable = await discoveryHandler({ operations: [{ type: "read_text" }] }, {});
    expect(unavailable, "Chrome discovery failure reported honestly").toMatchObject({ isError: true, content: [{ text: "Chrome is not available at the browser helper endpoint." }] });
    expect(unavailable.content[0]!.text, "discovery failure hides response details").not.toContain("private browser details");
    expect(unavailable.content[0]!.text, "discovery failure hides endpoint details").not.toContain("9222");

    let discoverySignal: AbortSignal | undefined;
    const chunk = new Uint8Array(600_000);
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      discoverySignal = init?.signal instanceof AbortSignal ? init.signal : undefined;
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(chunk);
          controller.enqueue(chunk);
          controller.close();
        },
      }));
    }) as typeof globalThis.fetch;
    const capped = fixture({ fetch: fetchImpl });

    const cappedResult = await capped.handler({ operations: [{ type: "read_text" }] }, {});

    expect(cappedResult, "oversized discovery response fails closed").toMatchObject({
      isError: true,
      content: [{ text: "Chrome returned an invalid browser discovery response." }],
    });
    expect(discoverySignal?.aborted, "discovery fetch aborted at the byte cap").toBe(true);
    expect(capped.socket.sent, "no page traffic after capped discovery").toHaveLength(0);
  });
});
