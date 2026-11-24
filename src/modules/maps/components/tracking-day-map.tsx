import { getFormatter, getTranslations } from "next-intl/server";
import { Alert } from "@/components/ui/primitives";
import { getUserContext } from "@/lib/authz/context";
import { seesSetupDetails } from "@/lib/maps/config";
import type { TrackingDay } from "@/modules/tracking/types";
import { buildDayRoute } from "../logic";
import { getVisitFixes, mapsBrowserKey } from "../queries";
import { DayRouteMap } from "./day-route-map";

const CAIRO_TIME = { timeStyle: "short", timeZone: "Africa/Cairo", numberingSystem: "latn" } as const;

/**
 * The map section of the tracking day page (one insertion line there): the route from the
 * day's usable points, numbered stops and visit check-ins, and gaps as dashed hops. The scope
 * is the tracking page's (api.tracking_day already succeeded); visit fixes come from
 * api.tracking_day_visit_fixes (empty without field.location.read). Nothing to draw once the
 * retention purge has removed the points.
 */
export async function TrackingDayMap({ day, locale }: { day: TrackingDay; locale: string }) {
  const t = await getTranslations("maps.day");
  const format = await getFormatter();
  if (day.summary_only || day.raw_purged) return null;

  const fixes = await getVisitFixes(day.employee_id, day.day);
  const route = buildDayRoute(day, fixes.ok ? fixes.data : []);
  const lang = locale === "en" ? "en" : "ar";
  const setupHint = seesSetupDetails(await getUserContext());
  const time = (iso: string | null) => (iso ? format.dateTime(new Date(iso), CAIRO_TIME) : "…");

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">{t("title")}</h2>
      {!fixes.ok ? <Alert tone="info">{t("fixesUnavailable")}</Alert> : null}
      {route.extent.length === 0 ? (
        <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <>
          <DayRouteMap apiKey={mapsBrowserKey()} setupHint={setupHint} locale={lang} route={route} />
          {route.marks.length > 0 ? (
            <ol className="grid gap-1 text-sm sm:grid-cols-2" aria-label={t("legend")}>
              {route.marks.map((m) => (
                <li key={`${m.kind}-${m.n}`} className="flex items-baseline gap-2">
                  <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">{m.n}</span>
                  <span className="min-w-0 break-words">
                    {m.kind === "stop"
                      ? `${m.stop.flagged ? t("stopFlaggedShort") : t("stopShort")} · ${time(m.stop.start_at)}–${time(m.stop.end_at)}`
                      : `${m.visit?.customer_name ?? t("visitUnnamed")} · ${t("checkIn", { time: time(m.fix.captured_at) })}`}
                  </span>
                </li>
              ))}
            </ol>
          ) : null}
          {route.hops.length > 0 ? <p className="text-sm text-muted-foreground">{t("gapsNote", { count: String(route.hops.length) })}</p> : null}
          {route.visitsWithoutFix.length > 0 ? <p className="text-sm text-muted-foreground">{t("visitsWithoutFix", { count: String(route.visitsWithoutFix.length) })}</p> : null}
        </>
      )}
    </section>
  );
}
