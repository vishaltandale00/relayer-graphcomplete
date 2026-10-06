import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import fsSync from 'node:fs';
import pathApi from 'node:path';
const exec = promisify(execFile), sha = bytes => createHash('sha256').update(bytes).digest('hex');
// Credentials are excluded by data-file identity, not by a source module's name.
export function excludedWindowsCredentialPath(path) {
  if (typeof path !== 'string') return false;
  const parts = path.split('/'), filename = parts.at(-1);
  return parts.some(part => /^\.env(?:\.|$)/i.test(part))
    || filename.toLowerCase() === 'live-run.local.json'
    || /\.(pem|pfx|p12|key)$/i.test(filename)
    || /^(?:auth|credentials?|live-credentials|private[-_]key)(?:\.(?:json|toml|ya?ml|ini|txt)|$)/i.test(filename);
}
export function excludedWindowsSourcePath(path) {
  return excludedWindowsCredentialPath(path) || (typeof path === 'string' && path.split('/').some(part => ['.git', '.relayer', 'node_modules', 'target'].includes(part.toLowerCase())));
}
export function safeWindowsSyncPath(path) {
  return typeof path === 'string' && path.length < 240 && !path.includes('\\') && !path.startsWith('/')
    && !/[\x00-\x1f<>:"|?*]/.test(path) && !excludedWindowsSourcePath(path)
    && !path.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
export function validateWindowsSourceManifest(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state) || Object.getPrototypeOf(state) !== Object.prototype) throw new Error('A complete tracked source manifest is required.');
  const names = Object.keys(state), seen = new Set();
  if (names.length === 0 || JSON.stringify(names) !== JSON.stringify([...names].sort())) throw new Error('The complete source manifest must be nonempty and ordered.');
  for (const name of names) {
    if (!safeWindowsSyncPath(name) || seen.has(name.toLowerCase())) throw new Error(`Unsafe or case-aliased source path: ${name}`);
    seen.add(name.toLowerCase());
    if (state[name] !== null && !/^[a-f0-9]{64}$/.test(state[name])) throw new Error(`Invalid tracked source hash: ${name}`);
  }
  return state;
}
export function windowsSourceFilePath({ fs, path, root, name }) {
  root = path.resolve(root);
  if (!safeWindowsSyncPath(name)) throw new Error(`Unsafe source path: ${name}`);
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error('Source root symlink');
  const file = path.resolve(root, ...name.split('/'));
  if (!file.toLowerCase().startsWith(root.toLowerCase() + path.sep)) throw new Error('Source escape');
  for (let parent = path.dirname(file); parent !== root; parent = path.dirname(parent)) {
    try { if (fs.lstatSync(parent).isSymbolicLink()) throw new Error('Source parent symlink'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return file;
}
// This is an explicit generated-output boundary, not a mutable .gitignore rule.
// A tracked path always wins over an ignored output path.
export function ignoredWindowsGeneratedPath(name) {
  const roots = ['node_modules', 'target', 'dist', 'coverage', '.playwright-mcp', '.git', '.relayer',
    'desktop/node_modules', 'desktop/dist', 'desktop/eval-dist', 'desktop/renderer/vendor', 'desktop/renderer/design',
    'packages/graph-client/agent-resource', 'designs/lab', 'docs/prd/assets/evidence/ask-profile-approval'];
  for (const pkg of ['graph-client', 'harness-host', 'visual-assets', 'eval-runner'])
    for (const output of ['dist', 'node_modules']) roots.push(`packages/${pkg}/${output}`);
  return roots.some(prefix => name === prefix || name.startsWith(`${prefix}/`))
    || /(?:^|\/)\.DS_Store$|\.log$/i.test(name)
    || ['docs/prd/comments.json', 'docs/prd/annotations.json'].includes(name);
}
export function verifyWindowsSourceInventory({ fs, path, root, state }) {
  const expected=new Set(Object.entries(state).filter(([,hash])=>hash!==null).map(([name])=>name)), parents=new Set();
  for(const name of expected)for(let parent=path.posix.dirname(name);parent!=='.';parent=path.posix.dirname(parent))parents.add(parent);
  function visit(relative) {
    const directory=relative?path.join(root,...relative.split('/')):root;
    for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
      const name=relative?`${relative}/${entry.name}`:entry.name;
      if(!expected.has(name)&&!parents.has(name)&&((entry.isFile()&&excludedWindowsCredentialPath(name))||ignoredWindowsGeneratedPath(name)))continue;
      if(entry.isSymbolicLink())throw new Error(`Source inventory symlink: ${name}`);
      if(entry.isDirectory())visit(name);
      else if(!entry.isFile()||!expected.has(name))throw new Error(`Unexpected unreviewed source: ${name}`);
    }
  }
  visit('');
}
// Shared production seam: the remote apply, dispatch/recovery verifier and local
// Windows wrapper all check every tracked path, including unchanged base files.
export function verifyWindowsManifestFiles({ fs, path, root, state }) {
  validateWindowsSourceManifest(state);
  for (const [name, wanted] of Object.entries(state)) {
    const file = windowsSourceFilePath({ fs, path, root, name });
    let observed = null;
    try {
      const info = fs.lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Non-file source: ${name}`);
      observed = sha(fs.readFileSync(file));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (observed !== wanted) throw new Error(`Remote source changed: ${name}`);
  }
  verifyWindowsSourceInventory({ fs, path, root, state });
}
export function verifyWindowsFullSourceState({ fs, path, root, sourceState, expected }) {
  if (!expected || !/^[a-f0-9]{40}$/.test(expected.baseCommit ?? '') || !/^[a-f0-9]{64}$/.test(expected.baselineDigest ?? '') || !/^[a-f0-9]{64}$/.test(expected.sourceDigest ?? '')) throw new Error('An independently acknowledged complete source identity is required.');
  if (sourceState?.schema !== 'windows-source-state/v2' || !/^[a-f0-9]{40}$/.test(sourceState.baseCommit ?? '')
    || !/^[a-f0-9]{64}$/.test(sourceState.baselineDigest ?? '')) throw new Error('Partial source state is unqualified; run an explicit --audit-source migration.');
  validateWindowsSourceManifest(sourceState.state);
  if (sha(JSON.stringify(sourceState.state)) !== sourceState.sourceDigest) throw new Error('Complete source identity mismatch.');
  if (sourceState.id !== expected.id || sourceState.baseCommit !== expected.baseCommit
    || sourceState.baselineDigest !== expected.baselineDigest || sourceState.sourceDigest !== expected.sourceDigest
    || (expected.state && JSON.stringify(sourceState.state) !== JSON.stringify(expected.state))) throw new Error('Remote sync identity differs from retained complete plan.');
  verifyWindowsManifestFiles({ fs, path, root, state: sourceState.state });
  return sourceState;
}
export function verifyWindowsDevSource(repositoryRoot, sourceState, expected) {
  return verifyWindowsFullSourceState({ fs: fsSync, path: pathApi, root: repositoryRoot, sourceState, expected });
}
const sharedManifestProgram = `
const excludedWindowsCredentialPath=${excludedWindowsCredentialPath.toString()};
const excludedWindowsSourcePath=${excludedWindowsSourcePath.toString()};
const safeWindowsSyncPath=${safeWindowsSyncPath.toString()};
const validateWindowsSourceManifest=${validateWindowsSourceManifest.toString()};
const windowsSourceFilePath=${windowsSourceFilePath.toString()};
const ignoredWindowsGeneratedPath=${ignoredWindowsGeneratedPath.toString()};
const verifyWindowsSourceInventory=${verifyWindowsSourceInventory.toString()};
const verifyWindowsManifestFiles=${verifyWindowsManifestFiles.toString()};
const verifyWindowsFullSourceState=${verifyWindowsFullSourceState.toString()};
`;
export const applyWindowsSyncProgram = `
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
${sharedManifestProgram}
const [root,bundle,expected]=process.argv.slice(2);const raw=fs.readFileSync(bundle);if(sha(raw)!==expected)throw Error('Sync bundle hash mismatch');
const plan=JSON.parse(zlib.gunzipSync(raw));
if(plan.schema!=='windows-source-delta/v2'||!Array.isArray(plan.files)||!/^[a-f0-9]{40}$/.test(plan.baseCommit)||!/^[a-f0-9]{64}$/.test(plan.baselineDigest))throw Error('A complete baseline-audited source plan is required');
validateWindowsSourceManifest(plan.beforeState);validateWindowsSourceManifest(plan.state);
if(sha(JSON.stringify(plan.state))!==plan.sourceDigest||JSON.stringify(Object.keys(plan.beforeState))!==JSON.stringify(Object.keys(plan.state)))throw Error('Complete plan identity mismatch');
const lockRoot=process.platform==='win32'?'C:\\\\RelayerDev':path.join(root,'.relayer','dev-lock');fs.mkdirSync(lockRoot,{recursive:true});const lease=path.join(lockRoot,'active-loop.json');const leaseHandle=fs.openSync(lease,'wx');
const sourceStatePath=path.join(root,'.relayer','source-sync-state.json');let oldSourceState;
try {
try{oldSourceState=fs.readFileSync(sourceStatePath);}catch(e){if(e.code!=='ENOENT')throw e;}
fs.writeFileSync(lease,JSON.stringify({id:plan.id,phase:'syncing'}));
// Full prior manifest audit precedes every write, even for zero-byte deltas.
verifyWindowsManifestFiles({fs,path,root,state:plan.beforeState});
const seen=new Set();for(const f of plan.files){if(!safeWindowsSyncPath(f.path)||seen.has(f.path.toLowerCase()))throw Error('Unsafe or duplicate source path');seen.add(f.path.toLowerCase());if(!Object.hasOwn(plan.beforeState,f.path)||plan.beforeState[f.path]!==f.before||plan.state[f.path]!==f.after)throw Error('Delta is outside its complete manifest');if(f.after!==null&&sha(Buffer.from(f.data,'base64'))!==f.after)throw Error('Delta content hash mismatch');}
const backup=path.join(root,'.relayer','sync-backups',plan.id);fs.mkdirSync(backup,{recursive:true});if(oldSourceState)fs.writeFileSync(path.join(backup,'source-state-before.json'),oldSourceState);const changed=[];
try{for(const f of plan.files){const p=path.join(root,...f.path.split('/'));if(f.before!==null){const b=path.join(backup,...f.path.split('/'));fs.mkdirSync(path.dirname(b),{recursive:true});fs.copyFileSync(p,b);}changed.push(f);if(f.after===null)fs.unlinkSync(p);else{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,Buffer.from(f.data,'base64'));}}
verifyWindowsManifestFiles({fs,path,root,state:plan.state});
fs.writeFileSync(path.join(backup,'receipt.json'),JSON.stringify({schema:plan.schema,id:plan.id,baseCommit:plan.baseCommit,baselineDigest:plan.baselineDigest,sourceDigest:plan.sourceDigest,files:plan.files.map(({data,...f})=>f)}));
fs.writeFileSync(sourceStatePath,JSON.stringify({schema:'windows-source-state/v2',id:plan.id,baseCommit:plan.baseCommit,baselineDigest:plan.baselineDigest,sourceDigest:plan.sourceDigest,state:plan.state}));
if(plan.build)fs.writeFileSync(lease,JSON.stringify({id:plan.id,phase:'sync-ready',baseCommit:plan.baseCommit,baselineDigest:plan.baselineDigest,sourceDigest:plan.sourceDigest}));
}catch(e){for(const f of changed.reverse()){const p=path.join(root,...f.path.split('/'));if(f.before===null)fs.rmSync(p,{force:true});else fs.copyFileSync(path.join(backup,...f.path.split('/')),p);}if(oldSourceState)fs.writeFileSync(sourceStatePath,oldSourceState);else fs.rmSync(sourceStatePath,{force:true});throw e;}
} catch(e) { fs.closeSync(leaseHandle);fs.rmSync(lease,{force:true});throw e; }
fs.closeSync(leaseHandle);if(!plan.build)fs.rmSync(lease,{force:true});
console.log(JSON.stringify({schema:'windows-dev-synced/v2',syncId:plan.id,files:plan.files.length,sourceDigest:plan.sourceDigest}));
`;
export const verifyWindowsSyncStateProgram = `
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib');const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
${sharedManifestProgram}
const [root,manifestFile]=process.argv.slice(2);const expected=JSON.parse(zlib.gunzipSync(fs.readFileSync(manifestFile)));const sourceState=JSON.parse(fs.readFileSync(path.join(root,'.relayer/source-sync-state.json'),'utf8'));
verifyWindowsFullSourceState({fs,path,root,sourceState,expected});
console.log(JSON.stringify({schema:'windows-dev-verified/v2',syncId:sourceState.id,sourceDigest:sourceState.sourceDigest}));
`;
const ordered = value => Object.fromEntries(Object.entries(value).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0));
async function readGitBlobManifest(repositoryRoot, entries) {
  // One batch avoids thousands of git processes and keeps warm manifest audits cheap.
  const output = await new Promise((accept, reject) => {
    const child = spawn('git', ['cat-file', '--batch'], { cwd: repositoryRoot, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks=[];let size=0, errors='';
    child.stdout.on('data', chunk => { size+=chunk.length; if(size>512*1024*1024){child.kill();reject(new Error('Trusted baseline exceeds 512 MiB; use an exact-source archive audit.'));}else chunks.push(chunk); });
    child.stderr.on('data', chunk => { if(errors.length<65536)errors+=chunk; });
    child.on('error', reject);child.stdin.on('error', reject);
    child.on('close', code => code===0 ? accept(Buffer.concat(chunks)) : reject(new Error(`Git baseline read failed (${code}): ${errors}`)));
    child.stdin.end(entries.map(entry => entry.oid).join('\n')+'\n');
  });
  const manifest={};let offset=0;
  for(const entry of entries){const end=output.indexOf(10,offset);const [oid,type,size]=output.subarray(offset,end).toString().split(' ');const count=Number(size);if(oid!==entry.oid||type!=='blob'||!Number.isSafeInteger(count)||count<0||end<0||end+1+count>=output.length)throw new Error('Invalid trusted Git blob response');const content=output.subarray(end+1,end+1+count);manifest[entry.path]=sha(content);offset=end+count+2;}
  if(offset!==output.length)throw new Error('Unexpected trusted Git blob bytes');
  return ordered(manifest);
}
export async function readWindowsBaselineManifest(repositoryRoot, baseCommit) {
  if (!/^[a-f0-9]{40}$/.test(baseCommit ?? '')) throw new Error('A full known VM source commit is required.');
  const tree=(await exec('git',['ls-tree','-r','-z',baseCommit],{cwd:repositoryRoot,maxBuffer:16*1024*1024})).stdout;
  const entries=[];
  for(const record of tree.split('\0').filter(Boolean)){
    const split=record.indexOf('\t'), [mode,type,oid]=record.slice(0,split).split(' '), path=record.slice(split+1);
    if(excludedWindowsSourcePath(path))continue;
    if(!safeWindowsSyncPath(path)||!/^100(644|755)$/.test(mode)||type!=='blob')throw new Error(`Unsupported tracked Windows source: ${path}`);
    entries.push({path,oid});
  }
  const manifest=await readGitBlobManifest(repositoryRoot,entries);validateWindowsSourceManifest(manifest);return manifest;
}
export async function createWindowsSourceDelta({ repositoryRoot, baseCommit, previous, auditSource = false, id = randomUUID() }) {
  const baseline=await readWindowsBaselineManifest(repositoryRoot,baseCommit), baselineDigest=sha(JSON.stringify(baseline));
  let beforeState=baseline, auditMode='trusted-base';
  if(previous){
    if(previous.schema==='windows-source-state/v2'){
      if(previous.baseCommit!==baseCommit||previous.baselineDigest!==baselineDigest||sha(JSON.stringify(previous.state))!==previous.sourceDigest)throw new Error('Previous complete baseline identity differs.');
      validateWindowsSourceManifest(previous.state);beforeState=previous.state;auditMode='verified-state';
      if(Object.keys(baseline).some(name=>!Object.hasOwn(beforeState,name)))throw new Error('Previous source state omits tracked baseline files.');
    }else{
      if(!auditSource)throw new Error('Legacy partial sync state cannot qualify source. Preserve it and rerun --audit-source for a complete baseline audit.');
      const partial=previous.state;
      if(!partial||typeof partial!=='object'||Array.isArray(partial))throw new Error('Invalid legacy partial state.');
      beforeState=ordered({...baseline,...partial});validateWindowsSourceManifest(beforeState);auditMode='legacy-full-audit';
    }
  }
  const index=(await exec('git',['ls-files','--stage','-z'],{cwd:repositoryRoot,maxBuffer:16*1024*1024})).stdout;
  const paths=new Set(Object.keys(beforeState)), tracked=new Set();
  for(const record of index.split('\0').filter(Boolean)){
    const split=record.indexOf('\t'),[mode,,stage]=record.slice(0,split).split(' '),path=record.slice(split+1);
    if(excludedWindowsSourcePath(path))continue;
    if(!safeWindowsSyncPath(path)||!/^100(644|755)$/.test(mode)||stage!=='0')throw new Error(`Unsupported tracked Windows source: ${path}`);
    paths.add(path);tracked.add(path);
  }
  beforeState=ordered(Object.fromEntries([...paths].map(path=>[path,beforeState[path]??null])));
  const files=[],state={};
  for(const path of [...paths].sort()){
    const sourcePath=windowsSourceFilePath({fs:fsSync,path:pathApi,root:repositoryRoot,name:path});
    let bytes=null;if(tracked.has(path))try{const info=await lstat(sourcePath);if(!info.isFile()||info.isSymbolicLink())throw new Error(`Source delta refuses non-file ${path}`);bytes=await readFile(sourcePath);}catch(error){if(error.code!=='ENOENT')throw error;}
    const before=beforeState[path]??null,after=bytes===null?null:sha(bytes);state[path]=after;
    if(before!==after)files.push({path,before,after,...(bytes===null?{}:{data:bytes.toString('base64')})});
  }
  validateWindowsSourceManifest(state);
  return {plan:{schema:'windows-source-delta/v2',id,baseCommit,baselineDigest,beforeState,sourceDigest:sha(JSON.stringify(state)),files,state,auditMode},state};
}
const quotePs = value => `'${value.replaceAll("'", "''")}'`;
const planSourceState = plan => ({schema:'windows-source-state/v2',id:plan.id,baseCommit:plan.baseCommit,baselineDigest:plan.baselineDigest,sourceDigest:plan.sourceDigest,state:plan.state});
function windowsSourceVerificationScript({ workspace, remoteRoot, id, sourceState, echo = false }) {
  const program=`${workspace}\\verify-source-${id}.cjs`, manifest=`${workspace}\\verify-source-${id}.gz`;
  return `[IO.File]::WriteAllBytes(${quotePs(program)},[Convert]::FromBase64String('${Buffer.from(verifyWindowsSyncStateProgram).toString('base64')}'))\n[IO.File]::WriteAllBytes(${quotePs(manifest)},[Convert]::FromBase64String('${gzipSync(JSON.stringify(sourceState)).toString('base64')}'))\n$verified=& ${quotePs(`${workspace}\\Node\\node-v22.23.2-win-x64\\node.exe`)} ${quotePs(program)} ${quotePs(remoteRoot)} ${quotePs(manifest)}\nif($LASTEXITCODE -ne 0){throw 'Complete remote source audit failed'}\n${echo?'$verified':''}`;
}
export async function dispatchWindowsDev({ evidence, id, sourceDigest, workspace, remoteRoot, resourceGroup, vm, rust, allowCold, sourceState }) {
  if (!/^[a-f0-9-]{36}$/.test(id) || !/^[a-f0-9]{64}$/.test(sourceDigest)) throw new Error('Invalid acknowledged source identity.');
  if (sourceState?.schema !== 'windows-source-state/v2' || sourceState.id !== id || sourceState.sourceDigest !== sourceDigest) throw new Error('Dispatch requires a complete audited source state.');
  const verification = windowsSourceVerificationScript({ workspace, remoteRoot, id, sourceState });
  const driver = `${remoteRoot}\\scripts\\windows-dev-environment.cmd`, log = `${workspace}\\dev-loop-${id}.log`;
  const command = `(call "${driver}" "${workspace}" "${remoteRoot}" && node scripts/run-windows-dev-loop.mjs --sync-id ${id}${rust ? ' --rust' : ''}${allowCold ? ' --allow-cold' : ''}) > "${log}" 2>&1`;
  const script = `$ErrorActionPreference='Stop'\n${verification}\n$leasePath='C:\\RelayerDev\\active-loop.json'\n$lease=Get-Content $leasePath -Raw | ConvertFrom-Json\nif($lease.id -ne '${id}' -or $lease.phase -ne 'sync-ready' -or $lease.sourceDigest -ne '${sourceDigest}'){throw 'The source lease is not ready for this dispatch'}\n$p=Start-Process -FilePath $env:ComSpec -ArgumentList @('/d','/s','/c',${quotePs(command)}) -PassThru -WindowStyle Hidden\n$ack=$false\nfor($i=0;$i -lt 300;$i++){\nStart-Sleep -Milliseconds 100\nif(Test-Path $leasePath){try{$live=Get-Content $leasePath -Raw | ConvertFrom-Json}catch{continue};if($live.id -eq '${id}' -and $live.phase -eq 'building'){$ack=$true;break}}\nif(Test-Path 'C:\\RelayerDev\\commands.jsonl'){$last=([string](Get-Content 'C:\\RelayerDev\\commands.jsonl' -Tail 1)) | ConvertFrom-Json;if($last.id -eq '${id}'){$ack=$true;break}}\n}\nif(!$ack){throw 'Build wrapper did not claim the lease; inspect status and resume the same sync ID after fixing the driver'}\n[PSCustomObject]@{schema='windows-dev-dispatch/v1';buildProcessId=$p.Id;log=${quotePs(log)};syncId='${id}';wrapperAcknowledged=$true} | ConvertTo-Json -Compress`;
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
  if (state.schema !== 'windows-source-state/v2' || plan.schema !== 'windows-source-delta/v2' || plan.id !== id || plan.sourceDigest !== sha(JSON.stringify(state.state))) throw new Error('This sync is not the currently acknowledged source state.');
  const result = await dispatchWindowsDev({ evidence, id, sourceDigest: plan.sourceDigest, workspace: state.workspace, remoteRoot: `${state.workspace}\\${state.checkout}`, resourceGroup, vm, rust, allowCold, sourceState: { ...state, id } });
  console.log(JSON.stringify(result)); return result;
}
export async function reconcileWindowsDev({ repositoryRoot = resolve(import.meta.dirname, '..'), id, resourceGroup = 'RELAYER-DESKTOP-CANARY', vm = 'relayer-win11' }) {
  if (!/^[a-f0-9-]{36}$/.test(id ?? '')) throw new Error('A retained source-sync ID is required.');
  const evidence = join(repositoryRoot, '.relayer/windows-dev-sync'), lockPath = join(evidence, 'active.lock'), lock = await open(lockPath, 'wx');
  try {
    const plan = JSON.parse(await readFile(join(evidence, `${id}-plan.json`), 'utf8'));
    if (plan.schema !== 'windows-source-delta/v2' || plan.id !== id || !plan.state || !plan.baseCommit || !plan.workspace || !plan.checkout || !plan.baselineDigest || sha(JSON.stringify(plan.state)) !== plan.sourceDigest) throw new Error('Partial retained plans cannot qualify source; run --audit-source for the complete baseline.');
    const remoteRoot=`${plan.workspace}\\${plan.checkout}`;
    const script=`$ErrorActionPreference='Stop'\n${windowsSourceVerificationScript({workspace:plan.workspace,remoteRoot,id,sourceState:planSourceState(plan),echo:true})}\n`;
    const path = join(evidence, `${id}-reconcile.ps1`); await writeFile(path, script);
    const result = await exec('az', ['vm', 'run-command', 'invoke', '--resource-group', resourceGroup, '--name', vm, '--command-id', 'RunPowerShellScript', '--scripts', `@${path}`, '--output', 'json'], { maxBuffer: 1024 * 1024 });
    await writeFile(join(evidence, `${id}-reconcile.json`), result.stdout);
    const output = JSON.parse(result.stdout), acknowledgement = JSON.parse(output.value?.find(item => item.code === 'ComponentStatus/StdOut/succeeded')?.message);
    if (acknowledgement.syncId !== id || acknowledgement.sourceDigest !== plan.sourceDigest) throw new Error('Remote reconciliation was not acknowledged.');
    await writeFile(join(evidence, 'state.json'), JSON.stringify({ ...planSourceState(plan), workspace: plan.workspace, checkout: plan.checkout }, null, 2));
    console.log(JSON.stringify(acknowledgement)); return acknowledgement;
  } finally { await lock.close(); await rm(lockPath, { force: true }); }
}
export async function syncWindowsDev({ repositoryRoot = resolve(import.meta.dirname, '..'), baseCommit,
  workspace = 'C:\\Users\\RelayerAVDTest\\RelayerDevWorkspace', checkout = 'source\\vishaltandale00-relayer-graphcomplete-3c641e1',
  resourceGroup = 'RELAYER-DESKTOP-CANARY', vm = 'relayer-win11', rust = false, allowCold = false, syncOnly = false, planOnly = false, auditSource = false } = {}) {
  const evidence = join(repositoryRoot, '.relayer/windows-dev-sync'); await mkdir(evidence, { recursive: true });
  const macLockPath = join(evidence, 'active.lock'), macLock = await open(macLockPath, 'wx');
  try {
  const statePath = join(evidence, 'state.json'); let previous;
  try { const saved = JSON.parse(await readFile(statePath, 'utf8')); if (saved.baseCommit !== baseCommit || saved.workspace !== workspace || saved.checkout !== checkout) throw new Error('Sync workspace/base changed; inspect the previous receipt first.'); previous = saved; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const { plan, state } = await createWindowsSourceDelta({ repositoryRoot, baseCommit, previous, auditSource });
  plan.build = !syncOnly;
  const bundle = gzipSync(JSON.stringify(plan));
  if (bundle.length > 4 * 1024 * 1024) throw new Error('Source delta exceeds 4 MiB; stage an exact-source artifact instead of expanding Run Command latency.');
  const description = { schema: plan.schema, id: plan.id, baseCommit, baselineDigest: plan.baselineDigest, auditMode: plan.auditMode, workspace, checkout, state, files: plan.files.map(({ data, ...file }) => file), compressedBytes: bundle.length, sourceDigest: plan.sourceDigest };
  await writeFile(join(evidence, `${plan.id}-plan.json`), JSON.stringify(description, null, 2));
  if (planOnly) { console.log(JSON.stringify(description)); return description; }
  if (previous && previous.schema !== 'windows-source-state/v2') await writeFile(join(evidence, `${plan.id}-legacy-state.json`), JSON.stringify(previous, null, 2));
  const scriptPath = join(evidence, `${plan.id}.ps1`), remoteRoot = `${workspace}\\${checkout}`;
  const script = `$ErrorActionPreference='Stop'\n$root=${quotePs(workspace)}\n$source=${quotePs(remoteRoot)}\nif (!(Test-Path -LiteralPath $source)) { throw 'Existing reviewed source workspace missing' }\n$bundle=Join-Path $root '${plan.id}.gz'\n$apply=Join-Path $root '${plan.id}.cjs'\n[IO.File]::WriteAllBytes($bundle,[Convert]::FromBase64String('${bundle.toString('base64')}'))\n[IO.File]::WriteAllBytes($apply,[Convert]::FromBase64String('${Buffer.from(applyWindowsSyncProgram).toString('base64')}'))\n& (Join-Path $root 'Node\\node-v22.23.2-win-x64\\node.exe') $apply $source $bundle '${sha(bundle)}'\nif ($LASTEXITCODE -ne 0) { throw 'Source delta rejected' }\n`;
  await writeFile(scriptPath, script);
  const started = performance.now();
  const result = await exec('az', ['vm', 'run-command', 'invoke', '--resource-group', resourceGroup, '--name', vm, '--command-id', 'RunPowerShellScript', '--scripts', `@${scriptPath}`, '--output', 'json'], { maxBuffer: 1024 * 1024 });
  const output = JSON.parse(result.stdout); await writeFile(join(evidence, `${plan.id}-sync.json`), JSON.stringify(output, null, 2));
  const text = output.value?.map(item => item.message).join('\n') ?? '';
  if (!text.includes(`"syncId":"${plan.id}"`) || /\[stderr\]\s*\S/.test(text)) throw new Error('Windows source sync did not acknowledge this exact plan; state was not advanced.');
  await writeFile(statePath, JSON.stringify({ ...planSourceState(plan), workspace, checkout }, null, 2));
  const receipt = { ...description, syncSeconds: (performance.now() - started) / 1000, scope: 'reviewed tracked source; unsigned Dev; credential stores excluded' };
  if (!syncOnly) {
    const build = await dispatchWindowsDev({ evidence, id: plan.id, sourceDigest: plan.sourceDigest, workspace, remoteRoot, resourceGroup, vm, rust, allowCold, sourceState: planSourceState(plan) });
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
  else await syncWindowsDev({ baseCommit: argv[baseIndex + 1], rust: argv.includes('--rust'), allowCold: argv.includes('--allow-cold'), syncOnly: argv.includes('--sync-only'), planOnly: argv.includes('--plan'), auditSource: argv.includes('--audit-source') });
}
