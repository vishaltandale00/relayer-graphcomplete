import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

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
