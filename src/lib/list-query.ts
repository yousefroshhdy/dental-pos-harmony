/**
 * Helpers for server-paged lists (Phase P step 2b): the page reads its state with
 * `readTableParams` (components/ui/data-table-params.ts), these turn it into a
 * PostgREST range, an `or=` search filter and filter-chip links, and `runPaged`
 * returns one page plus the exact row count. Sorting, search and paging are UX:
 * RLS decides which rows exist at all.
 */
import { fail, networkError, ok, parseDbError, type Result } from "@/lib/errors";
import { log } from "@/lib/log";

export interface Paged<T> {
  rows: T[];
  total: number;
}

/** Inclusive PostgREST range for one page. */
export function rangeOf(offset: number, pageSize: number): [number, number] {
  const from = Math.max(0, Math.floor(offset));
  return [from, from + Math.max(1, Math.floor(pageSize)) - 1];
}

/**
 * Typed text made safe for a PostgREST `or=(col.ilike."*q*",…)` filter: the
 * characters that end a value or a group (`,` `(` `)`), the quote and escape
 * characters, and the LIKE wildcards are dropped; whitespace runs collapse.
 * (searchFilter also double-quotes the value, so `.` and `:` in an email or a
 * code stay part of it.)
 */
export function sanitizeSearch(q: string, max = 100): string {
  return q
    .replace(/[,()"'\\%*_]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** `col1.ilike."*q*",col2.ilike."*q*"` for `.or(...)`, or null when nothing searchable is left. */
export function searchFilter(columns: readonly string[], q: string): string | null {
  const term = sanitizeSearch(q);
  if (!term || columns.length === 0) return null;
  return columns.map((c) => `${c}.ilike."*${term}*"`).join(",");
}

type Params = Record<string, string | string[] | undefined>;

export function firstParam(params: Params, key: string): string | undefined {
  const v = params[key];
  return Array.isArray(v) ? v[0] : v;
}

/** One value from an allow-list, else the fallback (a hand-edited URL can't inject a filter). */
export function pickParam<T extends string>(params: Params, key: string, allowed: readonly T[], fallback: T): T {
  const v = firstParam(params, key);
  return v !== undefined && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

/**
 * The href for a filter chip: the current query with `key` set to `value` (or
 * removed when `value` is null), back on the first page. Search and sort are kept.
 */
export function hrefWithParam(pathname: string, params: Params, key: string, value: string | null): string {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (k === key || k === "page" || v === undefined) continue;
    for (const x of Array.isArray(v) ? v : [v]) out.append(k, x);
  }
  if (value !== null) out.set(key, value);
  const query = out.toString();
  return query ? `${pathname}?${query}` : pathname;
}

type PagedQuery = PromiseLike<{ data: unknown; error: { code?: string; message?: string; details?: string } | null; count: number | null }>;

/** Runs a `select(..., { count: "exact" }).range(...)` query; logs a failure without its data. */
export async function runPaged<T>(name: string, query: PagedQuery): Promise<Result<Paged<T>>> {
  try {
    const { data, error, count } = await query;
    if (error) {
      const appError = parseDbError(error);
      log("warn", "list.read_failed", { view: name, code: appError.code, detail: appError.detail });
      return fail(appError);
    }
    const rows = (data ?? []) as T[];
    return ok({ rows, total: count ?? rows.length });
  } catch (cause) {
    log("error", "list.read_failed", { view: name, detail: cause instanceof Error ? cause.message : String(cause) });
    return fail(networkError(cause));
  }
}
