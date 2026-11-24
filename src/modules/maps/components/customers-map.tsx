"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useMemo } from "react";
import { MapView, type MapMarker } from "@/components/map/map-view";
import { directionsUrl } from "@/lib/maps/geo";
import { localizedName } from "@/modules/crm/logic";
import { customerTone, type PinnedCustomer } from "../logic";

const CAIRO_DATE = { dateStyle: "medium", timeZone: "Africa/Cairo", numberingSystem: "latn" } as const;

/** The customers map: one pin per clinic, coloured by overdue AR and stage, clustered when zoomed out. */
export function CustomersMap({ apiKey, setupHint, locale, rows }: { apiKey: string | null; setupHint?: boolean; locale: "ar" | "en"; rows: PinnedCustomer[] }) {
  const t = useTranslations("maps.customers");
  const tStage = useTranslations("crm.stage");
  const format = useFormatter();

  const markers = useMemo<MapMarker[]>(
    () =>
      rows.map((r) => {
        const rep = localizedName(locale, r.primary_rep_name_en, r.primary_rep_name_ar);
        const territory = localizedName(locale, r.territory_name_en, r.territory_name_ar);
        const lines = [
          `${r.customer_no} · ${tStage(r.lifecycle_stage)}`,
          rep ? t("info.rep", { name: rep }) : t("info.noRep"),
          ...(territory ? [territory] : []),
          ...(r.is_overdue ? [t("info.overdue", { days: String(r.max_days_overdue ?? 0) })] : []),
          r.last_visit_on ? t("info.lastVisit", { date: format.dateTime(new Date(`${r.last_visit_on}T10:00:00Z`), CAIRO_DATE) }) : t("info.neverVisited"),
          ...(r.location_verified ? [] : [t("info.unverified")]),
        ];
        return {
          id: r.id,
          lat: r.lat,
          lng: r.lng,
          title: r.display_name,
          tone: customerTone(r),
          info: {
            title: r.display_name,
            lines,
            links: [
              { href: `/${locale}/customers/${r.id}`, label: t("info.open") },
              { href: directionsUrl(r), label: t("info.directions"), external: true },
            ],
          },
        };
      }),
    [rows, locale, t, tStage, format],
  );

  return <MapView apiKey={apiKey} setupHint={setupHint} locale={locale} label={t("mapLabel")} markers={markers} cluster />;
}
