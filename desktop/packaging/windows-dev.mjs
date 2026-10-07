import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preparePinnedLadybugForPackaging, requireLadybugDistributionLicenseReady, withPinnedLadybugPackagingEnvironment } from './pinned-ladybug-build.mjs';
export const WINDOWS_DEV_RUNTIME_INPUT_PATHS = ['desktop/packaging/windows-dev.mjs', 'scripts/windows-dev-environment.cmd', 'scripts/windows-dev-preflight.cmake', 'crates', 'Cargo.lock', 'Cargo.toml', '.cargo', 'docs/graph-query-v1.md', 'docs/icon-catalog.json', 'fixtures/graph-query-v1', 'vendor/ladybug', 'scripts/prepare-ladybug-source.mjs', 'desktop/packaging/windows-ladybug-toolchain.cmake', 'scripts/verify-ladybug-native-receipts.mjs', 'desktop/packaging/pinned-ladybug-build.mjs', 'desktop/packaging/build-cache.mjs', 'desktop/packaging/windows-native.mjs', 'desktop/shared/target.mjs', 'scripts/ci/packaging-input-contract.json'];
export const WINDOWS_DEV_NATIVE_INPUT_PATHS = ['vendor/ladybug', 'scripts/prepare-ladybug-source.mjs', 'desktop/packaging/windows-ladybug-toolchain.cmake', 'scripts/verify-ladybug-native-receipts.mjs', 'desktop/packaging/pinned-ladybug-build.mjs', 'desktop/packaging/build-cache.mjs', 'scripts/ci/packaging-input-contract.json'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function run(command, args, options) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { ...options, stdio: 'inherit' });
    child.once('error', reject); child.once('exit', code => code === 0 ? accept() : reject(new Error(`${command} exited ${code}`)));
  });
}
export async function digestWindowsDevInputs(root, paths) {
  const files = [];
  async function visit(relative) {
    const path = join(root, relative); let info;
    try { info = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (info.isSymbolicLink()) throw new Error(`Dev input must not be a symlink: ${relative}`);
    if (info.isDirectory()) for (const name of (await readdir(path)).sort()) await visit(`${relative}/${name}`);
    else if (info.isFile()) files.push([relative, sha(await readFile(path))]);
  }
  for (const path of [...paths].sort()) await visit(path);
  return sha(JSON.stringify(files));
}
export function windowsDevNativeBuildIdentity(preparationIdentity, generators, orchestrationDigest) {
  return sha(JSON.stringify({ preparationIdentity, generators, orchestrationDigest }));
}
export async function windowsDevCMakeGeneratorIdentity({ cmakeExecutable, command, workspaceRoot }) {
  // CMake may create __cmake_systeminformation while probing. Keep all scratch
  // outside the audited source checkout and remove it even when the query fails.
  const scratch = await mkdtemp(join(workspaceRoot, 'cmake-system-info-'));
  let information;
  try { information = command(cmakeExecutable, ['--system-information'], { cwd: scratch }); }
  finally { await rm(scratch, { recursive: true, force: true }); }
  const runtime = /^CMAKE_ROOT "([^"\r\n]+)"\r?$/m.exec(information)?.[1];
  if (!runtime || !(await lstat(runtime)).isDirectory()) throw new Error('Selected CMake runtime directory is missing.');
  // Hash the actual selected installation, including every module/template.
  // Missing roots must not collapse into digestWindowsDevInputs' empty digest.
  if (!(await lstat(join(runtime, 'Modules', 'CMake.cmake'))).isFile()) throw new Error('Selected CMake module tree is missing.');
  return { path: runtime, sha256: await digestWindowsDevInputs(runtime, ['.']) };
}
export async function verifyWindowsDevNativeOutputs({ root, target, runtimeDigest }) {
  let previous, attempt;
  try {
    previous = JSON.parse(await readFile(join(root, 'native-state.json'), 'utf8'));
    attempt = JSON.parse(await readFile(join(root, 'native-attempt.json'), 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') throw new Error('No completed local native attempt exists: run --rust first.'); throw error; }
  if (attempt.schema !== 'windows-dev-native-attempt/v1' || !/^[a-f0-9]{64}$/.test(previous.nativeIdentity ?? '')
    || !/^[a-f0-9]{64}$/.test(previous.preparationIdentity ?? '') || !/^[a-f0-9]{64}$/.test(attempt.orchestrationDigest ?? '')
    || attempt.nativeIdentity !== previous.nativeIdentity || attempt.preparationIdentity !== previous.preparationIdentity)
    throw new Error('Latest native attempt has not completed successfully: run --rust first.');
  if (previous.runtimeDigest !== runtimeDigest) throw new Error('Rust source changed or no local native build exists: run --rust first.');
  const names = ['relayer-app-server.exe', 'relayer-graph-server.exe'];
  if (!previous.files || JSON.stringify(Object.keys(previous.files).sort()) !== JSON.stringify([...names].sort())) throw new Error('Incomplete local native output marker.');
  for (const name of names) if (sha(await readFile(join(target, 'x86_64-pc-windows-msvc/release', name))) !== previous.files[name]) throw new Error(`Local native output changed: ${name}`);
  return previous;
}
export async function beginWindowsDevNativeAttempt({ root, nativeIdentity, preparationIdentity, orchestrationDigest, execute, options }) {
  const path = join(root, 'native-attempt.json');
  let previous;
  try { previous = JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const mode = previous?.nativeIdentity === nativeIdentity ? 'reuse'
    : previous?.preparationIdentity === preparationIdentity && previous?.orchestrationDigest === orchestrationDigest ? 'ladybug-only' : 'all-native';
  if (mode !== 'reuse') {
    // Cleanup can fail after deleting some outputs. Revoke old success before
    // it starts; retain the old attempt until cleanup succeeds so retry repeats it.
    await rm(join(root, 'native-state.json'), { force: true });
    await execute('cargo', ['clean', ...(mode === 'ladybug-only' ? ['-p', 'lbug'] : []), '--release', '--target', 'x86_64-pc-windows-msvc'], options);
  }
  // Commit only after invalidation succeeds, before Cargo can produce outputs.
  // Failed Cargo attempts keep this identity; the success marker stays separate.
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify({ schema: 'windows-dev-native-attempt/v1', nativeIdentity, preparationIdentity, orchestrationDigest, at: new Date().toISOString() }));
  await rename(temporary, path);
  return mode;
}
export async function windowsDevLoop({ repositoryRoot = resolve(import.meta.dirname, '../..'), environment = process.env,
  rust = false, allowCold = false, execute = run, command = (name, args, options = {}) => execFileSync(name, args, { ...options, env: environment, encoding: 'utf8' }).trim(),
  platform = process.platform, prepareLadybug = preparePinnedLadybugForPackaging, now = () => performance.now() } = {}) {
  if (platform !== 'win32') throw new Error('Run desktop:dev:windows in the initialized Windows compiler workspace; the Mac sync command is desktop:sync:windows.');
  if (environment.RELAYER_DESKTOP_RUST_TARGET && environment.RELAYER_DESKTOP_RUST_TARGET !== 'x86_64-pc-windows-msvc') throw new Error('Windows Dev packaging requires the fixed x86_64-pc-windows-msvc Rust target.');
  if (environment.RELAYER_DESKTOP_RELEASE || environment.RUSTFLAGS || environment.CARGO_ENCODED_RUSTFLAGS || environment.RUSTC_WRAPPER || environment.RUSTC_WORKSPACE_WRAPPER) throw new Error('Dev loop rejects release authority and custom compiler flags/wrappers.');
  const unsupported = Object.keys(environment).filter(name => /^(RUSTC$|RUSTDOC$|CC$|CC_|CXX|CPP|CFLAGS|CXXFLAGS|AR$|AR_|LD$|LD_|LDFLAGS|CARGO_BUILD_|CARGO_TARGET_|CARGO_PROFILE_|CMAKE_|CCACHE_|SDKROOT$|C_INCLUDE_PATH$|CPLUS_INCLUDE_PATH$|OBJC_INCLUDE_PATH$|CPATH$|LIBRARY_PATH$|DYLD|PKG_CONFIG|SOURCE_DATE_EPOCH$|OPENSSL_|LBUG_)/i.test(name) && environment[name]);
  if (unsupported.length) throw new Error(`Unsupported native build inputs: ${unsupported.join(', ')}`);
  const root = 'C:\\RelayerDev', target = join(root, 'cargo-target');
  await mkdir(root, { recursive: true });
  const lease = JSON.parse(await readFile(join(root, 'active-loop.json'), 'utf8'));
  if (!environment.RELAYER_DEV_LOOP_ID || lease.id !== environment.RELAYER_DEV_LOOP_ID || lease.phase !== 'building' || lease.pid !== process.pid) throw new Error('Use the serialized desktop:dev:windows command.');
  const started = now(), stages = [], receipt = { schema: 'windows-dev-loop/v1', scope: 'unsigned-development', startedAt: new Date().toISOString(), stages, rust, sourceDigest: environment.RELAYER_DEV_SOURCE_DIGEST };
  async function stage(name, operation) { const start = now(); try { return await operation(); } finally { stages.push({ name, seconds: (now() - start) / 1000 }); } }

  const runtimeDigest = await digestWindowsDevInputs(repositoryRoot, WINDOWS_DEV_RUNTIME_INPUT_PATHS);
  const marker = join(root, 'native-state.json'); let previous;
  try { previous = JSON.parse(await readFile(marker, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try {
    if (rust) {
      // Tool hashes and fixed native prefix bind this local cache. It is never a
      // release-native artifact and cannot be adopted by the protected workflow.
      // Git's MSYS Perl cannot configure the native MSVC OpenSSL target.
      command('perl', ['-e', "die qq(Native Windows Perl required) unless $^O eq 'MSWin32'; require IPC::Cmd; print qq(native-perl-ok)"]);
      const tools = {};
      for (const tool of ['cl.exe', 'link.exe', 'nmake.exe', 'perl.exe', 'cmake.exe', 'ninja.exe', 'rustc.exe', 'cargo.exe']) {
        const path = command('where.exe', [tool]).split(/\r?\n/)[0]; tools[tool] = { path, sha256: sha(await readFile(path)) };
      }
      const nativeInputs = await digestWindowsDevInputs(repositoryRoot, WINDOWS_DEV_NATIVE_INPUT_PATHS);
      const preparationIdentity = sha(JSON.stringify({ repositoryRoot, target: 'windows-x64', tools, nativeInputs, rustVersion: command('rustc', ['-vV']), cargoVersion: command('cargo', ['-vV']), sdk: environment.WindowsSDKVersion, sdkDirectory: environment.WindowsSdkDir, compilerEnvironment: Object.fromEntries(["CL", "_CL_", "LINK", "_LINK_", "INCLUDE", "LIB", "LIBPATH", "VCINSTALLDIR", "VCToolsInstallDir"].map(key => [key, environment[key] ?? null])) }));
      // CMake modules, Python and ccache affect Ladybug compilation, but do not prepare its
      // source tree or static OpenSSL. Preserve that verified prefix when only
      // generators change; invalidate the compiled Ladybug outputs separately.
      const generators = { cmakeRuntime: await windowsDevCMakeGeneratorIdentity({ cmakeExecutable: tools['cmake.exe'].path, command, workspaceRoot: root }) };
      for (const tool of ['python.exe', 'ccache.exe']) {
        const path = command('where.exe', [tool]).split(/\r?\n/)[0];
        generators[tool] = { path, sha256: sha(await readFile(path)) };
        if (tool === 'python.exe') generators.pythonRuntime = await digestWindowsDevInputs(dirname(path), ['.']);
      }
      command('python', ['-c', "import sys; assert (3,9) <= sys.version_info[:2] < (4,0); import json,sysconfig; print('native-python-ok')"]);
      const orchestrationDigest = await digestWindowsDevInputs(repositoryRoot, ['desktop/packaging/windows-dev.mjs', 'scripts/windows-dev-environment.cmd', 'scripts/windows-dev-preflight.cmake']);
      const identity = windowsDevNativeBuildIdentity(preparationIdentity, generators, orchestrationDigest);
      receipt.preparationIdentity = preparationIdentity;
      receipt.nativeIdentity = identity;
      receipt.cacheDecision = previous?.nativeIdentity === identity ? 'warm local Cargo workspace; native inputs reverified' : 'no compatible local cache; checked trusted release caches separately; local cold build required';
      if (previous?.nativeIdentity !== identity && !allowCold) throw new Error('Cold native build required. Inspect verified cache availability, then rerun with --rust --allow-cold.');
      await stage('license', () => requireLadybugDistributionLicenseReady());
      await stage('Cargo fetch', () => execute('cargo', ['fetch', '--locked', '--target', 'x86_64-pc-windows-msvc'], { cwd: repositoryRoot, env: environment }));
      const buildEnvironment = { ...environment, CCACHE_DISABLE: '1', CARGO_TARGET_DIR: target, CARGO_PROFILE_RELEASE_DEBUG: '1', CARGO_PROFILE_RELEASE_INCREMENTAL: 'true' };
      receipt.nativeTransition = await stage('native cache transition', () => beginWindowsDevNativeAttempt({ root, nativeIdentity: identity, preparationIdentity, orchestrationDigest, execute, options: { cwd: repositoryRoot, env: buildEnvironment } }));
      await withPinnedLadybugPackagingEnvironment({ environment: buildEnvironment, target: { key: 'windows-x64', rustTarget: 'x86_64-pc-windows-msvc' },
        prepareLadybug: options => stage('verified native preparation', () => prepareLadybug({ ...options, cache: { root: join(root, 'native-cache'), native: preparationIdentity } })),
      }, (env, integrity) => stage('Cargo release', () => execute('cargo', ['build', '--release', '-p', 'relayer-app-server', '-p', 'relayer-graph-server', '--target', 'x86_64-pc-windows-msvc', ...integrity], { cwd: repositoryRoot, env })));
      const files = {};
      for (const name of ['relayer-app-server.exe', 'relayer-graph-server.exe']) files[name] = sha(await readFile(join(target, 'x86_64-pc-windows-msvc/release', name)));
      await writeFile(marker, JSON.stringify({ nativeIdentity: identity, preparationIdentity, runtimeDigest, files }, null, 2));
    } else {
      await verifyWindowsDevNativeOutputs({ root, target, runtimeDigest });
      receipt.cacheDecision = 'verified unchanged local Rust outputs; Cargo skipped';
    }
    await stage('JavaScript packages and renderer', () => execute(environment.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm.cmd run prepare:desktop-runtime'], { cwd: repositoryRoot, env: environment }));
    await stage('Electron assembly and package qualification', () => execute(process.execPath, [join(repositoryRoot, 'node_modules/electron-builder/out/cli/cli.js'), '--config', 'desktop/packaging/electron-builder.mjs', '--win', '--x64', '--dir', '--publish', 'never'], {
      cwd: repositoryRoot, env: { ...environment, RELAYER_DESKTOP_TARGET: 'windows-x64', RELAYER_DESKTOP_RUST_TARGET: 'x86_64-pc-windows-msvc', RELAYER_CARGO_TARGET_DIR: target },
    }));
    receipt.result = 'passed';
  } catch (error) { receipt.result = 'failed'; receipt.failure = error.message; throw error; }
  finally {
    receipt.seconds = (now() - started) / 1000; receipt.runtimeDigest = runtimeDigest;
    const slowest = [...stages].sort((a, b) => b.seconds - a.seconds)[0];
    receipt.bottleneck = slowest?.name ?? 'preflight';
    receipt.nextOptimization = slowest?.name === 'Cargo release' ? 'Inspect Cargo timings; keep the compiler, target and native prefix fixed.' : slowest?.name === 'Electron assembly and package qualification' ? 'Use verified Dev-only file deltas between full packages; installer qualification still requires a fresh exact-source package.' : 'Compare stage receipts before changing the build route.';
    await appendFile(join(root, 'loops.jsonl'), `${JSON.stringify(receipt)}\n`); console.log(JSON.stringify(receipt));
  }
  return receipt;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await windowsDevLoop({ rust: process.argv.includes('--rust'), allowCold: process.argv.includes('--allow-cold') });
}
