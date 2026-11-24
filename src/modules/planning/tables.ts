import type { TableParamOptions } from "@/components/ui/data-table-params";

/**
 * Coverage as a server-paged table (Phase P step 2b). The default order is the
 * worklist order: overdue first (never visited at the top), then by how late,
 * then by name.
 */
export const COVERAGE_TABLE = {
  pageSize: 25,
  sortable: ["customer_name", "last_visit_on", "overdue_days", "next_planned_on"],
} as const satisfies TableParamOptions;

export const COVERAGE_SEARCH_COLUMNS = ["customer_name", "customer_no"] as const;

export interface OrderTerm {
  column: string;
  ascending: boolean;
  nullsFirst: boolean;
}

/** PostgREST order terms for a coverage page; the user's sort, else the worklist order. Always ends on a unique key. */
export function coverageOrder(sort: { id: string; desc: boolean } | undefined): OrderTerm[] {
  const tail: OrderTerm = { column: "customer_id", ascending: true, nullsFirst: false };
  if (sort && (COVERAGE_TABLE.sortable as readonly string[]).includes(sort.id)) {
    // Never-visited / unplanned rows (null dates) sort as the oldest.
    return [{ column: sort.id, ascending: !sort.desc, nullsFirst: !sort.desc }, tail];
  }
  return [
    { column: "is_overdue", ascending: false, nullsFirst: false },
    { column: "overdue_days", ascending: false, nullsFirst: true },
    { column: "customer_name", ascending: true, nullsFirst: false },
    tail,
  ];
}
