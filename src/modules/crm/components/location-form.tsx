"use client";

import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/primitives";
import { setCustomerLocation } from "../actions";
import { locationFixProblem, MAX_LOCATION_ACCURACY_M } from "../logic";
import type { ActionState } from "../types";
import { CrmActionMessage } from "./crm-error";

type Fix = { lat: number; lng: number; accuracy: number };
type Geo =
  | { kind: "idle" }
  | { kind: "locating" }
  | { kind: "fix"; fix: Fix }
  | { kind: "error"; reason: "denied" | "unavailable" | "timeout" | "unsupported" };

const GEO_ERROR = { 1: "denied", 2: "unavailable", 3: "timeout" } as const;

/**
 * Pin the clinic at the user's current position (crm.customer_location.verify).
 * Uses the browser's high-accuracy fix and refuses one worse than
 * MAX_LOCATION_ACCURACY_M, because the pin drives visit check-in verification.
 * The coordinates are typed by nobody: they come from the device only.
 */
export function LocationForm({ customerId, hasLocation }: { customerId: string; hasLocation: boolean }) {
  const t = useTranslations("crm.location");
  const [geo, setGeo] = useState<Geo>({ kind: "idle" });
  const [state, formAction, pending] = useActionState<ActionState, FormData>(setCustomerLocation, null);

  function locate() {
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      setGeo({ kind: "error", reason: "unsupported" });
      return;
    }
    setGeo({ kind: "locating" });
    navigator.geolocation.getCurrentPosition(
      (pos) => setGeo({ kind: "fix", fix: { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy } }),
      (err) => setGeo({ kind: "error", reason: GEO_ERROR[err.code as 1 | 2 | 3] ?? "unavailable" }),
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 },
    );
  }

  const problem = geo.kind === "fix" ? locationFixProblem(geo.fix) : null;

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{t(hasLocation ? "hintChange" : "hintSet", { max: MAX_LOCATION_ACCURACY_M })}</p>
      <Button type="button" variant="outline" onClick={locate} disabled={geo.kind === "locating" || pending} className="w-full sm:w-auto">
        {geo.kind === "locating" ? t("locating") : geo.kind === "fix" ? t("retry") : t("locate")}
      </Button>

      <div aria-live="polite" className="space-y-3">
        {geo.kind === "error" ? <Alert>{t(`error.${geo.reason}`)}</Alert> : null}
        {geo.kind === "fix" ? (
          <>
            <p className="text-sm">
              <span dir="ltr" className="font-mono">
                {geo.fix.lat.toFixed(6)}, {geo.fix.lng.toFixed(6)}
              </span>{" "}
              · {t("accuracy", { meters: Math.round(geo.fix.accuracy) })}
            </p>
            {problem === "LOCATION_INACCURATE" ? <Alert>{t("inaccurate", { max: MAX_LOCATION_ACCURACY_M })}</Alert> : null}
            {problem === "OUTSIDE_EGYPT" ? <Alert>{t("outsideEgypt")}</Alert> : null}
            {problem === null ? (
              <form action={formAction}>
                <input type="hidden" name="customer_id" value={customerId} />
                <input type="hidden" name="latitude" value={geo.fix.lat.toFixed(6)} />
                <input type="hidden" name="longitude" value={geo.fix.lng.toFixed(6)} />
                <input type="hidden" name="accuracy_m" value={Math.round(geo.fix.accuracy)} />
                <Button type="submit" disabled={pending} className="w-full sm:w-auto">
                  {hasLocation ? t("saveChange") : t("save")}
                </Button>
              </form>
            ) : null}
          </>
        ) : null}
        <CrmActionMessage state={state} success={t("saved")} />
      </div>
    </div>
  );
}
