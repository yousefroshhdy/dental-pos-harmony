import "server-only";
import { log } from "@/lib/log";
import { createClient } from "@/lib/supabase/server";
import type { Option } from "./forms";

/**
 * Picker options for the /reports filter forms. Read through the user's
 * session (RLS), so each list holds only what the user can see. A failed
 * read degrades to "All" only; the export itself still applies RLS.
 */

export type { Option } from "./forms";

type Query = PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;

async function options(view: string, query: Query, toOption: (row: Record<string, unknown>) => Option): Promise<Option[]> {
  try {
    const { data, error } = await query;
    if (error) {
      log("warn", "reports.options_failed", { view, code: error.code });
      return [];
    }
    return ((Array.isArray(data) ? data : []) as Record<string, unknown>[]).map(toOption);
  } catch (cause) {
    log("warn", "reports.options_failed", { view, detail: cause instanceof Error ? cause.message : String(cause) });
    return [];
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const named = (locale: string, en: unknown, ar: unknown) => (locale === "ar" ? str(ar) || str(en) : str(en) || str(ar));

export const OPTION_LIMIT = 500;

export async function customerOptions(): Promise<Option[]> {
  const db = await createClient();
  return options(
    "v_customers",
    db.from("v_customers").select("id, customer_no, display_name").is("archived_at", null).order("display_name").limit(OPTION_LIMIT),
    (r) => ({ value: str(r.id), label: [str(r.display_name), str(r.customer_no)].filter(Boolean).join(" · ") }),
  );
}

export async function territoryOptions(locale: string): Promise<Option[]> {
  const db = await createClient();
  return options("v_territories", db.from("v_territories").select("id, code, name_en, name_ar").eq("is_active", true).order("code"), (r) => ({
    value: str(r.id),
    label: named(locale, r.name_en, r.name_ar) || str(r.code),
  }));
}

export async function specialtyOptions(locale: string): Promise<Option[]> {
  const db = await createClient();
  return options("v_specialties", db.from("v_specialties").select("code, name_en, name_ar").order("name_en"), (r) => ({
    value: str(r.code),
    label: named(locale, r.name_en, r.name_ar) || str(r.code),
  }));
}

/** Warehouses; without inventory.module.access only sellable ones (as on the stock page). */
export async function warehouseOptions(full: boolean): Promise<Option[]> {
  const db = await createClient();
  const all = await options("v_inventory_warehouses", db.from("v_inventory_warehouses").select("id, code, name, is_sellable").order("code"), (r) => ({
    value: r.is_sellable === true || full ? str(r.id) : "",
    label: [str(r.code), str(r.name)].filter(Boolean).join(" · "),
  }));
  return all.filter((o) => o.value !== "");
}

export async function brandOptions(): Promise<Option[]> {
  const db = await createClient();
  return options("v_catalog_brands", db.from("v_catalog_brands").select("id, code, name").order("code"), (r) => ({
    value: str(r.id),
    label: str(r.name) || str(r.code),
  }));
}
