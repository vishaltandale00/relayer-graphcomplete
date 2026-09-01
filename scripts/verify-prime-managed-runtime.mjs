import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createManagedRuntimeInstaller } from "../desktop/main/managed-runtimes/installer.mjs";
import {
  assemblePrimeManagedRuntime,
  checkPrimeManagedRuntime,
  createPrimeReviewedTreeCopier,
} from "../desktop/main/services/prime-managed-runtime.mjs";
import {
  PRIME_AGENT_ASSET_SHA256,
  PRIME_AGENT_REPOSITORY_DEPENDENCY_CLOSURE_SHA256,
} from "../desktop/main/services/prime-agent-runtime.mjs";

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("Prime managed runtime proof is defined only for macOS arm64.");
}

const repositoryRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const root = await mkdtemp(join(tmpdir(), "relayer-prime-managed-runtime-"));
try {
  const copyReviewedTrees = createPrimeReviewedTreeCopier({
    appRoot: repositoryRoot,
    pythonClientRoot: join(repositoryRoot, "python", "relayer-graph", "src"),
    expectedClosureSha256: PRIME_AGENT_REPOSITORY_DEPENDENCY_CLOSURE_SHA256,
    expectedPythonClientSha256: PRIME_AGENT_ASSET_SHA256.pythonPackageTree,
  });
  const installer = createManagedRuntimeInstaller({
    root,
    assembleRecipe: (context) => assemblePrimeManagedRuntime(context, { copyReviewedTrees }),
  });
  const runtime = await installer.prepare("prime@0.8.1");
  const readiness = await checkPrimeManagedRuntime({ runtime });
  if (readiness.available !== true) throw new Error("Prime managed runtime readiness failed.");
  process.stdout.write(`${JSON.stringify({
    recipeId: runtime.recipeId,
    recipeDigest: runtime.recipeDigest,
    target: runtime.target,
    javascriptClosureKind: "repository",
    javascriptClosureSha256: PRIME_AGENT_REPOSITORY_DEPENDENCY_CLOSURE_SHA256,
    ready: true,
  })}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
