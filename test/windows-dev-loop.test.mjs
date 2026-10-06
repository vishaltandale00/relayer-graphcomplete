import { expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { digestWindowsDevInputs, windowsDevLoop } from '../desktop/packaging/windows-dev.mjs';
it('detects real Rust input changes and rejects source symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'win-dev-inputs-'));
  try {
    await writeFile(join(root, 'main.rs'), 'fn main() {}');
    const first = await digestWindowsDevInputs(root, ['main.rs']);
    await writeFile(join(root, 'main.rs'), 'fn main() { println!("changed"); }');
    expect(await digestWindowsDevInputs(root, ['main.rs'])).not.toBe(first);
    await symlink(join(root, 'main.rs'), join(root, 'linked.rs'));
    await expect(digestWindowsDevInputs(root, ['linked.rs'])).rejects.toThrow('symlink');
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('cannot turn the unsigned dev entrypoint into a release or run without a Windows compiler environment', async () => {
  await expect(windowsDevLoop({ platform: 'darwin' })).rejects.toThrow('Windows compiler workspace');
  await expect(windowsDevLoop({ platform: 'win32', environment: { RELAYER_DESKTOP_RELEASE: '1' } })).rejects.toThrow('release authority');
  for (const name of ['CC', 'CFLAGS', 'CMAKE_TOOLCHAIN_FILE', 'OPENSSL_DIR']) await expect(windowsDevLoop({ platform: 'win32', environment: { [name]: 'custom' } })).rejects.toThrow('Unsupported native build inputs');
});
import { ensureWindowsDevDependencies } from '../scripts/run-windows-dev-loop.mjs';
it('retries failed dependency setup, and skips only after an exact lockfile success marker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'win-dev-deps-'));
  const { mkdir } = await import('node:fs/promises');
  try {
    await writeFile(join(root, 'package-lock.json'), '{"lockfileVersion":3}');
    await mkdir(join(root, 'node_modules')); await writeFile(join(root, 'node_modules/.package-lock.json'), '{}');
    let calls = 0;
    await expect(ensureWindowsDevDependencies({ repositoryRoot: root, execute: async () => { calls++; throw new Error('npm failed'); } })).rejects.toThrow('npm failed');
    await ensureWindowsDevDependencies({ repositoryRoot: root, execute: async () => { calls++; } });
    expect(calls).toBe(2);
    expect((await ensureWindowsDevDependencies({ repositoryRoot: root, execute: async () => { calls++; } })).mode).toBe('verified dependency hit');
    expect(calls).toBe(2);
    await writeFile(join(root, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}');
    await ensureWindowsDevDependencies({ repositoryRoot: root, execute: async () => { calls++; } }); expect(calls).toBe(3);
  } finally { await rm(root, { recursive: true, force: true }); }
});

import { claimWindowsDevLease } from '../scripts/run-windows-dev-loop.mjs';
it('allows exactly one build to claim a source-sync lease and retains it on rejected claims', async () => {
  const root = await mkdtemp(join(tmpdir(), 'win-dev-lease-'));
  const { readFile } = await import('node:fs/promises');
  try {
    await writeFile(join(root, 'active-loop.json'), JSON.stringify({ id: 'sync-1', phase: 'sync-ready' }));
    await expect(claimWindowsDevLease({ root, syncId: 'wrong-sync' })).rejects.toThrow('does not own');
    expect(JSON.parse(await readFile(join(root, 'active-loop.json'), 'utf8')).phase).toBe('sync-ready');
    const results = await Promise.allSettled([claimWindowsDevLease({ root, syncId: 'sync-1' }), claimWindowsDevLease({ root, syncId: 'sync-1' })]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const winner = results.find(result => result.status === 'fulfilled').value;
    expect(JSON.parse(await readFile(join(root, 'active-loop.json'), 'utf8'))).toMatchObject({ id: 'sync-1', phase: 'building', pid: process.pid });
    await winner.release();
    const next = await claimWindowsDevLease({ root }); await next.release();
  } finally { await rm(root, { recursive: true, force: true }); }
});
