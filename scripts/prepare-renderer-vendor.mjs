import { access, copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

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
const office = await build({
  input: resolve(repositoryRoot, "desktop/artifact-office/index.js"),
  platform: "browser",
  logLevel: "warn",
  output: { file: resolve(vendorDirectory, "artifact-office.js"), format: "iife", minify: true },
});
await writeFile(resolve(vendorDirectory, "artifact-office.LICENSES.txt"), await bundledLicences(office.output[0].moduleIds));

/**
 * Every package in the bundle with its licence text; a package without one fails the build.
 * A package's own dependencies are included too, since a prebuilt browser file (JSZip's)
 * inlines them without separate modules.
 */
async function bundledLicences(moduleIds) {
  const roots = new Set();
  for (const id of moduleIds) {
    const path = id.replaceAll("\\", "/");
    const at = path.lastIndexOf("/node_modules/");
    if (at < 0) continue;
    const [scope, name] = path.slice(at + "/node_modules/".length).split("/");
    roots.add(path.slice(0, at + "/node_modules/".length) + (scope.startsWith("@") ? `${scope}/${name}` : scope));
  }
  const sections = [];
  for (const root of roots) {
    const manifest = JSON.parse(await readFile(`${root}/package.json`, "utf8"));
    // A dependency the package's `browser` field replaces never reaches the bundle.
    const replaced = typeof manifest.browser === "object" && manifest.browser !== null ? manifest.browser : {};
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      if (!Object.hasOwn(replaced, dependency)) roots.add(await packageRoot(root, dependency));
    }
    const file = (await readdir(root)).find((entry) => /^licen[cs]e(\.|$)/iu.test(entry));
    if (!file) throw new Error(`${manifest.name} is bundled into artifact-office.js but ships no licence file.`);
    sections.push(`== ${manifest.name} ${manifest.version} (${manifest.license ?? "see below"}) ==\n\n${(await readFile(`${root}/${file}`, "utf8")).trim()}\n`);
  }
  sections.sort();
  return `Third-party software bundled in artifact-office.js.\n\n${sections.join("\n")}`;
}

/** Where Node would find `name` from the package at `from`. */
async function packageRoot(from, name) {
  for (let directory = from; directory !== dirname(directory); directory = dirname(directory)) {
    const candidate = resolve(directory, "node_modules", name);
    if (await access(resolve(candidate, "package.json")).then(() => true, () => false)) return candidate;
  }
  throw new Error(`${name} is not installed.`);
}
await buildDesign();
