import { describe, expect, it, vi } from "vitest";
import { fail, ok, type AppError, type Result } from "@/lib/errors";
import { withRetry } from "@/lib/retry";

const error = (retryable: boolean, code = retryable ? "UNAVAILABLE" : "VALIDATION"): AppError => ({
  code,
  messageKey: retryable ? "UNAVAILABLE" : "VALIDATION",
  detail: "test",
  retryable,
});

/** An operation that returns the given results in order (the last one repeats). */
function sequence<T>(...results: Result<T>[]) {
  let i = 0;
  return vi.fn(async () => results[Math.min(i++, results.length - 1)]!);
}

function harness(random = () => 0) {
  const delays: number[] = [];
  const sleep = vi.fn(async (ms: number) => {
    delays.push(ms);
  });
  return { delays, sleep, random };
}

describe("withRetry", () => {
  it("returns the first success without sleeping", async () => {
    const op = sequence(ok(42));
    const h = harness();
    await expect(withRetry(op, h)).resolves.toEqual(ok(42));
    expect(op).toHaveBeenCalledTimes(1);
    expect(h.sleep).not.toHaveBeenCalled();
  });

  it("stops at the first success after retryable failures", async () => {
    const op = sequence<string>(fail(error(true)), fail(error(true)), ok("done"));
    const h = harness();
    await expect(withRetry(op, { ...h, attempts: 5 })).resolves.toEqual(ok("done"));
    expect(op).toHaveBeenCalledTimes(3);
    expect(h.delays).toHaveLength(2);
  });

  it("returns a non-retryable failure immediately", async () => {
    const denied = fail(error(false, "PERMISSION_DENIED"));
    const op = sequence(denied);
    const h = harness();
    await expect(withRetry(op, { ...h, attempts: 5 })).resolves.toEqual(denied);
    expect(op).toHaveBeenCalledTimes(1);
    expect(h.sleep).not.toHaveBeenCalled();
  });

  it("stops when a retry turns into a non-retryable failure", async () => {
    const op = sequence<number>(fail(error(true)), fail(error(false, "INSUFFICIENT_STOCK")), ok(1));
    const h = harness();
    const result = await withRetry(op, { ...h, attempts: 5 });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("INSUFFICIENT_STOCK");
    expect(op).toHaveBeenCalledTimes(2);
  });

  it("gives up after `attempts` tries with exponential delays and no sleep after the last", async () => {
    const last = fail(error(true));
    const op = sequence(last);
    const h = harness(() => 0);
    await expect(withRetry(op, { ...h, attempts: 4, baseDelayMs: 100 })).resolves.toEqual(last);
    expect(op).toHaveBeenCalledTimes(4);
    expect(h.delays).toEqual([100, 200, 400]);
  });

  it("adds jitter of floor(random × base) to each delay", async () => {
    const op = sequence(fail(error(true)));
    const h = harness(() => 0.5);
    await withRetry(op, { ...h, attempts: 3, baseDelayMs: 50 });
    expect(h.delays).toEqual([50 + 25, 100 + 25]);
  });

  it("defaults to 3 attempts and a 100 ms base", async () => {
    const op = sequence(fail(error(true)));
    const h = harness(() => 0);
    await withRetry(op, h);
    expect(op).toHaveBeenCalledTimes(3);
    expect(h.delays).toEqual([100, 200]);
  });

  it("with a single attempt never retries", async () => {
    const op = sequence(fail(error(true)));
    const h = harness();
    await withRetry(op, { ...h, attempts: 1 });
    expect(op).toHaveBeenCalledTimes(1);
    expect(h.sleep).not.toHaveBeenCalled();
  });
});
