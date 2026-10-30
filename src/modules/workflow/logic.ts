import type { AppError } from "@/lib/errors";
import {
  CONDITION_OPS,
  type Condition,
  type ConditionClause,
  type ConditionOp,
  type DelegationRow,
  type EscalationRow,
  type Scalar,
  type StageRow,
  VALUE_TYPES,
  type ValueType,
  WORKFLOW_ERROR_KEYS,
  type WorkflowErrorKey,
} from "./types";

/**
 * Pure display and form logic for the workflow screens. Nothing here decides
 * authority: Postgres validates every rule, stage and delegation again.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
export function errorKeyFor(error: Pick<AppError, "code">): WorkflowErrorKey {
  if (error.code === "LIMIT_EXCEEDED") return "PERMISSION_DENIED";
  return (WORKFLOW_ERROR_KEYS as readonly string[]).includes(error.code) ? (error.code as WorkflowErrorKey) : "UNKNOWN";
}

// ---------------------------------------------------------------------------
// Workflow labels
// ---------------------------------------------------------------------------
/** Seeded workflow codes with a translated label under workflow.workflows.*. */
export const WORKFLOW_LABEL_KEYS: Record<string, string> = {
  "sales.order.discount": "orderDiscount",
  "sales.order.cancel": "orderCancel",
  "sales.return": "salesReturn",
  "inventory.adjustment": "inventoryAdjustment",
  "crm.customer.reassign": "customerReassign",
  "field.visit.exception": "visitException",
  "finance.credit_note": "creditNote",
  "finance.credit_limit": "creditLimit",
  "perf.commission_period": "commissionPeriod",
  "perf.commission_adjustment": "commissionAdjustment",
  "data.export": "dataExport",
};

export function workflowLabelKey(code: string | null | undefined): string | null {
  return code ? (WORKFLOW_LABEL_KEYS[code] ?? null) : null;
}

/** English or Arabic name, falling back to the other language. */
export function localizedName(locale: string, en: string | null | undefined, ar: string | null | undefined): string {
  const primary = locale === "ar" ? ar : en;
  return (primary ?? (locale === "ar" ? en : ar) ?? "").trim() || "—";
}

// ---------------------------------------------------------------------------
// Conditions (data in the {"all":[{field,op,value}]} format, never SQL)
// ---------------------------------------------------------------------------
export const MAX_CLAUSES = 20;
/** Rows the editor shows (empty rows are ignored). */
export const EDITOR_CLAUSE_ROWS = 4;
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*){0,4}$/;

/** One editor row as typed by the user (all strings). */
export interface ClauseInput {
  field: string;
  op: string;
  type: string;
  value: string;
}

export type ClauseError = "field" | "op" | "type" | "value" | "listOp" | "booleanOp" | "tooMany";
export type BuildResult = { ok: true; condition: Condition } | { ok: false; row: number; error: ClauseError };

const isOp = (op: string): op is ConditionOp => (CONDITION_OPS as readonly string[]).includes(op);
const isType = (t: string): t is ValueType => (VALUE_TYPES as readonly string[]).includes(t);

function parseNumber(raw: string): number | null {
  const s = raw.trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseValue(type: ValueType, raw: string): Scalar | Scalar[] | null {
  switch (type) {
    case "number":
      return parseNumber(raw);
    case "text":
      return raw.trim() === "" || raw.length > 200 ? null : raw.trim();
    case "boolean":
      return raw === "true" ? true : raw === "false" ? false : null;
    case "number_list": {
      const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
      const nums = parts.map(parseNumber);
      return parts.length === 0 || parts.length > 50 || nums.some((n) => n === null) ? null : (nums as number[]);
    }
    case "text_list": {
      const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
      return parts.length === 0 || parts.length > 50 || parts.some((p) => p.length > 200) ? null : parts;
    }
  }
}

/** Editor rows → condition. A row with an empty field is ignored; no rows = `{}` (always). */
export function buildCondition(rows: ClauseInput[]): BuildResult {
  const clauses: ConditionClause[] = [];
  for (const [i, row] of rows.entries()) {
    if (row.field.trim() === "") continue;
    const field = row.field.trim();
    if (!FIELD_RE.test(field)) return { ok: false, row: i, error: "field" };
    if (!isOp(row.op)) return { ok: false, row: i, error: "op" };
    if (!isType(row.type)) return { ok: false, row: i, error: "type" };
    const list = row.type === "number_list" || row.type === "text_list";
    if (list !== (row.op === "in")) return { ok: false, row: i, error: "listOp" };
    if (row.type === "boolean" && row.op !== "=" && row.op !== "!=") return { ok: false, row: i, error: "booleanOp" };
    const value = parseValue(row.type, row.value);
    if (value === null) return { ok: false, row: i, error: "value" };
    clauses.push({ field, op: row.op, value });
  }
  if (clauses.length > MAX_CLAUSES) return { ok: false, row: MAX_CLAUSES, error: "tooMany" };
  return { ok: true, condition: clauses.length === 0 ? {} : { all: clauses } };
}

const isScalar = (v: unknown): v is Scalar => typeof v === "number" || typeof v === "string" || typeof v === "boolean";

/** Stored condition → clauses, or null when it is not in the supported format. */
export function parseCondition(condition: unknown): ConditionClause[] | null {
  if (typeof condition !== "object" || condition === null || Array.isArray(condition)) return null;
  const keys = Object.keys(condition);
  if (keys.length === 0) return [];
  if (keys.length !== 1 || keys[0] !== "all") return null;
  const all = (condition as { all: unknown }).all;
  if (!Array.isArray(all)) return null;
  const out: ConditionClause[] = [];
  for (const c of all) {
    if (typeof c !== "object" || c === null) return null;
    const { field, op, value } = c as Record<string, unknown>;
    if (typeof field !== "string" || typeof op !== "string" || !isOp(op)) return null;
    if (op === "in" ? !(Array.isArray(value) && value.every(isScalar)) : !isScalar(value)) return null;
    out.push({ field, op, value: value as Scalar | Scalar[] });
  }
  return out;
}

/** Clauses → editor rows (prefill). Boolean lists cannot be edited in the form and yield null. */
export function clausesToRows(clauses: ConditionClause[]): ClauseInput[] | null {
  const rows: ClauseInput[] = [];
  for (const c of clauses) {
    if (Array.isArray(c.value)) {
      if (c.value.every((v) => typeof v === "number")) rows.push({ field: c.field, op: c.op, type: "number_list", value: c.value.join(", ") });
      else if (c.value.every((v) => typeof v === "string")) rows.push({ field: c.field, op: c.op, type: "text_list", value: c.value.join(", ") });
      else return null;
    } else if (typeof c.value === "number") rows.push({ field: c.field, op: c.op, type: "number", value: String(c.value) });
    else if (typeof c.value === "boolean") rows.push({ field: c.field, op: c.op, type: "boolean", value: String(c.value) });
    else rows.push({ field: c.field, op: c.op, type: "text", value: c.value });
  }
  return rows;
}

/** Pads editor rows to a fixed count so the form always offers empty rows to add clauses. */
export function editorRows(rows: ClauseInput[], count = EDITOR_CLAUSE_ROWS): ClauseInput[] {
  const empty: ClauseInput = { field: "", op: ">", type: "number", value: "" };
  return [...rows, ...Array.from({ length: Math.max(count - rows.length, 0) }, () => ({ ...empty }))];
}

/** Reads clause_<i>_<part> fields from a form object. */
export function clauseRowsFromForm(raw: Record<string, string>, count = EDITOR_CLAUSE_ROWS + MAX_CLAUSES): ClauseInput[] {
  const rows: ClauseInput[] = [];
  for (let i = 0; i < count; i++) {
    const field = raw[`clause_${i}_field`];
    if (field === undefined && raw[`clause_${i}_value`] === undefined) continue;
    rows.push({
      field: field ?? "",
      op: raw[`clause_${i}_op`] ?? "",
      type: raw[`clause_${i}_type`] ?? "",
      value: raw[`clause_${i}_value`] ?? "",
    });
  }
  return rows;
}

/** Display text of a clause value (lists comma-separated). */
export function formatClauseValue(value: Scalar | Scalar[]): string {
  return Array.isArray(value) ? value.map(String).join(", ") : String(value);
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------
export const MINUTES_PER_HOUR = 60;
export const MIN_ESCALATE_MINUTES = 15;
export const MAX_ESCALATE_MINUTES = 30 * 24 * 60;

/** Hours typed in the form → whole minutes for the command (NaN/empty → null). */
export function hoursToMinutes(hours: number | null | undefined): number | null {
  if (hours === null || hours === undefined || !Number.isFinite(hours)) return null;
  return Math.round(hours * MINUTES_PER_HOUR);
}

/** Minutes → hours for display and prefill (at most two decimals). */
export function minutesToHours(minutes: number | null | undefined): number | null {
  if (minutes === null || minutes === undefined) return null;
  return Math.round((minutes / MINUTES_PER_HOUR) * 100) / 100;
}

/** Next free stage number of a rule. */
export function nextStageNo(stages: Pick<StageRow, "stage_no">[]): number {
  return stages.reduce((max, s) => Math.max(max, s.stage_no), 0) + 1;
}

// ---------------------------------------------------------------------------
// Delegation window (Africa/Cairo, as typed in <input type="datetime-local">)
// ---------------------------------------------------------------------------
export const CAIRO = "Africa/Cairo";
const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** Offset of `zone` from UTC at `instant`, in minutes (Cairo is +120 or +180 with summer time). */
export function zoneOffsetMinutes(instant: Date, zone = CAIRO): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60000);
}

/** "2026-11-02T09:00" in Cairo time → ISO instant ("2026-11-02T07:00:00.000Z"). Null if malformed. */
export function cairoLocalToIso(local: string, zone = CAIRO): string | null {
  const m = LOCAL_RE.exec(local.trim());
  if (!m) return null;
  const num = (i: number) => Number(m[i] ?? "0");
  const [y, mo, d, h, mi, s] = [num(1), num(2), num(3), num(4), num(5), num(6)];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  if (new Date(guess).getUTCDate() !== d) return null;
  let instant = guess - zoneOffsetMinutes(new Date(guess), zone) * 60000;
  // Re-check once: the offset can differ on the other side of a summer-time change.
  instant = guess - zoneOffsetMinutes(new Date(instant), zone) * 60000;
  return new Date(instant).toISOString();
}

/** ISO instant → "YYYY-MM-DDTHH:mm" in Cairo time (value for a datetime-local input). */
export function isoToCairoLocal(iso: string | Date, zone = CAIRO): string {
  const instant = typeof iso === "string" ? new Date(iso) : iso;
  const shifted = new Date(instant.getTime() + zoneOffsetMinutes(instant, zone) * 60000);
  return shifted.toISOString().slice(0, 16);
}

// ---------------------------------------------------------------------------
// Delegations
// ---------------------------------------------------------------------------
export const OPEN_DELEGATION: readonly string[] = ["active", "scheduled"];

export interface DelegationGroups {
  fromMe: DelegationRow[];
  toMe: DelegationRow[];
  team: DelegationRow[];
}

const statusRank: Record<string, number> = { active: 0, scheduled: 1, ended: 2, revoked: 3 };

/** Active first, then scheduled, then history; newest window first inside each. */
export function sortDelegations(rows: DelegationRow[]): DelegationRow[] {
  return [...rows].sort(
    (a, b) => (statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9) || b.valid_from.localeCompare(a.valid_from),
  );
}

export function groupDelegations(rows: DelegationRow[]): DelegationGroups {
  const sorted = sortDelegations(rows);
  return {
    fromMe: sorted.filter((r) => r.is_from_me),
    toMe: sorted.filter((r) => r.is_to_me && !r.is_from_me),
    team: sorted.filter((r) => !r.is_from_me && !r.is_to_me),
  };
}

/**
 * Whether to offer "End now" (UX only; api.revoke_delegation decides). Open delegations of
 * mine or to me, and — for managers and workflow admins — the team rows they can see.
 */
export function canEndDelegation(row: Pick<DelegationRow, "status" | "is_from_me" | "is_to_me">, managesOthers: boolean): boolean {
  if (!OPEN_DELEGATION.includes(row.status)) return false;
  return row.is_from_me || row.is_to_me || managesOthers;
}

// ---------------------------------------------------------------------------
// Escalations
// ---------------------------------------------------------------------------
/** Open escalations only; the ones that reached me first, then the longest waiting. */
export function openEscalations(rows: EscalationRow[]): EscalationRow[] {
  return rows
    .filter((r) => r.is_open)
    .sort(
      (a, b) =>
        Number(b.i_am_target) - Number(a.i_am_target) ||
        Number(b.can_decide) - Number(a.can_decide) ||
        a.first_escalated_at.localeCompare(b.first_escalated_at),
    );
}
