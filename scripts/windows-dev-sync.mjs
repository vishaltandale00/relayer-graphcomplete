import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
const exec = promisify(execFile), sha = bytes => createHash('sha256').update(bytes).digest('hex');
export function safeWindowsSyncPath(path) {
  return typeof path === 'string' && path.length < 240 && !path.includes('\\') && !path.startsWith('/')
    && !/[\x00-\x1f<>:"|?*]/.test(path) && !path.split('/').some(part => !part || part === '.' || part === '..'
      || /^\.env(?:\.|$)/i.test(part) || ['.git', '.relayer', 'node_modules', 'target'].includes(part.toLowerCase())
      || /(?:credential|auth\.json|private[-_]key|\.pem$|\.pfx$)/i.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
// Applied on Windows by the pinned workspace Node. Validate the entire plan and
// every old hash before touching a source file. Unmanaged files cannot be deleted.
export const applyWindowsSyncProgram = `
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const [root,bundle,expected]=process.argv.slice(2);const raw=fs.readFileSync(bundle);if(hash(raw)!==expected)throw Error('Sync bundle hash mismatch');
const plan=JSON.parse(zlib.gunzipSync(raw));const safe=${safeWindowsSyncPath.toString()};
if(plan.schema!=='windows-source-delta/v1'||!Array.isArray(plan.files))throw Error('Invalid sync plan');
const lockRoot=process.platform==='win32'?'C:\\\\RelayerDev':path.join(root,'.relayer','dev-lock');fs.mkdirSync(lockRoot,{recursive:true});const lease=path.join(lockRoot,'active-loop.json');const leaseHandle=fs.openSync(lease,'wx');fs.writeFileSync(lease,JSON.stringify({id:plan.id,phase:'syncing'}));
try {
const seen=new Set();for(const f of plan.files){if(!safe(f.path)||seen.has(f.path.toLowerCase()))throw Error('Unsafe or duplicate source path');seen.add(f.path.toLowerCase());const p=path.resolve(root,...f.path.split('/'));if(!p.toLowerCase().startsWith(path.resolve(root).toLowerCase()+path.sep))throw Error('Source escape');for(let parent=path.dirname(p);parent!==path.resolve(root);parent=path.dirname(parent)){try{if(fs.lstatSync(parent).isSymbolicLink())throw Error('Source parent symlink');}catch(e){if(e.code!=='ENOENT')throw e;}}let old=null;try{if(!fs.lstatSync(p).isFile()||fs.lstatSync(p).isSymbolicLink())throw Error('Non-file source');old=hash(fs.readFileSync(p));}catch(e){if(e.code!=='ENOENT')throw e;}if(old!==f.before)throw Error('Remote source changed: '+f.path);if(f.after!==null&&hash(Buffer.from(f.data,'base64'))!==f.after)throw Error('Delta content hash mismatch');}
const backup=path.join(root,'.relayer','sync-backups',plan.id);fs.mkdirSync(backup,{recursive:true});const changed=[];
try{for(const f of plan.files){const p=path.join(root,...f.path.split('/'));if(f.before!==null){const b=path.join(backup,...f.path.split('/'));fs.mkdirSync(path.dirname(b),{recursive:true});fs.copyFileSync(p,b);}changed.push(f);if(f.after===null)fs.unlinkSync(p);else{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,Buffer.from(f.data,'base64'));}}}
catch(e){for(const f of changed.reverse()){const p=path.join(root,...f.path.split('/'));if(f.before===null)fs.rmSync(p,{force:true});else fs.copyFileSync(path.join(backup,...f.path.split('/')),p);}throw e;}
fs.writeFileSync(path.join(backup,'receipt.json'),JSON.stringify({schema:plan.schema,id:plan.id,sourceDigest:plan.sourceDigest,files:plan.files.map(({data,...f})=>f)}));
fs.writeFileSync(path.join(root,'.relayer','source-sync-state.json'),JSON.stringify({id:plan.id,sourceDigest:plan.sourceDigest,state:plan.state}));
if(plan.build)fs.writeFileSync(lease,JSON.stringify({id:plan.id,phase:'sync-ready',sourceDigest:plan.sourceDigest}));
} catch(e) { fs.closeSync(leaseHandle);fs.rmSync(lease,{force:true});throw e; }
fs.closeSync(leaseHandle);if(!plan.build)fs.rmSync(lease,{force:true});
console.log(JSON.stringify({syncId:plan.id,files:plan.files.length,sourceDigest:plan.sourceDigest}));
`;
// Read-only reconciliation after a lost Azure acknowledgement. Verify the
// exact retained manifest and all remote bytes before advancing Mac state.
export const verifyWindowsSyncStateProgram = `
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const [root,id,digest,encoded]=process.argv.slice(2);const expected=JSON.parse(Buffer.from(encoded,'base64'));const actual=JSON.parse(fs.readFileSync(path.join(root,'.relayer/source-sync-state.json'),'utf8'));const safe=${safeWindowsSyncPath.toString()};
if(actual.id!==id||actual.sourceDigest!==digest||hash(JSON.stringify(expected))!==digest||JSON.stringify(actual.state)!==JSON.stringify(expected))throw Error('Remote sync identity differs from retained plan');
for(const [name,wanted] of Object.entries(expected)){if(!safe(name))throw Error('Unsafe retained source path');const file=path.join(root,...name.split('/'));for(let parent=path.dirname(file);parent!==path.resolve(root);parent=path.dirname(parent)){try{if(fs.lstatSync(parent).isSymbolicLink())throw Error('Source parent symlink');}catch(e){if(e.code!=='ENOENT')throw e;}}let observed=null;try{const info=fs.lstatSync(file);if(!info.isFile()||info.isSymbolicLink())throw Error('Non-file source');observed=hash(fs.readFileSync(file));}catch(e){if(e.code!=='ENOENT')throw e;}if(observed!==wanted)throw Error('Remote source changed: '+name);}
console.log(JSON.stringify({schema:'windows-dev-reconciled/v1',syncId:id,sourceDigest:digest}));
`;
export async function createWindowsSourceDelta({ repositoryRoot, baseCommit, previous = {}, id = randomUUID() }) {
  if (!/^[a-f0-9]{40}$/.test(baseCommit)) throw new Error('A full known VM source commit is required.');
  const options = { cwd: repositoryRoot, maxBuffer: 16 * 1024 * 1024 };
  const changed = (await exec('git', ['diff', '--name-only', '-z', baseCommit], options)).stdout.split('\0');
  const paths = [...new Set([...changed, ...Object.keys(previous)])].filter(safeWindowsSyncPath).sort();
  const files = [], state = {};
  for (const path of paths) {
    let bytes = null; try { const info = await lstat(join(repositoryRoot, path)); if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Source delta refuses non-file ${path}`); bytes = await readFile(join(repositoryRoot, path)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    let before = previous[path];
    if (before === undefined) { try { before = sha((await exec('git', ['show', `${baseCommit}:${path}`], { ...options, encoding: 'buffer' })).stdout); } catch { before = null; } }
    const after = bytes === null ? null : sha(bytes); state[path] = after;
    if (before !== after) files.push({ path, before, after, ...(bytes === null ? {} : { data: bytes.toString('base64') }) });
  }
  return { plan: { schema: 'windows-source-delta/v1', id, baseCommit, sourceDigest: sha(JSON.stringify(state)), files, state }, state };
}
const quotePs = value => `'${value.replaceAll("'", "''")}'`;
export async function dispatchWindowsDev({ evidence, id, sourceDigest, workspace, remoteRoot, resourceGroup, vm, rust, allowCold }) {
  if (!/^[a-f0-9-]{36}$/.test(id) || !/^[a-f0-9]{64}$/.test(sourceDigest)) throw new Error('Invalid acknowledged source identity.');
  const driver = `${remoteRoot}\\scripts\\windows-dev-environment.cmd`, log = `${workspace}\\dev-loop-${id}.log`;
  const command = `call "${driver}" "${workspace}" "${remoteRoot}" && node scripts/run-windows-dev-loop.mjs --sync-id ${id}${rust ? ' --rust' : ''}${allowCold ? ' --allow-cold' : ''} > "${log}" 2>&1`;
  const script = `$ErrorActionPreference='Stop'\n$leasePath='C:\\RelayerDev\\active-loop.json'\n$lease=Get-Content $leasePath -Raw | ConvertFrom-Json\nif($lease.id -ne '${id}' -or $lease.phase -ne 'sync-ready' -or $lease.sourceDigest -ne '${sourceDigest}'){throw 'The source lease is not ready for this dispatch'}\n$p=Start-Process -FilePath $env:ComSpec -ArgumentList @('/d','/s','/c',${quotePs(command)}) -PassThru -WindowStyle Hidden\n$ack=$false\nfor($i=0;$i -lt 300;$i++){\nStart-Sleep -Milliseconds 100\nif(Test-Path $leasePath){try{$live=Get-Content $leasePath -Raw | ConvertFrom-Json}catch{continue};if($live.id -eq '${id}' -and $live.phase -eq 'building'){$ack=$true;break}}\nif(Test-Path 'C:\\RelayerDev\\commands.jsonl'){$last=([string](Get-Content 'C:\\RelayerDev\\commands.jsonl' -Tail 1)) | ConvertFrom-Json;if($last.id -eq '${id}'){$ack=$true;break}}\n}\nif(!$ack){throw 'Build wrapper did not claim the lease; inspect status and resume the same sync ID after fixing the driver'}\n[PSCustomObject]@{schema='windows-dev-dispatch/v1';buildProcessId=$p.Id;log=${quotePs(log)};syncId='${id}';wrapperAcknowledged=$true} | ConvertTo-Json -Compress`;
  const path = join(evidence, `${id}-build.ps1`); await writeFile(path, script);
  const result = await exec('az', ['vm', 'run-command', 'invoke', '--resource-group', resourceGroup, '--name', vm, '--command-id', 'RunPowerShellScript', '--scripts', `@${path}`, '--output', 'json'], { maxBuffer: 1024 * 1024 });
  await writeFile(join(evidence, `${id}-build-dispatch.json`), result.stdout);
  const output = JSON.parse(result.stdout), message = output.value?.find(item => item.code === 'ComponentStatus/StdOut/succeeded')?.message;
  let acknowledgement; try { acknowledgement = JSON.parse(message); } catch { throw new Error('Build dispatch was not acknowledged. Inspect desktop:status:windows; an unclaimed sync can be resumed with --resume-sync ID.'); }
  if (acknowledgement.syncId !== id || acknowledgement.wrapperAcknowledged !== true) throw new Error('Build wrapper did not acknowledge this source identity.');
  return acknowledgement;
}
export async function resumeWindowsDev({ repositoryRoot = resolve(import.meta.dirname, '..'), id, rust = false, allowCold = false,
  resourceGroup = 'RELAYER-DESKTOP-CANARY', vm = 'relayer-win11' }) {
  if (!/^[a-f0-9-]{36}$/.test(id ?? '')) throw new Error('A retained source-sync ID is required.');
  const evidence = join(repositoryRoot, '.relayer/windows-dev-sync'), state = JSON.parse(await readFile(join(evidence, 'state.json'), 'utf8'));
  const plan = JSON.parse(await readFile(join(evidence, `${id}-plan.json`), 'utf8'));
  if (plan.id !== id || plan.sourceDigest !== sha(JSON.stringify(state.state))) throw new Error('This sync is not the currently acknowledged source state.');
  const result = await dispatchWindowsDev({ evidence, id, sourceDigest: plan.sourceDigest, workspace: state.workspace, remoteRoot: `${state.workspace}\\${state.checkout}`, resourceGroup, vm, rust, allowCold });
  console.log(JSON.stringify(result)); return result;
}
export async function reconcileWindowsDev({ repositoryRoot = resolve(import.meta.dirname, '..'), id, resourceGroup = 'RELAYER-DESKTOP-CANARY', vm = 'relayer-win11' }) {
  if (!/^[a-f0-9-]{36}$/.test(id ?? '')) throw new Error('A retained source-sync ID is required.');
  const evidence = join(repositoryRoot, '.relayer/windows-dev-sync'), lockPath = join(evidence, 'active.lock'), lock = await open(lockPath, 'wx');
  try {
    const plan = JSON.parse(await readFile(join(evidence, `${id}-plan.json`), 'utf8'));
    if (plan.id !== id || !plan.state || !plan.baseCommit || !plan.workspace || !plan.checkout || sha(JSON.stringify(plan.state)) !== plan.sourceDigest) throw new Error('This plan lacks the retained context required for automatic reconciliation; inspect its original receipt manually.');
    const remoteRoot = `${plan.workspace}\\${plan.checkout}`, program = `${plan.workspace}\\reconcile-${id}.cjs`;
    const script = `$ErrorActionPreference='Stop'\n[IO.File]::WriteAllBytes(${quotePs(program)},[Convert]::FromBase64String('${Buffer.from(verifyWindowsSyncStateProgram).toString('base64')}'))\n& ${quotePs(`${plan.workspace}\\Node\\node-v22.23.2-win-x64\\node.exe`)} ${quotePs(program)} ${quotePs(remoteRoot)} '${id}' '${plan.sourceDigest}' '${Buffer.from(JSON.stringify(plan.state)).toString('base64')}'\nif($LASTEXITCODE -ne 0){throw 'Remote identity reconciliation failed'}\n`;
    const path = join(evidence, `${id}-reconcile.ps1`); await writeFile(path, script);
    const result = await exec('az', ['vm', 'run-command', 'invoke', '--resource-group', resourceGroup, '--name', vm, '--command-id', 'RunPowerShellScript', '--scripts', `@${path}`, '--output', 'json'], { maxBuffer: 1024 * 1024 });
    await writeFile(join(evidence, `${id}-reconcile.json`), result.stdout);
    const output = JSON.parse(result.stdout), acknowledgement = JSON.parse(output.value?.find(item => item.code === 'ComponentStatus/StdOut/succeeded')?.message);
    if (acknowledgement.syncId !== id || acknowledgement.sourceDigest !== plan.sourceDigest) throw new Error('Remote reconciliation was not acknowledged.');
    await writeFile(join(evidence, 'state.json'), JSON.stringify({ baseCommit: plan.baseCommit, workspace: plan.workspace, checkout: plan.checkout, state: plan.state }, null, 2));
    console.log(JSON.stringify(acknowledgement)); return acknowledgement;
  } finally { await lock.close(); await rm(lockPath, { force: true }); }
}
export async function syncWindowsDev({ repositoryRoot = resolve(import.meta.dirname, '..'), baseCommit,
  workspace = 'C:\\Users\\RelayerAVDTest\\RelayerDevWorkspace', checkout = 'source\\vishaltandale00-relayer-graphcomplete-3c641e1',
  resourceGroup = 'RELAYER-DESKTOP-CANARY', vm = 'relayer-win11', rust = false, allowCold = false, syncOnly = false, planOnly = false } = {}) {
  const evidence = join(repositoryRoot, '.relayer/windows-dev-sync'); await mkdir(evidence, { recursive: true });
  const macLockPath = join(evidence, 'active.lock'), macLock = await open(macLockPath, 'wx');
  try {
  const statePath = join(evidence, 'state.json'); let previous = {};
  try { const saved = JSON.parse(await readFile(statePath, 'utf8')); if (saved.baseCommit !== baseCommit || saved.workspace !== workspace || saved.checkout !== checkout) throw new Error('Sync workspace/base changed; inspect the previous receipt first.'); previous = saved.state; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const { plan, state } = await createWindowsSourceDelta({ repositoryRoot, baseCommit, previous });
  plan.build = !syncOnly;
  const bundle = gzipSync(JSON.stringify(plan));
  if (bundle.length > 4 * 1024 * 1024) throw new Error('Source delta exceeds 4 MiB; stage an exact-source artifact instead of expanding Run Command latency.');
  const description = { id: plan.id, baseCommit, workspace, checkout, state, files: plan.files.map(({ data, ...file }) => file), compressedBytes: bundle.length, sourceDigest: plan.sourceDigest };
  await writeFile(join(evidence, `${plan.id}-plan.json`), JSON.stringify(description, null, 2));
  if (planOnly) { console.log(JSON.stringify(description)); return description; }
  const scriptPath = join(evidence, `${plan.id}.ps1`), remoteRoot = `${workspace}\\${checkout}`;
  const script = `$ErrorActionPreference='Stop'\n$root=${quotePs(workspace)}\n$source=${quotePs(remoteRoot)}\nif (!(Test-Path -LiteralPath $source)) { throw 'Existing reviewed source workspace missing' }\n$bundle=Join-Path $root '${plan.id}.gz'\n$apply=Join-Path $root '${plan.id}.cjs'\n[IO.File]::WriteAllBytes($bundle,[Convert]::FromBase64String('${bundle.toString('base64')}'))\n[IO.File]::WriteAllBytes($apply,[Convert]::FromBase64String('${Buffer.from(applyWindowsSyncProgram).toString('base64')}'))\n& (Join-Path $root 'Node\\node-v22.23.2-win-x64\\node.exe') $apply $source $bundle '${sha(bundle)}'\nif ($LASTEXITCODE -ne 0) { throw 'Source delta rejected' }\n`;
  await writeFile(scriptPath, script);
  const started = performance.now();
  const result = await exec('az', ['vm', 'run-command', 'invoke', '--resource-group', resourceGroup, '--name', vm, '--command-id', 'RunPowerShellScript', '--scripts', `@${scriptPath}`, '--output', 'json'], { maxBuffer: 1024 * 1024 });
  const output = JSON.parse(result.stdout); await writeFile(join(evidence, `${plan.id}-sync.json`), JSON.stringify(output, null, 2));
  const text = output.value?.map(item => item.message).join('\n') ?? '';
  if (!text.includes(`"syncId":"${plan.id}"`) || /\[stderr\]\s*\S/.test(text)) throw new Error('Windows source sync did not acknowledge this exact plan; state was not advanced.');
  await writeFile(statePath, JSON.stringify({ baseCommit, workspace, checkout, state }, null, 2));
  const receipt = { ...description, syncSeconds: (performance.now() - started) / 1000, scope: 'reviewed tracked source; unsigned Dev; credential stores excluded' };
  if (!syncOnly) {
    const build = await dispatchWindowsDev({ evidence, id: plan.id, sourceDigest: plan.sourceDigest, workspace, remoteRoot, resourceGroup, vm, rust, allowCold });
    receipt.buildDispatched = true; receipt.wrapperAcknowledged = true; receipt.log = build.log;
  }
  await writeFile(join(evidence, `${plan.id}-receipt.json`), JSON.stringify(receipt, null, 2)); console.log(JSON.stringify(receipt)); return receipt;
  } finally { await macLock.close(); await rm(macLockPath, { force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2), baseIndex = argv.indexOf('--base');
  const reconcileIndex = argv.indexOf('--reconcile-sync');
  const resumeIndex = argv.indexOf('--resume-sync');
  if (reconcileIndex >= 0) await reconcileWindowsDev({ id: argv[reconcileIndex + 1] });
  else if (resumeIndex >= 0) await resumeWindowsDev({ id: argv[resumeIndex + 1], rust: argv.includes('--rust'), allowCold: argv.includes('--allow-cold') });
  else await syncWindowsDev({ baseCommit: argv[baseIndex + 1], rust: argv.includes('--rust'), allowCold: argv.includes('--allow-cold'), syncOnly: argv.includes('--sync-only'), planOnly: argv.includes('--plan') });
}
