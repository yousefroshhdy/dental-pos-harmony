import "server-only";
import { fail, networkError, ok, parseDbError, type Result } from "@/lib/errors";
import { log } from "@/lib/log";
import { createClient } from "@/lib/supabase/server";
import type { BaseLocationRow, SetupOverview, WarehouseRow } from "./setup";

/**
 * Reads for /admin/setup, as the signed-in user: RLS and the owner check in api.setup_overview
 * decide what comes back.
 */
type Query = PromiseLike<{ data: unknown; error: { code?: string; message?: string; details?: string } | null }>;

async function run<T>(name: string, query: Query, empty: T): Promise<Result<T>> {
  try {
    const { data, error } = await query;
    if (error) {
      const appError = parseDbError(error);
      log("warn", "setup.read_failed", { view: name, code: appError.code, detail: appError.detail });
      return fail(appError);
    }
    return ok((data ?? empty) as T);
  } catch (cause) {
    log("error", "setup.read_failed", { view: name, detail: cause instanceof Error ? cause.message : String(cause) });
    return fail(networkError(cause));
  }
}

export async function getSetupOverview(): Promise<Result<SetupOverview | null>> {
  const db = await createClient();
  return run("setup_overview", db.rpc("setup_overview"), null);
}

export async function listBaseLocations(): Promise<Result<BaseLocationRow[]>> {
  const db = await createClient();
  return run(
    "v_employee_base_locations",
    db
      .from("v_employee_base_locations")
      .select(
        "employee_id, employee_no, full_name_en, full_name_ar, job_title, employment_status, user_id, base_address, base_lat, base_lng, base_location_source, lead_radius_km, base_set_at",
      )
      .order("employee_no"),
    [],
  );
}

export async function listWarehouses(): Promise<Result<WarehouseRow[]>> {
  const db = await createClient();
  return run("v_inventory_warehouses", db.from("v_inventory_warehouses").select("id, code, name, kind, is_active").order("code"), []);
}
