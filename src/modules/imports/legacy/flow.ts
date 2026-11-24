import type { ImportKind } from "../kinds";
import { buildRows, type StagedRow } from "../logic";
import type { BatchStatus } from "../types";
import type { ConvertResult, NegativeStockItem, ReconLine } from "./convert";
import type { QualityRow } from "./schemas";

/**
 * The browser import of the old-system workbook (/admin/setup/legacy-import), pure parts:
 * which converter file feeds which step, how the owner's decisions shape the rows, the
 * reconciliation display and the step gating. Nothing here decides access: the database does
 * (api.legacy_import_*, the step-order trigger on import.batches, the import commands).
 */

/** The reviewer's order. Step n's batch may run only after steps 1..n-1 committed (DB-enforced). */
export const LEGACY_STEPS = [
  { stepNo: 1, kind: "customers", file: "4-customers.csv" },
  { stepNo: 2, kind: "products", file: "1-products.csv" },
  { stepNo: 3, kind: "customer_prices", file: "2-base-prices.csv" },
  { stepNo: 4, kind: "opening_stock", file: "3-opening-stock.csv" },
  { stepNo: 5, kind: "opening_ar", file: "5-opening-ar.csv" },
] as const satisfies readonly { stepNo: number; kind: ImportKind; file: string }[];
export const CREDITS_FILE = "6-opening-ar-credits.csv";

export type NegativeDecision = "zero" | "skip";
export type CreditsMode = "hold" | "import";

export interface Decisions {
  /** sku → decision, one per negative-stock item. */
  negative: Record<string, NegativeDecision>;
  credits: CreditsMode;
}

/** Every negative item needs an explicit decision before the import can start. */
export function missingDecisions(items: readonly NegativeStockItem[], negative: Record<string, NegativeDecision | undefined>): string[] {
  return items.filter((i) => negative[i.sku] !== "zero" && negative[i.sku] !== "skip").map((i) => i.sku);
}

/** What api.legacy_import_start records for the negative items (server-derived: sku, name, quantity). */
export function negativeStockRecord(items: readonly NegativeStockItem[], negative: Record<string, NegativeDecision>) {
  return items.map((i) => ({ sku: i.sku, name: i.name, quantity: i.quantity, decision: negative[i.sku] ?? "skip" }));
}

export type StageError = { code: "file_rejected"; file: string } | { code: "decisions_incomplete"; skus: string[] };

const fileRows = (result: ConvertResult, name: string) => result.files.find((f) => f.name === name);

/**
 * The staging rows of one step, exactly as the /imports upload would build them from the
 * converter's CSV (buildRows), with the owner's decisions applied:
 *   - "skip" items are removed from products and prices (stock never holds negatives);
 *   - "zero" items stay in products and prices and get no stock line (the converter leaves
 *     negatives out of opening stock already);
 *   - credit balances join the opening AR only when the owner chose "import".
 */
export function stepRows(result: ConvertResult, kind: ImportKind, decisions: Decisions): { ok: true; rows: StagedRow[] } | { ok: false; error: StageError } {
  const step = LEGACY_STEPS.find((s) => s.kind === kind);
  if (!step) return { ok: true, rows: [] };
  const skipped = new Set(Object.entries(decisions.negative).filter(([, d]) => d === "skip").map(([sku]) => sku));
  const build = (name: string): { ok: true; rows: StagedRow[] } | { ok: false; error: StageError } => {
    const f = fileRows(result, name);
    if (!f || f.rows.length === 0) return { ok: true, rows: [] };
    const built = buildRows(kind, f.csv);
    return built.ok ? { ok: true, rows: built.rows } : { ok: false, error: { code: "file_rejected", file: name } };
  };
  const main = build(step.file);
  if (!main.ok) return main;
  let rows = main.rows;
  if (kind === "products" || kind === "customer_prices" || kind === "opening_stock") {
    rows = rows.filter((r) => !skipped.has((r.sku ?? "").toUpperCase()));
  }
  if (kind === "opening_ar" && decisions.credits === "import") {
    const credits = build(CREDITS_FILE);
    if (!credits.ok) return credits;
    rows = [...rows, ...credits.rows];
  }
  return { ok: true, rows };
}

/** All five steps' rows for api.legacy_import_start, keyed by kind. */
export function stageAll(result: ConvertResult, decisions: Decisions): { ok: true; batches: Record<ImportKind, StagedRow[]> } | { ok: false; error: StageError } {
  const missing = missingDecisions(result.negativeStock, decisions.negative);
  if (missing.length > 0) return { ok: false, error: { code: "decisions_incomplete", skus: missing } };
  const batches = {} as Record<ImportKind, StagedRow[]>;
  for (const s of LEGACY_STEPS) {
    const r = stepRows(result, s.kind, decisions);
    if (!r.ok) return r;
    batches[s.kind] = r.rows;
  }
  return { ok: true, batches };
}

// ---------------------------------------------------------------------------
// Reconciliation display
// ---------------------------------------------------------------------------
export type ReconVerdict = "match" | "mismatch" | "info";

export interface ReconRow {
  check: string;
  source: number | null;
  converted: number;
  difference: number | null;
  verdict: ReconVerdict;
  note: string;
}

/** Converter lines → table rows: a check the Checks sheet has matches or not; the rest are info. */
export function reconciliationRows(lines: readonly ReconLine[]): ReconRow[] {
  return lines.map((l) => ({
    check: l.check,
    source: l.expected,
    converted: l.output,
    difference: l.difference,
    verdict: l.status === "ok" ? "match" : l.status === "diff" ? "mismatch" : "info",
    note: l.note,
  }));
}

export function reconciliationTally(rows: readonly ReconRow[]): { match: number; mismatch: number; info: number } {
  return {
    match: rows.filter((r) => r.verdict === "match").length,
    mismatch: rows.filter((r) => r.verdict === "mismatch").length,
    info: rows.filter((r) => r.verdict === "info").length,
  };
}

// ---------------------------------------------------------------------------
// Analysis (what the page shows before the owner starts) and the stored summary
// ---------------------------------------------------------------------------
export interface StepCount {
  stepNo: number;
  kind: ImportKind;
  rows: number;
}

export interface Analysis {
  fileName: string;
  sha256: string;
  reconciliation: ReconRow[];
  negativeStock: NegativeStockItem[];
  credits: { rows: number; total: number };
  steps: StepCount[];
  barcodesToVerify: number;
  warnings: string[];
}

export function analysisOf(result: ConvertResult, fileName: string, sha256: string): Analysis {
  const credits = fileRows(result, CREDITS_FILE)?.rows ?? [];
  return {
    fileName,
    sha256,
    reconciliation: reconciliationRows(result.reconciliation),
    negativeStock: result.negativeStock,
    credits: { rows: credits.length, total: Math.round(credits.reduce((a, r) => a + Math.abs(Number(r.amount ?? 0)), 0) * 100) / 100 },
    steps: LEGACY_STEPS.map((s) => ({ stepNo: s.stepNo, kind: s.kind, rows: fileRows(result, s.file)?.rows.length ?? 0 })),
    barcodesToVerify: fileRows(result, "barcodes-to-verify.csv")?.rows.length ?? 0,
    warnings: result.warnings,
  };
}

/** Options the steps were converted with; a restage converts the corrected workbook the same way. */
export interface ConvertChoices {
  governorateCode: string;
  warehouseCode: string;
}

/** The session summary (aggregates only: no names, phones or per-customer amounts). */
export interface SessionSummary {
  reconciliation: ReconRow[];
  steps: StepCount[];
  credits: { rows: number; total: number };
  barcodesToVerify: number;
  warnings: string[];
  choices: ConvertChoices;
}

export function summaryOf(analysis: Analysis, choices: ConvertChoices): SessionSummary {
  return {
    reconciliation: analysis.reconciliation,
    steps: analysis.steps,
    credits: analysis.credits,
    barcodesToVerify: analysis.barcodesToVerify,
    warnings: analysis.warnings.slice(0, 40),
    choices,
  };
}

// ---------------------------------------------------------------------------
// Step gating (UX; the database refuses out-of-order commands with LEGACY_ORDER)
// ---------------------------------------------------------------------------
export interface StepRow {
  step_no: number;
  kind: ImportKind;
  batch_id: string | null;
  batch_status: BatchStatus | null;
  row_count: number | null;
  valid_count: number | null;
  error_count: number | null;
  committed_count: number | null;
  failure: string | null;
  failure_row_no: number | null;
  restaged_count: number;
  result: Record<string, unknown> | null;
}

export type StepState = "empty" | "locked" | "staged" | "checked" | "rejected" | "committed" | "discarded";

export interface StepGate {
  step: StepRow;
  state: StepState;
  /** Dry run (api.import_validate). */
  canDryRun: boolean;
  /** Commit (api.import_commit): only after a clean dry run. */
  canCommit: boolean;
  /** Upload a corrected workbook for this step (api.legacy_import_restage). */
  canRestage: boolean;
  /** This is the step the owner works on now. */
  current: boolean;
}

function stateOf(step: StepRow): StepState {
  if (!step.batch_id || !step.batch_status) return "empty";
  switch (step.batch_status) {
    case "committed":
      return "committed";
    case "discarded":
      return "discarded";
    case "validated":
      return "checked";
    case "failed":
      return "rejected";
    default:
      return "staged";
  }
}

const done = (s: StepState) => s === "empty" || s === "committed";

export function stepGates(steps: readonly StepRow[], sessionOpen: boolean): StepGate[] {
  const ordered = [...steps].sort((a, b) => a.step_no - b.step_no);
  let earlierDone = true;
  let currentFound = false;
  return ordered.map((step) => {
    const raw = stateOf(step);
    const state: StepState = !earlierDone && !done(raw) ? "locked" : raw;
    const active = sessionOpen && earlierDone && !done(raw);
    const current = active && !currentFound;
    if (current) currentFound = true;
    earlierDone = earlierDone && done(raw);
    return {
      step,
      state,
      canDryRun: active && (raw === "staged" || raw === "checked" || raw === "rejected"),
      canCommit: active && raw === "checked",
      canRestage: active,
      current,
    };
  });
}

/** True once every step is committed or had nothing to import. */
export function allStepsDone(steps: readonly StepRow[]): boolean {
  return steps.length === LEGACY_STEPS.length && steps.every((s) => done(stateOf(s)));
}

/**
 * Where a "data to complete" row opens (path without the locale): the customer page for a missing
 * phone or pin; for an item without cost (entity_id = the SKU), its stock-by-lot page, where the
 * owner sets each unknown lot cost once (api.set_lot_cost).
 */
export function qualityHref(q: Pick<QualityRow, "issue" | "entity_type" | "entity_id" | "customer_id" | "product_id">): string {
  if (q.entity_type === "customer") return `/customers/${q.customer_id ?? q.entity_id}`;
  if (q.issue === "cost_unknown") return `/inventory/stock/${q.entity_id}`;
  return `/catalog/products/${q.product_id ?? ""}`;
}
