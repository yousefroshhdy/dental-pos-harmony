import "server-only";
import { buildHeaders } from "./sign";

/** Row returned by service.outbox_claim(). */
export interface ClaimedEvent {
  id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: unknown;
  attempts: number;
  created_at: string;
  targets: string[];
}

export interface DeliveryResult {
  ok: boolean;
  /** HTTP status, or null when no response arrived (timeout, network error). */
  status: number | null;
  error: string | null;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const DELIVERY_TIMEOUT_MS = 10_000;
export const EVENT_VERSION = 1;

/** Event envelope sent to consumers (docs/API_CONTRACTS.md §5). */
export function buildEnvelope(event: ClaimedEvent) {
  return { id: event.id, type: event.event_type, occurred_at: event.created_at, version: EVENT_VERSION, data: event.payload };
}

/**
 * Mirrors service.outbox_result: 4xx other than 408/429 means the consumer
 * rejected the contract and retrying cannot help.
 */
export function isPermanentStatus(status: number | null): boolean {
  return status !== null && status >= 400 && status <= 499 && status !== 408 && status !== 429;
}

export function classifyResponse(status: number, statusText = ""): DeliveryResult {
  if (status >= 200 && status <= 299) return { ok: true, status, error: null };
  return { ok: false, status, error: statusText.trim() ? statusText.trim().slice(0, 200) : null };
}

/** POST one signed event body to one target. Never throws. */
export async function deliverToTarget(
  target: string,
  rawBody: string,
  headers: Record<string, string>,
  opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<DeliveryResult> {
  const fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const timeoutMs = opts.timeoutMs ?? DELIVERY_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(target, {
      method: "POST",
      headers,
      body: rawBody,
      signal: controller.signal,
      // A signed payload must not follow a redirect to an unvetted host.
      redirect: "manual",
      cache: "no-store",
    });
    // The response body is never read (or stored): release the connection.
    await res.body?.cancel().catch(() => undefined);
    return classifyResponse(res.status, res.statusText);
  } catch (err) {
    if (controller.signal.aborted) {
      return { ok: false, status: null, error: `TIMEOUT: no response within ${Math.round(timeoutMs / 1000)} s` };
    }
    const name = err instanceof Error ? err.name : "Error";
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: null, error: `NETWORK: ${name}: ${message}`.slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One outcome per event across all its targets: ok only when every target
 * accepted it. A retryable failure wins over a permanent one, so a single broken
 * consumer does not stop retries to a healthy one (consumers dedupe on event id).
 */
export function aggregateResults(results: { target: string; result: DeliveryResult }[]): DeliveryResult {
  const failures = results.filter((r) => !r.result.ok);
  if (results.length > 0 && failures.length === 0) return { ok: true, status: results[0]!.result.status, error: null };
  if (failures.length === 0) return { ok: false, status: null, error: "NO_TARGETS" };
  const pick = failures.find((f) => !isPermanentStatus(f.result.status)) ?? failures[0]!;
  const detail = failures
    .map((f) => `${safeHost(f.target)}: ${f.result.status !== null ? `HTTP ${f.result.status}` : ""}${f.result.error ? ` ${f.result.error}` : ""}`.trim())
    .join("; ");
  return { ok: false, status: pick.result.status, error: detail };
}

/** Host only: target paths (e.g. Make.com hook ids) act as credentials and stay out of logs/errors. */
export function safeHost(target: string): string {
  try {
    return new URL(target).host;
  } catch {
    return "invalid-url";
  }
}

/** Deliver one event to all of its targets in parallel with one signed body. */
export async function deliverEvent(
  event: ClaimedEvent,
  secret: string,
  opts: { fetchImpl?: FetchLike; timeoutMs?: number; now?: Date } = {},
): Promise<DeliveryResult> {
  const rawBody = JSON.stringify(buildEnvelope(event));
  const headers = buildHeaders(event, rawBody, secret, opts.now);
  const settled = await Promise.allSettled(event.targets.map((t) => deliverToTarget(t, rawBody, headers, opts)));
  return aggregateResults(
    settled.map((s, i) => ({
      target: event.targets[i]!,
      result: s.status === "fulfilled" ? s.value : { ok: false, status: null, error: "NETWORK: unexpected rejection" },
    })),
  );
}
