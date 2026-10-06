import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readInstalledWindowsMetadata } from './read-windows-install-metadata.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex'), executeDefault = promisify(execFile);
async function filesBelow(root, prefix = '') {
  const files = [];
  for (const entry of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error('Installer inventory rejects symlinks.');
    if (entry.isDirectory()) files.push(...await filesBelow(root, path)); else if (entry.isFile()) files.push(path);
  }
  return files;
}
export async function collectWindowsInstallerFiles({ installer, sevenZip, installedRoot, execute = executeDefault }) {
  const temporary = await mkdtemp(join(tmpdir(), 'relayer-installer-inventory-'));
  try {
    const outer = join(temporary, 'installer'), payload = join(temporary, 'application');
    await execute(sevenZip, ['x', installer, `-o${outer}`, '-y'], { maxBuffer: 1024 * 1024 });
    const packages = (await filesBelow(outer)).filter(name => /(?:^|\/)app-64\.7z$/i.test(name));
    if (packages.length !== 1) throw new Error('Installer must contain exactly one Windows x64 app-64.7z payload.');
    await execute(sevenZip, ['x', join(outer, packages[0]), `-o${payload}`, '-y'], { maxBuffer: 1024 * 1024 });
    const files = [];
    for (const name of await filesBelow(payload)) {
      const candidate = await readFile(join(payload, name)), installedPath = join(installedRoot, name);
      const info = await lstat(installedPath); if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Installed payload file is invalid: ${name}`);
      const candidateSha256 = sha(candidate), installedSha256 = sha(await readFile(installedPath));
      if (candidateSha256 !== installedSha256) throw new Error(`Installed file differs from exact installer payload: ${name}`);
      files.push({ path: name, candidateSha256, installedSha256 });
    }
    for (const name of ['Relayer.exe', 'resources/app.asar', 'resources/node/node.exe', 'resources/bin/relayer-app-server.exe', 'resources/bin/relayer-graph-server.exe']) if (!files.some(file => file.path === name)) throw new Error(`Required installer payload file missing: ${name}`);
    return { schema: 'windows-installer-payload/v1', installerSha256: sha(await readFile(installer)), metadata: await readInstalledWindowsMetadata(join(payload, 'resources/app.asar')), files };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [installer, sevenZip, installedRoot, output] = process.argv.slice(2);
  await writeFile(output, JSON.stringify(await collectWindowsInstallerFiles({ installer, sevenZip, installedRoot }), null, 2), { flag: 'wx' });
}
