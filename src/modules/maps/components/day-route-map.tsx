"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useMemo } from "react";
import { MapView, type MapMarker, type MapPolyline } from "@/components/map/map-view";
import type { DayRoute } from "../logic";

const CAIRO_TIME = { timeStyle: "short", timeZone: "Africa/Cairo", numberingSystem: "latn" } as const;

/** The rep day map: route segments, dashed gap hops, numbered stops and visit check-ins. */
export function DayRouteMap({ apiKey, locale, route }: { apiKey: string | null; locale: "ar" | "en"; route: DayRoute }) {
  const t = useTranslations("maps.day");
  const format = useFormatter();
  const time = (iso: string | null) => (iso ? format.dateTime(new Date(iso), CAIRO_TIME) : "…");

  const polylines = useMemo<MapPolyline[]>(
    () => [
      ...route.segments.map((path, i) => ({ id: `seg-${i}`, path, tone: "info" as const })),
      ...route.hops.map((h, i) => ({ id: `gap-${i}`, path: [h.from, h.to], tone: "muted" as const, dashed: true })),
    ],
    [route],
  );

  const markers = useMemo<MapMarker[]>(() => {
    const out: MapMarker[] = [];
    if (route.start) out.push({ id: "start", ...route.start, title: t("start"), tone: "success", label: "▶", info: { title: t("start") } });
    if (route.end) out.push({ id: "end", ...route.end, title: t("end"), tone: "muted", label: "■", info: { title: t("end") } });
    for (const m of route.marks) {
      if (m.kind === "stop") {
        out.push({
          id: `stop-${m.n}`,
          lat: m.lat,
          lng: m.lng,
          label: String(m.n),
          tone: m.stop.flagged ? "warning" : "primary",
          title: t("stopTitle", { n: String(m.n) }),
          info: {
            title: m.stop.flagged ? t("stopFlagged", { n: String(m.n) }) : t("stopTitle", { n: String(m.n) }),
            lines: [t("range", { from: time(m.stop.start_at), to: time(m.stop.end_at) }), t("minutes", { minutes: String(Math.round(m.stop.seconds / 60)) })],
          },
        });
      } else {
        const name = m.visit?.customer_name ?? t("visitUnnamed");
        out.push({
          id: `visit-${m.fix.visit_id}`,
          lat: m.lat,
          lng: m.lng,
          label: String(m.n),
          tone: m.visit?.verification_status === "verified" ? "success" : "danger",
          title: t("visitTitle", { n: String(m.n), name }),
          info: {
            title: t("visitTitle", { n: String(m.n), name }),
            lines: [
              t("checkIn", { time: time(m.fix.captured_at) }),
              ...(m.visit ? [t(`verification.${m.visit.verification_status}`)] : []),
            ],
          },
        });
      }
    }
    return out;
    // `time` only formats; it changes with `format`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, t, format]);

  return <MapView apiKey={apiKey} locale={locale} label={t("mapLabel")} markers={markers} polylines={polylines} className="h-[50vh] min-h-72 w-full" />;
}
