/**
 * Result of service.workflow_escalate() as the cron route logs and returns it.
 * Unknown or malformed fields become 0, so a changed payload never crashes the route.
 *   scanned         pending requests past their stage's escalate_after (this run's batch)
 *   escalated       new escalation levels recorded
 *   notified        in-app notices sent to newly reached people
 *   owner_fallback  escalations that went to the owners (no fallback or manager found)
 *   no_target       escalations with nobody to reach (recorded, nothing sent)
 */
export interface EscalationRunSummary {
  scanned: number;
  escalated: number;
  notified: number;
  owner_fallback: number;
  no_target: number;
}

const count = (value: unknown): number => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0);

export function parseEscalationRun(data: unknown): EscalationRunSummary {
  const o = typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  return {
    scanned: count(o.scanned),
    escalated: count(o.escalated),
    notified: count(o.notified),
    owner_fallback: count(o.owner_fallback),
    no_target: count(o.no_target),
  };
}

/** Batch size per run; the DB clamps it to 1..2000 as well. */
export const ESCALATION_BATCH = 200;
