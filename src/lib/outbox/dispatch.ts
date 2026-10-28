import "server-only";
import { z } from "zod";
import { log } from "@/lib/log";
import { deliverEvent, safeHost, type ClaimedEvent, type DeliveryResult, type FetchLike } from "./deliver";

/**
 * One dispatcher run (docs/INTEGRATIONS.md §3). Claims in small batches so a
 * consumer outage (every request hitting the 10 s timeout) still finishes well
 * inside the function's 60 s limit instead of leaving rows in_flight until the
 * 10-minute lease recovers them.
 */
export const MAX_EVENTS_PER_RUN = 100;
export const CLAIM_BATCH = 10;
export const CONCURRENCY = 5;
/** No new batch is claimed after this; worst case one batch = 2 rounds × 10 s. */
export const TIME_BUDGET_MS = 25_000;

const claimedRow = z.object({
  id: z.string(),
  event_type: z.string(),
  aggregate_type: z.string(),
  aggregate_id: z.string(),
  payload: z.unknown(),
  attempts: z.number().int(),
  created_at: z.string(),
  targets: z.array(z.string()).min(1),
});

export interface OutboxStore {
  claim(limit: number): Promise<ClaimedEvent[]>;
  report(id: string, result: DeliveryResult): Promise<void>;
}

export interface DispatchSummary {
  claimed: number;
  delivered: number;
  failed: number;
}

export function parseClaimed(data: unknown): ClaimedEvent[] {
  return z.array(claimedRow).parse(data ?? []) as ClaimedEvent[];
}

async function mapPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export async function runDispatch(opts: {
  store: OutboxStore;
  secret: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  clock?: () => number;
  requestId?: string;
}): Promise<DispatchSummary> {
  const clock = opts.clock ?? Date.now;
  const started = clock();
  const summary: DispatchSummary = { claimed: 0, delivered: 0, failed: 0 };

  while (summary.claimed < MAX_EVENTS_PER_RUN && clock() - started < TIME_BUDGET_MS) {
    const batch = await opts.store.claim(Math.min(CLAIM_BATCH, MAX_EVENTS_PER_RUN - summary.claimed));
    summary.claimed += batch.length;

    await mapPool(batch, CONCURRENCY, async (event) => {
      const result = await deliverEvent(event, opts.secret, { fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs });
      if (result.ok) summary.delivered++;
      else {
        summary.failed++;
        log("warn", "outbox.delivery_failed", {
          request_id: opts.requestId,
          event_id: event.id,
          event_type: event.event_type,
          attempt: event.attempts + 1,
          status: result.status,
          targets: event.targets.map(safeHost),
        });
      }
      try {
        await opts.store.report(event.id, result);
      } catch (err) {
        // The row stays in_flight; lease recovery (10 min) makes it due again.
        log("error", "outbox.report_failed", {
          request_id: opts.requestId,
          event_id: event.id,
          error: err instanceof Error ? err.message.slice(0, 300) : "unknown",
        });
      }
    });

    if (batch.length < CLAIM_BATCH) break;   // queue drained
  }
  return summary;
}
