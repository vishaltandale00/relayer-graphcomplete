import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
const execute = promisify(execFile), sha = bytes => createHash('sha256').update(bytes).digest('hex');
const here = dirname(fileURLToPath(import.meta.url));
const generationKey = record => JSON.stringify(record.processes.map(item => [item.role, item.pid, item.createdAt]).sort((a, b) => a[0].localeCompare(b[0])));
async function inspect(runtime, state) {
  if (process.platform !== 'win32') throw new Error('Actual installed-process qualification requires Windows.');
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'collect-windows-install-processes.ps1'), '-InstalledExecutable', runtime.installedExecutable, '-FreshProfile', runtime.freshProfile, '-ExpectedSid', runtime.identity.sid, '-State', state], { maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout.trim());
}
export async function collectWindowsInstallState({ runtimeInspectionPath, interactionNodeId, state = 'running', inspectProcesses = inspect }) {
  if (!['running', 'stopped'].includes(state)) throw new Error('Explicit running or stopped process checkpoint required.');
  const runtimeBytes = await readFile(runtimeInspectionPath), runtime = JSON.parse(runtimeBytes);
  if (runtime.schema !== 'windows-first-install-runtime/v1' || runtime.identity?.ordinaryUser !== true || runtime.identity?.administratorGroupMember !== false || !runtime.identity?.sid || !runtime.installedExecutable || !runtime.freshProfile) throw new Error('Actual installed ordinary-user runtime inspection required.');
  const before = await inspectProcesses(runtime, state);
  if (before.schema !== 'windows-installed-processes/v1' || before.state !== state || before.userSid !== runtime.identity.sid || !Array.isArray(before.processes) || (state === 'stopped' ? before.processes.length !== 0 : before.processes.length !== 3)) throw new Error('Actual candidate process checkpoint is incomplete.');
  before.installedRuntimeSha256 = sha(runtimeBytes);
  if (state === 'stopped') return before;
  if (!Number.isSafeInteger(interactionNodeId) || interactionNodeId <= 0) throw new Error('Explicit observed interaction ID required.');
  const databasePath = await realpath(join(runtime.freshProfile, 'graphcomplete-runtime/graph.sqlite3'));
  const productDatabasePath = await realpath(join(runtime.freshProfile, 'product-data/product.sqlite3'));
  const graph = new DatabaseSync(databasePath, { readOnly: true });
  let product;
  try {
    product = new DatabaseSync(productDatabasePath, { readOnly: true });
    const completion = graph.prepare('SELECT interaction_node_id,lifecycle,head_revision,current_layer_id,final_layer_id FROM completion_states WHERE interaction_node_id=?').get(interactionNodeId);
    const rows = product.prepare(`SELECT i.id AS interactionId,i.thread_id AS threadId,i.graph_node_id AS graphNodeId,i.text AS prompt,i.completion_status AS completionStatus,i.model_provider_id AS providerId,i.provider_model_id AS modelId,a.adapter_id AS adapterId,a.provider_id AS attemptProviderId,a.model_id AS attemptModelId,a.outcome AS attemptOutcome,p.adapter_id AS definitionAdapterId,p.endpoint AS definitionEndpoint FROM interactions i JOIN model_providers p ON p.id=i.model_provider_id JOIN interaction_attempts a ON a.id=(SELECT latest.id FROM interaction_attempts latest WHERE latest.interaction_id=i.id ORDER BY latest.attempt_number DESC LIMIT 1) WHERE i.graph_node_id=?`).all(interactionNodeId);
    if (!completion || rows.length !== 1) throw new Error('One actual product interaction and graph completion must match the observed node.');
    const { definitionEndpoint, ...interaction } = rows[0];
    interaction.providerKind = ['openrouter', 'openai-api'].includes(interaction.definitionAdapterId) && typeof definitionEndpoint === 'string' && definitionEndpoint.replace(/\/+$/, '') === 'https://openrouter.ai/api/v1' ? 'openrouter' : 'other';
    if (interaction.completionStatus !== 'accepted' || interaction.attemptOutcome !== 'accepted' || interaction.adapterId !== interaction.definitionAdapterId || interaction.providerId !== interaction.attemptProviderId || interaction.modelId !== interaction.attemptModelId) throw new Error('Persisted interaction and accepted execution attempt disagree.');
    const after = await inspectProcesses(runtime, 'running');
    if (generationKey(before) !== generationKey(after)) throw new Error('Candidate app generation changed during persisted-state collection.');
    after.installedRuntimeSha256 = sha(runtimeBytes);
    return { schema: 'windows-installed-completion/v2', observedAt: new Date().toISOString(), databasePath, productDatabasePath, processGeneration: after, interaction, ...completion };
  } finally { graph.close(); product?.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [runtimeInspectionPath, id, outputPath] = process.argv.slice(2);
  await writeFile(outputPath, JSON.stringify(await collectWindowsInstallState({ runtimeInspectionPath, interactionNodeId: Number(id), state: id === '--stopped' ? 'stopped' : 'running' }), null, 2), { flag: 'wx' });
}
