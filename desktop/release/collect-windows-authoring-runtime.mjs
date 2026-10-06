import { createHash } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
function successfulNativeOutput(output) {
  const header = String(output).split(/\r?\nFinal output:/i)[0];
  const statuses = [...header.matchAll(/^(?:Process exited with code|Exit code:)\s*(-?\d+)\s*$/gim)];
  return statuses.length === 1 && Number(statuses[0][1]) === 0;
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export async function collectWindowsAuthoringRuntime({ rolloutPath, userDataDirectory, installedExecutable, interactionNodeId, notBefore }) {
  const [rollout, profile] = await Promise.all([realpath(rolloutPath), realpath(userDataDirectory)]);
  const within = relative(profile, rollout);
  if (within.startsWith('..') || isAbsolute(within)) throw new Error('Live authoring rollout is outside the installed profile.');
  if (!Number.isSafeInteger(interactionNodeId) || interactionNodeId <= 0 || !Number.isFinite(Date.parse(notBefore))) throw new Error('Explicit interaction and launch timestamp required.');
  const nodePath = join(dirname(await realpath(installedExecutable)), 'resources/node/node.exe');
  const bytes = await readFile(rollout), rows = bytes.toString('utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const expected = nodePath.replaceAll('\\', '/').toLowerCase();
  const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const literal = `(?:'${escaped.replaceAll("'", "''")}'|"${escaped}")`;
  const invocation = new RegExp(`(?:^|[|;\\n]\\s*)(?:&\\s*)${literal}\\s+--input-type=module\\b`, 'i');
  for (const row of rows) {
    const call = row.payload;
    if (row.type !== 'response_item' || call?.type !== 'function_call' || Date.parse(row.timestamp) < Date.parse(notBefore)) continue;
    let args; try { args = JSON.parse(call.arguments); } catch { continue; }
    const command = args.cmd ?? args.command;
    if (typeof command !== 'string' || !invocation.test(command.replaceAll('\\', '/'))) continue;
    const completed = rows.find(item => item.type === 'response_item' && item.payload?.type === 'function_call_output' && item.payload.call_id === call.call_id
      && successfulNativeOutput(item.payload.output));
    if (!completed) continue;
    return { schema: 'windows-live-authoring-runtime/v1', interactionNodeId, userDataDirectory: profile, nodePath,
      observedAt: completed.timestamp, callId: call.call_id, commandSha256: sha(command), rolloutPath: rollout, rolloutSha256: sha(bytes), exitCode: 0 };
  }
  throw new Error('No successful app-owned Node authoring command in this installed-profile rollout.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [rolloutPath, userDataDirectory, installedExecutable, id, notBefore, output] = process.argv.slice(2);
  await writeFile(output, JSON.stringify(await collectWindowsAuthoringRuntime({ rolloutPath, userDataDirectory, installedExecutable, interactionNodeId: Number(id), notBefore }), null, 2), { flag: 'wx' });
}
