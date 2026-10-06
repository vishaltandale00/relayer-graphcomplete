import { expect, it } from 'vitest';
import { validateWindowsFirstInstall } from '../desktop/release/windows-first-install.mjs';
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
    evidence: ['installed-launch', 'accepted-graph', 'reopened-graph', 'video', 'runtime', 'metadata', 'preflight', 'persistence', 'reopen-persistence', 'followup-persistence', 'installer-payload', 'live-authoring-runtime'].map(role => ({ role, sha256: digest })) };
  return { receipt, observations, installerName: receipt.artifacts[0].name, installerSha256: digest };
}
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
      persistence: { schema: 'windows-installed-completion/v1', databasePath: `${f.observations.freshProfile.path}/graphcomplete-runtime/graph.sqlite3`, observedAt: '2026-10-06T10:02:00Z', interaction_node_id: 32, lifecycle: 'failed', current_layer_id: 10, final_layer_id: 10 },
      'reopen-persistence': { schema: 'windows-installed-completion/v1', databasePath: `${f.observations.freshProfile.path}/graphcomplete-runtime/graph.sqlite3`, observedAt: '2026-10-06T10:03:00Z', interaction_node_id: 32, lifecycle: 'succeeded', current_layer_id: 10, final_layer_id: 10 },
      'followup-persistence': { schema: 'windows-installed-completion/v1', databasePath: `${f.observations.freshProfile.path}/graphcomplete-runtime/graph.sqlite3`, observedAt: '2026-10-06T10:04:00Z', interaction_node_id: 33, lifecycle: 'succeeded', current_layer_id: 11, final_layer_id: 11 },
    };
    records['live-authoring-runtime'] = { schema: 'windows-live-authoring-runtime/v1', interactionNodeId: 32, userDataDirectory: f.observations.freshProfile.path,
      nodePath: 'C:/Users/InstallerTest/AppData/Local/Programs/Relayer/resources/node/node.exe', exitCode: 0, observedAt: '2026-10-06T10:01:30Z', commandSha256: digest, rolloutSha256: digest, callId: 'authoring-call' };
    records['installer-payload'] = { schema: 'windows-installer-payload/v1', installerSha256: installerHash, metadata: records.metadata, files: ['Relayer.exe', 'resources/bin/relayer-app-server.exe', 'resources/bin/relayer-graph-server.exe', 'resources/node/node.exe'].map(path => ({ path, candidateSha256: digest, installedSha256: digest })) };
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
    const execute = async (_tool, args) => {
      const output = args.find(arg => arg.startsWith('-o')).slice(2);
      if (args[1] === installer) { await mkdir(output); await writeFile(join(output, 'app-64.7z'), 'payload fixture'); }
      else await cp(candidate, output, { recursive: true });
    };
    const result = await collectWindowsInstallerFiles({ installer, sevenZip: 'fixture-7z', installedRoot: installed, execute });
    expect(result).toMatchObject({ schema: 'windows-installer-payload/v1', metadata: { sourceCommit: source, version: '0.2.0' } });
    expect(result.files).toHaveLength(6);
    await writeFile(join(installed, 'resources/node/node.exe'), 'changed installed Node');
    await expect(collectWindowsInstallerFiles({ installer, sevenZip: 'fixture-7z', installedRoot: installed, execute })).rejects.toThrow('differs from exact installer payload');
  } finally { await rm(root, { recursive: true, force: true }); }
});

import { collectWindowsAuthoringRuntime } from '../desktop/release/collect-windows-authoring-runtime.mjs';
it('retains only sanitized proof of a successful app-owned command from the actual installed profile rollout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'win-live-authoring-'));
  try {
    const profile = join(root, 'profile'), installed = join(root, 'installed'), rollout = join(profile, 'rollout.jsonl'); await mkdir(profile); await mkdir(installed);
    const executable = join(installed, 'Relayer.exe'); await writeFile(executable, 'fixture');
    const command = `@'\nconsole.log("private prompt must not be retained");\n'@ | & "${await realpath(installed)}/resources/node/node.exe" --input-type=module`;
    const rows = [{ timestamp: '2026-10-06T10:01:00Z', type: 'response_item', payload: { type: 'function_call', call_id: 'call-1', arguments: JSON.stringify({ cmd: command }) } },
      { timestamp: '2026-10-06T10:01:10Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: 'Process exited with code 0\nprivate graph result' } }];
    await writeFile(rollout, rows.map(row => JSON.stringify(row)).join('\n'));
    const options = { rolloutPath: rollout, userDataDirectory: profile, installedExecutable: executable, interactionNodeId: 32, notBefore: '2026-10-06T10:00:00Z' };
    const record = await collectWindowsAuthoringRuntime(options); expect(record).toMatchObject({ interactionNodeId: 32, exitCode: 0, callId: 'call-1' });
    expect(JSON.stringify(record)).not.toContain('private prompt'); expect(JSON.stringify(record)).not.toContain('private graph');
    rows[1].payload.output = 'Process exited with code 1\nFinal output:\nProcess exited with code 0\n';
    await writeFile(rollout, rows.map(row => JSON.stringify(row)).join('\n'));
    await expect(collectWindowsAuthoringRuntime(options)).rejects.toThrow('No successful');
    await expect(collectWindowsAuthoringRuntime({ ...options, notBefore: '2026-10-06T11:00:00Z' })).rejects.toThrow('No successful');
    await expect(collectWindowsAuthoringRuntime({ ...options, userDataDirectory: installed })).rejects.toThrow('outside');
  } finally { await rm(root, { recursive: true, force: true }); }
});
