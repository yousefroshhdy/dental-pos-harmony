import "server-only";
import { publicEnv } from "@/env";
import { fail, networkError, ok, parseDbError, type Result } from "@/lib/errors";
import { log } from "@/lib/log";
import { normalizeMapsKey } from "@/lib/maps/config";
import { createClient } from "@/lib/supabase/server";
import { cairoToday } from "@/modules/tracking/logic";
import { lastVisitCondition } from "./logic";
import type { CustomerMapFilters } from "./schemas";
import type { CustomerMapRow, LocationProposalRow, ProposalStatus, TeamLocationRow, VisitFix } from "./types";

/**
 * Maps reads, as the signed-in user. Views are security_invoker (RLS decides what comes
 * back); api.tracking_day_visit_fixes checks the tracking scope itself.
 */

type QueryResult = { data: unknown; error: { code?: string; message?: string; details?: string } | null; count?: number | null };

async function run<T>(name: string, query: PromiseLike<QueryResult>, empty: T): Promise<Result<{ rows: T; count: number | null }>> {
  try {
    const { data, error, count } = await query;
    if (error) {
      const appError = parseDbError(error);
      log("warn", "maps.read_failed", { source: name, code: appError.code, detail: appError.detail });
      return fail(appError);
    }
    return ok({ rows: (data ?? empty) as T, count: count ?? null });
  } catch (cause) {
    log("error", "maps.read_failed", { source: name, detail: cause instanceof Error ? cause.message : String(cause) });
    return fail(networkError(cause));
  }
}

async function rows<T>(name: string, query: PromiseLike<QueryResult>, empty: T): Promise<Result<T>> {
  const r = await run(name, query, empty);
  return r.ok ? ok(r.data.rows) : r;
}

/** The browser key for the map component, or null ("The map is not available yet"). */
export function mapsBrowserKey(): string | null {
  return normalizeMapsKey(publicEnv().NEXT_PUBLIC_GOOGLE_MAPS_API_KEY);
}

/** Pins drawn on one map. More than this needs a narrower filter (the page says so). */
export const CUSTOMER_MAP_LIMIT = 3000;

const CUSTOMER_COLUMNS =
  "id, customer_no, display_name, kind, lifecycle_stage, city, latitude, longitude, location_verified, territory_id, " +
  "territory_name_en, territory_name_ar, primary_rep_employee_id, primary_rep_name_en, primary_rep_name_ar, " +
  "is_overdue, max_days_overdue, last_visit_on";

export interface CustomerMapData {
  pinned: CustomerMapRow[];
  /** Matching customers without a location (not on the map). */
  unpinned: number;
  truncated: boolean;
}

/** The PostgREST builder methods the customer-map filters use (structural, to keep the types shallow). */
interface MapQuery extends PromiseLike<QueryResult> {
  eq(column: string, value: string): MapQuery;
  is(column: string, value: null | boolean): MapQuery;
  not(column: string, operator: string, value: null): MapQuery;
  or(filters: string): MapQuery;
  order(column: string): MapQuery;
  limit(count: number): MapQuery;
}

export async function listCustomerMap(filters: CustomerMapFilters): Promise<Result<CustomerMapData>> {
  const db = await createClient();
  const visit = lastVisitCondition(filters.lastVisit, cairoToday());
  // A fresh builder per query (PostgREST builders are single-use).
  const filtered = (q: MapQuery): MapQuery => {
    let out = q;
    if (filters.rep) out = out.eq("primary_rep_employee_id", filters.rep);
    if (filters.territory) out = out.eq("territory_id", filters.territory);
    if (filters.stage) out = out.eq("lifecycle_stage", filters.stage);
    if (filters.overdue) out = out.is("is_overdue", true);
    if (visit?.kind === "never") out = out.is("last_visit_on", null);
    if (visit?.kind === "before") out = out.or(`last_visit_on.is.null,last_visit_on.lt.${visit.day}`);
    return out;
  };
  const pinnedQuery = db.from("v_customer_map").select(CUSTOMER_COLUMNS) as unknown as MapQuery;
  const unpinnedQuery = db.from("v_customer_map").select("id", { count: "exact", head: true }) as unknown as MapQuery;

  const [pinned, unpinned] = await Promise.all([
    run<CustomerMapRow[]>(
      "v_customer_map",
      filtered(pinnedQuery.not("latitude", "is", null)).order("customer_no").limit(CUSTOMER_MAP_LIMIT + 1),
      [],
    ),
    run<null>("v_customer_map", filtered(unpinnedQuery.is("latitude", null)), null),
  ]);
  if (!pinned.ok) return pinned;
  if (!unpinned.ok) return unpinned;
  const list = pinned.data.rows;
  return ok({ pinned: list.slice(0, CUSTOMER_MAP_LIMIT), unpinned: unpinned.data.count ?? 0, truncated: list.length > CUSTOMER_MAP_LIMIT });
}

export async function listTeamLocations(): Promise<Result<TeamLocationRow[]>> {
  const db = await createClient();
  return rows<TeamLocationRow[]>(
    "v_team_last_location",
    db
      .from("v_team_last_location")
      .select("employee_id, full_name_en, full_name_ar, shift_id, shift_started_at, point_source, latitude, longitude, accuracy_m, captured_at, anomaly_flags")
      .order("full_name_en"),
    [],
  );
}

const PROPOSAL_COLUMNS =
  "id, customer_id, customer_no, customer_name, territory_name_en, territory_name_ar, customer_has_location, visit_id, " +
  "proposed_by, proposed_by_name_en, proposed_by_name_ar, latitude, longitude, accuracy_m, captured_at, anomaly_flags, " +
  "status, decided_by_name_en, decided_by_name_ar, decided_at, decision_note, created_at";

export async function listLocationProposals(status: "pending" | "decided", limit = 200): Promise<Result<LocationProposalRow[]>> {
  const db = await createClient();
  const base = db.from("v_customer_location_proposals").select(PROPOSAL_COLUMNS);
  const query =
    status === "pending"
      ? base.eq("status", "pending").order("captured_at", { ascending: true })
      : base.neq("status", "pending").order("created_at", { ascending: false });
  return rows<LocationProposalRow[]>("v_customer_location_proposals", query.limit(limit), []);
}

export async function listCustomerProposals(customerId: string, statuses: ProposalStatus[] = ["pending"]): Promise<Result<LocationProposalRow[]>> {
  const db = await createClient();
  return rows<LocationProposalRow[]>(
    "v_customer_location_proposals",
    db.from("v_customer_location_proposals").select(PROPOSAL_COLUMNS).eq("customer_id", customerId).in("status", statuses).order("captured_at").limit(20),
    [],
  );
}

/** Visit check-in/out fixes of one rep and Cairo day (empty without field.location.read). */
export async function getVisitFixes(employeeId: string, day: string): Promise<Result<VisitFix[]>> {
  const db = await createClient();
  return rows<VisitFix[]>("tracking_day_visit_fixes", db.rpc("tracking_day_visit_fixes", { p_employee_id: employeeId, p_day: day }), []);
}
