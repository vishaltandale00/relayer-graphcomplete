import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");

await Promise.all([
  rm(resolve(repositoryRoot, "dist"), { recursive: true, force: true }),
  rm(resolve(repositoryRoot, "packages/graph-client/dist"), { recursive: true, force: true }),
  rm(resolve(repositoryRoot, "packages/harness-host/dist"), { recursive: true, force: true }),
  rm(resolve(repositoryRoot, "packages/eval-runner/dist"), { recursive: true, force: true }),
]);
