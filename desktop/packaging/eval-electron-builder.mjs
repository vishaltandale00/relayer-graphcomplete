import { resolve } from "node:path";
import { desktopTargetFromEnvironment } from "../shared/target.mjs";

const desktopRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(desktopRoot, "..");
const target = desktopTargetFromEnvironment(process.env);
const rustTarget = process.env.RELAYER_DESKTOP_RUST_TARGET || target.rustTarget;
const binarySuffix = target.platform === "win32" ? ".exe" : "";

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
    "main/single-instance.mjs",
    "preload/eval-*.cjs",
    "node_modules/**/*",
  ],
  extraResources: [
    { from: resolve(repositoryRoot, `target/${rustTarget}/release/relayer-app-server${binarySuffix}`), to: `bin/relayer-app-server${binarySuffix}` },
    { from: resolve(repositoryRoot, `target/${rustTarget}/release/relayer-graph-server${binarySuffix}`), to: `bin/relayer-graph-server${binarySuffix}` },
    { from: resolve(repositoryRoot, "harnesses"), to: "harnesses", filter: ["*.yaml"] },
    { from: resolve(repositoryRoot, "packages/graph-client/dist"), to: "graph-client" },
    { from: resolve(desktopRoot, "renderer"), to: "renderer" },
    { from: resolve(desktopRoot, "eval-renderer"), to: "eval-renderer" },
  ],
  artifactName: "Relayer-Eval-\${version}-\${os}-\${arch}.\${ext}",
  afterPack: target.platform === "darwin" ? "desktop/packaging/verify-bundled-app-server.mjs" : undefined,
  mac: {
    category: "public.app-category.developer-tools",
    icon: resolve(desktopRoot, "renderer/assets/relayer-logo.svg"),
    target: [{ target: "dir", arch: [target.architecture] }],
    identity: null,
    minimumSystemVersion: "13.0",
  },
  win: {
    icon: resolve(desktopRoot, "renderer/assets/relayer-logo.svg"),
    target: [{ target: "nsis", arch: [target.architecture] }],
  },
};
