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
    evidence: ['installed-launch', 'accepted-graph', 'reopened-graph', 'video', 'runtime', 'metadata', 'preflight', 'persistence', 'reopen-persistence', 'followup-persistence', 'installer-payload', 'live-authoring-runtime'].map(role => ({ role, sha256: digest })) };
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
    runtime: { identity: structuredClone(identity), freshProfile, installedExecutable: `${appDirectory}/Relayer.exe` } };
}
import { UUID } from 'builder-util-runtime';
it('binds fresh installation proof to the real NSIS identity, all registry views, full directories and ordinary user', () => {
  expect(WINDOWS_NSIS_INSTALLATION.guid).toBe(UUID.v5('ai.relayer.desktop', UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3')));
  const clean = collectedInstallEnvironment(); expect(() => validateCollectedWindowsInstallEnvironment(clean.preflight, clean.runtime)).not.toThrow();
  const changes = [
    fixture => { fixture.preflight.installation.directories[0].absent = false; }, // Remnant directory with no Relayer.exe still fails.
    fixture => { fixture.preflight.installation.registrations.push({ hive: 'LocalMachine', view: 'Registry32', key: WINDOWS_NSIS_INSTALLATION.uninstallKey }); },
    fixture => { fixture.preflight.installation.registryChecks.pop(); },
    fixture => { fixture.preflight.identity.administratorGroupMember = true; },
    fixture => { fixture.runtime.identity.sid = 'S-1-5-21-100-200-300-1002'; },
    fixture => { fixture.preflight.installation.directories.pop(); },
    fixture => { fixture.preflight.userDataAbsent = false; },
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
      persistence: { schema: 'windows-installed-completion/v1', databasePath: `${f.observations.freshProfile.path}/graphcomplete-runtime/graph.sqlite3`, observedAt: '2026-10-06T10:02:00Z', interaction_node_id: 32, lifecycle: 'failed', current_layer_id: 10, final_layer_id: 10 },
      'reopen-persistence': { schema: 'windows-installed-completion/v1', databasePath: `${f.observations.freshProfile.path}/graphcomplete-runtime/graph.sqlite3`, observedAt: '2026-10-06T10:03:00Z', interaction_node_id: 32, lifecycle: 'succeeded', current_layer_id: 10, final_layer_id: 10 },
      'followup-persistence': { schema: 'windows-installed-completion/v1', databasePath: `${f.observations.freshProfile.path}/graphcomplete-runtime/graph.sqlite3`, observedAt: '2026-10-06T10:04:00Z', interaction_node_id: 33, lifecycle: 'succeeded', current_layer_id: 11, final_layer_id: 11 },
    };
    const fresh = collectedInstallEnvironment();
    Object.assign(records.preflight, fresh.preflight); Object.assign(records.runtime, fresh.runtime);
    records['live-authoring-runtime'] = { schema: 'windows-live-authoring-runtime/v2', interactionNodeId: 32, finalLayerId: 10, parserVersion: '5.9.3', submission: { nodeId: 32, rootLayerId: 10, rootActionId: 10, resultSha256: digest }, userSid: fresh.runtime.identity.sid, userProfile: fresh.runtime.identity.userProfile, providerHome: `${fresh.runtime.identity.userProfile}/.codex`, providerHomeKind: 'codex-default', rolloutPath: `${fresh.runtime.identity.userProfile}/.codex/sessions/run.jsonl`, userDataDirectory: f.observations.freshProfile.path,
      nodePath: 'C:/Users/InstallerTest/AppData/Local/Programs/relayer-desktop/resources/node/node.exe', exitCode: 0, observedAt: '2026-10-06T10:01:30Z', commandSha256: digest, rolloutSha256: digest, callId: 'authoring-call' };
    records['installer-payload'] = { schema: 'windows-installer-payload/v1', installerSha256: installerHash, metadata: records.metadata, files: ['Relayer.exe', 'resources/bin/relayer-app-server.exe', 'resources/bin/relayer-graph-server.exe', 'resources/node/node.exe'].map(path => ({ path, candidateSha256: digest, installedSha256: digest })) };
    records['live-authoring-runtime'].installedRuntimeSha256 = createHash('sha256').update(JSON.stringify(records.runtime)).digest('hex');
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
