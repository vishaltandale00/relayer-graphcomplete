import { createServer, type IncomingMessage } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CodexBasicHarness } from "../src/implementations/codex-basic.js";
import { createNoopHarnessTraceSink } from "../src/trace.js";

const SYNTHETIC_API_KEY = "relayer-process-boundary-test-key";
const require = createRequire(import.meta.url);
const temporaryDirectories: string[] = [];
const nativeDarwinIt = process.platform === "darwin"
  && process.env.RELAYER_RUN_CODEX_SECRET_BOUNDARY === "1"
  ? it
  : it.skip;

describe("Codex secret-provider process boundary", () => {
  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  // Run this native-process boundary in isolation. Codex 0.147's shell-policy
  // behavior is not stable when many unrelated native tests execute in parallel,
  // and non-Darwin binaries are not evidence for the shipped macOS boundary.
  nativeDarwinIt("authenticates the selected Responses endpoint while excluding provider secrets from model-requested shell tools", async () => {
    const codexBinary = resolvePinnedCodexBinary();
    const codexHome = await mkdtemp(join(tmpdir(), "relayer-codex-secret-provider-"));
    temporaryDirectories.push(codexHome);
    const requestReceived = deferred<CapturedRequest>();
    const shellOutputReceived = deferred<string>();
    let requestNumber = 0;
    const server = createServer((request, response) => {
      void captureRequest(request).then((captured) => {
        requestNumber += 1;
        if (requestNumber === 1) {
          requestReceived.resolve(captured);
          respondWithEnvironmentProbe(response);
          return;
        }
        const shellOutput = functionCallOutput(captured.body);
        shellOutputReceived.resolve(shellOutput);
        respondWithFinalMessage(response);
      }, (error) => {
        if (requestNumber === 0) requestReceived.reject(error);
        else shellOutputReceived.reject(error);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Loopback provider did not expose a TCP port.");
    const endpoint = `http://127.0.0.1:${address.port}/v1`;
    const abort = new AbortController();
    const harness = new CodexBasicHarness({
      threadId: 1,
      permissionProfileId: "full",
      permissionBinding: { sandboxMode: "danger-full-access", approvalPolicy: "never" },
      workingDirectory: process.cwd(),
      configuration: {
        schemaVersion: 1,
        name: "codex-basic",
        implementation: "codex.basic",
        implementationVersion: 1,
        permissionBindings: {
          full: { sandboxMode: "danger-full-access", approvalPolicy: "never" },
        },
        settings: { skipGitRepoCheck: true },
      },
    });
    const inputGraph = {
      id: 1,
      kind: "user-interaction" as const,
      icon: "user" as const,
      title: "Question",
      detail: "Explain idempotency keys.",
      state: "accepted" as const,
    };
    const completion = harness.complete({
      inputGraph,
      interactionInput: { interaction: inputGraph, contexts: [] },
      origin: { kind: "root" },
      model: { providerId: "openai-test", adapterId: "openai-api", modelId: "gpt-test" },
      access: {
        kind: "secret",
        contract: "secret@1",
        providerId: "openai-test",
        adapterId: "openai-api",
        adapterImplementationVersion: "1",
        endpoint,
        fields: { "api-key": SYNTHETIC_API_KEY },
        runtime: {
          runtimeId: "codex",
          version: pinnedCodexVersion(),
          executable: codexBinary,
          environment: {
            CODEX_HOME: codexHome,
            RELAYER_CODEX_BINARY: codexBinary,
          },
        },
      },
      graph: {
        interactionNodeId: 1,
        acquireCapability: () => ({ url: "http://127.0.0.1:1", token: "graph-token", nodeId: 1 }),
      },
      approvals: { request: async () => { throw new Error("Approval was not expected."); } },
      trace: createNoopHarnessTraceSink(),
    }, abort.signal);

    try {
      const captured = await Promise.race([
        requestReceived.promise,
        new Promise<never>((_resolve, reject) => setTimeout(
          () => reject(new Error("Pinned Codex did not contact the loopback Responses provider.")),
          10_000,
        )),
      ]);
      expect(captured).toMatchObject({
        method: "POST",
        url: "/v1/responses",
        host: `127.0.0.1:${address.port}`,
        authorization: `Bearer ${SYNTHETIC_API_KEY}`,
      });
      expect(JSON.parse(captured.body)).toMatchObject({ model: "gpt-test", stream: true });
      const shellOutput = await Promise.race([
        shellOutputReceived.promise,
        new Promise<never>((_resolve, reject) => setTimeout(
          () => reject(new Error("Pinned Codex did not return the model-requested shell probe.")),
          10_000,
        )),
      ]);
      expect(shellOutput).toContain("OPENAI_API_KEY_ABSENT");
      expect(shellOutput).toContain("OPENAI_BASE_URL_ABSENT");
      expect(shellOutput).toContain("RELAYER_GRAPH_URL_PRESENT");
      expect(shellOutput).toContain("RELAYER_GRAPH_TOKEN_PRESENT");
      expect(shellOutput).toContain("RELAYER_NODE_ID_PRESENT");
      expect(shellOutput).not.toContain(SYNTHETIC_API_KEY);
      await expect(completion).resolves.toBeUndefined();
    } finally {
      abort.abort(new Error("Process-boundary test cleanup."));
      harness.forceShutdown();
      await completion.catch(() => undefined);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);

  nativeDarwinIt("uses the invoked child's fresh graph capability in a pinned-Codex shell after a parent completion", async () => {
    const codexBinary = resolvePinnedCodexBinary();
    const codexHome = await mkdtemp(join(tmpdir(), "relayer-codex-invoked-capability-"));
    temporaryDirectories.push(codexHome);
    const parentToken = "parent-capability-token";
    const childToken = "child-capability-token";
    const graphTokens = [parentToken, childToken] as const;
    const graphCapabilityUses: string[] = [];
    let graphRequestNumber = 0;
    const graphServer = createServer((request, response) => {
      const authorization = request.headers.authorization ?? "";
      graphRequestNumber += 1;
      graphCapabilityUses.push(authorization === `Bearer ${parentToken}`
        ? "parent"
        : authorization === `Bearer ${childToken}` ? "child" : "unknown");
      const expected = `Bearer ${graphTokens[graphRequestNumber - 1] ?? "unexpected"}`;
      if (request.method !== "GET" || request.url !== "/api/graph/input" || authorization !== expected) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { code: "invalid_capability" } }));
        return;
      }
      const nodeId = graphRequestNumber;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        interaction: {
          id: nodeId,
          kind: "user-interaction",
          icon: "user",
          title: nodeId === 1 ? "Parent" : "Invoked child",
          detail: "Read this interaction through the public graph client.",
          state: "accepted",
        },
        contexts: [],
      }));
    });
    await listenLoopback(graphServer);
    const graphAddress = graphServer.address();
    if (graphAddress === null || typeof graphAddress === "string") throw new Error("Loopback graph server did not expose a TCP port.");
    const graphUrl = `http://127.0.0.1:${graphAddress.port}`;

    const shellOutputs: string[] = [];
    let requestNumber = 0;
    const providerServer = createServer((request, response) => {
      void captureRequest(request).then((captured) => {
        requestNumber += 1;
        if (requestNumber % 2 === 1) {
          const expectedNodeId = (requestNumber + 1) / 2;
          respondWithGraphInputProbe(response, expectedNodeId);
          return;
        }
        shellOutputs.push(functionCallOutput(captured.body));
        respondWithFinalMessage(response);
      });
    });
    await listenLoopback(providerServer);
    const providerAddress = providerServer.address();
    if (providerAddress === null || typeof providerAddress === "string") throw new Error("Loopback provider did not expose a TCP port.");
    const endpoint = `http://127.0.0.1:${providerAddress.port}/v1`;
    await writeFile(join(codexHome, "config.toml"), [
      'model_provider = "relayer_loopback"',
      "[model_providers.relayer_loopback]",
      'name = "Relayer loopback test provider"',
      `base_url = ${JSON.stringify(endpoint)}`,
      'wire_api = "responses"',
      "requires_openai_auth = false",
      "supports_websockets = false",
      "",
    ].join("\n"));
    const harness = new CodexBasicHarness({
      threadId: 1,
      permissionProfileId: "full",
      permissionBinding: { sandboxMode: "danger-full-access", approvalPolicy: "never" },
      workingDirectory: process.cwd(),
      configuration: {
        schemaVersion: 1,
        name: "codex-basic",
        implementation: "codex.basic",
        implementationVersion: 1,
        permissionBindings: {
          full: { sandboxMode: "danger-full-access", approvalPolicy: "never" },
        },
        settings: { skipGitRepoCheck: true },
      },
    });
    const access = {
      kind: "managed-runtime" as const,
      contract: "managed-runtime@1" as const,
      providerId: "codex",
      adapterId: "codex-subscription",
      adapterImplementationVersion: "1",
      runtimeId: "codex",
      version: pinnedCodexVersion(),
      executable: codexBinary,
      environment: {
        CODEX_HOME: codexHome,
        RELAYER_CODEX_BINARY: codexBinary,
      },
    };
    const model = { providerId: "codex", adapterId: "codex-subscription", modelId: "gpt-test" };
    const inputGraph = (id: number, title: string) => ({
      id,
      kind: "user-interaction" as const,
      icon: "user" as const,
      title,
      detail: "Read this interaction through the public graph client.",
      state: "accepted" as const,
    });
    const complete = (id: number, token: string, origin: { kind: "root" } | { kind: "invoke"; sourceCompletionId: number; actionId: number }) => {
      const input = inputGraph(id, id === 1 ? "Parent" : "Invoked child");
      return harness.complete({
        inputGraph: input,
        interactionInput: { interaction: input, contexts: [] },
        origin,
        model,
        access,
        graph: {
          interactionNodeId: id,
          acquireCapability: () => ({ url: graphUrl, token, nodeId: id }),
        },
        approvals: { request: async () => { throw new Error("Approval was not expected."); } },
        trace: createNoopHarnessTraceSink(),
      });
    };
    try {
      await complete(1, parentToken, { kind: "root" });
      await complete(2, childToken, { kind: "invoke", sourceCompletionId: 1, actionId: 102 });

      expect(shellOutputs).toHaveLength(2);
      expect(shellOutputs[0]).toContain("GRAPH_INPUT_NODE_1_OK");
      expect(shellOutputs[1]).toContain("GRAPH_INPUT_NODE_2_OK");
      expect(shellOutputs.join("\n")).not.toContain(parentToken);
      expect(shellOutputs.join("\n")).not.toContain(childToken);
      expect(graphCapabilityUses).toEqual(["parent", "child"]);
    } finally {
      harness.forceShutdown();
      await Promise.all([
        closeServer(providerServer),
        closeServer(graphServer),
      ]);
    }
  }, 30_000);
});

interface CapturedRequest {
  readonly method: string;
  readonly url: string;
  readonly host: string;
  readonly authorization: string;
  readonly body: string;
}

async function captureRequest(request: IncomingMessage): Promise<CapturedRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return {
    method: request.method ?? "",
    url: request.url ?? "",
    host: request.headers.host ?? "",
    authorization: request.headers.authorization ?? "",
    body: Buffer.concat(chunks).toString("utf8"),
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function functionCallOutput(body: string): string {
  const input = JSON.parse(body).input;
  if (!Array.isArray(input)) throw new Error("Codex Responses request omitted its input array.");
  const output = input.find((item) => item?.type === "function_call_output")?.output;
  if (typeof output !== "string") throw new Error("Codex did not return the shell tool output.");
  return output;
}

function respondWithEnvironmentProbe(response: import("node:http").ServerResponse): void {
  const argumentsJson = JSON.stringify({
    cmd: environmentProbeCommand(),
  });
  const item = {
    id: "fc_environment_probe",
    type: "function_call",
    status: "completed",
    arguments: argumentsJson,
    call_id: "call_environment_probe",
    name: "exec_command",
  };
  startEventStream(response);
  sendEvent(response, "response.created", {
    type: "response.created", response: responseEnvelope("response_probe", "in_progress", []), sequence_number: 0,
  });
  sendEvent(response, "response.output_item.added", {
    type: "response.output_item.added", output_index: 0,
    item: { ...item, status: "in_progress", arguments: "" }, sequence_number: 1,
  });
  sendEvent(response, "response.function_call_arguments.delta", {
    type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0,
    delta: argumentsJson, sequence_number: 2,
  });
  sendEvent(response, "response.function_call_arguments.done", {
    type: "response.function_call_arguments.done", item_id: item.id, output_index: 0,
    arguments: argumentsJson, sequence_number: 3,
  });
  sendEvent(response, "response.output_item.done", {
    type: "response.output_item.done", output_index: 0, item, sequence_number: 4,
  });
  sendEvent(response, "response.completed", {
    type: "response.completed", response: responseEnvelope("response_probe", "completed", [item]), sequence_number: 5,
  });
  response.end();
}

function respondWithGraphInputProbe(response: import("node:http").ServerResponse, expectedNodeId: number): void {
  const clientModuleUrl = import.meta.resolve("@relayer/graph-client");
  const script = [
    `import { RelayerGraphClient } from ${JSON.stringify(clientModuleUrl)};`,
    "try {",
    "const input = await RelayerGraphClient.fromEnv().getInteractionInput();",
    `if (input.interaction.id !== ${expectedNodeId}) throw new Error("Unexpected interaction node");`,
    `console.log("GRAPH_INPUT_NODE_${expectedNodeId}_OK");`,
    "} catch { console.log(\"GRAPH_INPUT_PROBE_FAILED\"); process.exitCode = 1; }",
  ].join(" ");
  const argumentsJson = JSON.stringify({
    cmd: `node --input-type=module --eval ${shellSingleQuote(script)}`,
  });
  const item = {
    id: `fc_graph_input_${expectedNodeId}`,
    type: "function_call",
    status: "completed",
    arguments: argumentsJson,
    call_id: `call_graph_input_${expectedNodeId}`,
    name: "exec_command",
  };
  startEventStream(response);
  sendEvent(response, "response.created", {
    type: "response.created", response: responseEnvelope(`response_graph_input_${expectedNodeId}`, "in_progress", []), sequence_number: 0,
  });
  sendEvent(response, "response.output_item.added", {
    type: "response.output_item.added", output_index: 0,
    item: { ...item, status: "in_progress", arguments: "" }, sequence_number: 1,
  });
  sendEvent(response, "response.function_call_arguments.delta", {
    type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0,
    delta: argumentsJson, sequence_number: 2,
  });
  sendEvent(response, "response.function_call_arguments.done", {
    type: "response.function_call_arguments.done", item_id: item.id, output_index: 0,
    arguments: argumentsJson, sequence_number: 3,
  });
  sendEvent(response, "response.output_item.done", {
    type: "response.output_item.done", output_index: 0, item, sequence_number: 4,
  });
  sendEvent(response, "response.completed", {
    type: "response.completed", response: responseEnvelope(`response_graph_input_${expectedNodeId}`, "completed", [item]), sequence_number: 5,
  });
  response.end();
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function environmentProbeCommand(): string {
  if (process.platform === "win32") {
    return "cmd.exe /d /s /c \"if defined OPENAI_API_KEY (echo OPENAI_API_KEY_PRESENT) else (echo OPENAI_API_KEY_ABSENT) & if defined OPENAI_BASE_URL (echo OPENAI_BASE_URL_PRESENT) else (echo OPENAI_BASE_URL_ABSENT) & if defined RELAYER_GRAPH_URL (echo RELAYER_GRAPH_URL_PRESENT) else (echo RELAYER_GRAPH_URL_ABSENT) & if defined RELAYER_GRAPH_TOKEN (echo RELAYER_GRAPH_TOKEN_PRESENT) else (echo RELAYER_GRAPH_TOKEN_ABSENT) & if defined RELAYER_NODE_ID (echo RELAYER_NODE_ID_PRESENT) else (echo RELAYER_NODE_ID_ABSENT)\"";
  }
  return "if env | grep -q ^OPENAI_API_KEY=; then echo OPENAI_API_KEY_PRESENT; else echo OPENAI_API_KEY_ABSENT; fi; if env | grep -q ^OPENAI_BASE_URL=; then echo OPENAI_BASE_URL_PRESENT; else echo OPENAI_BASE_URL_ABSENT; fi; if env | grep -q ^RELAYER_GRAPH_URL=; then echo RELAYER_GRAPH_URL_PRESENT; else echo RELAYER_GRAPH_URL_ABSENT; fi; if env | grep -q ^RELAYER_GRAPH_TOKEN=; then echo RELAYER_GRAPH_TOKEN_PRESENT; else echo RELAYER_GRAPH_TOKEN_ABSENT; fi; if env | grep -q ^RELAYER_NODE_ID=; then echo RELAYER_NODE_ID_PRESENT; else echo RELAYER_NODE_ID_ABSENT; fi";
}

function respondWithFinalMessage(response: import("node:http").ServerResponse): void {
  const part = { type: "output_text", annotations: [], logprobs: [], text: "Environment probe complete." };
  const item = { id: "message_probe_complete", type: "message", status: "completed", role: "assistant", content: [part] };
  startEventStream(response);
  sendEvent(response, "response.created", {
    type: "response.created", response: responseEnvelope("response_complete", "in_progress", []), sequence_number: 0,
  });
  sendEvent(response, "response.output_item.added", {
    type: "response.output_item.added", output_index: 0,
    item: { ...item, status: "in_progress", content: [] }, sequence_number: 1,
  });
  sendEvent(response, "response.content_part.added", {
    type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0,
    part: { ...part, text: "" }, sequence_number: 2,
  });
  sendEvent(response, "response.output_text.delta", {
    type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0,
    delta: part.text, logprobs: [], sequence_number: 3,
  });
  sendEvent(response, "response.output_text.done", {
    type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0,
    text: part.text, logprobs: [], sequence_number: 4,
  });
  sendEvent(response, "response.content_part.done", {
    type: "response.content_part.done", item_id: item.id, output_index: 0, content_index: 0,
    part, sequence_number: 5,
  });
  sendEvent(response, "response.output_item.done", {
    type: "response.output_item.done", output_index: 0, item, sequence_number: 6,
  });
  sendEvent(response, "response.completed", {
    type: "response.completed", response: responseEnvelope("response_complete", "completed", [item]), sequence_number: 7,
  });
  response.end();
}

function startEventStream(response: import("node:http").ServerResponse): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
}

function sendEvent(
  response: import("node:http").ServerResponse,
  event: string,
  data: Record<string, unknown>,
): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function responseEnvelope(id: string, status: string, output: readonly unknown[]): Record<string, unknown> {
  return {
    id,
    object: "response",
    created_at: 1,
    status,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: "gpt-test",
    output,
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: "medium", summary: null },
    store: false,
    temperature: null,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: null,
    truncation: "disabled",
    usage: {
      input_tokens: 1,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 1,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 2,
    },
    user: null,
    metadata: {},
  };
}

function pinnedCodexVersion(): string {
  return require("@openai/codex/package.json").version;
}

function resolvePinnedCodexBinary(): string {
  const target = codexTarget();
  const packageRoot = dirname(require.resolve(`${target.packageName}/package.json`));
  return join(packageRoot, "vendor", target.triple, "bin", target.executable);
}

async function listenLoopback(server: import("node:http").Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

async function closeServer(server: import("node:http").Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function codexTarget(): { packageName: string; triple: string; executable: string } {
  const executable = process.platform === "win32" ? "codex.exe" : "codex";
  if (process.platform === "darwin" && process.arch === "arm64") {
    return { packageName: "@openai/codex-darwin-arm64", triple: "aarch64-apple-darwin", executable };
  }
  if (process.platform === "darwin" && process.arch === "x64") {
    return { packageName: "@openai/codex-darwin-x64", triple: "x86_64-apple-darwin", executable };
  }
  if (process.platform === "linux" && process.arch === "arm64") {
    return { packageName: "@openai/codex-linux-arm64", triple: "aarch64-unknown-linux-musl", executable };
  }
  if (process.platform === "linux" && process.arch === "x64") {
    return { packageName: "@openai/codex-linux-x64", triple: "x86_64-unknown-linux-musl", executable };
  }
  if (process.platform === "win32" && process.arch === "arm64") {
    return { packageName: "@openai/codex-win32-arm64", triple: "aarch64-pc-windows-msvc", executable };
  }
  if (process.platform === "win32" && process.arch === "x64") {
    return { packageName: "@openai/codex-win32-x64", triple: "x86_64-pc-windows-msvc", executable };
  }
  throw new Error(`Unsupported Codex test target: ${process.platform}/${process.arch}`);
}
