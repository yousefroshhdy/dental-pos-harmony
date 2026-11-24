"use client";

import { ClipboardListIcon } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import type { DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { CAIRO_DATE_TIME } from "../format";
import { FilterTabs } from "../kit/url-filters";
import { UrlDataTable } from "../kit/url-table";
import { ORDER_LIST } from "../lists";
import { STATUS_FILTERS, statusTone, toNumber, type StatusFilter } from "../logic";
import type { OrderRow } from "../types";

const FILTERS = Object.keys(STATUS_FILTERS) as StatusFilter[];

/** The orders list: status tabs, search, sortable columns, server pages; a card per order on phones. */
export function OrdersTable({
  rows,
  total,
  filter,
  error,
  emptyAction,
}: {
  rows: OrderRow[];
  total: number;
  filter: StatusFilter;
  error?: ReactNode;
  emptyAction?: ReactNode;
}) {
  const t = useTranslations("orders");
  const format = useFormatter();
  const money = (v: number | string) => format.number(toNumber(v), "egp");
  const when = (o: OrderRow) => format.dateTime(new Date(o.submitted_at ?? o.created_at), CAIRO_DATE_TIME);
  const number = (o: OrderRow) => (
    <span dir="ltr" className="whitespace-nowrap">
      {o.order_no ?? t("draftNo")}
    </span>
  );
  const status = (o: OrderRow) => <Badge tone={statusTone(o.status)}>{t(`status.${o.status}`)}</Badge>;
  const amount = (o: OrderRow) => (
    <span className="whitespace-nowrap tabular-nums">
      {money(o.total)}
      {o.status === "draft" ? <span className="block text-xs font-normal text-muted-foreground">{t("indicative")}</span> : null}
    </span>
  );

  const columns: DataTableColumn<OrderRow>[] = [
    { id: "number", header: t("list.columns.number"), accessor: (o) => o.order_no, cell: number, sortable: true, primary: true },
    { id: "customer", header: t("list.columns.customer"), accessor: (o) => o.customer_name, sortable: true, className: "min-w-40" },
    { id: "rep", header: t("list.columns.rep"), accessor: (o) => o.employee_name, sortable: true },
    { id: "status", header: t("list.columns.status"), accessor: (o) => o.status, cell: status, sortable: true },
    { id: "created", header: t("list.columns.date"), accessor: (o) => o.created_at, cell: (o) => <span className="whitespace-nowrap">{when(o)}</span>, sortable: true },
    { id: "total", header: t("list.columns.total"), accessor: (o) => toNumber(o.total), cell: amount, sortable: true, align: "end" },
  ];

  return (
    <div className="space-y-3">
      <FilterTabs name="status" label={t("list.filterLabel")} current={filter === "all" ? null : filter} items={FILTERS.map((f) => ({ value: f === "all" ? null : f, text: t(`filters.${f}`) }))} />
      <UrlDataTable
        spec={ORDER_LIST}
        rowCount={total}
        columns={columns}
        data={rows}
        getRowId={(o) => o.id}
        rowHref={(o) => `/orders/${o.id}`}
        searchPlaceholder={t("list.searchPlaceholder")}
        caption={t("list.title")}
        error={error}
        empty={
          <EmptyState
            icon={<ClipboardListIcon aria-hidden="true" />}
            title={filter === "all" ? t("list.empty") : t("list.emptyFiltered")}
            description={filter === "all" ? t("list.emptyHint") : undefined}
            action={filter === "all" ? emptyAction : undefined}
          />
        }
        mobileCard={(o) => (
          <div className="space-y-1">
            <div className="flex items-start justify-between gap-2">
              <span className="min-w-0 space-y-0.5">
                <span className="flex flex-wrap items-center gap-2 font-medium">
                  {number(o)}
                  {status(o)}
                </span>
                <span className="block truncate text-sm">{o.customer_name ?? "—"}</span>
              </span>
              <span className="text-end text-sm font-semibold">{amount(o)}</span>
            </div>
            <p className="text-xs text-muted-foreground">{[o.employee_name, when(o)].filter(Boolean).join(" · ")}</p>
          </div>
        )}
      />
    </div>
  );
}
