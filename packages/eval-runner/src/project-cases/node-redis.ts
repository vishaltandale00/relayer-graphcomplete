import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

import { bindAutonomousCaseSnapshot } from "../cases/catalog.js";
import { createAutonomousCaseSnapshot } from "../cases/contracts.js";
import type { EvalCheck } from "../runtime-basic.js";
import type { CommandResult, CommandRunner, ProjectEvalThreadDefinition } from "./h3.js";

export const NODE_REDIS_COMMAND_QUEUE_RACE_CASE_ID = "autonomous.node-redis.command-queue-race";
export const NODE_REDIS_REPOSITORY_URL = "https://github.com/redis/node-redis.git";
export const NODE_REDIS_UPSTREAM_TAG_OBJECT = "115b11829508162bf0776c68500b87de08d52560";
export const NODE_REDIS_UPSTREAM_COMMIT = "4f85030e42da2eed6a178e54994330af5062761e";
export const NODE_REDIS_UPSTREAM_TREE = "3a360d5440b2d73831123df48e24b3422676bb16";
const NODE_REDIS_NODE_VERSION = "22.23.2";
const NODE_REDIS_NPM_VERSION = "10.9.8";
const NODE_REDIS_ARCHITECTURE = "arm64";
export const NODE_REDIS_VERIFIER_PREDICATE_IDS = Object.freeze([
  "fault-injection-observed",
  "failed-command-rejected-once",
  "queue-clean-before-reconnect",
  "reconnect-reply-order",
  "offline-queue-replayed-in-order",
  "reconnect-queue-drained",
  "single-failure-callbacks-settle",
  "repeated-faults-observed",
  "fault-command-matrix-observed",
  "repeated-failures-rejected-independently",
  "repeated-reconnects-start-clean",
  "ordered-replies-after-recovery",
  "no-command-reply-misassociation",
  "callbacks-settle-without-hang",
  "client-reply-modes-preserved",
] as const);

const runtimeDependencies = Object.freeze([
  Object.freeze({
    name: "denque",
    version: "1.5.1",
    integrity: "sha512-XwE+iZ4D6ZUB7mfYRMb5wByE8L74HCn30FBN7sWnXksWc1LO1bPDl67pBR9o/kC4z/xSNAwkMYcGgqDV3BE3Hw==",
    license: "Apache-2.0",
  }),
  Object.freeze({
    name: "redis-commands",
    version: "1.7.0",
    integrity: "sha512-nJWqw3bTFy21hX/CPKHth6sfhZbdiHP6bTawSgQBlKOVRG7EZkfHbbHwQJnrE4vsQf0CMNE+3gJ4Fmm16vdVlQ==",
    license: "MIT",
  }),
  Object.freeze({
    name: "redis-errors",
    version: "1.2.0",
    integrity: "sha512-1qny3OExCf0UvUV/5wpYKf2YwPcOqXzkwKKSmKHiE6ZMQs5heeE/c8eXK+PNllPvmjgAbfnsbpkGZWy8cBpn9w==",
    license: "MIT",
  }),
  Object.freeze({
    name: "redis-parser",
    version: "3.0.0",
    integrity: "sha512-DJnGAeenTdpMEH6uAJRK/uiyEIH9WVsUmoLwzudwGJUwZPp80PDBWPHXSAGNPwNvIXAbe7MSUB1zQFugFml66A==",
    license: "MIT",
  }),
]);

const environmentIdentity = Object.freeze({
  platform: "darwin",
  architecture: NODE_REDIS_ARCHITECTURE,
  node: NODE_REDIS_NODE_VERSION,
  npm: NODE_REDIS_NPM_VERSION,
  install: Object.freeze([
    "npm",
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--no-save",
    "--package-lock=false",
    "--omit=dev",
    ...runtimeDependencies.map(({ name, version }) => `${name}@${version}`),
  ]),
  runtimeDependencies,
});

const repositoryRoot = resolve(import.meta.dirname, "../../../..");
const moduleRelativePath = "packages/eval-runner/src/project-cases/node-redis.ts";
const verifierRelativePath = "eval-cases/node-redis-command-queue-race/verifier/deterministic-socket-race.cjs";
const verifierDriverRelativePath = "eval-cases/node-redis-command-queue-race/verifier/deterministic-socket-race-driver.cjs";
const verifierEvaluatorRelativePath = "eval-cases/node-redis-command-queue-race/verifier/deterministic-socket-race-evaluator.cjs";
const candidateRegressionPath = "test/command-queue-race.test.js";
const referenceRelativePath = "eval-cases/node-redis-command-queue-race/solution/reference.patch";
const admissionRelativePaths = Object.freeze([
  "eval-cases/node-redis-command-queue-race/admission/README.md",
  "eval-cases/node-redis-command-queue-race/admission/adversarial-review.json",
  "eval-cases/node-redis-command-queue-race/admission/candidate-regression.fixture.cjs",
  "eval-cases/node-redis-command-queue-race/admission/noop-regression.fixture.cjs",
  "eval-cases/node-redis-command-queue-race/admission/alternative-queue-admission.patch",
  "eval-cases/node-redis-command-queue-race/admission/mutant-clear-on-ready.patch",
  "eval-cases/node-redis-command-queue-race/admission/mutant-first-error-only.patch",
  "eval-cases/node-redis-command-queue-race/admission/mutant-no-reconnect.patch",
  "eval-cases/node-redis-command-queue-race/admission/mutant-forged-observations.patch",
  "scripts/verify-node-redis-case-admission.mjs",
]);

const taskText = "Fix the Node Redis disconnect race that can leave its public command queue out of sync when a socket error occurs during a command write. Preserve reconnect behavior and exact command/reply association across repeated failures. Add a deterministic regression at test/command-queue-race.test.js that runs directly with Node, run the relevant checks, and create exactly one meaningful local commit with a clean tree. Keep the change scoped, do not change dependencies or generated files, and do not push or publish anything. The repair must work deterministically on the pinned Node runtime rather than depending on retired Node/libuv timing.";

export interface NodeRedisCaseDefinition {
  readonly schemaVersion: 1;
  readonly id: typeof NODE_REDIS_COMMAND_QUEUE_RACE_CASE_ID;
  readonly name: string;
  readonly description: string;
  readonly localOnly: true;
  readonly supportedPlatform: "darwin";
  readonly autonomous: true;
  readonly category: "coding";
  readonly taskType: "debugging";
  readonly fixture: {
    readonly repositoryUrl: typeof NODE_REDIS_REPOSITORY_URL;
    readonly upstreamTagObject: typeof NODE_REDIS_UPSTREAM_TAG_OBJECT;
    readonly upstreamCommit: typeof NODE_REDIS_UPSTREAM_COMMIT;
    readonly upstreamTree: typeof NODE_REDIS_UPSTREAM_TREE;
    readonly node: typeof NODE_REDIS_NODE_VERSION;
    readonly packageManager: "npm@10.9.8";
    readonly license: "MIT";
  };
  readonly threads: readonly ProjectEvalThreadDefinition[];
}

export const nodeRedisCommandQueueRaceDefinition: NodeRedisCaseDefinition = Object.freeze({
  schemaVersion: 1,
  id: NODE_REDIS_COMMAND_QUEUE_RACE_CASE_ID,
  name: "Node Redis · disconnect command-queue race",
  description: "Repairs a historical socket-error interleaving that can poison command/reply association after reconnect.",
  localOnly: true,
  supportedPlatform: "darwin",
  autonomous: true,
  category: "coding",
  taskType: "debugging",
  fixture: Object.freeze({
    repositoryUrl: NODE_REDIS_REPOSITORY_URL,
    upstreamTagObject: NODE_REDIS_UPSTREAM_TAG_OBJECT,
    upstreamCommit: NODE_REDIS_UPSTREAM_COMMIT,
    upstreamTree: NODE_REDIS_UPSTREAM_TREE,
    node: NODE_REDIS_NODE_VERSION,
    packageManager: "npm@10.9.8",
    license: "MIT",
  }),
  threads: Object.freeze([Object.freeze({
    id: "implementation",
    name: "Repair disconnect queue synchronization",
    permissionProfileId: "auto",
    mutationPolicy: "writable",
    workspaceGrade: "autonomous-implementation",
    prompts: Object.freeze([taskText]),
  })]),
});

const digest = (value: string | Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}` as const;
const artifactDigest = (relativePath: string) => digest(readFileSync(resolve(repositoryRoot, relativePath)));

export function nodeRedisVerifierDigest(): `sha256:${string}` {
  return digest([
    artifactDigest(moduleRelativePath),
    artifactDigest(verifierRelativePath),
    artifactDigest(verifierDriverRelativePath),
    artifactDigest(verifierEvaluatorRelativePath),
    ...admissionRelativePaths.map(artifactDigest),
    JSON.stringify(environmentIdentity),
  ].join("\n"));
}

export const nodeRedisCommandQueueRaceCase = bindAutonomousCaseSnapshot(
  nodeRedisCommandQueueRaceDefinition,
  createAutonomousCaseSnapshot({
    id: NODE_REDIS_COMMAND_QUEUE_RACE_CASE_ID,
    name: nodeRedisCommandQueueRaceDefinition.name,
    description: nodeRedisCommandQueueRaceDefinition.description,
    category: "coding",
    taskType: "debugging",
    artifacts: {
      task: { kind: "visible-task", text: taskText, contentDigest: digest(taskText) },
      workspace: {
        kind: "frozen-workspace",
        materializerId: "node-redis-v3.1.2-command-queue-race-v1",
        source: NODE_REDIS_REPOSITORY_URL,
        revision: `git-tree:${NODE_REDIS_UPSTREAM_TREE}`,
        contentDigest: digest([
          NODE_REDIS_UPSTREAM_TAG_OBJECT,
          NODE_REDIS_UPSTREAM_COMMIT,
          NODE_REDIS_UPSTREAM_TREE,
        ].join("\n")),
        environmentDigest: digest(JSON.stringify(environmentIdentity)),
      },
      reference: {
        kind: "sealed-reference",
        artifactId: "node-redis-command-queue-race-reference-v1",
        format: "git-patch",
        contentDigest: artifactDigest(referenceRelativePath),
        sealedPath: referenceRelativePath,
      },
      verifier: {
        kind: "sealed-verifier",
        artifactId: "node-redis-command-queue-race-verifier-v1",
        verifierId: "node-redis-command-queue-race-v1",
        contentDigest: nodeRedisVerifierDigest(),
        sealedPath: verifierRelativePath,
        mandatoryGates: [
          { id: "queue-cleanup", label: "Queue cleanup", description: "Every faulted command is rejected once and the public command queue is empty before reconnect readiness." },
          { id: "reconnect-integrity", label: "Reconnect integrity", description: "Recovered connections remain usable and preserve reply ordering and queue drainage." },
          { id: "repeated-failure-safety", label: "Repeated failure safety", description: "Two distinct socket error epochs recover without command/reply misassociation or hung callbacks." },
          { id: "reply-mode-regression", label: "Reply-mode regression", description: "No-fault CLIENT REPLY ON, OFF, and SKIP bookkeeping remains correct." },
          { id: "node-redis-scoped-clean-commit", label: "Scoped clean commit", description: "The repair and focused tests are committed, dependency-safe, and leave a clean tree." },
        ],
      },
      outcomeRubric: {
        kind: "outcome-rubric",
        rubricVersion: "node-redis-command-queue-race-outcome-v1",
        contentDigest: digest("queue synchronization|reconnect integrity|implementation quality"),
        criteria: [
          { id: "synchronization", label: "Synchronization correctness", description: "Socket failures cannot poison command/reply association.", weight: 3 },
          { id: "recovery", label: "Recovery behavior", description: "Reconnect and repeated-failure behavior remains usable and ordered.", weight: 2 },
          { id: "quality", label: "Implementation quality", description: "The solution is scoped, maintainable, and regression-tested.", weight: 1 },
        ],
      },
    },
  }),
);

export const nodeRedisAutonomousCases = Object.freeze([nodeRedisCommandQueueRaceCase]);
export const nodeRedisAutonomousCaseIds = new Set([NODE_REDIS_COMMAND_QUEUE_RACE_CASE_ID]);

export interface NodeRedisFixtureReceipt {
  readonly schemaVersion: 1;
  readonly fixtureId: typeof NODE_REDIS_COMMAND_QUEUE_RACE_CASE_ID;
  readonly workspaceDirectory: string;
  readonly repositoryUrl: typeof NODE_REDIS_REPOSITORY_URL;
  readonly upstreamCommit: typeof NODE_REDIS_UPSTREAM_COMMIT;
  readonly upstreamTree: typeof NODE_REDIS_UPSTREAM_TREE;
  readonly sourceRevision: `git-tree:${typeof NODE_REDIS_UPSTREAM_TREE}`;
  readonly nodeVersion: typeof NODE_REDIS_NODE_VERSION;
  readonly npmVersion: typeof NODE_REDIS_NPM_VERSION;
  readonly architecture: typeof NODE_REDIS_ARCHITECTURE;
  readonly packageManager: "npm@10.9.8";
  readonly environmentDigest: `sha256:${string}`;
  readonly installedExactRuntimeDependencies: true;
}

export async function materializeNodeRedisProjectFixture(options: {
  readonly cacheDirectory: string;
  readonly workspaceDirectory: string;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
  readonly nodeVersion?: string;
  readonly npmVersion?: string;
  readonly runCommand?: CommandRunner;
}): Promise<NodeRedisFixtureReceipt> {
  if ((options.platform ?? process.platform) !== "darwin") throw new Error("The pinned Node Redis project case is local Mac only.");
  if ((options.architecture ?? process.arch) !== NODE_REDIS_ARCHITECTURE) throw new Error(`The pinned Node Redis project case requires ${NODE_REDIS_ARCHITECTURE}.`);
  assertNodeVersion(options.nodeVersion ?? process.versions.node);
  const runCommand = options.runCommand ?? run;
  await ensureSourceCache(options.cacheDirectory, runCommand);
  await requireMissing(options.workspaceDirectory);
  await mkdir(dirname(options.workspaceDirectory), { recursive: true, mode: 0o700 });
  await required(runCommand, "git", ["clone", "--local", "--no-hardlinks", "--no-checkout", options.cacheDirectory, options.workspaceDirectory], dirname(options.workspaceDirectory));
  await required(runCommand, "git", ["checkout", "--quiet", "--detach", NODE_REDIS_UPSTREAM_COMMIT], options.workspaceDirectory);
  await verifySource(options.workspaceDirectory, runCommand);
  await verifyManifest(options.workspaceDirectory);
  await installRuntimeDependencies(options.workspaceDirectory, runCommand, options.npmVersion);
  await verifyInstalledRuntimeDependencies(options.workspaceDirectory);
  const status = (await required(runCommand, "git", ["status", "--porcelain=v1", "--untracked-files=all"], options.workspaceDirectory)).stdout.trim();
  if (status) throw new Error(`Frozen Node Redis install changed the tracked workspace: ${status}`);
  return {
    schemaVersion: 1,
    fixtureId: NODE_REDIS_COMMAND_QUEUE_RACE_CASE_ID,
    workspaceDirectory: options.workspaceDirectory,
    repositoryUrl: NODE_REDIS_REPOSITORY_URL,
    upstreamCommit: NODE_REDIS_UPSTREAM_COMMIT,
    upstreamTree: NODE_REDIS_UPSTREAM_TREE,
    sourceRevision: `git-tree:${NODE_REDIS_UPSTREAM_TREE}`,
    nodeVersion: NODE_REDIS_NODE_VERSION,
    npmVersion: NODE_REDIS_NPM_VERSION,
    architecture: NODE_REDIS_ARCHITECTURE,
    packageManager: "npm@10.9.8",
    environmentDigest: digest(JSON.stringify(environmentIdentity)),
    installedExactRuntimeDependencies: true,
  };
}

export async function gradeNodeRedisWorkspace(options: {
  readonly workspaceDirectory: string;
  readonly runCommand?: CommandRunner;
}): Promise<readonly EvalCheck[]> {
  const runCommand = options.runCommand ?? run;
  const status = (await required(runCommand, "git", ["status", "--porcelain=v1", "--untracked-files=all"], options.workspaceDirectory)).stdout.trim();
  const commits = lines((await required(runCommand, "git", ["rev-list", "--reverse", `${NODE_REDIS_UPSTREAM_COMMIT}..HEAD`], options.workspaceDirectory)).stdout);
  const changes = parseNameStatus((await required(runCommand, "git", ["diff", "--name-status", `${NODE_REDIS_UPSTREAM_COMMIT}..HEAD`, "--"], options.workspaceDirectory)).stdout);
  const protectedFiles = new Set(["package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml"]);
  const hasSource = changes.some(({ status: changeStatus, paths }) => changeStatus !== "D" && paths.some((path) => path.endsWith(".js") && !path.startsWith("test/")));
  const hasTests = changes.some(({ status: changeStatus, paths }) => changeStatus !== "D" && paths.includes(candidateRegressionPath));
  const scoped = changes.length > 0
    && changes.every(({ status: changeStatus, paths }) => changeStatus !== "D" && paths.every((path) => !protectedFiles.has(path) && !path.startsWith("node_modules/")));

  let behaviorChecks: readonly EvalCheck[];
  try {
    behaviorChecks = await withPristineVerifierWorkspace(options.workspaceDirectory, runCommand);
  } catch (error) {
    behaviorChecks = [{
      name: "workspace:node-redis:pristine-verifier-workspace",
      passed: false,
      detail: error instanceof Error ? error.message : String(error),
    }];
  }

  return [
    ...behaviorChecks,
    {
      name: "workspace:node-redis:focused-source-and-tests",
      passed: hasSource && hasTests,
      detail: `Changed source=${hasSource}; focused tests=${hasTests}; files=${changes.map(({ status: s, paths }) => `${s}:${paths.join("->")}`).join(", ") || "none"}.`,
    },
    {
      name: "workspace:node-redis:dependency-safe-scope",
      passed: scoped,
      detail: scoped ? "The committed patch does not alter dependencies, generated modules, or delete repository files." : "The committed patch changes a protected dependency/generated boundary or deletes files.",
    },
    {
      name: "workspace:node-redis:meaningful-commit",
      passed: commits.length === 1,
      detail: `${commits.length} post-baseline commit(s); exactly one is required.`,
    },
    {
      name: "workspace:node-redis:implementation-clean",
      passed: status === "",
      detail: status === "" ? "The candidate workspace is clean." : `Workspace changes remain: ${status}`,
    },
  ];
}

async function withPristineVerifierWorkspace(candidateDirectory: string, runCommand: CommandRunner): Promise<readonly EvalCheck[]> {
  const verifierDirectory = await mkdtemp(join(dirname(candidateDirectory), ".node-redis-verifier-"));
  const baselineTestDirectory = await mkdtemp(join(dirname(candidateDirectory), ".node-redis-baseline-regression-"));
  const dependencyDirectory = await mkdtemp(join(dirname(candidateDirectory), ".node-redis-verifier-dependencies-"));
  try {
    const patch = (await required(runCommand, "git", ["diff", "--binary", NODE_REDIS_UPSTREAM_COMMIT, "HEAD", "--"], candidateDirectory)).stdout;
    const testMode = (await required(runCommand, "git", ["ls-tree", "HEAD", "--", candidateRegressionPath], candidateDirectory)).stdout.trim();
    if (!testMode.startsWith("100644 blob ")) throw new Error(`${candidateRegressionPath} must be a committed regular file.`);
    const candidateTestSource = (await required(runCommand, "git", ["show", `HEAD:${candidateRegressionPath}`], candidateDirectory)).stdout;
    await required(runCommand, "git", ["clone", "--local", "--no-hardlinks", "--no-checkout", candidateDirectory, verifierDirectory], dirname(verifierDirectory));
    await required(runCommand, "git", ["checkout", "--quiet", "--detach", NODE_REDIS_UPSTREAM_COMMIT], verifierDirectory);
    await required(runCommand, "git", ["clone", "--local", "--no-hardlinks", "--no-checkout", candidateDirectory, baselineTestDirectory], dirname(baselineTestDirectory));
    await required(runCommand, "git", ["checkout", "--quiet", "--detach", NODE_REDIS_UPSTREAM_COMMIT], baselineTestDirectory);
    await mkdir(dirname(join(baselineTestDirectory, candidateRegressionPath)), { recursive: true });
    await writeFile(join(baselineTestDirectory, candidateRegressionPath), candidateTestSource, "utf8");
    if (patch.trim()) {
      const patchPath = join(verifierDirectory, ".relayer-candidate.patch");
      await writeFile(patchPath, patch, "utf8");
      await required(runCommand, "git", ["apply", "--whitespace=nowarn", patchPath], verifierDirectory);
      await rm(patchPath, { force: true });
    }
    await writeFile(join(dependencyDirectory, "package.json"), JSON.stringify({ private: true }), "utf8");
    await installRuntimeDependencies(dependencyDirectory, runCommand);
    await verifyInstalledRuntimeDependencies(dependencyDirectory);
    await rm(join(verifierDirectory, "node_modules"), { recursive: true, force: true });
    await symlink(join(dependencyDirectory, "node_modules"), join(verifierDirectory, "node_modules"), "dir");
    await rm(join(baselineTestDirectory, "node_modules"), { recursive: true, force: true });
    await symlink(join(dependencyDirectory, "node_modules"), join(baselineTestDirectory, "node_modules"), "dir");
    const candidateTest = await runCommand(process.execPath, [candidateRegressionPath], {
      cwd: verifierDirectory,
      env: sealedProcessEnvironment(),
    });
    const baselineTest = await runCommand(process.execPath, [candidateRegressionPath], {
      cwd: baselineTestDirectory,
      env: sealedProcessEnvironment(),
    });
    const result = await runCommand(process.execPath, [resolve(repositoryRoot, verifierRelativePath), verifierDirectory], {
      cwd: verifierDirectory,
      env: sealedProcessEnvironment(),
    });
    const receipt = parseVerifierReceipt(result.stdout);
    return [{
      name: "workspace:node-redis:candidate-regression-passes",
      passed: candidateTest.exitCode === 0 && baselineTest.exitCode !== 0,
      detail: candidateTest.exitCode === 0 && baselineTest.exitCode !== 0
        ? `${candidateRegressionPath} is red on the untouched source and green on the candidate.`
        : `Regression exits: untouched=${baselineTest.exitCode}, candidate=${candidateTest.exitCode}.`,
    }, ...receipt.predicates.map((predicate) => ({
      name: `workspace:node-redis:${predicate.id}`,
      passed: predicate.passed,
      detail: predicate.detail,
    }))];
  } finally {
    await rm(verifierDirectory, { recursive: true, force: true });
    await rm(baselineTestDirectory, { recursive: true, force: true });
    await rm(dependencyDirectory, { recursive: true, force: true });
  }
}

function parseVerifierReceipt(stdout: string): { readonly predicates: readonly { readonly id: string; readonly passed: boolean; readonly detail: string }[] } {
  const line = lines(stdout).at(-1);
  if (!line) throw new Error("The sealed Node Redis verifier emitted no receipt.");
  const parsed = JSON.parse(line) as { schemaVersion?: unknown; predicates?: unknown };
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.predicates) || parsed.predicates.length === 0) {
    throw new Error("The sealed Node Redis verifier emitted an invalid receipt.");
  }
  const predicates = parsed.predicates.map((value) => {
    const predicate = value as Record<string, unknown>;
    if (typeof predicate.id !== "string" || typeof predicate.passed !== "boolean" || typeof predicate.detail !== "string") {
      throw new Error("The sealed Node Redis verifier emitted an invalid predicate.");
    }
    return { id: predicate.id, passed: predicate.passed, detail: predicate.detail };
  });
  if (new Set(predicates.map(({ id }) => id)).size !== predicates.length) throw new Error("The sealed Node Redis verifier emitted duplicate predicates.");
  if (JSON.stringify(predicates.map(({ id }) => id)) !== JSON.stringify(NODE_REDIS_VERIFIER_PREDICATE_IDS)) {
    throw new Error("The sealed Node Redis verifier omitted or reordered its declared predicate matrix.");
  }
  return { predicates };
}

async function ensureSourceCache(cacheDirectory: string, runCommand: CommandRunner): Promise<void> {
  try {
    await access(cacheDirectory);
    await verifySource(cacheDirectory, runCommand);
    await verifyManifest(cacheDirectory);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(cacheDirectory), { recursive: true, mode: 0o700 });
  const temporary = `${cacheDirectory}.tmp-${randomUUID()}`;
  await mkdir(temporary, { mode: 0o700 });
  try {
    await required(runCommand, "git", ["init", "--quiet"], temporary);
    await required(runCommand, "git", ["remote", "add", "origin", NODE_REDIS_REPOSITORY_URL], temporary);
    await required(runCommand, "git", ["fetch", "--quiet", "--depth", "1", "origin", NODE_REDIS_UPSTREAM_COMMIT], temporary);
    await required(runCommand, "git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"], temporary);
    await verifySource(temporary, runCommand);
    await verifyManifest(temporary);
    try {
      await rename(temporary, cacheDirectory);
    } catch (error) {
      if (!new Set(["EEXIST", "ENOTEMPTY"]).has((error as NodeJS.ErrnoException).code ?? "")) throw error;
      await verifySource(cacheDirectory, runCommand);
      await verifyManifest(cacheDirectory);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function verifySource(directory: string, runCommand: CommandRunner): Promise<void> {
  const commit = (await required(runCommand, "git", ["rev-parse", "HEAD"], directory)).stdout.trim();
  const tree = (await required(runCommand, "git", ["rev-parse", "HEAD^{tree}"], directory)).stdout.trim();
  if (commit !== NODE_REDIS_UPSTREAM_COMMIT || tree !== NODE_REDIS_UPSTREAM_TREE) {
    throw new Error(`Pinned Node Redis source mismatch: expected ${NODE_REDIS_UPSTREAM_COMMIT}/${NODE_REDIS_UPSTREAM_TREE}, received ${commit}/${tree}.`);
  }
}

async function verifyManifest(directory: string): Promise<void> {
  const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as Record<string, unknown>;
  const engines = manifest.engines as Record<string, unknown> | undefined;
  if (manifest.name !== "redis" || manifest.version !== "3.1.2" || manifest.license !== "MIT" || engines?.node !== ">=10") {
    throw new Error("Pinned Node Redis package metadata does not match the v3.1.2 fixture contract.");
  }
  const license = await readFile(join(directory, "LICENSE"), "utf8");
  if (!license.startsWith("MIT License\n\nCopyright (c) 2016-present Node Redis contributors.")) {
    throw new Error("Pinned Node Redis fixture does not contain the expected MIT license notice.");
  }
}

async function installRuntimeDependencies(directory: string, runCommand: CommandRunner, npmVersion?: string): Promise<void> {
  const resolvedNpmVersion = npmVersion ?? (await required(runCommand, "npm", ["--version"], directory)).stdout.trim();
  if (resolvedNpmVersion !== NODE_REDIS_NPM_VERSION) throw new Error(`The Node Redis case requires npm ${NODE_REDIS_NPM_VERSION}; received ${resolvedNpmVersion || "unknown"}.`);
  await required(runCommand, "npm", environmentIdentity.install.slice(1), directory);
}

async function verifyInstalledRuntimeDependencies(directory: string): Promise<void> {
  const installLock = JSON.parse(await readFile(join(directory, "node_modules", ".package-lock.json"), "utf8")) as {
    lockfileVersion?: unknown;
    packages?: Record<string, Record<string, unknown>>;
  };
  if (installLock.lockfileVersion !== 3 || !installLock.packages) {
    throw new Error("Installed Node Redis dependencies do not include the expected npm v10 hidden lock.");
  }
  for (const dependency of runtimeDependencies) {
    const manifest = JSON.parse(await readFile(join(directory, "node_modules", dependency.name, "package.json"), "utf8")) as Record<string, unknown>;
    const locked = installLock.packages[`node_modules/${dependency.name}`];
    if (manifest.name !== dependency.name
      || manifest.version !== dependency.version
      || manifest.license !== dependency.license
      || locked?.version !== dependency.version
      || locked?.integrity !== dependency.integrity
      || locked?.resolved !== `https://registry.npmjs.org/${dependency.name}/-/${dependency.name}-${dependency.version}.tgz`) {
      throw new Error(`Installed Node Redis dependency ${dependency.name} does not match the frozen environment contract.`);
    }
  }
}

function assertNodeVersion(version: string): void {
  if (version.replace(/^v/, "") !== NODE_REDIS_NODE_VERSION) throw new Error(`The Node Redis case requires Node ${NODE_REDIS_NODE_VERSION}; received ${version}.`);
}

function parseNameStatus(value: string): { readonly status: string; readonly paths: readonly string[] }[] {
  return lines(value).map((line) => {
    const [status = "", first = "", second] = line.split("\t");
    return { status: status[0] ?? status, paths: [first, second].filter((path): path is string => Boolean(path)) };
  }).filter(({ paths }) => paths.length > 0);
}

function sealedProcessEnvironment(): Readonly<Record<string, string>> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: resolve(repositoryRoot, ".sealed-empty-home"),
    LANG: "C",
    LC_ALL: "C",
  };
}

function lines(value: string): string[] {
  return value.split("\n").map((line) => line.trim()).filter(Boolean);
}

async function requireMissing(path: string): Promise<void> {
  try {
    await access(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Refusing to overwrite existing Node Redis workspace: ${path}`);
}

async function required(runCommand: CommandRunner, command: string, args: readonly string[], cwd: string, env?: Readonly<Record<string, string>>): Promise<CommandResult> {
  const result = await runCommand(command, args, env ? { cwd, env } : { cwd });
  if (result.exitCode !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`);
  return result;
}

const run: CommandRunner = (command, args, options) => new Promise((resolvePromise, reject) => {
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env ? { ...options.env } : process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 2 * 60_000);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout = `${stdout}${chunk}`.slice(-128_000); });
  child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-128_000); });
  child.once("error", (error) => { clearTimeout(timeout); reject(error); });
  child.once("exit", (code, signal) => {
    clearTimeout(timeout);
    resolvePromise({ exitCode: code ?? (signal ? 1 : 0), stdout, stderr: signal ? `${stderr}\nProcess stopped by ${signal}.` : stderr });
  });
});
