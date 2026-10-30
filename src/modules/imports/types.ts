import type { TranslatedCode } from "@/lib/errors";
import type { ImportKind } from "./kinds";

/** Row shapes of api.v_import_batches / api.v_import_rows (20261103000110_import_commands.sql). */
export type BatchStatus = "uploaded" | "validated" | "committed" | "failed" | "discarded";
export type RowStatus = "pending" | "valid" | "invalid" | "committed";

export interface ImportBatchView {
  id: string;
  kind: ImportKind;
  status: BatchStatus;
  file_name: string | null;
  row_count: number;
  valid_count: number;
  error_count: number;
  committed_count: number;
  failure: string | null;
  failure_row_no: number | null;
  result: Record<string, unknown> | null;
  created_by: string;
  created_by_name_en: string | null;
  created_by_name_ar: string | null;
  created_at: string;
  validated_at: string | null;
  committed_at: string | null;
  discarded_at: string | null;
}

export interface ImportRowView {
  id: string;
  batch_id: string;
  row_no: number;
  raw: Record<string, string | null>;
  normalized: Record<string, unknown> | null;
  errors: string[];
  status: RowStatus;
  result: Record<string, unknown> | null;
}

/** A refusal from the upload step that the page explains (file problems found before the DB). */
export type UploadProblem =
  | { code: "no_file" }
  | { code: "too_large" }
  | { code: "not_text" }
  | { code: "csv"; reason: "unterminated_quote" | "unexpected_quote"; line: number }
  | { code: "empty" }
  | { code: "too_many_rows"; count: number }
  | { code: "duplicate_header"; column: string }
  | { code: "unknown_columns"; columns: string }
  | { code: "missing_columns"; columns: string }
  | { code: "extra_cells"; line: number };

export type ActionResult =
  | { ok: true; status?: BatchStatus }
  | { ok: false; code: string; messageKey: TranslatedCode; requestId?: string; problem?: UploadProblem };
export type ActionState = ActionResult | null;
