"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/primitives";
import { acknowledgeTrackingNotice } from "../actions";
import { noticeBody, noticeParagraphs, trackingErrorCode } from "../logic";
import type { TrackingNotice } from "../types";

/** The versioned notice text as stored on the server (the text the rep acknowledges). */
export function NoticeText({ notice }: { notice: TrackingNotice }) {
  const t = useTranslations("tracking.notice");
  const locale = useLocale();
  return (
    <div className="space-y-3 text-sm leading-relaxed">
      {noticeParagraphs(noticeBody(notice, locale)).map((p, i) => (
        <p key={i}>{p}</p>
      ))}
      <p className="text-xs text-muted-foreground">
        {t("version", { version: notice.version })} · {t("legalPending")}
      </p>
    </div>
  );
}

/** First screen before the first shift: read, then acknowledge (stored on the server, per version). */
export function NoticePanel({ notice, onAccepted }: { notice: TrackingNotice; onAccepted: (acknowledgedAt: string) => void }) {
  const t = useTranslations("tracking");
  const tErrors = useTranslations("errors");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setError(t("notice.offline"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await acknowledgeTrackingNotice({ version: notice.version });
      if (result.ok) {
        onAccepted(result.data.acknowledged_at);
        return;
      }
      const own = trackingErrorCode(result.code);
      setError(own ? t(`errors.${own}`) : tErrors(result.messageKey, { requestId: result.requestId ?? "—" }));
    } catch {
      setError(t("notice.offline"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="tracking-notice-title" className="space-y-4">
      <div className="space-y-1">
        <h3 id="tracking-notice-title" className="font-semibold">
          {t("notice.title")}
        </h3>
        <p className="text-sm text-muted-foreground">{t("notice.intro")}</p>
      </div>
      <div className="max-h-[50dvh] overflow-y-auto rounded-md border bg-muted/40 p-3">
        <NoticeText notice={notice} />
      </div>
      {error ? <Alert>{error}</Alert> : null}
      <Button type="button" size="lg" className="w-full sm:w-auto" disabled={busy} onClick={() => void accept()}>
        {busy ? t("notice.accepting") : t("notice.accept")}
      </Button>
    </section>
  );
}
