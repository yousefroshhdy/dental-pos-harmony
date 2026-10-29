"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/primitives";
import { GPS_CONSENT_STORAGE_KEY, GPS_CONSENT_VERSION, parseConsent, recordConsent, withdrawConsent } from "../consent";
import { CAIRO_DATE_TIME } from "../format";

// localStorage as an external store: re-read on our own writes and on other tabs' writes.
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === GPS_CONSENT_STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}
const notify = () => listeners.forEach((l) => l());
const snapshot = () => {
  try {
    return window.localStorage.getItem(GPS_CONSENT_STORAGE_KEY);
  } catch {
    return null;
  }
};

/** The device's acknowledgement for the current text version, with accept / withdraw. */
export function ConsentStatus({ userId }: { userId: string }) {
  const t = useTranslations("field.privacy");
  const format = useFormatter();
  const raw = useSyncExternalStore(subscribe, snapshot, () => undefined);
  if (raw === undefined) return null; // server render: storage is device-only

  const record = parseConsent(raw);
  const current = record !== null && record.version === GPS_CONSENT_VERSION && record.userId === userId;

  return (
    <div className="space-y-3">
      {current && record ? (
        <Alert tone="success" role="status">
          {t("accepted", { when: format.dateTime(new Date(record.acceptedAt), CAIRO_DATE_TIME) })}
        </Alert>
      ) : (
        <Alert tone="info" role="status">
          {t("notAccepted")}
        </Alert>
      )}
      <div className="flex flex-col gap-2 sm:flex-row">
        {current ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              withdrawConsent();
              notify();
            }}
          >
            {t("withdraw")}
          </Button>
        ) : (
          <Button
            type="button"
            onClick={() => {
              recordConsent(userId);
              notify();
            }}
          >
            {t("accept")}
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{t("deviceOnly")}</p>
    </div>
  );
}
