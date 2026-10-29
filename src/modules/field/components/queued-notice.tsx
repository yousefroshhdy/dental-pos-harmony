"use client";

import { useFormatter, useTranslations } from "next-intl";
import { Alert } from "@/components/ui/primitives";
import type { QueueItem } from "@/lib/offline/types";
import { CAIRO_DATE_TIME } from "../format";
import { queuedView } from "../logic";
import { FieldError } from "./field-error";

/**
 * "Saved on this device, will sync" for a field command in the offline queue,
 * shown instead of the server's verdict until the server confirms it. A
 * rejected or stale item points to the pending-sync panel, where the rep
 * retries or discards it. The caller renders the synced state itself.
 */
export function QueuedNotice({ item, message, capturedAt }: { item: QueueItem; message: string; capturedAt?: string | null }) {
  const t = useTranslations("field.offline");
  const format = useFormatter();
  const view = queuedView(item);

  if (view === "attention") {
    return (
      <div className="space-y-2">
        {item.lastError && item.status !== "pending" ? (
          <FieldError code={item.lastError.code} messageKey={item.lastError.messageKey} requestId={item.lastError.requestId} />
        ) : null}
        <Alert>{item.status === "pending" ? t("stale") : t("attention")}</Alert>
      </div>
    );
  }

  const time = capturedAt ?? item.createdAt;
  return (
    <Alert tone="info" role="status" aria-live="polite" className="space-y-1">
      <p>
        <span className="font-medium">{t("savedTitle")}</span> {message}
      </p>
      <p className="text-xs text-muted-foreground">
        <time dateTime={time}>{t("capturedAt", { time: format.dateTime(new Date(time), CAIRO_DATE_TIME) })}</time>{" "}
        {item.status === "syncing" ? t("sending") : t("followSync")}
      </p>
    </Alert>
  );
}
