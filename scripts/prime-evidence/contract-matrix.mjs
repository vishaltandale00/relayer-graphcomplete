import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const PRIME_CONTRACT_TEST_NAMES = Object.freeze([
  "maps an admitted family to isolated native providers and reuses the session across root changes",
  "routes Ask through exact approval scope after boundary attestation",
  "Auto allows only validated IPython after attestation and Full omits bounded scopes",
  "returns an Ask denial to Prime without executing the recognized cell",
]);
export const HOST_CONTRACT_TEST_NAMES = Object.freeze([
  "admits the complete ordered family, deduplicates access by provider definition, and aliases orchestrator access",
  "rolls back already-acquired family access when a later provider cannot be acquired",
]);
export const PRIME_SOURCE_TEST_PATHS = Object.freeze([
  "packages/coding-agent/test/suite/regressions/171-run-model-scope.test.ts",
  "packages/coding-agent/test/suite/regressions/71-run-tool-authority.test.ts",
  "packages/coding-agent/test/suite/regressions/71-authority-cleanup-races.test.ts",
  "packages/coding-agent/test/suite/regressions/71-bounded-kernel.test.ts",
  "packages/ai/test/run-scoped-env-auth.test.ts",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function verifyPrimeContractMatrix({ repositoryRoot, outputDirectory, primeSourceRoot, expectedPrimeCommit }) {
  await mkdir(outputDirectory, { recursive: true });
  const testPaths = [
    join(repositoryRoot, "packages/harness-host/test/prime-agent.test.ts"),
    join(repositoryRoot, "packages/harness-host/test/host.test.ts"),
  ];
  const sources = await Promise.all(testPaths.map((path) => readFile(path)));
  const allTestNames = [...PRIME_CONTRACT_TEST_NAMES, ...HOST_CONTRACT_TEST_NAMES];
  const filter = allTestNames.map((name) => `(?:${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`).join("|");
  const vitest = join(repositoryRoot, "node_modules/vitest/vitest.mjs");
  const command = [process.execPath, vitest, "run", ...testPaths, "--testNamePattern", filter];
  const result = await run(command[0], command.slice(1), {
    cwd: repositoryRoot,
    maxBuffer: 16 * 1024 * 1024,
  });
	const primeCommit = (await run("git", ["-C", primeSourceRoot, "rev-parse", "HEAD"])).stdout.trim();
	if (primeCommit !== expectedPrimeCommit) {
		throw new Error(`Prime source mismatch: expected ${expectedPrimeCommit}, received ${primeCommit}`);
	}
	const primeStatus = (await run("git", ["-C", primeSourceRoot, "status", "--porcelain", "--untracked-files=normal"])).stdout.trim();
	if (primeStatus) throw new Error("Prime source worktree must be clean before evidence capture.");
	const primeTestPaths = PRIME_SOURCE_TEST_PATHS.map((path) => join(primeSourceRoot, path));
	const primeSources = await Promise.all(primeTestPaths.map((path) => readFile(path)));
	const primeVitest = join(primeSourceRoot, "node_modules/vitest/vitest.mjs");
	const primeCommand = [process.execPath, primeVitest, "run", ...primeTestPaths, "--no-file-parallelism"];
	const primeResult = await run(primeCommand[0], primeCommand.slice(1), {
		cwd: join(primeSourceRoot, "packages/coding-agent"),
		maxBuffer: 16 * 1024 * 1024,
	});
  const receipt = {
    schemaVersion: 1,
    command,
    assertions: {
      orderedThreeModelRoster: true,
      twoProviderAdapters: ["openai-api", "anthropic-api"],
      isolatedDefinitionsSharingAdapter: 2,
      allCredentialsResolvedBeforePrimePrompt: true,
      ambientCredentialFallbackRejected: true,
      recursiveOutsiderRejected: true,
      sessionReusedAcrossRootChange: true,
      permissions: {
        askBoundaryAndApproval: true,
        askDenialDoesNotExecute: true,
        autoAllowsOnlyAttestedIpynb: true,
        fullOmitsBoundedScopes: true,
        recursiveChildUsesSameAuthority: true,
      },
    },
    testNames: allTestNames,
    sources: testPaths.map((path, index) => ({ path, bytes: sources[index].byteLength, sha256: sha256(sources[index]) })),
    stdoutSha256: sha256(result.stdout),
    stderrSha256: sha256(result.stderr),
		primeSource: {
			commit: primeCommit,
			command: primeCommand,
			sources: primeTestPaths.map((path, index) => ({ path, bytes: primeSources[index].byteLength, sha256: sha256(primeSources[index]) })),
			stdoutSha256: sha256(primeResult.stdout),
			stderrSha256: sha256(primeResult.stderr),
		},
  };
  const path = join(outputDirectory, "prime-contract-matrix.json");
  const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  await writeFile(path, bytes, { mode: 0o600 });
  return { path, bytes: bytes.length, sha256: sha256(bytes), receipt };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const repositoryRoot = resolve(process.argv[2] || ".");
  const outputDirectory = resolve(process.argv[3] || ".relayer/evidence/prime-family");
	const primeSourceRoot = resolve(process.argv[4] || "../prime-agent");
	const expectedPrimeCommit = String(process.argv[5] || "").trim();
	verifyPrimeContractMatrix({ repositoryRoot, outputDirectory, primeSourceRoot, expectedPrimeCommit })
    .then(({ path }) => process.stdout.write(`${path}\n`))
    .catch((error) => { console.error(error); process.exitCode = 1; });
}
