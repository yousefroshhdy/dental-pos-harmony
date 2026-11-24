"use client";

import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { MapView, type MapMarker } from "@/components/map/map-view";
import { placeUrl } from "@/lib/maps/geo";

export interface ProposalPin {
  id: string;
  lat: number;
  lng: number;
  customerName: string;
  repName: string;
  n: number;
}

/** Pending pin proposals on one map, numbered like the list below it. */
export function ProposalsMap({ apiKey, setupHint, locale, pins }: { apiKey: string | null; setupHint?: boolean; locale: "ar" | "en"; pins: ProposalPin[] }) {
  const t = useTranslations("maps.proposals");
  const markers = useMemo<MapMarker[]>(
    () =>
      pins.map((p) => ({
        id: p.id,
        lat: p.lat,
        lng: p.lng,
        title: p.customerName,
        label: String(p.n),
        tone: "warning",
        info: {
          title: `${p.n}. ${p.customerName}`,
          lines: [t("by", { name: p.repName })],
          links: [{ href: placeUrl(p), label: t("openInMaps"), external: true }],
        },
      })),
    [pins, t],
  );
  return <MapView apiKey={apiKey} setupHint={setupHint} locale={locale} label={t("mapLabel")} markers={markers} cluster className="h-[45vh] min-h-64 w-full" />;
}
