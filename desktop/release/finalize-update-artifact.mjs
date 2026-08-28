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
  if (contract.platform !== "darwin" || !contract.minimumUpdateSystemVersion) {
    throw new Error("macOS update artifact finalization requires the minimum update system version.");
  }
  const names = desktopReleaseArtifactNames(contract);
  const zipPath = join(distRoot, names.zip);
  const dmgPath = join(distRoot, names.dmg);
  const zipBlockmapPath = `${zipPath}.blockmap`;
  const dmgBlockmapPath = `${dmgPath}.blockmap`;
  const manifestPath = join(distRoot, names.manifest);
  const temporaryZipPath = `${zipPath}.${randomUUID()}.tmp`;
  const temporaryBlockmapPaths = [
    `${zipBlockmapPath}.${randomUUID()}.tmp`,
    `${dmgBlockmapPath}.${randomUUID()}.tmp`,
  ];
  const temporaryManifestPath = `${manifestPath}.${randomUUID()}.tmp`;

  try {
    await execute("/usr/bin/ditto", ["-c", "-k", "--norsrc", "--keepParent", appPath, temporaryZipPath]);
    const zipStat = await stat(temporaryZipPath);
    if (!zipStat.isFile() || zipStat.size === 0) throw new Error("Final update ZIP is empty.");
    await rename(temporaryZipPath, zipPath);

    const finalizedArtifacts = [];
    for (const [index, artifact] of [
      { path: zipPath, name: names.zip, blockmapPath: zipBlockmapPath },
      { path: dmgPath, name: names.dmg, blockmapPath: dmgBlockmapPath },
    ].entries()) {
      const temporaryBlockmapPath = temporaryBlockmapPaths[index];
      await createBlockMap({ inputPath: artifact.path, outputPath: temporaryBlockmapPath });
      const blockmapStat = await stat(temporaryBlockmapPath);
      if (!blockmapStat.isFile() || blockmapStat.size === 0) {
        throw new Error(`Final ${artifact.name} blockmap is empty.`);
      }
      await rename(temporaryBlockmapPath, artifact.blockmapPath);
      const digest = createHash("sha512");
      for await (const chunk of createReadStream(artifact.path)) digest.update(chunk);
      const artifactStat = await stat(artifact.path);
      finalizedArtifacts.push({
        ...artifact,
        sha512: digest.digest("base64"),
        size: artifactStat.size,
        blockMapSize: blockmapStat.size,
      });
    }

    const manifest = parseYaml(await readFile(manifestPath, "utf8"));
    if (!manifest || String(manifest.version) !== contract.version || !Array.isArray(manifest.files)) {
      throw new Error(`${names.manifest} is not a valid candidate manifest.`);
    }
    if (manifest.files.length !== finalizedArtifacts.length) {
      throw new Error(`${names.manifest} must contain exactly the update ZIP and DMG.`);
    }
    for (const artifact of finalizedArtifacts) {
      const entry = manifest.files.find((candidate) => candidate?.url === artifact.name);
      if (!entry) throw new Error(`${names.manifest} does not contain ${artifact.name}.`);
      entry.sha512 = artifact.sha512;
      entry.size = artifact.size;
      entry.blockMapSize = artifact.blockMapSize;
    }
    const finalizedZip = finalizedArtifacts.find((artifact) => artifact.name === names.zip);
    manifest.path = names.zip;
    manifest.sha512 = finalizedZip.sha512;
    manifest.minimumSystemVersion = contract.minimumUpdateSystemVersion;
    await writeFile(temporaryManifestPath, stringifyYaml(manifest), {
      encoding: "utf8",
      mode: 0o644,
      flag: "wx",
    });
    await rename(temporaryManifestPath, manifestPath);
    return { zipPath, dmgPath, zipBlockmapPath, dmgBlockmapPath, manifestPath };
  } finally {
    await Promise.all([
      rm(temporaryZipPath, { force: true }),
      ...temporaryBlockmapPaths.map((temporaryPath) => rm(temporaryPath, { force: true })),
      rm(temporaryManifestPath, { force: true }),
    ]);
  }
}
