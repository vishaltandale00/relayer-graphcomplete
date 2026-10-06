import { open, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export async function readInstalledWindowsMetadata(archive) {
  const file = await open(archive, 'r');
  try {
    const prefix = Buffer.alloc(16); if ((await file.read(prefix, 0, 16, 0)).bytesRead !== 16) throw new Error('Truncated installed ASAR.');
    const headerSize = prefix.readUInt32LE(4), jsonSize = prefix.readUInt32LE(12);
    if (prefix.readUInt32LE(0) !== 4 || headerSize < 8 || headerSize > 16 * 1024 * 1024 || jsonSize > headerSize - 8) throw new Error('Invalid installed ASAR header.');
    const bytes = Buffer.alloc(jsonSize); if ((await file.read(bytes, 0, jsonSize, 16)).bytesRead !== jsonSize) throw new Error('Truncated ASAR inventory.');
    const entry = JSON.parse(bytes).files?.['package.json'];
    if (!entry || entry.unpacked || entry.link || !/^(0|[1-9]\d*)$/.test(entry.offset) || !Number.isSafeInteger(entry.size) || entry.size <= 0 || entry.size > 1024 * 1024) throw new Error('Installed package metadata is not a bounded packed file.');
    const content = Buffer.alloc(entry.size); if ((await file.read(content, 0, entry.size, 8 + headerSize + Number(entry.offset))).bytesRead !== entry.size) throw new Error('Truncated installed metadata.');
    const digest = createHash('sha256').update(content).digest('hex'); if (digest !== entry.integrity?.hash) throw new Error('Installed metadata integrity mismatch.');
    const packageMetadata = JSON.parse(content);
    return { schema: 'windows-installed-metadata/v1', sourceCommit: packageMetadata.relayerReleaseSourceCommit,
      version: packageMetadata.version, target: packageMetadata.relayerReleaseTarget, channel: packageMetadata.relayerUpdateChannel,
      artifactMode: packageMetadata.relayerArtifactMode, product: packageMetadata.relayerProductName, metadataSha256: digest };
  } finally { await file.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [archive, output] = process.argv.slice(2); await writeFile(output, JSON.stringify(await readInstalledWindowsMetadata(archive), null, 2), { flag: 'wx' });
}
