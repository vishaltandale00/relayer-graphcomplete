import { expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { applyWindowsSyncProgram, verifyWindowsSyncStateProgram, safeWindowsSyncPath } from '../scripts/windows-dev-sync.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
it('rejects credentials and unsafe paths before source transfer', () => {
  for (const path of ['.env.local', 'desktop/.env', '.git/config', 'node_modules/pkg/x', '../file', 'foo\\bar', 'target/binary', 'secrets/credential.json', 'dir/file.', 'dir/file ', 'dir/CON.txt', 'dir/COM1']) expect(safeWindowsSyncPath(path)).toBe(false);
  expect(safeWindowsSyncPath('crates/server/src/main.rs')).toBe(true);
});
it('applies a verified source delta once, preserves rollback bytes and rejects a changed remote or parent symlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'win-source-delta-')); const source = join(root, 'source'); await mkdir(source);
  const program = join(root, 'apply.cjs'), bundle = join(root, 'bundle.gz'); await writeFile(program, applyWindowsSyncProgram);
  const run = async files => { const bytes = gzipSync(JSON.stringify({ schema: 'windows-source-delta/v1', id: 'test-loop', files })); await writeFile(bundle, bytes); return execFileSync(process.execPath, [program, source, bundle, sha(bytes)], { stdio: ['ignore', 'pipe', 'pipe'] }); };
  try {
    await writeFile(join(source, 'file.rs'), 'old');
    const file = { path: 'file.rs', before: sha('old'), after: sha('new'), data: Buffer.from('new').toString('base64') };
    await run([file]); expect(await readFile(join(source, 'file.rs'), 'utf8')).toBe('new');
    expect(await readFile(join(source, '.relayer/sync-backups/test-loop/file.rs'), 'utf8')).toBe('old');
    await expect(run([file])).rejects.toThrow();
    const lock = join(source, '.relayer/dev-lock/active-loop.json');
    await writeFile(lock, JSON.stringify({ id: 'active-build', phase: 'building' }));
    await expect(run([{ ...file, before: sha('new'), after: sha('next'), data: Buffer.from('next').toString('base64') }])).rejects.toThrow();
    expect(await readFile(join(source, 'file.rs'), 'utf8')).toBe('new');
    await rm(lock);
    await mkdir(join(root, 'outside')); await symlink(join(root, 'outside'), join(source, 'escape'));
    await expect(run([{ ...file, path: 'escape/file.rs', before: null }])).rejects.toThrow();
    await expect(readFile(join(root, 'outside/file.rs'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('reconciles a lost acknowledgement only for the exact retained remote identity and source bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'win-sync-reconcile-'));
  try {
    const program = join(root, 'verify.cjs'), state = { 'file.rs': sha('synced') }, digest = sha(JSON.stringify(state));
    await mkdir(join(root, '.relayer')); await writeFile(join(root, 'file.rs'), 'synced'); await writeFile(program, verifyWindowsSyncStateProgram);
    await writeFile(join(root, '.relayer/source-sync-state.json'), JSON.stringify({ id: 'sync-id', sourceDigest: digest, state }));
    const run = id => execFileSync(process.execPath, [program, root, id, digest, Buffer.from(JSON.stringify(state)).toString('base64')], { stdio: ['ignore', 'pipe', 'pipe'] });
    expect(JSON.parse(run('sync-id').toString())).toMatchObject({ syncId: 'sync-id', sourceDigest: digest });
    expect(() => run('another-sync')).toThrow();
    await writeFile(join(root, 'file.rs'), 'changed remotely'); expect(() => run('sync-id')).toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
