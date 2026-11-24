"use client";

import type { RowData } from "@tanstack/react-table";
import { DataTable, type DataTableProps } from "@/components/ui/data-table";
import { useUrlTableState } from "@/components/ui/use-url-table-state";
import { tableOptions, type ListSpec } from "./paging";

/**
 * A server-paginated DataTable whose page, sort and search live in the URL. The
 * server page reads the same URL with `pageRequest(searchParams, spec)`, fetches
 * that window and passes `rowCount`; changing page/sort/search navigates and the
 * table shows its skeleton until the new rows arrive.
 */
export function UrlDataTable<TData extends RowData>({
  spec,
  rowCount,
  ...props
}: Omit<DataTableProps<TData>, "server" | "loading" | "pageSize"> & { spec: ListSpec; rowCount: number }) {
  const url = useUrlTableState(tableOptions(spec));
  return <DataTable {...props} searchable={props.searchable ?? Boolean(spec.searchColumns?.length)} server={{ rowCount, state: url.state, onStateChange: url.onStateChange }} loading={url.pending} />;
}
