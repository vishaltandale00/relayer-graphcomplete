import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

import { bindAutonomousCaseSnapshot } from "../cases/catalog.js";
import { createAutonomousCaseSnapshot } from "../cases/contracts.js";
import type { EvalCheck } from "../runtime-basic.js";
import type { CommandResult, CommandRunner, ProjectEvalCaseDefinition, ProjectEvalThreadDefinition } from "./h3.js";

export const OFETCH_RETRY_METHODS_CASE_ID = "autonomous.ofetch.retry-methods";
export const TRUE_MYTH_INSPECT_BOTH_CASE_ID = "autonomous.true-myth.inspect-both";
export const SQL_FORMATTER_ANSI_ALIAS_CASE_ID = "autonomous.sql-formatter.ansi-alias";
export const HTTPX_PROXY_AUTH_REPORT_CASE_ID = "autonomous.httpx.proxy-auth-report";

type FrontierCaseId =
  | typeof OFETCH_RETRY_METHODS_CASE_ID
  | typeof TRUE_MYTH_INSPECT_BOTH_CASE_ID
  | typeof SQL_FORMATTER_ANSI_ALIAS_CASE_ID
  | typeof HTTPX_PROXY_AUTH_REPORT_CASE_ID;

interface FrontierFixture {
  readonly repositoryUrl: string;
  readonly upstreamCommit: string;
  readonly upstreamTree: string;
  readonly packageManager: string;
  readonly install: readonly [string, readonly string[]] | null;
  readonly license: "MIT" | "BSD-3-Clause";
}

interface FrontierCaseDefinition extends Omit<ProjectEvalCaseDefinition, "fixture" | "threads"> {
  readonly id: FrontierCaseId;
  readonly fixture: FrontierFixture;
  readonly threads: readonly ProjectEvalThreadDefinition[];
}

const fixtures: Readonly<Record<FrontierCaseId, FrontierFixture>> = Object.freeze({
  [OFETCH_RETRY_METHODS_CASE_ID]: Object.freeze({
    repositoryUrl: "https://github.com/unjs/ofetch.git",
    upstreamCommit: "dfbe3ca4ef8a22fc023fca5a5ef530e525f5e523",
    upstreamTree: "0c6a0dd6cfd8b99bec9d69c92ae8a024c8228ef3",
    packageManager: "pnpm@10.20.0",
    install: ["corepack", ["pnpm@10.20.0", "install", "--frozen-lockfile"]] as const,
    license: "MIT",
  }),
  [TRUE_MYTH_INSPECT_BOTH_CASE_ID]: Object.freeze({
    repositoryUrl: "https://github.com/true-myth/true-myth.git",
    upstreamCommit: "d8fbebc75de4991a32354518beff1abf628d0b07",
    upstreamTree: "44a7e60897363a65f734284a79d228d1a6ea9c79",
    packageManager: "pnpm@10.20.0",
    install: ["corepack", ["pnpm@10.20.0", "install", "--frozen-lockfile"]] as const,
    license: "MIT",
  }),
  [SQL_FORMATTER_ANSI_ALIAS_CASE_ID]: Object.freeze({
    repositoryUrl: "https://github.com/sql-formatter-org/sql-formatter.git",
    upstreamCommit: "954e5a474b9e3d45ca58f02a3a4eac8e1947acc5",
    upstreamTree: "b26af86985b62b073c25b7009c8412880f8de653",
    packageManager: "yarn@1",
    install: ["corepack", ["yarn@1.22.22", "install", "--frozen-lockfile", "--ignore-scripts"]] as const,
    license: "MIT",
  }),
  [HTTPX_PROXY_AUTH_REPORT_CASE_ID]: Object.freeze({
    repositoryUrl: "https://github.com/encode/httpx.git",
    upstreamCommit: "b5addb64f0161ff6bfe94c124ef76f6a1fba5254",
    upstreamTree: "31ba94512339180efacceacc0646b56ee15eba63",
    packageManager: "none",
    install: null,
    license: "BSD-3-Clause",
  }),
});

function thread(options: {
  id: string;
  name: string;
  prompt: string;
  mutationPolicy: "read-only" | "writable";
  workspaceGrade: ProjectEvalThreadDefinition["workspaceGrade"];
}): ProjectEvalThreadDefinition {
  return Object.freeze({
    id: options.id,
    name: options.name,
    permissionProfileId: options.mutationPolicy === "writable" ? "full" : "auto",
    mutationPolicy: options.mutationPolicy,
    workspaceGrade: options.workspaceGrade,
    prompts: Object.freeze([options.prompt]),
  });
}

const definitions: readonly FrontierCaseDefinition[] = Object.freeze([
  Object.freeze({
    schemaVersion: 1,
    id: OFETCH_RETRY_METHODS_CASE_ID,
    name: "ofetch · configurable retry methods",
    description: "Adds an opt-in method allowlist without changing existing retry defaults.",
    localOnly: true,
    supportedPlatform: "darwin",
    autonomous: true,
    category: "coding",
    taskType: "feature-change",
    fixture: fixtures[OFETCH_RETRY_METHODS_CASE_ID],
    threads: Object.freeze([thread({
      id: "implementation",
      name: "Add retry method controls",
      mutationPolicy: "writable",
      workspaceGrade: "autonomous-implementation",
      prompt: "Add a retryMethods option so callers can explicitly choose which HTTP methods ofetch may retry. Method names should be case-insensitive and existing behavior must stay unchanged when the option is omitted. Add focused tests, run the relevant checks, and commit the change. Do not push or publish anything.",
    })]),
  }),
  Object.freeze({
    schemaVersion: 1,
    id: TRUE_MYTH_INSPECT_BOTH_CASE_ID,
    name: "True Myth · Result inspectBoth",
    description: "Adds a branch-aware Result inspection API in method and data-last forms.",
    localOnly: true,
    supportedPlatform: "darwin",
    autonomous: true,
    category: "coding",
    taskType: "feature-change",
    fixture: fixtures[TRUE_MYTH_INSPECT_BOTH_CASE_ID],
    threads: Object.freeze([thread({
      id: "implementation",
      name: "Add inspectBoth",
      mutationPolicy: "writable",
      workspaceGrade: "autonomous-implementation",
      prompt: "Add Result.inspectBoth with Ok and Err callbacks, plus the matching data-last helper. It should call exactly the active branch and return the original Result unchanged. Add focused runtime and type coverage, run the relevant checks, and commit the change. Do not push or publish anything.",
    })]),
  }),
  Object.freeze({
    schemaVersion: 1,
    id: SQL_FORMATTER_ANSI_ALIAS_CASE_ID,
    name: "SQL Formatter · ANSI dialect alias",
    description: "Adds ansi as a public alias for the generic sql dialect.",
    localOnly: true,
    supportedPlatform: "darwin",
    autonomous: true,
    category: "coding",
    taskType: "feature-change",
    fixture: fixtures[SQL_FORMATTER_ANSI_ALIAS_CASE_ID],
    threads: Object.freeze([thread({
      id: "implementation",
      name: "Add ANSI alias",
      mutationPolicy: "writable",
      workspaceGrade: "autonomous-implementation",
      prompt: "Let users select ansi as an alias for the generic sql dialect. Keep the public language type, supported dialect list, formatter behavior, and CLI behavior consistent. Add focused tests, run the relevant checks, and commit the change. Do not push or publish anything.",
    })]),
  }),
  Object.freeze({
    schemaVersion: 1,
    id: HTTPX_PROXY_AUTH_REPORT_CASE_ID,
    name: "HTTPX · proxy credential flow report",
    description: "Produces a source-grounded security review of proxy credential handling.",
    localOnly: true,
    supportedPlatform: "darwin",
    autonomous: true,
    category: "work",
    taskType: "investigation",
    fixture: fixtures[HTTPX_PROXY_AUTH_REPORT_CASE_ID],
    threads: Object.freeze([thread({
      id: "investigation",
      name: "Trace proxy credentials",
      mutationPolicy: "writable",
      workspaceGrade: "autonomous-implementation",
      prompt: "Trace how proxy URL credentials move through this checkout: extraction, encoding, handoff to the transport, and redaction from representations. Put a concise, evidence-grounded report in proxy-auth-flow.md with exact files and symbols, then commit the report. Do not change application code, dependencies, or generated files, and do not push or publish anything.",
    })]),
  }),
]);

const digest = (value: string) => `sha256:${value}` as const;
const hash = (value: string) => digest(createHash("sha256").update(value).digest("hex"));
const sealedDigests: Readonly<Record<FrontierCaseId, { reference: string; verifier: string }>> = Object.freeze({
  [OFETCH_RETRY_METHODS_CASE_ID]: { reference: "d83c22ccc316b61e3954b5ba948bc597f71e0f1684798cfc308f08c3134e31d8", verifier: "f2ee474e135bd15f91a32aa35a4b3878788d6d39c6fe43d6b9c588c677580b53" },
  [TRUE_MYTH_INSPECT_BOTH_CASE_ID]: { reference: "2e31b8bb7cc2085d3c5d36e9eb947bd9fff75bc820dc0d405d2eb1f758445a78", verifier: "5ef504edc5a59db10d23bafe0ed5231cc3045dd642d5ab755be540a89bd9093b" },
  [SQL_FORMATTER_ANSI_ALIAS_CASE_ID]: { reference: "48840ed942aa3f68cf570dda95fa7c9d51a02d661fc2d34f6d1fa9bc1c46cc2e", verifier: "e8f4a1c3520e5e31d4a7039eb4f0df17a6f5273e86a6cfbae9b65ce47369add8" },
  [HTTPX_PROXY_AUTH_REPORT_CASE_ID]: { reference: "d345087428c811ee98ac044a720c716e33810c7c1250dcf96fd3c1376a23ed32", verifier: "8dc9d0c788a325e548f1646f24f42a91639ac82b9fa0f8dbbb6a57efca373e85" },
});

function bind(definition: FrontierCaseDefinition) {
  const fixture = definition.fixture;
  const isWork = definition.category === "work";
  const slug = definition.id.replace(/^autonomous\./, "").replaceAll(".", "-");
  const criteria = isWork
    ? [{ id: "accuracy", label: "Technical accuracy", description: "The report is correct, complete, and evidence-grounded.", weight: 3 }, { id: "usability", label: "Report usability", description: "The report is concise and decision-useful.", weight: 1 }]
    : [{ id: "behavior", label: "Behavioral correctness", description: "The requested API behavior works without regressions.", weight: 3 }, { id: "quality", label: "Implementation quality", description: "The implementation and tests fit repository conventions.", weight: 1 }];
  return bindAutonomousCaseSnapshot(definition, createAutonomousCaseSnapshot({
    id: definition.id,
    name: definition.name,
    description: definition.description,
    category: definition.category!,
    taskType: definition.taskType!,
    artifacts: {
      task: { kind: "visible-task", text: definition.threads[0]!.prompts[0]!, contentDigest: hash(definition.threads[0]!.prompts[0]!) },
      workspace: {
        kind: "frozen-workspace",
        materializerId: `${slug}-v1`,
        source: fixture.repositoryUrl,
        revision: `git-tree:${fixture.upstreamTree}`,
        contentDigest: hash(`${fixture.repositoryUrl}\n${fixture.upstreamCommit}\n${fixture.upstreamTree}`),
        environmentDigest: hash(JSON.stringify({ packageManager: fixture.packageManager, install: fixture.install })),
      },
      reference: {
        kind: "sealed-reference",
        artifactId: `${slug}-reference-v1`,
        format: isWork ? "markdown" : "git-patch",
        contentDigest: digest(sealedDigests[definition.id].reference),
        sealedPath: `eval-cases/${slug}/solution/reference.${isWork ? "md" : "patch"}`,
      },
      verifier: {
        kind: "sealed-verifier",
        artifactId: `${slug}-verifier-v1`,
        verifierId: `${slug}-v1`,
        contentDigest: digest(sealedDigests[definition.id].verifier),
        sealedPath: `eval-cases/${slug}/verifier/README.md`,
        mandatoryGates: [
          { id: "hidden-behavior", label: isWork ? "Report artifact integrity" : "Hidden behavior", description: isWork ? "The requested report artifact exists and contains content." : "Evaluator-owned behavioral checks pass." },
          { id: "scoped-delivery", label: "Scoped delivery", description: isWork ? "Only the requested report is added." : "The implementation is committed, focused, and clean." },
        ],
      },
      outcomeRubric: {
        kind: "outcome-rubric",
        rubricVersion: `${slug}-outcome-v1`,
        contentDigest: hash(JSON.stringify(criteria)),
        criteria,
      },
    },
  }));
}

export const frontierAutonomousCases = Object.freeze(definitions.map(bind));
export const frontierAutonomousCaseIds = new Set<FrontierCaseId>(definitions.map(({ id }) => id));

export async function materializeFrontierProjectFixture(options: {
  readonly caseId: FrontierCaseId;
  readonly cacheDirectory: string;
  readonly workspaceDirectory: string;
  readonly platform?: NodeJS.Platform;
  readonly runCommand?: CommandRunner;
}) {
  if ((options.platform ?? process.platform) !== "darwin") throw new Error("Frontier project cases are local Mac only.");
  const fixture = fixtures[options.caseId];
  if (!fixture) throw new Error(`Unknown frontier fixture: ${options.caseId}`);
  const runCommand = options.runCommand ?? run;
  await ensureCache(options.cacheDirectory, fixture, runCommand);
  await requireMissing(options.workspaceDirectory);
  await mkdir(dirname(options.workspaceDirectory), { recursive: true, mode: 0o700 });
  await required(runCommand, "git", ["clone", "--local", "--no-hardlinks", "--no-checkout", options.cacheDirectory, options.workspaceDirectory], dirname(options.workspaceDirectory));
  await required(runCommand, "git", ["checkout", "--detach", fixture.upstreamCommit], options.workspaceDirectory);
  if (fixture.install) await required(runCommand, fixture.install[0], fixture.install[1], options.workspaceDirectory);
  const status = await required(runCommand, "git", ["status", "--porcelain=v1", "--untracked-files=all"], options.workspaceDirectory);
  if (status.stdout.trim()) throw new Error(`Frozen install changed ${options.caseId}: ${status.stdout.trim()}`);
  return {
    schemaVersion: 1,
    fixtureId: options.caseId,
    workspaceDirectory: options.workspaceDirectory,
    repositoryUrl: fixture.repositoryUrl,
    upstreamCommit: fixture.upstreamCommit,
    seededTree: fixture.upstreamTree,
    packageManager: fixture.packageManager,
    installedWithFrozenLockfile: fixture.install !== null,
  };
}

export async function gradeFrontierProjectWorkspace(options: {
  readonly caseId: FrontierCaseId;
  readonly workspaceDirectory: string;
  readonly runCommand?: CommandRunner;
}): Promise<readonly EvalCheck[]> {
  const runCommand = options.runCommand ?? run;
  const fixture = fixtures[options.caseId];
  const build = await runValidationBuild(options.caseId, options.workspaceDirectory, runCommand);
  const hidden = await runHidden(options.caseId, options.workspaceDirectory, runCommand);
  const status = (await required(runCommand, "git", ["status", "--porcelain=v1", "--untracked-files=all"], options.workspaceDirectory)).stdout.trim();
  const changed = lines((await required(runCommand, "git", ["diff", "--name-only", fixture.upstreamCommit, "--"], options.workspaceDirectory)).stdout);
  const requiredFiles = requiredChangedFiles(options.caseId);
  const requiredFilesPresent = [...requiredFiles].every((file) => changed.includes(file));
  const additional = changed.filter((file) => !allowedFiles(options.caseId).has(file));
  const exactScopeRequired = options.caseId === HTTPX_PROXY_AUTH_REPORT_CASE_ID;
  const commits = lines((await required(runCommand, "git", ["rev-list", `${fixture.upstreamCommit}..HEAD`], options.workspaceDirectory)).stdout);
  return [
    { name: "workspace:validation-build", passed: build.exitCode === 0, detail: commandDetail("repository validation build", build) },
    { name: "workspace:hidden-behavior", passed: hidden.exitCode === 0, detail: commandDetail("sealed verifier", hidden) },
    {
      name: "workspace:required-delivery-files",
      passed: requiredFilesPresent && (!exactScopeRequired || additional.length === 0),
      detail: `Changed files: ${changed.join(", ") || "none"}. Required: ${[...requiredFiles].join(", ")}.`
        + (additional.length === 0 ? "" : ` Additional files for quality review: ${additional.join(", ")}.`),
    },
    { name: "workspace:delivery-commit", passed: commits.length >= 1, detail: `${commits.length} post-fixture commit(s).` },
    { name: "workspace:delivery-clean", passed: status === "", detail: status === "" ? "The workspace is clean." : `Uncommitted changes remain: ${status}` },
  ];
}

async function runValidationBuild(caseId: FrontierCaseId, cwd: string, runCommand: CommandRunner): Promise<CommandResult> {
  if (caseId === OFETCH_RETRY_METHODS_CASE_ID) return runCommand("corepack", ["pnpm@10.20.0", "run", "build"], { cwd });
  if (caseId === TRUE_MYTH_INSPECT_BOTH_CASE_ID) {
    return runCommand("corepack", ["pnpm@10.20.0", "exec", "tsc", "--project", "ts/publish.tsconfig.json", "--types", "node"], { cwd });
  }
  if (caseId === SQL_FORMATTER_ANSI_ALIAS_CASE_ID) {
    const grammar = await runCommand("corepack", ["yarn@1.22.22", "grammar"], { cwd });
    return grammar.exitCode === 0
      ? runCommand("corepack", ["yarn@1.22.22", "jest", "test/sqlFormatter.test.ts", "--runInBand", "--coverage=false"], { cwd })
      : grammar;
  }
  return { exitCode: 0, stdout: "No build required.", stderr: "" };
}

function allowedFiles(caseId: FrontierCaseId): ReadonlySet<string> {
  if (caseId === OFETCH_RETRY_METHODS_CASE_ID) return new Set(["src/fetch.ts", "src/types.ts", "test/index.test.ts", "README.md", "CHANGELOG.md"]);
  if (caseId === TRUE_MYTH_INSPECT_BOTH_CASE_ID) return new Set(["src/result.ts", "test/result.test.ts", "README.md", "CHANGELOG.md"]);
  if (caseId === SQL_FORMATTER_ANSI_ALIAS_CASE_ID) return new Set(["src/sqlFormatter.ts", "test/options/language.ts", "test/sqlFormatter.test.ts", "README.md", "CHANGELOG.md"]);
  return new Set(["proxy-auth-flow.md"]);
}

function requiredChangedFiles(caseId: FrontierCaseId): ReadonlySet<string> {
  if (caseId === OFETCH_RETRY_METHODS_CASE_ID) return new Set(["src/fetch.ts", "src/types.ts", "test/index.test.ts"]);
  if (caseId === TRUE_MYTH_INSPECT_BOTH_CASE_ID) return new Set(["src/result.ts", "test/result.test.ts"]);
  if (caseId === SQL_FORMATTER_ANSI_ALIAS_CASE_ID) return new Set(["src/sqlFormatter.ts", "test/sqlFormatter.test.ts"]);
  return new Set(["proxy-auth-flow.md"]);
}

async function runHidden(caseId: FrontierCaseId, cwd: string, runCommand: CommandRunner): Promise<CommandResult> {
  if (caseId === OFETCH_RETRY_METHODS_CASE_ID) {
    const script = `import { createFetch } from './dist/index.mjs';\nlet calls=0; const fetch=createFetch({fetch:async()=>{calls++; return new Response('x',{status:calls<2?500:200})}});\nawait fetch.raw('https://example.test',{method:'post',retryMethods:['POST'],retry:1}); if(calls!==2) throw Error('POST allowlist did not retry');\ncalls=0; try{await fetch.raw('https://example.test',{method:'GET',retryMethods:['post'],retry:1})}catch{} if(calls!==1) throw Error('method matching or deny behavior is wrong');`;
    return runCommand("node", ["--input-type=module", "--eval", script], { cwd });
  }
  if (caseId === TRUE_MYTH_INSPECT_BOTH_CASE_ID) {
    const script = `import Result, { inspectBoth } from './dist/result.js'; let seen=[]; const ok=Result.ok(3); const returned=ok.inspectBoth({Ok:v=>seen.push('o'+v),Err:e=>seen.push('e'+e)}); if(returned!==ok||seen.join()!=='o3') throw Error('method contract'); seen=[]; const err=Result.err('bad'); const returned2=inspectBoth({Ok:v=>seen.push('o'+v),Err:e=>seen.push('e'+e)})(err); if(returned2!==err||seen.join()!=='ebad') throw Error('helper contract');`;
    return runCommand("node", ["--input-type=module", "--eval", script], { cwd });
  }
  if (caseId === SQL_FORMATTER_ANSI_ALIAS_CASE_ID) {
    const hiddenPath = join(cwd, "test", ".relayer-ansi-alias.test.ts");
    await writeFile(hiddenPath, "import { format, supportedDialects } from '../src/sqlFormatter.js';\ntest('sealed ansi alias behavior', () => { expect(supportedDialects).toContain('ansi'); expect(format('select 1', { language: 'ansi', keywordCase: 'upper' })).toBe(format('select 1', { language: 'sql', keywordCase: 'upper' })); });\n", "utf8");
    try {
      return await runCommand("corepack", ["yarn@1.22.22", "jest", "test/.relayer-ansi-alias.test.ts", "--runInBand", "--coverage=false"], { cwd });
    } finally {
      await rm(hiddenPath, { force: true });
    }
  }
  const report = await readFile(join(cwd, "proxy-auth-flow.md"), "utf8").catch(() => "");
  const hasContent = report.trim().length > 0;
  return { exitCode: hasContent ? 0 : 1, stdout: "", stderr: hasContent ? "" : "The report artifact is empty or missing." };
}

async function ensureCache(directory: string, fixture: FrontierFixture, runCommand: CommandRunner): Promise<void> {
  try {
    await access(directory);
    await verifySource(directory, fixture, runCommand);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  const temporary = `${directory}.tmp-${randomUUID()}`;
  await mkdir(temporary, { mode: 0o700 });
  try {
    await required(runCommand, "git", ["init", "--quiet"], temporary);
    await required(runCommand, "git", ["remote", "add", "origin", fixture.repositoryUrl], temporary);
    await required(runCommand, "git", ["fetch", "--quiet", "--depth", "1", "origin", fixture.upstreamCommit], temporary);
    await required(runCommand, "git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"], temporary);
    await verifySource(temporary, fixture, runCommand);
    await rename(temporary, directory);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function verifySource(directory: string, fixture: FrontierFixture, runCommand: CommandRunner): Promise<void> {
  const commit = (await required(runCommand, "git", ["rev-parse", "HEAD"], directory)).stdout.trim();
  const tree = (await required(runCommand, "git", ["rev-parse", "HEAD^{tree}"], directory)).stdout.trim();
  if (commit !== fixture.upstreamCommit || tree !== fixture.upstreamTree) throw new Error(`Pinned source mismatch: ${commit}/${tree}.`);
}

async function required(runCommand: CommandRunner, command: string, args: readonly string[], cwd: string): Promise<CommandResult> {
  const result = await runCommand(command, args, { cwd });
  if (result.exitCode !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`);
  return result;
}

async function requireMissing(path: string): Promise<void> {
  try { await access(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  throw new Error(`Refusing to overwrite existing project-case workspace: ${path}`);
}

function lines(value: string): string[] { return value.split("\n").map((line) => line.trim()).filter(Boolean); }
function commandDetail(label: string, result: CommandResult): string { return result.exitCode === 0 ? `${label} passed.` : `${label} failed (${result.exitCode}): ${(result.stderr || result.stdout).trim().slice(-1_000) || "no output"}`; }

const run: CommandRunner = (command, args, options) => new Promise((resolve, reject) => {
  const child = spawn(command, [...args], { cwd: options.cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout = `${stdout}${chunk}`.slice(-64_000); });
  child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-64_000); });
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve({ exitCode: code ?? (signal ? 1 : 0), stdout, stderr: signal ? `${stderr}\nProcess stopped by ${signal}.` : stderr }));
});
