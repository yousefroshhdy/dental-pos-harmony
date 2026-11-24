"use client";

import { TagsIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import type { PriceListKind } from "../types";

export interface PriceListListRow {
  id: string;
  code: string;
  name: string;
  kind: PriceListKind;
  kindTone: BadgeTone;
  isDefault: boolean;
  /** "current" | "notInForce" | "inactive" */
  state: "current" | "notInForce" | "inactive";
  priority: number;
  validity: string;
  items: number;
  customers: number | null;
}

/** Price lists (tens, not thousands): searched, sorted and paged in the browser. */
export function PriceListsTable({ rows, error }: { rows: PriceListListRow[]; error?: ReactNode }) {
  const t = useTranslations("catalog.priceList");

  const columns: DataTableColumn<PriceListListRow>[] = [
    {
      id: "name",
      header: t("name"),
      sortable: true,
      searchable: true,
      primary: true,
      accessor: (r) => r.name,
    },
    {
      id: "code",
      header: t("code"),
      sortable: true,
      searchable: true,
      accessor: (r) => r.code,
      cell: (r) => (
        <code dir="ltr" className="text-xs">
          {r.code}
        </code>
      ),
    },
    {
      id: "kind",
      header: t("kind"),
      accessor: (r) => r.kind,
      cell: (r) => (
        <span className="flex flex-wrap gap-1">
          <Badge tone={r.kindTone}>{t(`kinds.${r.kind}`)}</Badge>
          {r.isDefault ? <Badge tone="info">{t("default")}</Badge> : null}
          <Badge tone={r.state === "current" ? "success" : "neutral"}>{t(r.state)}</Badge>
        </span>
      ),
    },
    { id: "priority", header: t("priority"), sortable: true, align: "end", accessor: (r) => r.priority },
    { id: "validity", header: t("validity"), accessor: (r) => r.validity, className: "whitespace-nowrap" },
    { id: "items", header: t("items"), sortable: true, align: "end", accessor: (r) => r.items },
    { id: "customers", header: t("customersCount"), align: "end", accessor: (r) => r.customers },
  ];

  return (
    <DataTable
      columns={columns}
      data={rows}
      getRowId={(r) => r.id}
      rowHref={(r) => `/catalog/price-lists/${r.id}`}
      error={error}
      caption={t("listTitle")}
      empty={<EmptyState icon={<TagsIcon aria-hidden="true" />} title={t("empty")} />}
    />
  );
}
