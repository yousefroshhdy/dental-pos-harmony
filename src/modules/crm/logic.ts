import type { AppError } from "@/lib/errors";
import type { CustomerListParams } from "./schemas";
import {
  CRM_ERROR_CODES,
  OPPORTUNITY_STAGES,
  type ActionFailure,
  type CrmErrorCode,
  type CustomerRow,
  type DuplicateCheck,
  type DuplicateOutcome,
  type LifecycleStage,
  type OpportunityRow,
  type OpportunityStage,
} from "./types";

/**
 * Pure CRM logic: phone normalisation, search, state machines, form diffs and
 * display helpers. UI gating here is cosmetic; every rule is enforced again by
 * the api.* commands in Postgres.
 */

type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info";

// ---------------------------------------------------------------------------
// Phones
// ---------------------------------------------------------------------------

/** Arabic-Indic (٠-٩) and Eastern Arabic-Indic (۰-۹) digits → Latin. */
export function toLatinDigits(value: string): string {
  return value.replace(/[٠-٩۰-۹]/g, (d) => {
    const code = d.charCodeAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });
}

/** Same check as the core.phone_e164 domain. */
export const EGYPT_E164 = /^\+20(1[0125][0-9]{8}|[2-9][0-9]{7,8})$/;

/**
 * Egyptian phone → E.164 (`+20…`), mirroring core.to_phone_e164: accepts the
 * local `01…` form, `0020…`, `20…`, `+20…`, Arabic-Indic digits, spaces, dashes,
 * dots and brackets. Returns null when the result is not a valid Egyptian number.
 */
export function normalizeEgyptPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let v = toLatinDigits(raw).replace(/[\s().-]/g, "");
  if (v === "") return null;
  if (v.startsWith("00")) v = `+${v.slice(2)}`;
  if (/^20[0-9]{9,10}$/.test(v)) v = `+${v}`;
  else if (/^0[0-9]{8,10}$/.test(v)) v = `+20${v.slice(1)}`;
  return EGYPT_E164.test(v) ? v : null;
}

/** `+201001234567` → `0100 123 4567` for display (Egyptians read the local form). */
export function formatEgyptPhone(e164: string | null | undefined): string {
  if (!e164) return "";
  if (!e164.startsWith("+20")) return e164;
  const local = `0${e164.slice(3)}`;
  return local.length === 11 ? `${local.slice(0, 4)} ${local.slice(4, 7)} ${local.slice(7)}` : local;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** Characters with meaning in PostgREST filter syntax or LIKE patterns. */
const SEARCH_RESERVED = /[,()*%\\:"'`]/g;

/** Free-text search term made safe for a PostgREST `or=(…ilike…)` filter. Null when empty. */
export function sanitizeSearch(term: string | null | undefined): string | null {
  if (!term) return null;
  const clean = term.replace(SEARCH_RESERVED, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return clean === "" ? null : clean;
}

/**
 * If the term looks like (part of) a phone number, the digits to look for inside
 * the stored E.164 value: `0100 123` → `100123`, `+20 100…` → `100…`.
 */
export function phoneSearchDigits(term: string): string | null {
  const v = toLatinDigits(term).replace(/[\s().+-]/g, "");
  if (!/^[0-9]{4,15}$/.test(v)) return null;
  if (v.startsWith("0020")) return v.slice(4) || null;
  if (/^20[0-9]{9,10}$/.test(v)) return v.slice(2);
  if (v.startsWith("0")) return v.slice(1);
  return v;
}

/** PostgREST `or` filter for the customer list search (name, number or phone). */
export function customerSearchFilter(term: string | null | undefined): string | null {
  const clean = sanitizeSearch(term);
  if (!clean) return null;
  // Quoted so dots and spaces in names stay part of the value (quotes were stripped above).
  const like = `"*${clean}*"`;
  const parts = [`display_name.ilike.${like}`, `doctor_name.ilike.${like}`, `clinic_name.ilike.${like}`, `customer_no.ilike.${like}`];
  const digits = phoneSearchDigits(clean);
  if (digits) parts.push(`phone_primary.ilike."*${digits}*"`, `phone_secondary.ilike."*${digits}*"`);
  return parts.join(",");
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export const PAGE_SIZE = 25;

/** Inclusive row range for PostgREST `.range()`; page is 1-based. */
export function pageRange(page: number, size = PAGE_SIZE): { from: number; to: number } {
  const p = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1;
  return { from: (p - 1) * size, to: p * size - 1 };
}

export function totalPages(count: number | null | undefined, size = PAGE_SIZE): number {
  return Math.max(1, Math.ceil((count ?? 0) / size));
}

/** Query string for the customer list, dropping empty values and page 1. */
export function listQuery(params: Record<string, string | number | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") continue;
    if (key === "page" && Number(value) <= 1) continue;
    q.set(key, String(value));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

// ---------------------------------------------------------------------------
// Customer list (api.v_customer_list): filters, order, links
// ---------------------------------------------------------------------------

/** One condition on api.v_customer_list; queries.ts applies them to the PostgREST builder. */
export type CustomerListFilter = { op: "eq"; column: string; value: string | boolean } | { op: "or"; value: string };

/** URL filter keys in the order links are written (search first, sort last). */
const FILTER_KEYS = ["stage", "territory", "specialty", "rep", "overdue", "phone", "location"] as const;
export type CustomerFilterKey = (typeof FILTER_KEYS)[number];

/** The list filters as column conditions. Every one is UX: RLS decides which rows exist. */
export function customerListFilters(params: CustomerListParams): CustomerListFilter[] {
  const out: CustomerListFilter[] = [];
  const search = customerSearchFilter(params.q);
  if (search) out.push({ op: "or", value: search });
  if (params.stage) out.push({ op: "eq", column: "lifecycle_stage", value: params.stage });
  if (params.territory) out.push({ op: "eq", column: "territory_id", value: params.territory });
  if (params.specialty) out.push({ op: "eq", column: "specialty_code", value: params.specialty });
  if (params.rep) out.push({ op: "eq", column: "primary_rep_employee_id", value: params.rep });
  // A masked overdue flag is NULL, so "= true" never matches a customer whose balance is hidden.
  if (params.overdue) out.push({ op: "eq", column: "is_overdue", value: true });
  if (params.phone) out.push({ op: "eq", column: "phone_missing", value: true });
  if (params.location) out.push({ op: "eq", column: "location_missing", value: true });
  return out;
}

/** Columns the customers list can be sorted by (DataTable column ids = view columns). */
export const CUSTOMER_SORTS = ["display_name", "customer_no", "created_at", "balance"] as const;

/** ORDER BY for the list: a known column (default the name), then the id so pages never overlap. */
export function customerListOrder(sorting: readonly { id: string; desc: boolean }[]): { column: string; ascending: boolean }[] {
  const first = sorting[0];
  const known = first && (CUSTOMER_SORTS as readonly string[]).includes(first.id) ? first : null;
  return [
    { column: known?.id ?? "display_name", ascending: known ? !known.desc : true },
    { column: "id", ascending: true },
  ];
}

/** The filters that are set (for the "clear filters" link and the active count). */
export function activeCustomerFilters(params: CustomerListParams): CustomerFilterKey[] {
  return FILTER_KEYS.filter((key) => Boolean(params[key]));
}

/**
 * `/customers?…` with `change` applied (undefined clears one filter; `null` clears every
 * filter but keeps the search). Always back to page 1; the sort is kept.
 */
export function customerListHref(
  params: CustomerListParams & { sort?: string },
  change: Partial<Record<CustomerFilterKey, string | undefined>> | null,
): string {
  const next: Record<string, string | undefined> = { q: params.q };
  for (const key of FILTER_KEYS) next[key] = change === null ? undefined : key in change ? change[key] : params[key];
  next.sort = params.sort;
  return `/customers${listQuery(next)}`;
}

// ---------------------------------------------------------------------------
// Data gaps and contact links
// ---------------------------------------------------------------------------

/** Same rules as api.v_customer_data_gaps: no primary phone, no GPS pin. */
export type CustomerGap = "phone_missing" | "location_missing";

export function customerGaps(row: {
  phone_primary: string | null;
  latitude: number | string | null;
  phone_missing?: boolean | null;
  location_missing?: boolean | null;
}): CustomerGap[] {
  const phone = row.phone_missing ?? !row.phone_primary;
  const location = row.location_missing ?? (row.latitude === null || row.latitude === undefined || row.latitude === "");
  const gaps: CustomerGap[] = [];
  if (phone) gaps.push("phone_missing");
  if (location) gaps.push("location_missing");
  return gaps;
}

/** `tel:` link for a stored (E.164) Egyptian number; null when there is none. */
export function telHref(e164: string | null | undefined): string | null {
  return e164 && EGYPT_E164.test(e164) ? `tel:${e164}` : null;
}

/** WhatsApp click-to-chat (wa.me takes the digits without "+"); Egyptian mobiles only. */
export function whatsappHref(e164: string | null | undefined): string | null {
  return e164 && /^\+201[0125][0-9]{8}$/.test(e164) ? `https://wa.me/${e164.slice(1)}` : null;
}

/** Clearing a saved primary phone (api.update_customer refuses it: "cannot be removed"). */
export function phoneRemoved(current: string | null | undefined, input: string | null | undefined): boolean {
  return Boolean(current) && (input ?? "").trim() === "";
}

// ---------------------------------------------------------------------------
// Customer detail tabs
// ---------------------------------------------------------------------------

export const CUSTOMER_TABS = ["overview", "visits", "orders", "invoices", "activity"] as const;
export type CustomerTab = (typeof CUSTOMER_TABS)[number];

/** The read permission each tab's data needs (the views check it again through RLS). */
const TAB_PERMISSION: Partial<Record<CustomerTab, string>> = {
  visits: "field.visit.read",
  orders: "sales.order.read",
  invoices: "finance.invoice.read",
};

export function customerTabs(may: (permission: string) => boolean): CustomerTab[] {
  return CUSTOMER_TABS.filter((tab) => {
    const permission = TAB_PERMISSION[tab];
    return permission === undefined || may(permission);
  });
}

/** `?tab=` → a tab the user may open; anything else is the overview. */
export function parseCustomerTab(raw: string | string[] | undefined, allowed: readonly CustomerTab[]): CustomerTab {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return allowed.find((tab) => tab === value) ?? "overview";
}

// ---------------------------------------------------------------------------
// Customer lifecycle (mirror of crm.stage_transition_allowed)
// ---------------------------------------------------------------------------

const LIFECYCLE_TRANSITIONS: Record<LifecycleStage, LifecycleStage[]> = {
  lead: ["prospect", "active", "lost"],
  prospect: ["lead", "active", "lost"],
  active: ["dormant", "lost"],
  dormant: ["active", "lost"],
  lost: ["lead", "prospect"],
  // Set and cleared only by finance/credit commands.
  blocked: [],
};

export function lifecycleTransitionAllowed(from: LifecycleStage, to: LifecycleStage): boolean {
  return LIFECYCLE_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Options for the stage select on the edit form: the current stage first. */
export function lifecycleOptions(current: LifecycleStage): LifecycleStage[] {
  return [current, ...(LIFECYCLE_TRANSITIONS[current] ?? [])];
}

export function lifecycleTone(stage: LifecycleStage): BadgeTone {
  switch (stage) {
    case "active":
      return "success";
    case "lead":
    case "prospect":
      return "info";
    case "dormant":
      return "warning";
    case "lost":
      return "neutral";
    case "blocked":
      return "danger";
  }
}

// ---------------------------------------------------------------------------
// Opportunities (mirror of crm.opportunity_transition_allowed)
// ---------------------------------------------------------------------------

export const OPEN_STAGES = ["new", "qualified", "proposal", "negotiation"] as const satisfies readonly OpportunityStage[];

export function isOpenStage(stage: OpportunityStage): boolean {
  return (OPEN_STAGES as readonly string[]).includes(stage);
}

export function opportunityTransitionAllowed(from: OpportunityStage, to: OpportunityStage): boolean {
  return isOpenStage(from) && from !== to && (OPPORTUNITY_STAGES as readonly string[]).includes(to);
}

export function nextOpportunityStages(from: OpportunityStage): OpportunityStage[] {
  return OPPORTUNITY_STAGES.filter((to) => opportunityTransitionAllowed(from, to));
}

export function opportunityTone(stage: OpportunityStage): BadgeTone {
  return stage === "won" ? "success" : stage === "lost" ? "neutral" : stage === "negotiation" ? "warning" : "info";
}

export interface StageColumn {
  stage: OpportunityStage;
  items: OpportunityRow[];
  count: number;
  /** Sum of expected values (display only; the server owns every money rule). */
  expectedTotal: number;
}

/** Pipeline columns in stage order; items keep the order they arrived in. */
export function groupByStage(rows: OpportunityRow[]): StageColumn[] {
  return OPPORTUNITY_STAGES.map((stage) => {
    const items = rows.filter((r) => r.stage === stage);
    const expectedTotal = items.reduce((sum, r) => sum + (toNumber(r.expected_value) ?? 0), 0);
    return { stage, items, count: items.length, expectedTotal: Math.round(expectedTotal * 100) / 100 };
  });
}

// ---------------------------------------------------------------------------
// Customer form diff (api.update_customer takes only the changed fields)
// ---------------------------------------------------------------------------

export interface CustomerInput {
  doctor_name?: string;
  clinic_name?: string;
  display_name?: string;
  kind: string;
  specialty_code?: string;
  /** Optional since Phase P (a customer may have no phone yet). */
  phone_primary?: string;
  phone_secondary?: string;
  email?: string;
  address_line?: string;
  city?: string;
  governorate_code: string;
  tags: string[];
  notes?: string;
  lifecycle_stage?: LifecycleStage;
}

const TEXT_FIELDS = ["doctor_name", "clinic_name", "email", "address_line", "city", "notes", "specialty_code"] as const;

const blank = (v: string | null | undefined) => (v ?? "").trim();

/**
 * Fields that differ from the current record, as the `p_changes` object for
 * api.update_customer. Values are compared as the database would store them
 * (trimmed, empty = null, phones in E.164, tags as a sorted set).
 */
export function customerChanges(current: CustomerRow, input: CustomerInput): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  for (const field of TEXT_FIELDS) {
    const next = blank(input[field]);
    if (next !== blank(current[field])) changes[field] = next === "" ? null : next;
  }
  // display_name is only sent when the user typed one that differs; otherwise the
  // command recomposes it from the clinic/doctor names.
  const display = blank(input.display_name);
  if (display !== "" && display !== blank(current.display_name)) changes.display_name = display;
  if (input.kind !== current.kind) changes.kind = input.kind;
  if (input.governorate_code.toUpperCase() !== blank(current.governorate_code).toUpperCase()) {
    changes.governorate_code = input.governorate_code.toUpperCase();
  }
  // An empty phone is "no change": a missing phone stays missing, and removing a saved one is
  // refused before this is called (phoneRemoved), as the command refuses it.
  const primary = blank(input.phone_primary);
  if (primary !== "" && (normalizeEgyptPhone(primary) ?? primary) !== (current.phone_primary ?? "")) {
    changes.phone_primary = primary;
  }
  const secondary = input.phone_secondary ? (normalizeEgyptPhone(input.phone_secondary) ?? input.phone_secondary) : "";
  if (secondary !== (current.phone_secondary ?? "")) changes.phone_secondary = input.phone_secondary || null;
  const tags = normalizeTags(input.tags);
  if (tags.join("\u0000") !== normalizeTags(current.tags ?? []).join("\u0000")) changes.tags = tags;
  if (input.lifecycle_stage && input.lifecycle_stage !== current.lifecycle_stage) changes.lifecycle_stage = input.lifecycle_stage;
  return changes;
}

/** Sorted, de-duplicated, trimmed, non-empty (same as the command). */
export function normalizeTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map((t) => t.trim()).filter(Boolean))].sort();
}

/** "implants, vip ,  vip" → ["implants", "vip"]. Accepts Arabic commas too. */
export function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return normalizeTags(raw.split(/[,،]/));
}

// ---------------------------------------------------------------------------
// Time (forms send Cairo wall-clock time)
// ---------------------------------------------------------------------------

const CAIRO = "Africa/Cairo";

/** Minutes the Cairo clock is ahead of UTC at `instant` (DST-aware). */
function cairoOffsetMinutes(instant: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CAIRO,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - Math.floor(instant / 1000) * 1000) / 60000);
}

/** `<input type="datetime-local">` value in Cairo time → ISO instant. Null if malformed. */
export function cairoLocalToIso(local: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local ?? "");
  if (!m) return null;
  const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4], m[5]].map(Number) as [number, number, number, number, number];
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  if (Number.isNaN(naive)) return null;
  let instant = naive - cairoOffsetMinutes(naive) * 60000;
  instant = naive - cairoOffsetMinutes(instant) * 60000;
  return new Date(instant).toISOString();
}

/** Now as a Cairo `datetime-local` value (default and max of the activity form). */
export function cairoNowLocal(now: Date = new Date()): string {
  const shifted = new Date(now.getTime() + cairoOffsetMinutes(now.getTime()) * 60000);
  return shifted.toISOString().slice(0, 16);
}

// ---------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------

/** Same default as core.system_settings 'field.max_accuracy_m' (used for visit verification). */
export const MAX_LOCATION_ACCURACY_M = 100;

/** Egypt bounding box enforced by crm.customers and api.set_customer_location. */
export function insideEgypt(lat: number, lng: number): boolean {
  return lat >= 21.5 && lat <= 32.0 && lng >= 24.5 && lng <= 37.5;
}

export type LocationProblem = "LOCATION_INACCURATE" | "OUTSIDE_EGYPT" | null;

/** Whether a browser fix is good enough to pin the clinic. */
export function locationFixProblem(fix: { lat: number; lng: number; accuracy: number }): LocationProblem {
  if (!insideEgypt(fix.lat, fix.lng)) return "OUTSIDE_EGYPT";
  if (!(fix.accuracy >= 0) || fix.accuracy > MAX_LOCATION_ACCURACY_M) return "LOCATION_INACCURATE";
  return null;
}

export type LocationStatus = "verified" | "unverified" | "missing";

export function locationStatus(row: Pick<CustomerRow, "latitude" | "location_verified">): LocationStatus {
  if (row.latitude === null || row.latitude === undefined) return "missing";
  return row.location_verified ? "verified" : "unverified";
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Duplicate pre-check → what the create form does. A same-phone match stops the submit (with
 * its number only when the caller can see that customer); similar names, visible or not, ask
 * for confirmation. Hidden matches never carry a number or a count (audit Phase 3 F7).
 */
export function duplicateOutcome(check: DuplicateCheck): DuplicateOutcome {
  if (check.phone_duplicate_customer_no) return { kind: "phone", customerNo: check.phone_duplicate_customer_no };
  if (check.phone_duplicate_outside_scope) return { kind: "phoneOutsideScope" };
  const outsideScope = check.similar_outside_scope === true;
  if (check.similar_count > 0 || outsideScope) {
    return { kind: "similar", similar: check.similar_customer_nos ?? [], similarCount: check.similar_count, outsideScope };
  }
  return { kind: "none" };
}

/** Existing customer number from a DUPLICATE_CUSTOMER error (the only detail the DB reveals). */
export function duplicateCustomerNo(detail: string | null | undefined): string | null {
  if (!detail) return null;
  const json = /"existing_customer_no"\s*:\s*"([^"]+)"/.exec(detail);
  if (json?.[1]) return json[1];
  return /registered to customer ([A-Z0-9][A-Z0-9-]*)/.exec(detail)?.[1] ?? null;
}

export function isCrmErrorCode(code: string): code is CrmErrorCode {
  return (CRM_ERROR_CODES as readonly string[]).includes(code);
}

/** AppError → what the browser may see: translation keys plus safe values. */
export function toActionFailure(error: AppError): ActionFailure {
  const failure: ActionFailure = { ok: false, messageKey: error.messageKey, requestId: error.requestId };
  if (isCrmErrorCode(error.code)) failure.crmCode = error.code;
  if (error.code === "DUPLICATE_CUSTOMER") {
    // The DB names the existing customer only if the caller may read it.
    if (/"outside_scope"\s*:\s*true/.test(error.detail ?? "")) {
      failure.crmCode = "DUPLICATE_CUSTOMER_HIDDEN";
    } else {
      const customerNo = duplicateCustomerNo(error.detail);
      failure.params = { customerNo: customerNo ?? "—" };
    }
  }
  return failure;
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/** Name in the viewer's locale, falling back to the other language. */
export function localizedName(locale: string, en: string | null | undefined, ar: string | null | undefined): string {
  if (locale === "ar" && ar) return ar;
  return en ?? ar ?? "";
}

/** numeric from PostgREST (number or string) → number. */
export function toNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}
