import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isNumericVersion } from "./numeric-version.mjs";
import { desktopTargetByKey } from "../shared/target.mjs";

export async function loadDesktopVersion({ desktopRoot, targetKey }) {
  const target = desktopTargetByKey(targetKey);
  const metadata = JSON.parse(await readFile(resolve(desktopRoot,
    target.platform === "win32" ? "windows-version.json" : "package.json"), "utf8"));
  if (!isNumericVersion(metadata.version)) throw new Error("Desktop version must be numeric major.minor.patch.");
  return metadata.version;
}

export function desktopReleaseTag(version, targetKey) {
  if (!isNumericVersion(version)) throw new Error("Desktop version must be numeric major.minor.patch.");
  return `${desktopTargetByKey(targetKey).platform === "win32" ? "desktop-windows-v" : "desktop-v"}${version}`;
}
