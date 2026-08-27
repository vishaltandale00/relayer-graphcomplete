import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createServer as createSecureServer } from "node:https";

export const PRIME_EVIDENCE_PROVIDER_ID = "openai-work";
export const PRIME_EVIDENCE_API_KEY = "relayer-prime-evidence-key";
export const PRIME_EVIDENCE_ROOT_MODEL = "relayer-evidence-root";
export const PRIME_EVIDENCE_CHILD_MODEL = "relayer-evidence-child";
export const PRIME_EVIDENCE_CHILD_SELECTOR = "relayer-openai-api-b3BlbmFpLXdvcms/relayer-evidence-child";

const DEFAULT_MODELS = Object.freeze([
  Object.freeze({ id: PRIME_EVIDENCE_ROOT_MODEL, name: "Evidence Root", is_default: true }),
  Object.freeze({ id: PRIME_EVIDENCE_CHILD_MODEL, name: "Evidence Child" }),
]);

function readRequest(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function walk(value, visit) {
  visit(value);
  if (Array.isArray(value)) value.forEach((entry) => walk(entry, visit));
  else if (value && typeof value === "object") Object.values(value).forEach((entry) => walk(entry, visit));
}

export function requestFacts(body) {
  let toolOutputs = 0;
  const strings = [];
  walk(body.input, (value) => {
    if (value?.type === "function_call_output") toolOutputs += 1;
    if (typeof value === "string") strings.push(value);
  });
  const text = strings.join("\n");
  const interactionMatches = [...text.matchAll(/Current interaction node:\s*(\d+)/g)];
  return {
    text,
    toolOutputs,
    interactionId: Number(interactionMatches.at(-1)?.[1] ?? 0),
    child: /deterministic family child: report the admitted child model/i.test(text),
    askBoundary: /Ask boundary: request a graph write, accept a denial, then request it again\./i.test(text),
    followup: /Follow-up: change the selected orchestrator and continue the same Prime session\./i.test(text),
  };
}

function graphCode({ interactionId, spawnChild, childSelector }) {
  if (!Number.isInteger(interactionId) || interactionId < 1) throw new Error("Prime evidence request omitted the interaction id.");
  const prefix = `evidence-${interactionId}`;
  return [
    ...(spawnChild ? [
      `await rlm("deterministic family child: report the admitted child model", name="family-child-${interactionId}", model="${childSelector}")`,
    ] : []),
    "from relayer_graph import GraphSession, NodeObject, EdgeObject, LayerObject, NodePlacementObject, LayerLayoutObject",
    "graph = await GraphSession.current()",
    `root = NodeObject("info", "Prime root ${interactionId}", "The explicitly selected orchestrator authored this accepted graph.", client_key="${prefix}-root")`,
    `child = NodeObject("users", "Native family child", "The second admitted family member ran through Prime native recursion.", client_key="${prefix}-child")`,
    "await graph.submit_node(root)",
    "await graph.submit_node(child)",
    `edge = EdgeObject((root, child), client_key="${prefix}-edge")`,
    "await graph.create_edge(edge)",
    "layout = LayerLayoutObject((NodePlacementObject(root, 0.28, 0.5), NodePlacementObject(child, 0.72, 0.5)))",
    `layer = LayerObject((root, child), (edge,), layout, client_key="${prefix}-layer")`,
    "await graph.submit_layer(layer)",
    `await graph.add_navigate_action(${interactionId}, "Prime evidence", layer, relation="expand", client_key="${prefix}-navigate")`,
    `await graph.submit(${interactionId})`,
  ].join("\n");
}

function responseEnvelope(id, model, output, usage = {}) {
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model,
    output,
    usage: {
      input_tokens: usage.input_tokens ?? 12,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: usage.output_tokens ?? 8,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: (usage.input_tokens ?? 12) + (usage.output_tokens ?? 8),
    },
  };
}

function toolEvents(responseId, model, code) {
  const item = {
    id: `fc_${responseId}`,
    type: "function_call",
    call_id: `call_${responseId}`,
    name: "ipython",
    arguments: JSON.stringify({ code }),
    status: "completed",
  };
  const completed = responseEnvelope(responseId, model, [item]);
  return [
    { type: "response.created", response: { ...completed, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    { type: "response.function_call_arguments.done", item_id: item.id, output_index: 0, arguments: item.arguments },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: completed },
  ];
}

function textEvents(responseId, model, text) {
  const part = { type: "output_text", text, annotations: [] };
  const item = { id: `msg_${responseId}`, type: "message", role: "assistant", status: "completed", content: [part] };
  const completed = responseEnvelope(responseId, model, [item]);
  return [
    { type: "response.created", response: { ...completed, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { ...part, text: "" } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: completed },
  ];
}

function writeEvents(response, events) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "x-request-id": `req_${Date.now()}`,
  });
  for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end("data: [DONE]\n\n");
}

export async function createDeterministicPrimeProviderServer({ apiKey = PRIME_EVIDENCE_API_KEY, tls = null } = {}) {
  let models = [...DEFAULT_MODELS];
  let childSelector = PRIME_EVIDENCE_CHILD_SELECTOR;
  let sequence = 0;
  const rootRequestsByInteraction = new Map();
  const rootSessionIds = new Set();
  const observations = [];
  const handle = async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      const authorization = request.headers.authorization ?? "";
      const authorized = authorization === `Bearer ${apiKey}`;
      observations.push({
        method: request.method,
        pathname: url.pathname,
        authorized,
        authorizationSha256: createHash("sha256").update(authorization).digest("hex"),
        sessionId: request.headers.session_id ?? null,
      });
      if (!authorized) {
        response.writeHead(401, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "unauthorized" } }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/models") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ object: "list", data: models }));
        return;
      }
      if (request.method !== "POST" || url.pathname !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      const body = await readRequest(request);
      const facts = requestFacts(body);
      const sessionId = typeof request.headers.session_id === "string" ? request.headers.session_id : null;
      const recursionRole = sessionId !== null && rootSessionIds.has(sessionId)
        ? "root"
        : facts.child ? "child" : "root";
      if (recursionRole === "root" && sessionId !== null) rootSessionIds.add(sessionId);
      const responseId = `resp_${++sequence}`;
      Object.assign(observations.at(-1), {
        model: body.model,
        interactionId: facts.interactionId || null,
        recursionRole,
        toolOutputs: facts.toolOutputs,
      });
      if (recursionRole === "child") {
        writeEvents(response, textEvents(responseId, body.model, "Deterministic child completed with the second family member."));
      } else {
        const rootRequestCount = (rootRequestsByInteraction.get(facts.interactionId) ?? 0) + 1;
        rootRequestsByInteraction.set(facts.interactionId, rootRequestCount);
        const shouldCallTool = facts.askBoundary ? rootRequestCount <= 2 : rootRequestCount === 1;
        if (shouldCallTool) {
        writeEvents(response, toolEvents(responseId, body.model, graphCode({
          interactionId: facts.interactionId,
          spawnChild: rootRequestCount === 1 && !facts.followup,
          childSelector,
        })));
        } else {
          writeEvents(response, textEvents(responseId, body.model, "The deterministic Prime graph was submitted."));
        }
      }
    } catch (error) {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: error.message } }));
    }
  };
  const server = tls ? createSecureServer(tls, handle) : createServer(handle);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Deterministic provider did not bind a TCP port.");
  return Object.freeze({
    endpoint: `${tls ? "https" : "http"}://127.0.0.1:${address.port}/v1`,
    observations,
    setModels(next) { models = next.map((model) => ({ ...model })); },
    setChildSelector(value) {
      if (typeof value !== "string" || !value.includes("/")) throw new Error("Prime child selector must be provider/model.");
      childSelector = value;
    },
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  });
}
