import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { resolveDesktopNotarizationCredentials } from "./contract.mjs";

const execFileAsync = promisify(execFile);

export async function notarizeAndStapleDesktopDMGs({
  distRoot,
  environment = process.env,
  execute = (command, args) => execFileAsync(command, args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  }),
} = {}) {
  if (environment.RELAYER_DESKTOP_RELEASE !== "1") {
    throw new Error("DMG notarization requires explicit desktop release mode.");
  }
  const notarization = resolveDesktopNotarizationCredentials(environment);
  const entries = await readdir(distRoot, { withFileTypes: true });
  const dmgPaths = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".dmg"))
    .map((entry) => join(distRoot, entry.name))
    .sort();
  if (dmgPaths.length !== 1) {
    throw new Error(`Expected exactly one DMG beneath ${distRoot}; found ${dmgPaths.length}.`);
  }

  for (const dmgPath of dmgPaths) {
    const submission = await execute("/usr/bin/xcrun", [
      "notarytool",
      "submit",
      dmgPath,
      ...notarization.notarytoolArgs,
      "--wait",
      "--output-format",
      "json",
    ]);
    let result;
    try {
      result = JSON.parse(String(submission.stdout || ""));
    } catch {
      throw new Error("Apple notarytool returned invalid JSON for the Relayer DMG.");
    }
    if (result.status !== "Accepted") {
      throw new Error(`Apple notarization returned ${String(result.status || "unknown")} for the Relayer DMG.`);
    }
    await execute("/usr/bin/xcrun", ["stapler", "staple", dmgPath]);
    await execute("/usr/bin/xcrun", ["stapler", "validate", dmgPath]);
    await execute("/usr/sbin/spctl", [
      "--assess",
      "--type",
      "open",
      "--context",
      "context:primary-signature",
      "--verbose=4",
      dmgPath,
    ]);
  }
  return { dmgPaths, notarizationMode: notarization.mode };
}
