"use client";

import { useTranslations } from "next-intl";
import { useId } from "react";
import { Button } from "@/components/ui/button";

/** The consent text (versioned: GPS_CONSENT_VERSION in consent.ts). */
export function GpsConsentText({ headingId }: { headingId?: string }) {
  const t = useTranslations("field.consent");
  return (
    <div className="space-y-2 text-sm">
      <h2 id={headingId} className="text-base font-semibold">
        {t("title")}
      </h2>
      <p>{t("intro")}</p>
      <ul className="list-disc space-y-1 ps-5">
        <li>{t("what")}</li>
        <li>{t("when")}</li>
        <li>{t("why")}</li>
        <li>{t("retention")}</li>
        <li>{t("access")}</li>
        <li>{t("without")}</li>
      </ul>
    </div>
  );
}

/**
 * Shown before the first check-in on this device. Accepting stores the
 * acknowledgement (consent.ts) and continues to the browser's own permission
 * prompt; "without location" checks in with no fix (→ no_device_location).
 */
export function GpsConsentPanel({
  onAccept,
  onWithoutLocation,
  onCancel,
}: {
  onAccept: () => void;
  onWithoutLocation: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations("field.consent");
  const headingId = useId();
  return (
    <section role="dialog" aria-labelledby={headingId} className="space-y-3 rounded-lg border bg-muted/50 p-3">
      <GpsConsentText headingId={headingId} />
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type="button" onClick={onAccept} autoFocus>
          {t("accept")}
        </Button>
        <Button type="button" variant="outline" onClick={onWithoutLocation}>
          {t("withoutLocation")}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t("cancel")}
        </Button>
      </div>
    </section>
  );
}
