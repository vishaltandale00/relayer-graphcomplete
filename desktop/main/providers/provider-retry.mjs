const RETRYABLE_CODES = new Set(["transport", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN"]);

export function isRetryableProviderError(error) {
  if (error?.name === "AbortError") return false;
  if (error?.status === 429 || (error?.status >= 500 && error?.status <= 599)) return true;
  return RETRYABLE_CODES.has(error?.code);
}

export async function withProviderRetry(operation, {
  signal,
  attempts = 4,
  baseDelayMs = 250,
  maximumDelayMs = 2_000,
  random = Math.random,
  sleep = (delay, sleepSignal) => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, delay);
    const onAbort = () => {
      clearTimeout(timer);
      reject(sleepSignal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    };
    sleepSignal?.addEventListener("abort", onAbort, { once: true });
  }),
} = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    signal?.throwIfAborted();
    try {
      return await operation({ attempt, signal });
    } catch (error) {
      signal?.throwIfAborted();
      if (attempt === attempts || !isRetryableProviderError(error)) throw error;
      const unjittered = Math.min(maximumDelayMs, baseDelayMs * (2 ** (attempt - 1)));
      const delay = Math.round(unjittered * (0.5 + random()));
      await sleep(delay, signal);
    }
  }
  throw new Error("Provider retry exhausted unexpectedly.");
}
