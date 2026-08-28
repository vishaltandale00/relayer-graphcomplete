import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { bindAutonomousCaseSnapshot } from "../cases/catalog.js";
import { createAutonomousCaseSnapshot } from "../cases/contracts.js";
import type { EvalCheck } from "../runtime-basic.js";
import type { CommandResult, CommandRunner, ProjectEvalThreadDefinition } from "./h3.js";

export const HTTPCORE_CANCELLATION_CASE_ID = "autonomous.httpcore.cancellation-poisoned-pool";
export const HTTPCORE_REPOSITORY_URL = "https://github.com/encode/httpcore.git";
export const HTTPCORE_UPSTREAM_COMMIT = "79fa6bf0dfcf3820d1ae7e52a2d268f33022c5a4";
export const HTTPCORE_UPSTREAM_TREE = "834aaf7041c78aa49597e691e6ce9fc41d6c0bc6";
export const HTTPCORE_PYTHON_VERSION = "3.12.2";
export const HTTPCORE_LICENSE = "BSD-3-Clause";
export const HTTPCORE_UV_VERSION = "0.12.0";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const CASE_ROOT = join(REPOSITORY_ROOT, "eval-cases", "httpcore-cancellation-pool");
const VERIFIER_PATH = join(CASE_ROOT, "verifier", "verify.py");
const REGRESSION_VERIFIER_PATH = join(CASE_ROOT, "verifier", "regression.py");
const REQUIREMENTS_PATH = join(CASE_ROOT, "environment", "requirements.lock");
const REFERENCE_PATH = join(CASE_ROOT, "solution", "upstream-evidence.md");
const ADMISSION_RECEIPT_PATH = join(CASE_ROOT, "admission", "receipt.json");
const ADMISSION_VARIANTS = Object.freeze([
  { id: "green-connection-state", expected: "green", path: join(CASE_ROOT, "admission", "green-connection-state.patch"), sha256: "b928c8eb08caea07e9041136e77c97ff293898390d72594f4f4fa5e7d205c5aa", rejects: [] },
  { id: "green-pool-removal", expected: "green", path: join(CASE_ROOT, "admission", "green-pool-removal.patch"), sha256: "25177b60a16f4556e1848bf5695d8e9a5ec1332b636df9d3f0c95bc6bfb53a7d", rejects: [] },
  { id: "mutant-root-hooks", expected: "red", path: join(CASE_ROOT, "admission", "mutant-root-hooks.patch"), sha256: "93b9d30a8fca4acf3d2e4cbffa04ba77730dd8f655a1e809c63eb1f74ecced98", rejects: ["connection-slot-release", "subsequent-request-success", "repeated-cancellation"] },
  { id: "mutant-package-hooks", expected: "red", path: join(CASE_ROOT, "admission", "mutant-package-hooks.patch"), sha256: "6ca88d6aa30cbaaf0c9173dbd77a2464ef1920c569e9de08c1e13e653f036bea", rejects: ["connection-slot-release", "subsequent-request-success", "repeated-cancellation"] },
  { id: "mutant-mainmodule-exit", expected: "red", path: join(CASE_ROOT, "admission", "mutant-mainmodule-exit.patch"), sha256: "940dbc1cabc3e1e59b1e37520cb2fc5dd946282d7640b30f7faa4e46951dfdc7", rejects: ["connection-slot-release", "subsequent-request-success", "repeated-cancellation", "regression-safety"] },
  { id: "mutant-repeat-once", expected: "red", path: join(CASE_ROOT, "admission", "mutant-repeat-once.patch"), sha256: "af1f0dfbc3683583f6884f54d70877102c54294e9a080a36715a1de182628ead", rejects: ["repeated-cancellation"] },
  { id: "mutant-over-capacity", expected: "red", path: join(CASE_ROOT, "admission", "mutant-over-capacity.patch"), sha256: "d8ba86e60a58ca8d98a443a05db648b3fad8cf48bd6704619a5218ceeabfb180", rejects: ["connection-slot-release", "repeated-cancellation", "regression-safety"] },
  { id: "mutant-skip-close", expected: "red", path: join(CASE_ROOT, "admission", "mutant-skip-close.patch"), sha256: "7c7b247a88165b4c48e68a77c56d4c8e1a70d313a56a38643deb7e96f4ec8563", rejects: ["cleanup", "regression-safety"] },
  { id: "mutant-hanging-cleanup", expected: "red", path: join(CASE_ROOT, "admission", "mutant-hanging-cleanup.patch"), sha256: "37611f22bd3d88ff5d9ea841f6304b6e5801b05ee1532ad503f1c859bf673c92", rejects: ["cleanup", "regression-safety"] },
] as const);
const VERIFIER_SHA256 = "b859fbcb32e8559203893b0a60857e9688697c24decab9b5cdce912070b878bc";
const REGRESSION_VERIFIER_SHA256 = "effced73865277136cba74126b263b0b4efcf276e0de81451dd0589628ae970e";
const REQUIREMENTS_SHA256 = "1574363aaad673aee0654c936447f11fa3ed09bcf582d5e75c3e743509c1a99b";
const REFERENCE_SHA256 = "5f7e4bff4863c0bea231779641a044401628d1485070e77b30992e39e7e65a09";
const ADMISSION_RECEIPT_SHA256 = "5ba67fc3e4b0868c436a785fef55e8dde6c51ce3451c30b7e246cecf3fe8a904";
const PREDICATE_IDS = Object.freeze([
  "deterministic-cancellation",
  "connection-slot-release",
  "subsequent-request-success",
  "repeated-cancellation",
  "cleanup",
]);
const VERIFIER_PROCESS_TIMEOUT_MS = 20_000;
const VERIFIER_RUNNER_GRACE_MS = 1_000;
const AUTHORITY_BOUNDARY = "Behavioral verifier admission is not a security sandbox for arbitrarily hostile candidate code executing inside the Python worker.";
const UNRESOLVED_FINDINGS = Object.freeze([
  "A candidate with arbitrary code execution may attack Python process internals beyond the sealed practical hook mutants; host execution isolation remains a separate product authority boundary.",
]);

const prompt = "Fix the cancellation race in this HTTPCore checkout. Cancellation after asynchronous TCP connection setup begins must not poison a one-slot connection pool: the slot must be released, a later request must succeed, repeated cancellation must remain safe, and pool shutdown must clean up loopback connections. Run the relevant focused regression checks and create one meaningful local commit. Keep the change scoped, preserve existing public behavior, and do not push or publish anything.";

export interface HTTPCoreCaseDefinition {
  readonly schemaVersion: 1;
  readonly id: typeof HTTPCORE_CANCELLATION_CASE_ID;
  readonly name: string;
  readonly description: string;
  readonly localOnly: true;
  readonly supportedPlatform: "darwin";
  readonly autonomous: true;
  readonly category: "coding";
  readonly taskType: "debugging";
  readonly fixture: {
    readonly repositoryUrl: typeof HTTPCORE_REPOSITORY_URL;
    readonly upstreamCommit: typeof HTTPCORE_UPSTREAM_COMMIT;
    readonly upstreamTree: typeof HTTPCORE_UPSTREAM_TREE;
    readonly packageManager: "uv";
    readonly python: typeof HTTPCORE_PYTHON_VERSION;
    readonly license: typeof HTTPCORE_LICENSE;
  };
  readonly threads: readonly ProjectEvalThreadDefinition[];
}

export const httpcoreCancellationEvalCase: HTTPCoreCaseDefinition = Object.freeze({
  schemaVersion: 1,
  id: HTTPCORE_CANCELLATION_CASE_ID,
  name: "HTTPCore · cancellation-poisoned connection pool",
  description: "Repairs the historical async-connect cancellation window without prescribing the upstream patch.",
  localOnly: true,
  supportedPlatform: "darwin",
  autonomous: true,
  category: "coding",
  taskType: "debugging",
  fixture: Object.freeze({
    repositoryUrl: HTTPCORE_REPOSITORY_URL,
    upstreamCommit: HTTPCORE_UPSTREAM_COMMIT,
    upstreamTree: HTTPCORE_UPSTREAM_TREE,
    packageManager: "uv",
    python: HTTPCORE_PYTHON_VERSION,
    license: HTTPCORE_LICENSE,
  }),
  threads: Object.freeze([Object.freeze({
    id: "implementation",
    name: "Repair async connection cancellation",
    permissionProfileId: "auto",
    mutationPolicy: "writable",
    workspaceGrade: "autonomous-implementation",
    prompts: Object.freeze([prompt]),
  })]),
});

const digest = (value: string) => `sha256:${value}` as const;
const hash = (value: string) => digest(createHash("sha256").update(value).digest("hex"));

export const httpcoreCancellationCase = bindAutonomousCaseSnapshot(
  httpcoreCancellationEvalCase,
  createAutonomousCaseSnapshot({
    id: httpcoreCancellationEvalCase.id,
    name: httpcoreCancellationEvalCase.name,
    description: httpcoreCancellationEvalCase.description,
    category: "coding",
    taskType: "debugging",
    artifacts: {
      task: { kind: "visible-task", text: prompt, contentDigest: hash(prompt) },
      workspace: {
        kind: "frozen-workspace",
        materializerId: "httpcore-git-python-v1",
        source: HTTPCORE_REPOSITORY_URL,
        revision: `git-tree:${HTTPCORE_UPSTREAM_TREE}`,
        contentDigest: hash(`${HTTPCORE_REPOSITORY_URL}\n${HTTPCORE_UPSTREAM_COMMIT}\n${HTTPCORE_UPSTREAM_TREE}\n${HTTPCORE_LICENSE}`),
        environmentDigest: hash(`cpython:${HTTPCORE_PYTHON_VERSION}\nuv:${HTTPCORE_UV_VERSION}\nrequirements:${REQUIREMENTS_SHA256}`),
      },
      reference: {
        kind: "sealed-reference",
        artifactId: "httpcore-cancellation-upstream-evidence-v1",
        format: "markdown",
        contentDigest: digest(REFERENCE_SHA256),
        sealedPath: "eval-cases/httpcore-cancellation-pool/solution/upstream-evidence.md",
      },
      verifier: {
        kind: "sealed-verifier",
        artifactId: "httpcore-cancellation-public-seam-verifier-v1",
        verifierId: "httpcore-cancellation-public-seam-v1",
        contentDigest: hash(`verify.py:${VERIFIER_SHA256}\nregression.py:${REGRESSION_VERIFIER_SHA256}\nrequirements.lock:${REQUIREMENTS_SHA256}\npredicates:${PREDICATE_IDS.join(",")}\nadmission:${ADMISSION_VARIANTS.map(({ sha256 }) => sha256).join(",")}\nruntime:${verifierRuntimeDigest()}`),
        sealedPath: "eval-cases/httpcore-cancellation-pool/verifier/verify.py",
        mandatoryGates: [
          { id: "cancellation-recovery", label: "Cancellation recovery", description: "Exact connect-time cancellation releases capacity and later loopback requests succeed across repeated cycles." },
          { id: "resource-cleanup", label: "Resource cleanup", description: "Pool shutdown closes the real loopback transport and clears its public connection inventory." },
          { id: "focused-regression-safety", label: "Focused regression safety", description: "The pinned upstream async connection and pool tests pass in a pristine verifier workspace." },
          { id: "committed-delivery", label: "Scoped committed delivery", description: "The candidate leaves a clean workspace with a substantive post-fixture commit." },
        ],
      },
      outcomeRubric: {
        kind: "outcome-rubric",
        rubricVersion: "httpcore-cancellation-outcome-v1",
        contentDigest: hash("behavior:3\nimplementation-quality:1"),
        criteria: [
          { id: "behavior", label: "Cancellation safety", description: "Cancellation releases pool capacity, later requests succeed, and cleanup remains reliable.", weight: 3 },
          { id: "implementation-quality", label: "Implementation quality", description: "The repair is focused, maintainable, and regression-safe without changing public behavior.", weight: 1 },
        ],
      },
    },
  }),
);

export const httpcoreCancellationCases = Object.freeze([httpcoreCancellationCase]);
export const httpcoreCancellationCaseIds = new Set([HTTPCORE_CANCELLATION_CASE_ID]);

export interface HTTPCoreFixtureReceipt {
  readonly schemaVersion: 1;
  readonly fixtureId: typeof HTTPCORE_CANCELLATION_CASE_ID;
  readonly workspaceDirectory: string;
  readonly environmentDirectory: string;
  readonly pythonExecutable: string;
  readonly repositoryUrl: typeof HTTPCORE_REPOSITORY_URL;
  readonly upstreamCommit: typeof HTTPCORE_UPSTREAM_COMMIT;
  readonly seededTree: typeof HTTPCORE_UPSTREAM_TREE;
  readonly sourceRevision: `git-tree:${typeof HTTPCORE_UPSTREAM_TREE}`;
  readonly pythonVersion: typeof HTTPCORE_PYTHON_VERSION;
  readonly requirementsDigest: `sha256:${string}`;
  readonly environmentDigest: `sha256:${string}`;
  readonly uvVersion: typeof HTTPCORE_UV_VERSION;
  readonly installedWithFrozenLockfile: true;
}

export async function materializeHTTPCoreCancellationFixture(options: {
  readonly cacheDirectory: string;
  readonly workspaceDirectory: string;
  readonly environmentDirectory?: string;
  readonly platform?: NodeJS.Platform;
  readonly runCommand?: CommandRunner;
}): Promise<HTTPCoreFixtureReceipt> {
  if ((options.platform ?? process.platform) !== "darwin") throw new Error("The HTTPCore cancellation case is local Mac only.");
  const runCommand = options.runCommand ?? run;
  const environmentDirectory = options.environmentDirectory ?? join(dirname(options.workspaceDirectory), "environment");
  await verifySealedFiles();
  const uvVersion = (await required(runCommand, "uv", ["--version"], REPOSITORY_ROOT)).stdout.trim();
  const installedUvVersion = /^uv\s+(\S+)/.exec(uvVersion)?.[1];
  if (installedUvVersion !== HTTPCORE_UV_VERSION) {
    throw new Error(`Pinned HTTPCore uv mismatch: expected uv ${HTTPCORE_UV_VERSION}, received ${uvVersion}.`);
  }
  await ensureCache(options.cacheDirectory, runCommand);
  await requireMissing(options.workspaceDirectory, "HTTPCore execution workspace");
  await requireMissing(environmentDirectory, "HTTPCore execution environment");
  await mkdir(dirname(options.workspaceDirectory), { recursive: true, mode: 0o700 });
  await required(runCommand, "git", ["clone", "--local", "--no-hardlinks", "--no-checkout", options.cacheDirectory, options.workspaceDirectory], dirname(options.workspaceDirectory));
  await required(runCommand, "git", ["checkout", "--quiet", "--detach", HTTPCORE_UPSTREAM_COMMIT], options.workspaceDirectory);
  await verifySource(options.workspaceDirectory, runCommand);
  await required(runCommand, "uv", ["venv", "--python", HTTPCORE_PYTHON_VERSION, environmentDirectory], dirname(environmentDirectory));
  const pythonExecutable = join(environmentDirectory, "bin", "python");
  await required(runCommand, "uv", ["pip", "install", "--python", pythonExecutable, "--require-hashes", "--requirement", REQUIREMENTS_PATH], options.workspaceDirectory);
  const version = (await required(runCommand, pythonExecutable, ["-c", "import platform; print(platform.python_version())"], options.workspaceDirectory)).stdout.trim();
  if (version !== HTTPCORE_PYTHON_VERSION) throw new Error(`Pinned HTTPCore Python mismatch: expected ${HTTPCORE_PYTHON_VERSION}, received ${version}.`);
  const status = (await required(runCommand, "git", ["status", "--porcelain=v1", "--untracked-files=all"], options.workspaceDirectory)).stdout.trim();
  if (status) throw new Error(`Frozen HTTPCore materialization is dirty: ${status}`);
  return {
    schemaVersion: 1,
    fixtureId: HTTPCORE_CANCELLATION_CASE_ID,
    workspaceDirectory: options.workspaceDirectory,
    environmentDirectory,
    pythonExecutable,
    repositoryUrl: HTTPCORE_REPOSITORY_URL,
    upstreamCommit: HTTPCORE_UPSTREAM_COMMIT,
    seededTree: HTTPCORE_UPSTREAM_TREE,
    sourceRevision: `git-tree:${HTTPCORE_UPSTREAM_TREE}`,
    pythonVersion: HTTPCORE_PYTHON_VERSION,
    requirementsDigest: digest(REQUIREMENTS_SHA256),
    environmentDigest: httpcoreCancellationCase.snapshot.artifacts.workspace.environmentDigest,
    uvVersion: HTTPCORE_UV_VERSION,
    installedWithFrozenLockfile: true,
  };
}

export async function gradeHTTPCoreCancellationWorkspace(options: {
  readonly workspaceDirectory: string;
  readonly pythonExecutable?: string;
  readonly runCommand?: CommandRunner;
}): Promise<readonly EvalCheck[]> {
  const runCommand = options.runCommand ?? run;
  const pythonExecutable = options.pythonExecutable ?? join(dirname(options.workspaceDirectory), "environment", "bin", "python");
  const status = (await required(runCommand, "git", ["status", "--porcelain=v1", "--untracked-files=all"], options.workspaceDirectory)).stdout.trim();
  const commits = lines((await required(runCommand, "git", ["rev-list", `${HTTPCORE_UPSTREAM_COMMIT}..HEAD`], options.workspaceDirectory)).stdout);
  const verifier = await withPristineVerifierWorkspace(options.workspaceDirectory, runCommand, async (directory, baselineDirectory) => {
    const env = { PYTHONDONTWRITEBYTECODE: "1" };
    const behavior = await runBoundedCommand(runCommand, pythonExecutable, ["-I", VERIFIER_PATH, directory], REPOSITORY_ROOT, env);
    const regression = await runBoundedCommand(runCommand, pythonExecutable, ["-I", REGRESSION_VERIFIER_PATH, directory, baselineDirectory], REPOSITORY_ROOT, env);
    return { behavior, regression };
  });
  const predicates = parseVerifierPredicates(verifier.behavior);
  return [
    ...PREDICATE_IDS.map((id) => ({
      name: `workspace:httpcore-${id}`,
      passed: predicates.get(id)?.passed === true,
      detail: predicates.get(id)?.detail ?? commandDetail("sealed public-seam verifier", verifier.behavior),
    })),
    {
      name: "workspace:httpcore-regression-safety",
      passed: regressionPasses(verifier.regression),
      detail: commandDetail("pinned upstream async connection/pool tests", verifier.regression),
    },
    {
      name: "workspace:httpcore-meaningful-commit",
      passed: commits.length >= 1,
      detail: `${commits.length} post-fixture commit(s).`,
    },
    {
      name: "workspace:httpcore-clean",
      passed: status === "",
      detail: status === "" ? "The candidate workspace is clean." : `Uncommitted changes remain: ${status}`,
    },
  ];
}

export interface HTTPCoreAdmissionReceipt {
  readonly schemaVersion: 1;
  readonly caseId: typeof HTTPCORE_CANCELLATION_CASE_ID;
  readonly source: {
    readonly commit: typeof HTTPCORE_UPSTREAM_COMMIT;
    readonly tree: typeof HTTPCORE_UPSTREAM_TREE;
    readonly license: typeof HTTPCORE_LICENSE;
  };
  readonly environment: {
    readonly python: typeof HTTPCORE_PYTHON_VERSION;
    readonly uv: typeof HTTPCORE_UV_VERSION;
    readonly requirementsDigest: `sha256:${string}`;
  };
  readonly verifierDigest: `sha256:${string}`;
  readonly authorityBoundary: typeof AUTHORITY_BOUNDARY;
  readonly unresolvedFindings: typeof UNRESOLVED_FINDINGS;
  readonly result: "pass" | "fail";
  readonly variants: readonly {
    readonly id: string;
    readonly expected: "red" | "green";
    readonly actual: "red" | "green";
    readonly patchDigest: `sha256:${string}` | null;
    readonly failedChecks: readonly string[];
  }[];
}

interface AdmissionVariantEvaluation {
  readonly id: string;
  readonly expected: "red" | "green";
  readonly actual: "red" | "green";
  readonly patchDigest: `sha256:${string}` | null;
  readonly checks: readonly EvalCheck[];
}

export async function runHTTPCoreAdmissionPortfolio(options: {
  readonly cacheDirectory: string;
  readonly rootDirectory: string;
  readonly platform?: NodeJS.Platform;
  readonly runCommand?: CommandRunner;
}): Promise<HTTPCoreAdmissionReceipt> {
  const runCommand = options.runCommand ?? run;
  const baselineRoot = join(options.rootDirectory, "untouched-baseline");
  const fixture = await materializeHTTPCoreCancellationFixture({
    cacheDirectory: options.cacheDirectory,
    workspaceDirectory: join(baselineRoot, "workspace"),
    environmentDirectory: join(options.rootDirectory, "environment"),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    runCommand,
  });
  const variants: AdmissionVariantEvaluation[] = [];
  const baselineChecks = await gradeHTTPCoreCancellationWorkspace({
    workspaceDirectory: fixture.workspaceDirectory,
    pythonExecutable: fixture.pythonExecutable,
    runCommand,
  });
  variants.push({
    id: "untouched-baseline",
    expected: "red",
    actual: rejectsExactly(baselineChecks, ["connection-slot-release", "subsequent-request-success", "repeated-cancellation"], ["deterministic-cancellation", "cleanup", "regression-safety"]),
    patchDigest: null,
    checks: baselineChecks,
  });

  for (const variant of ADMISSION_VARIANTS) {
    const directory = join(options.rootDirectory, variant.id, "workspace");
    await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
    await required(runCommand, "git", ["clone", "--local", "--no-hardlinks", "--no-checkout", options.cacheDirectory, directory], dirname(directory));
    await required(runCommand, "git", ["checkout", "--quiet", "--detach", HTTPCORE_UPSTREAM_COMMIT], directory);
    await required(runCommand, "git", ["apply", "--binary", variant.path], directory);
    await required(runCommand, "git", ["add", "--all"], directory);
    await required(runCommand, "git", ["commit", "-m", `Admission ${variant.id}`], directory, fixtureCommitEnvironment());
    const checks = await gradeHTTPCoreCancellationWorkspace({
      workspaceDirectory: directory,
      pythonExecutable: fixture.pythonExecutable,
      runCommand,
    });
    const patchDigest = digest(createHash("sha256").update(await readFile(variant.path)).digest("hex"));
    variants.push({
      id: variant.id,
      expected: variant.expected,
      actual: variant.expected === "green" ? (qualifies(checks) ? "green" : "red") : rejectsExactly(checks, variant.rejects),
      patchDigest,
      checks,
    });
  }
  const passed = variants.every((variant) => variant.actual === variant.expected)
    && variants.filter((variant) => variant.expected === "green").length >= 2
    && ADMISSION_VARIANTS.filter((variant) => variant.expected === "red").every((variant) => variant.rejects.length > 0);
  return {
    schemaVersion: 1,
    caseId: HTTPCORE_CANCELLATION_CASE_ID,
    source: { commit: HTTPCORE_UPSTREAM_COMMIT, tree: HTTPCORE_UPSTREAM_TREE, license: HTTPCORE_LICENSE },
    environment: {
      python: HTTPCORE_PYTHON_VERSION,
      uv: HTTPCORE_UV_VERSION,
      requirementsDigest: digest(REQUIREMENTS_SHA256),
    },
    verifierDigest: httpcoreCancellationCase.snapshot.artifacts.verifier.contentDigest,
    authorityBoundary: AUTHORITY_BOUNDARY,
    unresolvedFindings: UNRESOLVED_FINDINGS,
    result: passed ? "pass" : "fail",
    variants: variants.map(({ id, expected, actual, patchDigest, checks }) => ({
      id,
      expected,
      actual,
      patchDigest,
      failedChecks: checks.filter(({ passed: checkPassed }) => !checkPassed).map(({ name }) => name.replace("workspace:httpcore-", "")),
    })),
  };
}

async function withPristineVerifierWorkspace<T>(
  sourceDirectory: string,
  runCommand: CommandRunner,
  evaluate: (directory: string, baselineDirectory: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "relayer-httpcore-verifier-"));
  const directory = join(root, "workspace");
  const baselineDirectory = join(root, "baseline");
  const patchPath = join(root, "candidate.patch");
  try {
    const patch = await required(runCommand, "git", ["diff", "--binary", HTTPCORE_UPSTREAM_COMMIT, "HEAD", "--"], sourceDirectory);
    await required(runCommand, "git", ["clone", "--local", "--no-hardlinks", "--no-checkout", sourceDirectory, directory], root);
    await required(runCommand, "git", ["checkout", "--quiet", "--detach", HTTPCORE_UPSTREAM_COMMIT], directory);
    await required(runCommand, "git", ["clone", "--local", "--no-hardlinks", "--no-checkout", sourceDirectory, baselineDirectory], root);
    await required(runCommand, "git", ["checkout", "--quiet", "--detach", HTTPCORE_UPSTREAM_COMMIT], baselineDirectory);
    if (patch.stdout.length > 0) {
      await writeFile(patchPath, patch.stdout, "utf8");
      await required(runCommand, "git", ["apply", "--binary", patchPath], directory);
    }
    return await evaluate(directory, baselineDirectory);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function parseVerifierPredicates(result: CommandResult): Map<string, { passed: boolean; detail: string }> {
  try {
    const receipt = JSON.parse(result.stdout.trim()) as { schemaVersion?: unknown; predicates?: Record<string, { passed?: unknown; detail?: unknown }> };
    if (receipt.schemaVersion !== 1 || receipt.predicates === undefined) return new Map();
    return new Map(Object.entries(receipt.predicates).map(([id, predicate]) => [id, {
      passed: predicate.passed === true,
      detail: typeof predicate.detail === "string" ? predicate.detail : "Verifier predicate omitted detail.",
    }]));
  } catch {
    return new Map();
  }
}

async function verifySealedFiles(): Promise<void> {
  const files = [
    [VERIFIER_PATH, VERIFIER_SHA256, "verifier"],
    [REGRESSION_VERIFIER_PATH, REGRESSION_VERIFIER_SHA256, "regression verifier"],
    [REQUIREMENTS_PATH, REQUIREMENTS_SHA256, "requirements lock"],
    [REFERENCE_PATH, REFERENCE_SHA256, "upstream reference"],
    [ADMISSION_RECEIPT_PATH, ADMISSION_RECEIPT_SHA256, "admission receipt"],
  ] as const;
  for (const [path, expected, label] of files) {
    const actual = createHash("sha256").update(await readFile(path)).digest("hex");
    if (actual !== expected) throw new Error(`Sealed HTTPCore ${label} digest mismatch: expected ${expected}, received ${actual}.`);
  }
  for (const variant of ADMISSION_VARIANTS) {
    const actual = createHash("sha256").update(await readFile(variant.path)).digest("hex");
    if (actual !== variant.sha256) throw new Error(`Sealed HTTPCore admission patch ${variant.id} digest mismatch: expected ${variant.sha256}, received ${actual}.`);
  }
}

async function ensureCache(directory: string, runCommand: CommandRunner): Promise<void> {
  try {
    await access(directory);
    await verifySource(directory, runCommand);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  const temporary = `${directory}.tmp-${randomUUID()}`;
  await mkdir(temporary, { mode: 0o700 });
  try {
    await required(runCommand, "git", ["init", "--quiet"], temporary);
    await required(runCommand, "git", ["remote", "add", "origin", HTTPCORE_REPOSITORY_URL], temporary);
    await required(runCommand, "git", ["fetch", "--quiet", "--depth", "1", "origin", HTTPCORE_UPSTREAM_COMMIT], temporary);
    await required(runCommand, "git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"], temporary);
    await verifySource(temporary, runCommand);
    try {
      await rename(temporary, directory);
    } catch (error) {
      if (!new Set(["EEXIST", "ENOTEMPTY"]).has((error as NodeJS.ErrnoException).code ?? "")) throw error;
      await verifySource(directory, runCommand);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function verifySource(directory: string, runCommand: CommandRunner): Promise<void> {
  const commit = (await required(runCommand, "git", ["rev-parse", "HEAD"], directory)).stdout.trim();
  const tree = (await required(runCommand, "git", ["rev-parse", "HEAD^{tree}"], directory)).stdout.trim();
  if (commit !== HTTPCORE_UPSTREAM_COMMIT || tree !== HTTPCORE_UPSTREAM_TREE) {
    throw new Error(`Pinned HTTPCore source mismatch: expected ${HTTPCORE_UPSTREAM_COMMIT}/${HTTPCORE_UPSTREAM_TREE}, received ${commit}/${tree}.`);
  }
  const metadata = JSON.parse(parseTomlIdentity(
    await readFile(join(directory, "pyproject.toml"), "utf8"),
    await readFile(join(directory, "httpcore", "__init__.py"), "utf8"),
  )) as { version: string; license: string; python: string };
  if (metadata.version !== "1.0.2" || metadata.license !== HTTPCORE_LICENSE || metadata.python !== ">=3.8") {
    throw new Error("Pinned HTTPCore package metadata does not match the fixture contract.");
  }
  const license = await readFile(join(directory, "LICENSE.md"), "utf8");
  if (!license.includes("Redistribution and use in source and binary forms") || !license.includes("THIS SOFTWARE IS PROVIDED")) {
    throw new Error("Pinned HTTPCore fixture does not contain the expected BSD-3-Clause license.");
  }
}

function parseTomlIdentity(source: string, packageSource: string): string {
  const versionSource = /__version__\s*=\s*"([^"]+)"/.exec(packageSource)?.[1];
  const license = /^license\s*=\s*"([^"]+)"/m.exec(source)?.[1];
  const python = /^requires-python\s*=\s*"([^"]+)"/m.exec(source)?.[1];
  return JSON.stringify({ version: versionSource ?? "", license: license ?? "", python: python ?? "" });
}

async function required(
  runCommand: CommandRunner,
  command: string,
  args: readonly string[],
  cwd: string,
  env?: Readonly<Record<string, string>>,
): Promise<CommandResult> {
  const result = await runCommand(command, args, { cwd, ...(env === undefined ? {} : { env }) });
  if (result.exitCode !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`);
  return result;
}

async function runBoundedCommand(
  runCommand: CommandRunner,
  command: string,
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>>,
): Promise<CommandResult> {
  let timeout: NodeJS.Timeout | undefined;
  const expired = new Promise<CommandResult>((resolve) => {
    timeout = setTimeout(() => resolve({
      exitCode: 124,
      stdout: "",
      stderr: `Verifier process exceeded ${VERIFIER_PROCESS_TIMEOUT_MS}ms.`,
    }), VERIFIER_PROCESS_TIMEOUT_MS + VERIFIER_RUNNER_GRACE_MS);
  });
  try {
    return await Promise.race([
      runCommand(command, args, { cwd, env, timeoutMs: VERIFIER_PROCESS_TIMEOUT_MS }),
      expired,
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function qualifies(checks: readonly EvalCheck[]): boolean {
  return checks.length > 0 && checks.every((check) => check.passed);
}

function regressionPasses(result: CommandResult): boolean {
  const output = `${result.stdout}\n${result.stderr}`;
  return result.exitCode === 0
    && /\b51 passed\b/.test(output)
    && output.includes("RELAYER_FROZEN_REGRESSION_COMPLETE:0")
    && !/\b(?:skipped|failed|error)s?\b/i.test(output);
}

function verifierRuntimeDigest(): string {
  const contract = {
    schemaVersion: 1,
    candidateReplay: "committed-git-diff-on-pinned-pristine-checkout",
    pythonIsolation: "isolated-startup-explicit-candidate-package",
    behaviorInfrastructure: "one-loopback-server-per-predicate",
    cleanupTimeoutMs: 1_000,
    processTimeoutMs: VERIFIER_PROCESS_TIMEOUT_MS,
    runnerFallbackGraceMs: VERIFIER_RUNNER_GRACE_MS,
    processTimeoutEnforcement: "promise-race-and-production-sigkill",
    regressionSource: "separate-pinned-baseline-checkout",
    regressionQualification: "exit-zero-exactly-51-passed-no-skip-failure-error-plus-completion-marker",
    authorityBoundary: AUTHORITY_BOUNDARY,
    predicates: PREDICATE_IDS,
    admissions: ADMISSION_VARIANTS.map(({ id, expected, sha256, rejects }) => ({ id, expected, sha256, rejects })),
  };
  return createHash("sha256").update(JSON.stringify(contract)).digest("hex");
}

function rejectsExactly(checks: readonly EvalCheck[], failedIds: readonly string[], passingIds: readonly string[] = []): "red" | "green" {
  const byId = new Map(checks.map((check) => [check.name.replace("workspace:httpcore-", ""), check.passed]));
  const rejected = failedIds.every((id) => byId.get(id) === false);
  const preserved = passingIds.every((id) => byId.get(id) === true);
  return rejected && preserved ? "red" : "green";
}

function fixtureCommitEnvironment(): Readonly<Record<string, string>> {
  return {
    GIT_AUTHOR_NAME: "Relayer Eval Admission",
    GIT_AUTHOR_EMAIL: "eval-admission@relayer.local",
    GIT_AUTHOR_DATE: "2026-08-28T12:00:00Z",
    GIT_COMMITTER_NAME: "Relayer Eval Admission",
    GIT_COMMITTER_EMAIL: "eval-admission@relayer.local",
    GIT_COMMITTER_DATE: "2026-08-28T12:00:00Z",
  };
}

async function requireMissing(path: string, label: string): Promise<void> {
  try {
    await access(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Refusing to overwrite existing ${label}: ${path}`);
}

function lines(value: string): string[] {
  return value.split("\n").map((line) => line.trim()).filter(Boolean);
}

function commandDetail(label: string, result: CommandResult): string {
  const output = result.stderr.trim() || result.stdout.trim();
  return `${label} exited ${result.exitCode}${output ? `: ${output.slice(0, 1_000)}` : "."}`;
}

function run(command: string, args: readonly string[], options: { readonly cwd: string; readonly env?: Readonly<Record<string, string>>; readonly timeoutMs?: number }): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env === undefined ? process.env : { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = options.timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => {
      if (timeout !== undefined) clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      if (timeout !== undefined) clearTimeout(timeout);
      resolve({
        exitCode: timedOut ? 124 : (code ?? 1),
        stdout,
        stderr: timedOut ? `${stderr}${stderr.endsWith("\n") || stderr === "" ? "" : "\n"}Verifier process exceeded ${options.timeoutMs}ms.` : stderr,
      });
    });
  });
}
