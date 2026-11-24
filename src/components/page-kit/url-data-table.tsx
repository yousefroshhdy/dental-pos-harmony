"use client";

import type { RowData } from "@tanstack/react-table";
import { DataTable, type DataTableProps } from "@/components/ui/data-table";
import type { TableParamOptions } from "@/components/ui/data-table-params";
import { useUrlTableState } from "@/components/ui/use-url-table-state";

/**
 * DataTable in server mode, its page, sort and search kept in the URL. The server
 * page reads the same `options` with `readTableParams` and passes one page of
 * rows plus the exact `rowCount`. Define the options once (a plain module both
 * sides import) so the two never disagree.
 */
export function UrlDataTable<TData extends RowData>({
  options,
  rowCount,
  ...props
}: Omit<DataTableProps<TData>, "server" | "loading" | "pageSize"> & { options: TableParamOptions; rowCount: number }) {
  const url = useUrlTableState(options);
  return <DataTable {...props} server={{ rowCount, state: url.state, onStateChange: url.onStateChange }} loading={url.pending} />;
}
