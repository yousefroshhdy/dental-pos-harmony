import type { Result } from "./errors";

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Retries an operation while it fails with a retryable error (serialization
 * failure, deadlock, network). Exponential backoff with jitter.
 * Non-retryable failures return immediately.
 */
export async function withRetry<T>(op: () => Promise<Result<T>>, opts: RetryOptions = {}): Promise<Result<T>> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseDelayMs ?? 100;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;

  let last: Result<T> | undefined;
  for (let attempt = 0; attempt < attempts; attempt++) {
    last = await op();
    if (last.ok || !last.error.retryable) return last;
    if (attempt < attempts - 1) await sleep(base * 2 ** attempt + Math.floor(random() * base));
  }
  return last as Result<T>;
}
