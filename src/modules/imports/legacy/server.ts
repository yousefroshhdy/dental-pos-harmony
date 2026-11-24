import "server-only";
import { revalidatePath } from "next/cache";
import { getUserContext } from "@/lib/authz/context";
import { callCommand } from "@/lib/command";
import type { AppError } from "@/lib/errors";
import { log } from "@/lib/log";
import { getRequestId } from "@/lib/request-id";
import { DEFAULT_OPTIONS, type ConvertOptions } from "./convert";
import { cairoToday, convertUpload } from "./convert-upload";
import { analysisOf, LEGACY_STEPS, negativeStockRecord, stageAll, stepRows, summaryOf, type Decisions, type NegativeDecision } from "./flow";
import { getSession } from "./queries";
import { legacyUploadSchema, type LegacyProblem, type LegacyUploadResponse } from "./schemas";
import { isSameOrigin, MAX_REQUEST_BYTES, MAX_WORKBOOK_BYTES } from "./upload";

/**
 * POST /api/legacy-import: the old-system workbook, uploaded from /admin/setup/legacy-import.
 *
 * A route handler rather than a Server Action because Server Actions accept 1 MB bodies by
 * default and raising that limit is a shared next.config change; the route takes up to
 * MAX_WORKBOOK_BYTES (below Vercel's 4.5 MB function body limit). It repeats what a Server
 * Action gets for free (Origin check) and runs as the signed-in user, so the database decides:
 *
 *   1. Origin and Content-Length checks (nothing is read before them);
 *   2. api.legacy_import_check (owner + admin.import.run, MFA when enforced) BEFORE the file is parsed;
 *   3. the workbook is read and converted in memory; the bytes are dropped with the request
 *      (no disk, no Storage bucket, no database blob: only the import batch rows are stored);
 *   4. mode analyze → the reconciliation and the decisions to make (nothing stored);
 *      mode start   → api.legacy_import_start stages the five steps' batches in one transaction;
 *      mode restage → api.legacy_import_restage replaces the current step's batch.
 *
 * Logs carry counts and error codes only, never row contents.
 */
const json = (status: number, body: LegacyUploadResponse) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

const problem = (status: number, p: LegacyProblem, requestId: string) =>
  json(status, { ok: false, code: "UPLOAD_PROBLEM", messageKey: "VALIDATION", problem: p, requestId });

const failed = (error: AppError) =>
  json(error.code === "PERMISSION_DENIED" || error.code === "OWNER_ONLY" || error.code === "MFA_REQUIRED" ? 403 : 400, {
    ok: false,
    code: error.code,
    messageKey: error.messageKey,
    requestId: error.requestId,
  });

function formFields(form: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (typeof v === "string" && v.trim() !== "") out[k] = v.trim();
  return out;
}

export async function handleLegacyUpload(request: Request): Promise<Response> {
  const requestId = await getRequestId();
  const h = request.headers;
  if (!isSameOrigin({ origin: h.get("origin"), host: h.get("host"), forwardedHost: h.get("x-forwarded-host"), fetchSite: h.get("sec-fetch-site") })) {
    log("warn", "legacy_import.refused", { requestId, code: "bad_origin" });
    return problem(403, "bad_origin", requestId);
  }
  const length = Number(h.get("content-length") ?? "");
  if (!Number.isFinite(length) || length <= 0) return problem(411, "bad_request", requestId);
  if (length > MAX_REQUEST_BYTES) return problem(413, "too_large", requestId);

  // UX shortcut only; the database check below is the control.
  const ctx = await getUserContext();
  if (!ctx.user_id) return json(401, { ok: false, code: "PERMISSION_DENIED", messageKey: "PERMISSION_DENIED", requestId });
  const gate = await callCommand<{ allowed: boolean; open_session_id: string | null }>("legacy_import_check");
  if (!gate.ok) return failed(gate.error);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return problem(400, "bad_request", requestId);
  }
  const parsed = legacyUploadSchema.safeParse(formFields(form));
  if (!parsed.success) return problem(400, "bad_request", requestId);
  const input = parsed.data;
  const file = form.get("file");
  if (!(file instanceof File)) return problem(400, "no_file", requestId);
  if (file.size > MAX_WORKBOOK_BYTES) return problem(413, "too_large", requestId);
  const meta = { name: file.name, type: file.type, size: file.size };

  // ------------------------------------------------------------------ restage
  if (input.mode === "restage") {
    const session = await getSession(input.session_id);
    if (!session.ok) return failed(session.error);
    if (!session.data) return json(404, { ok: false, code: "NOT_FOUND", messageKey: "NOT_FOUND", requestId });
    const s = session.data;
    const choices = s.summary.choices;
    const options: ConvertOptions = {
      ...DEFAULT_OPTIONS,
      governorateCode: choices?.governorateCode ?? DEFAULT_OPTIONS.governorateCode,
      warehouseCode: choices?.warehouseCode ?? DEFAULT_OPTIONS.warehouseCode,
      today: cairoToday(),
    };
    const converted = await convertUpload(new Uint8Array(await file.arrayBuffer()), meta, options);
    if (!converted.ok) return problem(400, converted.problem, requestId);
    const negative: Record<string, NegativeDecision> = Object.fromEntries(s.negative_stock.map((d) => [d.sku, d.decision]));
    // A corrected workbook with a NEW negative item needs a new decision: abandon and start again.
    if (converted.result.negativeStock.some((i) => !negative[i.sku])) return problem(400, "new_negative_items", requestId);
    const kind = LEGACY_STEPS[input.step - 1]?.kind;
    if (!kind) return problem(400, "bad_request", requestId);
    const rows = stepRows(converted.result, kind, { negative, credits: s.credits_mode });
    if (!rows.ok) return problem(400, rows.error.code, requestId);
    const result = await callCommand<{ session_id: string }>("legacy_import_restage", {
      p_session_id: s.id,
      p_step: input.step,
      p_rows: rows.rows,
      p_idempotency_key: input.idempotency_key,
    });
    log("info", "legacy_import.restage", { requestId, ok: result.ok, step: input.step, rows: rows.rows.length, code: result.ok ? undefined : result.error.code });
    if (!result.ok) return failed(result.error);
    revalidatePath("/[locale]/admin/setup/legacy-import", "page");
    return json(200, { ok: true, mode: "restage", sessionId: s.id });
  }

  // ------------------------------------------------------------------ analyze / start
  const options: ConvertOptions = {
    ...DEFAULT_OPTIONS,
    governorateCode: input.governorate_code,
    warehouseCode: input.warehouse_code,
    today: cairoToday(),
  };
  const converted = await convertUpload(new Uint8Array(await file.arrayBuffer()), meta, options);
  if (!converted.ok) {
    log("info", "legacy_import.rejected", { requestId, mode: input.mode, code: converted.problem });
    return problem(400, converted.problem, requestId);
  }
  const analysis = analysisOf(converted.result, file.name.slice(0, 200), converted.sha256);
  if (input.mode === "analyze") {
    log("info", "legacy_import.analyzed", {
      requestId,
      steps: analysis.steps.map((s) => s.rows),
      negative: analysis.negativeStock.length,
      credits: analysis.credits.rows,
      mismatches: analysis.reconciliation.filter((r) => r.verdict === "mismatch").length,
    });
    return json(200, { ok: true, mode: "analyze", analysis });
  }

  const decisions: Decisions = { negative: input.decisions, credits: input.credits_mode };
  const staged = stageAll(converted.result, decisions);
  if (!staged.ok) return problem(400, staged.error.code, requestId);
  const negativeStock = negativeStockRecord(converted.result.negativeStock, decisions.negative);
  const result = await callCommand<{ session_id: string }>("legacy_import_start", {
    p_idempotency_key: input.idempotency_key,
    p_file_name: analysis.fileName,
    p_file_sha256: analysis.sha256,
    p_summary: summaryOf(analysis, { governorateCode: options.governorateCode, warehouseCode: options.warehouseCode }),
    p_negative_stock: negativeStock,
    p_credits_mode: decisions.credits,
    p_batches: staged.batches,
  });
  log("info", "legacy_import.start", { requestId, ok: result.ok, steps: LEGACY_STEPS.map((s) => staged.batches[s.kind].length), code: result.ok ? undefined : result.error.code });
  if (!result.ok) return failed(result.error);
  revalidatePath("/[locale]/admin/setup/legacy-import", "page");
  return json(200, { ok: true, mode: "start", sessionId: result.data.session_id });
}
