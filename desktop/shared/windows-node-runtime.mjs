import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
export const WINDOWS_NODE_RUNTIME = Object.freeze({
  version: '22.23.2', target: 'win-x64',
  archive: 'node-v22.23.2-win-x64.zip',
  archiveSha256: '1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97',
  executableSha256: '0d0f5e39f9f3d9587bc19f73eab3c2c9c4903fd02d6dbf9c853dd81b3d95fad4',
  licenseSha256: '8cc9bb466b19fc7e7cc99d03e9df1132021fda8b01eea2624c58bb372dbef576',
});
export async function packagedWindowsNodePath(resourcesPath) {
  const path = join(resourcesPath, 'node', 'node.exe');
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size === 0) throw new Error('Packaged Windows Node executable is missing or invalid.');
  return path;
}
