import { mkdir, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "rolldown";

const packageRoot = resolve(import.meta.dirname, "..");
const outputRoot = resolve(packageRoot, "agent-resource");

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
await build({
  input: resolve(packageRoot, "dist/index.js"),
  platform: "node",
  output: {
    file: resolve(outputRoot, "index.js"),
    format: "esm",
    codeSplitting: false,
  },
});

const entries = await readdir(outputRoot);
if (entries.length !== 1 || entries[0] !== "index.js") {
  throw new Error(`Packaged graph-client agent resource must contain only index.js; found ${entries.join(", ")}`);
}
