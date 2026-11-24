"use client";

import { useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { usePathname, useRouter } from "@/i18n/navigation";
import { readTableParams, tableStateToQuery, type TableParamOptions, type TableState } from "./data-table-params";

/**
 * Server-side DataTable state in the URL. The server page reads the same params with
 * `readTableParams(searchParams, options)`, fetches that page (offset/limit, order,
 * search) and passes `rowCount`; this hook turns table changes into a navigation:
 *
 *   const url = useUrlTableState({ pageSize: 25, sortable: ["display_name", "created_at"] });
 *   <DataTable server={{ rowCount: total, ...url }} loading={url.pending} … />
 */
export function useUrlTableState(options: TableParamOptions = {}): {
  state: TableState;
  onStateChange: (state: TableState) => void;
  pending: boolean;
} {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const parsed = readTableParams(new URLSearchParams(searchParams.toString()), options);
  const state: TableState = { pageIndex: parsed.pageIndex, pageSize: parsed.pageSize, sorting: parsed.sorting, search: parsed.search };

  const onStateChange = (next: TableState) => {
    const query = tableStateToQuery(next, new URLSearchParams(searchParams.toString())).toString();
    startTransition(() => router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false }));
  };
  return { state, onStateChange, pending };
}
