"use client";

import {
  columnFilteringFeature,
  createFilteredRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  filterFn_includesString,
  globalFilteringFeature,
  rowPaginationFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  tableFeatures,
  useTable,
  type ColumnDef,
  type PaginationState,
  type RowData,
  type SortingState,
} from "@tanstack/react-table";
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon, ChevronLeftIcon, ChevronRightIcon, SearchIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { Button } from "./button";
import { pageRange, type TableState } from "./data-table-params";
import { EmptyState } from "./empty-state";
import { Input } from "./input";
import { Skeleton } from "./skeleton";

/**
 * Data table on @tanstack/react-table v9 (headless): search, sortable headers, a
 * filter slot, client- or server-side pagination, and a card list under `md` so a
 * phone never scrolls sideways.
 *
 * Columns hold render functions, so define them in a client component (the shadcn
 * "columns.tsx" pattern) and pass rows from the server page:
 *
 *   const columns: DataTableColumn<CustomerRow>[] = [
 *     { id: "name", header: t("name"), accessor: (r) => r.display_name, sortable: true, searchable: true, primary: true },
 *     { id: "balance", header: t("balance"), accessor: (r) => Number(r.balance), cell: (r) => <Money value={r.balance} />, align: "end" },
 *   ];
 *   <DataTable columns={columns} data={rows} rowHref={(r) => `/customers/${r.id}`} />
 *
 * Server mode (`server` prop): the page fetches one page with `readTableParams`
 * (data-table-params.ts) and `useUrlTableState` keeps the URL in step.
 * Sorting/search/pagination are UX: RLS decides which rows exist at all.
 */
export interface DataTableColumn<TData> {
  id: string;
  header: string;
  /** Plain value for sorting, searching and the default cell. */
  accessor?: (row: TData) => string | number | null | undefined;
  /** Rich cell; defaults to the accessor value (or an em dash). */
  cell?: (row: TData) => ReactNode;
  sortable?: boolean;
  /** Included in the search box (client mode). */
  searchable?: boolean;
  align?: "start" | "center" | "end";
  className?: string;
  /** The card title on phones (one column). Its cell links to `rowHref` on desktop. */
  primary?: boolean;
  /** Left out of the phone card (e.g. a column the title already shows). */
  hideOnMobile?: boolean;
}

export interface DataTableServerState {
  rowCount: number;
  state: TableState;
  onStateChange: (state: TableState) => void;
}

export interface DataTableProps<TData extends RowData> {
  columns: readonly DataTableColumn<TData>[];
  data: readonly TData[];
  getRowId?: (row: TData, index: number) => string;
  /** Turns rows into links (whole card on phones, the primary cell on desktop). */
  rowHref?: (row: TData) => string;
  /** Filter controls (selects, date pickers…) shown next to the search box. */
  filters?: ReactNode;
  /** Actions at the toolbar's end (export, "New"). */
  actions?: ReactNode;
  /** Hide the search box. */
  searchable?: boolean;
  searchPlaceholder?: string;
  /** Client mode only. */
  pageSize?: number;
  /** Server-side pagination, sorting and search. */
  server?: DataTableServerState;
  loading?: boolean;
  /** An error panel; replaces the rows. */
  error?: ReactNode;
  /** Shown when there are no rows and no search is active. */
  empty?: ReactNode;
  /** Custom phone card; defaults to the primary column as title and the others as label/value rows. */
  mobileCard?: (row: TData) => ReactNode;
  caption?: string;
  className?: string;
}

const features = tableFeatures({
  rowSortingFeature,
  columnFilteringFeature,
  globalFilteringFeature,
  rowPaginationFeature,
  sortedRowModel: createSortedRowModel(),
  filteredRowModel: createFilteredRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, basic: sortFn_basic },
  filterFns: { includesString: filterFn_includesString },
});
type Features = typeof features;

const ALIGN = { start: "text-start", center: "text-center", end: "text-end" } as const;
const SEARCH_DEBOUNCE_MS = 300;

export function DataTable<TData extends RowData>({
  columns,
  data,
  getRowId,
  rowHref,
  filters,
  actions,
  searchable = true,
  searchPlaceholder,
  pageSize = 25,
  server,
  loading = false,
  error,
  empty,
  mobileCard,
  caption,
  className,
}: DataTableProps<TData>) {
  const t = useTranslations("dataTable");
  const manual = server !== undefined;

  const [clientSorting, setClientSorting] = useState<SortingState>([]);
  const [clientPagination, setClientPagination] = useState<PaginationState>({ pageIndex: 0, pageSize });
  const [clientSearch, setClientSearch] = useState("");
  const [searchText, setSearchText] = useState(server?.state.search ?? "");

  // Server mode: send the typed search after a pause, from the first page.
  const serverRef = useRef(server);
  useEffect(() => {
    serverRef.current = server;
  });
  useEffect(() => {
    const current = serverRef.current;
    if (!current || searchText === current.state.search) return;
    const timer = setTimeout(() => current.onStateChange({ ...current.state, search: searchText, pageIndex: 0 }), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchText]);

  const tableColumns = useMemo(
    () =>
      columns.map(
        (col) =>
          ({
            id: col.id,
            accessorFn: col.accessor ? (row: TData) => col.accessor?.(row) ?? undefined : undefined,
            header: col.header,
            enableSorting: Boolean(col.sortable && (col.accessor || manual)),
            enableGlobalFilter: Boolean(col.searchable && col.accessor),
            sortFn: "alphanumeric",
            sortUndefined: "last",
          }) as ColumnDef<Features, TData>,
      ),
    [columns, manual],
  );

  const sorting = server ? server.state.sorting : clientSorting;
  const pagination = server ? { pageIndex: server.state.pageIndex, pageSize: server.state.pageSize } : clientPagination;

  const table = useTable({
    features,
    columns: tableColumns,
    data: data as TData[],
    getRowId,
    state: { sorting, pagination, globalFilter: manual ? "" : clientSearch },
    onSortingChange: (updater) => {
      const next = typeof updater === "function" ? updater(sorting) : updater;
      if (server) server.onStateChange({ ...server.state, sorting: next.slice(0, 1), pageIndex: 0 });
      else setClientSorting(next);
    },
    onPaginationChange: (updater) => {
      const next = typeof updater === "function" ? updater(pagination) : updater;
      if (server) server.onStateChange({ ...server.state, pageIndex: next.pageIndex, pageSize: next.pageSize });
      else setClientPagination(next);
    },
    onGlobalFilterChange: (value) => {
      setClientSearch(String(value ?? ""));
      setClientPagination((p) => ({ ...p, pageIndex: 0 }));
    },
    globalFilterFn: "includesString",
    enableMultiSort: false,
    manualPagination: manual,
    manualSorting: manual,
    manualFiltering: manual,
    rowCount: server?.rowCount,
  });

  const rows = table.getRowModel().rows;
  const rowCount = server ? server.rowCount : table.getFilteredRowModel().rows.length;
  const { from, to, pages } = pageRange(pagination.pageIndex, pagination.pageSize, rowCount);
  const searching = (server ? server.state.search : clientSearch) !== "";
  const byId = new Map(columns.map((c) => [c.id, c]));
  const primary = columns.find((c) => c.primary) ?? columns[0];

  const renderCell = (col: DataTableColumn<TData>, row: TData): ReactNode => {
    if (col.cell) return col.cell(row);
    const v = col.accessor?.(row);
    return v === null || v === undefined || v === "" ? "—" : v;
  };

  const onSearch = (value: string) => {
    setSearchText(value);
    if (!server) table.setGlobalFilter(value);
  };

  return (
    <div data-slot="data-table" className={cn("space-y-3", className)}>
      {searchable || filters || actions ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          {searchable ? (
            <div className="relative sm:max-w-xs sm:flex-1">
              <SearchIcon aria-hidden="true" className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                value={searchText}
                onChange={(e) => onSearch(e.target.value)}
                placeholder={searchPlaceholder ?? t("search")}
                aria-label={searchPlaceholder ?? t("search")}
                className="ps-9"
              />
            </div>
          ) : null}
          {filters ? <div className="flex flex-wrap items-center gap-2">{filters}</div> : null}
          {actions ? <div className="flex flex-wrap items-center gap-2 sm:ms-auto">{actions}</div> : null}
        </div>
      ) : null}

      {error ? (
        error
      ) : loading ? (
        <div role="status" className="space-y-2">
          <span className="sr-only">{t("loading")}</span>
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        searching ? (
          <EmptyState icon={<SearchIcon aria-hidden="true" />} title={t("noMatches")} description={t("noMatchesHint")} />
        ) : (
          (empty ?? <EmptyState title={t("empty")} />)
        )
      ) : (
        <>
          {/* Desktop and tablet: a real table. */}
          <div className="hidden overflow-x-auto rounded-lg border bg-card md:block">
            <table className="w-full text-sm">
              {caption ? <caption className="sr-only">{caption}</caption> : null}
              <thead>
                {table.getHeaderGroups().map((group) => (
                  <tr key={group.id}>
                    {group.headers.map((header) => {
                      const col = byId.get(header.column.id);
                      const sorted = header.column.getIsSorted();
                      const canSort = header.column.getCanSort();
                      return (
                        <th
                          key={header.id}
                          scope="col"
                          aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined}
                          className={cn("border-b bg-muted px-3 py-2 font-medium whitespace-nowrap", ALIGN[col?.align ?? "start"], col?.className)}
                        >
                          {canSort ? (
                            <button
                              type="button"
                              onClick={header.column.getToggleSortingHandler()}
                              className="-mx-2 inline-flex min-h-11 min-w-11 items-center gap-1 rounded px-2 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                            >
                              {col?.header}
                              {sorted === "asc" ? (
                                <ArrowUpIcon aria-hidden="true" className="size-3.5" />
                              ) : sorted === "desc" ? (
                                <ArrowDownIcon aria-hidden="true" className="size-3.5" />
                              ) : (
                                <ArrowUpDownIcon aria-hidden="true" className="size-3.5 opacity-40" />
                              )}
                              <span className="sr-only">{t("sortHint")}</span>
                            </button>
                          ) : (
                            col?.header
                          )}
                        </th>
                      );
                    })}
                  </tr>
                ))}
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="transition-colors hover:bg-muted/40 [&:last-child>td]:border-b-0">
                    {columns.map((col) => (
                      <td key={col.id} className={cn("border-b px-3 py-2 align-middle", ALIGN[col.align ?? "start"], col.className)}>
                        {rowHref && col === primary ? (
                          <Link href={rowHref(row.original)} className="font-medium text-primary underline-offset-4 hover:underline">
                            {renderCell(col, row.original)}
                          </Link>
                        ) : (
                          renderCell(col, row.original)
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Phones: one card per row. */}
          <ul className="space-y-2 md:hidden">
            {rows.map((row) => {
              const body = mobileCard ? (
                mobileCard(row.original)
              ) : (
                <>
                  {primary ? <p className="font-medium">{renderCell(primary, row.original)}</p> : null}
                  <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                    {columns
                      .filter((c) => c !== primary && !c.hideOnMobile)
                      .map((c) => (
                        <div key={c.id} className="contents">
                          <dt className="text-muted-foreground">{c.header}</dt>
                          <dd className="min-w-0 text-end break-words">{renderCell(c, row.original)}</dd>
                        </div>
                      ))}
                  </dl>
                </>
              );
              return (
                <li key={row.id}>
                  {rowHref ? (
                    <Link
                      href={rowHref(row.original)}
                      className="block rounded-lg border bg-card p-3 shadow-xs transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                    >
                      {body}
                    </Link>
                  ) : (
                    <div className="rounded-lg border bg-card p-3 shadow-xs">{body}</div>
                  )}
                </li>
              );
            })}
          </ul>

          {pages > 1 || rowCount > pagination.pageSize ? (
            <nav aria-label={t("pagination")} className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <p className="text-muted-foreground tabular-nums" aria-live="polite">
                {t("showing", { from, to, total: rowCount })}
              </p>
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" size="icon" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()} aria-label={t("previous")}>
                  <ChevronLeftIcon aria-hidden="true" className="rtl:rotate-180" />
                </Button>
                <span className="min-w-20 text-center tabular-nums">{t("page", { page: pagination.pageIndex + 1, pages })}</span>
                <Button type="button" variant="outline" size="icon" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()} aria-label={t("next")}>
                  <ChevronRightIcon aria-hidden="true" className="rtl:rotate-180" />
                </Button>
              </div>
            </nav>
          ) : null}
        </>
      )}
    </div>
  );
}
