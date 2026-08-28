import { describe, expect, it, vi } from "vitest";
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
      this.emit("message", { data: JSON.stringify({
        id: request.id,
        result: { frameId: "frame", ...(this.navigateErrorText === undefined ? {} : { errorText: this.navigateErrorText }) },
      }) });
      queueMicrotask(() => this.emit("message", { data: JSON.stringify({ method: "Page.loadEventFired", result: {} }) }));
      return;
    }
    const result = request.method === "Runtime.evaluate"
      ? { result: { value: String(request.params?.expression).includes("textContent") ? "existing-session-marker" : true } }
      : {};
    this.emit("message", { data: JSON.stringify({ id: request.id, result }) });
  }

  close(): void {
    this.closed = true;
    this.emit("close", {});
  }

  private emit(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function fixture(options: {
  endpoint?: string;
  socket?: FakeSocket;
  targets?: readonly Record<string, unknown>[];
  fetch?: typeof globalThis.fetch;
  createWebSocket?: (url: string, socket: FakeSocket) => FakeSocket;
} = {}): {
  handler: ToolHandler;
  socket: FakeSocket;
  socketUrls: string[];
  server: unknown;
} {
  let handler: ToolHandler | undefined;
  let fullName = "";
  const sdk: ClaudeBrowserSdk = {
    tool: ((name: string, _description: string, _schema: unknown, candidate: ToolHandler) => {
      fullName = `mcp__relayer_browser__${name}`;
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
    timeoutMs: 100,
  });
  expect(fullName).toBe(CLAUDE_BROWSER_TOOL);
  if (!handler) throw new Error("tool handler was not registered");
  return { handler, socket, socketUrls, server };
}

describe("claude.basic browser MCP tool", () => {
  it("attaches to an existing page and executes a bounded batch without launching or stopping Chrome", async () => {
    const { handler, socket, server } = fixture();
    const result = await handler({ operations: [
      { type: "read_text", selector: "#marker" },
      { type: "navigate", url: "https://example.test/next" },
      { type: "click", selector: "#continue" },
      { type: "fill", selector: "#name", value: "Ada" },
    ] }, {});

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ operations: [
      { type: "read_text", text: "existing-session-marker" },
      { type: "navigate", url: "https://example.test/next" },
      { type: "click", clicked: true },
      { type: "fill", filled: true },
    ] });
    expect(socket.sent.map((entry) => entry.method)).toEqual([
      "Runtime.evaluate", "Page.enable", "Page.navigate", "Runtime.evaluate", "Runtime.evaluate",
    ]);
    expect(socket.closed).toBe(true);
    expect(server).toMatchObject({ name: "relayer_browser", version: "1.0.0" });
  });

  it("rejects a non-loopback dependency override before creating a tool", () => {
    expect(() => fixture({ endpoint: "http://example.test:9222" })).toThrow(/invalid-endpoint/);
  });

  it("reports a CDP navigation error instead of claiming the page was reached", async () => {
    const socket = new FakeSocket();
    socket.navigateErrorText = "net::ERR_CONNECTION_REFUSED private-upstream.test";
    const { handler } = fixture({ socket });

    const result = await handler({ operations: [{ type: "navigate", url: "https://unavailable.test/" }] }, {});

    expect(result).toMatchObject({ isError: true, content: [{ text: "Chrome could not reach the requested page." }] });
    expect(result.content[0]!.text).not.toContain("private-upstream");
    expect(socket.closed).toBe(true);
  });

  it("requires a unique explicit target when Chrome exposes multiple pages", async () => {
    const targets = [
      { id: "private", type: "page", title: "Private", url: "https://private.test/", webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/private" },
      { id: "marker", type: "page", title: "Benign marker", url: "https://example.test/marker", webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/marker" },
    ];
    const ambiguous = fixture({ targets });
    await expect(ambiguous.handler({ operations: [{ type: "read_text" }] }, {})).resolves.toMatchObject({
      isError: true,
      content: [{ text: "More than one Chrome page matches the browser target selection." }],
    });
    expect(ambiguous.socket.sent).toHaveLength(0);

    const selected = fixture({ targets });
    await expect(selected.handler({
      target: { targetId: "marker" },
      operations: [{ type: "read_text", selector: "#marker" }],
    }, {})).resolves.not.toHaveProperty("isError");
    expect(selected.socket.sent).toHaveLength(1);
    expect(selected.socketUrls).toEqual(["ws://127.0.0.1:9333/devtools/page/marker"]);

    const absent = fixture({ targets });
    await expect(absent.handler({
      target: { urlContains: "missing.test" },
      operations: [{ type: "read_text" }],
    }, {})).resolves.toMatchObject({ isError: true, content: [{ text: "No attachable Chrome page is available." }] });
  });

  it("binds selected discovery metadata to the exact page socket", async () => {
    const { handler, socket, socketUrls } = fixture({
      targets: [{
        id: "marker",
        type: "page",
        title: "Benign marker",
        url: "https://example.test/marker",
        webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/private",
      }],
    });

    await expect(handler({
      target: { targetId: "marker" },
      operations: [{ type: "read_text" }],
    }, {})).resolves.toMatchObject({
      isError: true,
      content: [{ text: "No attachable Chrome page is available." }],
    });
    expect(socketUrls).toHaveLength(0);
    expect(socket.sent).toHaveLength(0);
  });

  it("closes its CDP socket when the SDK cancels the enclosing native tool", async () => {
    const socket = new FakeSocket();
    socket.respond = false;
    const { handler } = fixture({ socket });
    const controller = new AbortController();
    const operation = handler({ operations: [{ type: "read_text", selector: "body" }] }, { signal: controller.signal });
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    controller.abort(new Error("stop"));

    await expect(operation).resolves.toMatchObject({
      isError: true,
      content: [{ text: "Browser operation cancelled." }],
    });
    expect(socket.closed).toBe(true);
  });

  it("reports prompt cancellation when the signal aborts during socket creation", async () => {
    const controller = new AbortController();
    const socket = new FakeSocket(0);
    const { handler } = fixture({
      socket,
      createWebSocket: (_url, created) => {
        controller.abort(new Error("cancel during socket construction"));
        return created;
      },
    });

    await expect(handler({ operations: [{ type: "read_text" }] }, { signal: controller.signal })).resolves.toMatchObject({
      isError: true,
      content: [{ text: "Browser operation cancelled." }],
    });
    expect(socket.closed).toBe(true);
    expect(socket.sent).toHaveLength(0);
  });

  it("observes both navigation waiters and closes the socket when navigation is cancelled", async () => {
    const socket = new FakeSocket();
    socket.stallNavigate = true;
    const { handler } = fixture({ socket });
    const controller = new AbortController();
    const operation = handler({ operations: [{ type: "navigate", url: "https://example.test/slow" }] }, { signal: controller.signal });
    await vi.waitFor(() => expect(socket.sent.map((entry) => entry.method)).toContain("Page.navigate"));
    controller.abort(new Error("cancel navigation"));

    await expect(operation).resolves.toMatchObject({
      isError: true,
      content: [{ text: "Browser operation cancelled." }],
    });
    expect(socket.closed).toBe(true);
  });

  it("reports Chrome discovery failures without returning endpoint or response details", async () => {
    let handler: ToolHandler | undefined;
    const sdk: ClaudeBrowserSdk = {
      tool: ((_name: string, _description: string, _schema: unknown, candidate: ToolHandler) => {
        handler = candidate;
        return {};
      }) as ClaudeBrowserSdk["tool"],
      createSdkMcpServer: ((input: unknown) => input) as ClaudeBrowserSdk["createSdkMcpServer"],
    };
    createClaudeBasicBrowserServer(sdk, {
      fetch: vi.fn(async () => new Response("private browser details", { status: 503 })),
    });
    if (!handler) throw new Error("tool handler was not registered");

    const result = await handler({ operations: [{ type: "read_text" }] }, {});
    expect(result).toMatchObject({ isError: true, content: [{ text: "Chrome is not available at the browser helper endpoint." }] });
    expect(result.content[0]!.text).not.toContain("private browser details");
    expect(result.content[0]!.text).not.toContain("9222");
  });

  it("aborts a chunked discovery response as soon as it crosses the byte cap", async () => {
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
    const { handler, socket } = fixture({ fetch: fetchImpl });

    const result = await handler({ operations: [{ type: "read_text" }] }, {});

    expect(result).toMatchObject({
      isError: true,
      content: [{ text: "Chrome returned an invalid browser discovery response." }],
    });
    expect(discoverySignal?.aborted).toBe(true);
    expect(socket.sent).toHaveLength(0);
  });
});
