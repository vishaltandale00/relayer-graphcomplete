import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyWindowsDevSource } from './windows-dev-sync.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function run(command, args, options) {
  return new Promise((accept, reject) => { const child = spawn(command, args, { ...options, stdio: 'inherit' }); child.once('error', reject); child.once('exit', code => code === 0 ? accept() : reject(new Error(`${command} exited ${code}`))); });
}
export async function ensureWindowsDevDependencies({ repositoryRoot, environment = process.env, execute = run } = {}) {
  const lockfile = await readFile(join(repositoryRoot, 'package-lock.json'));
  const digest = sha(lockfile), marker = join(repositoryRoot, '.relayer/npm-dependencies.json');
  let previous; try { previous = JSON.parse(await readFile(marker, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let installed = false; try { await readFile(join(repositoryRoot, 'node_modules/.package-lock.json')); installed = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (installed && previous?.lockSha256 === digest && previous.nodeVersion === process.version) return { mode: 'verified dependency hit', lockSha256: digest };
  await mkdir(join(repositoryRoot, '.relayer'), { recursive: true }); await rm(marker, { force: true });
  await execute(environment.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm.cmd ci --ignore-scripts'], { cwd: repositoryRoot, env: environment });
  await writeFile(marker, JSON.stringify({ schema: 'windows-dev-dependencies/v1', lockSha256: digest, nodeVersion: process.version }));
  return { mode: 'installed locked dependencies', lockSha256: digest };
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
