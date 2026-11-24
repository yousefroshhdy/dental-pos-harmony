import type { Metadata } from "next";
import { getFormatter, getLocale, getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { Button, buttonVariants } from "@/components/ui/button";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { FilterChips } from "@/components/page-kit/filter-chips";
import { FormDatePicker } from "@/components/page-kit/form-controls";
import { FormField } from "@/components/ui/form-field";
import { PageHeader } from "@/components/ui/page-header";
import { Alert } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { getUserContext } from "@/lib/authz/context";
import { PageBody } from "@/modules/field/components/layout-bits";
import { localizedName } from "@/modules/field/logic";
import { TrackingHealthPanel } from "@/modules/tracking/components/health-panel";
import { TeamDayTable, type TeamDayListRow } from "@/modules/tracking/components/team-day-table";
import { CAIRO_DATE_LONG, CAIRO_TIME, dayAsDate, formatDuration, formatKm } from "@/modules/tracking/format";
import { addDays, cairoToday, canReadTracking, dayFlags, isRowFlagged, parseDay, sortTeamRows, trackingErrorCode } from "@/modules/tracking/logic";
import { getTeamDay } from "@/modules/tracking/queries";
import { ExportCsvButton } from "@/modules/reports/components/export-csv-button";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "tracking.team" });
  return { title: t("title") };
}

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Managers: the team's working day (api.tracking_team_day). One row per rep in the
 * caller's field.tracking.read scope; rows with an idle stop, a gap, an anomaly or an
 * auto-closed day are highlighted and listed first. Signals to review, not penalties.
 */
export default async function TrackingTeamPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: SearchParams }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!canReadTracking(ctx)) return <Forbidden />;

  const sp = await searchParams;
  const today = cairoToday();
  const day = parseDay(sp.date) ?? today;
  const t = await getTranslations("tracking");
  const tErrors = await getTranslations("errors");
  const format = await getFormatter();
  const lang = await getLocale();

  const result = await getTeamDay(day);
  const rows = result.ok ? sortTeamRows(result.data, lang) : [];
  const flagged = rows.filter(isRowFlagged).length;

  const flaggedOnly = sp.flagged === "1";
  const time = (iso: string | null) => (iso ? format.dateTime(new Date(iso), CAIRO_TIME) : t("team.none"));
  const tableRows: TeamDayListRow[] = rows
    .filter((r) => !flaggedOnly || isRowFlagged(r))
    .map((r) => ({
      employeeId: r.employee_id,
      name: localizedName(lang, r.full_name_en, r.full_name_ar),
      href: `/tracking/${r.employee_id}/${day}`,
      onShift: r.on_shift ? "yes" : r.shift_count === 0 ? "notStarted" : "no",
      shift: formatDuration(t, r.shift_seconds),
      shiftSeconds: r.shift_seconds,
      visits: r.visit_count,
      visitTime: formatDuration(t, r.visit_seconds),
      idle: r.idle_stop_count > 0 ? formatDuration(t, r.idle_stop_seconds) : t("team.none"),
      gaps: r.gap_count > 0 ? t("team.gapsValue", { count: String(r.gap_count), duration: formatDuration(t, r.gap_seconds) }) : t("team.none"),
      distance: formatKm(t, r.distance_m),
      distanceM: Number(r.distance_m ?? 0),
      lastSeen: time(r.last_ping_at),
      lastSeenAt: r.last_ping_at,
      flagged: isRowFlagged(r),
      flags: dayFlags(r.flags),
      summaryOnly: r.from_summary,
    }));

  return (
    <PageBody>
      <PageHeader
        title={t("team.title")}
        description={t("team.subtitle")}
        actions={<ExportCsvButton ctx={ctx} kind="tracking" filters={{ date: day }} label={t("team.export")} />}
      />

      <div className="flex flex-col gap-3 rounded-lg border bg-card p-3 shadow-sm sm:flex-row sm:items-end sm:justify-between">
        <form method="get" className="flex flex-wrap items-end gap-2">
          <FormField label={t("team.date")} className="min-w-48">
            <FormDatePicker name="date" defaultValue={day} max={today} placeholder={t("team.date")} />
          </FormField>
          {flaggedOnly ? <input type="hidden" name="flagged" value="1" /> : null}
          <Button type="submit" variant="outline">
            {t("team.show")}
          </Button>
        </form>
        <nav aria-label={t("team.date")} className="flex flex-wrap gap-2">
          <Link href={`/tracking?date=${addDays(day, -1)}`} className={buttonVariants({ variant: "outline" })}>
            <ChevronRightIcon aria-hidden="true" className="ltr:rotate-180" />
            {t("team.prevDay")}
          </Link>
          {day !== today ? (
            <Link href="/tracking" className={buttonVariants({ variant: "outline" })}>
              {t("team.today")}
            </Link>
          ) : null}
          {day < today ? (
            <Link href={`/tracking?date=${addDays(day, 1)}`} className={buttonVariants({ variant: "outline" })}>
              {t("team.nextDay")}
              <ChevronLeftIcon aria-hidden="true" className="ltr:rotate-180" />
            </Link>
          ) : null}
        </nav>
      </div>

      {/* Phase P step 5: is tracking working on each phone right now? (today only) */}
      {day === today ? <TrackingHealthPanel /> : null}

      <section aria-labelledby="tracking-day" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="tracking-day" className="text-lg font-semibold">
            {format.dateTime(dayAsDate(day), CAIRO_DATE_LONG)}
          </h2>
          {result.ok && rows.length > 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("team.count", { count: rows.length })} · {t("team.flaggedCount", { count: flagged })}
            </p>
          ) : null}
        </div>
        <TeamDayTable
          rows={tableRows}
          error={
            result.ok ? undefined : (
              <Alert>
                {trackingErrorCode(result.error.code)
                  ? t(`errors.${trackingErrorCode(result.error.code)}`)
                  : tErrors(result.error.messageKey, { requestId: result.error.requestId ?? "—" })}
              </Alert>
            )
          }
          filters={
            <FilterChips
              label={t("teamTable.filter")}
              pathname="/tracking"
              params={sp}
              param="flagged"
              current={flaggedOnly ? "1" : null}
              options={[
                { value: null, label: t("teamTable.everyone"), count: rows.length },
                { value: "1", label: t("teamTable.flaggedOnly"), count: flagged },
              ]}
            />
          }
        />
      </section>
    </PageBody>
  );
}
