import { expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, symlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { digestWindowsDevInputs, WINDOWS_DEV_RUNTIME_INPUT_PATHS, WINDOWS_DEV_NATIVE_INPUT_PATHS, windowsDevLoop, windowsDevNativeBuildIdentity, beginWindowsDevNativeAttempt, verifyWindowsDevNativeOutputs, windowsDevCMakeGeneratorIdentity } from '../desktop/packaging/windows-dev.mjs';
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
  await expect(windowsDevLoop({ platform: 'win32', environment: { RELAYER_DESKTOP_RUST_TARGET: 'another-x64-target' } })).rejects.toThrow('fixed x86_64-pc-windows-msvc');
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

it('restores changed installed dependency bytes and rejects an escaping dependency link without baselining it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'win-dependency-integrity-'));
  const { mkdir, readFile } = await import('node:fs/promises');
  try {
    await writeFile(join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {
      'node_modules/@relayer/fixture': { resolved: 'packages/fixture', link: true },
    } }));
    await mkdir(join(root, 'packages/fixture/dist'), { recursive: true });
    await writeFile(join(root, 'packages/fixture/dist/index.js'), 'generated workspace output');
    let calls = 0;
    const execute = async () => {
      calls++; await rm(join(root, 'node_modules'), { recursive: true, force: true });
      await mkdir(join(root, 'node_modules/pkg'), { recursive: true });
      await mkdir(join(root, 'node_modules/@relayer'), { recursive: true });
      await writeFile(join(root, 'node_modules/.package-lock.json'), '{}');
      await writeFile(join(root, 'node_modules/pkg/index.js'), 'trusted locked dependency');
      await symlink(join(root, 'packages/fixture'), join(root, 'node_modules/@relayer/fixture'), 'junction');
    };
    await ensureWindowsDevDependencies({ repositoryRoot: root, execute });
    expect((await ensureWindowsDevDependencies({ repositoryRoot: root, execute })).mode).toBe('verified dependency hit');
    expect(calls).toBe(1);
    await writeFile(join(root, 'packages/fixture/dist/index.js'), 'new generated workspace output');
    expect((await ensureWindowsDevDependencies({ repositoryRoot: root, execute })).mode).toBe('verified dependency hit');
    await writeFile(join(root, 'node_modules/pkg/index.js'), 'changed dependency');
    expect((await ensureWindowsDevDependencies({ repositoryRoot: root, execute })).mode).toBe('installed locked dependencies');
    expect(calls).toBe(2);
    expect(await readFile(join(root, 'node_modules/pkg/index.js'), 'utf8')).toBe('trusted locked dependency');
    await writeFile(join(root, 'node_modules/pkg/unreviewed-postinstall.js'), 'unreviewed output');
    await ensureWindowsDevDependencies({ repositoryRoot: root, execute }); expect(calls).toBe(3);
    const outside = await mkdtemp(join(tmpdir(), 'win-dependency-outside-'));
    try {
      await rm(join(root, 'node_modules/pkg/index.js'));
      await symlink(join(outside, 'private.txt'), join(root, 'node_modules/pkg/index.js'));
      await expect(ensureWindowsDevDependencies({ repositoryRoot: root, execute: async () => { throw Error('restore unavailable'); } })).rejects.toThrow('restore unavailable');
      await expect(readFile(join(root, '.relayer/npm-dependencies.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(outside, { recursive: true, force: true }); }
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

it('invalidates compiled native identity for generator changes while preserving its preparation identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'win-dev-generator-'));
  try {
    await writeFile(join(root, 'python313.zip'), 'original stdlib');
    const preparationIdentity = 'a'.repeat(64);
    const first = windowsDevNativeBuildIdentity(preparationIdentity, { python: await digestWindowsDevInputs(root, ['.']) }, 'orchestration');
    await writeFile(join(root, 'python313.zip'), 'changed stdlib');
    const next = windowsDevNativeBuildIdentity(preparationIdentity, { python: await digestWindowsDevInputs(root, ['.']) }, 'orchestration');
    expect(next).not.toBe(first);
    expect(windowsDevNativeBuildIdentity(preparationIdentity, { python: await digestWindowsDevInputs(root, ['.']) }, 'changed orchestration')).not.toBe(next);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('retains failed-attempt identity and scopes invalidation before admitting new Cargo outputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'win-native-attempt-'));
  const { readFile } = await import('node:fs/promises');
  const calls = [];
  const begin = (nativeIdentity, preparationIdentity = 'prep', orchestrationDigest = 'producer', execute = async (_, args) => { calls.push(args); }) => beginWindowsDevNativeAttempt({ root, nativeIdentity, preparationIdentity, orchestrationDigest, execute, options: {} });
  try {
    expect(await begin('first')).toBe('all-native');
    // Simulate Cargo failing after Ladybug finished: no success marker exists.
    expect(await begin('first')).toBe('reuse');
    expect(calls).toHaveLength(1);
    expect(await begin('python-changed')).toBe('ladybug-only');
    expect(calls.at(-1)).toContain('lbug');
    const old = await readFile(join(root, 'native-attempt.json'), 'utf8');
    await expect(begin('compiler-changed', 'new-prep', 'producer', async () => { throw Error('cleanup failed'); })).rejects.toThrow('cleanup failed');
    expect(await readFile(join(root, 'native-attempt.json'), 'utf8')).toBe(old);
    expect(await begin('compiler-changed', 'new-prep')).toBe('all-native');
    expect(calls.at(-1)).not.toContain('-p');
    expect(await begin('producer-changed', 'new-prep', 'new-producer')).toBe('all-native');
    expect(calls.at(-1)).not.toContain('-p');
    expect(JSON.parse(await readFile(join(root, 'native-attempt.json'), 'utf8')).nativeIdentity).toBe('producer-changed');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('binds selected CMake runtime bytes and rejects an incomplete selected module tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'win-cmake-runtime-'));
  try {
    await mkdir(join(root, 'Modules'));
    await writeFile(join(root, 'Modules/CMake.cmake'), 'selected original module');
    const command = (tool, args, options) => { expect(tool).toBe('selected-cmake.exe'); expect(args).toEqual(['--system-information']); expect(options.cwd.startsWith(join(root, 'cmake-system-info-'))).toBe(true); return `CMAKE_ROOT "${root}"`; };
    const first = await windowsDevCMakeGeneratorIdentity({ cmakeExecutable: 'selected-cmake.exe', command, workspaceRoot: root });
    await expect(windowsDevCMakeGeneratorIdentity({ cmakeExecutable: 'selected-cmake.exe', command: () => { throw Error('metadata failed'); }, workspaceRoot: root })).rejects.toThrow('metadata failed');
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(root)).some(name => name.startsWith('cmake-system-info-'))).toBe(false);
    await writeFile(join(root, 'Modules/CMake.cmake'), 'selected changed module');
    const next = await windowsDevCMakeGeneratorIdentity({ cmakeExecutable: 'selected-cmake.exe', command, workspaceRoot: root });
    expect(windowsDevNativeBuildIdentity('same-preparation', { cmakeRuntime: next }, 'producer')).not.toBe(windowsDevNativeBuildIdentity('same-preparation', { cmakeRuntime: first }, 'producer'));
    await symlink(join(root, 'Modules/CMake.cmake'), join(root, 'Modules/linked.cmake'));
    await expect(windowsDevCMakeGeneratorIdentity({ cmakeExecutable: 'selected-cmake.exe', command, workspaceRoot: root })).rejects.toThrow('symlink');
    await rm(join(root, 'Modules/linked.cmake')); await rm(join(root, 'Modules/CMake.cmake'));
    await expect(windowsDevCMakeGeneratorIdentity({ cmakeExecutable: 'selected-cmake.exe', command, workspaceRoot: root })).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('refuses old successful executables after a failed generator transition until the latest attempt succeeds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'win-native-success-')), target = join(root, 'target');
  const { createHash } = await import('node:crypto');
  const files = {}, runtimeDigest = 'runtime', preparationIdentity = 'c'.repeat(64), orchestrationDigest = 'd'.repeat(64);
  const first = 'a'.repeat(64), next = 'b'.repeat(64);
  const begin = (nativeIdentity, execute = async () => {}) => beginWindowsDevNativeAttempt({ root, nativeIdentity, preparationIdentity, orchestrationDigest, execute, options: {} });
  const verify = () => verifyWindowsDevNativeOutputs({ root, target, runtimeDigest });
  try {
    await mkdir(join(target, 'x86_64-pc-windows-msvc/release'), { recursive: true });
    for (const name of ['relayer-app-server.exe', 'relayer-graph-server.exe']) {
      await writeFile(join(target, 'x86_64-pc-windows-msvc/release', name), name);
      files[name] = createHash('sha256').update(name).digest('hex');
    }
    await begin(first);
    await writeFile(join(root, 'native-state.json'), JSON.stringify({ nativeIdentity: first, preparationIdentity, runtimeDigest, files }));
    await expect(verify()).resolves.toMatchObject({ nativeIdentity: first });
    const { readFile } = await import('node:fs/promises');
    const oldAttempt = await readFile(join(root, 'native-attempt.json'), 'utf8');
    await expect(begin(next, async () => { throw Error('partial cleanup failed'); })).rejects.toThrow('partial cleanup failed');
    expect(await readFile(join(root, 'native-attempt.json'), 'utf8')).toBe(oldAttempt);
    await expect(verify()).rejects.toThrow('No completed local native attempt');
    let cleanupCalls = 0;
    expect(await begin(next, async (_, args) => { cleanupCalls++; expect(args).toContain('lbug'); })).toBe('ladybug-only');
    expect(cleanupCalls).toBe(1); // Retry repeats cleanup; Cargo then fails with old executable bytes still present.
    await expect(verify()).rejects.toThrow('No completed local native attempt');
    expect(await begin(next)).toBe('reuse');
    await expect(verify()).rejects.toThrow('No completed local native attempt');
    await writeFile(join(root, 'native-state.json'), JSON.stringify({ nativeIdentity: next, preparationIdentity, runtimeDigest, files }));
    await expect(verify()).resolves.toMatchObject({ nativeIdentity: next });
    await writeFile(join(target, 'x86_64-pc-windows-msvc/release/relayer-app-server.exe'), 'corrupted');
    await expect(verify()).rejects.toThrow('Local native output changed');
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Dev output reuse and native preparation have separate identities; both must
// include the CMake file that changes effective C++ compilation.
it('invalidates both Dev input identities when the owned Ladybug toolchain changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'win-dev-toolchain-'));
  try {
    const path = join(root, 'desktop/packaging/windows-ladybug-toolchain.cmake');
    await mkdir(join(root, 'desktop/packaging'), { recursive: true });
    await writeFile(path, 'reviewed Embedded debug format');
    const before = await Promise.all([WINDOWS_DEV_RUNTIME_INPUT_PATHS, WINDOWS_DEV_NATIVE_INPUT_PATHS].map(paths => digestWindowsDevInputs(root, paths)));
    await writeFile(path, 'changed debug format');
    const after = await Promise.all([WINDOWS_DEV_RUNTIME_INPUT_PATHS, WINDOWS_DEV_NATIVE_INPUT_PATHS].map(paths => digestWindowsDevInputs(root, paths)));
    expect(after[0]).not.toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
