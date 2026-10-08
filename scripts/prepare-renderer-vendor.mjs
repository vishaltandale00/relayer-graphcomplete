import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { build } from "rolldown";

import { buildDesign } from "./design/build.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const vendorDirectory = resolve(repositoryRoot, "desktop/renderer/vendor");

await mkdir(vendorDirectory, { recursive: true });
await copyFile(
  resolve(repositoryRoot, "node_modules/marked/lib/marked.umd.js"),
  resolve(vendorDirectory, "marked.umd.js"),
);
await copyFile(
  resolve(repositoryRoot, "node_modules/lucide/dist/umd/lucide.min.js"),
  resolve(vendorDirectory, "lucide.min.js"),
);
// Office renderers for the artifact viewer (PRD 6.6.9), served only inside artifact views.
await build({
  input: resolve(repositoryRoot, "desktop/artifact-office/index.js"),
  platform: "browser",
  logLevel: "warn",
  output: { file: resolve(vendorDirectory, "artifact-office.js"), format: "iife", minify: true },
});
await buildDesign();
