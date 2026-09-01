import { join } from "node:path";

import { desktopTargetFromEnvironment } from "../shared/target.mjs";
import { verifyPackagedLadybugNotices } from "./verify-bundled-app-server.mjs";

// The Eval package bundles the compiled Ladybug graph server but not the Prime
// Agent runtime or the full desktop shell, so its afterPack hook verifies only
// the Ladybug notices (present + exact digest + no unlisted files) rather than
// the complete desktop bundle.
export default async function verifyElectronBuilderBundledNotices(context) {
  const productFilename = String(context?.packager?.appInfo?.productFilename || "").trim();
  const appOutDir = String(context?.appOutDir || "").trim();
  if (!productFilename || !appOutDir) {
    throw new Error("electron-builder afterPack context is missing the packaged app path.");
  }
  const target = desktopTargetFromEnvironment(process.env);
  const appPath = target.platform === "darwin" ? join(appOutDir, `${productFilename}.app`) : appOutDir;
  const resourcesPath = target.platform === "darwin"
    ? join(appPath, "Contents", "Resources")
    : join(appPath, "resources");
  return verifyPackagedLadybugNotices(resourcesPath);
}
