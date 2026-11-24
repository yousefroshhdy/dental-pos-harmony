/**
 * Shared inline validation messages (messages/{ar,en}.json → `form.*`). Maps a zod
 * issue (v4 shape) to a message key and its values, so every form shows the same
 * Arabic / English wording for the common cases. A module with its own wording
 * for a field passes that text to FormField instead.
 *
 *   const t = useTranslations("form");
 *   const m = validationMessage(issue);
 *   <FormField error={t(m.key, m.values)} …>
 */
export const VALIDATION_KEYS = [
  "required",
  "invalid",
  "email",
  "phone",
  "number",
  "integer",
  "tooShort",
  "tooLong",
  "min",
  "max",
  "date",
] as const;
export type ValidationKey = (typeof VALIDATION_KEYS)[number];

export interface ValidationIssue {
  code: string;
  /** zod: the expected type (invalid_type) or the checked origin (too_small / too_big). */
  expected?: string;
  origin?: string;
  format?: string;
  minimum?: number | bigint;
  maximum?: number | bigint;
  /** Present only when the schema reports inputs; otherwise pass `{ value }`. */
  input?: unknown;
  message?: string;
}

export interface ValidationMessage {
  key: ValidationKey;
  values?: Record<string, number>;
}

const num = (v: number | bigint | undefined) => (v === undefined ? 0 : Number(v));
const isEmpty = (v: unknown) => v === undefined || v === null || v === "";

/**
 * `field.value`: the submitted value, when the caller has it. zod v4 leaves the input
 * out of issues by default; without either, a missing field is recognised by zod's
 * own "received undefined" wording.
 */
export function validationMessage(issue: ValidationIssue, field?: { value: unknown }): ValidationMessage {
  switch (issue.code) {
    case "invalid_type":
      if ("input" in issue ? isEmpty(issue.input) : field ? isEmpty(field.value) : /received (undefined|null)/.test(issue.message ?? "")) {
        return { key: "required" };
      }
      if (issue.expected === "number" || issue.expected === "int") return { key: "number" };
      if (issue.expected === "date") return { key: "date" };
      return { key: "invalid" };
    case "too_small":
      if (issue.origin === "string" || issue.origin === "array") {
        // min(1) on a string is how zod schemas say "required".
        return num(issue.minimum) <= 1 ? { key: "required" } : { key: "tooShort", values: { min: num(issue.minimum) } };
      }
      return { key: "min", values: { min: num(issue.minimum) } };
    case "too_big":
      if (issue.origin === "string" || issue.origin === "array") return { key: "tooLong", values: { max: num(issue.maximum) } };
      return { key: "max", values: { max: num(issue.maximum) } };
    case "invalid_format":
      if (issue.format === "email") return { key: "email" };
      if (issue.format === "e164" || issue.format === "phone") return { key: "phone" };
      if (issue.format === "date" || issue.format === "datetime") return { key: "date" };
      return { key: "invalid" };
    case "not_multiple_of":
      return { key: "integer" };
    default:
      return { key: "invalid" };
  }
}
