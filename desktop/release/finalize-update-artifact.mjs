import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { buildBlockMap } from "app-builder-lib/out/targets/blockmap/blockmap.js";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { desktopReleaseArtifactNames } from "./artifacts.mjs";

const execFileAsync = promisify(execFile);

export async function finalizeDesktopUpdateArtifact({
  appPath,
  contract,
  distRoot,
  execute = execFileAsync,
  createBlockMap = ({ inputPath, outputPath }) => buildBlockMap(inputPath, "gzip", outputPath),
} = {}) {
  if (!contract?.release) throw new Error("Update artifact finalization requires the signed release contract.");
  const names = desktopReleaseArtifactNames(contract);
  const zipPath = join(distRoot, names.zip);
  const zipBlockmapPath = `${zipPath}.blockmap`;
  const manifestPath = join(distRoot, names.manifest);
  const temporaryZipPath = `${zipPath}.${randomUUID()}.tmp`;
  const temporaryBlockmapPath = `${zipBlockmapPath}.${randomUUID()}.tmp`;
  const temporaryManifestPath = `${manifestPath}.${randomUUID()}.tmp`;

  try {
    await execute("/usr/bin/ditto", ["-c", "-k", "--norsrc", "--keepParent", appPath, temporaryZipPath]);
    const zipStat = await stat(temporaryZipPath);
    if (!zipStat.isFile() || zipStat.size === 0) throw new Error("Final update ZIP is empty.");
    await rename(temporaryZipPath, zipPath);

    await createBlockMap({ inputPath: zipPath, outputPath: temporaryBlockmapPath });
    const blockmapStat = await stat(temporaryBlockmapPath);
    if (!blockmapStat.isFile() || blockmapStat.size === 0) throw new Error("Final update ZIP blockmap is empty.");
    await rename(temporaryBlockmapPath, zipBlockmapPath);

    // The existing manifest still seals the pre-finalization ZIP, so compute the
    // new ZIP evidence directly before rewriting that manifest.
    const digest = createHash("sha512");
    for await (const chunk of createReadStream(zipPath)) digest.update(chunk);
    const zipSha512 = digest.digest("base64");
    const finalZipStat = await stat(zipPath);

    const manifest = parseYaml(await readFile(manifestPath, "utf8"));
    if (!manifest || String(manifest.version) !== contract.version || !Array.isArray(manifest.files)) {
      throw new Error(`${names.manifest} is not a valid candidate manifest.`);
    }
    const zipEntry = manifest.files.find((entry) => entry?.url === names.zip);
    if (!zipEntry) throw new Error(`${names.manifest} does not contain the update ZIP.`);
    zipEntry.sha512 = zipSha512;
    zipEntry.size = finalZipStat.size;
    zipEntry.blockMapSize = blockmapStat.size;
    manifest.path = names.zip;
    manifest.sha512 = zipSha512;
    await writeFile(temporaryManifestPath, stringifyYaml(manifest), {
      encoding: "utf8",
      mode: 0o644,
      flag: "wx",
    });
    await rename(temporaryManifestPath, manifestPath);
    return { zipPath, zipBlockmapPath, manifestPath };
  } finally {
    await Promise.all([
      rm(temporaryZipPath, { force: true }),
      rm(temporaryBlockmapPath, { force: true }),
      rm(temporaryManifestPath, { force: true }),
    ]);
  }
}
