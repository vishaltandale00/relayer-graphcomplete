import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadDesktopReleaseContract } from "./contract.mjs";
import { desktopReleaseAppPath } from "./app-path.mjs";
import { verifyDesktopReleaseEvidence } from "./artifacts.mjs";
import { verifyMacOSApplication } from "./verify-macos-app.mjs";
import { verifyPackagedDesktopContract } from "./verify-packaged-contract.mjs";
import { verifyDesktopUpdateZip } from "./verify-update-zip.mjs";
import { verifyWindowsRelease } from "./verify-windows-app.mjs";

export async function verifyBuiltDesktopRelease({ environment = process.env } = {}) {
  const desktopRoot = resolve(import.meta.dirname, "..");
  const distRoot = resolve(desktopRoot, "dist");
  const contract = await loadDesktopReleaseContract({ environment, desktopRoot });
  if (!contract.release) throw new Error("Artifact verification requires explicit desktop release mode.");
  const appPath = desktopReleaseAppPath({ distRoot, contract });
  if (contract.platform === "darwin") {
    await verifyMacOSApplication(appPath, {
      assessNotarization: true,
      expectedArchitecture: contract.architecture === "x64" ? "x86_64" : contract.architecture,
    });
    await verifyDesktopUpdateZip({ contract, distRoot });
  } else {
    await verifyWindowsRelease({ appOutDir: appPath, distRoot, contract });
  }
  await verifyPackagedDesktopContract({ appPath, contract });
  return verifyDesktopReleaseEvidence({ distRoot, contract });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await verifyBuiltDesktopRelease();
  console.log(JSON.stringify({ ok: true, receipt: result.names.receipt }, null, 2));
}
