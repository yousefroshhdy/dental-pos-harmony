import { readTableParams, type TableParamOptions, type TableState } from "@/components/ui/data-table-params";

/**
 * Server-side paging for the Orders, Finance, Inventory and Returns lists
 * (Phase P redesign). Pure, so the server page and the unit tests read the URL
 * the same way the client DataTable writes it (`?page=&sort=&q=` plus each
 * list's own filters).
 *
 * The page asks the database for one window (`range(offset, offset+limit-1)`,
 * `count: "exact"`) of an api.v_* view; RLS still decides which rows exist.
 * Sorting is a whitelist: a column id the table shows → the view column to
 * order by. Anything else in `?sort=` falls back to the list's default order.
 */
export interface SortSpec {
  column: string;
  ascending: boolean;
}

export interface ListSpec {
  pageSize?: number;
  /** Table column id → api view column. */
  sortColumns: Readonly<Record<string, string>>;
  /** The order when `?sort=` is absent or not allowed (column ids from `sortColumns`). */
  defaultSort: { id: string; desc: boolean };
  /** View columns `?q=` searches (case-insensitive, substring). Empty: no search. */
  searchColumns?: readonly string[];
}

export interface PageRequest {
  /** What the client table shows (page, sort, search). */
  state: TableState;
  offset: number;
  limit: number;
  /** Primary order, then the list's own tie-breakers in the query. */
  sort: SortSpec;
  /** Sanitised search text, or "" when none. */
  search: string;
}

type Params = Record<string, string | string[] | undefined> | URLSearchParams;

/** Options for `useUrlTableState` / `readTableParams` that match `spec` (same ids on both sides). */
export function tableOptions(spec: ListSpec): TableParamOptions {
  return { pageSize: spec.pageSize, sortable: Object.keys(spec.sortColumns), defaultSort: spec.defaultSort };
}

/**
 * Search text safe inside a PostgREST `or=(…)` ilike filter: letters (Arabic too),
 * digits, spaces and `. - / +`; commas, parentheses, quotes, `%`, `*` and `\` go.
 */
export function cleanSearch(raw: string | null | undefined): string {
  return (raw ?? "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s.\-/+]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

export function pageRequest(params: Params, spec: ListSpec): PageRequest {
  const parsed = readTableParams(params, tableOptions(spec));
  const first = parsed.sorting[0] ?? spec.defaultSort;
  const column = spec.sortColumns[first.id] ?? spec.sortColumns[spec.defaultSort.id] ?? "created_at";
  const search = spec.searchColumns && spec.searchColumns.length > 0 ? cleanSearch(parsed.search) : "";
  return {
    state: { pageIndex: parsed.pageIndex, pageSize: parsed.pageSize, sorting: parsed.sorting, search: parsed.search },
    offset: parsed.offset,
    limit: parsed.pageSize,
    sort: { column, ascending: !first.desc },
    search,
  };
}

/**
 * PostgREST `or` filter body for a substring search over `columns`, or null when
 * there is nothing to search. The value is quoted so dots and spaces stay part of it.
 */
export function ilikeAny(columns: readonly string[], search: string): string | null {
  const clean = cleanSearch(search);
  if (!clean || columns.length === 0) return null;
  return columns.map((c) => `${c}.ilike."*${clean}*"`).join(",");
}

/**
 * The URL query for a changed filter: `patch` values replace (null/"" removes),
 * every other parameter stays, and the page goes back to the first one.
 */
export function filterQuery(current: Params, patch: Readonly<Record<string, string | null | undefined>>): string {
  const out = new URLSearchParams();
  const entries =
    current instanceof URLSearchParams
      ? [...current.entries()]
      : Object.entries(current).flatMap(([k, v]) => (v === undefined ? [] : (Array.isArray(v) ? v : [v]).map((x) => [k, x] as [string, string])));
  for (const [k, v] of entries) if (k !== "page" && !(k in patch)) out.append(k, v);
  for (const [k, v] of Object.entries(patch)) if (v) out.set(k, v);
  return out.toString();
}

/** True when any of `keys` carries a value (to tell "nothing yet" from "nothing matches"). */
export function hasAnyParam(current: Params, keys: readonly string[]): boolean {
  return keys.some((k) => {
    const v = current instanceof URLSearchParams ? current.get(k) : current[k];
    const s = Array.isArray(v) ? v[0] : v;
    return typeof s === "string" && s.trim() !== "";
  });
}

/** One page of rows and the total the filters match. */
export interface Page<T> {
  rows: T[];
  total: number;
}
