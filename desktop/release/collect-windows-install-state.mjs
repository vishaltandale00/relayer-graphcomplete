import { DatabaseSync } from 'node:sqlite';
import { realpath, writeFile } from 'node:fs/promises';
const [databasePath, id, outputPath] = process.argv.slice(2);
const interactionNodeId = Number(id);
if (!Number.isSafeInteger(interactionNodeId) || interactionNodeId <= 0) throw new Error('Explicit fixture interaction ID required.');
const resolvedDatabasePath = await realpath(databasePath);
const db = new DatabaseSync(resolvedDatabasePath, { readOnly: true });
try {
  const row = db.prepare('SELECT interaction_node_id,lifecycle,head_revision,current_layer_id,final_layer_id FROM completion_states WHERE interaction_node_id=?').get(interactionNodeId);
  if (!row) throw new Error('Fixture completion state is absent.');
  await writeFile(outputPath, JSON.stringify({ schema: 'windows-installed-completion/v1', observedAt: new Date().toISOString(), databasePath: resolvedDatabasePath, ...row }, null, 2), { flag: 'wx' });
} finally { db.close(); }
