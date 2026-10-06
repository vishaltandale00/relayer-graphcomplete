import { expect, it } from 'vitest';
import { createDesktopBuilderConfig } from '../desktop/packaging/electron-builder.mjs';
import { resolveDesktopReleaseContract } from '../desktop/release/contract.mjs';
it('packages app-owned Node and app-local VC runtime for Windows only', () => {
  const windows = resolveDesktopReleaseContract({ environment: { RELAYER_DESKTOP_TARGET: 'windows-x64' }, version: '0.2.0', sourceCommit: 'a'.repeat(40) });
  const resources = createDesktopBuilderConfig(windows).extraResources;
  expect(resources.find(entry => entry.to === 'node')?.filter).toContain('node.exe');
  expect(resources.find(entry => entry.to === 'bin' && entry.filter?.includes('*.dll'))).toBeDefined();
  const mac = resolveDesktopReleaseContract({ environment: { RELAYER_DESKTOP_TARGET: 'macos-arm64' }, version: '0.2.0', sourceCommit: 'a'.repeat(40) });
  expect(createDesktopBuilderConfig(mac).extraResources.some(entry => entry.to === 'node')).toBe(false);
});
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareWindowsNodeRuntime, verifyNodeInput, windowsAppRuntimeRoot } from '../desktop/packaging/windows-app-runtime.mjs';
import { packagedWindowsNodePath } from '../desktop/shared/windows-node-runtime.mjs';
it('rejects a changed official archive before extraction and leaves no usable runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'windows-node-pin-'));
  let extracted = false;
  try {
    await expect(prepareWindowsNodeRuntime({ repositoryRoot: root,
      download: async () => ({ ok: true, arrayBuffer: async () => Buffer.from('tampered archive') }),
      extract: async () => { extracted = true; },
    })).rejects.toThrow('archive identity mismatch');
    expect(extracted).toBe(false);
    await expect(verifyNodeInput(join(windowsAppRuntimeRoot(root), 'node'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('fails closed for corrupted cached Node and never repairs it by downloading silently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'windows-node-corrupt-'));
  let downloaded = false;
  try {
    const directory = join(windowsAppRuntimeRoot(root), 'node'); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'node.exe'), 'changed executable');
    await expect(prepareWindowsNodeRuntime({ repositoryRoot: root, download: async () => { downloaded = true; } })).rejects.toThrow('input identity mismatch');
    expect(downloaded).toBe(false);
    await rm(join(directory, 'node.exe')); await symlink(join(root, 'elsewhere'), join(directory, 'node.exe'));
    await expect(packagedWindowsNodePath(windowsAppRuntimeRoot(root))).rejects.toThrow('missing or invalid');
  } finally { await rm(root, { recursive: true, force: true }); }
});
