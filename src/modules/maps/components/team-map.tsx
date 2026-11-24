"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useMemo } from "react";
import { MapView, type MapMarker } from "@/components/map/map-view";
import { localizedName } from "@/modules/crm/logic";
import { freshnessTone, minutesSince, type TeamPoint } from "../logic";

const CAIRO_TIME = { timeStyle: "short", timeZone: "Africa/Cairo", numberingSystem: "latn" } as const;

/** Managers' team map: the last point of each rep on an open shift (D-14). */
export function TeamMap({ apiKey, locale, points, day }: { apiKey: string | null; locale: "ar" | "en"; points: TeamPoint[]; day: string }) {
  const t = useTranslations("maps.team");
  const format = useFormatter();

  const markers = useMemo<MapMarker[]>(() => {
    const now = new Date();
    return points.map((p) => {
      const name = localizedName(locale, p.full_name_en, p.full_name_ar) || t("unnamed");
      const minutes = minutesSince(p.captured_at, now);
      return {
        id: p.employee_id,
        lat: p.lat,
        lng: p.lng,
        title: name,
        tone: freshnessTone(minutes),
        info: {
          title: name,
          lines: [
            p.point_source === "ping" ? t("lastPoint", { time: format.dateTime(new Date(p.captured_at), CAIRO_TIME) }) : t("startPoint"),
            t("minutesAgo", { minutes: String(minutes) }),
            ...(p.accuracy_m !== null ? [t("accuracy", { metres: String(Math.round(Number(p.accuracy_m))) })] : []),
          ],
          links: [{ href: `/${locale}/tracking/${p.employee_id}/${day}`, label: t("openDay") }],
        },
      };
    });
  }, [points, locale, day, t, format]);

  return <MapView apiKey={apiKey} locale={locale} label={t("mapLabel")} markers={markers} />;
}
