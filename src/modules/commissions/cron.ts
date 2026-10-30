/**
 * Result of service.commission_run() as the cron route logs and returns it.
 * Malformed fields become empty, so a changed payload never crashes the route.
 *   closed      months frozen in this run (their close date, perf.period_close_at, passed)
 *   calculated  open months recalculated, oldest first
 *   changed     how many of them changed
 */
export interface CommissionRunSummary {
  closed: string[];
  calculated: string[];
  changed: number;
}

const months = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((m): m is string => typeof m === "string" && /^\d{4}-\d{2}$/.test(m)) : [];

export function parseCommissionRun(data: unknown): CommissionRunSummary {
  const o = typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const changed = typeof o.changed === "number" && Number.isInteger(o.changed) && o.changed >= 0 ? o.changed : 0;
  return { closed: months(o.closed), calculated: months(o.calculated), changed };
}
