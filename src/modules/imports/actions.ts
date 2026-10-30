"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { callCommand } from "@/lib/command";
import type { AppError } from "@/lib/errors";
import { buildRows, MAX_FILE_BYTES, type BuildError } from "./logic";
import { batchActionSchema, commitSchema, formToObject, uploadSchema } from "./schemas";
import type { ActionResult, ActionState, BatchStatus, UploadProblem } from "./types";

/**
 * Import mutations. Each action validates its input, calls exactly one api.import_*
 * command as the signed-in user and refreshes the import pages. Authorization is NOT
 * decided here: the database checks admin.import.run (and the kind's own permission)
 * at scope "all" on every call, and validates every row again.
 */

function refresh() {
  revalidatePath("/[locale]/imports", "layout");
}

const failed = (error: AppError): ActionResult => ({
  ok: false,
  code: error.code,
  messageKey: error.messageKey,
  requestId: error.requestId,
});

const invalid = (): ActionResult => ({ ok: false, code: "VALIDATION", messageKey: "VALIDATION" });

const problem = (p: UploadProblem): ActionResult => ({ ok: false, code: "UPLOAD_PROBLEM", messageKey: "VALIDATION", problem: p });

function fromBuildError(error: BuildError): UploadProblem {
  switch (error.code) {
    case "csv":
      return { code: "csv", reason: error.csv.code, line: error.csv.line };
    case "unknown_columns":
    case "missing_columns":
      return { code: error.code, columns: error.columns.join(", ") };
    default:
      return error;
  }
}

/**
 * Strict UTF-8: a file saved in a legacy Arabic code page (Windows-1256) or a binary
 * spreadsheet (.xlsx is a zip) is refused with "Save as CSV (UTF-8)".
 */
function decodeUtf8(bytes: ArrayBuffer): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.includes("\u0000") ? null : text;
  } catch {
    return null;
  }
}

/** Parse the CSV on the server, stage it (api.import_create_batch), open the batch. */
export async function uploadBatch(_prev: ActionState, form: FormData): Promise<ActionResult> {
  const parsed = uploadSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid();
  const { kind, idempotency_key, locale } = parsed.data;

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return problem({ code: "no_file" });
  if (file.size > MAX_FILE_BYTES) return problem({ code: "too_large" });
  const text = decodeUtf8(await file.arrayBuffer());
  if (text === null) return problem({ code: "not_text" });

  const built = buildRows(kind, text);
  if (!built.ok) return problem(fromBuildError(built.error));

  const result = await callCommand<{ batch_id: string }>("import_create_batch", {
    p_kind: kind,
    p_rows: built.rows,
    p_idempotency_key: idempotency_key,
    p_file_name: file.name.slice(0, 200),
  });
  if (!result.ok) return failed(result.error);
  refresh();
  redirect(`/${locale}/imports/${result.data.batch_id}`);
}

export async function validateBatch(_prev: ActionState, form: FormData): Promise<ActionResult> {
  const parsed = batchActionSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid();
  const result = await callCommand<{ status: BatchStatus }>("import_validate", { p_batch_id: parsed.data.batch_id });
  if (!result.ok) return failed(result.error);
  refresh();
  return { ok: true, status: result.data.status };
}

/**
 * Commit: all rows in one database transaction. A refused commit (rows no longer valid,
 * or a row the posting command rejected) comes back as status "failed" with nothing posted.
 */
export async function commitBatch(_prev: ActionState, form: FormData): Promise<ActionResult> {
  const parsed = commitSchema.safeParse(formToObject(form));
  if (!parsed.success) return { ok: false, code: "CONFIRM_REQUIRED", messageKey: "VALIDATION" };
  const result = await callCommand<{ status: BatchStatus }>("import_commit", { p_batch_id: parsed.data.batch_id });
  if (!result.ok) return failed(result.error);
  refresh();
  return { ok: true, status: result.data.status };
}

export async function discardBatch(_prev: ActionState, form: FormData): Promise<ActionResult> {
  const parsed = batchActionSchema.extend({ locale: uploadSchema.shape.locale }).safeParse(formToObject(form));
  if (!parsed.success) return invalid();
  const result = await callCommand("import_discard", { p_batch_id: parsed.data.batch_id });
  if (!result.ok) return failed(result.error);
  refresh();
  redirect(`/${parsed.data.locale}/imports`);
}
