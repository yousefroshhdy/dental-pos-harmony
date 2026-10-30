import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { buttonVariants } from "@/components/ui/button";
import { Alert, Badge, Card } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { getUserContext } from "@/lib/authz/context";
import { cn } from "@/lib/utils";
import { Empty, PageBody, Section } from "@/modules/field/components/layout-bits";
import { localizedName } from "@/modules/field/logic";
import { CAIRO_DATE_LONG, CAIRO_TIME, dayAsDate, formatDuration, formatKm } from "@/modules/tracking/format";
import { addDays, cairoToday, canOpenDay, canReadTracking, dayView, mapsUrl, trackingErrorCode, type TimelineEntry } from "@/modules/tracking/logic";
import { getTrackingDay } from "@/modules/tracking/queries";
import { dayParamsSchema } from "@/modules/tracking/schemas";
import { PING_FLAGS } from "@/modules/tracking/types";

type Params = Promise<{ locale: string; employeeId: string; date: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "tracking.day" });
  return { title: t("timeline") };
}

/**
 * One rep's Cairo day (api.tracking_day): totals, the timeline (shift → visits,
 * stops and gaps in order, with durations) and the point list. Each point and stop
 * opens in Google Maps (no map library). A rep may open their own day; others need
 * field.tracking.read covering the rep (the database decides; 42501 → Forbidden).
 * Once the retention purge has summarized the day, only the stored summary is shown,
 * labelled as such (dayView); a long point list is capped by the server and says so.
 */
export default async function TrackingDayPage({ params }: { params: Params }) {
  const { locale, employeeId, date } = await params;
  setRequestLocale(locale);
  const parsed = dayParamsSchema.safeParse({ employeeId, date });
  if (!parsed.success) notFound();
  const ctx = await getUserContext();
  if (!canOpenDay(ctx, parsed.data.employeeId)) return <Forbidden />;

  const day = parsed.data.date;
  const t = await getTranslations("tracking");
  const tErrors = await getTranslations("errors");
  const format = await getFormatter();
  const lang = await getLocale();
  const result = await getTrackingDay(parsed.data.employeeId, day);

  if (!result.ok) {
    if (result.error.code === "PERMISSION_DENIED") return <Forbidden />;
    if (result.error.code === "NOT_FOUND") notFound();
    const own = trackingErrorCode(result.error.code);
    return (
      <PageBody>
        <Alert>{own ? t(`errors.${own}`) : tErrors(result.error.messageKey, { requestId: result.error.requestId ?? "—" })}</Alert>
      </PageBody>
    );
  }
  const data = result.data;
  if (!data) notFound();

  const name = localizedName(lang, data.employee.full_name_en, data.employee.full_name_ar);
  const time = (iso: string | null | undefined) => (iso ? format.dateTime(new Date(iso), CAIRO_TIME) : "…");
  const range = (from: string, to: string | null) => t("timeline.range", { from: time(from), to: to ? time(to) : "…" });
  const today = cairoToday();
  const base = `/tracking/${data.employee_id}`;
  const view = dayView(data);
  const timeline = view.timeline;
  const isManager = canReadTracking(ctx);

  const mapLink = (lat: number | string, lng: number | string) => (
    <a
      href={mapsUrl(lat, lng)}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline"
    >
      {t("day.openMap")}
    </a>
  );

  const entry = (e: TimelineEntry, i: number) => {
    switch (e.kind) {
      case "shift_start":
        return (
          <li key={i} className="rounded-lg border bg-card p-3">
            <p className="font-medium">{t("timeline.shiftStart")}</p>
            <p className="text-sm text-muted-foreground">{time(e.shift.start_at)}</p>
            {e.shift.start_lat !== null && e.shift.start_lng !== null ? mapLink(e.shift.start_lat, e.shift.start_lng) : null}
          </li>
        );
      case "shift_end":
        return (
          <li key={i} className="rounded-lg border bg-card p-3">
            <p className="font-medium">{e.shift.status === "auto_closed" ? t("timeline.shiftAutoClosed") : t("timeline.shiftEnd")}</p>
            <p className="text-sm text-muted-foreground">
              {time(e.shift.end_at)} · {formatDuration(t, e.shift.seconds)}
            </p>
            {e.shift.end_lat !== null && e.shift.end_lng !== null ? mapLink(e.shift.end_lat, e.shift.end_lng) : null}
          </li>
        );
      case "visit":
        return (
          <li key={i} className="rounded-lg border border-primary/30 bg-primary/5 p-3">
            <p className="font-medium">
              {e.visit.open ? t("timeline.visitOpen") : t("timeline.visit")}: {e.visit.customer_name ?? t("timeline.unnamedCustomer")}
            </p>
            <p className="text-sm text-muted-foreground">
              {range(e.visit.start_at, e.visit.end_at)} · {formatDuration(t, e.visit.seconds)}
            </p>
          </li>
        );
      case "stop":
        return (
          <li key={i} className={cn("rounded-lg border p-3", e.stop.flagged ? "border-warning bg-warning/10" : "bg-card")}>
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-medium">{e.stop.flagged ? t("timeline.stopFlagged") : t("timeline.stop")}</p>
              {e.stop.in_visit ? <Badge tone="info">{t("timeline.inVisit")}</Badge> : null}
              {e.stop.near_customer ? <Badge tone="info">{t("timeline.nearCustomer")}</Badge> : null}
            </div>
            <p className="text-sm text-muted-foreground">
              {range(e.stop.start_at, e.stop.end_at)} · {formatDuration(t, e.stop.seconds)}
            </p>
            {mapLink(e.stop.lat, e.stop.lng)}
          </li>
        );
      case "gap":
        return (
          <li key={i} className="rounded-lg border border-dashed p-3">
            <p className="font-medium">{e.gap.ongoing ? t("timeline.gapOngoing") : t("timeline.gap")}</p>
            <p className="text-sm text-muted-foreground">
              {range(e.gap.start_at, e.gap.ongoing ? null : e.gap.end_at)} · {formatDuration(t, e.gap.seconds)}
            </p>
          </li>
        );
    }
  };

  const stats: [string, string][] = [
    [t("day.shiftTime"), formatDuration(t, view.figures.shift_seconds)],
    [t("day.visits"), String(view.figures.visit_count)],
    [t("day.visitTime"), formatDuration(t, view.figures.visit_seconds)],
    [t("day.idle"), formatDuration(t, view.figures.idle_stop_seconds)],
    [t("day.gaps"), formatDuration(t, view.figures.gap_seconds)],
    [t("day.distance"), formatKm(t, view.figures.distance_m)],
  ];

  return (
    <PageBody>
      <div className="space-y-1">
        {isManager ? (
          <Link href={`/tracking?date=${day}`} className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline">
            {t("day.back")}
          </Link>
        ) : null}
        <h1 className="text-2xl font-semibold break-words">{t("day.title", { name })}</h1>
        <p className="text-sm text-muted-foreground">{format.dateTime(dayAsDate(day), CAIRO_DATE_LONG)}</p>
        <div className="flex flex-wrap gap-1">
          {view.flags.map((f) => (
            <Badge key={f} tone="warning">
              {t(`flags.${f}`)}
            </Badge>
          ))}
        </div>
      </div>

      <nav aria-label={t("day.timeline")} className="flex flex-wrap gap-2">
        <Link href={`${base}/${addDays(day, -1)}`} className={buttonVariants({ variant: "outline" })}>
          {t("day.prevDay")}
        </Link>
        {day < today ? (
          <Link href={`${base}/${addDays(day, 1)}`} className={buttonVariants({ variant: "outline" })}>
            {t("day.nextDay")}
          </Link>
        ) : null}
      </nav>

      {view.summaryOnly ? (
        <Alert tone="info">
          <strong className="font-semibold">{t("day.summaryOnlyTitle")}</strong> {t("day.summaryOnly", { days: data.retention_days ?? 90 })}
        </Alert>
      ) : view.purgedWithoutSummary ? (
        <Alert tone="info">{t("day.purged")}</Alert>
      ) : null}

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {stats.map(([label, value]) => (
          <Card key={label} className="space-y-1 p-3 sm:p-4">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="text-lg font-semibold">{value}</dd>
          </Card>
        ))}
      </dl>

      <Section title={t("day.timeline")} count={timeline.length}>
        <p className="text-sm text-muted-foreground">{t("day.explain")}</p>
        {timeline.length === 0 ? <Empty>{t("day.empty")}</Empty> : <ol className="space-y-2">{timeline.map(entry)}</ol>}
      </Section>

      <Section title={t("day.points")} count={view.summaryOnly ? view.figures.ping_count : view.points.length}>
        {view.summaryOnly ? (
          <Empty>{t("day.pointsDeleted", { count: view.figures.ping_count, days: data.retention_days ?? 90 })}</Empty>
        ) : view.points.length === 0 ? (
          <Empty>{t("day.pointsCount", { count: 0 })}</Empty>
        ) : (
          <details className="rounded-lg border bg-card">
            <summary className="flex min-h-11 cursor-pointer items-center px-4 text-sm font-medium">
              {t("day.showPoints")} ({t("day.pointsCount", { count: view.points.length })})
            </summary>
            {view.pointsTruncated ? (
              <p className="border-b px-4 py-2 text-sm text-muted-foreground" role="note">
                {t("day.pointsTruncated", { shown: view.points.length, total: view.figures.ping_count })}
              </p>
            ) : null}
            <ol className="divide-y">
              {view.points.map((p) => {
                const flags = PING_FLAGS.filter((f) => p.anomaly_flags.includes(f));
                return (
                  <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
                    <div className="space-y-0.5">
                      <p className="font-medium tabular-nums">
                        {time(p.captured_at)}
                        {p.accuracy_m !== null ? <span className="ms-2 text-muted-foreground">{t("day.accuracy", { metres: String(Math.round(Number(p.accuracy_m))) })}</span> : null}
                      </p>
                      <div className="flex flex-wrap gap-1">
                        {flags.map((f) => (
                          <Badge key={f} tone="warning">
                            {t(`pingFlags.${f}`)}
                          </Badge>
                        ))}
                        {!p.usable ? <Badge>{t("day.unusable")}</Badge> : null}
                      </div>
                    </div>
                    {mapLink(p.lat, p.lng)}
                  </li>
                );
              })}
            </ol>
          </details>
        )}
      </Section>
    </PageBody>
  );
}
