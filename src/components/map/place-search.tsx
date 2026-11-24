"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { MAPS_REGION, mapsKeyState, shouldLoadMaps } from "@/lib/maps/config";
import type { LatLng } from "@/lib/maps/geo";
import { importMapsLibrary } from "@/lib/maps/loader";

export interface PlacePick extends LatLng {
  address: string | null;
}

/**
 * Address search with Google's Place Autocomplete widget (Places API (New),
 * PlaceAutocompleteElement), limited to Egypt, in the page language. Client-side with the
 * browser key; nothing about the place is stored except the coordinates the user saves
 * (they become HONEST's own clinic pin). Without a key it renders nothing.
 */
export function PlaceSearch({ apiKey, locale, onPick }: { apiKey: string | null; locale: "ar" | "en"; onPick: (p: PlacePick) => void }) {
  const t = useTranslations("maps.map");
  const host = useRef<HTMLDivElement>(null);
  const pick = useRef(onPick);
  const [failed, setFailed] = useState(false);
  const state = mapsKeyState(apiKey);
  const key = shouldLoadMaps(state) ? state.key : null;

  useEffect(() => {
    pick.current = onPick;
  }, [onPick]);

  useEffect(() => {
    if (!key || !host.current) return;
    let cancelled = false;
    let element: HTMLElement | null = null;
    importMapsLibrary(key, locale, "places")
      .then((places) => {
        if (cancelled || !host.current) return;
        const el = new places.PlaceAutocompleteElement({
          includedRegionCodes: [MAPS_REGION.toLowerCase()],
          requestedLanguage: locale,
          requestedRegion: MAPS_REGION.toLowerCase(),
        });
        el.style.width = "100%";
        el.addEventListener("gmp-select", (event: Event) => {
          const prediction = (event as google.maps.places.PlacePredictionSelectEvent).placePrediction;
          const place = prediction.toPlace();
          place
            .fetchFields({ fields: ["location", "formattedAddress"] })
            .then(() => {
              const loc = place.location;
              if (loc) pick.current({ lat: loc.lat(), lng: loc.lng(), address: place.formattedAddress ?? null });
            })
            .catch(() => setFailed(true));
        });
        host.current.replaceChildren(el);
        element = el;
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      element?.remove();
    };
  }, [key, locale]);

  if (!key) return null;
  return (
    <div className="space-y-1">
      <div ref={host} className="min-h-11" aria-label={t("searchAddress")} />
      {failed ? <p className="text-sm text-destructive">{t("searchFailed")}</p> : null}
    </div>
  );
}
