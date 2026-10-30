import { z } from "zod";
import { IMPORT_KINDS } from "./kinds";

/**
 * Input validation for the import Server Actions. These reject malformed input early;
 * api.import_* re-validates everything and decides permissions.
 */

/** FormData → plain object of trimmed, non-empty strings (files are read separately). */
export function formToObject(form: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed !== "") out[key] = trimmed;
  }
  return out;
}

const id = z.guid();
const locale = z.enum(["ar", "en"]);

export const uploadSchema = z.object({
  kind: z.enum(IMPORT_KINDS),
  /** Device-generated per attempt: a retried upload replays the same batch. */
  idempotency_key: z.string().min(8).max(200),
  locale,
});

export const batchActionSchema = z.object({
  batch_id: id,
});

/** Commit needs an explicit confirmation tick on top of the dialog. */
export const commitSchema = batchActionSchema.extend({
  confirm: z.literal("on"),
});

export const batchIdParam = z.guid();
export const kindParam = z.enum(IMPORT_KINDS);
