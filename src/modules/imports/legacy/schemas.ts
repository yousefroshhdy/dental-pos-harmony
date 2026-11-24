import { z } from "zod";
import type { TranslatedCode } from "@/lib/errors";
import type { Analysis, NegativeDecision, SessionSummary } from "./flow";
import type { UploadProblemCode } from "./upload";

/**
 * Input of POST /api/legacy-import (multipart: these fields + `file`) and of the step actions.
 * They reject malformed input early; the database re-checks everything and decides access.
 */
const governorate = z.string().regex(/^EG-[A-Z]{1,4}$/);
const warehouse = z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,39}$/);
const key = z.string().min(8).max(120).regex(/^[A-Za-z0-9-]+$/);

const decisions = z
  .string()
  .max(500_000)
  .transform((s, ctx) => {
    try {
      return JSON.parse(s) as unknown;
    } catch {
      ctx.addIssue({ code: "custom", message: "decisions must be JSON" });
      return z.NEVER;
    }
  })
  .pipe(z.record(z.string().max(64), z.enum(["zero", "skip"])));

export const legacyUploadSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("analyze"), governorate_code: governorate, warehouse_code: warehouse }),
  z.object({
    mode: z.literal("start"),
    governorate_code: governorate,
    warehouse_code: warehouse,
    idempotency_key: key,
    decisions,
    credits_mode: z.enum(["hold", "import"]).default("hold"),
  }),
  z.object({ mode: z.literal("restage"), session_id: z.guid(), step: z.coerce.number().int().min(1).max(5), idempotency_key: key }),
]);
export type LegacyUploadInput = z.infer<typeof legacyUploadSchema>;

export const stepActionSchema = z.object({ batch_id: z.guid() });
export const commitStepSchema = stepActionSchema.extend({ confirm: z.literal("on") });
export const sessionActionSchema = z.object({ session_id: z.guid(), confirm: z.literal("on") });

/** Problems the page explains (found before or instead of a database error). */
export type LegacyProblem = UploadProblemCode | "bad_request" | "bad_origin" | "decisions_incomplete" | "new_negative_items" | "file_rejected";

export type LegacyUploadResponse =
  | { ok: true; mode: "analyze"; analysis: Analysis }
  | { ok: true; mode: "start" | "restage"; sessionId: string }
  | { ok: false; code: string; messageKey: TranslatedCode; requestId?: string; problem?: LegacyProblem };

export type StepActionResult = { ok: true; status?: string } | { ok: false; code: string; messageKey: TranslatedCode; requestId?: string };
export type StepActionState = StepActionResult | null;

/** api.v_legacy_import_sessions. */
export interface LegacySessionView {
  id: string;
  status: "open" | "completed" | "abandoned";
  file_name: string | null;
  file_sha256: string | null;
  summary: Partial<SessionSummary>;
  credits_mode: "hold" | "import";
  negative_stock: { sku: string; name?: string; quantity: number; decision: NegativeDecision }[];
  created_by: string;
  created_by_name_en: string | null;
  created_by_name_ar: string | null;
  created_at: string;
  completed_at: string | null;
  abandoned_at: string | null;
}

/** api.v_legacy_import_quality. */
export interface QualityRow {
  session_id: string;
  issue: "phone_missing" | "location_missing" | "cost_unknown";
  entity_type: "customer" | "product";
  entity_id: string;
  customer_id: string | null;
  product_id: string | null;
  code: string;
  label: string;
}
