"use client";

import { useTranslations } from "next-intl";
import { useActionState, useCallback, useMemo, useState } from "react";
import { MapView, type MapMarker } from "@/components/map/map-view";
import { PlaceSearch, type PlacePick } from "@/components/map/place-search";
import { Button, buttonVariants } from "@/components/ui/button";
import { Alert } from "@/components/ui/primitives";
import { directionsUrl, distanceMeters, insideEgypt, type LatLng } from "@/lib/maps/geo";
import { setCustomerLocationFromMap } from "../actions";
import type { MapsActionState } from "../types";
import { MapsActionMessage } from "./action-message";

export interface PanelProposal extends LatLng {
  id: string;
  repName: string;
}

type Me = { kind: "idle" } | { kind: "locating" } | { kind: "fix"; at: LatLng; accuracy: number } | { kind: "error"; reason: "denied" | "unavailable" | "timeout" | "unsupported" };
type Draft = (LatLng & { source: "search" | "pin"; address: string | null }) | null;

const GEO_ERROR = { 1: "denied", 2: "unavailable", 3: "timeout" } as const;

/**
 * Customer detail map: the clinic pin, the distance from the user's position (browser
 * geolocation, only when they ask), Google Maps directions, pending pin proposals, and for
 * crm.customer_location.verify holders a location editor (address search or a dropped,
 * draggable pin). Saving calls api.set_customer_location, as before.
 */
export function CustomerMapClient({
  apiKey,
  setupHint,
  locale,
  customerId,
  name,
  clinic,
  canLocate,
  proposals,
}: {
  apiKey: string | null;
  setupHint?: boolean;
  locale: "ar" | "en";
  customerId: string;
  name: string;
  clinic: LatLng | null;
  canLocate: boolean;
  proposals: PanelProposal[];
}) {
  const t = useTranslations("maps.customer");
  const [me, setMe] = useState<Me>({ kind: "idle" });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>(null);
  const [state, action, pending] = useActionState<MapsActionState, FormData>(async (prev, form) => {
    const result = await setCustomerLocationFromMap(prev, form);
    if (result.ok) {
      setEditing(false);
      setDraft(null);
    }
    return result;
  }, null);

  const locate = () => {
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      setMe({ kind: "error", reason: "unsupported" });
      return;
    }
    setMe({ kind: "locating" });
    navigator.geolocation.getCurrentPosition(
      (pos) => setMe({ kind: "fix", at: { lat: pos.coords.latitude, lng: pos.coords.longitude }, accuracy: pos.coords.accuracy }),
      (err) => setMe({ kind: "error", reason: GEO_ERROR[err.code as 1 | 2 | 3] ?? "unavailable" }),
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 60_000 },
    );
  };

  const pick = useCallback((p: PlacePick) => setDraft({ lat: p.lat, lng: p.lng, address: p.address, source: "search" }), []);
  const onMapClick = useCallback(
    (p: LatLng) => {
      if (editing) setDraft({ ...p, address: null, source: "pin" });
    },
    [editing],
  );
  const onDrag = useCallback((_id: string, p: LatLng) => setDraft((d) => ({ ...p, address: d?.address ?? null, source: "pin" })), []);

  const myFix = me.kind === "fix" ? me : null;
  const markers = useMemo<MapMarker[]>(() => {
    const out: MapMarker[] = [];
    if (clinic) out.push({ id: "clinic", ...clinic, title: name, tone: "primary", emphasis: true, info: { title: name, lines: [t("clinicPin")] } });
    for (const p of proposals) {
      out.push({ id: `proposal-${p.id}`, lat: p.lat, lng: p.lng, title: t("proposalBy", { name: p.repName }), tone: "warning", label: "?", info: { title: t("proposal"), lines: [t("proposalBy", { name: p.repName })] } });
    }
    if (myFix) out.push({ id: "me", ...myFix.at, title: t("you"), tone: "info", info: { title: t("you"), lines: [t("accuracy", { metres: String(Math.round(myFix.accuracy)) })] } });
    if (draft) out.push({ id: "draft", lat: draft.lat, lng: draft.lng, title: t("newPin"), tone: "danger", emphasis: true, draggable: true });
    return out;
  }, [clinic, proposals, myFix, draft, name, t]);

  const distance = clinic && myFix ? distanceMeters(myFix.at, clinic) : null;
  const draftOk = draft !== null && insideEgypt(draft);

  return (
    <div className="space-y-3">
      <MapView
        apiKey={apiKey}
        setupHint={setupHint}
        locale={locale}
        label={t("mapLabel", { name })}
        markers={markers}
        fitKey={`${clinic ? "c" : ""}${proposals.length}${myFix ? "m" : ""}${draft?.source === "search" ? `${draft.lat}` : ""}`}
        onMapClick={onMapClick}
        onMarkerDragEnd={onDrag}
        className="h-64 w-full sm:h-72"
      />

      {!clinic ? <p className="text-sm text-muted-foreground">{t("noPin")}</p> : null}

      <div className="flex flex-wrap gap-2">
        {clinic ? (
          <a href={directionsUrl(clinic, myFix?.at)} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: "outline" })}>
            {t("directions")}
          </a>
        ) : null}
        {clinic ? (
          <Button type="button" variant="outline" onClick={locate} disabled={me.kind === "locating"}>
            {me.kind === "locating" ? t("locating") : t("distance")}
          </Button>
        ) : null}
        {canLocate && !editing ? (
          <Button type="button" variant="outline" onClick={() => setEditing(true)}>
            {clinic ? t("move") : t("set")}
          </Button>
        ) : null}
      </div>

      <div aria-live="polite" className="space-y-2">
        {distance !== null && myFix ? (
          <p className="text-sm">
            {t("distanceIs", { km: (distance / 1000).toFixed(distance < 10_000 ? 2 : 1), metres: String(Math.round(myFix.accuracy)) })}
          </p>
        ) : null}
        {me.kind === "error" ? <Alert>{t(`geo.${me.reason}`)}</Alert> : null}
        {state?.ok ? (
          <Alert tone="success" role="status">
            {t("saved")}
          </Alert>
        ) : null}
        <MapsActionMessage state={state} />
      </div>

      {canLocate && editing ? (
        <div className="space-y-3 rounded-lg border p-3">
          <p className="text-sm text-muted-foreground">{apiKey ? t("editHint") : t("editNoKey")}</p>
          <PlaceSearch apiKey={apiKey} locale={locale} onPick={pick} />
          {draft ? (
            <p className="text-sm">
              {draft.address ? <span className="block break-words">{draft.address}</span> : null}
              <span dir="ltr" className="font-mono">
                {draft.lat.toFixed(6)}, {draft.lng.toFixed(6)}
              </span>
            </p>
          ) : null}
          {draft && !draftOk ? <Alert>{t("outsideEgypt")}</Alert> : null}
          <form action={action} className="flex flex-wrap gap-2">
            <input type="hidden" name="customer_id" value={customerId} />
            <input type="hidden" name="latitude" value={draft ? draft.lat.toFixed(6) : ""} />
            <input type="hidden" name="longitude" value={draft ? draft.lng.toFixed(6) : ""} />
            <input type="hidden" name="source" value={draft?.source ?? "pin"} />
            <Button type="submit" disabled={!draftOk || pending}>
              {clinic ? t("saveMove") : t("save")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setEditing(false);
                setDraft(null);
              }}
              disabled={pending}
            >
              {t("cancel")}
            </Button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
