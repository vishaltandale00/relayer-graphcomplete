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
    || appDirectory !== windowsPath(win32.dirname(runtime.installedExecutable)) || !Array.isArray(installation.directories)
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
  for (const name of ['installed-launch', 'accepted-graph', 'reopened-graph', 'video', 'runtime', 'metadata', 'preflight', 'persistence', 'reopen-persistence', 'followup-persistence', 'installer-payload', 'live-authoring-runtime']) {
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
  const [preflight, metadata, runtime, liveState, reopenedState, followupState, payload, authoring] = await Promise.all(['preflight', 'metadata', 'runtime', 'persistence', 'reopen-persistence', 'followup-persistence', 'installer-payload', 'live-authoring-runtime'].map(record));
  if (preflight.schema !== 'windows-first-install-preflight/v1' || preflight.emptyBeforeInstall !== true || preflight.sourceCommit !== receipt.sourceCommit
    || preflight.version !== receipt.version || preflight.freshProfile !== observations.freshProfile?.path
    || String(preflight.workflowRunId) !== String(receipt.candidateWorkflowRunId) || String(preflight.workflowRunAttempt) !== String(receipt.candidateWorkflowRunAttempt)) throw new Error('Collected fresh-install preflight is not bound to the candidate.');
  if (metadata.schema !== 'windows-installed-metadata/v1' || metadata.sourceCommit !== receipt.sourceCommit || metadata.version !== receipt.version
    || metadata.target !== 'windows-x64' || metadata.channel !== 'preview' || metadata.artifactMode !== 'release') throw new Error('Installed package metadata is not bound to the candidate.');
  if (payload.schema !== 'windows-installer-payload/v1' || payload.installerSha256 !== sha(installer)
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
  const expectedDatabase = win32.resolve(observations.freshProfile?.path ?? '', 'graphcomplete-runtime', 'graph.sqlite3').toLowerCase();
  for (const state of [liveState, reopenedState, followupState]) {
    if (typeof state.databasePath !== 'string' || win32.resolve(state.databasePath).toLowerCase() !== expectedDatabase) throw new Error('Collected completion belongs to a different Windows profile.');
  }
  for (const state of [liveState, reopenedState]) {
    if (state.schema !== 'windows-installed-completion/v1' || state.interaction_node_id !== observations.live?.interactionNodeId || state.lifecycle !== 'succeeded'
      || state.final_layer_id !== observations.live?.finalLayerId || state.current_layer_id !== state.final_layer_id) throw new Error('Collected persisted completion is not the accepted live graph.');
  }
  if (followupState.schema !== 'windows-installed-completion/v1' || followupState.lifecycle !== 'succeeded' || followupState.interaction_node_id !== observations.reopen?.followupInteractionNodeId || !Number.isSafeInteger(followupState.final_layer_id) || followupState.final_layer_id <= 0 || followupState.current_layer_id !== followupState.final_layer_id) throw new Error('Collected follow-up completion is not accepted.');
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
