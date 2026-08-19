import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

import { desktopReleaseArtifactNames } from "./artifacts.mjs";
import { verifyMacOSApplication } from "./verify-macos-app.mjs";
import { verifyPackagedDesktopContract } from "./verify-packaged-contract.mjs";

const execFileAsync = promisify(execFile);

export async function verifyDesktopUpdateZip({ contract, distRoot, execute = execFileAsync } = {}) {
  const names = desktopReleaseArtifactNames(contract);
  const zipPath = join(distRoot, names.zip);
  const listing = await execute("/usr/bin/unzip", ["-Z1", zipPath], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  const entries = String(listing.stdout || "").split("\n").filter(Boolean);
  if (
    entries.length === 0 ||
    entries.some((entry) => entry.startsWith("/") || entry.includes("../") || entry.startsWith("__MACOSX/"))
  ) {
    throw new Error("Desktop update ZIP contains entries outside the one-app archive boundary.");
  }

  const extractedRoot = await mkdtemp(join(tmpdir(), "relayer-update-zip-"));
  try {
    await execute("/usr/bin/ditto", ["-x", "-k", zipPath, extractedRoot]);
    const extractedEntries = await readdir(extractedRoot, { withFileTypes: true });
    const apps = extractedEntries.filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"));
    if (apps.length !== 1 || apps[0].name !== "Relayer.app" || extractedEntries.length !== 1) {
      throw new Error("Desktop update ZIP must contain exactly one Relayer.app bundle.");
    }
    const appPath = join(extractedRoot, apps[0].name);
    await verifyMacOSApplication(appPath, {
      assessNotarization: true,
      execute,
      expectedArchitecture: contract.architecture === "x64" ? "x86_64" : contract.architecture,
    });
    await verifyPackagedDesktopContract({ appPath, contract });
    return { zipPath, appPath: basename(appPath) };
  } finally {
    await rm(extractedRoot, { recursive: true, force: true });
  }
}
