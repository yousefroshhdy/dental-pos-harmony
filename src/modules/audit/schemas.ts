import { z } from "zod";
import { AUDIT_ACTIONS, type AuditFilters } from "./types";

/**
 * URL search parameters of the audit pages. Each one is validated on its own: an invalid
 * value is dropped (and reported) instead of failing the whole search. The database
 * re-validates every argument.
 */

const identifier = /^[a-z_][a-z0-9_]*$/;
export const tableRefSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/);
const isoDate = z.iso.date();

const fieldSchemas = {
  table: tableRefSchema,
  record: z.string().trim().min(1).max(200),
  actor: z.guid().transform((v) => v.toLowerCase()),
  from: isoDate,
  to: isoDate,
  action: z.string().trim().toUpperCase().pipe(z.enum(AUDIT_ACTIONS)),
  before: z.string().regex(/^\d{1,15}$/).transform(Number).pipe(z.number().int().positive()),
} as const;

export type AuditSearchField = keyof typeof fieldSchemas | "range";
export type SearchParams = Record<string, string | string[] | undefined>;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** "crm.customers" → ["crm", "customers"], or null. */
export function splitTableRef(value: string | undefined | null): [string, string] | null {
  const parsed = tableRefSchema.safeParse(value ?? "");
  if (!parsed.success) return null;
  const [schema, table] = parsed.data.split(".");
  return schema && table && identifier.test(schema) && identifier.test(table) ? [schema, table] : null;
}

export function parseAuditSearch(sp: SearchParams): { filters: AuditFilters; invalid: AuditSearchField[] } {
  const invalid: AuditSearchField[] = [];
  const read = <K extends keyof typeof fieldSchemas>(key: K): z.output<(typeof fieldSchemas)[K]> | undefined => {
    const raw = first(sp[key]);
    if (raw === undefined || raw.trim() === "") return undefined;
    const parsed = fieldSchemas[key].safeParse(raw);
    if (!parsed.success) {
      invalid.push(key);
      return undefined;
    }
    return parsed.data as z.output<(typeof fieldSchemas)[K]>;
  };

  const table = read("table");
  const ref = table ? splitTableRef(table) : null;
  let from = read("from");
  let to = read("to");
  if (from && to && from > to) {
    invalid.push("range");
    from = undefined;
    to = undefined;
  }

  return {
    filters: {
      tableSchema: ref?.[0],
      tableName: ref?.[1],
      recordId: read("record"),
      actorUserId: read("actor"),
      from,
      to,
      action: read("action"),
      beforeId: read("before"),
      reveal: first(sp.reveal) === "1",
    },
    invalid,
  };
}

/** Route params of /audit/[table]/[recordId]. */
export function parseRecordRoute(table: string, recordId: string): { schema: string; table: string; recordId: string } | null {
  const ref = splitTableRef(safeDecode(table));
  const id = z.string().trim().min(1).max(200).safeParse(safeDecode(recordId));
  if (!ref || !id.success) return null;
  return { schema: ref[0], table: ref[1], recordId: id.data };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
