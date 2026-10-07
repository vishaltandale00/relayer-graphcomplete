import { expect, it } from 'vitest';
import { validateWindowsFirstInstall, validateCollectedWindowsInstallEnvironment, WINDOWS_NSIS_INSTALLATION } from '../desktop/release/windows-first-install.mjs';
import { createDesktopBuilderConfig } from '../desktop/packaging/electron-builder.mjs';
import { resolveDesktopReleaseContract } from '../desktop/release/contract.mjs';
const digest = 'a'.repeat(64), source = 'b'.repeat(40);
function fixture() {
  const c = resolveDesktopReleaseContract({ version: '0.2.0', sourceCommit: source, environment: {
    RELAYER_DESKTOP_RELEASE: '1', RELAYER_DESKTOP_TARGET: 'windows-x64', RELAYER_DESKTOP_CHANNEL: 'preview',
    RELAYER_DESKTOP_UPDATE_BASE_URL: 'https://updates.relayerlabs.ai/desktop/windows/x64',
    RELAYER_DESKTOP_CANDIDATE_RUN_ID: '123', RELAYER_DESKTOP_CANDIDATE_RUN_ATTEMPT: '1',
    RELAYER_WINDOWS_SIGNING_ENDPOINT: 'https://eus.codesigning.azure.net/', RELAYER_WINDOWS_SIGNING_ACCOUNT: 'relayercodesigning',
    RELAYER_WINDOWS_CERTIFICATE_PROFILE: 'relayer-windows', RELAYER_WINDOWS_PUBLISHER_NAME: 'CN=Relayer Labs LLC, O=Relayer Labs LLC, L=Lewes, S=Delaware, C=US',
  } });
  const receipt = { schemaVersion: 2, product: 'Relayer', appId: c.appId, version: c.version, target: c.targetKey,
    platform: c.distributionPlatform, architecture: c.architecture, channel: c.channelName, updateBaseUrl: c.updateBaseUrl,
    sourceCommit: source, candidateWorkflowRunId: '123', candidateWorkflowRunAttempt: '1',
    signing: { mode: c.signingMode, endpoint: c.artifactSigningEndpoint, accountName: c.artifactSigningAccountName, certificateProfileName: c.artifactSigningCertificateProfileName, publisherName: c.publisherName },
    artifacts: [{ name: 'Relayer-0.2.0-win-x64.exe', sha256: digest }] };
  const observations = { schema: 'windows-first-install-observations/v1', sourceCommit: source, version: '0.2.0', workflowRunId: '123', workflowRunAttempt: '1', installerSha256: digest,
    host: { platform: 'win32', architecture: 'x64' }, freshProfile: { path: 'C:/Users/InstallerTest/AppData/Roaming/Relayer', emptyBeforeInstall: true, ordinaryUser: true },
    environment: { externalNodeOnPath: false, developmentOverrides: [] },
    signatures: ['installer', 'electron', 'app-server', 'graph-server', 'node'].map(role => ({ role, status: 'Valid', subject: c.publisherName, timestampThumbprint: 'timestamp', thumbprint: 'signer', sha256: digest })),
    runtime: { nodeVersion: '22.23.2', appOwnedNodeExecuted: true, unicodeStdinPreserved: true, crtLoadedModules: ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'].map(name => ({ name, fromAppDirectory: true })) },
    live: { provider: 'openrouter', model: 'openai/gpt-6-luna', prompt: 'Why the sky is blue?', lifecycle: 'succeeded', interactionNodeId: 32, currentLayerId: 10, finalLayerId: 10, visibleGraph: true, navigationWorked: true },
    reopen: { cleanShutdown: true, sameProfile: true, interactionNodeId: 32, finalLayerId: 10, visibleGraph: true, followupLifecycle: 'succeeded', followupInteractionNodeId: 33 },
    evidence: ['installed-launch', 'accepted-graph', 'reopened-graph', 'video', 'runtime', 'metadata', 'preflight', 'persistence', 'reopen-persistence', 'followup-persistence', 'installer-payload', 'live-authoring-runtime', 'shutdown-processes'].map(role => ({ role, sha256: digest })) };
  return { receipt, observations, installerName: receipt.artifacts[0].name, installerSha256: digest };
}
function collectedInstallEnvironment() {
  const identity = { sid: 'S-1-5-21-100-200-300-1001', name: 'TESTPC\\InstallerTest', ordinaryUser: true, authenticated: true, administratorGroupMember: false,
    userProfile: 'C:/Users/InstallerTest', appDataDirectory: 'C:/Users/InstallerTest/AppData/Roaming', localAppDataDirectory: 'C:/Users/InstallerTest/AppData/Local',
    programFilesDirectory: 'C:/Program Files', programFilesX86Directory: 'C:/Program Files (x86)' };
  const freshProfile = `${identity.appDataDirectory}/Relayer`, appDirectory = `${identity.localAppDataDirectory}/Programs/relayer-desktop`;
  const directories = [appDirectory];
  for (const parent of [`${identity.localAppDataDirectory}/Programs`, identity.programFilesDirectory, identity.programFilesX86Directory]) for (const name of ['Relayer', 'relayer-desktop']) directories.push(`${parent}/${name}`);
  const registryChecks = ['CurrentUser', 'LocalMachine'].flatMap(hive => ['Registry32', 'Registry64'].map(view => ({ hive, view, checked: true, installKey: WINDOWS_NSIS_INSTALLATION.installKey, uninstallKey: WINDOWS_NSIS_INSTALLATION.uninstallKey })));
  return { preflight: { freshProfile, userDataAbsent: true, identity, installation: { appDirectory, directories: [...new Set(directories)].map(path => ({ path, absent: true })), registryChecks, registrations: [] } },
    runtime: { version: '0.2.0', identity: structuredClone(identity), freshProfile, installedExecutable: `${appDirectory}/Relayer.exe`, installation: { appDirectory, registryChecks: structuredClone(registryChecks), registrations: [
      {kind:'production-nsis',hive:'CurrentUser',view:'Registry64',key:WINDOWS_NSIS_INSTALLATION.installKey,installLocation:appDirectory},
      {kind:'production-nsis',hive:'CurrentUser',view:'Registry64',key:WINDOWS_NSIS_INSTALLATION.uninstallKey,displayName:'Relayer 0.2.0',displayVersion:'0.2.0',uninstallString:`"${appDirectory}/Uninstall Relayer.exe" /currentuser`}
    ] } } };
}
import { UUID } from 'builder-util-runtime';
import { getWindowsInstallationDirName } from 'app-builder-lib/out/targets/targetUtil.js';
it('binds fresh installation proof to the real NSIS identity, all registry views, full directories and ordinary user', () => {
  expect(getWindowsInstallationDirName({ productFilename: 'Relayer', sanitizedName: 'relayer-desktop' }, false)).toBe(WINDOWS_NSIS_INSTALLATION.defaultDirectoryName);
  expect(WINDOWS_NSIS_INSTALLATION.guid).toBe(UUID.v5('ai.relayer.desktop', UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3')));
  const clean = collectedInstallEnvironment(); expect(() => validateCollectedWindowsInstallEnvironment(clean.preflight, clean.runtime)).not.toThrow();
  // HKCU shared views and the uninstall enumeration retain the same real key
  // through more than one read; these are not different installations.
  const shared=structuredClone(clean);shared.runtime.installation.registrations.push(...shared.runtime.installation.registrations.map(item=>({...item,view:'Registry32'})), {...shared.runtime.installation.registrations[1],kind:'production-display-name'});
  expect(()=>validateCollectedWindowsInstallEnvironment(shared.preflight,shared.runtime)).not.toThrow();
  const changes = [
    fixture => { fixture.preflight.installation.directories[0].absent = false; }, // Remnant directory with no Relayer.exe still fails.
    fixture => { fixture.preflight.installation.registrations.push({ hive: 'LocalMachine', view: 'Registry32', key: WINDOWS_NSIS_INSTALLATION.uninstallKey }); },
    fixture => { fixture.preflight.installation.registryChecks.pop(); },
    fixture => { fixture.preflight.identity.administratorGroupMember = true; },
    fixture => { fixture.runtime.identity.sid = 'S-1-5-21-100-200-300-1002'; },
    fixture => { fixture.preflight.installation.directories.pop(); },
    fixture => { fixture.preflight.userDataAbsent = false; },
    fixture => { fixture.runtime.installation.registrations = []; }, // Extracted payload without running NSIS.
    fixture => { fixture.runtime.installation.registrations[0].installLocation = 'C:/OtherApp'; },
    fixture => { fixture.runtime.installation.registrations[1].displayVersion = '0.1.0'; },
    fixture => { fixture.runtime.installation.registrations[1].uninstallString = '"C:/OtherApp/Uninstall Relayer.exe" /currentuser'; },
    fixture => { fixture.runtime.installation.registrations[0].hive = 'LocalMachine'; },

  ];
  for (const change of changes) { const fixture = collectedInstallEnvironment(); change(fixture); expect(() => validateCollectedWindowsInstallEnvironment(fixture.preflight, fixture.runtime)).toThrow(); }
});
it('requires first-install proof without demanding or fabricating a publication receipt', () => {
  const f = fixture(); expect(validateWindowsFirstInstall(f)).toMatchObject({ result: 'passed', scope: expect.stringContaining('no updater or publication claim') });
});
it('withholds the installer gate for unsigned runtime, external Node, system CRT, failed graph, lost reopen or missing evidence', () => {
  const changes = [f => { f.observations.signatures.pop(); }, f => { f.observations.environment.externalNodeOnPath = true; },
    f => { f.observations.runtime.crtLoadedModules[0].fromAppDirectory = false; }, f => { f.observations.runtime.unicodeStdinPreserved = false; },
    f => { f.observations.live.lifecycle = 'failed'; }, f => { f.observations.live.currentLayerId = 11; },
    f => { f.observations.reopen.finalLayerId = 11; }, f => { f.observations.evidence.pop(); },
    f => { f.receipt.sourceCommit = 'c'.repeat(40); }];
  for (const change of changes) { const f = fixture(); change(f); expect(() => validateWindowsFirstInstall(f)).toThrow(); }
});
import { cp, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { finished } from 'node:stream/promises';
import { createPackage } from '@electron/asar';
import { readInstalledWindowsMetadata } from '../desktop/release/read-windows-install-metadata.mjs';
import { createWindowsFirstInstallEvidence } from '../desktop/release/windows-first-install.mjs';
it('reads source/version from the real installed ASAR and rejects altered package bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'win-installed-metadata-'));
  try {
    const input = join(root, 'input'), archive = join(root, 'app.asar'); await mkdir(input);
    const metadata = { version: '0.2.0', relayerReleaseSourceCommit: source, relayerReleaseTarget: 'windows-x64', relayerUpdateChannel: 'preview', relayerArtifactMode: 'release', relayerProductName: 'Relayer' };
    await writeFile(join(input, 'package.json'), JSON.stringify(metadata)); await finished(await createPackage(input, archive), { cleanup: true });
    expect(await readInstalledWindowsMetadata(archive)).toMatchObject({ sourceCommit: source, version: '0.2.0', artifactMode: 'release' });
    const bytes = await readFile(archive); bytes[bytes.length - 1] ^= 1; await writeFile(archive, bytes);
    await expect(readInstalledWindowsMetadata(archive)).rejects.toThrow('integrity mismatch');
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('rejects a contradictory retained persistence record even when every file hash matches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'win-gate-records-')); const f = fixture();
  try {
    const installer = join(root, f.installerName), receiptPath = join(root, 'receipt.json'), observationsPath = join(root, 'observations.json');
    await writeFile(installer, 'signed-installer-fixture'); const installerHash = createHash('sha256').update('signed-installer-fixture').digest('hex');
    f.receipt.artifacts[0].sha256 = installerHash; f.observations.installerSha256 = installerHash; f.observations.signatures[0].sha256 = installerHash;
    const records = {
      preflight: { schema: 'windows-first-install-preflight/v1', at: '2026-10-06T10:00:00Z', sourceCommit: source, version: '0.2.0', emptyBeforeInstall: true, freshProfile: f.observations.freshProfile.path, workflowRunId: '123', workflowRunAttempt: '1' },
      metadata: { schema: 'windows-installed-metadata/v1', sourceCommit: source, version: '0.2.0', target: 'windows-x64', channel: 'preview', artifactMode: 'release' },
      runtime: { installedExecutable: 'C:/Users/InstallerTest/AppData/Local/Programs/Relayer/Relayer.exe', schema: 'windows-first-install-runtime/v1', at: '2026-10-06T10:01:00Z', sourceCommit: source, version: '0.2.0', nodeVersion: 'v22.23.2', unicodeStdinPreserved: true, crtLoadedModules: f.observations.runtime.crtLoadedModules, signatures: f.observations.signatures },
      persistence: { schema: 'windows-installed-completion/v2', databasePath: `${f.observations.freshProfile.path}/graphcomplete-runtime/graph.sqlite3`, observedAt: '2026-10-06T10:02:00Z', interaction_node_id: 32, lifecycle: 'failed', current_layer_id: 10, final_layer_id: 10 },
      'reopen-persistence': { schema: 'windows-installed-completion/v2', databasePath: `${f.observations.freshProfile.path}/graphcomplete-runtime/graph.sqlite3`, observedAt: '2026-10-06T10:03:00Z', interaction_node_id: 32, lifecycle: 'succeeded', current_layer_id: 10, final_layer_id: 10 },
      'followup-persistence': { schema: 'windows-installed-completion/v2', databasePath: `${f.observations.freshProfile.path}/graphcomplete-runtime/graph.sqlite3`, observedAt: '2026-10-06T10:04:00Z', interaction_node_id: 33, lifecycle: 'succeeded', current_layer_id: 11, final_layer_id: 11 },
    };
    const fresh = collectedInstallEnvironment();
    Object.assign(records.preflight, fresh.preflight); Object.assign(records.runtime, fresh.runtime);
    records['live-authoring-runtime'] = { schema: 'windows-live-authoring-runtime/v2', interactionNodeId: 32, finalLayerId: 10, parserVersion: '5.9.3', submission: { nodeId: 32, rootLayerId: 10, rootActionId: 10, resultSha256: digest }, userSid: fresh.runtime.identity.sid, userProfile: fresh.runtime.identity.userProfile, providerHome: `${fresh.runtime.identity.userProfile}/.codex`, providerHomeKind: 'codex-default', rolloutPath: `${fresh.runtime.identity.userProfile}/.codex/sessions/run.jsonl`, userDataDirectory: f.observations.freshProfile.path,
      nodePath: 'C:/Users/InstallerTest/AppData/Local/Programs/relayer-desktop/resources/node/node.exe', exitCode: 0, observedAt: '2026-10-06T10:01:30Z', commandSha256: digest, rolloutSha256: digest, callId: 'authoring-call' };
    records['installer-payload'] = { schema: 'windows-installer-payload/v2', installedRoot: fresh.runtime.installation.appDirectory, installerSha256: installerHash, metadata: records.metadata, files: ['Relayer.exe', 'resources/bin/relayer-app-server.exe', 'resources/bin/relayer-graph-server.exe', 'resources/node/node.exe'].map(path => ({ path, candidateSha256: digest, installedSha256: digest })) };
    records['live-authoring-runtime'].installedRuntimeSha256 = createHash('sha256').update(JSON.stringify(records.runtime)).digest('hex');
    const runtimeHash = records['live-authoring-runtime'].installedRuntimeSha256;
    const generation = (pid, createdAt, observedAt, state = 'running') => ({schema:'windows-installed-processes/v1',state,observedAt,installedRoot:fresh.runtime.installation.appDirectory,freshProfile:fresh.runtime.freshProfile,userSid:fresh.runtime.identity.sid,installedRuntimeSha256:runtimeHash,
      processes: state === 'stopped' ? [] : ['electron','app-server','graph-server'].map((role,index)=>({role,pid:pid+index,parentPid:index ? pid : 1,createdAt,path:role==='electron'?fresh.runtime.installedExecutable:`${fresh.runtime.installation.appDirectory}/resources/bin/relayer-${role}.exe`,userSid:fresh.runtime.identity.sid,sha256:digest}))});
    for (const [role,id] of [['persistence',32],['reopen-persistence',32],['followup-persistence',33]]) {
      const record = records[role]; record.productDatabasePath = `${fresh.runtime.freshProfile}/product-data/product.sqlite3`;
      record.interaction={interactionId:id,threadId:2,graphNodeId:id,prompt:'Why the sky is blue?',completionStatus:'accepted',providerId:'qa-custom-provider',modelId:'openai/gpt-6-luna',adapterId:'openrouter',definitionAdapterId:'openrouter',providerKind:'openrouter',attemptProviderId:'qa-custom-provider',attemptModelId:'openai/gpt-6-luna',attemptOutcome:'accepted'};
      record.processGeneration=generation(role==='persistence'?100:200,role==='persistence'?'2026-10-06T10:00:30Z':'2026-10-06T10:02:40Z',record.observedAt);
    }
    records['shutdown-processes']=generation(0,'','2026-10-06T10:02:30Z','stopped');

    for (const item of f.observations.evidence) {
      item.path = join(root, `${item.role}.json`); const bytes = Buffer.from(JSON.stringify(records[item.role] ?? { syntheticUiFixture: item.role }));
      await writeFile(item.path, bytes); item.sha256 = createHash('sha256').update(bytes).digest('hex');
    }
    await writeFile(receiptPath, JSON.stringify(f.receipt)); await writeFile(observationsPath, JSON.stringify(f.observations));
    await expect(createWindowsFirstInstallEvidence({ releaseReceiptPath: receiptPath, installerPath: installer, observationsPath, outputPath: join(root, 'gate.json') })).rejects.toThrow('persisted completion');
    records.persistence.lifecycle = 'succeeded';
    records.persistence.databasePath = 'C:/Users/OldDev/AppData/Roaming/Relayer Dev/graphcomplete-runtime/graph.sqlite3';
    const wrongRecord = f.observations.evidence.find(item => item.role === 'persistence'), wrongBytes = JSON.stringify(records.persistence);
    await writeFile(wrongRecord.path, wrongBytes); wrongRecord.sha256 = createHash('sha256').update(wrongBytes).digest('hex');
    await writeFile(observationsPath, JSON.stringify(f.observations));
    await expect(createWindowsFirstInstallEvidence({ releaseReceiptPath: receiptPath, installerPath: installer, observationsPath, outputPath: join(root, 'gate.json') })).rejects.toThrow('different Windows profile');
    records.persistence.databasePath = `${f.observations.freshProfile.path}/graphcomplete-runtime/graph.sqlite3`;
    const record = f.observations.evidence.find(item => item.role === 'persistence'), corrected = JSON.stringify(records.persistence);
    await writeFile(record.path, corrected); record.sha256 = createHash('sha256').update(corrected).digest('hex');
    await writeFile(observationsPath, JSON.stringify(f.observations));
    const mutateRecord = async (role, mutate) => {
      const saved=structuredClone(records[role]); mutate(records[role]);
      const item=f.observations.evidence.find(item=>item.role===role), bytes=JSON.stringify(records[role]);
      await writeFile(item.path,bytes);item.sha256=createHash('sha256').update(bytes).digest('hex');await writeFile(observationsPath,JSON.stringify(f.observations));
      await expect(createWindowsFirstInstallEvidence({ releaseReceiptPath: receiptPath, installerPath: installer, observationsPath, outputPath: join(root, 'reject.json') })).rejects.toThrow();
      records[role]=saved;const restored=JSON.stringify(saved);await writeFile(item.path,restored);item.sha256=createHash('sha256').update(restored).digest('hex');await writeFile(observationsPath,JSON.stringify(f.observations));
    };
    await mutateRecord('installer-payload',record=>{record.installedRoot='C:/CleanExtraction';});
    await mutateRecord('persistence',record=>{record.interaction.prompt='A different question';});
    await mutateRecord('persistence',record=>{record.interaction.providerKind='other';});
    for (const completionStatus of ['running','submitted','failed','stopped','succeeded']) {
      await mutateRecord('persistence',record=>{record.interaction.completionStatus=completionStatus;});
    }
    await mutateRecord('persistence',record=>{record.interaction.modelId=record.interaction.attemptModelId='wrong-model';});
    await mutateRecord('reopen-persistence',record=>{record.processGeneration=structuredClone(records.persistence.processGeneration);record.processGeneration.observedAt=record.observedAt;});
    await mutateRecord('reopen-persistence',record=>{record.processGeneration.processes[1].parentPid=999;});
    await mutateRecord('reopen-persistence',record=>{record.processGeneration.processes[1].path='C:/OtherApp/relayer-app-server.exe';});
    await mutateRecord('reopen-persistence',record=>{record.processGeneration.processes[1].userSid='S-1-5-21-999-999-999-1001';});
    await mutateRecord('reopen-persistence',record=>{record.processGeneration.processes[1].sha256='c'.repeat(64);});
    await mutateRecord('shutdown-processes',record=>{record.processes=structuredClone(records.persistence.processGeneration.processes);});
    await mutateRecord('shutdown-processes',record=>{record.observedAt='2026-10-06T10:03:30Z';});
    expect(await createWindowsFirstInstallEvidence({ releaseReceiptPath: receiptPath, installerPath: installer, observationsPath, outputPath: join(root, 'gate.json') })).toMatchObject({ result: 'passed' });
    await expect(createWindowsFirstInstallEvidence({ releaseReceiptPath: receiptPath, installerPath: installer, observationsPath, outputPath: join(root, 'gate.json') })).rejects.toMatchObject({ code: 'EEXIST' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

import { collectWindowsInstallerFiles } from '../desktop/release/collect-windows-installer-files.mjs';
it('compares the complete extracted installer payload to installed bytes and rejects a changed installed runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'win-installer-payload-'));
  try {
    const candidate = join(root, 'candidate'), installed = join(root, 'installed'), input = join(root, 'asar-input'), installer = join(root, 'Relayer.exe');
    await mkdir(input); await mkdir(join(candidate, 'resources/node'), { recursive: true }); await mkdir(join(candidate, 'resources/bin'), { recursive: true });
    await writeFile(join(input, 'package.json'), JSON.stringify({ version: '0.2.0', relayerReleaseSourceCommit: source, relayerReleaseTarget: 'windows-x64', relayerUpdateChannel: 'preview', relayerArtifactMode: 'release', relayerProductName: 'Relayer' }));
    await finished(await createPackage(input, join(candidate, 'resources/app.asar')), { cleanup: true });
    for (const path of ['Relayer.exe', 'resources/node/node.exe', 'resources/bin/relayer-app-server.exe', 'resources/bin/relayer-graph-server.exe', 'resources/bin/vcruntime140.dll']) await writeFile(join(candidate, path), `fixture ${path}`);
    await writeFile(installer, 'NSIS extraction fixture'); await cp(candidate, installed, { recursive: true });
    // Only the external decompressor is substituted; production inventory,
    // ASAR reading and all installed-file comparisons run against real files.
    let layout = 'nested', extractions = 0;
    const execute = async (_tool, args) => {
      extractions++;
      const output = args.find(arg => arg.startsWith('-o')).slice(2);
      if (args[1] !== installer) { await cp(candidate, output, { recursive: true }); return; }
      if (['direct', 'mixed', 'partial'].includes(layout)) {
        await cp(candidate, output, { recursive: true });
        if (layout === 'mixed') await writeFile(join(output, 'app-64.7z'), 'second representation');
        if (layout === 'partial') await rm(join(output, 'resources/node/node.exe'));
      } else {
        await mkdir(output); await writeFile(join(output, 'app-64.7z'), 'payload fixture');
        if (layout === 'multiple') { await mkdir(join(output, 'other')); await writeFile(join(output, 'other/app-64.7z'), 'competing payload'); }
      }
    };
    const collect = () => collectWindowsInstallerFiles({ installer, sevenZip: 'fixture-7z', installedRoot: installed, execute });
    for (layout of ['nested', 'direct']) {
      extractions = 0;
      const result = await collect();
      expect(result).toMatchObject({ schema: 'windows-installer-payload/v2', metadata: { sourceCommit: source, version: '0.2.0' } });
      expect(result.files).toHaveLength(6);
      expect(result.installedRoot).toBe(await realpath(installed));
      expect(extractions).toBe(layout === 'nested' ? 2 : 1);
    }
    for (layout of ['mixed', 'partial', 'multiple']) await expect(collect()).rejects.toThrow('ambiguous or incomplete');
    await writeFile(join(installed, 'resources/node/node.exe'), 'changed installed Node');
    for (layout of ['nested', 'direct']) await expect(collect()).rejects.toThrow('differs from exact installer payload');
  } finally { await rm(root, { recursive: true, force: true }); }
});

import { collectWindowsAuthoringRuntime } from '../desktop/release/collect-windows-authoring-runtime.mjs';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { RelayerGraphClient } from '../packages/graph-client/dist/index.js';
import { productionProviderRuntimeDependencies, productionHarnessRuntimeDescriptor } from '../desktop/main/providers/provider-adapter-registry.mjs';
it('binds real graph-client submission output to the exact owned command, observed interaction and final layer across native formats', async () => {
  const root = await mkdtemp(join(tmpdir(), 'win-live-authoring-'));
  const accepted = { nodeId: 32, rootAction: { id: 10, sourceNodeId: 32, targetLayerId: 10, kind: 'navigate', relation: 'expand', state: 'accepted' },
    rootLayer: { layer: { id: 10, state: 'accepted', nodes: [37], edges: [], layout: { version: 1, placements: [{ nodeId: 37, x: 0.5, y: 0.5 }] } },
      nodes: [{ id: 37, detail: 'private graph result', state: 'accepted' }], edges: [], actions: [] } };
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    requests.push({ path: request.url, method: request.method, body: JSON.parse(Buffer.concat(chunks).toString()) });
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(accepted));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    // Exercise the real production graph-client submit request and returned API
    // object. The server is a realistic deterministic fixture, not live proof.
    const graph = new RelayerGraphClient({ url: `http://127.0.0.1:${server.address().port}`, token: 'fixture', nodeId: 32 });
    const result = await graph.submit(32);
    expect(requests).toEqual([{ path: '/api/graph/submit', method: 'POST', body: { nodeId: 32 } }]);
    const userProfile = join(root, 'qa-user'), profile = join(userProfile, 'AppData/Roaming/Relayer'), installed = join(userProfile, "installed'quoted"), rollout = join(userProfile, '.codex/sessions/rollout.jsonl');
    await mkdir(profile, { recursive: true }); await mkdir(installed); await mkdir(join(userProfile, '.codex/sessions'), { recursive: true });
    const executable = join(installed, 'Relayer.exe'); await writeFile(executable, 'fixture');
    const actualInstalled = await realpath(installed), ownedNode = `${actualInstalled}/resources/node/node.exe`, clientUrl = pathToFileURL(join(actualInstalled, 'resources/graph-client/index.js')).href;
    const program = `import { RelayerGraphClient } from ${JSON.stringify(clientUrl)};\nconst graph = RelayerGraphClient.fromEnv();\nconst result = await graph.submit(32);\nconsole.log(JSON.stringify(result));`;
    const command = `$OutputEncoding=[Text.UTF8Encoding]::new($false)\n@'\n${program}\n'@ | & '${ownedNode.replaceAll("'", "''")}' --input-type=module`;
    const runtimeInspectionPath = join(root, 'installed-runtime.json');
    await writeFile(runtimeInspectionPath, JSON.stringify({ schema: 'windows-first-install-runtime/v1', freshProfile: profile, installedExecutable: executable,
      identity: { sid: 'S-1-5-21-100-200-300-1001', ordinaryUser: true, authenticated: true, administratorGroupMember: false, userProfile } }));
    // Observe the real API-provider mapper: secret@1 bypasses subscription homes;
    // the fallback managed descriptor preserves the OS user, not CODEX_HOME.
    expect(await productionProviderRuntimeDependencies({ accessContract: 'secret@1', adapterId: 'openrouter' }, {})).toEqual({});
    expect(productionHarnessRuntimeDescriptor({ runtimeId: 'codex', version: '0.159.3', executable: 'fixture' }, { environment: { USERPROFILE: userProfile, CODEX_HOME: 'ambient-override' } }).environment).toEqual({ USERPROFILE: userProfile });
    const options = { rolloutPath: rollout, runtimeInspectionPath, interactionNodeId: 32, finalLayerId: 10, notBefore: '2026-10-06T10:00:00Z' };
    const rows = (style, command, returned = result, exit = 0) => {
      const stdout = `graph program id: abcdef12\n${JSON.stringify(returned)}\n`;
      const payload = style === 'custom' ? { type: 'custom_tool_call', name: 'exec', call_id: 'call-1', input: `const r = await tools.exec_command({cmd:${JSON.stringify(command)}, shell:"powershell", max_output_tokens:3000}); text(r);` }
        : { type: 'function_call', name: 'exec_command', call_id: 'call-1', arguments: JSON.stringify({ cmd: command }) };
      const output = style === 'custom' ? [{ type: 'input_text', text: 'Script completed\nWall time 3.7 seconds\nOutput:\n' },
        { type: 'input_text', text: JSON.stringify({ exit_code: exit, output: stdout, wall_time_seconds: 3.7 }) }]
        : `Process exited with code ${exit}\nFinal output:\n${stdout}`;
      return [{ timestamp: '2026-10-06T10:01:00Z', type: 'response_item', payload }, { timestamp: '2026-10-06T10:01:10Z', type: 'response_item', payload: { type: `${payload.type}_output`, call_id: 'call-1', output } }];
    };
    const collect = async records => { await writeFile(rollout, records.map(row => JSON.stringify(row)).join('\n')); return collectWindowsAuthoringRuntime(options); };
    for (const style of ['custom', 'function']) {
      const record = await collect(rows(style, command));
      expect(record).toMatchObject({ schema: 'windows-live-authoring-runtime/v2', interactionNodeId: 32, finalLayerId: 10, exitCode: 0, callId: 'call-1', submission: { nodeId: 32, rootLayerId: 10 }, userSid: 'S-1-5-21-100-200-300-1001', providerHomeKind: 'codex-default' });
      expect(JSON.stringify(record)).not.toContain('private graph');
      const unrelated = command.replace('graph.submit(32)', 'graph.submit(31)'), unrelatedResult = structuredClone(result);
      unrelatedResult.nodeId = 31; unrelatedResult.rootAction.sourceNodeId = 31;
      await expect(collect(rows(style, unrelated, unrelatedResult))).rejects.toThrow('No successful');
      const mismatchedLayer = structuredClone(result); mismatchedLayer.rootLayer.layer.id = 11; mismatchedLayer.rootAction.targetLayerId = 11;
      await expect(collect(rows(style, command, mismatchedLayer))).rejects.toThrow('No successful');
      await expect(collect(rows(style, command, result, 1))).rejects.toThrow('No successful');
      const genericProbe = command.replace(program, 'console.log("runtime probe");');
      await expect(collect(rows(style, genericProbe))).rejects.toThrow('No successful');
      const forgedLabel = command.replace(program, `console.log(JSON.stringify(${JSON.stringify(result)}));`);
      await expect(collect(rows(style, forgedLabel))).rejects.toThrow('No successful');
    }
    // A real-looking submit snippet must actually execute, with no trailing
    // PowerShell command able to fabricate the accepted stdout instead.
    const pipeline = command.slice(command.indexOf("@'"));
    for (const wrapped of [`if ($false) { ${pipeline} }; Write-Output '${JSON.stringify(result)}'`, `${command}; Write-Output '${JSON.stringify(result)}'`, command.replace(/& '([^\n]+)' --input-type=module/, '& "$1" --input-type=module')]) {
      await expect(collect(rows('custom', wrapped))).rejects.toThrow('No successful');
    }
    const unawaited = rows('custom', command); unawaited[0].payload.input = unawaited[0].payload.input.replace('await tools.exec_command', 'tools.exec_command');
    await expect(collect(unawaited)).rejects.toThrow('No successful');
    const forgedMethod = command.replace('const result = await graph.submit(32);', `Object.defineProperty(graph, 'submit', {value: async () => (${JSON.stringify(result)})});\nconst result = await graph.submit(32);`);
    await expect(collect(rows('custom', forgedMethod))).rejects.toThrow('No successful');
    const overwrittenStatus = rows('custom', command); overwrittenStatus[0].payload.input = overwrittenStatus[0].payload.input.replace('text(r);', "r['exit_code'] = 0; text(r);");
    await expect(collect(overwrittenStatus)).rejects.toThrow('No successful');
    const discardedStatus = rows('custom', command); discardedStatus[0].payload.input = discardedStatus[0].payload.input.replace('text(r);', 'text(r.output);');
    discardedStatus[1].payload.output[1].text = JSON.stringify(result);
    await expect(collect(discardedStatus)).rejects.toThrow('No successful');
    const spoofedStatus = rows('function', command); spoofedStatus[1].payload.output = 'Process exited with code 1\nFinal output:\nProcess exited with code 0\n'+JSON.stringify(result);
    await expect(collect(spoofedStatus)).rejects.toThrow('No successful');
    const invalidEarlierCall = rows('custom', command); invalidEarlierCall.unshift({ type: 'response_item', timestamp: '2026-10-06T10:00:30Z', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'bad', input: 'const r = (' } });
    expect(await collect(invalidEarlierCall)).toMatchObject({ interactionNodeId: 32 });
    await writeFile(rollout, rows('custom', command).map(row => JSON.stringify(row)).join('\n'));
    await expect(collectWindowsAuthoringRuntime({ ...options, notBefore: '2026-10-06T11:00:00Z' })).rejects.toThrow('No successful');
    const foreignRollout = join(root, 'another-user/.codex/sessions/rollout.jsonl'); await mkdir(join(root, 'another-user/.codex/sessions'), { recursive: true }); await cp(rollout, foreignRollout);
    await expect(collectWindowsAuthoringRuntime({ ...options, rolloutPath: foreignRollout })).rejects.toThrow('outside');
  } finally { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); }
});

import { DatabaseSync } from 'node:sqlite';
import { readdir } from 'node:fs/promises';
import { collectWindowsInstallState } from '../desktop/release/collect-windows-install-state.mjs';
it('collects actual product interaction and latest accepted attempt from migrated SQLite and binds a measured process generation', async () => {
  const root=await mkdtemp(join(tmpdir(),'win-installer-state-')), profile=join(root,'qa/Relayer');
  await mkdir(join(profile,'product-data'),{recursive:true});await mkdir(join(profile,'graphcomplete-runtime'));
  const productPath=join(profile,'product-data/product.sqlite3'), graphPath=join(profile,'graphcomplete-runtime/graph.sqlite3');
  const product=new DatabaseSync(productPath), graph=new DatabaseSync(graphPath);
  try {
    // Use the production product migrations, including real provider definition
    // and attempt receipts; never export the DB or credential-reference column.
    const migrations=new URL('../crates/relayer-app-server/src/storage/sqlite/migrations/',import.meta.url);
    for(const name of (await readdir(migrations)).sort()) if(name.endsWith('.sql')) product.exec(await readFile(new URL(name,migrations),'utf8'));
    product.exec(`INSERT INTO threads(id,title,created_at,updated_at) VALUES(2,'sky','1','1');
      INSERT INTO model_providers(id,label,connected,refreshed_at,adapter_id,access_contract,endpoint,credential_reference) VALUES('qa-custom-provider','My API',1,'1','openrouter','secret@1','https://openrouter.ai/api/v1/','never-export-this-reference');
      INSERT INTO interactions(id,thread_id,sequence,text,created_at,graph_node_id,completion_status,model_provider_id,provider_model_id) VALUES(100,2,1,'Why the sky is blue?','1',32,'accepted','qa-custom-provider','openai/gpt-6-luna');
      INSERT INTO interaction_attempts(id,interaction_id,attempt_number,started_at,finished_at,family_id,family_revision,harness_configuration_name,harness_configuration_revision,harness_configuration_digest,provider_id,adapter_id,adapter_implementation_version,model_id,access_contract,outcome)
      VALUES(10,100,1,'1','2',1,1,'codex-basic',1,'fixture','qa-custom-provider','openrouter',2,'openai/gpt-6-luna','secret@1','accepted');`);
    const temporal=await readFile(new URL('../crates/relayer-graph-core/src/storage/sqlite/migrations/0011_temporal_completions.sql',import.meta.url),'utf8');
    graph.exec('CREATE TABLE nodes(id INTEGER PRIMARY KEY);CREATE TABLE layers(id INTEGER PRIMARY KEY);INSERT INTO nodes VALUES(32);INSERT INTO layers VALUES(10);'+temporal.slice(temporal.indexOf('CREATE TABLE completion_states'),temporal.indexOf('CREATE TABLE current_revisions')));
    graph.exec("INSERT INTO completion_states(interaction_node_id,lifecycle,head_revision,current_layer_id,final_layer_id) VALUES(32,'succeeded',1,10,10)");
    const runtime=collectedInstallEnvironment().runtime;runtime.schema='windows-first-install-runtime/v1';runtime.freshProfile=profile;
    const runtimeInspectionPath=join(root,'runtime.json');await writeFile(runtimeInspectionPath,JSON.stringify(runtime));
    let generation=100,calls=0;
    const inspectProcesses=async(_runtime,state)=>{calls++;return {schema:'windows-installed-processes/v1',state,userSid:runtime.identity.sid,installedRoot:runtime.installation.appDirectory,freshProfile:profile,observedAt:new Date().toISOString(),processes:state==='stopped'?[]:['electron','app-server','graph-server'].map((role,index)=>({role,pid:generation+index,createdAt:'2026-10-06T10:00:00Z'}))};};
    const options={runtimeInspectionPath,interactionNodeId:32,inspectProcesses};
    const record=await collectWindowsInstallState(options);
    expect(record).toMatchObject({schema:'windows-installed-completion/v2',interaction_node_id:32,lifecycle:'succeeded',databasePath:await realpath(graphPath),productDatabasePath:await realpath(productPath),interaction:{interactionId:100,graphNodeId:32,providerId:'qa-custom-provider',providerKind:'openrouter',modelId:'openai/gpt-6-luna',prompt:'Why the sky is blue?',completionStatus:'accepted',attemptOutcome:'accepted'}});
    expect(JSON.stringify(record)).not.toContain('never-export-this-reference');expect(JSON.stringify(record)).not.toContain('https://');expect(calls).toBe(2);
    for (const completionStatus of ['running','submitted','failed','stopped','succeeded']) {
      product.prepare('UPDATE interactions SET completion_status=?').run(completionStatus);
      await expect(collectWindowsInstallState(options)).rejects.toThrow('execution attempt disagree');
    }
    product.exec("UPDATE interactions SET completion_status='accepted'");
    product.exec("UPDATE model_providers SET endpoint='https://other-provider.example/v1'");
    expect((await collectWindowsInstallState(options)).interaction.providerKind).toBe('other');
    product.exec("UPDATE model_providers SET endpoint='https://openrouter.ai/api/v1'");
    const changing=async(runtime,state)=>{const snapshot=await inspectProcesses(runtime,state);generation++;return snapshot;};
    await expect(collectWindowsInstallState({...options,inspectProcesses:changing})).rejects.toThrow('generation changed');
    product.exec("INSERT INTO interaction_attempts(id,interaction_id,attempt_number,started_at,finished_at,family_id,family_revision,harness_configuration_name,harness_configuration_revision,harness_configuration_digest,provider_id,adapter_id,adapter_implementation_version,model_id,access_contract,outcome) VALUES(11,100,2,'3','4',1,1,'codex-basic',1,'fixture','qa-custom-provider','openrouter',2,'wrong-model','secret@1','accepted')");
    await expect(collectWindowsInstallState(options)).rejects.toThrow('execution attempt disagree');
    const stopped=await collectWindowsInstallState({...options,state:'stopped'});expect(stopped).toMatchObject({schema:'windows-installed-processes/v1',state:'stopped',processes:[]});
    await expect(collectWindowsInstallState({...options,state:'stopped',inspectProcesses:async()=>({...stopped,processes:[{pid:100}]})})).rejects.toThrow('checkpoint is incomplete');
  } finally { product.close();graph.close();await rm(root,{recursive:true,force:true}); }
});
