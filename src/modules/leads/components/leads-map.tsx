"use client";

import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { MapView, type MapMarker } from "@/components/map/map-view";
import type { LatLng } from "@/lib/maps/geo";

export interface LeadPin {
  id: string;
  lat: number;
  lng: number;
  title: string;
  address: string | null;
  distance: string | null;
  status: string;
  mapsUri: string | null;
  planned: boolean;
}

/**
 * The leads of the page on the shared Google map (Google's own map carries the Google logo, which
 * is the attribution Places requires there). The points come from live Place Details and live
 * only in this page; nothing is stored.
 */
export function LeadsMap({
  apiKey,
  setupHint,
  locale,
  pins,
  base,
}: {
  apiKey: string | null;
  setupHint?: boolean;
  locale: "ar" | "en";
  pins: LeadPin[];
  base: LatLng | null;
}) {
  const t = useTranslations("leads.map");
  const markers = useMemo<MapMarker[]>(() => {
    const out: MapMarker[] = pins.map((p, i) => ({
      id: p.id,
      lat: p.lat,
      lng: p.lng,
      title: p.title,
      label: String(i + 1),
      tone: p.planned ? "success" : "info",
      info: {
        title: p.title,
        lines: [...(p.address ? [p.address] : []), ...(p.distance ? [p.distance] : []), p.status],
        links: [
          { href: `/${locale}/leads/${p.id}`, label: t("open") },
          ...(p.mapsUri ? [{ href: p.mapsUri, label: t("openInGoogleMaps"), external: true }] : []),
        ],
      },
    }));
    if (base) out.push({ id: "base", lat: base.lat, lng: base.lng, title: t("base"), tone: "primary", emphasis: true });
    return out;
  }, [pins, base, locale, t]);

  return <MapView apiKey={apiKey} setupHint={setupHint} locale={locale} label={t("label")} markers={markers} />;
}
