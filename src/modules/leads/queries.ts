import "server-only";
import { callCommand } from "@/lib/command";
import { fail, networkError, ok, parseDbError, type Result } from "@/lib/errors";
import { log } from "@/lib/log";
import { fetchPlaceDetails, placesServerKey } from "@/lib/places/client";
import { createClient } from "@/lib/supabase/server";
import { filterConditions, LEADS_PAGE_SIZE, type DetailsState } from "./logic";
import type { LeadListParams } from "./schemas";
import type { BaseLocationRow, LeadRow, LeadRunRow, LeadStatsRow, LeadUsage } from "./types";

/**
 * Leads reads, as the signed-in user. Views are security_invoker: RLS on crm.leads decides
 * (own leads for a rep, the team's for a manager). Live Google details are fetched here, on the
 * server, with the server key, and only for the rows on screen; they are never stored.
 */

type QueryResult = { data: unknown; error: { code?: string; message?: string; details?: string } | null; count?: number | null };

async function run<T>(name: string, query: PromiseLike<QueryResult>, empty: T): Promise<Result<{ rows: T; count: number | null }>> {
  try {
    const { data, error, count } = await query;
    if (error) {
      const appError = parseDbError(error);
      log("warn", "leads.read_failed", { source: name, code: appError.code, detail: appError.detail });
      return fail(appError);
    }
    return ok({ rows: (data ?? empty) as T, count: count ?? null });
  } catch (cause) {
    log("error", "leads.read_failed", { source: name, detail: cause instanceof Error ? cause.message : String(cause) });
    return fail(networkError(cause));
  }
}

const LEAD_COLUMNS =
  "id, place_id, employee_id, employee_name_en, employee_name_ar, status, distance_m, first_seen_at, last_seen_at, " +
  "in_latest_run, notes, customer_id, customer_no, customer_name, customer_stage, planned_for, planned_today, " +
  "status_changed_at, assigned_at, updated_at, version";

interface LeadQuery extends PromiseLike<QueryResult> {
  in(column: string, values: string[]): LeadQuery;
  eq(column: string, value: string): LeadQuery;
  order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }): LeadQuery;
  range(from: number, to: number): LeadQuery;
}

export interface LeadPage {
  rows: LeadRow[];
  total: number;
  page: number;
  pages: number;
}

/** One page of leads, nearest first (unknown distances last). */
export async function listLeads(params: LeadListParams, today: string): Promise<Result<LeadPage>> {
  const db = await createClient();
  let q = db.from("v_leads").select(LEAD_COLUMNS, { count: "exact" }) as unknown as LeadQuery;
  for (const c of filterConditions(params.filter, today)) {
    q = c.op === "in" ? q.in(c.column, c.value as string[]) : q.eq(c.column, c.value as string);
  }
  if (params.rep) q = q.eq("employee_id", params.rep);
  const from = (params.page - 1) * LEADS_PAGE_SIZE;
  q = q.order("distance_m", { ascending: true, nullsFirst: false }).order("first_seen_at", { ascending: true }).order("id").range(from, from + LEADS_PAGE_SIZE - 1);
  const r = await run<LeadRow[]>("v_leads", q, []);
  if (!r.ok) return r;
  const total = r.data.count ?? r.data.rows.length;
  return ok({ rows: r.data.rows, total, page: params.page, pages: Math.max(1, Math.ceil(total / LEADS_PAGE_SIZE)) });
}

export async function getLead(id: string): Promise<Result<LeadRow | null>> {
  const db = await createClient();
  const r = await run<LeadRow[]>("v_leads", db.from("v_leads").select(LEAD_COLUMNS).eq("id", id).limit(1), []);
  return r.ok ? ok(r.data.rows[0] ?? null) : r;
}

/** Open leads of one employee (bulk reassignment). */
export async function listOpenLeadIds(employeeId: string): Promise<Result<string[]>> {
  const db = await createClient();
  const r = await run<{ id: string }[]>(
    "v_leads",
    db.from("v_leads").select("id").eq("employee_id", employeeId).in("status", ["new", "visited", "not_interested"]).limit(500),
    [],
  );
  return r.ok ? ok(r.data.rows.map((x) => x.id)) : r;
}

export async function listLeadStats(): Promise<Result<LeadStatsRow[]>> {
  const db = await createClient();
  const r = await run<LeadStatsRow[]>(
    "v_lead_stats",
    db
      .from("v_lead_stats")
      .select(
        "employee_id, employee_name_en, employee_name_ar, total, new_count, visited_count, prospect_count, customer_count, " +
          "not_interested_count, planned_today, visited_pct, converted_pct, last_run_status, last_run_finished_at",
      )
      .order("employee_name_en"),
    [],
  );
  return r.ok ? ok(r.data.rows) : r;
}

export async function listRuns(limit = 20, employeeId?: string): Promise<Result<LeadRunRow[]>> {
  const db = await createClient();
  let q = db
    .from("v_lead_discovery_runs")
    .select(
      "id, employee_id, employee_name_en, employee_name_ar, trigger, status, radius_km, requested_at, started_at, finished_at, " +
        "request_count, estimated_cost_usd, places_found, leads_new, leads_seen, excluded_customers, other_rep, truncated, refusal, error_code",
    );
  if (employeeId) q = q.eq("employee_id", employeeId);
  const r = await run<LeadRunRow[]>("v_lead_discovery_runs", q.order("requested_at", { ascending: false }).limit(limit), []);
  return r.ok ? ok(r.data.rows) : r;
}

/** Employees the caller may read, with their base point and radius (core.employees RLS). */
export async function listBaseLocations(): Promise<Result<BaseLocationRow[]>> {
  const db = await createClient();
  const r = await run<BaseLocationRow[]>(
    "v_employee_base_locations",
    db
      .from("v_employee_base_locations")
      .select("employee_id, full_name_en, full_name_ar, employment_status, base_address, base_lat, base_lng, base_location_source, lead_radius_km")
      .eq("employment_status", "active")
      .order("full_name_en"),
    [],
  );
  return r.ok ? ok(r.data.rows) : r;
}

/** The owner's cost guard (api.lead_usage; OWNER_ONLY for anyone else). */
export async function getLeadUsage(): Promise<Result<LeadUsage>> {
  const r = await callCommand<Record<string, unknown>>("lead_usage", {});
  if (!r.ok) return r;
  const n = (k: string) => Number(r.data[k] ?? 0) || 0;
  return ok({
    today_requests: n("today_requests"),
    month_run_cost_usd: n("month_run_cost_usd"),
    month_detail_requests: n("month_detail_requests"),
    month_detail_cost_usd: n("month_detail_cost_usd"),
    daily_request_cap: n("daily_request_cap"),
    monthly_budget_usd: n("monthly_budget_usd"),
    run_request_limit: n("run_request_limit"),
    queued_runs: n("queued_runs"),
  });
}

export function placesConfigured(): boolean {
  return placesServerKey().status === "ready";
}

/**
 * Live Google details (name, address, location, Maps link) for the places on screen. Asks the
 * database for an allowance first (monthly budget); places past it show without a name.
 */
export async function loadLeadDetails(placeIds: readonly string[], language: "ar" | "en"): Promise<DetailsState> {
  const key = placesServerKey();
  if (key.status !== "ready") return { status: "not_configured" };
  if (placeIds.length === 0) return { status: "ok", details: new Map() };
  const allowance = await callCommand<number>("lead_details_allowance", { p_requested: Math.min(placeIds.length, 50) });
  if (!allowance.ok) return { status: "error" };
  const allowed = Math.max(0, Math.floor(Number(allowance.data) || 0));
  const details = allowed > 0 ? await fetchPlaceDetails(key.key, placeIds.slice(0, allowed), { language }) : new Map();
  return { status: allowed < placeIds.length ? "budget_reached" : "ok", details };
}
