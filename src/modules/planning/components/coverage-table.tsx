"use client";

import { CalendarPlusIcon, MapPinnedIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { UrlDataTable } from "@/components/page-kit/url-data-table";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import type { DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { COVERAGE_TABLE } from "../tables";
import type { VisitClass } from "../types";
import { FrequencyForm } from "./frequency-form";

/** One customer's month, the dates formatted on the server. */
export interface CoverageListRow {
  customerId: string;
  customerNo: string;
  customerName: string;
  rep: string;
  visitClass: VisitClass;
  classIsDefault: boolean;
  /** "overdue" carries `overdueDays`; "never" is overdue and never visited. */
  state: "onTrack" | "overdue" | "never";
  overdueDays: number;
  lastVisit: string;
  lastVisitOn: string | null;
  actual: number;
  target: number;
  pct: number;
  targetMet: boolean;
  nextPlanned: string | null;
  /** Link to plan a visit (managers, when nothing is planned yet). */
  planHref: string | null;
}

export function CoverageTable({
  rows,
  rowCount,
  filters,
  error,
  canEdit,
  overdueOnly,
}: {
  rows: CoverageListRow[];
  rowCount: number;
  filters?: ReactNode;
  error?: ReactNode;
  canEdit: boolean;
  overdueOnly: boolean;
}) {
  const t = useTranslations("planning");

  const stateBadge = (r: CoverageListRow) =>
    r.state === "onTrack" ? (
      <Badge tone="success">{t("coverage.onTrack")}</Badge>
    ) : r.state === "never" ? (
      <Badge tone="danger">{t("coverage.neverVisited")}</Badge>
    ) : (
      <Badge tone="danger">{t("coverage.overdueBy", { count: r.overdueDays })}</Badge>
    );

  const progress = (r: CoverageListRow) => (
    <span className="flex min-w-32 flex-col gap-1">
      <span className="text-sm tabular-nums">
        {t("coverage.visitsOfTarget", { actual: r.actual, target: r.target })}
        <span className="sr-only"> ({r.pct}%)</span>
      </span>
      <span
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label={t("coverage.thisMonth")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={r.pct}
      >
        <span className={cn("block h-full", r.targetMet ? "bg-success" : "bg-warning")} style={{ inlineSize: `${r.pct}%` }} />
      </span>
    </span>
  );

  const columns: DataTableColumn<CoverageListRow>[] = [
    {
      id: "customer_name",
      header: t("coverageTable.customer"),
      sortable: true,
      primary: true,
      accessor: (r) => r.customerName,
      cell: (r) => (
        <span className="inline-flex flex-col">
          <span className="font-medium">{r.customerName}</span>
          <span className="text-xs text-muted-foreground">
            <span dir="ltr">{r.customerNo}</span> · {r.rep}
          </span>
        </span>
      ),
    },
    { id: "status", header: t("coverageTable.status"), cell: stateBadge },
    {
      id: "class",
      header: t("coverage.class"),
      cell: (r) =>
        canEdit ? (
          <FrequencyForm customerId={r.customerId} customerName={r.customerName} current={r.visitClass} />
        ) : (
          <span>
            {t(`class.${r.visitClass}`)}
            {r.classIsDefault ? <span className="ms-1 text-xs text-muted-foreground">{t("coverage.defaultClass")}</span> : null}
          </span>
        ),
    },
    { id: "last_visit_on", header: t("coverage.lastVisit"), sortable: true, accessor: (r) => r.lastVisitOn, cell: (r) => r.lastVisit },
    { id: "month", header: t("coverage.thisMonth"), cell: progress },
    {
      id: "next_planned_on",
      header: t("coverage.nextPlanned"),
      sortable: true,
      accessor: (r) => r.nextPlanned,
      cell: (r) =>
        r.nextPlanned ? (
          r.nextPlanned
        ) : r.planHref ? (
          <Link href={r.planHref} className={buttonVariants({ variant: "outline", size: "sm", className: "min-h-11" })}>
            <CalendarPlusIcon aria-hidden="true" />
            {t("coverage.plan")}
          </Link>
        ) : (
          <span className="text-muted-foreground">{t("coverage.notPlanned")}</span>
        ),
    },
  ];

  return (
    <UrlDataTable
      options={COVERAGE_TABLE}
      rowCount={rowCount}
      columns={columns}
      data={rows}
      getRowId={(r) => r.customerId}
      searchPlaceholder={t("coverageTable.search")}
      filters={filters}
      error={error}
      caption={t("coverage.title")}
      mobileCard={(r) => (
        <div className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate font-medium">{r.customerName}</p>
              <p className="text-xs text-muted-foreground">
                <span dir="ltr">{r.customerNo}</span> · {r.rep}
              </p>
            </div>
            {stateBadge(r)}
          </div>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted-foreground">{t("coverage.lastVisit")}</dt>
            <dd>{r.lastVisit}</dd>
            <dt className="text-muted-foreground">{t("coverage.nextPlanned")}</dt>
            <dd>{r.nextPlanned ?? t("coverage.notPlanned")}</dd>
          </dl>
          {progress(r)}
          <div className="flex flex-wrap items-end justify-between gap-3">
            {canEdit ? (
              <FrequencyForm customerId={r.customerId} customerName={r.customerName} current={r.visitClass} />
            ) : (
              <span className="text-sm">{t(`class.${r.visitClass}`)}</span>
            )}
            {!r.nextPlanned && r.planHref ? (
              <Link href={r.planHref} className={buttonVariants({ variant: "outline", size: "sm", className: "min-h-11" })}>
                {t("coverage.plan")}
              </Link>
            ) : null}
          </div>
        </div>
      )}
      empty={
        <EmptyState icon={<MapPinnedIcon aria-hidden="true" />} title={overdueOnly ? t("coverage.emptyOverdue") : t("coverage.empty")} />
      }
    />
  );
}
