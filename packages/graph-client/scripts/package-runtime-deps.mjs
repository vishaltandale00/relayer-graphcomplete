import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(packageRoot, "..", "..");
const outputRoot = resolve(packageRoot, "dist");
const runtimeDependencies = [
  { name: "css-tree", version: "3.1.0", source: resolve(repositoryRoot, "node_modules/css-tree") },
  { name: "mdn-data", version: "2.12.2", source: resolve(repositoryRoot, "node_modules/mdn-data") },
  { name: "source-map-js", version: "1.2.1", source: resolve(repositoryRoot, "node_modules/source-map-js") },
  { name: "parse5", version: "8.0.0", source: resolve(packageRoot, "node_modules/parse5") },
  { name: "entities", version: "6.0.1", source: resolve(repositoryRoot, "node_modules/entities") },
];

await mkdir(resolve(outputRoot, "node_modules"), { recursive: true });
for (const dependency of runtimeDependencies) {
  const manifest = JSON.parse(await readFile(resolve(dependency.source, "package.json"), "utf8"));
  if (manifest.name !== dependency.name || manifest.version !== dependency.version) {
    throw new Error(`Graph client runtime dependency ${dependency.name} must be exactly ${dependency.version}`);
  }
  await cp(dependency.source, resolve(outputRoot, "node_modules", dependency.name), { recursive: true });
}
await writeFile(resolve(outputRoot, "package.json"), `${JSON.stringify({
  name: "@relayer/graph-client-packaged-runtime",
  private: true,
  type: "module",
})}\n`);
