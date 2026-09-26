export async function runEvidenceCleanup(steps) {
  const failures = [];
  for (const step of steps) {
    try { await step(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "Evidence service cleanup failed");
}
