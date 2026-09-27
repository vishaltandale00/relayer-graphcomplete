import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { requireEvalArtifacts } from "../desktop/eval-main/runtime-artifacts.mjs";

requireEvalArtifacts();
const compiledEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
// Reuse the real recursive fixture, but exercise the entry point loaded by agents.
export default defineConfig({
  resolve: { alias: [
    { find: /^(?:\.\.\/)+src\/index\.js$/, replacement: compiledEntry },
    { find: fileURLToPath(new URL("../src/index.js", import.meta.url)), replacement: compiledEntry },
  ] },
  test: { include: ["test/recursive-complete-e2e.test.mjs"], testTimeout: 15_000 },
});
