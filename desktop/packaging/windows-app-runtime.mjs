import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import extractZip from 'extract-zip';
import { WINDOWS_NODE_RUNTIME as node, packagedWindowsNodePath } from '../shared/windows-node-runtime.mjs';
import { inspectPortableExecutable } from './windows-native.mjs';
const executeDefault = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const windowsAppRuntimeRoot = repositoryRoot => resolve(repositoryRoot, '.relayer/windows-app-runtime-v1');
export async function verifyNodeInput(directory) {
  for (const [name, digest] of [['node.exe', node.executableSha256], ['LICENSE', node.licenseSha256]]) {
    const path = join(directory, name), info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || hash(await readFile(path)) !== digest) throw new Error(`Windows Node input identity mismatch: ${name}`);
  }
}
export async function prepareWindowsNodeRuntime({ repositoryRoot, download = url => fetch(url), extract = extractZip } = {}) {
  const root = windowsAppRuntimeRoot(repositoryRoot), destination = join(root, 'node');
  try { await verifyNodeInput(destination); return destination; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(root, { recursive: true });
  const temporary = await mkdtemp(join(tmpdir(), 'relayer-node-'));
  const staged = join(root, `node-${randomUUID()}`);
  try {
    const response = await download(`https://nodejs.org/dist/v${node.version}/${node.archive}`);
    if (!response.ok) throw new Error(`Official Node download failed: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (hash(bytes) !== node.archiveSha256) throw new Error('Official Windows Node archive identity mismatch.');
    const archive = join(temporary, node.archive); await writeFile(archive, bytes);
    await extract(archive, { dir: join(temporary, 'extracted'), onEntry: entry => {
      const path = entry.fileName;
      if (!path.startsWith(`node-v${node.version}-${node.target}/`) || path.split(/[\\/]/).includes('..') || path.includes('\\')) throw new Error('Unsafe Windows Node archive entry.');
    } });
    await mkdir(staged);
    for (const name of ['node.exe', 'LICENSE']) await cp(join(temporary, 'extracted', `node-v${node.version}-${node.target}`, name), join(staged, name));
    await verifyNodeInput(staged);
    await writeFile(join(staged, 'provenance.json'), JSON.stringify({ schema: 'windows-node/v1', ...node }, null, 2));
    await rename(staged, destination); return destination;
  } finally { await rm(temporary, { recursive: true, force: true }); await rm(staged, { recursive: true, force: true }); }
}
export async function resolveWindowsCrtRedistSource(prefix) {
  const architectureRoot = join(prefix, 'x64');
  const candidates = (await readdir(architectureRoot, { withFileTypes: true })).filter(entry => /^Microsoft\.VC\d+\.CRT$/i.test(entry.name));
  if (candidates.length !== 1 || !candidates[0].isDirectory() || candidates[0].isSymbolicLink()) throw new Error('Initialized MSVC toolchain must supply exactly one regular x64 CRT redistribution directory.');
  return join(architectureRoot, candidates[0].name);
}
export async function prepareWindowsCrtRuntime({ repositoryRoot, environment = process.env, execute = executeDefault } = {}) {
  // Use only the redistribution directory belonging to the initialized MSVC
  // toolchain, never DLLs found on PATH or in System32. Preserve Microsoft signatures.
  const prefix = environment.VCToolsRedistDir;
  if (!prefix) throw new Error('Windows app-local CRT packaging requires VCToolsRedistDir from the initialized MSVC toolchain.');
  const source = await resolveWindowsCrtRedistSource(prefix);
  const names = (await readdir(source)).filter(name => /^[a-z0-9_]+\.dll$/i.test(name)).sort();
  for (const name of ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']) if (!names.includes(name)) throw new Error(`MSVC redistribution input missing ${name}`);
  const paths = names.map(name => join(source, name));
  const command = `$ErrorActionPreference='Stop'; @(${paths.map(path => `'${path.replaceAll("'", "''")}'`).join(',')}) | ForEach-Object { $s=Get-AuthenticodeSignature -LiteralPath $_; if ($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation(,|$)') { throw 'Untrusted MSVC redistributable' } }`;
  const signatureEnvironment = Object.fromEntries(Object.entries(environment).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
  await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { env: signatureEnvironment });
  const destination = join(windowsAppRuntimeRoot(repositoryRoot), 'crt');
  const staged = `${destination}-${randomUUID()}`; await mkdir(staged, { recursive: true });
  try {
    const files = [];
    for (const name of names) {
      const bytes = await readFile(join(source, name));
      if (inspectPortableExecutable(bytes).architecture !== 'x86_64') throw new Error(`Wrong MSVC DLL architecture: ${name}`);
      await writeFile(join(staged, name), bytes); files.push({ name, sha256: hash(bytes) });
    }
    await writeFile(join(staged, 'provenance.json'), JSON.stringify({ schema: 'windows-crt/v1', source, files }, null, 2));
    await rm(destination, { recursive: true, force: true }); await rename(staged, destination); return destination;
  } finally { await rm(staged, { recursive: true, force: true }); }
}
export async function prepareWindowsAppRuntime(options) {
  return { node: await prepareWindowsNodeRuntime(options), crt: await prepareWindowsCrtRuntime(options) };
}
export async function verifyPackagedWindowsAppRuntime(resources, { execute = executeDefault } = {}) {
  const path = await packagedWindowsNodePath(resources);
  const pe = inspectPortableExecutable(await readFile(path));
  if (pe.architecture !== 'x86_64') throw new Error('Packaged Node must be Windows x64.');
  if (hash(await readFile(join(resources, 'node', 'LICENSE'))) !== node.licenseSha256) throw new Error('Packaged Node license identity mismatch.');
  const provenance = JSON.parse(await readFile(join(resources, 'node', 'provenance.json'), 'utf8'));
  if (JSON.stringify(provenance) !== JSON.stringify({ schema: 'windows-node/v1', ...node })) throw new Error('Packaged Node provenance mismatch.');
  const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, PATH: '' };
  const version = await execute(path, ['--version'], { env });
  if (version.stdout.trim() !== `v${node.version}`) throw new Error('Packaged Node version mismatch.');
  // Exercise the actual packaged client with ambient Node absent. No provider or paid call.
  const program = `await import(${JSON.stringify(pathToFileURL(join(resources, 'graph-client', 'index.js')).href)}); console.log('packaged-client-ok');`;
  const client = await execute(path, ['--input-type=module', '--eval', program], { env });
  if (client.stdout.trim() !== 'packaged-client-ok') throw new Error('Packaged Node cannot load the packaged graph client.');
  const crt = JSON.parse(await readFile(join(resources, 'bin', 'provenance.json'), 'utf8'));
  if (crt.schema !== 'windows-crt/v1' || !Array.isArray(crt.files)) throw new Error('Packaged CRT provenance invalid.');
  const available = new Set();
  for (const file of crt.files) {
    if (!/^[a-z0-9_]+\.dll$/i.test(file.name) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Unsafe CRT provenance entry.');
    if (hash(await readFile(join(resources, 'bin', file.name))) !== file.sha256) throw new Error(`Packaged CRT identity mismatch: ${file.name}`);
    available.add(file.name.toLowerCase());
  }
  for (const executable of ['relayer-app-server.exe', 'relayer-graph-server.exe', ...available]) {
    const imported = inspectPortableExecutable(await readFile(join(resources, 'bin', executable))).imports;
    for (const library of imported) if (/^(msvcp|vcruntime|concrt|vccorlib)\d/i.test(library) && !available.has(library.toLowerCase())) throw new Error(`Unbundled VC runtime dependency: ${library}`);
  }
  return { executable: path, version: node.version, crtFiles: [...available] };
}
