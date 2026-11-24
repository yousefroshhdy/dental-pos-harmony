"use client";

import { useTranslations } from "next-intl";
import { useActionState, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label } from "@/components/ui/primitives";
import { saveBaseLocation, type BaseLocationState } from "../../setup-actions";
import { parseLatLngPair } from "../../setup";
import { ErrorMessage } from "../action-message";

/**
 * A rep's base address. "Find on map" geocodes the address on the server (Google, region eg,
 * Arabic); without a server key, or when Google finds nothing, the owner types the point
 * ("lat, lng" pasted from Google Maps works) or skips. Clearing removes the point.
 */
export function BaseLocationForm({
  employeeId,
  uiLocale,
  defaults,
}: {
  employeeId: string;
  uiLocale: "ar" | "en";
  defaults: { address: string | null; lat: number | null; lng: number | null; radius: number };
}) {
  const t = useTranslations("setup.base");
  const [state, action, pending] = useActionState<BaseLocationState, FormData>(saveBaseLocation, null);
  const [showPoint, setShowPoint] = useState(defaults.lat !== null);
  const [lat, setLat] = useState(defaults.lat === null ? "" : String(defaults.lat));
  const [lng, setLng] = useState(defaults.lng === null ? "" : String(defaults.lng));
  const ids = { address: useId(), lat: useId(), lng: useId(), radius: useId(), paste: useId() };
  const needsPoint = state !== null && !state.ok && "geocode" in state;

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="employee_id" value={employeeId} />
      <input type="hidden" name="ui_locale" value={uiLocale} />
      <div className="space-y-1">
        <Label htmlFor={ids.address}>{t("address")}</Label>
        <Input id={ids.address} name="address" maxLength={300} defaultValue={defaults.address ?? ""} autoComplete="off" />
        <p className="text-xs text-muted-foreground">{t("addressHint")}</p>
      </div>

      {showPoint || needsPoint ? (
        <fieldset className="grid gap-3 sm:grid-cols-2">
          <legend className="mb-1 text-sm font-medium">{t("point")}</legend>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor={ids.paste}>{t("paste")}</Label>
            <Input
              id={ids.paste}
              dir="ltr"
              inputMode="decimal"
              placeholder="31.0409, 31.3785"
              onChange={(e) => {
                const pair = parseLatLngPair(e.currentTarget.value);
                if (pair) {
                  setLat(String(pair.lat));
                  setLng(String(pair.lng));
                }
              }}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={ids.lat}>{t("lat")}</Label>
            <Input id={ids.lat} name="lat" dir="ltr" inputMode="decimal" value={lat} onChange={(e) => setLat(e.currentTarget.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={ids.lng}>{t("lng")}</Label>
            <Input id={ids.lng} name="lng" dir="ltr" inputMode="decimal" value={lng} onChange={(e) => setLng(e.currentTarget.value)} />
          </div>
        </fieldset>
      ) : (
        <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => setShowPoint(true)}>
          {t("typePoint")}
        </Button>
      )}

      <div className="space-y-1">
        <Label htmlFor={ids.radius}>{t("radius")}</Label>
        <Input id={ids.radius} name="lead_radius_km" dir="ltr" inputMode="decimal" defaultValue={String(defaults.radius)} className="sm:max-w-32" />
        <p className="text-xs text-muted-foreground">{t("radiusHint")}</p>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Button type="submit" name="intent" value="save" disabled={pending} className="w-full sm:w-auto">
          {lat !== "" && lng !== "" ? t("savePoint") : t("geocode")}
        </Button>
        {defaults.lat !== null ? (
          <Button type="submit" name="intent" value="clear" variant="outline" disabled={pending} className="w-full sm:w-auto">
            {t("clear")}
          </Button>
        ) : null}
      </div>

      {state === null ? null : state.ok ? (
        <Alert tone="success" role="status">
          {state.source === null ? t("cleared") : state.source === "geocoded" ? t("savedGeocoded", { address: state.formattedAddress ?? "" }) : t("savedManual")}
          {state.approximate ? ` ${t("approximate")}` : null}
        </Alert>
      ) : "geocode" in state ? (
        <Alert tone="info" role="status">
          {t(`problems.${state.geocode}`)}
        </Alert>
      ) : (
        <ErrorMessage messageKey={state.messageKey} requestId={state.requestId} />
      )}
    </form>
  );
}
