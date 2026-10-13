/** Seed pre-policy history only; preserve the production accepted-action guard. */
export function restoreHistoricalInvokePolicy(database, actionId) {
  const trigger = database.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='accepted_invoke_reuse_immutable'").get()?.sql;
  if (!trigger) throw new Error("Historical fixture requires the accepted Invoke policy guard");
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec("DROP TRIGGER accepted_invoke_reuse_immutable");
    const changed = database.prepare("UPDATE actions SET reusable=NULL WHERE id=? AND kind='invoke'").run(actionId);
    if (changed.changes !== 1) throw new Error("Historical fixture must identify exactly one Invoke");
    database.exec(trigger);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
