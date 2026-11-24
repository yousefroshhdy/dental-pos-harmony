/**
 * URL state for a server-side DataTable: `?page=2&sort=-created_at&q=clinic`.
 * Pure, so a server page can read the same parameters it renders with (and unit
 * tests cover it). `page` is 1-based in the URL, `pageIndex` 0-based in the table.
 * `sort` is a column id, prefixed with "-" for descending.
 */
export interface TableState {
  pageIndex: number;
  pageSize: number;
  sorting: { id: string; desc: boolean }[];
  search: string;
}

export interface TableParamOptions {
  pageSize?: number;
  /** Column ids the server can order by; anything else in ?sort= is ignored. */
  sortable?: readonly string[];
  defaultSort?: { id: string; desc: boolean } | null;
  /** Longest accepted search text (the rest is cut). */
  maxSearch?: number;
}

export const DEFAULT_PAGE_SIZE = 25;
/** Hard cap on ?page= so a hand-edited URL can't ask for an absurd offset. */
export const MAX_PAGE = 10_000;

type Params = Record<string, string | string[] | undefined> | URLSearchParams;

function get(params: Params, key: string): string | undefined {
  if (params instanceof URLSearchParams) return params.get(key) ?? undefined;
  const v = params[key];
  return Array.isArray(v) ? v[0] : v;
}

export function readTableParams(params: Params, options: TableParamOptions = {}): TableState & { offset: number } {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const rawPage = Number.parseInt(get(params, "page") ?? "1", 10);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.min(rawPage, MAX_PAGE) : 1;

  const rawSort = get(params, "sort") ?? "";
  const desc = rawSort.startsWith("-");
  const id = desc ? rawSort.slice(1) : rawSort;
  const sorting = id && options.sortable?.includes(id) ? [{ id, desc }] : options.defaultSort ? [options.defaultSort] : [];

  const search = (get(params, "q") ?? "").trim().slice(0, options.maxSearch ?? 100);
  return { pageIndex: page - 1, pageSize, sorting, search, offset: (page - 1) * pageSize };
}

/**
 * The query for `state`, merged into `current` (other filters in the URL are kept).
 * Defaults are omitted so the first page has a clean URL.
 */
export function tableStateToQuery(state: TableState, current: Params = {}): URLSearchParams {
  const out = new URLSearchParams();
  const entries = current instanceof URLSearchParams ? [...current.entries()] : Object.entries(current).flatMap(([k, v]) => (v === undefined ? [] : (Array.isArray(v) ? v : [v]).map((x) => [k, x] as [string, string])));
  for (const [k, v] of entries) if (k !== "page" && k !== "sort" && k !== "q") out.append(k, v);
  if (state.search) out.set("q", state.search);
  const sort = state.sorting[0];
  if (sort) out.set("sort", `${sort.desc ? "-" : ""}${sort.id}`);
  if (state.pageIndex > 0) out.set("page", String(state.pageIndex + 1));
  return out;
}

/** "Showing 26–50 of 112": the 1-based range on the current page (0–0 when empty). */
export function pageRange(pageIndex: number, pageSize: number, rowCount: number): { from: number; to: number; pages: number } {
  const pages = Math.max(1, Math.ceil(rowCount / pageSize));
  if (rowCount === 0) return { from: 0, to: 0, pages };
  const from = Math.min(pageIndex * pageSize + 1, rowCount);
  return { from, to: Math.min((pageIndex + 1) * pageSize, rowCount), pages };
}
