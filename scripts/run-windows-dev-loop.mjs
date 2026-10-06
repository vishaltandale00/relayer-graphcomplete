import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, lstat, mkdir, open, readFile, readdir, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyWindowsDevSource } from './windows-dev-sync.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function run(command, args, options) {
  return new Promise((accept, reject) => { const child = spawn(command, args, { ...options, stdio: 'inherit' }); child.once('error', reject); child.once('exit', code => code === 0 ? accept() : reject(new Error(`${command} exited ${code}`))); });
}
// npm workspaces are deliberate links into the separately audited source tree.
// Their generated dist files are rebuilt by prepare:desktop-runtime, not adopted
// as immutable registry dependencies. Every ordinary installed file is hashed.
export async function inventoryWindowsDevDependencies({ repositoryRoot, lockfile }) {
  const root = resolve(repositoryRoot), canonicalRoot = await realpath(root);
  const packages = JSON.parse(lockfile).packages ?? {}, roots = new Set(['node_modules']);
  const inside = path => path === canonicalRoot || path.startsWith(canonicalRoot + sep);
  for (const name of Object.keys(packages)) {
    if (name.includes('\\') || name.startsWith('/') || name.split('/').some(part => part === '..' || part === '.')) throw Error('Unsafe locked dependency path.');
    const index = name.indexOf('/node_modules/');
    if (index >= 0) roots.add(name.slice(0, index) + '/node_modules');
  }
  const records = [], files = [];
  async function visit(name) {
    const directory = join(root, ...name.split('/'));
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || !inside(await realpath(directory))) throw Error(`Unsafe installed dependency directory: ${name}`);
    records.push([name, 'directory']);
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = `${name}/${entry.name}`, path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = resolve(dirname(path), await readlink(path));
        const actual = await realpath(target);
        if (!inside(actual)) throw Error(`Installed dependency link escapes repository: ${child}`);
        const workspace = packages[child];
        if (workspace?.link === true) {
          if (typeof workspace.resolved !== 'string' || workspace.resolved.includes('\\') || workspace.resolved.split('/').includes('..')) throw Error(`Unsafe locked workspace link: ${child}`);
          const expected = await realpath(resolve(root, workspace.resolved));
          if (!inside(expected) || actual !== expected) throw Error(`Installed workspace link differs from lock: ${child}`);
        } else {
          const moduleRoots = [...roots].map(name => join(root, ...name.split('/')));
          if (!moduleRoots.some(directory => actual.startsWith(directory + sep))) throw Error(`Unreviewed installed dependency link: ${child}`);
        }
        records.push([child, 'link', relative(canonicalRoot, actual).split(sep).join('/')]);
      } else if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) files.push([child, path]);
      else throw Error(`Unsupported installed dependency entry: ${child}`);
    }
  }
  for (const name of [...roots].sort()) {
    try { await lstat(join(root, ...name.split('/'))); }
    catch (error) { if (error.code === 'ENOENT' && name !== 'node_modules') continue; throw error; }
    await visit(name);
  }
  // Bound reads on the small VM: hashing cannot create an unbounded file/open or
  // memory queue. Symlinks are validated as links and never read as file bytes.
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, files.length) }, async () => {
    while (next < files.length) {
      const [name, path] = files[next++], info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) throw Error(`Installed dependency changed during audit: ${name}`);
      records.push([name, 'file', sha(await readFile(path))]);
    }
  }));
  records.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  if (!records.some(([name, kind]) => name === 'node_modules/.package-lock.json' && kind === 'file')) throw Error('Installed npm lock inventory missing.');
  return { sha256: sha(JSON.stringify(records)), files: files.length, entries: records.length };
}
export async function ensureWindowsDevDependencies({ repositoryRoot, environment = process.env, execute = run } = {}) {
  const lockfile = await readFile(join(repositoryRoot, 'package-lock.json'));
  const digest = sha(lockfile), marker = join(repositoryRoot, '.relayer/npm-dependencies.json');
  let previous;
  try {
    const info = await lstat(marker);
    if (info.isFile() && !info.isSymbolicLink()) previous = JSON.parse(await readFile(marker, 'utf8'));
  } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  if (previous?.schema === 'windows-dev-dependencies/v2' && previous.lockSha256 === digest
    && previous.nodeVersion === process.version && previous.platform === process.platform && previous.architecture === process.arch) {
    try {
      const inventory = await inventoryWindowsDevDependencies({ repositoryRoot, lockfile });
      if (inventory.sha256 === previous.inventory?.sha256) return { mode: 'verified dependency hit', lockSha256: digest, inventory };
    } catch { /* Missing, changed or unsafe installed inputs require a locked restore. */ }
  }
  await mkdir(join(repositoryRoot, '.relayer'), { recursive: true }); await rm(marker, { force: true });
  await execute(environment.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm.cmd ci --ignore-scripts'], { cwd: repositoryRoot, env: environment });
  const inventory = await inventoryWindowsDevDependencies({ repositoryRoot, lockfile });
  await writeFile(marker, JSON.stringify({ schema: 'windows-dev-dependencies/v2', lockSha256: digest, nodeVersion: process.version,
    platform: process.platform, architecture: process.arch, inventory }));
  return { mode: 'installed locked dependencies', lockSha256: digest, inventory };
}
// A second exclusive file serializes dispatch claims as well as source writes.
// The sync-ready lease remains present until the winning build finishes.
export async function claimWindowsDevLease({ root, syncId = null, id = syncId ?? randomUUID() }) {
  await mkdir(root, { recursive: true });
  const leasePath = join(root, 'active-loop.json'), claimPath = join(root, 'build-claim.lock');
  const claim = await open(claimPath, 'wx'); let lease, sourceIdentity;
  try {
    await claim.writeFile(JSON.stringify({ id, pid: process.pid, startedAt: new Date().toISOString() }));
    if (syncId) {
      const pending = JSON.parse(await readFile(leasePath, 'utf8'));
      if (pending.id !== syncId || pending.phase !== 'sync-ready') throw new Error('The dispatched build does not own the source-sync lease.');
      sourceIdentity = { id: pending.id, baseCommit: pending.baseCommit, baselineDigest: pending.baselineDigest, sourceDigest: pending.sourceDigest };
    } else { lease = await open(leasePath, 'wx'); }
    await writeFile(leasePath, JSON.stringify({ ...sourceIdentity, id, phase: 'building', pid: process.pid, startedAt: new Date().toISOString() }));
  } catch (error) {
    await lease?.close(); await claim.close(); await rm(claimPath, { force: true }); throw error;
  }
  return { id, sourceIdentity, async release() {
    await lease?.close(); await rm(leasePath, { force: true });
    await claim.close(); await rm(claimPath, { force: true });
  } };
}
export async function runWindowsDevCommand({ repositoryRoot = resolve(import.meta.dirname, '..'), argv = process.argv.slice(2), environment = process.env } = {}) {
  if (process.platform !== 'win32') throw new Error('Use desktop:sync:windows from the Mac.');
  const root = 'C:\\RelayerDev';
  const syncIndex = argv.indexOf('--sync-id'), syncId = syncIndex < 0 ? null : argv[syncIndex + 1];
  if (!syncId) throw new Error('Audited Windows builds require --sync-id from the acknowledged Mac sync.');
  const lease = await claimWindowsDevLease({ root, syncId });
  const started = performance.now(), receipt = { schema: 'windows-dev-command/v1', id: lease.id, startedAt: new Date().toISOString() };
  try {
    const sourceState = JSON.parse(await readFile(join(repositoryRoot, '.relayer/source-sync-state.json'), 'utf8'));
    if (syncId && sourceState.id !== syncId) throw new Error('Source identity changed after dispatch.');
    verifyWindowsDevSource(repositoryRoot, sourceState, lease.sourceIdentity);
    receipt.sourceDigest = sourceState.sourceDigest;
    const dependencyStart = performance.now(); receipt.dependencies = await ensureWindowsDevDependencies({ repositoryRoot, environment });
    receipt.dependencySeconds = (performance.now() - dependencyStart) / 1000;
    console.log(JSON.stringify({ stage: 'dependencies', ...receipt.dependencies, seconds: receipt.dependencySeconds }));
    const { windowsDevLoop } = await import('../desktop/packaging/windows-dev.mjs');
    receipt.build = await windowsDevLoop({ repositoryRoot, environment: { ...environment, RELAYER_DEV_LOOP_ID: lease.id, RELAYER_DEV_SOURCE_DIGEST: receipt.sourceDigest }, rust: argv.includes('--rust'), allowCold: argv.includes('--allow-cold') });
    verifyWindowsDevSource(repositoryRoot, sourceState, lease.sourceIdentity);
    receipt.result = 'passed'; return receipt;
  } catch (error) { receipt.result = 'failed'; receipt.failure = error.message; throw error; }
  finally {
    receipt.seconds = (performance.now() - started) / 1000;
    try { await appendFile(join(root, 'commands.jsonl'), `${JSON.stringify(receipt)}\n`); }
    finally { await lease.release(); }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runWindowsDevCommand();
