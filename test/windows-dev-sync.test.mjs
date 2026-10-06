import { expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';
import { applyWindowsSyncProgram, verifyWindowsSyncStateProgram, safeWindowsSyncPath,
  createWindowsSourceDelta, verifyWindowsDevSource, validateWindowsSourceManifest } from '../scripts/windows-dev-sync.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const runNode = args => execFileSync(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
async function fixture() {
  const root=await mkdtemp(join(tmpdir(),'win-full-source-')),local=join(root,'local'),remote=join(root,'remote');
  await mkdir(local);await mkdir(remote);
  const files={'src/main.rs':'old','src/unchanged.rs':'unchanged','desktop/main/credentials/credential-adapter.mjs':'export const source = true;'};
  for(const [path,bytes] of Object.entries(files))for(const directory of [local,remote]){await mkdir(dirname(join(directory,path)),{recursive:true});await writeFile(join(directory,path),bytes);}
  await writeFile(join(local,'.env.example'),'FAKE_FIXTURE_KEY=excluded');
  const git=args=>execFileSync('git',args,{cwd:local,stdio:['ignore','pipe','pipe']}).toString();
  git(['init','--quiet']);git(['add','.']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','base']);
  const baseCommit=git(['rev-parse','HEAD']).trim(),program=join(root,'apply.cjs'),bundle=join(root,'bundle.gz');await writeFile(program,applyWindowsSyncProgram);
  const apply=async plan=>{const bytes=gzipSync(JSON.stringify(plan));await writeFile(bundle,bytes);return JSON.parse(runNode([program,remote,bundle,sha(bytes)]));};
  const state=async()=>JSON.parse(await readFile(join(remote,'.relayer/source-sync-state.json'),'utf8'));
  return {root,local,remote,git,baseCommit,apply,state};
}
it('rejects credential data, aliases and unsafe paths while retaining reviewed credential source modules',()=>{
  for(const path of ['.env.local','desktop/.env','.git/config','node_modules/pkg/x','../file','foo\\bar','target/binary','secrets/credential.json','dir/file.','dir/file ','dir/CON.txt','dir/COM1','auth.json','key.pem'])expect(safeWindowsSyncPath(path)).toBe(false);
  expect(safeWindowsSyncPath('desktop/main/credentials/credential-adapter.mjs')).toBe(true);
  expect(()=>validateWindowsSourceManifest({'A.rs':sha('a'),'a.rs':sha('a')})).toThrow('case-aliased');
});
it('audits unchanged base bytes before any delta, retains rollback evidence and rechecks the full state on later syncs',async()=>{
  const f=await fixture();
  try{
    await writeFile(join(f.local,'src/main.rs'),'new');
    await writeFile(join(f.local,'untracked-api-token.txt'),'fixture never transferred');
    const {plan}=await createWindowsSourceDelta({repositoryRoot:f.local,baseCommit:f.baseCommit});
    expect(plan.files.map(file=>file.path)).toEqual(['src/main.rs']);
    expect(Object.keys(plan.state)).toHaveLength(3);
    expect(plan.state['src/unchanged.rs']).toBe(sha('unchanged'));
    expect(plan.state).not.toHaveProperty('.env.example');expect(plan.state).not.toHaveProperty('untracked-api-token.txt');
    await writeFile(join(f.remote,'src/unchanged.rs'),'tampered unchanged source');
    await expect(f.apply(plan)).rejects.toThrow('Remote source changed: src/unchanged.rs');
    expect(await readFile(join(f.remote,'src/main.rs'),'utf8')).toBe('old');
    await writeFile(join(f.remote,'src/unchanged.rs'),'unchanged');
    expect((await f.apply(plan)).syncId).toBe(plan.id);
    const previous=await f.state();expect(previous.schema).toBe('windows-source-state/v2');
    expect(await readFile(join(f.remote,`.relayer/sync-backups/${plan.id}/src/main.rs`),'utf8')).toBe('old');
    await writeFile(join(f.local,'src/main.rs'),'next');
    const next=(await createWindowsSourceDelta({repositoryRoot:f.local,baseCommit:f.baseCommit,previous})).plan;
    await rm(join(f.remote,'src/unchanged.rs'));await expect(f.apply(next)).rejects.toThrow('Remote source changed: src/unchanged.rs');
    expect(await readFile(join(f.remote,'src/main.rs'),'utf8')).toBe('new');
    await writeFile(join(f.remote,'src/unchanged.rs'),'unchanged');
    const lease=join(f.remote,'.relayer/dev-lock/active-loop.json');await writeFile(lease,JSON.stringify({id:'active-build',phase:'building'}));
    await expect(f.apply(next)).rejects.toThrow();expect(JSON.parse(await readFile(lease,'utf8')).id).toBe('active-build');await rm(lease);
    await f.apply(next);expect(await readFile(join(f.remote,'src/main.rs'),'utf8')).toBe('next');
  }finally{await rm(f.root,{recursive:true,force:true});}
});
it('rejects new-file parent symlinks and tracked source symlinks before mutation',async()=>{
  const f=await fixture();
  try{
    await mkdir(join(f.local,'new'));await writeFile(join(f.local,'new/file.rs'),'new source');f.git(['add','new/file.rs']);
    await mkdir(join(f.root,'outside'));await symlink(join(f.root,'outside'),join(f.remote,'new'));
    const plan=(await createWindowsSourceDelta({repositoryRoot:f.local,baseCommit:f.baseCommit})).plan;
    expect(plan.beforeState['new/file.rs']).toBeNull();
    await expect(f.apply(plan)).rejects.toThrow('Source parent symlink');
    await expect(readFile(join(f.root,'outside/file.rs'))).rejects.toMatchObject({code:'ENOENT'});
    await rm(join(f.local,'src'),{recursive:true});await mkdir(join(f.root,'private-outside'));
    await writeFile(join(f.root,'private-outside/main.rs'),'private fixture bytes');await writeFile(join(f.root,'private-outside/unchanged.rs'),'private fixture bytes');
    await symlink(join(f.root,'private-outside'),join(f.local,'src'));
    await expect(createWindowsSourceDelta({repositoryRoot:f.local,baseCommit:f.baseCommit})).rejects.toThrow('Source parent symlink');
    await rm(join(f.local,'src'));await mkdir(join(f.local,'src'));await writeFile(join(f.local,'src/main.rs'),'old');await writeFile(join(f.local,'src/unchanged.rs'),'unchanged');
    await rm(join(f.local,'src/main.rs'));await symlink(join(f.local,'src/unchanged.rs'),join(f.local,'src/main.rs'));
    await expect(createWindowsSourceDelta({repositoryRoot:f.local,baseCommit:f.baseCommit})).rejects.toThrow('non-file');
  }finally{await rm(f.root,{recursive:true,force:true});}
});
it('migrates acknowledged partial state only after a full baseline audit and preserves source/native cache bytes',async()=>{
  const f=await fixture();
  try{
    await writeFile(join(f.remote,'src/main.rs'),'old acknowledged marker');
    const legacy={baseCommit:f.baseCommit,state:{'src/main.rs':sha('old acknowledged marker')}};
    await mkdir(join(f.remote,'.relayer'));await writeFile(join(f.remote,'.relayer/source-sync-state.json'),JSON.stringify(legacy));
    const cache=join(f.root,'cargo-target');await mkdir(cache);await writeFile(join(cache,'trusted-object'),'retain');
    await expect(createWindowsSourceDelta({repositoryRoot:f.local,baseCommit:f.baseCommit,previous:legacy})).rejects.toThrow('--audit-source');
    const {plan}=await createWindowsSourceDelta({repositoryRoot:f.local,baseCommit:f.baseCommit,previous:legacy,auditSource:true});
    expect(plan.auditMode).toBe('legacy-full-audit');expect(plan.beforeState['src/main.rs']).toBe(sha('old acknowledged marker'));
    expect(plan.state['src/main.rs']).toBe(sha('old'));expect(Object.keys(plan.state)).toHaveLength(3);
    await writeFile(join(f.remote,'src/unchanged.rs'),'hidden stale source');await expect(f.apply(plan)).rejects.toThrow('unchanged.rs');
    expect(await readFile(join(f.remote,'src/main.rs'),'utf8')).toBe('old acknowledged marker');
    await writeFile(join(f.remote,'src/unchanged.rs'),'unchanged');await f.apply(plan);
    expect(await readFile(join(f.remote,`.relayer/sync-backups/${plan.id}/source-state-before.json`),'utf8')).toBe(JSON.stringify(legacy));
    expect(await readFile(join(cache,'trusted-object'),'utf8')).toBe('retain');
    expect((await f.state()).baselineDigest).toBe(plan.baselineDigest);
  }finally{await rm(f.root,{recursive:true,force:true});}
});
it('recovery and the Windows wrapper reject tampered unchanged files and partial or omitted manifests',async()=>{
  const f=await fixture();
  try{
    const {plan}=await createWindowsSourceDelta({repositoryRoot:f.local,baseCommit:f.baseCommit});await f.apply(plan);
    const sourceState=await f.state(),program=join(f.root,'verify.cjs'),manifest=join(f.root,'manifest.gz');
    await writeFile(program,verifyWindowsSyncStateProgram);await writeFile(manifest,gzipSync(JSON.stringify(sourceState)));
    const run=()=>JSON.parse(runNode([program,f.remote,manifest]));
    expect(run().syncId).toBe(plan.id);expect(verifyWindowsDevSource(f.remote,sourceState,sourceState).sourceDigest).toBe(plan.sourceDigest);
    await writeFile(join(f.remote,'src/unchanged.rs'),'changed after dispatch');
    expect(run).toThrow('unchanged.rs');expect(()=>verifyWindowsDevSource(f.remote,sourceState,sourceState)).toThrow('unchanged.rs');
    await writeFile(join(f.remote,'src/unchanged.rs'),'unchanged');
    const omitted={...sourceState,state:{'src/main.rs':sha('old')},sourceDigest:sha(JSON.stringify({'src/main.rs':sha('old')}))};
    await writeFile(join(f.remote,'.relayer/source-sync-state.json'),JSON.stringify(omitted));expect(run).toThrow('retained complete plan');
    expect(()=>verifyWindowsDevSource(f.remote,omitted,sourceState)).toThrow('retained complete plan');
    expect(()=>verifyWindowsDevSource(f.remote,omitted)).toThrow('independently acknowledged');
    await writeFile(join(f.remote,'.relayer/source-sync-state.json'),JSON.stringify({id:randomUUID(),state:{'src/main.rs':sha('old')}}));expect(run).toThrow('--audit-source');
    await expect(createWindowsSourceDelta({repositoryRoot:f.local,baseCommit:f.baseCommit,previous:omitted})).rejects.toThrow('omits tracked baseline files');
  }finally{await rm(f.root,{recursive:true,force:true});}
});

it('binds wrapper verification to the claimed complete lease and carries staged deletions as tombstones',async()=>{
  const f=await fixture();
  const {claimWindowsDevLease}=await import('../scripts/run-windows-dev-loop.mjs');
  try{
    const initial=(await createWindowsSourceDelta({repositoryRoot:f.local,baseCommit:f.baseCommit})).plan;
    initial.build=true;await f.apply(initial);const sourceState=await f.state();
    const lockRoot=join(f.remote,'.relayer/dev-lock');const claim=await claimWindowsDevLease({root:lockRoot,syncId:initial.id});
    try{
      expect(claim.sourceIdentity).toMatchObject({baseCommit:initial.baseCommit,baselineDigest:initial.baselineDigest,sourceDigest:initial.sourceDigest});
      expect(verifyWindowsDevSource(f.remote,sourceState,claim.sourceIdentity).sourceDigest).toBe(initial.sourceDigest);
      const state={'src/main.rs':sha('old')},omitted={...sourceState,state,sourceDigest:sha(JSON.stringify(state))};
      expect(()=>verifyWindowsDevSource(f.remote,omitted,claim.sourceIdentity)).toThrow('retained complete plan');
    }finally{await claim.release();}
    f.git(['rm','--cached','src/unchanged.rs']);
    expect(await readFile(join(f.local,'src/unchanged.rs'),'utf8')).toBe('unchanged');
    const next=(await createWindowsSourceDelta({repositoryRoot:f.local,baseCommit:f.baseCommit,previous:sourceState})).plan;
    expect(next.state['src/unchanged.rs']).toBeNull();expect(next.files.find(file=>file.path==='src/unchanged.rs').after).toBeNull();
    await f.apply(next);await expect(readFile(join(f.remote,'src/unchanged.rs'))).rejects.toMatchObject({code:'ENOENT'});
  }finally{await rm(f.root,{recursive:true,force:true});}
});

it('rejects extra unreviewed build sources while permitting explicit generated/dependency outputs',async()=>{
  const f=await fixture();
  try{
    const {plan}=await createWindowsSourceDelta({repositoryRoot:f.local,baseCommit:f.baseCommit});
    await mkdir(join(f.remote,'node_modules/pkg'),{recursive:true});await writeFile(join(f.remote,'node_modules/pkg/output.js'),'locked dependency output');
    await mkdir(join(f.remote,'desktop/renderer/vendor'),{recursive:true});await writeFile(join(f.remote,'desktop/renderer/vendor/generated.js'),'renderer output');
    await f.apply(plan);const previous=await f.state();
    const next=(await createWindowsSourceDelta({repositoryRoot:f.local,baseCommit:f.baseCommit,previous})).plan;
    await writeFile(join(f.remote,'desktop/main/unreviewed.mjs'),'unreviewed package-glob input');
    await expect(f.apply(next)).rejects.toThrow('Unexpected unreviewed source: desktop/main/unreviewed.mjs');
    expect(()=>verifyWindowsDevSource(f.remote,previous,previous)).toThrow('Unexpected unreviewed source');
    await rm(join(f.remote,'desktop/main/unreviewed.mjs'));
    await writeFile(join(f.remote,'src/unreviewed.rs'),'unreviewed Rust include');await expect(f.apply(next)).rejects.toThrow('Unexpected unreviewed source: src/unreviewed.rs');
    await rm(join(f.remote,'src/unreviewed.rs'));
    await mkdir(join(f.remote,'desktop/main/private_key'));await writeFile(join(f.remote,'desktop/main/private_key/unreviewed.mjs'),'credential-like directory is not a source exception');
    await expect(f.apply(next)).rejects.toThrow('Unexpected unreviewed source: desktop/main/private_key/unreviewed.mjs');
    await rm(join(f.remote,'desktop/main/private_key'),{recursive:true});
    for(const output of ['dist','target','node_modules']){
      await mkdir(join(f.remote,`desktop/main/${output}`));await writeFile(join(f.remote,`desktop/main/${output}/unreviewed.mjs`),'output-like source directory is not a generated exception');
      await expect(f.apply(next)).rejects.toThrow(`Unexpected unreviewed source: desktop/main/${output}/unreviewed.mjs`);
      await rm(join(f.remote,`desktop/main/${output}`),{recursive:true});
    }
    await f.apply(next);
  }finally{await rm(f.root,{recursive:true,force:true});}
});


it('keeps only root-local credential and log exceptions outside packaged and native source inputs', async () => {
  const f = await fixture();
  try {
    const { plan } = await createWindowsSourceDelta({ repositoryRoot: f.local, baseCommit: f.baseCommit });
    await writeFile(join(f.remote, '.env.local'), 'FAKE_PRIVATE_KEY=fixture');
    await writeFile(join(f.remote, 'live-run.local.json'), '{"fixture":"private"}');
    await writeFile(join(f.remote, 'build.log'), 'root operator log');
    await f.apply(plan);
    const previous = await f.state();
    const next = (await createWindowsSourceDelta({ repositoryRoot: f.local, baseCommit: f.baseCommit, previous })).plan;
    for (const name of ['desktop/auth.json', 'desktop/key.pem', 'desktop/private.log', 'desktop/.env.local', 'src/build.log', 'src/auth.json']) {
      await writeFile(join(f.remote, name), 'unreviewed private fixture');
      await expect(f.apply(next)).rejects.toThrow(`Unexpected unreviewed source: ${name}`);
      expect(() => verifyWindowsDevSource(f.remote, previous, previous)).toThrow(`Unexpected unreviewed source: ${name}`);
      await rm(join(f.remote, name));
    }
    await f.apply(next);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
