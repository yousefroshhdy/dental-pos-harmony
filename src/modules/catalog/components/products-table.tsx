"use client";

import { PackageIcon, PlusIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { UrlDataTable } from "@/components/page-kit/url-data-table";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import type { DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Link } from "@/i18n/navigation";
import { PRODUCTS_TABLE } from "../tables";
import type { ProductStatus } from "../types";

export interface ProductListRow {
  id: string;
  code: string;
  name: string;
  brand: string;
  category: string;
  status: ProductStatus;
  statusTone: BadgeTone;
  variants: number;
  activeVariants: number;
  /** Formatted on the server; null when prices are hidden from this viewer. */
  price: string | null;
}

export function ProductsTable({
  rows,
  rowCount,
  filters,
  error,
  canCreate,
  showPrices,
  filtered,
}: {
  rows: ProductListRow[];
  rowCount: number;
  filters?: ReactNode;
  error?: ReactNode;
  canCreate: boolean;
  showPrices: boolean;
  filtered: boolean;
}) {
  const t = useTranslations("catalog.products");
  const tStatus = useTranslations("catalog.product.status");
  const tl = useTranslations("catalog.list");

  const columns: DataTableColumn<ProductListRow>[] = [
    {
      id: "name",
      header: tl("product"),
      sortable: true,
      primary: true,
      accessor: (r) => r.name,
      cell: (r) => <span className="break-words">{r.name}</span>,
    },
    {
      id: "code",
      header: tl("code"),
      sortable: true,
      accessor: (r) => r.code,
      cell: (r) => (
        <code dir="ltr" className="text-xs">
          {r.code}
        </code>
      ),
    },
    { id: "brand", header: t("brand"), sortable: true, accessor: (r) => r.brand },
    { id: "category", header: tl("category"), accessor: (r) => r.category },
    {
      id: "variants",
      header: tl("variants"),
      align: "end",
      accessor: (r) => r.variants,
      cell: (r) => (
        <span className="tabular-nums">
          {r.activeVariants === r.variants ? r.variants : tl("activeOf", { active: r.activeVariants, total: r.variants })}
        </span>
      ),
    },
    ...(showPrices
      ? [
          {
            id: "price",
            header: tl("price"),
            align: "end",
            cell: (r: ProductListRow) => <span className="whitespace-nowrap tabular-nums">{r.price ?? t("noPrice")}</span>,
          } satisfies DataTableColumn<ProductListRow>,
        ]
      : []),
    {
      id: "status",
      header: t("status"),
      sortable: true,
      accessor: (r) => r.status,
      cell: (r) => <Badge tone={r.statusTone}>{tStatus(r.status)}</Badge>,
    },
  ];

  return (
    <UrlDataTable
      options={PRODUCTS_TABLE}
      rowCount={rowCount}
      columns={columns}
      data={rows}
      getRowId={(r) => r.id}
      rowHref={(r) => `/catalog/products/${r.id}`}
      searchPlaceholder={t("searchPlaceholder")}
      filters={filters}
      error={error}
      caption={t("listLabel")}
      empty={
        <EmptyState
          icon={<PackageIcon aria-hidden="true" />}
          title={filtered ? t("noMatch") : t("empty")}
          description={filtered ? undefined : tl("emptyHint")}
          action={
            canCreate && !filtered ? (
              <Link href="/catalog/products/new" className={buttonVariants()}>
                <PlusIcon aria-hidden="true" />
                {t("new")}
              </Link>
            ) : undefined
          }
        />
      }
    />
  );
}
