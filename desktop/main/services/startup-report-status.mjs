// In-memory attribution only. Never attach raw exceptions or identifiers to records.
const outcomes = new WeakMap();

export function trackStartupErrorReport(error, report) {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) return;
  outcomes.set(error, Promise.resolve(report).then((result) => result?.accepted === true, () => false));
}

export async function startupErrorAlreadyReported(error) {
  const seen = new Set();
  const pending = [error];
  const reports = [];
  // Cleanup may wrap a child failure in AggregateError. Inspect a bounded closure.
  while (pending.length && seen.size < 8) {
    const current = pending.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    const report = outcomes.get(current);
    if (report) reports.push(report);
    try {
      if (current.cause) pending.push(current.cause);
      if (Array.isArray(current.errors)) pending.push(...current.errors.slice(0, 8));
    } catch {}
  }
  return (await Promise.all(reports)).some(Boolean);
}
