// Read/preparation callbacks may not implement AbortSignal. Stop waiting on them,
// while callers check the signal before publishing evidence or dispatching writes.
export function abortable(signal, operation) {
  signal?.throwIfAborted();
  if (!signal) return operation();
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); })
      .then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}
