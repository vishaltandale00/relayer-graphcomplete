import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { createInterface } from "node:readline";

import { bindAutonomousCaseSnapshot } from "../cases/catalog.js";
import { createAutonomousCaseSnapshot } from "../cases/contracts.js";
import type { EvalCheck } from "../runtime-basic.js";
import type { CommandResult, CommandRunner, ProjectEvalThreadDefinition } from "./h3.js";

export const API_CONTRACT_SIMULATION_LABORATORY_CASE_ID = "capability.greenfield.api-contract-simulation-laboratory";
export const API_CONTRACT_SIMULATION_LABORATORY_VERIFIER_SOURCE_SHA256 = "7f673face611a7b712b5d27a189c1ef6b50b57ef379502fbc6a26a6c7913744e";

const QUALIFICATION_ENVIRONMENT = Object.freeze({
  nodeVersion: "v22.23.2",
  nodeSha256: "18e387c90ab8a8400183e8bdd396376e1e875b91b4c874b894dcade7b35bf572",
  npmCliSha256: "8e5f6f3429f8cdbe693cdc29904e9d5a7b127a494bd15c804bd54c7403bfcbe7",
  sandboxExecPath: "/usr/bin/sandbox-exec",
  sandboxExecSha256: "e3d7a792c58a5d3783d2f7274c82d70062393830d8cb1ded713ca554a470bd2f",
  platform: "darwin-arm64",
  network: "inbound-loopback-only",
  filesystem: "node-permission-workspace-only",
});

const VISIBLE_TASK = `Build an API Contract Simulation Laboratory in this repository and commit the finished project. The laboratory must import the supplied versioned JSON API contracts, serve their mock operations deterministically, validate requests and example responses, inject configured latency and ordered failures, compare revisions, and replay recorded exchanges deterministically.

The evaluator treats the running process as a black box. Keep complete implementation freedom behind this public seam:

- \`npm start -- --port 0\` starts without external network access or dependency installation and prints one JSON line \`{"type":"ready","baseUrl":"http://127.0.0.1:<port>"}\` when ready. The \`start\` script must be exactly one \`node <repo-relative .js or .mjs entry>\` command, with no shell chaining. Listen only on loopback. Exit non-zero on startup failure.
- \`POST /_lab/contracts\` imports one supplied contract document. Return 201 with its \`revision\` and \`operationCount\`. Reject malformed contracts and response examples that violate their declared schemas with 422 and independent machine-readable \`issues\` whose entries identify \`request\` or \`response\` direction.
- \`PUT /_lab/active\` with \`{"revision":"..."}\` selects an imported revision.
- \`PUT /_lab/scenario\` with \`operationId\`, non-negative integer \`latencyMs\`, and an ordered \`failures\` array replaces that operation's scenario and resets its deterministic cursor. Each failure has an HTTP \`status\` and JSON \`body\`.
- Active contract paths are served over ordinary HTTP. Validate path, header, query, and JSON body inputs against the contract. Invalid requests return 400 with issues. Successful responses use the contract's declared status/example and include \`x-lab-operation-id\`. Record whether both request and response validated.
- A response with \`x-lab-kind: redirect\` is an un-followed redirect using its declared status and Location. A response with \`x-lab-kind: stream\` sends its declared UTF-8 chunks in order using chunked HTTP delivery. The supplied cases bound redirects to one hop and streams to four small chunks.
- \`GET /_lab/trace\` returns \`{"entries":[...]}\` in sequence order. Mock-operation entries include sequence, revision, operationId, status, requestValid, and responseValid.
- \`POST /_lab/replay\` with an inclusive \`fromSequence\` and optional \`toSequence\` returns normalized recorded exchanges plus the lowercase hexadecimal SHA-256 of \`JSON.stringify(exchanges)\`. Repeating a replay must be byte-for-byte deterministic and must not consume or alter failure scenarios.
- \`POST /_lab/compare\` with \`base\` and \`candidate\` revisions returns \`compatible\` and independently listed \`changes\`. Each change identifies its path, kind, and whether it is breaking. Detect at least removed operations, newly required request inputs, and additive optional response fields.

Use only Node.js built-ins in the delivered runtime, keep the seeded contract files immutable, add focused tests and concise usage documentation, and leave a clean Git workspace. Qualification denies outbound network and child-process access and confines runtime filesystem reads and writes to the pristine workspace. Safe internal symlinks are allowed; broken links and links escaping that workspace are rejected. Do not contact external services, push, publish, or add generated/dependency artifacts.`;

const packageJson = `${JSON.stringify({
  name: "api-contract-simulation-laboratory",
  version: "1.0.0",
  private: true,
  type: "module",
  scripts: { start: "node server.mjs", test: "node --test" },
  engines: { node: ">=22.8.0" },
}, null, 2)}\n`;

const contractV1 = {
  labContract: 1,
  revision: "orders-v1",
  operations: [
    {
      operationId: "get-user",
      method: "GET",
      path: "/users/{id}",
      request: {
        path: { id: { type: "string", pattern: "^[a-z0-9-]{2,24}$", required: true } },
        headers: { "x-client-version": { type: "string", pattern: "^1\\.", required: true } },
        query: { expand: { type: "string", enum: ["basic", "full"], required: false } },
      },
      response: { status: 200, schema: { type: "object", required: ["id", "name"], properties: { id: { type: "string" }, name: { type: "string" } } }, example: { id: "user-7", name: "Ada" } },
    },
    {
      operationId: "create-order",
      method: "POST",
      path: "/orders",
      request: { body: { type: "object", required: ["sku", "quantity"], properties: { sku: { type: "string", minLength: 2 }, quantity: { type: "integer", minimum: 1 } } } },
      response: { status: 201, schema: { type: "object", required: ["orderId", "accepted"], properties: { orderId: { type: "string" }, accepted: { type: "boolean" } } }, example: { orderId: "order-100", accepted: true } },
    },
    {
      operationId: "legacy-redirect",
      method: "GET",
      path: "/legacy",
      response: { status: 307, "x-lab-kind": "redirect", location: "/users/user-7" },
    },
    {
      operationId: "event-stream",
      method: "GET",
      path: "/events",
      response: { status: 200, "x-lab-kind": "stream", chunks: ["event: open\\n", "data: one\\n\\n", "data: two\\n\\n", "event: close\\n\\n"] },
    },
  ],
};

const contractV2 = {
  ...contractV1,
  revision: "orders-v2",
  operations: contractV1.operations
    .filter(({ operationId }) => operationId !== "legacy-redirect")
    .map((operation) => {
      const candidate = operation as any;
      if (operation.operationId === "create-order") return {
        ...candidate,
        request: { body: { ...candidate.request.body, required: ["sku", "quantity", "region"], properties: { ...candidate.request.body.properties, region: { type: "string" } } } },
      };
      if (operation.operationId === "get-user") return {
        ...candidate,
        response: {
          ...candidate.response,
          schema: { ...candidate.response.schema, properties: { ...candidate.response.schema.properties, displayName: { type: "string" } } },
          example: { ...candidate.response.example, displayName: "Ada L." },
        },
      };
      return operation;
    }),
};

const invalidResponseContract = {
  labContract: 1,
  revision: "invalid-response-v1",
  operations: [{
    operationId: "broken-example",
    method: "GET",
    path: "/broken",
    response: { status: 200, schema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }, example: { ok: "yes" } },
  }],
};

const propertyContract = {
  labContract: 1,
  revision: "inventory-property-v1",
  operations: [{
    operationId: "get-inventory",
    method: "GET",
    path: "/inventory/{sku}",
    request: {
      path: { sku: { type: "string", pattern: "^[A-Z]{2}-[0-9]{3}$", required: true } },
      headers: { "x-tenant": { type: "string", pattern: "^[a-z]{3,8}$", required: true } },
    },
    response: { status: 200, schema: { type: "object", required: ["sku", "available"], properties: { sku: { type: "string" }, available: { type: "integer", minimum: 0 } } }, example: { sku: "ZX-314", available: 8 } },
  }, {
    operationId: "legacy-stock",
    method: "GET",
    path: "/stock/legacy",
    response: { status: 200, schema: { type: "object", required: ["legacy"], properties: { legacy: { type: "boolean" } } }, example: { legacy: true } },
  }],
};

const propertyCandidateContract = {
  ...propertyContract,
  revision: "inventory-property-v2",
  operations: propertyContract.operations
    .filter(({ operationId }) => operationId !== "legacy-stock")
    .map((operation) => operation.operationId === "get-inventory" ? {
      ...(operation as any),
      request: {
        ...(operation as any).request,
        query: { region: { type: "string", pattern: "^[A-Z]{2}$", required: true } },
      },
      response: {
        ...(operation as any).response,
        schema: { ...(operation as any).response.schema, properties: { ...(operation as any).response.schema.properties, warehouse: { type: "string" } } },
        example: { ...(operation as any).response.example, warehouse: "north" },
      },
    } : operation),
};

const fixtureFiles: Readonly<Record<string, string>> = Object.freeze({
  "README.md": `# API Contract Simulation Laboratory\n\n${VISIBLE_TASK}\n\nThe evaluator-owned contracts are in \`contracts/\`. Their bytes are part of the frozen fixture identity and must not be edited.\n`,
  "package.json": packageJson,
  "server.mjs": `console.error("The API Contract Simulation Laboratory has not been implemented.");\nprocess.exitCode = 1;\n`,
  "contracts/orders-v1.json": `${JSON.stringify(contractV1, null, 2)}\n`,
  "contracts/orders-v2.json": `${JSON.stringify(contractV2, null, 2)}\n`,
  "contracts/invalid-response-v1.json": `${JSON.stringify(invalidResponseContract, null, 2)}\n`,
});

const hash = (value: string): `sha256:${string}` => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const canonicalFiles = (files: Readonly<Record<string, string>>): string => Object.entries(files)
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([path, contents]) => `${path}\0${contents.length}\0${contents}`)
  .join("\0");

const fixtureDigest = hash(canonicalFiles(fixtureFiles));
const referenceDigest = "sha256:fa3e264b469aa400ef65cefd751873445a654fe6c5ee7b3a2bd11fb36a8d84e7";

const thread: ProjectEvalThreadDefinition = Object.freeze({
  id: "implementation",
  name: "Build the simulation laboratory",
  permissionProfileId: "auto",
  mutationPolicy: "writable",
  workspaceGrade: "autonomous-implementation",
  prompts: Object.freeze([VISIBLE_TASK]),
});

const definition = Object.freeze({
  schemaVersion: 1 as const,
  id: API_CONTRACT_SIMULATION_LABORATORY_CASE_ID,
  name: "API contract simulation laboratory",
  description: "Builds a deterministic, contract-driven mock service and compatibility laboratory behind a public HTTP seam.",
  localOnly: true as const,
  supportedPlatform: "darwin" as const,
  autonomous: true as const,
  category: "coding" as const,
  taskType: "greenfield-build",
  fixture: Object.freeze({
    source: `relayer-eval://capability/${API_CONTRACT_SIMULATION_LABORATORY_CASE_ID}`,
    revision: `template:${fixtureDigest}`,
    packageManager: "node@22-builtins-only",
  }),
  threads: Object.freeze([thread]),
});

const mandatoryGates = Object.freeze([
  { id: "contract-import", label: "Contract import", description: "Valid revisions import and invalid contracts fail with directional issues." },
  { id: "mock-routing", label: "Deterministic mock routing", description: "The public HTTP seam routes path, header, and body operations deterministically." },
  { id: "request-response-validation", label: "Request and response validation", description: "Boundary matrices reject invalid requests and invalid response examples." },
  { id: "fault-injection", label: "Latency and failure injection", description: "Configured delay and ordered failures are observable and reset deterministically." },
  { id: "bounded-http", label: "Redirects and streaming", description: "The bounded redirect and streaming contract is preserved over HTTP." },
  { id: "revision-compatibility", label: "Revision compatibility", description: "Revision changes are independently classified as breaking or additive." },
  { id: "deterministic-replay", label: "Deterministic replay", description: "Recorded public exchanges replay byte-stably without consuming scenarios." },
  { id: "scoped-api-laboratory-delivery", label: "Scoped committed delivery", description: "The committed candidate diff applies to a pristine fixture and leaves source contracts unchanged." },
]);

export const API_CONTRACT_SIMULATION_LABORATORY_GATE_CHECK_PATTERNS = Object.freeze({
  "contract-import": Object.freeze(["contract-import"]),
  "mock-routing": Object.freeze(["mock-routing", "property-contract"]),
  "request-response-validation": Object.freeze(["request-validation", "response-validation"]),
  "fault-injection": Object.freeze(["latency-injection", "failure-injection"]),
  "bounded-http": Object.freeze(["bounded-redirect", "bounded-streaming"]),
  "revision-compatibility": Object.freeze(["revision-comparison", "compatibility-report"]),
  "deterministic-replay": Object.freeze(["causal-trace", "deterministic-replay"]),
  "scoped-api-laboratory-delivery": Object.freeze(["runtime-contract", "artifact-scope", "protected-contracts", "delivery-commit", "delivery-clean"]),
});

const verifierIdentity = [
  "api-contract-simulation-laboratory-verifier-v1",
  ...mandatoryGates.map(({ id, description }) => `${id}:${description}`),
  JSON.stringify(contractV1), JSON.stringify(contractV2), JSON.stringify(invalidResponseContract), JSON.stringify(propertyContract), JSON.stringify(propertyCandidateContract),
  JSON.stringify(API_CONTRACT_SIMULATION_LABORATORY_GATE_CHECK_PATTERNS),
  API_CONTRACT_SIMULATION_LABORATORY_VERIFIER_SOURCE_SHA256,
  gradeApiContractSimulationLaboratoryWorkspace.toString(),
  materializeApiContractSimulationLaboratoryFixture.toString(),
  preparePristineQualificationWorkspace.toString(),
  rejectEscapingSymlinks.toString(),
  verifyApiContractSimulationLaboratoryPublicSeam.toString(),
  launchLaboratory.toString(),
  jsonRequest.toString(),
  canonical.toString(),
  requireMissing.toString(),
  required.toString(),
  runCommandDefault.toString(),
].join("\n");

export const apiContractSimulationLaboratoryCase = bindAutonomousCaseSnapshot(definition, createAutonomousCaseSnapshot({
  id: definition.id,
  name: definition.name,
  description: definition.description,
  category: "coding",
  taskType: definition.taskType,
  artifacts: {
    task: { kind: "visible-task", text: VISIBLE_TASK, contentDigest: hash(VISIBLE_TASK) },
    workspace: {
      kind: "frozen-workspace",
      materializerId: "api-contract-simulation-laboratory-v1",
      source: definition.fixture.source,
      revision: definition.fixture.revision,
      contentDigest: fixtureDigest,
      environmentDigest: hash(JSON.stringify(QUALIFICATION_ENVIRONMENT)),
    },
    reference: {
      kind: "sealed-reference",
      artifactId: "api-contract-simulation-laboratory-reference-v1",
      format: "markdown",
      contentDigest: referenceDigest,
      sealedPath: "eval-cases/api-contract-simulation-laboratory/solution/reference.md",
    },
    verifier: {
      kind: "sealed-verifier",
      artifactId: "api-contract-simulation-laboratory-verifier-v1",
      verifierId: "api-contract-simulation-laboratory-v1",
      contentDigest: hash(verifierIdentity),
      sealedPath: "packages/eval-runner/src/project-cases/api-contract-simulation-laboratory.ts",
      mandatoryGates,
    },
    outcomeRubric: {
      kind: "outcome-rubric",
      rubricVersion: "api-contract-simulation-laboratory-outcome-v1",
      contentDigest: hash("behavior:3\nquality:1"),
      criteria: [
        { id: "behavior", label: "Laboratory correctness", description: "The laboratory is correct across contract, HTTP, failure, replay, and compatibility boundaries.", weight: 3 },
        { id: "quality", label: "Product quality", description: "The interface, implementation, tests, and documentation form a coherent usable project.", weight: 1 },
      ],
    },
  },
}));

export const apiContractSimulationLaboratoryCaseIds = new Set([API_CONTRACT_SIMULATION_LABORATORY_CASE_ID]);

export interface ApiContractSimulationLaboratoryFixtureReceipt {
  readonly schemaVersion: 1;
  readonly fixtureId: typeof API_CONTRACT_SIMULATION_LABORATORY_CASE_ID;
  readonly workspaceDirectory: string;
  readonly repositoryUrl: string;
  readonly sourceRevision: string;
  readonly seededCommit: string;
  readonly seededTree: string;
  readonly packageManager: "node@22-builtins-only";
  readonly installedWithFrozenLockfile: false;
  readonly environmentDigest: `sha256:${string}`;
}

export async function materializeApiContractSimulationLaboratoryFixture(options: {
  readonly workspaceDirectory: string;
  readonly platform?: NodeJS.Platform;
  readonly runCommand?: CommandRunner;
}): Promise<ApiContractSimulationLaboratoryFixtureReceipt> {
  if ((options.platform ?? process.platform) !== "darwin") throw new Error("The API contract simulation laboratory is local Mac only.");
  await requireMissing(options.workspaceDirectory);
  await mkdir(options.workspaceDirectory, { recursive: true, mode: 0o700 });
  for (const [relativePath, contents] of Object.entries(fixtureFiles)) {
    const target = join(options.workspaceDirectory, relativePath);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, contents, "utf8");
  }
  const runCommand = options.runCommand ?? runCommandDefault;
  await required(runCommand, "git", ["init", "--quiet", "--initial-branch=main"], options.workspaceDirectory);
  await required(runCommand, "git", ["config", "user.name", "Relayer Eval Fixture"], options.workspaceDirectory);
  await required(runCommand, "git", ["config", "user.email", "eval-fixture@relayer.local"], options.workspaceDirectory);
  await required(runCommand, "git", ["add", "--all"], options.workspaceDirectory);
  await required(runCommand, "git", ["commit", "--quiet", "-m", `Seed ${API_CONTRACT_SIMULATION_LABORATORY_CASE_ID}`], options.workspaceDirectory, {
    GIT_AUTHOR_DATE: "2026-08-28T12:00:00Z",
    GIT_COMMITTER_DATE: "2026-08-28T12:00:00Z",
  });
  const seededCommit = (await required(runCommand, "git", ["rev-parse", "HEAD"], options.workspaceDirectory)).stdout.trim();
  const seededTree = (await required(runCommand, "git", ["rev-parse", "HEAD^{tree}"], options.workspaceDirectory)).stdout.trim();
  return Object.freeze({
    schemaVersion: 1 as const,
    fixtureId: API_CONTRACT_SIMULATION_LABORATORY_CASE_ID,
    workspaceDirectory: options.workspaceDirectory,
    repositoryUrl: definition.fixture.source,
    sourceRevision: definition.fixture.revision,
    seededCommit,
    seededTree,
    packageManager: "node@22-builtins-only" as const,
    installedWithFrozenLockfile: false as const,
    environmentDigest: hash(JSON.stringify(QUALIFICATION_ENVIRONMENT)),
  });
}

interface RunningLaboratory {
  readonly baseUrl: string;
  readonly stop: () => Promise<void>;
}

export type LaboratoryLauncher = (workspaceDirectory: string) => Promise<RunningLaboratory>;

export async function gradeApiContractSimulationLaboratoryWorkspace(options: {
  readonly workspaceDirectory: string;
  readonly baseRevision?: string;
  readonly runCommand?: CommandRunner;
  readonly launch?: LaboratoryLauncher;
}): Promise<readonly EvalCheck[]> {
  const runCommand = options.runCommand ?? runCommandDefault;
  const baseRevision = options.baseRevision ?? (await required(runCommand, "git", ["rev-list", "--max-parents=0", "HEAD"], options.workspaceDirectory)).stdout.trim();
  const status = (await required(runCommand, "git", ["status", "--porcelain=v1", "--untracked-files=all"], options.workspaceDirectory)).stdout.trim();
  const commits = lines((await required(runCommand, "git", ["rev-list", `${baseRevision}..HEAD`], options.workspaceDirectory)).stdout);
  const changedPaths = lines((await required(runCommand, "git", ["diff", "--name-only", baseRevision, "HEAD", "--"], options.workspaceDirectory)).stdout);
  const packageManifest = await readFile(join(options.workspaceDirectory, "package.json"), "utf8")
    .then((source) => JSON.parse(source) as Record<string, any>)
    .catch(() => null);
  const startScript = packageManifest?.scripts?.start;
  const runtimeEntry = typeof startScript === "string" ? /^node ([A-Za-z0-9._/-]+\.(?:mjs|js))$/.exec(startScript)?.[1] : undefined;
  const dependencySections = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
  const runtimeEntryValid = runtimeEntry !== undefined && await resolveRuntimeEntry(options.workspaceDirectory, runtimeEntry).then(() => true).catch(() => false);
  const runtimeContract = runtimeEntry !== undefined && runtimeEntryValid
    && !runtimeEntry.startsWith("/")
    && !runtimeEntry.split("/").includes("..")
    && packageManifest?.scripts?.prestart === undefined
    && packageManifest?.scripts?.poststart === undefined
    && dependencySections.every((section) => !packageManifest?.[section] || Object.keys(packageManifest[section]).length === 0);
  const forbiddenArtifact = changedPaths.find((path) => /(^|\/)(?:node_modules|vendor|dist|build|coverage|\.npm-cache)(?:\/|$)/.test(path)
    || /(^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(path)
    || /\.(?:node|dylib|so|dll|exe|pyc)$/.test(path));
  const protectedContracts = await Promise.all(Object.entries(fixtureFiles)
    .filter(([path]) => path.startsWith("contracts/"))
    .map(async ([path, expected]) => ({ path, unchanged: await Promise.all([
      readFile(join(options.workspaceDirectory, path), "utf8"),
      lstat(join(options.workspaceDirectory, path)),
    ]).then(([actual, metadata]) => actual === expected && metadata.isFile()).catch(() => false) })));

  let qualificationDirectory: string | null = null;
  let running: RunningLaboratory | null = null;
  const behavior: EvalCheck[] = [];
  try {
    qualificationDirectory = await preparePristineQualificationWorkspace({
      candidateDirectory: options.workspaceDirectory,
      baseRevision,
      runCommand,
    });
    running = await (options.launch ?? launchLaboratory)(qualificationDirectory);
    behavior.push(...await verifyApiContractSimulationLaboratoryPublicSeam(running.baseUrl));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    for (const name of [
      "contract-import", "mock-routing", "property-contract", "request-validation", "response-validation",
      "latency-injection", "failure-injection", "bounded-redirect", "bounded-streaming",
      "revision-comparison", "compatibility-report", "causal-trace", "deterministic-replay",
    ]) behavior.push({ name: `workspace:${name}`, passed: false, detail: `Public-seam verification unavailable: ${detail}` });
  } finally {
    await running?.stop().catch(() => {});
    if (qualificationDirectory) await rm(dirname(qualificationDirectory), { recursive: true, force: true });
  }

  return Object.freeze([
    ...behavior,
    { name: "workspace:runtime-contract", passed: runtimeContract, detail: runtimeContract ? `The runtime is dependency-free and starts through the single pinned Node entry: ${startScript}.` : `package.json must declare no dependencies and an exact single Node start command; found ${JSON.stringify(startScript)}.` },
    { name: "workspace:artifact-scope", passed: forbiddenArtifact === undefined, detail: forbiddenArtifact === undefined ? "The committed diff contains no dependency, generated, or native-binary artifacts." : `Forbidden delivery artifact: ${forbiddenArtifact}.` },
    { name: "workspace:protected-contracts", passed: protectedContracts.every(({ unchanged }) => unchanged), detail: protectedContracts.map(({ path, unchanged }) => `${path}: ${unchanged ? "unchanged" : "changed"}`).join(", ") },
    { name: "workspace:delivery-commit", passed: commits.length >= 1, detail: `${commits.length} post-fixture commit(s).` },
    { name: "workspace:delivery-clean", passed: status === "", detail: status === "" ? "The candidate workspace is clean." : `Uncommitted changes remain: ${status}` },
  ]);
}

async function preparePristineQualificationWorkspace(options: {
  readonly candidateDirectory: string;
  readonly baseRevision: string;
  readonly runCommand: CommandRunner;
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "relayer-api-lab-qualification-"));
  const workspace = join(root, "workspace");
  try {
    const receipt = await materializeApiContractSimulationLaboratoryFixture({ workspaceDirectory: workspace, platform: "darwin", runCommand: options.runCommand });
    if (receipt.seededTree !== (await required(options.runCommand, "git", ["rev-parse", `${options.baseRevision}^{tree}`], options.candidateDirectory)).stdout.trim()) {
      throw new Error("Candidate base tree does not match the frozen API laboratory fixture.");
    }
    const patch = await required(options.runCommand, "git", ["diff", "--binary", options.baseRevision, "HEAD", "--"], options.candidateDirectory);
    const patchPath = join(root, "candidate.patch");
    await writeFile(patchPath, patch.stdout, { encoding: "utf8", mode: 0o600 });
    if (patch.stdout.trim()) await required(options.runCommand, "git", ["apply", "--binary", "--whitespace=error-all", patchPath], workspace);
    await rejectEscapingSymlinks(workspace);
    return workspace;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function rejectEscapingSymlinks(root: string): Promise<void> {
  const canonicalRoot = await realpath(root);
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await realpath(path).catch(() => "");
        if (target !== canonicalRoot && !target.startsWith(`${canonicalRoot}/`)) throw new Error(`Qualification workspace contains an escaping or broken symbolic link: ${path}.`);
      } else if (entry.isDirectory()) await visit(path);
    }
  };
  await visit(root);
}

export async function verifyApiContractSimulationLaboratoryPublicSeam(baseUrl: string): Promise<readonly EvalCheck[]> {
  const checks: EvalCheck[] = [];
  const attempt = async (name: string, action: () => Promise<string>) => {
    try { checks.push({ name: `workspace:${name}`, passed: true, detail: await action() }); }
    catch (error) { checks.push({ name: `workspace:${name}`, passed: false, detail: error instanceof Error ? error.message : String(error) }); }
  };
  let v1Imported = false;
  let v2Imported = false;
  const causallyObserved: any[] = [];
  const readMockTrace = async () => {
    const trace = await jsonRequest(baseUrl, "GET", "/_lab/trace");
    if (trace.status !== 200 || !Array.isArray(trace.body?.entries)) throw new Error(`Trace endpoint failed: ${trace.status}/${JSON.stringify(trace.body)}.`);
    return trace.body.entries.filter((entry: any) => typeof entry.operationId === "string");
  };
  const causalProbe = async (
    action: () => ReturnType<typeof jsonRequest>,
    expected: Readonly<Record<string, unknown>>,
    expectedResponse: { readonly status: number; readonly operationId?: string; readonly body?: unknown; readonly issues?: true },
  ) => {
    const before = await readMockTrace();
    const response = await action();
    const after = await readMockTrace();
    const observed = after.at(-1);
    const previousSequence = before.at(-1)?.sequence ?? 0;
    if (after.length !== before.length + 1 || !observed || observed.sequence !== previousSequence + 1
      || Object.entries(expected).some(([key, value]) => observed[key] !== value)) {
      throw new Error(`One public operation must cause exactly one matching trace entry: before=${before.length}, after=${after.length}, observed=${JSON.stringify(observed)}, expected=${JSON.stringify(expected)}.`);
    }
    if (response.status !== expectedResponse.status || observed.status !== response.status
      || (expectedResponse.operationId && response.headers.get("x-lab-operation-id") !== expectedResponse.operationId)
      || ("body" in expectedResponse && canonical(response.body) !== canonical(expectedResponse.body))
      || (expectedResponse.issues && (!Array.isArray(response.body?.issues) || response.body.issues.length === 0))) {
      throw new Error(`Causal operation response disagreed with its declared behavior or new trace entry: response=${response.status}/${JSON.stringify(response.body)}, observed=${JSON.stringify(observed)}.`);
    }
    causallyObserved.push(observed);
  };

  await attempt("contract-import", async () => {
    const v1 = await jsonRequest(baseUrl, "POST", "/_lab/contracts", contractV1);
    const v2 = await jsonRequest(baseUrl, "POST", "/_lab/contracts", contractV2);
    v1Imported = v1.status === 201 && v1.body?.revision === "orders-v1" && v1.body?.operationCount === 4;
    v2Imported = v2.status === 201 && v2.body?.revision === "orders-v2" && v2.body?.operationCount === 3;
    const malformed = await jsonRequest(baseUrl, "POST", "/_lab/contracts", { revision: "malformed" });
    const property = await jsonRequest(baseUrl, "POST", "/_lab/contracts", propertyContract);
    const propertyCandidate = await jsonRequest(baseUrl, "POST", "/_lab/contracts", propertyCandidateContract);
    const directional = malformed.status === 422 && Array.isArray(malformed.body?.issues) && malformed.body.issues.some((issue: unknown) => JSON.stringify(issue).includes("request"));
    if (!v1Imported || !v2Imported || !directional || property.status !== 201 || property.body?.operationCount !== 2 || propertyCandidate.status !== 201 || propertyCandidate.body?.operationCount !== 1) throw new Error(`Expected both frozen revisions, two derived property revisions, and directional malformed rejection: v1=${v1.status}/${JSON.stringify(v1.body)}, v2=${v2.status}/${JSON.stringify(v2.body)}, property=${property.status}/${JSON.stringify(property.body)}, candidate=${propertyCandidate.status}/${JSON.stringify(propertyCandidate.body)}, malformed=${malformed.status}/${JSON.stringify(malformed.body)}.`);
    return "Both immutable revisions and two evaluator-derived property revisions imported; a malformed document failed directionally.";
  });
  await attempt("response-validation", async () => {
    const response = await jsonRequest(baseUrl, "POST", "/_lab/contracts", invalidResponseContract);
    if (response.status !== 422 || !Array.isArray(response.body?.issues) || !response.body.issues.some((issue: unknown) => JSON.stringify(issue).includes("response"))) {
      throw new Error(`Invalid response example was not rejected directionally: ${response.status}/${JSON.stringify(response.body)}.`);
    }
    return "An invalid declared response example was rejected with a response-directed issue.";
  });
  if (v1Imported) await jsonRequest(baseUrl, "PUT", "/_lab/active", { revision: "orders-v1" });

  await attempt("mock-routing", async () => {
    const first = await jsonRequest(baseUrl, "GET", "/users/user-7", undefined, { "x-client-version": "1.4" });
    const second = await jsonRequest(baseUrl, "GET", "/users/user-9", undefined, { "x-client-version": "1.9" });
    if (first.status !== 200 || second.status !== 200) throw new Error(`Expected both parameterized paths to route: ${first.status}, ${second.status}.`);
    requireOperationIdentity(first, "get-user", "first parameterized route");
    requireOperationIdentity(second, "get-user", "second parameterized route");
    if (canonical(first.body) !== canonical({ id: "user-7", name: "Ada" }) || canonical(second.body) !== canonical(first.body)) throw new Error("Parameterized routing did not return the exact deterministic declared response.");
    const missing = await jsonRequest(baseUrl, "GET", "/unknown", undefined, { "x-client-version": "1.0" });
    if (missing.status !== 404) throw new Error(`Unknown paths must remain outside the route table; received ${missing.status}.`);
    return "Two path-parameter boundaries routed deterministically and an unknown path remained 404.";
  });
  await attempt("property-contract", async () => {
    const activated = await jsonRequest(baseUrl, "PUT", "/_lab/active", { revision: "inventory-property-v1" });
    const invalid = await jsonRequest(baseUrl, "GET", "/inventory/bad", undefined, { "x-tenant": "tenant" });
    const valid = await jsonRequest(baseUrl, "GET", "/inventory/ZX-314", undefined, { "x-tenant": "tenant" });
    if (activated.status !== 200 || activated.body?.revision !== "inventory-property-v1" || invalid.status !== 400 || valid.status !== 200 || canonical(valid.body) !== canonical({ sku: "ZX-314", available: 8 })) {
      throw new Error(`Derived contract behavior failed: active=${activated.status}/${JSON.stringify(activated.body)}, invalid=${invalid.status}, valid=${valid.status}/${JSON.stringify(valid.body)}.`);
    }
    requireOperationIdentity(valid, "get-inventory", "derived property route");
    await jsonRequest(baseUrl, "PUT", "/_lab/active", { revision: "orders-v1" });
    return "A hidden derived contract proved generic import, path compilation, header validation, activation, and exact response behavior.";
  });
  await attempt("request-validation", async () => {
    const cases = [
      await jsonRequest(baseUrl, "GET", "/users/user-7"),
      await jsonRequest(baseUrl, "GET", "/users/INVALID!", undefined, { "x-client-version": "1.0" }),
      await jsonRequest(baseUrl, "GET", "/users/user-7?expand=everything", undefined, { "x-client-version": "1.0" }),
      await jsonRequest(baseUrl, "GET", "/users/user-7?expand=basic", undefined, { "x-client-version": "1.0" }),
      await jsonRequest(baseUrl, "POST", "/orders", { sku: "A", quantity: 0 }),
      await jsonRequest(baseUrl, "POST", "/orders", { sku: "AB", quantity: 2 }),
    ];
    if (cases[0]!.status !== 400 || cases[1]!.status !== 400 || cases[2]!.status !== 400 || cases[3]!.status !== 200 || cases[4]!.status !== 400 || cases[5]!.status !== 201) {
      throw new Error(`Request boundary matrix failed: ${cases.map(({ status }) => status).join(",")}.`);
    }
    requireOperationIdentity(cases[3]!, "get-user", "valid query route");
    requireOperationIdentity(cases[5]!, "create-order", "valid body route");
    if ([cases[0]!, cases[1]!, cases[2]!, cases[4]!].some(({ body }) => !Array.isArray(body?.issues) || body.issues.length === 0)) throw new Error("Invalid requests need machine-readable issues.");
    if (canonical(cases[5]!.body) !== canonical({ orderId: "order-100", accepted: true })) throw new Error(`Valid order response did not match the declared example: ${JSON.stringify(cases[5]!.body)}.`);
    return "Missing header, malformed path, rejected and accepted query values, invalid JSON body, and valid body boundaries were independently exercised.";
  });
  await attempt("latency-injection", async () => {
    await jsonRequest(baseUrl, "PUT", "/_lab/scenario", { operationId: "get-user", latencyMs: 80, failures: [] });
    const start = performance.now();
    const response = await jsonRequest(baseUrl, "GET", "/users/user-7", undefined, { "x-client-version": "1.0" });
    const elapsed = performance.now() - start;
    if (response.status !== 200 || elapsed < 65) throw new Error(`Configured 80 ms latency was not observable (status=${response.status}, elapsed=${elapsed.toFixed(1)} ms).`);
    requireOperationIdentity(response, "get-user", "delayed route");
    await jsonRequest(baseUrl, "PUT", "/_lab/scenario", { operationId: "get-user", latencyMs: 0, failures: [] });
    const resetStart = performance.now();
    const resetResponse = await jsonRequest(baseUrl, "GET", "/users/user-7", undefined, { "x-client-version": "1.0" });
    const resetElapsed = performance.now() - resetStart;
    if (resetResponse.status !== 200 || elapsed < resetElapsed + 50 || resetElapsed > 250) throw new Error(`Latency reset was not materially faster and bounded: delayed=${elapsed.toFixed(1)} ms, reset=${resetElapsed.toFixed(1)} ms.`);
    requireOperationIdentity(resetResponse, "get-user", "reset zero-latency route");
    return `An 80 ms injection took ${elapsed.toFixed(1)} ms and reset to ${resetElapsed.toFixed(1)} ms.`;
  });
  await attempt("failure-injection", async () => {
    const scenario = { operationId: "get-user", latencyMs: 0, failures: [{ status: 503, body: { code: "busy" } }, { status: 429, body: { code: "slow" } }] };
    const invalidScenarios = [
      await jsonRequest(baseUrl, "PUT", "/_lab/scenario", { operationId: "get-user", latencyMs: -1, failures: [] }),
      await jsonRequest(baseUrl, "PUT", "/_lab/scenario", { operationId: "get-user", latencyMs: 1.5, failures: [] }),
      await jsonRequest(baseUrl, "PUT", "/_lab/scenario", { operationId: "get-user", latencyMs: 0, failures: [{ status: 99, body: {} }] }),
      await jsonRequest(baseUrl, "PUT", "/_lab/scenario", { operationId: "missing-operation", latencyMs: 0, failures: [] }),
    ];
    if (invalidScenarios.some(({ status }) => status !== 400)) throw new Error(`Invalid scenario boundary matrix was accepted: ${invalidScenarios.map(({ status }) => status).join(",")}.`);
    const execute = async () => {
      const configured = await jsonRequest(baseUrl, "PUT", "/_lab/scenario", scenario);
      if (configured.status !== 200) throw new Error(`Valid scenario configuration failed: ${configured.status}.`);
      const responses = [];
      for (let index = 0; index < 3; index += 1) responses.push(await jsonRequest(baseUrl, "GET", "/users/user-7", undefined, { "x-client-version": "1.0" }));
      return responses.map(({ status, body, headers }) => ({ status, body, operationId: status < 400 ? headers.get("x-lab-operation-id") : null }));
    };
    const first = await execute();
    const second = await execute();
    const expected = [{ status: 503, body: { code: "busy" }, operationId: null }, { status: 429, body: { code: "slow" }, operationId: null }, { status: 200, body: { id: "user-7", name: "Ada" }, operationId: "get-user" }];
    if (canonical(first) !== canonical(second) || canonical(first) !== canonical(expected)) throw new Error(`Ordered failure schedule or bodies were not resettable and deterministic: ${canonical(first)} / ${canonical(second)}.`);
    return "Invalid scenarios failed and the exact 503/busy, 429/slow, success schedule repeated after replacement.";
  });
  await attempt("bounded-redirect", async () => {
    const response = await fetch(`${baseUrl}/legacy`, { redirect: "manual", signal: AbortSignal.timeout(2_000) });
    if (response.status !== 307 || response.headers.get("location") !== "/users/user-7") throw new Error(`Redirect contract mismatch: ${response.status}/${response.headers.get("location")}.`);
    requireOperationIdentity(response, "legacy-redirect", "redirect route");
    return "The one-hop redirect preserved its declared 307 status and Location.";
  });
  await attempt("bounded-streaming", async () => {
    const response = await fetch(`${baseUrl}/events`, { signal: AbortSignal.timeout(2_000) });
    if (response.status !== 200 || response.body === null) throw new Error(`Streaming response unavailable (${response.status}).`);
    const reader = response.body.getReader();
    const chunks: string[] = [];
    const decoder = new TextDecoder();
    while (true) { const item = await reader.read(); if (item.done) break; chunks.push(decoder.decode(item.value, { stream: true })); }
    chunks.push(decoder.decode());
    const expected = contractV1.operations.find(({ operationId }) => operationId === "event-stream")!.response.chunks!.join("");
    const actual = chunks.join("");
    requireOperationIdentity(response, "event-stream", "stream route");
    if (!/chunked/i.test(response.headers.get("transfer-encoding") ?? "") || actual !== expected) throw new Error(`Expected chunked transfer with all declared chunks in order; transfer-encoding=${response.headers.get("transfer-encoding")}, body=${JSON.stringify(actual)}.`);
    return "Chunked transfer preserved all four declared chunks in order without depending on client read coalescing.";
  });
  await attempt("revision-comparison", async () => {
    if (!v2Imported) throw new Error("orders-v2 was not imported.");
    const response = await jsonRequest(baseUrl, "POST", "/_lab/compare", { base: "orders-v1", candidate: "orders-v2" });
    const changes = Array.isArray(response.body?.changes) ? response.body.changes : [];
    const removed = changes.some((change: any) => change.breaking === true && /legacy/.test(String(change.path)) && /remove/i.test(String(change.kind)));
    const required = changes.some((change: any) => change.breaking === true && /region/.test(String(change.path)) && /required/i.test(String(change.kind)));
    const additive = changes.some((change: any) => change.breaking === false && /displayName/.test(String(change.path)));
    const activated = await jsonRequest(baseUrl, "PUT", "/_lab/active", { revision: "orders-v2" });
    const v2Response = await jsonRequest(baseUrl, "GET", "/users/user-7", undefined, { "x-client-version": "1.0" });
    await jsonRequest(baseUrl, "PUT", "/_lab/active", { revision: "orders-v1" });
    requireOperationIdentity(v2Response, "get-user", "activated v2 route");
    if (response.status !== 200 || !removed || !required || !additive || activated.body?.revision !== "orders-v2" || canonical(v2Response.body) !== canonical({ id: "user-7", name: "Ada", displayName: "Ada L." })) throw new Error(`Revision change or activated v2 behavior coverage incomplete: comparison=${JSON.stringify(response.body)}, activation=${JSON.stringify(activated.body)}, response=${JSON.stringify(v2Response.body)}.`);
    return "Removed operation, newly required request field, and optional response addition were independently reported.";
  });
  await attempt("compatibility-report", async () => {
    const forward = await jsonRequest(baseUrl, "POST", "/_lab/compare", { base: "orders-v1", candidate: "orders-v2" });
    const same = await jsonRequest(baseUrl, "POST", "/_lab/compare", { base: "orders-v1", candidate: "orders-v1" });
    const property = await jsonRequest(baseUrl, "POST", "/_lab/compare", { base: "inventory-property-v1", candidate: "inventory-property-v2" });
    const propertyChanges = Array.isArray(property.body?.changes) ? property.body.changes : [];
    const propertyRemoved = propertyChanges.some((change: any) => change.breaking === true && /legacy-stock/.test(String(change.path)) && /remove/i.test(String(change.kind)));
    const propertyRequired = propertyChanges.some((change: any) => change.breaking === true && /region/.test(String(change.path)) && /required/i.test(String(change.kind)));
    const propertyAdditive = propertyChanges.some((change: any) => change.breaking === false && /warehouse/.test(String(change.path)));
    if (forward.body?.compatible !== false || same.body?.compatible !== true || !Array.isArray(same.body?.changes) || same.body.changes.length !== 0 || property.body?.compatible !== false || !propertyRemoved || !propertyRequired || !propertyAdditive) {
      throw new Error(`Compatibility booleans or derived change classification do not follow reported changes: forward=${JSON.stringify(forward.body)}, same=${JSON.stringify(same.body)}, property=${JSON.stringify(property.body)}.`);
    }
    return "Compatibility is false for both visible and hidden breaking revisions, true for identity, and independently classifies hidden removed/required/additive changes.";
  });
  await attempt("causal-trace", async () => {
    const challenge = randomBytes(5).toString("hex");
    await jsonRequest(baseUrl, "PUT", "/_lab/active", { revision: "orders-v1" });
    await jsonRequest(baseUrl, "PUT", "/_lab/scenario", { operationId: "get-user", latencyMs: 0, failures: [] });
    await causalProbe(
      () => jsonRequest(baseUrl, "GET", `/users/c-${challenge}?expand=full`, undefined, { "x-client-version": "1.0" }),
      { revision: "orders-v1", operationId: "get-user", method: "GET", path: `/users/c-${challenge}`, status: 200, requestValid: true, responseValid: true },
      { status: 200, operationId: "get-user", body: { id: "user-7", name: "Ada" } },
    );
    await causalProbe(
      () => jsonRequest(baseUrl, "POST", "/orders", { sku: challenge.slice(0, 4), quantity: 0 }),
      { revision: "orders-v1", operationId: "create-order", method: "POST", path: "/orders", status: 400, requestValid: false, responseValid: true },
      { status: 400, issues: true },
    );
    await jsonRequest(baseUrl, "PUT", "/_lab/scenario", { operationId: "get-user", latencyMs: 0, failures: [{ status: 451, body: { code: "causal" } }] });
    await causalProbe(
      () => jsonRequest(baseUrl, "GET", `/users/f-${challenge}`, undefined, { "x-client-version": "1.0" }),
      { revision: "orders-v1", operationId: "get-user", method: "GET", path: `/users/f-${challenge}`, status: 451, requestValid: true, responseValid: false },
      { status: 451, operationId: "get-user", body: { code: "causal" } },
    );
    await jsonRequest(baseUrl, "PUT", "/_lab/active", { revision: "orders-v2" });
    await jsonRequest(baseUrl, "PUT", "/_lab/scenario", { operationId: "get-user", latencyMs: 0, failures: [] });
    await causalProbe(
      () => jsonRequest(baseUrl, "GET", `/users/v-${challenge}`, undefined, { "x-client-version": "1.0" }),
      { revision: "orders-v2", operationId: "get-user", method: "GET", path: `/users/v-${challenge}`, status: 200, requestValid: true, responseValid: true },
      { status: 200, operationId: "get-user", body: { id: "user-7", name: "Ada", displayName: "Ada L." } },
    );
    await jsonRequest(baseUrl, "PUT", "/_lab/active", { revision: "orders-v1" });
    return "Four evaluator-chosen valid, invalid, injected-failure, and revision-switched requests each caused exactly one consecutive trace entry.";
  });
  await attempt("deterministic-replay", async () => {
    const trace = await jsonRequest(baseUrl, "GET", "/_lab/trace");
    const entries = Array.isArray(trace.body?.entries) ? trace.body.entries : [];
    const mockEntries = entries.filter((entry: any) => typeof entry.operationId === "string");
    const ordered = mockEntries.every((entry: any, index: number) => Number.isInteger(entry.sequence) && (index === 0 || entry.sequence > mockEntries[index - 1].sequence));
    const requiredEvidence = [
      { operationId: "get-user", method: "GET", path: "/users/user-7", status: 503, revision: "orders-v1", requestValid: true, responseValid: false },
      { operationId: "get-user", method: "GET", path: "/users/user-7", status: 429, revision: "orders-v1", requestValid: true, responseValid: false },
      { operationId: "create-order", method: "POST", path: "/orders", status: 400, revision: "orders-v1", requestValid: false, responseValid: true },
      { operationId: "create-order", method: "POST", path: "/orders", status: 201, revision: "orders-v1", requestValid: true, responseValid: true },
      { operationId: "get-inventory", method: "GET", path: "/inventory/bad", status: 400, revision: "inventory-property-v1", requestValid: false, responseValid: true },
      { operationId: "get-inventory", method: "GET", path: "/inventory/ZX-314", status: 200, revision: "inventory-property-v1", requestValid: true, responseValid: true },
      { operationId: "get-user", method: "GET", path: "/users/user-7", status: 200, revision: "orders-v2", requestValid: true, responseValid: true },
      { operationId: "legacy-redirect", method: "GET", path: "/legacy", status: 307, revision: "orders-v1", requestValid: true, responseValid: true },
      { operationId: "event-stream", method: "GET", path: "/events", status: 200, revision: "orders-v1", requestValid: true, responseValid: true },
    ];
    const includes = (expected: Readonly<Record<string, unknown>>) => mockEntries.some((entry: any) => Object.entries(expected).every(([key, value]) => entry[key] === value));
    if (mockEntries.length < 10 || !ordered || requiredEvidence.some((expected) => !includes(expected)) || mockEntries.some((entry: any) => typeof entry.requestValid !== "boolean" || typeof entry.responseValid !== "boolean")) {
      throw new Error(`Trace lacks independently validated operation evidence: ${JSON.stringify(mockEntries.slice(-3))}.`);
    }
    if (causallyObserved.length !== 4) throw new Error("Causal trace evidence was unavailable for replay verification.");
    const fromSequence = causallyObserved[0].sequence;
    const toSequence = causallyObserved.at(-1).sequence;
    const first = await jsonRequest(baseUrl, "POST", "/_lab/replay", { fromSequence, toSequence });
    const second = await jsonRequest(baseUrl, "POST", "/_lab/replay", { fromSequence, toSequence });
    const expected = causallyObserved.map(({ method, path, status, operationId, revision }: any) => ({ method, path, status, operationId, revision }));
    const expectedDigest = createHash("sha256").update(JSON.stringify(expected)).digest("hex");
    const middle = await jsonRequest(baseUrl, "POST", "/_lab/replay", { fromSequence: causallyObserved[1].sequence, toSequence: causallyObserved[2].sequence });
    const suffix = await jsonRequest(baseUrl, "POST", "/_lab/replay", { fromSequence: causallyObserved.at(-2).sequence });
    const expectedMiddle = expected.slice(1, 3);
    const expectedSuffix = expected.slice(-2);
    if (first.status !== 200 || second.status !== 200 || first.text !== second.text || first.body?.digest !== expectedDigest || canonical(first.body?.exchanges) !== canonical(expected)
      || middle.status !== 200 || middle.body?.digest !== createHash("sha256").update(JSON.stringify(expectedMiddle)).digest("hex") || canonical(middle.body?.exchanges) !== canonical(expectedMiddle)
      || suffix.status !== 200 || suffix.body?.digest !== createHash("sha256").update(JSON.stringify(expectedSuffix)).digest("hex") || canonical(suffix.body?.exchanges) !== canonical(expectedSuffix)) {
      throw new Error(`Replay was not byte-stable and digest-bearing: ${canonical(first.body)} / ${canonical(second.body)}.`);
    }
    await jsonRequest(baseUrl, "PUT", "/_lab/scenario", { operationId: "get-user", latencyMs: 0, failures: [{ status: 418, body: { code: "reserved" } }] });
    await jsonRequest(baseUrl, "POST", "/_lab/replay", { fromSequence, toSequence });
    const afterReplay = await jsonRequest(baseUrl, "GET", "/users/user-7", undefined, { "x-client-version": "1.0" });
    if (afterReplay.status !== 418) throw new Error(`Replay consumed or altered a pending failure scenario; next status was ${afterReplay.status}.`);
    return `${first.body.exchanges.length} exact normalized exchanges plus inclusive middle and open-ended suffix ranges replayed byte-stably with SHA-256 ${first.body.digest} without consuming scenario state.`;
  });
  return checks;
}

async function launchLaboratory(workspaceDirectory: string): Promise<RunningLaboratory> {
  const environment = await verifyQualificationEnvironment();
  const canonicalWorkspace = await realpath(workspaceDirectory);
  const manifest = JSON.parse(await readFile(join(workspaceDirectory, "package.json"), "utf8"));
  const startScript = manifest?.scripts?.start;
  const runtimeEntry = typeof startScript === "string" ? /^node ([A-Za-z0-9._/-]+\.(?:mjs|js))$/.exec(startScript)?.[1] : undefined;
  if (!runtimeEntry || manifest?.scripts?.prestart !== undefined || manifest?.scripts?.poststart !== undefined) throw new Error("The declared runtime must be one Node entry without start lifecycle hooks.");
  const runtimeEntryPath = await resolveRuntimeEntry(workspaceDirectory, runtimeEntry);
  return new Promise((resolve, reject) => {
    const profile = [
      "(version 1)",
      "(allow default)",
      "(deny process-exec)",
      `(allow process-exec (literal ${JSON.stringify(environment.nodeExecutable)}))`,
      "(deny network*)",
      '(allow network-inbound (local tcp "localhost:*"))',
      "(deny file-write*)",
      `(allow file-write* (subpath ${JSON.stringify(canonicalWorkspace)}))`,
      '(allow file-write-data (literal "/dev/null"))',
    ].join("\n");
    const child = spawn(QUALIFICATION_ENVIRONMENT.sandboxExecPath, [
      "-p", profile,
      environment.nodeExecutable,
      "--experimental-permission",
      `--allow-fs-read=${canonicalWorkspace}`,
      `--allow-fs-write=${canonicalWorkspace}`,
      runtimeEntryPath,
      "--port", "0",
    ], {
      cwd: canonicalWorkspace,
      env: {
        PATH: [dirname(environment.nodeExecutable), "/usr/bin", "/bin"].join(delimiter),
        NODE_ENV: "test",
        TMPDIR: join(workspaceDirectory, ".tmp"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => finish(new Error(`Laboratory did not become ready within 5 seconds. ${stderr}`)), 5_000);
    const finish = (error: Error | null, baseUrl?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) { child.kill("SIGKILL"); reject(error); return; }
      resolve({
        baseUrl: baseUrl!,
        stop: () => new Promise<void>((done) => {
          if (child.exitCode !== null || child.signalCode !== null) { done(); return; }
          const force = setTimeout(() => child.kill("SIGKILL"), 1_000);
          child.once("exit", () => { clearTimeout(force); done(); });
          child.kill("SIGTERM");
        }),
      });
    };
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-4_000); });
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => finish(new Error(`Laboratory exited before readiness (${code ?? signal}). ${stderr}`)));
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        const ready = JSON.parse(line);
        const url = new URL(ready.baseUrl);
        if (ready.type !== "ready" || url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) throw new Error("invalid ready record");
        finish(null, url.toString().replace(/\/$/, ""));
      } catch { /* npm and candidates may print other startup lines */ }
    });
  });
}

function verifyQualificationEnvironment(): Promise<{ readonly nodeExecutable: string; readonly npmCli: string }> {
  return inspectQualificationEnvironment();
}

export async function preflightApiContractSimulationLaboratoryEnvironment(): Promise<
  { readonly available: true; readonly environmentDigest: `sha256:${string}` }
  | { readonly available: false; readonly reason: string }
> {
  try {
    await verifyQualificationEnvironment();
    return { available: true, environmentDigest: hash(JSON.stringify(QUALIFICATION_ENVIRONMENT)) };
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

async function inspectQualificationEnvironment(): Promise<{ readonly nodeExecutable: string; readonly npmCli: string }> {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error(`API laboratory qualification requires ${QUALIFICATION_ENVIRONMENT.platform}; found ${process.platform}-${process.arch}.`);
  }
  const nodeExecutable = await resolvePathExecutable("node");
  const version = await runCommandDefault(nodeExecutable, ["--version"], { cwd: tmpdir() });
  if (version.exitCode !== 0 || version.stdout.trim() !== QUALIFICATION_ENVIRONMENT.nodeVersion) {
    throw new Error(`API laboratory qualification requires Node ${QUALIFICATION_ENVIRONMENT.nodeVersion}; found ${version.stdout.trim() || version.stderr.trim() || "unavailable"}.`);
  }
  const npmCli = join(dirname(nodeExecutable), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  const identities = await Promise.all([
    fileSha256(nodeExecutable),
    fileSha256(npmCli),
    fileSha256(QUALIFICATION_ENVIRONMENT.sandboxExecPath),
  ]);
  const expected = [QUALIFICATION_ENVIRONMENT.nodeSha256, QUALIFICATION_ENVIRONMENT.npmCliSha256, QUALIFICATION_ENVIRONMENT.sandboxExecSha256];
  if (identities.some((identity, index) => identity !== expected[index])) {
    throw new Error(`API laboratory qualification toolchain digest mismatch: ${identities.join(",")}.`);
  }
  return { nodeExecutable, npmCli };
}

async function resolvePathExecutable(name: string): Promise<string> {
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, name);
    try { await access(candidate); return await realpath(candidate); } catch { /* keep searching the explicit inherited PATH */ }
  }
  throw new Error(`API laboratory qualification could not resolve ${name} from the explicit inherited PATH.`);
}

async function fileSha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function resolveRuntimeEntry(root: string, entry: string): Promise<string> {
  if (entry.startsWith("/") || entry.split("/").includes("..")) throw new Error("The Node runtime entry must be repo-relative and contained in the candidate workspace.");
  const canonicalRoot = await realpath(root);
  const target = await realpath(join(root, entry));
  const metadata = await lstat(target);
  if (!metadata.isFile() || (target !== canonicalRoot && !target.startsWith(`${canonicalRoot}/`))) throw new Error("The Node runtime entry must resolve to a regular file inside the candidate workspace.");
  return target;
}

async function jsonRequest(baseUrl: string, method: string, path: string, body?: unknown, headers: Readonly<Record<string, string>> = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    redirect: "manual",
    signal: AbortSignal.timeout(2_000),
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: any = null;
  try { parsed = text === "" ? null : JSON.parse(text); } catch { parsed = text; }
  return { status: response.status, headers: response.headers, body: parsed, text };
}

function requireOperationIdentity(response: { readonly headers: Headers }, operationId: string, context: string): void {
  const actual = response.headers.get("x-lab-operation-id");
  if (actual !== operationId) throw new Error(`${context} omitted its declared operation identity: expected ${operationId}, found ${actual}.`);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  return JSON.stringify(value);
}

async function requireMissing(path: string): Promise<void> {
  try { await access(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  throw new Error(`Refusing to overwrite existing API laboratory workspace: ${path}`);
}

async function required(runCommand: CommandRunner, command: string, args: readonly string[], cwd: string, environment: Readonly<Record<string, string>> = {}): Promise<CommandResult> {
  const result = await runCommand(command, args, { cwd, env: { ...process.env, ...environment } as Readonly<Record<string, string>> });
  if (result.exitCode !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`);
  return result;
}

function lines(value: string): string[] { return value.split("\n").map((line) => line.trim()).filter(Boolean); }

function runCommandDefault(command: string, args: readonly string[], options: { readonly cwd: string; readonly env?: Readonly<Record<string, string>> }): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd: options.cwd, env: options.env ? { ...process.env, ...options.env } : process.env, stdio: ["ignore", "pipe", "pipe"] });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 10 * 60_000);
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout = `${stdout}${chunk}`.slice(-4 * 1024 * 1024); });
    child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-4 * 1024 * 1024); });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code, signal) => { clearTimeout(timeout); resolve({ exitCode: code ?? (signal ? 1 : 0), stdout, stderr: signal ? `${stderr}\nProcess stopped by ${signal}.` : stderr }); });
  });
}
