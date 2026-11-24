"use client";

import { Undo2Icon } from "lucide-react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import type { DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterTabs } from "@/modules/orders/kit/url-filters";
import { UrlDataTable } from "@/modules/orders/kit/url-table";
import { CAIRO_DATE_TIME, QUANTITY } from "../format";
import { RETURN_LIST } from "../lists";
import { localizedName, STATUS_FILTERS, statusTone, toNumber, type StatusFilter } from "../logic";
import type { ReturnRow } from "../types";

const FILTERS = Object.keys(STATUS_FILTERS) as StatusFilter[];

/** The returns list: status tabs, search, sortable columns, server pages; a card per return on phones. */
export function ReturnsTable({
  rows,
  total,
  filter,
  error,
  emptyAction,
}: {
  rows: ReturnRow[];
  total: number;
  filter: StatusFilter;
  error?: ReactNode;
  emptyAction?: ReactNode;
}) {
  const t = useTranslations("returns");
  const locale = useLocale();
  const format = useFormatter();
  const when = (r: ReturnRow) => format.dateTime(new Date(r.created_at), CAIRO_DATE_TIME);
  const number = (r: ReturnRow) => (
    <span dir="ltr" className="whitespace-nowrap">
      {r.return_no}
    </span>
  );
  const status = (r: ReturnRow) => <Badge tone={statusTone(r.status)}>{t(`status.${r.status}`)}</Badge>;
  // A credited return shows its credit notes' total; before that, the estimate at the order's prices.
  const amount = (r: ReturnRow) => (
    <span className="whitespace-nowrap tabular-nums">
      <span className="block font-semibold">{format.number(toNumber(r.status === "credited" ? r.credited_total : r.estimated_total), "egp")}</span>
      {r.status === "credited" ? null : <span className="block text-xs font-normal text-muted-foreground">{t("list.estimate")}</span>}
    </span>
  );
  const units = (r: ReturnRow) => t("list.units", { count: r.total_qty, formatted: format.number(r.total_qty, QUANTITY) });

  const columns: DataTableColumn<ReturnRow>[] = [
    { id: "number", header: t("list.columns.number"), accessor: (r) => r.return_no, cell: number, sortable: true, primary: true },
    { id: "customer", header: t("list.columns.customer"), accessor: (r) => r.customer_name, sortable: true, className: "min-w-40" },
    { id: "order", header: t("list.columns.order"), accessor: (r) => r.order_no, cell: (r) => <span dir="ltr">{r.order_no ?? "—"}</span>, sortable: true },
    { id: "status", header: t("list.columns.status"), accessor: (r) => r.status, cell: status, sortable: true },
    { id: "rep", header: t("list.columns.rep"), accessor: (r) => localizedName(locale, r.rep_name_en, r.rep_name_ar) || null },
    { id: "created", header: t("list.columns.date"), accessor: (r) => r.created_at, cell: (r) => <span className="whitespace-nowrap">{when(r)}</span>, sortable: true },
    { id: "units", header: t("list.columns.units"), accessor: (r) => r.total_qty, cell: (r) => <span className="tabular-nums">{units(r)}</span>, sortable: true, align: "end" },
    { id: "amount", header: t("list.columns.amount"), cell: amount, align: "end" },
  ];

  return (
    <div className="space-y-3">
      <FilterTabs name="status" label={t("list.filterLabel")} current={filter === "all" ? null : filter} items={FILTERS.map((f) => ({ value: f === "all" ? null : f, text: t(`filters.${f}`) }))} />
      <UrlDataTable
        spec={RETURN_LIST}
        rowCount={total}
        columns={columns}
        data={rows}
        getRowId={(r) => r.id}
        rowHref={(r) => `/returns/${r.id}`}
        searchPlaceholder={t("list.searchPlaceholder")}
        caption={t("list.title")}
        error={error}
        empty={
          <EmptyState
            icon={<Undo2Icon aria-hidden="true" />}
            title={filter === "all" ? t("list.empty") : t("list.emptyFiltered")}
            description={filter === "all" ? t("list.emptyHint") : undefined}
            action={filter === "all" ? emptyAction : undefined}
          />
        }
        mobileCard={(r) => (
          <div className="space-y-1">
            <div className="flex items-start justify-between gap-2">
              <span className="min-w-0 space-y-0.5">
                <span className="flex flex-wrap items-center gap-2 font-medium">
                  {number(r)}
                  {status(r)}
                </span>
                <span className="block truncate text-sm">{r.customer_name ?? "—"}</span>
              </span>
              <span className="text-end text-sm">
                {amount(r)}
                <span className="block text-xs text-muted-foreground">{units(r)}</span>
              </span>
            </div>
            <p className="text-xs text-muted-foreground">{[r.order_no, localizedName(locale, r.rep_name_en, r.rep_name_ar) || null, when(r)].filter(Boolean).join(" · ")}</p>
          </div>
        )}
      />
    </div>
  );
}
