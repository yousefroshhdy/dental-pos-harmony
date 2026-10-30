/**
 * Result of service.finance_overdue_scan() as the cron route logs and returns it.
 * Unknown or malformed fields become 0, so a changed payload never crashes the route.
 *   created   collection tasks opened for newly overdue invoices
 *   reopened  tasks closed or marked collected while their invoice is still open and overdue
 */
export interface OverdueScanSummary {
  business_date: string | null;
  scanned: number;
  created: number;
  unassigned: number;
  reopened: number;
}

const count = (value: unknown): number => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0);

export function parseOverdueScan(data: unknown): OverdueScanSummary {
  const o = typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  return {
    business_date: typeof o.business_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(o.business_date) ? o.business_date : null,
    scanned: count(o.scanned),
    created: count(o.created),
    unassigned: count(o.unassigned),
    reopened: count(o.reopened),
  };
}
