import { createHash } from "node:crypto";
import { createServer } from "node:http";

const mutant = process.env.RELAYER_API_LAB_MUTANT || "none";
const architecture = process.env.RELAYER_API_LAB_ARCHITECTURE || "interpreted";
const contracts = new Map();
const scenarios = new Map();
const trace = [];
let active = null;
let sequence = 0;

const send = (response, status, body, headers = {}) => {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
};
const body = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return undefined;
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return Symbol.for("invalid-json"); }
};
const schemaIssues = (schema, value, path = "body") => {
  const issues = [];
  if (!schema) return issues;
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [`${path} must be an object`];
    for (const key of schema.required || []) if (!(key in value)) issues.push(`${path}.${key} is required`);
    for (const [key, child] of Object.entries(schema.properties || {})) if (key in value) issues.push(...schemaIssues(child, value[key], `${path}.${key}`));
  } else if (schema.type === "string") {
    if (typeof value !== "string") issues.push(`${path} must be a string`);
    else if (schema.minLength && value.length < schema.minLength) issues.push(`${path} is too short`);
    else if (schema.pattern && !new RegExp(schema.pattern).test(value)) issues.push(`${path} does not match`);
    else if (schema.enum && !schema.enum.includes(value)) issues.push(`${path} is not allowed`);
  } else if (schema.type === "integer") {
    if (!Number.isInteger(value)) issues.push(`${path} must be an integer`);
    else if (schema.minimum !== undefined && value < schema.minimum) issues.push(`${path} is below minimum`);
  } else if (schema.type === "boolean" && typeof value !== "boolean") issues.push(`${path} must be a boolean`);
  return issues;
};
const validateContract = (document) => {
  const issues = [];
  if (document?.labContract !== 1 || typeof document?.revision !== "string" || !Array.isArray(document?.operations)) issues.push({ direction: "request", path: "contract", message: "invalid contract envelope" });
  for (const operation of document?.operations || []) {
    if (!operation?.operationId || !operation?.method || !operation?.path || !operation?.response) issues.push({ direction: "request", path: "operation", message: "invalid operation" });
    if (operation?.response?.example !== undefined) for (const message of schemaIssues(operation.response.schema, operation.response.example, "response")) issues.push({ direction: "response", path: operation.operationId, message });
  }
  return issues;
};
const compile = (document) => document.operations.map((operation) => {
  const names = [];
  const pattern = operation.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{([^}]+)\\\}/g, (_, name) => { names.push(name); return "([^/]+)"; });
  return { operation, matcher: new RegExp(`^${pattern}$`), names };
});
const findInterpreted = (document, method, pathname) => {
  for (const operation of document.operations) {
    if (operation.method !== method) continue;
    const expected = operation.path.split("/"); const actual = pathname.split("/");
    if (expected.length !== actual.length) continue;
    const params = {}; let matches = true;
    for (let index = 0; index < expected.length; index += 1) {
      const segment = expected[index];
      if (segment.startsWith("{") && segment.endsWith("}")) params[segment.slice(1, -1)] = decodeURIComponent(actual[index]);
      else if (segment !== actual[index]) matches = false;
    }
    if (matches) return { operation, params };
  }
  return null;
};
const findCompiled = (document, method, pathname) => {
  for (const entry of document.compiled) {
    if (entry.operation.method !== method) continue;
    const match = entry.matcher.exec(pathname);
    if (match) return { operation: entry.operation, params: Object.fromEntries(entry.names.map((name, index) => [name, decodeURIComponent(match[index + 1])])) };
  }
  return null;
};
const requestIssues = (operation, params, request, requestBody, url) => {
  if (mutant === "no-request-validation") return [];
  const issues = [];
  for (const [name, schema] of Object.entries(operation.request?.path || {})) {
    if (schema.required && params[name] === undefined) issues.push(`${name} is required`);
    else issues.push(...schemaIssues(schema, params[name], `path.${name}`));
  }
  for (const [name, schema] of Object.entries(operation.request?.headers || {})) {
    const value = request.headers[name];
    if (schema.required && value === undefined) issues.push(`${name} is required`);
    else if (value !== undefined) issues.push(...schemaIssues(schema, value, `header.${name}`));
  }
  for (const [name, schema] of Object.entries(operation.request?.query || {})) {
    const value = url.searchParams.get(name) ?? undefined;
    if (schema.required && value === undefined) issues.push(`${name} is required`);
    else if (value !== undefined) issues.push(...schemaIssues(schema, value, `query.${name}`));
  }
  if (operation.request?.body) issues.push(...schemaIssues(operation.request.body, requestBody, "body"));
  return issues;
};
const record = (operation, status, requestValid, responseValid, path) => {
  if (mutant === "fixed-causal-probes-only" && (/^\/users\/[cfv]-/.test(path) || path === "/orders")) return;
  trace.push({ sequence: ++sequence, revision: active, operationId: operation.operationId, method: operation.method, path, status, requestValid, responseValid });
};
const normalizeChanges = (base, candidate) => {
  if (mutant === "shallow-compatibility") return [];
  const changes = [];
  const candidateById = new Map(candidate.operations.map((operation) => [operation.operationId, operation]));
  for (const operation of base.operations) if (!candidateById.has(operation.operationId)) changes.push({ path: `operations.${operation.operationId}`, kind: "removed-operation", breaking: true });
  for (const operation of base.operations) {
    const next = candidateById.get(operation.operationId); if (!next) continue;
    for (const location of ["path", "headers", "query"]) {
      for (const [name, schema] of Object.entries(next.request?.[location] || {})) {
        if (schema.required === true && operation.request?.[location]?.[name]?.required !== true) changes.push({ path: `operations.${operation.operationId}.request.${location}.${name}`, kind: "new-required-input", breaking: true });
      }
    }
    const beforeRequired = new Set(operation.request?.body?.required || []);
    for (const name of next.request?.body?.required || []) if (!beforeRequired.has(name)) changes.push({ path: `operations.${operation.operationId}.request.body.${name}`, kind: "new-required-input", breaking: true });
    const beforeProperties = operation.response?.schema?.properties || {};
    const beforeResponseRequired = new Set(operation.response?.schema?.required || []);
    for (const name of Object.keys(next.response?.schema?.properties || {})) if (!(name in beforeProperties)) changes.push({ path: `operations.${operation.operationId}.response.${name}`, kind: beforeResponseRequired.has(name) ? "required-response-field" : "optional-response-field", breaking: false });
  }
  return changes;
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const requestBody = await body(request);
  if (request.method === "POST" && url.pathname === "/_lab/contracts") {
    if (mutant === "frozen-contracts-only" && !["orders-v1", "orders-v2", "invalid-response-v1"].includes(requestBody?.revision)) return send(response, 422, { issues: [{ direction: "request", message: "unknown fixture" }] });
    const issues = validateContract(requestBody);
    if (mutant === "no-response-validation") issues.splice(0, issues.length, ...issues.filter((issue) => issue.direction !== "response"));
    if (issues.length) return send(response, 422, { issues });
    const stored = structuredClone(requestBody); stored.compiled = compile(stored);
    contracts.set(stored.revision, stored);
    return send(response, 201, { revision: stored.revision, operationCount: stored.operations.length });
  }
  if (request.method === "PUT" && url.pathname === "/_lab/active") {
    if (!contracts.has(requestBody?.revision)) return send(response, 404, { issues: ["unknown revision"] });
    if (mutant !== "inactive-selection") active = requestBody.revision;
    return send(response, 200, { revision: requestBody.revision });
  }
  if (request.method === "PUT" && url.pathname === "/_lab/scenario") {
    const operationExists = [...contracts.values()].some((document) => document.operations.some((operation) => operation.operationId === requestBody?.operationId));
    const validLatency = Number.isInteger(requestBody?.latencyMs) && requestBody.latencyMs >= 0;
    const validFailures = Array.isArray(requestBody?.failures) && requestBody.failures.every((failure) => Number.isInteger(failure?.status) && failure.status >= 100 && failure.status <= 599 && failure.body && typeof failure.body === "object");
    if (mutant !== "no-scenario-validation" && (!operationExists || !validLatency || !validFailures)) return send(response, 400, { issues: ["invalid scenario"] });
    scenarios.set(requestBody?.operationId, { latencyMs: requestBody?.latencyMs || 0, failures: structuredClone(requestBody?.failures || []), cursor: 0 });
    return send(response, 200, { configured: true });
  }
  if (request.method === "GET" && url.pathname === "/_lab/trace") {
    if (mutant === "fabricated-trace") return send(response, 200, { entries: Array.from({ length: 12 }, (_, index) => ({ sequence: index + 1, revision: "orders-v1", operationId: "get-user", method: "GET", path: "/users/user-7", status: 200, requestValid: true, responseValid: true })) });
    return send(response, 200, { entries: structuredClone(trace) });
  }
  if (request.method === "POST" && url.pathname === "/_lab/replay") {
    const exchanges = trace.filter(({ sequence }) => sequence >= requestBody.fromSequence && (requestBody.toSequence === undefined || sequence <= requestBody.toSequence)).map(({ method, path, status, operationId, revision }) => ({ method, path, status, operationId, revision }));
    if (mutant === "nondeterministic-replay") exchanges.push({ nonce: Math.random() });
    const serialized = JSON.stringify(exchanges);
    return send(response, 200, { exchanges, digest: createHash("sha256").update(serialized).digest("hex") });
  }
  if (request.method === "POST" && url.pathname === "/_lab/compare") {
    const base = contracts.get(requestBody?.base); const candidate = contracts.get(requestBody?.candidate);
    if (!base || !candidate) return send(response, 404, { issues: ["unknown revision"] });
    const changes = normalizeChanges(base, candidate);
    return send(response, 200, { compatible: !changes.some(({ breaking }) => breaking), changes });
  }
  const document = contracts.get(active);
  if (!document) return send(response, 409, { issues: ["no active revision"] });
  const match = architecture === "compiled" ? findCompiled(document, request.method, url.pathname) : findInterpreted(document, request.method, url.pathname);
  if (!match) return send(response, 404, { issues: ["unknown operation"] });
  const issues = requestIssues(match.operation, match.params, request, requestBody, url);
  if (issues.length) { record(match.operation, 400, false, true, url.pathname); return send(response, 400, { issues }); }
  const scenario = scenarios.get(match.operation.operationId) || { latencyMs: 0, failures: [], cursor: 0 };
  if (scenario.latencyMs && mutant !== "no-latency") await new Promise((resolve) => setTimeout(resolve, scenario.latencyMs));
  if (scenario.cursor < scenario.failures.length && mutant !== "no-failures") {
    const failure = scenario.failures[scenario.cursor++];
    const failureBody = mutant === "wrong-failure-body" ? { wrong: true } : failure.body;
    record(match.operation, failure.status, true, false, url.pathname); return send(response, failure.status, failureBody, { "x-lab-operation-id": match.operation.operationId });
  }
  const declared = match.operation.response;
  if (declared["x-lab-kind"] === "redirect") { record(match.operation, declared.status, true, true, url.pathname); response.writeHead(declared.status, { location: mutant === "wrong-redirect" ? "/wrong" : declared.location, ...(mutant === "selective-operation-header" ? {} : { "x-lab-operation-id": match.operation.operationId }) }); return response.end(); }
  if (declared["x-lab-kind"] === "stream") {
    record(match.operation, declared.status, true, true, url.pathname);
    if (mutant === "buffered-stream") {
      const complete = declared.chunks.join("");
      response.writeHead(declared.status, { "content-type": "text/event-stream", "content-length": Buffer.byteLength(complete), ...(mutant === "selective-operation-header" ? {} : { "x-lab-operation-id": match.operation.operationId }) });
      return response.end(complete);
    }
    response.writeHead(declared.status, { "content-type": "text/event-stream", ...(mutant === "selective-operation-header" ? {} : { "x-lab-operation-id": match.operation.operationId }) });
    for (const chunk of declared.chunks) { response.write(chunk); await new Promise((resolve) => setTimeout(resolve, 2)); }
    return response.end();
  }
  const example = mutant === "wrong-response-example" ? {} : declared.example;
  const responseValid = schemaIssues(declared.schema, example, "response").length === 0;
  record(match.operation, declared.status, true, responseValid, url.pathname);
  return send(response, declared.status, example, mutant === "selective-success-header" && url.pathname === "/users/user-9" ? {} : { "x-lab-operation-id": match.operation.operationId });
});

const argumentIndex = process.argv.indexOf("--port");
const port = argumentIndex >= 0 ? Number(process.argv[argumentIndex + 1]) : 0;
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  process.stdout.write(`${JSON.stringify({ type: "ready", baseUrl: `http://127.0.0.1:${address.port}` })}\n`);
});
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close(() => process.exit(0)));
