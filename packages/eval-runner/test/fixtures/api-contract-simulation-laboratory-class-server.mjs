import { createHash } from "node:crypto";
import { createServer } from "node:http";

class SchemaValidator {
  check(schema, value, path = "value") {
    if (!schema) return [];
    if (schema.type === "object") {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return [`${path} must be an object`];
      const issues = [];
      for (const name of schema.required || []) if (!(name in value)) issues.push(`${path}.${name} is required`);
      for (const [name, child] of Object.entries(schema.properties || {})) if (name in value) issues.push(...this.check(child, value[name], `${path}.${name}`));
      return issues;
    }
    if (schema.type === "string") {
      if (typeof value !== "string") return [`${path} must be a string`];
      if (schema.minLength && value.length < schema.minLength) return [`${path} is too short`];
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) return [`${path} does not match`];
      if (schema.enum && !schema.enum.includes(value)) return [`${path} is not allowed`];
    }
    if (schema.type === "integer") {
      if (!Number.isInteger(value)) return [`${path} must be an integer`];
      if (schema.minimum !== undefined && value < schema.minimum) return [`${path} is below minimum`];
    }
    if (schema.type === "boolean" && typeof value !== "boolean") return [`${path} must be a boolean`];
    return [];
  }
}

class ContractRegistry {
  #documents = new Map();
  #validator;
  constructor(validator) { this.#validator = validator; }
  import(document) {
    const issues = [];
    if (document?.labContract !== 1 || typeof document?.revision !== "string" || !Array.isArray(document?.operations)) issues.push({ direction: "request", path: "contract", message: "invalid contract envelope" });
    for (const operation of document?.operations || []) {
      if (!operation?.operationId || !operation?.method || !operation?.path || !operation?.response) issues.push({ direction: "request", path: "operation", message: "invalid operation" });
      for (const message of this.#validator.check(operation?.response?.schema, operation?.response?.example, "response")) issues.push({ direction: "response", path: operation.operationId, message });
    }
    if (issues.length) return { issues };
    const operations = document.operations.map((operation) => {
      const names = [];
      const expression = operation.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{([^}]+)\\\}/g, (_, name) => { names.push(name); return "([^/]+)"; });
      return { ...structuredClone(operation), names, expression: new RegExp(`^${expression}$`) };
    });
    this.#documents.set(document.revision, { revision: document.revision, operations });
    return { revision: document.revision, operationCount: operations.length };
  }
  get(revision) { return this.#documents.get(revision); }
  hasOperation(operationId) { return [...this.#documents.values()].some(({ operations }) => operations.some((operation) => operation.operationId === operationId)); }
}

class CompatibilityAnalyzer {
  compare(base, candidate) {
    const changes = [];
    const nextById = new Map(candidate.operations.map((operation) => [operation.operationId, operation]));
    for (const operation of base.operations) if (!nextById.has(operation.operationId)) changes.push({ path: `operations.${operation.operationId}`, kind: "removed-operation", breaking: true });
    for (const operation of base.operations) {
      const next = nextById.get(operation.operationId);
      if (!next) continue;
      for (const location of ["path", "headers", "query"]) {
        for (const [name, schema] of Object.entries(next.request?.[location] || {})) if (schema.required && operation.request?.[location]?.[name]?.required !== true) changes.push({ path: `operations.${operation.operationId}.request.${location}.${name}`, kind: "new-required-input", breaking: true });
      }
      const beforeBodyRequired = new Set(operation.request?.body?.required || []);
      for (const name of next.request?.body?.required || []) if (!beforeBodyRequired.has(name)) changes.push({ path: `operations.${operation.operationId}.request.body.${name}`, kind: "new-required-input", breaking: true });
      const beforeResponse = operation.response?.schema?.properties || {};
      for (const name of Object.keys(next.response?.schema?.properties || {})) if (!(name in beforeResponse)) changes.push({ path: `operations.${operation.operationId}.response.${name}`, kind: "optional-response-field", breaking: false });
    }
    return { compatible: !changes.some(({ breaking }) => breaking), changes };
  }
}

class Laboratory {
  #validator = new SchemaValidator();
  #registry = new ContractRegistry(this.#validator);
  #compatibility = new CompatibilityAnalyzer();
  #active = null;
  #scenarios = new Map();
  #trace = [];
  async handle(request, response) {
    const url = new URL(request.url, "http://127.0.0.1");
    const input = await this.#readBody(request);
    if (request.method === "POST" && url.pathname === "/_lab/contracts") {
      const result = this.#registry.import(input);
      return this.#json(response, result.issues ? 422 : 201, result);
    }
    if (request.method === "PUT" && url.pathname === "/_lab/active") {
      if (!this.#registry.get(input?.revision)) return this.#json(response, 404, { issues: ["unknown revision"] });
      this.#active = input.revision;
      return this.#json(response, 200, { revision: input.revision });
    }
    if (request.method === "PUT" && url.pathname === "/_lab/scenario") {
      const validLatency = Number.isInteger(input?.latencyMs) && input.latencyMs >= 0;
      const validFailures = Array.isArray(input?.failures) && input.failures.every((failure) => Number.isInteger(failure?.status) && failure.status >= 100 && failure.status <= 599 && failure.body && typeof failure.body === "object");
      if (!this.#registry.hasOperation(input?.operationId) || !validLatency || !validFailures) return this.#json(response, 400, { issues: ["invalid scenario"] });
      this.#scenarios.set(input.operationId, { latencyMs: input.latencyMs, failures: structuredClone(input.failures), cursor: 0 });
      return this.#json(response, 200, { configured: true });
    }
    if (request.method === "GET" && url.pathname === "/_lab/trace") return this.#json(response, 200, { entries: structuredClone(this.#trace) });
    if (request.method === "POST" && url.pathname === "/_lab/replay") {
      const exchanges = this.#trace.filter(({ sequence }) => sequence >= input.fromSequence && (input.toSequence === undefined || sequence <= input.toSequence)).map(({ method, path, status, operationId, revision }) => ({ method, path, status, operationId, revision }));
      return this.#json(response, 200, { exchanges, digest: createHash("sha256").update(JSON.stringify(exchanges)).digest("hex") });
    }
    if (request.method === "POST" && url.pathname === "/_lab/compare") {
      const base = this.#registry.get(input?.base); const candidate = this.#registry.get(input?.candidate);
      if (!base || !candidate) return this.#json(response, 404, { issues: ["unknown revision"] });
      return this.#json(response, 200, this.#compatibility.compare(base, candidate));
    }
    return this.#mock(request, response, url, input);
  }
  async #mock(request, response, url, input) {
    const document = this.#registry.get(this.#active);
    if (!document) return this.#json(response, 409, { issues: ["no active revision"] });
    let selected = null;
    for (const operation of document.operations) {
      if (operation.method !== request.method) continue;
      const match = operation.expression.exec(url.pathname);
      if (match) { selected = { operation, params: Object.fromEntries(operation.names.map((name, index) => [name, decodeURIComponent(match[index + 1])])) }; break; }
    }
    if (!selected) return this.#json(response, 404, { issues: ["unknown operation"] });
    const { operation, params } = selected;
    const issues = [];
    for (const [name, schema] of Object.entries(operation.request?.path || {})) issues.push(...this.#validator.check(schema, params[name], `path.${name}`));
    for (const [name, schema] of Object.entries(operation.request?.headers || {})) {
      const value = request.headers[name];
      if (schema.required && value === undefined) issues.push(`${name} is required`); else if (value !== undefined) issues.push(...this.#validator.check(schema, value, `header.${name}`));
    }
    for (const [name, schema] of Object.entries(operation.request?.query || {})) {
      const value = url.searchParams.get(name) ?? undefined;
      if (schema.required && value === undefined) issues.push(`${name} is required`); else if (value !== undefined) issues.push(...this.#validator.check(schema, value, `query.${name}`));
    }
    if (operation.request?.body) issues.push(...this.#validator.check(operation.request.body, input, "body"));
    if (issues.length) { this.#record(operation, url.pathname, 400, false, true); return this.#json(response, 400, { issues }); }
    const scenario = this.#scenarios.get(operation.operationId) || { latencyMs: 0, failures: [], cursor: 0 };
    if (scenario.latencyMs) await new Promise((resolve) => setTimeout(resolve, scenario.latencyMs));
    if (scenario.cursor < scenario.failures.length) {
      const failure = scenario.failures[scenario.cursor++]; this.#record(operation, url.pathname, failure.status, true, false);
      return this.#json(response, failure.status, failure.body, { "x-lab-operation-id": operation.operationId });
    }
    const declared = operation.response;
    if (declared["x-lab-kind"] === "redirect") { this.#record(operation, url.pathname, declared.status, true, true); response.writeHead(declared.status, { location: declared.location, "x-lab-operation-id": operation.operationId }); return response.end(); }
    if (declared["x-lab-kind"] === "stream") {
      this.#record(operation, url.pathname, declared.status, true, true); response.writeHead(declared.status, { "content-type": "text/event-stream", "x-lab-operation-id": operation.operationId });
      for (const chunk of declared.chunks) { response.write(chunk); await new Promise((resolve) => setTimeout(resolve, 2)); }
      return response.end();
    }
    const valid = this.#validator.check(declared.schema, declared.example, "response").length === 0;
    this.#record(operation, url.pathname, declared.status, true, valid);
    return this.#json(response, declared.status, declared.example, { "x-lab-operation-id": operation.operationId });
  }
  #record(operation, path, status, requestValid, responseValid) { this.#trace.push({ sequence: this.#trace.length + 1, revision: this.#active, operationId: operation.operationId, method: operation.method, path, status, requestValid, responseValid }); }
  #json(response, status, value, headers = {}) { response.writeHead(status, { "content-type": "application/json", ...headers }); response.end(JSON.stringify(value)); }
  async #readBody(request) { const chunks = []; for await (const chunk of request) chunks.push(chunk); if (!chunks.length) return undefined; try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return Symbol.for("invalid-json"); } }
}

const laboratory = new Laboratory();
const server = createServer((request, response) => laboratory.handle(request, response));
const portIndex = process.argv.indexOf("--port");
server.listen(portIndex < 0 ? 0 : Number(process.argv[portIndex + 1]), "127.0.0.1", () => {
  process.stdout.write(`${JSON.stringify({ type: "ready", baseUrl: `http://127.0.0.1:${server.address().port}` })}\n`);
});
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close(() => process.exit(0)));
