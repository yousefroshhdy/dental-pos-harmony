"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/primitives";
import { openNativeAppSettings } from "@/lib/native/background-geolocation";
import type { CollectorProblem } from "../device-store";
import { nativeProblemKey } from "../logic";

/** "Open app settings" (Android's page for Honest OS: permissions, notifications, battery). */
function OpenSettingsButton() {
  const t = useTranslations("tracking.native");
  const [failed, setFailed] = useState(false);
  return (
    <div className="space-y-1">
      <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => void openNativeAppSettings().then((ok) => setFailed(!ok))}>
        {t("openSettings")}
      </Button>
      {failed ? <p className="text-xs">{t("settingsFallback")}</p> : null}
    </div>
  );
}

/** Why the Android shell cannot read the location, and what the rep does about it. */
export function NativeProblemAlert({ problem }: { problem: CollectorProblem }) {
  const t = useTranslations("tracking.native.problem");
  const key = nativeProblemKey(problem);
  return (
    <Alert className="space-y-2">
      <p>{t(key)}</p>
      {key === "denied" ? <OpenSettingsButton /> : null}
    </Alert>
  );
}

/**
 * Inside the Android shell: background recording, the battery-optimisation warning, and the
 * phone settings that keep tracking alive (permissions, notifications, battery, OEM extras).
 */
export function NativeTrackingHelp({ onShift }: { onShift: boolean }) {
  const t = useTranslations("tracking.native");
  return (
    <div className="space-y-2 text-sm">
      {onShift ? <Alert tone="info">{t("background")}</Alert> : null}
      <Alert tone="info">{t("batteryWarning")}</Alert>
      <details className="rounded-md border p-3">
        <summary className="flex min-h-11 cursor-pointer items-center font-medium">{t("help.title")}</summary>
        <div className="space-y-3 pt-2">
          <section className="space-y-1">
            <h3 className="font-medium">{t("help.permissionsTitle")}</h3>
            <ul className="list-disc space-y-1 ps-5">
              <li>{t("help.location")}</li>
              <li>{t("help.notifications")}</li>
            </ul>
          </section>
          <section className="space-y-1">
            <h3 className="font-medium">{t("help.batteryTitle")}</h3>
            <ul className="list-disc space-y-1 ps-5">
              <li>{t("help.batteryAndroid")}</li>
              <li>{t("help.batterySamsung")}</li>
              <li>{t("help.batteryOthers")}</li>
              <li>{t("help.batteryMdm")}</li>
            </ul>
          </section>
          <OpenSettingsButton />
        </div>
      </details>
    </div>
  );
}
