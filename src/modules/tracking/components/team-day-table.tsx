"use client";

import { RouteIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";

/**
 * One rep's working day, every value formatted on the server (durations, km, Cairo
 * times). api.tracking_team_day returns the whole team at once (tens of reps), so
 * the table sorts, searches and pages in the browser; flagged rows come first.
 */
export interface TeamDayListRow {
  employeeId: string;
  name: string;
  href: string;
  onShift: "yes" | "no" | "notStarted";
  shift: string;
  shiftSeconds: number;
  visits: number;
  visitTime: string;
  idle: string;
  gaps: string;
  distance: string;
  distanceM: number;
  lastSeen: string;
  lastSeenAt: string | null;
  flagged: boolean;
  flags: string[];
  summaryOnly: boolean;
}

export function TeamDayTable({ rows, error, filters }: { rows: TeamDayListRow[]; error?: ReactNode; filters?: ReactNode }) {
  const t = useTranslations("tracking");

  const shiftBadge = (r: TeamDayListRow) =>
    r.onShift === "yes" ? <Badge tone="success">{t("team.yes")}</Badge> : r.onShift === "notStarted" ? <Badge>{t("team.notStarted")}</Badge> : <Badge>{t("team.no")}</Badge>;
  const flagBadges = (r: TeamDayListRow) =>
    r.flags.length > 0 || r.summaryOnly ? (
      <span className="flex flex-wrap gap-1">
        {r.flags.map((f) => (
          <Badge key={f} tone="warning">
            {t(`flags.${f}`)}
          </Badge>
        ))}
        {r.summaryOnly ? <Badge tone="info">{t("team.summaryOnly")}</Badge> : null}
      </span>
    ) : null;

  const columns: DataTableColumn<TeamDayListRow>[] = [
    {
      id: "name",
      header: t("team.rep"),
      primary: true,
      sortable: true,
      searchable: true,
      accessor: (r) => r.name,
      cell: (r) => (
        <span className="inline-flex flex-col gap-1">
          <span className={cn(r.flagged && "font-semibold")}>{r.name}</span>
          {flagBadges(r)}
        </span>
      ),
    },
    { id: "onShift", header: t("team.onShift"), cell: shiftBadge },
    { id: "shift", header: t("team.shiftTime"), sortable: true, accessor: (r) => r.shiftSeconds, cell: (r) => <span className="whitespace-nowrap">{r.shift}</span> },
    { id: "visits", header: t("team.visits"), sortable: true, align: "end", accessor: (r) => r.visits },
    { id: "visitTime", header: t("team.visitTime"), cell: (r) => <span className="whitespace-nowrap">{r.visitTime}</span> },
    { id: "idle", header: t("team.idle"), cell: (r) => <span className="whitespace-nowrap">{r.idle}</span> },
    { id: "gaps", header: t("team.gaps"), cell: (r) => <span className="whitespace-nowrap">{r.gaps}</span> },
    { id: "distance", header: t("team.distance"), sortable: true, accessor: (r) => r.distanceM, cell: (r) => <span className="whitespace-nowrap">{r.distance}</span> },
    { id: "lastSeen", header: t("team.lastSeen"), sortable: true, accessor: (r) => r.lastSeenAt, cell: (r) => <span className="whitespace-nowrap">{r.lastSeen}</span> },
  ];

  return (
    <DataTable
      columns={columns}
      data={rows}
      getRowId={(r) => r.employeeId}
      rowHref={(r) => r.href}
      searchPlaceholder={t("teamTable.search")}
      filters={filters}
      error={error}
      caption={t("team.title")}
      mobileCard={(r) => (
        <div className={cn("space-y-2", r.flagged && "-m-3 rounded-lg bg-warning/10 p-3")}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <p className="font-medium text-primary">{r.name}</p>
            {shiftBadge(r)}
          </div>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted-foreground">{t("team.shiftTime")}</dt>
            <dd>{r.shift}</dd>
            <dt className="text-muted-foreground">{t("team.visits")}</dt>
            <dd>
              {r.visits} · {r.visitTime}
            </dd>
            <dt className="text-muted-foreground">{t("team.idle")}</dt>
            <dd>{r.idle}</dd>
            <dt className="text-muted-foreground">{t("team.gaps")}</dt>
            <dd>{r.gaps}</dd>
            <dt className="text-muted-foreground">{t("team.distance")}</dt>
            <dd>{r.distance}</dd>
            <dt className="text-muted-foreground">{t("team.lastSeen")}</dt>
            <dd>{r.lastSeen}</dd>
          </dl>
          {flagBadges(r)}
        </div>
      )}
      empty={<EmptyState icon={<RouteIcon aria-hidden="true" />} title={t("team.empty")} />}
    />
  );
}

