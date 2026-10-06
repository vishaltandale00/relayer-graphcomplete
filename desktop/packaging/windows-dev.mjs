import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preparePinnedLadybugForPackaging, requireLadybugDistributionLicenseReady, withPinnedLadybugPackagingEnvironment } from './pinned-ladybug-build.mjs';
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
export async function windowsDevLoop({ repositoryRoot = resolve(import.meta.dirname, '../..'), environment = process.env,
  rust = false, allowCold = false, execute = run, command = (name, args) => execFileSync(name, args, { env: environment, encoding: 'utf8' }).trim(),
  platform = process.platform, prepareLadybug = preparePinnedLadybugForPackaging, now = () => performance.now() } = {}) {
  if (platform !== 'win32') throw new Error('Run desktop:dev:windows in the initialized Windows compiler workspace; the Mac sync command is desktop:sync:windows.');
  if (environment.RELAYER_DESKTOP_RELEASE || environment.RUSTFLAGS || environment.CARGO_ENCODED_RUSTFLAGS || environment.RUSTC_WRAPPER || environment.RUSTC_WORKSPACE_WRAPPER) throw new Error('Dev loop rejects release authority and custom compiler flags/wrappers.');
  const unsupported = Object.keys(environment).filter(name => /^(RUSTC$|RUSTDOC$|CC$|CC_|CXX|CPP|CFLAGS|CXXFLAGS|AR$|AR_|LD$|LD_|LDFLAGS|CARGO_BUILD_|CARGO_TARGET_|CARGO_PROFILE_|CMAKE_|SDKROOT$|C_INCLUDE_PATH$|CPLUS_INCLUDE_PATH$|OBJC_INCLUDE_PATH$|CPATH$|LIBRARY_PATH$|DYLD|PKG_CONFIG|SOURCE_DATE_EPOCH$|OPENSSL_|LBUG_)/i.test(name) && environment[name]);
  if (unsupported.length) throw new Error(`Unsupported native build inputs: ${unsupported.join(', ')}`);
  const root = 'C:\\RelayerDev', target = join(root, 'cargo-target');
  await mkdir(root, { recursive: true });
  const lease = JSON.parse(await readFile(join(root, 'active-loop.json'), 'utf8'));
  if (!environment.RELAYER_DEV_LOOP_ID || lease.id !== environment.RELAYER_DEV_LOOP_ID || lease.phase !== 'building' || lease.pid !== process.pid) throw new Error('Use the serialized desktop:dev:windows command.');
  const started = now(), stages = [], receipt = { schema: 'windows-dev-loop/v1', scope: 'unsigned-development', startedAt: new Date().toISOString(), stages, rust, sourceDigest: environment.RELAYER_DEV_SOURCE_DIGEST };
  async function stage(name, operation) { const start = now(); try { return await operation(); } finally { stages.push({ name, seconds: (now() - start) / 1000 }); } }
  const runtimePaths = ['crates', 'Cargo.lock', 'Cargo.toml', '.cargo', 'docs/graph-query-v1.md', 'docs/icon-catalog.json', 'fixtures/graph-query-v1', 'vendor/ladybug', 'scripts/prepare-ladybug-source.mjs', 'scripts/verify-ladybug-native-receipts.mjs', 'desktop/packaging/pinned-ladybug-build.mjs', 'desktop/packaging/build-cache.mjs', 'desktop/packaging/windows-native.mjs', 'desktop/shared/target.mjs', 'scripts/ci/packaging-input-contract.json'];
  const runtimeDigest = await digestWindowsDevInputs(repositoryRoot, runtimePaths);
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
      const nativeInputs = await digestWindowsDevInputs(repositoryRoot, ['vendor/ladybug', 'scripts/prepare-ladybug-source.mjs', 'scripts/verify-ladybug-native-receipts.mjs', 'desktop/packaging/pinned-ladybug-build.mjs', 'desktop/packaging/build-cache.mjs', 'scripts/ci/packaging-input-contract.json']);
      const identity = sha(JSON.stringify({ repositoryRoot, target: 'windows-x64', tools, nativeInputs, rustVersion: command('rustc', ['-vV']), cargoVersion: command('cargo', ['-vV']), sdk: environment.WindowsSDKVersion, sdkDirectory: environment.WindowsSdkDir, compilerEnvironment: Object.fromEntries(["CL", "_CL_", "LINK", "_LINK_", "INCLUDE", "LIB", "LIBPATH", "VCINSTALLDIR", "VCToolsInstallDir"].map(key => [key, environment[key] ?? null])) }));
      receipt.nativeIdentity = identity;
      receipt.cacheDecision = previous?.nativeIdentity === identity ? 'warm local Cargo workspace; native inputs reverified' : 'no compatible local cache; checked trusted release caches separately; local cold build required';
      if (previous?.nativeIdentity !== identity && !allowCold) throw new Error('Cold native build required. Inspect verified cache availability, then rerun with --rust --allow-cold.');
      await stage('license', () => requireLadybugDistributionLicenseReady());
      await stage('Cargo fetch', () => execute('cargo', ['fetch', '--locked', '--target', 'x86_64-pc-windows-msvc'], { cwd: repositoryRoot, env: environment }));
      const buildEnvironment = { ...environment, CARGO_TARGET_DIR: target, CARGO_PROFILE_RELEASE_DEBUG: '1', CARGO_PROFILE_RELEASE_INCREMENTAL: 'true' };
      await withPinnedLadybugPackagingEnvironment({ environment: buildEnvironment, target: { key: 'windows-x64', rustTarget: 'x86_64-pc-windows-msvc' },
        prepareLadybug: options => stage('verified native preparation', () => prepareLadybug({ ...options, cache: { root: join(root, 'native-cache'), native: identity } })),
      }, (env, integrity) => stage('Cargo release', () => execute('cargo', ['build', '--release', '-p', 'relayer-app-server', '-p', 'relayer-graph-server', '--target', 'x86_64-pc-windows-msvc', ...integrity], { cwd: repositoryRoot, env })));
      const files = {};
      for (const name of ['relayer-app-server.exe', 'relayer-graph-server.exe']) files[name] = sha(await readFile(join(target, 'x86_64-pc-windows-msvc/release', name)));
      await writeFile(marker, JSON.stringify({ nativeIdentity: identity, runtimeDigest, files }, null, 2));
    } else {
      if (previous?.runtimeDigest !== runtimeDigest) throw new Error('Rust source changed or no local native build exists: run --rust first.');
      for (const [name, digest] of Object.entries(previous.files)) if (sha(await readFile(join(target, 'x86_64-pc-windows-msvc/release', name))) !== digest) throw new Error(`Local native output changed: ${name}`);
      receipt.cacheDecision = 'verified unchanged local Rust outputs; Cargo skipped';
    }
    await stage('JavaScript packages and renderer', () => execute(environment.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm.cmd run prepare:desktop-runtime'], { cwd: repositoryRoot, env: environment }));
    await stage('Electron assembly and package qualification', () => execute(process.execPath, [join(repositoryRoot, 'node_modules/electron-builder/out/cli/cli.js'), '--config', 'desktop/packaging/electron-builder.mjs', '--win', '--x64', '--dir', '--publish', 'never'], {
      cwd: repositoryRoot, env: { ...environment, RELAYER_DESKTOP_TARGET: 'windows-x64', RELAYER_CARGO_TARGET_DIR: target },
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
