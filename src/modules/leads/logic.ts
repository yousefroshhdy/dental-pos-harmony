import type { AppError } from "@/lib/errors";
import type { PlaceDetails } from "@/lib/places/requests";
import {
  LEADS_ERROR_CODES,
  type JobOutcome,
  type LeadFilter,
  type LeadRow,
  type LeadsActionResult,
  type LeadsErrorCode,
  type LeadStatus,
  type ManualLeadStatus,
} from "./types";

/** Pure helpers for the leads screens (unit-tested). */

export const LEADS_PAGE_SIZE = 10;

export function isLeadsErrorCode(code: string): code is LeadsErrorCode {
  return (LEADS_ERROR_CODES as readonly string[]).includes(code);
}

export function toLeadsFailure(error: AppError): LeadsActionResult {
  return {
    ok: false,
    messageKey: error.messageKey,
    ...(isLeadsErrorCode(error.code) ? { leadsCode: error.code } : {}),
    requestId: error.requestId,
  };
}

/** Statuses a person may move a lead to from its current one (UX only; the database decides). */
export function nextManualStatuses(status: LeadStatus): ManualLeadStatus[] {
  switch (status) {
    case "new":
      return ["visited", "not_interested"];
    case "visited":
      return ["new", "not_interested"];
    case "not_interested":
      return ["new"];
    default:
      return [];
  }
}

/** A lead can be planned, visited for the first time or reassigned only before it is in the CRM. */
export function isOpen(status: LeadStatus): boolean {
  return status === "new" || status === "visited" || status === "not_interested";
}

/** PostgREST filter for a list filter: [column, operator, value] pairs. */
export function filterConditions(filter: LeadFilter, today: string): { column: string; op: "in" | "eq"; value: string | string[] }[] {
  switch (filter) {
    case "open":
      return [{ column: "status", op: "in", value: ["new", "visited"] }];
    case "planned":
      return [{ column: "planned_for", op: "eq", value: today }];
    case "not_interested":
      return [{ column: "status", op: "eq", value: "not_interested" }];
    case "converted":
      return [{ column: "status", op: "in", value: ["prospect", "customer"] }];
    default:
      return [];
  }
}

/** "850 m" / "1.2 km" input for the formatter: null when the distance is not known. */
export function distanceParts(distance: number | string | null | undefined): { value: number; unit: "m" | "km" } | null {
  if (distance === null || distance === undefined || distance === "") return null;
  const m = Number(distance);
  if (!Number.isFinite(m) || m < 0) return null;
  return m < 1000 ? { value: Math.round(m / 10) * 10, unit: "m" } : { value: Math.round(m / 100) / 10, unit: "km" };
}

export function percent(v: number | string | null | undefined): string {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  return Number.isFinite(n) ? `${n.toFixed(1).replace(/\.0$/, "")}%` : "—";
}

/** How many live details to load for a page: the rows without a CRM customer name. */
export function placeIdsNeedingDetails(rows: readonly Pick<LeadRow, "place_id" | "customer_name">[]): string[] {
  return [...new Set(rows.filter((r) => !r.customer_name).map((r) => r.place_id))];
}

/** Live details state for the page (never stored). */
export type DetailsState =
  | { status: "not_configured" }
  | { status: "budget_reached"; details: Map<string, PlaceDetails | null> }
  | { status: "ok"; details: Map<string, PlaceDetails | null> }
  | { status: "error" };

/** The text shown for a lead: the CRM name once converted, else Google's live name, else null. */
export function leadTitle(row: Pick<LeadRow, "customer_name" | "place_id">, details: PlaceDetails | null | undefined): string | null {
  return row.customer_name ?? details?.name ?? null;
}

/** Third-party attributions shown under a list (unique by provider). */
export function collectAttributions(details: Iterable<PlaceDetails | null>): { provider: string; providerUri: string | null }[] {
  const seen = new Map<string, string | null>();
  for (const d of details) for (const a of d?.attributions ?? []) if (!seen.has(a.provider)) seen.set(a.provider, a.providerUri);
  return [...seen.entries()].map(([provider, providerUri]) => ({ provider, providerUri }));
}

/** Parse service.leads_claim_run / leads_finish_run answers into a job outcome. */
export function parseClaim(data: unknown):
  | { status: "none" }
  | { status: "cancelled" | "not_configured"; runId: string }
  | { status: "refused"; runId: string; reason: "daily_cap" | "monthly_budget" }
  | { status: "claimed"; runId: string; center: { lat: number; lng: number }; radiusM: number; maxRequests: number }
  | { status: "invalid" } {
  const d = (data ?? {}) as Record<string, unknown>;
  const runId = typeof d.run_id === "string" ? d.run_id : null;
  switch (d.status) {
    case "none":
      return { status: "none" };
    case "cancelled":
    case "not_configured":
      return runId ? { status: d.status, runId } : { status: "invalid" };
    case "refused":
      return runId && (d.reason === "daily_cap" || d.reason === "monthly_budget")
        ? { status: "refused", runId, reason: d.reason }
        : { status: "invalid" };
    case "claimed": {
      const c = (d.center ?? {}) as Record<string, unknown>;
      const lat = Number(c.lat);
      const lng = Number(c.lng);
      const radiusM = Number(d.radius_m);
      const maxRequests = Number(d.max_requests);
      if (!runId || ![lat, lng, radiusM, maxRequests].every(Number.isFinite) || radiusM <= 0 || maxRequests < 1) return { status: "invalid" };
      return { status: "claimed", runId, center: { lat, lng }, radiusM, maxRequests: Math.floor(maxRequests) };
    }
    default:
      return { status: "invalid" };
  }
}

/** The message key under leads.run for an outcome (owner's "Run now"). */
export function outcomeMessageKey(o: JobOutcome): string {
  if (o.status === "refused") return o.reason === "daily_cap" ? "refusedDaily" : "refusedBudget";
  if (o.status === "done") return o.truncated ? "doneTruncated" : "done";
  return o.status === "not_configured" ? "notConfigured" : o.status;
}

/** Badge tone for a status (the text always says the status too). */
export function statusTone(status: LeadStatus): "neutral" | "info" | "success" | "warning" {
  switch (status) {
    case "visited":
      return "info";
    case "prospect":
    case "customer":
      return "success";
    case "not_interested":
      return "warning";
    default:
      return "neutral";
  }
}

/** /leads link with the given list state (defaults left out, so the plain page stays "/leads"). */
export function leadListHref(state: { filter: LeadFilter; page: number; view: "list" | "map"; rep?: string }): string {
  const q = new URLSearchParams();
  if (state.filter !== "open") q.set("filter", state.filter);
  if (state.view !== "list") q.set("view", state.view);
  if (state.rep) q.set("rep", state.rep);
  if (state.page > 1) q.set("page", String(state.page));
  const s = q.toString();
  return s ? `/leads?${s}` : "/leads";
}
