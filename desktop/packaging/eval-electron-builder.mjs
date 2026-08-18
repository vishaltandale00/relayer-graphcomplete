import { resolve } from "node:path";

const desktopRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(desktopRoot, "..");

export default {
  appId: "ai.relayer.eval",
  productName: "Relayer Eval",
  electronVersion: "43.0.0",
  npmRebuild: false,
  asar: true,
  directories: { app: desktopRoot, output: resolve(desktopRoot, "eval-dist") },
  extraMetadata: { main: "eval-main/index.mjs" },
  files: [
    "package.json",
    "eval-main/**/*",
    "main/services/**/*",
    "preload/eval-*.cjs",
    "node_modules/**/*",
  ],
  extraResources: [
    { from: resolve(repositoryRoot, "target/aarch64-apple-darwin/release/relayer-app-server"), to: "bin/relayer-app-server" },
    { from: resolve(repositoryRoot, "target/aarch64-apple-darwin/release/relayer-graph-server"), to: "bin/relayer-graph-server" },
    { from: resolve(repositoryRoot, "harnesses"), to: "harnesses", filter: ["*.yaml"] },
    { from: resolve(repositoryRoot, "packages/graph-client/dist"), to: "graph-client" },
    { from: resolve(desktopRoot, "renderer"), to: "renderer" },
    { from: resolve(desktopRoot, "eval-renderer"), to: "eval-renderer" },
  ],
  artifactName: "Relayer-Eval-\${version}-mac-\${arch}.\${ext}",
  afterPack: "desktop/packaging/verify-bundled-app-server.mjs",
  mac: {
    category: "public.app-category.developer-tools",
    icon: resolve(desktopRoot, "renderer/assets/relayer-logo.svg"),
    target: [{ target: "dir", arch: ["arm64"] }],
    identity: null,
    minimumSystemVersion: "13.0",
  },
};
