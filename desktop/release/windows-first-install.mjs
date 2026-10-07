import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DESKTOP_RELEASE, desktopReleaseTarget } from './contract.mjs';
import { isNumericVersion } from './numeric-version.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const windows = desktopReleaseTarget('windows-x64');
// The pinned electron-builder NSIS UUID.v5 production identity. The deterministic
// fixture compares this to the real builder implementation, not an invented key.
export const WINDOWS_NSIS_INSTALLATION = Object.freeze({
  defaultDirectoryName: 'relayer-desktop',
  guid: '84f14565-3886-5a18-8e80-eb3a9f9c3c18',
  installKey: 'Software\\84f14565-3886-5a18-8e80-eb3a9f9c3c18',
  uninstallKey: 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\84f14565-3886-5a18-8e80-eb3a9f9c3c18',
});
const windowsPath = value => typeof value === 'string' && win32.isAbsolute(value) ? win32.resolve(value).toLowerCase() : null;
export function validateCollectedWindowsInstallEnvironment(preflight, runtime) {
  const identity = preflight.identity, installation = preflight.installation;
  if (preflight.userDataAbsent !== true || identity?.ordinaryUser !== true || identity.authenticated !== true || identity.administratorGroupMember !== false
    || !/^S-1-(?:\d+-)+\d+$/.test(identity.sid ?? '') || ['S-1-5-18', 'S-1-5-19', 'S-1-5-20'].includes(identity.sid) || !identity.name
    || !windowsPath(identity.userProfile) || !windowsPath(identity.appDataDirectory)
    || windowsPath(preflight.freshProfile) !== windowsPath(win32.join(identity.appDataDirectory, 'Relayer'))
    || runtime.identity?.sid !== identity.sid || runtime.identity?.name !== identity.name || runtime.identity?.ordinaryUser !== true
    || runtime.identity?.authenticated !== true || runtime.identity?.administratorGroupMember !== false
    || windowsPath(runtime.freshProfile) !== windowsPath(preflight.freshProfile)
    || windowsPath(runtime.identity?.userProfile) !== windowsPath(identity.userProfile)) throw new Error('Collected first-install identity is not the same fresh ordinary Windows user.');
  const appDirectory = windowsPath(installation?.appDirectory);
  if (!appDirectory || !windowsPath(runtime.installedExecutable) || win32.basename(runtime.installedExecutable).toLowerCase() !== 'relayer.exe'
    || appDirectory !== windowsPath(win32.dirname(runtime.installedExecutable)) || appDirectory !== windowsPath(win32.join(identity.localAppDataDirectory, 'Programs', WINDOWS_NSIS_INSTALLATION.defaultDirectoryName)) || !Array.isArray(installation.directories)
    || installation.directories.some(item => !windowsPath(item.path) || item.absent !== true)) throw new Error('Entire installed application directory was not absent before installation.');
  const expectedDirectories = [appDirectory];
  for (const parent of [identity.localAppDataDirectory && win32.join(identity.localAppDataDirectory, 'Programs'), identity.programFilesDirectory, identity.programFilesX86Directory]) {
    if (!windowsPath(parent)) throw new Error('Standard Windows installation locations were not inspected.');
    for (const name of ['Relayer', 'relayer-desktop']) expectedDirectories.push(windowsPath(win32.join(parent, name)));
  }
  const checkedDirectories = new Set(installation.directories.map(item => windowsPath(item.path)));
  if (expectedDirectories.some(path => !checkedDirectories.has(path))) throw new Error('Standard Windows installation locations were not inspected.');
  const checks = installation.registryChecks;
  if (!Array.isArray(checks) || checks.length !== 4 || !Array.isArray(installation.registrations) || installation.registrations.length !== 0) throw new Error('Existing or uninspected NSIS product registration.');
  for (const hive of ['CurrentUser', 'LocalMachine']) for (const view of ['Registry32', 'Registry64']) {
    const matching = checks.filter(item => item.hive === hive && item.view === view);
    if (matching.length !== 1 || matching[0].checked !== true || matching[0].installKey !== WINDOWS_NSIS_INSTALLATION.installKey
      || matching[0].uninstallKey !== WINDOWS_NSIS_INSTALLATION.uninstallKey) throw new Error('Existing or uninspected NSIS product registration.');
  }
  const installed = runtime.installation;
  if (windowsPath(installed?.appDirectory) !== appDirectory || !Array.isArray(installed.registryChecks) || installed.registryChecks.length !== 4 || !Array.isArray(installed.registrations)) throw new Error('Post-install NSIS registration is uninspected.');
  for (const hive of ['CurrentUser', 'LocalMachine']) for (const view of ['Registry32', 'Registry64']) {
    if (installed.registryChecks.filter(item => item.hive === hive && item.view === view && item.checked === true && item.installKey === WINDOWS_NSIS_INSTALLATION.installKey && item.uninstallKey === WINDOWS_NSIS_INSTALLATION.uninstallKey).length !== 1) throw new Error('Post-install NSIS registration is uninspected.');
  }
  const registrations = installed.registrations.filter(item => item.kind === 'production-nsis');
  const required = key => registrations.filter(item => item.hive === 'CurrentUser' && item.view === 'Registry64' && item.key === key);
  if (required(WINDOWS_NSIS_INSTALLATION.installKey).length !== 1 || required(WINDOWS_NSIS_INSTALLATION.uninstallKey).length !== 1) throw new Error('Expected installed NSIS production keys are absent.');
  for (const item of installed.registrations) {
    if (item.hive !== 'CurrentUser' || !['Registry32','Registry64'].includes(item.view)) throw new Error('Unexpected installed NSIS product registration.');
    if (item.kind === 'production-nsis' && item.key === WINDOWS_NSIS_INSTALLATION.installKey) {
      if (windowsPath(item.installLocation) !== appDirectory) throw new Error('NSIS install location is a different app.');
    } else if ((item.kind === 'production-nsis' && item.key === WINDOWS_NSIS_INSTALLATION.uninstallKey) || item.kind === 'production-display-name') {
      if (item.displayName !== `Relayer ${runtime.version}` || item.displayVersion !== runtime.version || !/^"([^"]+)" \/currentuser$/.test(item.uninstallString ?? '') || windowsPath(/^"([^"]+)" \/currentuser$/.exec(item.uninstallString ?? '')?.[1]) !== windowsPath(win32.join(appDirectory, 'Uninstall Relayer.exe'))) throw new Error('NSIS uninstall identity differs from the candidate.');
    } else throw new Error('Unexpected installed NSIS product registration.');
  }
}
export function validateWindowsInstallProcesses(record, runtime, runtimeSha256, expectedState) {
  const root = windowsPath(win32.dirname(runtime.installedExecutable ?? ''));
  if (record?.schema !== 'windows-installed-processes/v1' || record.state !== expectedState || record.installedRuntimeSha256 !== runtimeSha256 || record.userSid !== runtime.identity.sid
    || windowsPath(record.installedRoot) !== root || windowsPath(record.freshProfile) !== windowsPath(runtime.freshProfile) || !Number.isFinite(Date.parse(record.observedAt)) || !Array.isArray(record.processes)) throw new Error('Actual installed-process identity is unbound.');
  if (expectedState === 'stopped') { if (record.processes.length) throw new Error('Candidate processes were not stopped.'); return; }
  const images = { electron: runtime.installedExecutable, 'app-server': win32.join(root, 'resources/bin/relayer-app-server.exe'), 'graph-server': win32.join(root, 'resources/bin/relayer-graph-server.exe') };
  if (record.processes.length !== 3 || new Set(record.processes.map(item => item.pid)).size !== 3) throw new Error('Actual candidate process generation is incomplete.');
  for (const [role, path] of Object.entries(images)) {
    const matching = record.processes.filter(item => item.role === role), signature = runtime.signatures.find(item => item.role === role);
    const image = matching[0];
    if (matching.length !== 1 || !image || windowsPath(image.path) !== windowsPath(path) || image.userSid !== runtime.identity.sid || !Number.isSafeInteger(image.pid) || image.pid <= 0 || !Number.isSafeInteger(image.parentPid) || image.parentPid < 0
      || !Number.isFinite(Date.parse(image.createdAt)) || Date.parse(image.createdAt) > Date.parse(record.observedAt) || image.sha256 !== signature?.sha256) throw new Error('Candidate process path, owner, start time or exact bytes differs.');
  }
  const electron = record.processes.find(item => item.role === 'electron');
  if (record.processes.some(item => item.role !== 'electron' && (item.parentPid !== electron.pid || Date.parse(item.createdAt) < Date.parse(electron.createdAt)))) throw new Error('Candidate Rust servers belong to another Electron generation.');
}
export function validateWindowsFirstInstall({ receipt, installerName, installerSha256, observations }) {
  const artifacts = receipt?.artifacts?.filter(item => item.name.endsWith('.exe'));
  if (receipt?.schemaVersion !== 2 || receipt.product !== DESKTOP_RELEASE.productName || receipt.appId !== DESKTOP_RELEASE.productionAppId
    || receipt.target !== windows.key || receipt.platform !== windows.distributionPlatform || receipt.architecture !== 'x64'
    || receipt.channel !== 'preview' || receipt.updateBaseUrl !== windows.updateBaseUrl || !isNumericVersion(receipt.version)
    || !/^[a-f0-9]{40}$/.test(receipt.sourceCommit ?? '') || !/^\d+$/.test(String(receipt.candidateWorkflowRunId ?? ''))
    || !/^\d+$/.test(String(receipt.candidateWorkflowRunAttempt ?? ''))
    || receipt.signing?.mode !== 'azure-artifact-signing' || receipt.signing.endpoint !== DESKTOP_RELEASE.artifactSigningEndpoint
    || receipt.signing.accountName !== DESKTOP_RELEASE.artifactSigningAccountName || !receipt.signing.publisherName || !receipt.signing.certificateProfileName
    || artifacts?.length !== 1 || artifacts[0].name !== installerName || artifacts[0].sha256 !== installerSha256) throw new Error('First-install candidate identity does not match the sealed Windows Preview installer.');
  const o = observations;
  if (o?.schema !== 'windows-first-install-observations/v1' || o.sourceCommit !== receipt.sourceCommit || o.version !== receipt.version
    || String(o.workflowRunId) !== String(receipt.candidateWorkflowRunId) || String(o.workflowRunAttempt) !== String(receipt.candidateWorkflowRunAttempt)
    || o.installerSha256 !== installerSha256 || o.host?.platform !== 'win32' || o.host.architecture !== 'x64'
    || o.freshProfile?.emptyBeforeInstall !== true || o.freshProfile.ordinaryUser !== true || !o.freshProfile.path
    || o.environment?.externalNodeOnPath !== false || o.environment.developmentOverrides?.length !== 0) throw new Error('First-install environment or source observations are incomplete.');
  const signed = new Map(o.signatures?.map(item => [item.role, item]) ?? []);
  for (const role of ['installer', 'electron', 'app-server', 'graph-server', 'node']) {
    const item = signed.get(role);
    if (item?.status !== 'Valid' || item.subject !== receipt.signing.publisherName || !item.timestampThumbprint || !item.thumbprint || !/^[a-f0-9]{64}$/.test(item.sha256 ?? '')) throw new Error(`Missing exact-publisher timestamped signature: ${role}`);
    if (role === 'installer' && item.sha256 !== installerSha256) throw new Error('Installer signature observation hashes a different file.');
  }
  if (o.runtime?.nodeVersion !== '22.23.2' || o.runtime.appOwnedNodeExecuted !== true || o.runtime.unicodeStdinPreserved !== true
    || !Array.isArray(o.runtime.crtLoadedModules) || !['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'].every(name => o.runtime.crtLoadedModules.some(item => item.name.toLowerCase() === name && item.fromAppDirectory === true))) throw new Error('App-owned executable or actual app-local CRT loading is unqualified.');
  const live = o.live, reopen = o.reopen;
  if (live?.provider !== 'openrouter' || !live.model || live.prompt !== 'Why the sky is blue?' || live.lifecycle !== 'succeeded'
    || !Number.isSafeInteger(live.interactionNodeId) || live.interactionNodeId <= 0 || !Number.isSafeInteger(live.finalLayerId) || live.finalLayerId <= 0
    || live.currentLayerId !== live.finalLayerId || live.visibleGraph !== true || live.navigationWorked !== true) throw new Error('Live graph acceptance is not qualified.');
  if (reopen?.cleanShutdown !== true || reopen.sameProfile !== true || reopen.interactionNodeId !== live.interactionNodeId
    || reopen.finalLayerId !== live.finalLayerId || reopen.visibleGraph !== true || reopen.followupLifecycle !== 'succeeded'
    || !Number.isSafeInteger(reopen.followupInteractionNodeId) || reopen.followupInteractionNodeId === live.interactionNodeId) throw new Error('Installed-app reopen and follow-up are not qualified.');
  for (const name of ['installed-launch', 'accepted-graph', 'reopened-graph', 'video', 'runtime', 'metadata', 'preflight', 'persistence', 'reopen-persistence', 'followup-persistence', 'installer-payload', 'live-authoring-runtime', 'shutdown-processes']) {
    if (!o.evidence?.some(item => item.role === name && /^[a-f0-9]{64}$/.test(item.sha256 ?? ''))) throw new Error(`Missing first-install evidence: ${name}`);
  }
  return { schema: 'windows-first-install/v1', result: 'passed', scope: 'signed installer first install, live graph and reopen; no updater or publication claim',
    sourceCommit: receipt.sourceCommit, version: receipt.version, workflowRunId: String(receipt.candidateWorkflowRunId), workflowRunAttempt: String(receipt.candidateWorkflowRunAttempt),
    installer: { name: installerName, sha256: installerSha256 }, host: o.host, signatures: o.signatures, live, reopen, evidence: o.evidence };
}
export async function createWindowsFirstInstallEvidence({ releaseReceiptPath, installerPath, observationsPath, outputPath }) {
  const [receiptBytes, installer, observationBytes] = await Promise.all([readFile(releaseReceiptPath), readFile(installerPath), readFile(observationsPath)]);
  const observations = JSON.parse(observationBytes);
  // Never trust a checkbox or an asserted evidence digest alone: hash each retained file.
  for (const item of observations.evidence ?? []) if (sha(await readFile(item.path)) !== item.sha256) throw new Error(`First-install evidence file changed: ${item.role}`);
  const receipt = JSON.parse(receiptBytes);
  const record = async role => {
    const evidence = observations.evidence?.filter(item => item.role === role);
    if (evidence?.length !== 1) throw new Error(`Exactly one collected record required: ${role}`);
    return JSON.parse(await readFile(evidence[0].path, 'utf8'));
  };
  const [preflight, metadata, runtime, liveState, reopenedState, followupState, payload, authoring, shutdown] = await Promise.all(['preflight', 'metadata', 'runtime', 'persistence', 'reopen-persistence', 'followup-persistence', 'installer-payload', 'live-authoring-runtime', 'shutdown-processes'].map(record));
  if (preflight.schema !== 'windows-first-install-preflight/v1' || preflight.emptyBeforeInstall !== true || preflight.sourceCommit !== receipt.sourceCommit
    || preflight.version !== receipt.version || preflight.freshProfile !== observations.freshProfile?.path
    || String(preflight.workflowRunId) !== String(receipt.candidateWorkflowRunId) || String(preflight.workflowRunAttempt) !== String(receipt.candidateWorkflowRunAttempt)) throw new Error('Collected fresh-install preflight is not bound to the candidate.');
  if (metadata.schema !== 'windows-installed-metadata/v1' || metadata.sourceCommit !== receipt.sourceCommit || metadata.version !== receipt.version
    || metadata.target !== 'windows-x64' || metadata.channel !== 'preview' || metadata.artifactMode !== 'release') throw new Error('Installed package metadata is not bound to the candidate.');
  if (payload.schema !== 'windows-installer-payload/v2' || windowsPath(payload.installedRoot) !== windowsPath(win32.dirname(runtime.installedExecutable ?? '')) || payload.installerSha256 !== sha(installer)
    || JSON.stringify(payload.metadata) !== JSON.stringify(metadata) || !Array.isArray(payload.files) || !payload.files.length
    || payload.files.some(file => !/^[a-f0-9]{64}$/.test(file.candidateSha256 ?? '') || file.candidateSha256 !== file.installedSha256)) throw new Error('Installed files are not bound to the exact installer payload.');
  const signedPaths = { electron: 'Relayer.exe', node: 'resources/node/node.exe', 'app-server': 'resources/bin/relayer-app-server.exe', 'graph-server': 'resources/bin/relayer-graph-server.exe' };
  for (const [role, path] of Object.entries(signedPaths)) {
    const files = payload.files.filter(file => file.path === path), signatures = observations.signatures?.filter(item => item.role === role);
    if (files.length !== 1 || signatures?.length !== 1 || files[0].installedSha256 !== signatures[0].sha256) throw new Error(`Signed file is not the installed candidate payload: ${role}`);
  }
  if (runtime.schema !== 'windows-first-install-runtime/v1' || runtime.sourceCommit !== receipt.sourceCommit || runtime.version !== receipt.version
    || runtime.nodeVersion !== `v${observations.runtime?.nodeVersion}` || runtime.unicodeStdinPreserved !== true
    || JSON.stringify(runtime.crtLoadedModules) !== JSON.stringify(observations.runtime?.crtLoadedModules)
    || JSON.stringify(runtime.signatures) !== JSON.stringify(observations.signatures)) throw new Error('Collected installed runtime differs from observations.');
  validateCollectedWindowsInstallEnvironment(preflight, runtime);
  const expectedUserProfile = windowsPath(runtime.identity.userProfile);
  const providerHome = windowsPath(authoring.providerHome), rollout = windowsPath(authoring.rolloutPath);
  const defaultHome = windowsPath(win32.join(runtime.identity.userProfile, '.codex'));
  const legacyHome = windowsPath(win32.join(runtime.freshProfile, 'codex-home'));
  const providerRoot = windowsPath(win32.join(runtime.freshProfile, 'provider-runtimes'));
  const providerRelative = providerHome && win32.relative(providerRoot, providerHome).split(win32.sep);
  const supportedHome = authoring.providerHomeKind === 'codex-default' && providerHome === defaultHome
    || authoring.providerHomeKind === 'codex-legacy' && providerHome === legacyHome
    || authoring.providerHomeKind === 'codex-provider' && providerRelative?.length === 2 && /^[a-z0-9][a-z0-9._-]*$/i.test(providerRelative[0]) && providerRelative[0] !== '..' && providerRelative[1] === 'codex-home';
  if (authoring.userSid !== runtime.identity.sid || windowsPath(authoring.userProfile) !== expectedUserProfile
    || authoring.installedRuntimeSha256 !== observations.evidence.find(item => item.role === 'runtime').sha256 || !supportedHome || !rollout
    || !rollout.startsWith(`${win32.join(providerHome, 'sessions')}\\`)) throw new Error('Live authoring belongs to a different Windows user or unsupported provider home.');
  const expectedNode = win32.resolve(win32.dirname(runtime.installedExecutable ?? ''), 'resources/node/node.exe').toLowerCase();
  if (authoring.schema !== 'windows-live-authoring-runtime/v2' || authoring.interactionNodeId !== observations.live?.interactionNodeId || authoring.finalLayerId !== observations.live?.finalLayerId || authoring.exitCode !== 0
    || authoring.submission?.nodeId !== authoring.interactionNodeId || authoring.submission?.rootLayerId !== authoring.finalLayerId
    || !Number.isSafeInteger(authoring.submission?.rootActionId) || authoring.submission.rootActionId <= 0 || !/^[a-f0-9]{64}$/.test(authoring.submission?.resultSha256 ?? '') || authoring.parserVersion !== '5.9.3'
    || typeof authoring.nodePath !== 'string' || win32.resolve(authoring.nodePath).toLowerCase() !== expectedNode
    || typeof authoring.userDataDirectory !== 'string' || win32.resolve(authoring.userDataDirectory).toLowerCase() !== win32.resolve(observations.freshProfile.path).toLowerCase()
    || !/^[a-f0-9]{64}$/.test(authoring.commandSha256 ?? '') || !/^[a-f0-9]{64}$/.test(authoring.rolloutSha256 ?? '') || !authoring.callId
    || !(Date.parse(runtime.at) <= Date.parse(authoring.observedAt) && Date.parse(authoring.observedAt) <= Date.parse(liveState.observedAt))) throw new Error('Live authoring did not use the installed app-owned runtime.');
  const runtimeSha256 = observations.evidence.find(item => item.role === 'runtime').sha256;
  const generations = [liveState.processGeneration, reopenedState.processGeneration, followupState.processGeneration];
  for (const generation of generations) validateWindowsInstallProcesses(generation, runtime, runtimeSha256, 'running');
  validateWindowsInstallProcesses(shutdown, runtime, runtimeSha256, 'stopped');
  if (!(Date.parse(liveState.observedAt) < Date.parse(shutdown.observedAt) && Date.parse(shutdown.observedAt) < Date.parse(reopenedState.processGeneration.observedAt))) throw new Error('Actual stopped checkpoint does not separate the app generations.');
  for (const previous of generations[0].processes) {
    const reopened = generations[1].processes.find(item => item.role === previous.role), followup = generations[2].processes.find(item => item.role === previous.role);
    if (reopened.pid === previous.pid && reopened.createdAt === previous.createdAt || !(Date.parse(shutdown.observedAt) < Date.parse(reopened.createdAt)) || reopened.pid !== followup.pid || reopened.createdAt !== followup.createdAt) throw new Error('Reopen and follow-up are not from one new actual app generation.');
  }
  for (const state of [liveState, reopenedState, followupState]) {
    const interaction = state.interaction;
    if (!interaction || interaction.graphNodeId !== state.interaction_node_id || !Number.isSafeInteger(interaction.interactionId) || interaction.interactionId <= 0 || !Number.isSafeInteger(interaction.threadId) || interaction.threadId <= 0
      || interaction.completionStatus !== 'accepted' || interaction.attemptOutcome !== 'accepted' || interaction.providerId !== interaction.attemptProviderId || interaction.modelId !== interaction.attemptModelId || interaction.adapterId !== interaction.definitionAdapterId
      || windowsPath(state.productDatabasePath) !== windowsPath(win32.join(runtime.freshProfile, 'product-data/product.sqlite3')) || !(Date.parse(state.processGeneration.observedAt) <= Date.parse(state.observedAt))) throw new Error('Actual persisted product interaction or process generation is unbound.');
  }
  if (liveState.interaction.providerKind !== observations.live.provider || liveState.interaction.modelId !== observations.live.model || liveState.interaction.prompt !== observations.live.prompt
    || JSON.stringify(liveState.interaction) !== JSON.stringify(reopenedState.interaction) || followupState.interaction.threadId !== liveState.interaction.threadId) throw new Error('Persisted interaction provider, model, prompt or reopened identity differs from the required scenario.');
  const expectedDatabase = win32.resolve(observations.freshProfile?.path ?? '', 'graphcomplete-runtime', 'graph.sqlite3').toLowerCase();
  for (const state of [liveState, reopenedState, followupState]) {
    if (typeof state.databasePath !== 'string' || win32.resolve(state.databasePath).toLowerCase() !== expectedDatabase) throw new Error('Collected completion belongs to a different Windows profile.');
  }
  for (const state of [liveState, reopenedState]) {
    if (state.schema !== 'windows-installed-completion/v2' || state.interaction_node_id !== observations.live?.interactionNodeId || state.lifecycle !== 'succeeded'
      || state.final_layer_id !== observations.live?.finalLayerId || state.current_layer_id !== state.final_layer_id) throw new Error('Collected persisted completion is not the accepted live graph.');
  }
  if (followupState.schema !== 'windows-installed-completion/v2' || followupState.lifecycle !== 'succeeded' || followupState.interaction_node_id !== observations.reopen?.followupInteractionNodeId || !Number.isSafeInteger(followupState.final_layer_id) || followupState.final_layer_id <= 0 || followupState.current_layer_id !== followupState.final_layer_id) throw new Error('Collected follow-up completion is not accepted.');
  if (!(Date.parse(reopenedState.observedAt) < Date.parse(followupState.observedAt))) throw new Error('Follow-up was not observed after reopening.');
  if (!(Date.parse(preflight.at) < Date.parse(runtime.at) && Date.parse(runtime.at) <= Date.parse(liveState.observedAt) && Date.parse(liveState.observedAt) < Date.parse(reopenedState.observedAt))) throw new Error('First-install observation chronology is incomplete.');
  const result = validateWindowsFirstInstall({ receipt, installerName: basename(installerPath), installerSha256: sha(installer), observations });
  result.releaseReceiptSha256 = sha(receiptBytes); result.observationsSha256 = sha(observationBytes);
  await writeFile(outputPath, JSON.stringify(result, null, 2), { flag: 'wx' }); return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [releaseReceiptPath, installerPath, observationsPath, outputPath] = process.argv.slice(2);
  console.log(JSON.stringify(await createWindowsFirstInstallEvidence({ releaseReceiptPath, installerPath, observationsPath, outputPath })));
}
