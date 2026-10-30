import type { Metadata } from "next";
import { getFormatter, getLocale, getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { Button, buttonVariants } from "@/components/ui/button";
import { Alert, Badge, Input, Label, Table, Td, Th } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { getUserContext } from "@/lib/authz/context";
import { cn } from "@/lib/utils";
import { Empty, Item, ItemList, PageBody } from "@/modules/field/components/layout-bits";
import { localizedName } from "@/modules/field/logic";
import { CAIRO_DATE_LONG, CAIRO_TIME, dayAsDate, formatDuration, formatKm } from "@/modules/tracking/format";
import { addDays, cairoToday, canReadTracking, dayFlags, isRowFlagged, parseDay, sortTeamRows, trackingErrorCode } from "@/modules/tracking/logic";
import { getTeamDay } from "@/modules/tracking/queries";
import type { TeamDayRow } from "@/modules/tracking/types";

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

  const name = (r: TeamDayRow) => localizedName(lang, r.full_name_en, r.full_name_ar);
  const dayHref = (r: TeamDayRow) => `/tracking/${r.employee_id}/${day}`;
  const time = (iso: string | null) => (iso ? format.dateTime(new Date(iso), CAIRO_TIME) : t("team.none"));
  const onShift = (r: TeamDayRow) =>
    r.on_shift ? <Badge tone="success">{t("team.yes")}</Badge> : r.shift_count === 0 ? <Badge>{t("team.notStarted")}</Badge> : <Badge>{t("team.no")}</Badge>;
  const flagBadges = (r: TeamDayRow) => (
    <div className="flex flex-wrap gap-1">
      {dayFlags(r.flags).map((f) => (
        <Badge key={f} tone="warning">
          {t(`flags.${f}`)}
        </Badge>
      ))}
      {r.from_summary ? <Badge tone="info">{t("team.summaryOnly")}</Badge> : null}
    </div>
  );
  const gaps = (r: TeamDayRow) => (r.gap_count > 0 ? t("team.gapsValue", { count: String(r.gap_count), duration: formatDuration(t, r.gap_seconds) }) : t("team.none"));
  const idle = (r: TeamDayRow) => (r.idle_stop_count > 0 ? formatDuration(t, r.idle_stop_seconds) : t("team.none"));

  return (
    <PageBody>
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">{t("team.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("team.subtitle")}</p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <form method="get" className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="tracking-date">{t("team.date")}</Label>
            <Input id="tracking-date" name="date" type="date" defaultValue={day} max={today} className="w-auto" />
          </div>
          <Button type="submit" variant="outline">
            {t("team.show")}
          </Button>
        </form>
        <nav aria-label={t("team.date")} className="flex flex-wrap gap-2">
          <Link href={`/tracking?date=${addDays(day, -1)}`} className={buttonVariants({ variant: "outline" })}>
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
            </Link>
          ) : null}
        </nav>
      </div>

      <h2 className="text-lg font-semibold">{format.dateTime(dayAsDate(day), CAIRO_DATE_LONG)}</h2>

      {!result.ok ? (
        <Alert>
          {trackingErrorCode(result.error.code)
            ? t(`errors.${trackingErrorCode(result.error.code)}`)
            : tErrors(result.error.messageKey, { requestId: result.error.requestId ?? "—" })}
        </Alert>
      ) : rows.length === 0 ? (
        <Empty>{t("team.empty")}</Empty>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {t("team.count", { count: rows.length })} · {t("team.flaggedCount", { count: flagged })}
          </p>

          {/* Phones: one card per rep. */}
          <ItemList className="md:hidden">
            {rows.map((r) => (
              <Item key={r.employee_id} className={cn(isRowFlagged(r) && "border-warning bg-warning/10")}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <Link href={dayHref(r)} className="inline-flex min-h-11 items-center font-medium text-primary underline-offset-4 hover:underline">
                    {name(r)}
                  </Link>
                  {onShift(r)}
                </div>
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                  <dt className="text-muted-foreground">{t("team.shiftTime")}</dt>
                  <dd>{formatDuration(t, r.shift_seconds)}</dd>
                  <dt className="text-muted-foreground">{t("team.visits")}</dt>
                  <dd>
                    {r.visit_count} · {formatDuration(t, r.visit_seconds)}
                  </dd>
                  <dt className="text-muted-foreground">{t("team.idle")}</dt>
                  <dd>{idle(r)}</dd>
                  <dt className="text-muted-foreground">{t("team.gaps")}</dt>
                  <dd>{gaps(r)}</dd>
                  <dt className="text-muted-foreground">{t("team.distance")}</dt>
                  <dd>{formatKm(t, r.distance_m)}</dd>
                  <dt className="text-muted-foreground">{t("team.lastSeen")}</dt>
                  <dd>{time(r.last_ping_at)}</dd>
                </dl>
                {flagBadges(r)}
              </Item>
            ))}
          </ItemList>

          {/* Wider screens: the table. */}
          <div className="hidden md:block">
            <Table>
              <thead>
                <tr>
                  <Th scope="col">{t("team.rep")}</Th>
                  <Th scope="col">{t("team.onShift")}</Th>
                  <Th scope="col">{t("team.shiftTime")}</Th>
                  <Th scope="col">{t("team.visits")}</Th>
                  <Th scope="col">{t("team.visitTime")}</Th>
                  <Th scope="col">{t("team.idle")}</Th>
                  <Th scope="col">{t("team.gaps")}</Th>
                  <Th scope="col">{t("team.distance")}</Th>
                  <Th scope="col">{t("team.lastSeen")}</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.employee_id} className={cn(isRowFlagged(r) && "bg-warning/10")}>
                    <Td>
                      <div className="space-y-1">
                        <Link href={dayHref(r)} aria-label={t("team.open", { name: name(r) })} className="font-medium text-primary underline-offset-4 hover:underline">
                          {name(r)}
                        </Link>
                        {flagBadges(r)}
                      </div>
                    </Td>
                    <Td>{onShift(r)}</Td>
                    <Td className="whitespace-nowrap">{formatDuration(t, r.shift_seconds)}</Td>
                    <Td>{r.visit_count}</Td>
                    <Td className="whitespace-nowrap">{formatDuration(t, r.visit_seconds)}</Td>
                    <Td className="whitespace-nowrap">{idle(r)}</Td>
                    <Td className="whitespace-nowrap">{gaps(r)}</Td>
                    <Td className="whitespace-nowrap">{formatKm(t, r.distance_m)}</Td>
                    <Td className="whitespace-nowrap">{time(r.last_ping_at)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        </>
      )}
    </PageBody>
  );
}
