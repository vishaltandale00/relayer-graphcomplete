import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

import type { EvalCheck } from "../runtime-basic.js";

export const H3_PROJECT_CASE_ID = "project.h3.sanitize-status-code";
export const H3_AUTONOMOUS_FIX_CASE_ID = "autonomous.h3.sanitize-status-code";
export const H3_AUTONOMOUS_INVESTIGATION_CASE_ID = "autonomous.h3.investigate-status-code";
export const H3_REPOSITORY_URL = "https://github.com/h3js/h3.git";
export const H3_UPSTREAM_COMMIT = "abd4d7725b70790481d7fb816eda9650472ca725";
export const H3_UPSTREAM_TREE = "71fe6d55f98415d1eb0e3ca0cbc6e6ea071c9d97";
export const H3_SEEDED_COMMIT = "5cfbf3a3734d4dc5eafc84e27fcef9598dd3e511";
export const H3_SEEDED_TREE = "0d03a8df15b45f742da04f128558243fbcedaafd";
export const H3_PACKAGE_MANAGER = "pnpm@11.15.1";
export const H3_NODE_RANGE = ">=20.11.1";
export const H3_SEED_PATH = "src/utils/sanitize.ts";
export const H3_TEST_PATH = "test/unit/sanitize.test.ts";
export const H3_SEED_COMMIT_MESSAGE = "Seed status-code decimal validation bug";

const GOOD_VALIDATION = "Number.isInteger(statusCode)";
const SEEDED_VALIDATION = "Number.isFinite(statusCode)";
const FIXTURE_IDENTITY = Object.freeze({
  name: "Relayer Eval Fixture",
  email: "eval-fixture@relayer.local",
  date: "2026-08-19T12:00:00Z",
});

export interface ProjectEvalThreadDefinition {
  readonly id: string;
  readonly name: string;
  readonly permissionProfileId: "ask" | "auto" | "full";
  readonly mutationPolicy: "read-only" | "writable";
  readonly prompts: readonly string[];
  readonly workspaceGrade: "question" | "diagnosis" | "implementation" | "autonomous-implementation";
}

export interface ProjectEvalCaseDefinition {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly localOnly: true;
  readonly supportedPlatform: "darwin";
  readonly fixture: {
    readonly repositoryUrl: typeof H3_REPOSITORY_URL;
    readonly upstreamCommit: typeof H3_UPSTREAM_COMMIT;
    readonly upstreamTree: typeof H3_UPSTREAM_TREE;
    readonly seededCommit: typeof H3_SEEDED_COMMIT;
    readonly seededTree: typeof H3_SEEDED_TREE;
    readonly packageManager: typeof H3_PACKAGE_MANAGER;
    readonly node: typeof H3_NODE_RANGE;
    readonly license: "MIT";
  };
  readonly threads: readonly ProjectEvalThreadDefinition[];
  readonly autonomous?: true;
  readonly category?: "coding" | "work";
  readonly taskType?: "feature-change" | "debugging" | "investigation";
}

export const h3ProjectEvalCase: ProjectEvalCaseDefinition = Object.freeze({
  schemaVersion: 1,
  id: H3_PROJECT_CASE_ID,
  name: "h3 · status-code sanitization",
  description: "Explores h3 architecture, diagnoses a seeded decimal status-code bug, then implements and commits the repair in one shared project.",
  localOnly: true,
  supportedPlatform: "darwin",
  fixture: Object.freeze({
    repositoryUrl: H3_REPOSITORY_URL,
    upstreamCommit: H3_UPSTREAM_COMMIT,
    upstreamTree: H3_UPSTREAM_TREE,
    seededCommit: H3_SEEDED_COMMIT,
    seededTree: H3_SEEDED_TREE,
    packageManager: H3_PACKAGE_MANAGER,
    node: H3_NODE_RANGE,
    license: "MIT",
  }),
  threads: Object.freeze([
    Object.freeze({
      id: "architecture",
      name: "Architecture question",
      permissionProfileId: "auto",
      mutationPolicy: "read-only",
      workspaceGrade: "question",
      prompts: Object.freeze([
        "In this h3 checkout, explain how a handler result becomes a standards-compliant Response. Trace the important response and error boundaries, including where HTTP status values are normalized. Ground the explanation in exact files and symbols. Do not modify the checkout.",
        "Think deeper. Trace at least two distinct handler-output paths into response construction, explain which invariants are shared or path-specific, and show where invalid status values can cross a boundary. Keep the checkout unchanged.",
      ]),
    }),
    Object.freeze({
      id: "diagnosis",
      name: "Read-only bug diagnosis",
      permissionProfileId: "auto",
      mutationPolicy: "read-only",
      workspaceGrade: "diagnosis",
      prompts: Object.freeze([
        "Diagnose why a decimal HTTP status such as 200.5 can survive h3 status sanitization and later fail at a platform Response boundary. Identify the smallest responsible code path and relevant existing tests. This is read-only diagnosis: do not modify or commit anything.",
        "Challenge your diagnosis with a competing hypothesis: could response-adapter coercion, truthiness handling, or string conversion be the real cause instead? Compare the hypotheses against concrete call sites and test evidence, then state what evidence would falsify your conclusion. Keep the checkout unchanged.",
      ]),
    }),
    Object.freeze({
      id: "implementation",
      name: "Implement and commit the repair",
      permissionProfileId: "full",
      mutationPolicy: "writable",
      workspaceGrade: "implementation",
      prompts: Object.freeze([
        "Fix the diagnosed status-code validation bug in the smallest appropriate source boundary. Add focused regression coverage for decimal numbers and decimal numeric strings. Run relevant checks and create one meaningful local commit. Do not change dependencies, generated files, or unrelated code.",
        "Now strengthen the tests around the accepted 100–599 boundaries and numeric-string behavior. Confirm integer numeric strings remain accepted while decimal numeric strings fall back. Make any remaining substantive correction, run the relevant checks, and produce a second meaningful local commit. Keep changes limited to the sanitizer and its focused unit test, leave the tree clean, and do not deploy, publish, or push.",
      ]),
    }),
  ]),
});

const H3_FIXTURE = h3ProjectEvalCase.fixture;

export const h3AutonomousFixEvalCase: ProjectEvalCaseDefinition = Object.freeze({
  schemaVersion: 1,
  id: H3_AUTONOMOUS_FIX_CASE_ID,
  name: "h3 · autonomous status-code repair",
  description: "Repairs a seeded decimal status-code validation bug from a concise user request.",
  localOnly: true,
  supportedPlatform: "darwin",
  autonomous: true,
  category: "coding",
  taskType: "debugging",
  fixture: H3_FIXTURE,
  threads: Object.freeze([
    Object.freeze({
      id: "implementation",
      name: "Repair decimal status validation",
      permissionProfileId: "full",
      mutationPolicy: "writable",
      workspaceGrade: "autonomous-implementation",
      prompts: Object.freeze([
        "Fix the decimal HTTP status validation bug in this checkout. Add focused regression coverage, run the relevant checks, and commit the repair. Keep the change scoped and do not push or publish anything.",
      ]),
    }),
  ]),
});

export const h3AutonomousInvestigationEvalCase: ProjectEvalCaseDefinition = Object.freeze({
  schemaVersion: 1,
  id: H3_AUTONOMOUS_INVESTIGATION_CASE_ID,
  name: "h3 · autonomous status-code investigation",
  description: "Investigates a production-shaped status-code failure without a curated diagnostic recipe.",
  localOnly: true,
  supportedPlatform: "darwin",
  autonomous: true,
  category: "work",
  taskType: "investigation",
  fixture: H3_FIXTURE,
  threads: Object.freeze([
    Object.freeze({
      id: "investigation",
      name: "Investigate invalid Response status",
      permissionProfileId: "auto",
      mutationPolicy: "read-only",
      workspaceGrade: "diagnosis",
      prompts: Object.freeze([
        "A decimal HTTP status can make it through this checkout and later fail when a platform Response is constructed. Investigate the cause, identify the smallest responsible path and relevant tests, and explain how you verified the diagnosis. Do not modify the checkout.",
      ]),
    }),
  ]),
});

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env?: Readonly<Record<string, string>> },
) => Promise<CommandResult>;

export interface H3FixtureReceipt {
  readonly schemaVersion: 1;
  readonly fixtureId: typeof H3_PROJECT_CASE_ID;
  readonly workspaceDirectory: string;
  readonly repositoryUrl: typeof H3_REPOSITORY_URL;
  readonly upstreamCommit: typeof H3_UPSTREAM_COMMIT;
  readonly upstreamTree: typeof H3_UPSTREAM_TREE;
  readonly seededCommit: typeof H3_SEEDED_COMMIT;
  readonly seededTree: typeof H3_SEEDED_TREE;
  readonly packageManager: typeof H3_PACKAGE_MANAGER;
  readonly installedWithFrozenLockfile: true;
}

export async function materializeH3ProjectFixture(options: {
  readonly cacheDirectory: string;
  readonly workspaceDirectory: string;
  readonly platform?: NodeJS.Platform;
  readonly nodeVersion?: string;
  readonly runCommand?: CommandRunner;
}): Promise<H3FixtureReceipt> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") throw new Error("The pinned h3 project case is local Mac only.");
  assertSupportedNode(options.nodeVersion ?? process.versions.node);
  const runCommand = options.runCommand ?? run;
  await ensureSourceCache(options.cacheDirectory, runCommand);
  await requireMissing(options.workspaceDirectory, "h3 execution workspace");
  await mkdir(dirname(options.workspaceDirectory), { recursive: true, mode: 0o700 });
  await required(runCommand, "git", ["clone", "--local", "--no-hardlinks", "--no-checkout", options.cacheDirectory, options.workspaceDirectory], dirname(options.workspaceDirectory));
  await required(runCommand, "git", ["checkout", "--detach", H3_UPSTREAM_COMMIT], options.workspaceDirectory);
  await verifyUpstream(options.workspaceDirectory, runCommand);
  await verifyManifest(options.workspaceDirectory);
  await seedBug(options.workspaceDirectory);
  await required(runCommand, "git", ["add", "--", H3_SEED_PATH], options.workspaceDirectory);
  await required(runCommand, "git", ["commit", "-m", H3_SEED_COMMIT_MESSAGE], options.workspaceDirectory, fixtureCommitEnvironment());
  await verifySeededFixture(options.workspaceDirectory, runCommand);
  await required(runCommand, "corepack", [H3_PACKAGE_MANAGER, "install", "--frozen-lockfile"], options.workspaceDirectory);
  const status = await required(runCommand, "git", ["status", "--porcelain=v1", "--untracked-files=all"], options.workspaceDirectory);
  if (status.stdout.trim()) throw new Error(`Frozen h3 install changed the tracked workspace: ${status.stdout.trim()}`);
  return {
    schemaVersion: 1,
    fixtureId: H3_PROJECT_CASE_ID,
    workspaceDirectory: options.workspaceDirectory,
    repositoryUrl: H3_REPOSITORY_URL,
    upstreamCommit: H3_UPSTREAM_COMMIT,
    upstreamTree: H3_UPSTREAM_TREE,
    seededCommit: H3_SEEDED_COMMIT,
    seededTree: H3_SEEDED_TREE,
    packageManager: H3_PACKAGE_MANAGER,
    installedWithFrozenLockfile: true,
  };
}

export async function gradeH3Workspace(options: {
  readonly workspaceDirectory: string;
  readonly grade: ProjectEvalThreadDefinition["workspaceGrade"];
  readonly runCommand?: CommandRunner;
}): Promise<readonly EvalCheck[]> {
  const runCommand = options.runCommand ?? run;
  if (options.grade === "implementation" || options.grade === "autonomous-implementation") {
    return gradeImplementation(options.workspaceDirectory, runCommand, options.grade === "implementation" ? 2 : 1);
  }
  const checks = await gradeReadOnly(options.workspaceDirectory, runCommand, options.grade);
  if (options.grade === "question") return checks;
  const hidden = await runHiddenStatusCheck(options.workspaceDirectory, runCommand);
  return [
    ...checks,
    {
      name: "workspace:diagnosis-reproduces-seeded-failure",
      passed: hidden.exitCode !== 0,
      detail: hidden.exitCode !== 0
        ? "The hidden decimal-status check exposes the seeded validation failure."
        : "The hidden decimal-status check unexpectedly passed before implementation.",
    },
  ];
}

export function seedH3SanitizerSource(source: string): string {
  const occurrences = source.split(GOOD_VALIDATION).length - 1;
  if (occurrences !== 1 || source.includes(SEEDED_VALIDATION)) {
    throw new Error("Pinned h3 sanitizer source does not match the seeded-bug contract.");
  }
  return source.replace(GOOD_VALIDATION, SEEDED_VALIDATION);
}

async function ensureSourceCache(cacheDirectory: string, runCommand: CommandRunner): Promise<void> {
  try {
    await access(cacheDirectory);
    await verifyUpstream(cacheDirectory, runCommand);
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
    await required(runCommand, "git", ["remote", "add", "origin", H3_REPOSITORY_URL], temporary);
    await required(runCommand, "git", ["fetch", "--quiet", "--depth", "1", "origin", H3_UPSTREAM_COMMIT], temporary);
    await required(runCommand, "git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"], temporary);
    await verifyUpstream(temporary, runCommand);
    await verifyManifest(temporary);
    try {
      await rename(temporary, cacheDirectory);
    } catch (error) {
      if (!(["EEXIST", "ENOTEMPTY"] as const).includes((error as NodeJS.ErrnoException).code as "EEXIST" | "ENOTEMPTY")) throw error;
      await verifyUpstream(cacheDirectory, runCommand);
      await verifyManifest(cacheDirectory);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function verifyUpstream(directory: string, runCommand: CommandRunner): Promise<void> {
  const commit = (await required(runCommand, "git", ["rev-parse", "HEAD"], directory)).stdout.trim();
  const tree = (await required(runCommand, "git", ["rev-parse", "HEAD^{tree}"], directory)).stdout.trim();
  if (commit !== H3_UPSTREAM_COMMIT || tree !== H3_UPSTREAM_TREE) {
    throw new Error(`Pinned h3 source mismatch: expected ${H3_UPSTREAM_COMMIT}/${H3_UPSTREAM_TREE}, received ${commit}/${tree}.`);
  }
}

async function verifyManifest(directory: string): Promise<void> {
  const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as Record<string, unknown>;
  const engines = manifest.engines as Record<string, unknown> | undefined;
  if (manifest.license !== "MIT" || manifest.packageManager !== H3_PACKAGE_MANAGER || engines?.node !== H3_NODE_RANGE) {
    throw new Error("Pinned h3 package metadata does not match the fixture contract.");
  }
  const license = await readFile(join(directory, "LICENSE"), "utf8");
  if (!license.startsWith("MIT License\n")) throw new Error("Pinned h3 fixture does not contain the expected MIT license.");
}

async function seedBug(directory: string): Promise<void> {
  const path = join(directory, H3_SEED_PATH);
  const source = await readFile(path, "utf8");
  await writeFile(path, seedH3SanitizerSource(source), "utf8");
}

async function verifySeededFixture(directory: string, runCommand: CommandRunner): Promise<void> {
  const commit = (await required(runCommand, "git", ["rev-parse", "HEAD"], directory)).stdout.trim();
  const tree = (await required(runCommand, "git", ["rev-parse", "HEAD^{tree}"], directory)).stdout.trim();
  const parent = (await required(runCommand, "git", ["rev-parse", "HEAD^"], directory)).stdout.trim();
  if (commit !== H3_SEEDED_COMMIT || tree !== H3_SEEDED_TREE || parent !== H3_UPSTREAM_COMMIT) {
    throw new Error(`Seeded h3 fixture mismatch: expected ${H3_SEEDED_COMMIT}/${H3_SEEDED_TREE} on ${H3_UPSTREAM_COMMIT}.`);
  }
}

async function gradeReadOnly(directory: string, runCommand: CommandRunner, grade: "question" | "diagnosis"): Promise<readonly EvalCheck[]> {
  const head = (await required(runCommand, "git", ["rev-parse", "HEAD"], directory)).stdout.trim();
  const status = (await required(runCommand, "git", ["status", "--porcelain=v1", "--untracked-files=all"], directory)).stdout.trim();
  const diff = await runCommand("git", ["diff", "--quiet", H3_SEEDED_COMMIT, "--"], { cwd: directory });
  return [
    {
      name: `workspace:${grade}-baseline-head`,
      passed: head === H3_SEEDED_COMMIT,
      detail: head === H3_SEEDED_COMMIT ? "The seeded fixture commit is unchanged." : `HEAD moved to ${head}.`,
    },
    {
      name: `workspace:${grade}-zero-diff`,
      passed: diff.exitCode === 0 && status === "",
      detail: diff.exitCode === 0 && status === "" ? "The project checkout has zero tracked or untracked changes." : `Workspace changed: ${status || "tracked diff"}`,
    },
  ];
}

async function gradeImplementation(directory: string, runCommand: CommandRunner, minimumCommits: 1 | 2): Promise<readonly EvalCheck[]> {
  const hidden = await runHiddenStatusCheck(directory, runCommand);
  const build = await runCommand("corepack", [H3_PACKAGE_MANAGER, "run", "build"], { cwd: directory });
  const typecheck = await runCommand("corepack", [H3_PACKAGE_MANAGER, "run", "typecheck"], { cwd: directory });
  const status = (await required(runCommand, "git", ["status", "--porcelain=v1", "--untracked-files=all"], directory)).stdout.trim();
  const commits = lines((await required(runCommand, "git", ["rev-list", "--reverse", `${H3_SEEDED_COMMIT}..HEAD`], directory)).stdout);
  const changedFiles = lines((await required(runCommand, "git", ["diff", "--name-only", `${H3_SEEDED_COMMIT}..HEAD`, "--"], directory)).stdout);
  const commitFiles = await Promise.all(commits.map(async (commit) => lines(
    (await required(runCommand, "git", ["diff-tree", "--no-commit-id", "--name-only", "-r", commit], directory)).stdout,
  )));
  const allowedFiles = new Set([H3_SEED_PATH, H3_TEST_PATH]);
  const source = await readFile(join(directory, H3_SEED_PATH), "utf8");
  const tests = await readFile(join(directory, H3_TEST_PATH), "utf8");
  const boundaryCoverage = [
    "sanitizeStatusCode(100)",
    "sanitizeStatusCode(599)",
    'sanitizeStatusCode("599")',
    "sanitizeStatusCode(200.5)",
    'sanitizeStatusCode("200.5")',
  ].every((snippet) => tests.includes(snippet));
  return [
    { name: "workspace:implementation-build", passed: build.exitCode === 0, detail: commandDetail("h3 build", build) },
    { name: "workspace:implementation-typecheck", passed: typecheck.exitCode === 0, detail: commandDetail("h3 typecheck", typecheck) },
    { name: "workspace:implementation-hidden-decimal-check", passed: hidden.exitCode === 0, detail: commandDetail("hidden decimal-status check", hidden) },
    {
      name: "workspace:implementation-focused-files",
      passed: changedFiles.length > 0 && changedFiles.every((file) => allowedFiles.has(file)),
      detail: `Changed files: ${changedFiles.join(", ") || "none"}.`,
    },
    {
      name: "workspace:implementation-validation-boundary",
      passed: source.includes(GOOD_VALIDATION) && !source.includes(SEEDED_VALIDATION) && boundaryCoverage,
      detail: "The sanitizer uses integer validation and focused tests cover number and numeric-string boundaries.",
    },
    {
      name: `workspace:implementation-${minimumCommits === 1 ? "meaningful-commit" : "two-meaningful-commits"}`,
      passed: commits.length >= minimumCommits
        && commitFiles.every((files) => files.length > 0 && files.every((file) => allowedFiles.has(file)))
        && commitFiles.some((files) => files.includes(H3_SEED_PATH))
        && commitFiles.some((files) => files.includes(H3_TEST_PATH)),
      detail: `${commits.length} post-seed commit(s); per-commit files: ${commitFiles.map((files) => files.join(",") || "empty").join(" | ")}.`,
    },
    {
      name: "workspace:implementation-clean",
      passed: status === "",
      detail: status === "" ? "The implementation workspace is clean." : `Uncommitted changes remain: ${status}`,
    },
  ];
}

async function runHiddenStatusCheck(directory: string, runCommand: CommandRunner): Promise<CommandResult> {
  const script = [
    'import { sanitizeStatusCode } from "./src/utils/sanitize.ts";',
    "const cases = [[200.5, 418], [\"200.5\", 418], [100, 100], [599, 599], [\"301\", 301]];",
    "for (const [input, expected] of cases) {",
    "  const actual = sanitizeStatusCode(input, 418);",
    "  if (actual !== expected) { console.error(`${JSON.stringify(input)}: expected ${expected}, received ${actual}`); process.exitCode = 1; }",
    "}",
  ].join("\n");
  // This runs inside the Eval Electron main process during local project cases.
  // process.execPath is Electron there, so resolve Node through PATH instead.
  return runCommand("node", ["--experimental-strip-types", "--input-type=module", "--eval", script], { cwd: directory });
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

function fixtureCommitEnvironment(): Readonly<Record<string, string>> {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    GIT_AUTHOR_NAME: FIXTURE_IDENTITY.name,
    GIT_AUTHOR_EMAIL: FIXTURE_IDENTITY.email,
    GIT_AUTHOR_DATE: FIXTURE_IDENTITY.date,
    GIT_COMMITTER_NAME: FIXTURE_IDENTITY.name,
    GIT_COMMITTER_EMAIL: FIXTURE_IDENTITY.email,
    GIT_COMMITTER_DATE: FIXTURE_IDENTITY.date,
  };
}

function assertSupportedNode(version: string): void {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  if (major < 20 || (major === 20 && (minor < 11 || (minor === 11 && patch < 1)))) {
    throw new Error(`The pinned h3 fixture requires Node ${H3_NODE_RANGE}; received ${version}.`);
  }
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
  const output = (result.stderr || result.stdout).trim().slice(-1_000);
  return result.exitCode === 0 ? `${label} passed.` : `${label} failed (${result.exitCode}): ${output || "no output"}`;
}

const run: CommandRunner = (command, args, options) => new Promise((resolve, reject) => {
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env === undefined ? process.env : { ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout = `${stdout}${chunk}`.slice(-64_000); });
  child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-64_000); });
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve({
    exitCode: code ?? (signal ? 1 : 0),
    stdout,
    stderr: signal ? `${stderr}\nProcess stopped by ${signal}.` : stderr,
  }));
});
