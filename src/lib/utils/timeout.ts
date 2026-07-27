/**
 * Bound for a single LLM call (including the SDK's internal retries). Every
 * external scraper already runs under withTimeout/fetchWithTimeout; without
 * this, a stalled model call was the one unbounded await left inside tools —
 * and one stalled tool freezes the whole agent stream.
 */
export const LLM_TIMEOUT_MS = 90_000;

/** Fresh abort signal for one LLM call. Pass as `abortSignal` to the AI SDK. */
export const llmTimeout = () => AbortSignal.timeout(LLM_TIMEOUT_MS);

/**
 * Race a promise against a timer; rejects with a labeled error if `ms` elapses first.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label} timed out after ${ms / 1000}s`)),
        ms,
      ),
    ),
  ]);
}
