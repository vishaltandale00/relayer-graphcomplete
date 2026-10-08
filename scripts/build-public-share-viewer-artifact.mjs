import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { buildDesign } from "./design/build.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const rendererRoot = join(repositoryRoot, "desktop/renderer");
const contractPath = join(repositoryRoot, "contracts/share-service-v1/contract.json");
const builder = "scripts/build-public-share-viewer-artifact.mjs@1";

const browserResources = Object.freeze([
  "assets/relayer-logo.svg",
  "assets/relayer-mark-mask.svg",
  "styles.css",
  "vendor/lucide.min.js",
  "vendor/marked.umd.js",
  "src/action-invocation-state.js",
  "src/api.js",
  "src/approval-model.js",
  "src/composer-drafts.js",
  "src/control-activation.js",
  "src/environment-context.js",
  "src/interaction-failure-model.js",
  "src/model-picker-model.js",
  "src/model-picker.js",
  "src/node-context-drafts.js",
  "src/node-input-controls.js",
  "src/product-workspace/annotations.js",
  "src/product-workspace/composer-submission.js",
  "src/product-workspace/edge-shapes.js",
  "src/product-workspace/graph-layout.js",
  "src/product-workspace/icons.js",
  "src/product-workspace/image-icons.js",
  "src/product-workspace/index.js",
  "src/product-workspace/interaction-graph.js",
  "src/product-workspace/invoke-inputs.js",
  "src/product-workspace/layer-selection.js",
  "src/product-workspace/markdown.js",
  "src/product-workspace/model.js",
  "src/product-workspace/node-detail-runtime.js",
  "src/product-workspace/run-state.js",
  "src/product-workspace/view.js",
  "src/product-workspace/workspace.js",
  "src/product-workspace/workspace-layout.js",
  "src/public-share-viewer/adapter.js",
  "src/public-share-viewer/main.js",
  "src/public-share-viewer/snapshot.js",
  "src/public-share-viewer/viewer.css",
  "src/share-publish-ui.js",
  "src/ui.js"
]);

const logicalAssets = Object.freeze({
  logo: "assets/relayer-logo.svg",
  ogImage: "design/share-og.svg",
  viewerScript: "src/public-share-viewer/main.js",
  viewerStyles: "src/public-share-viewer/viewer.css",
  workspaceStyles: "styles.css",
  lucideScript: "vendor/lucide.min.js",
  markedScript: "vendor/marked.umd.js"
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function outputArgument(argv) {
  const index = argv.indexOf("--output");
  const value = index >= 0 ? argv[index + 1] : null;
  if (!value || value.startsWith("--")) throw new Error("Usage: node scripts/build-public-share-viewer-artifact.mjs --output <directory>");
  return resolve(value);
}

async function copyHashed(source, destination, manifestPath, files) {
  const bytes = await readFile(source);
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { force: true });
  files[manifestPath] = Object.freeze({ bytes: bytes.byteLength, sha256: sha256(bytes) });
}

async function main() {
  const output = outputArgument(process.argv.slice(2));
  const productCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
  const dirty = Boolean(execFileSync("git", ["status", "--porcelain"], { cwd: repositoryRoot, encoding: "utf8" }).trim());
  if (dirty) throw new Error("Viewer artifacts require a clean committed source tree.");
  const contract = JSON.parse(await readFile(contractPath, "utf8"));
  const prefix = `assets/${productCommit}`;
  const files = {};

  // Shares always carry the committed default design, whatever a local build prepared.
  const design = await buildDesign({ selection: "" });
  for (const path of [...browserResources, ...design.files]) {
    await copyHashed(join(rendererRoot, path), join(output, prefix, path), `${prefix}/${path}`, files);
  }
  await copyHashed(
    join(rendererRoot, "src/public-share-viewer/template.js"),
    join(output, "server/template.js"),
    "server/template.js",
    files,
  );
  await copyHashed(contractPath, join(output, "contract.json"), "contract.json", files);

  const canonicalFiles = Object.entries(files)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, identity]) => `${path}\0${identity.bytes}\0${identity.sha256}\n`)
    .join("");
  const assets = Object.fromEntries(Object.entries(logicalAssets).map(([key, path]) => [key, `${prefix}/${path}`]));
  const resources = Object.fromEntries(Object.entries(logicalAssets).map(([key, path]) => {
    const artifactPath = `${prefix}/${path}`;
    return [key, { path: artifactPath, ...files[artifactPath] }];
  }));
  const manifest = {
    version: 1,
    contractVersion: contract.contractVersion,
    productCommit,
    sourceDirty: dirty,
    artifactSha256: sha256(canonicalFiles),
    builder,
    snapshotVersions: [...contract.snapshot.exportVersions],
    csp: contract.viewerArtifact.csp,
    assets,
    resources,
    files,
  };
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${join(output, "manifest.json")}\n`);
}

await main();
