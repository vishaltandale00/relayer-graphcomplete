import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DESKTOP_RELEASE, desktopReleaseTarget } from './contract.mjs';
import { isNumericVersion } from './numeric-version.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const windows = desktopReleaseTarget('windows-x64');
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
  const expectedNode = win32.resolve(win32.dirname(runtime.installedExecutable ?? ''), 'resources/node/node.exe').toLowerCase();
  if (authoring.schema !== 'windows-live-authoring-runtime/v1' || authoring.interactionNodeId !== observations.live?.interactionNodeId || authoring.exitCode !== 0
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
