"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Alert } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import type { JsonObject, QueueItem } from "@/lib/offline/types";
import { cn } from "@/lib/utils";
import { hasCurrentConsent, recordConsent } from "../consent";
import { sendVisitCheckIn } from "../device";
import { METRES } from "../format";
import { captureFix, type GeoFailureReason, type GeoOutcome } from "../geo";
import { asCheckInResult, deviceQueueId, FIELD_QUEUED_COMMANDS, needsException, queuedView, toMetres } from "../logic";
import { buildCheckInPayload } from "../payloads";
import type { CheckInPayload } from "../schemas";
import type { CheckInResult } from "../types";
import { useDeviceSubmit, useQueuedItem } from "../use-device-queue";
import { VerdictBadge } from "./badges";
import { CheckOutForm, SavedCheckOut } from "./check-out-form";
import { ExceptionForm } from "./exception-form";
import { FieldError } from "./field-error";
import { GpsConsentPanel } from "./gps-consent";
import { QueuedNotice } from "./queued-notice";

type Phase =
  | { kind: "idle" }
  | { kind: "consent" }
  | { kind: "locating" }
  | { kind: "geoFailed"; failure: GeoOutcome & { ok: false } }
  | { kind: "sending" }
  | { kind: "queued"; item: QueueItem }
  | { kind: "failed"; code: string; messageKey: Parameters<typeof FieldError>[0]["messageKey"]; requestId?: string; retryable: boolean }
  | { kind: "done"; result: CheckInResult };

/**
 * One-tap check-in: consent (first time) → one high-accuracy fix → command →
 * the server's verdict. The visit id, the fix and the device time are fixed at
 * the tap, before the first attempt (the planned visit's id, or a new
 * crypto.randomUUID()). Offline, or when the request is lost, the same payload
 * is saved on the device and the offline queue sends it later; the server then
 * judges the device time against its own clock (late_sync / clock_skew flags).
 * A replay can never create a second visit.
 */
export function CheckInButton({
  visitId,
  customerId,
  customerName,
  userId,
  mayRequestException,
  size = "default",
}: {
  /** The planned visit's id; omit for an unplanned visit. */
  visitId?: string;
  customerId: string;
  customerName: string;
  userId: string;
  mayRequestException: boolean;
  size?: "default" | "lg";
}) {
  const t = useTranslations("field.checkIn");
  const tOffline = useTranslations("field.offline");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const visitIdRef = useRef<string | null>(visitId ?? null);
  const payloadRef = useRef<CheckInPayload | null>(null);
  const submit = useDeviceSubmit(userId);
  // A planned visit may already have a check-in saved on this device (e.g. before a reload).
  const watchedId = phase.kind === "queued" ? phase.item.id : phase.kind === "idle" ? visitId : undefined;
  const saved = useQueuedItem(userId, watchedId);

  const ensureVisitId = () => (visitIdRef.current ??= crypto.randomUUID());

  async function send(payload: CheckInPayload) {
    payloadRef.current = payload;
    setPhase({ kind: "sending" });
    const outcome = await submit<CheckInResult>(
      {
        command: FIELD_QUEUED_COMMANDS.checkIn,
        id: deviceQueueId(FIELD_QUEUED_COMMANDS.checkIn, payload.visit_id),
        args: payload as unknown as JsonObject,
        groupKey: payload.visit_id,
        summary: customerName,
      },
      () => sendVisitCheckIn(payload),
    );
    if (outcome.kind === "sent") setPhase({ kind: "done", result: outcome.data });
    else if (outcome.kind === "queued") setPhase({ kind: "queued", item: outcome.item });
    else setPhase({ kind: "failed", code: outcome.code, messageKey: outcome.messageKey, requestId: outcome.requestId, retryable: outcome.retryable });
  }

  async function locate() {
    setPhase({ kind: "locating" });
    const geo = await captureFix();
    if (geo.ok) await send(buildCheckInPayload({ visitId: ensureVisitId(), customerId, geo, consented: true }));
    else setPhase({ kind: "geoFailed", failure: geo });
  }

  function start() {
    if (payloadRef.current) {
      void send(payloadRef.current); // replay the exact payload of the failed attempt
      return;
    }
    if (hasCurrentConsent(userId)) void locate();
    else setPhase({ kind: "consent" });
  }

  function withoutLocation(failure: GeoOutcome | null) {
    void send(buildCheckInPayload({ visitId: ensureVisitId(), customerId, geo: failure, consented: hasCurrentConsent(userId) }));
  }

  const savedItem = saved ?? (phase.kind === "queued" ? phase.item : undefined);
  if (savedItem && (phase.kind === "idle" || phase.kind === "queued")) {
    const synced = savedItem.status === "done" ? asCheckInResult(savedItem.result) : null;
    if (synced) return <CheckInVerdict result={synced} userId={userId} mayRequestException={mayRequestException} />;
    return <SavedCheckIn item={savedItem} userId={userId} message={tOffline("checkIn")} />;
  }

  switch (phase.kind) {
    case "consent":
      return (
        <GpsConsentPanel
          onAccept={() => {
            recordConsent(userId);
            void locate();
          }}
          onWithoutLocation={() => withoutLocation(null)}
          onCancel={() => setPhase({ kind: "idle" })}
        />
      );

    case "locating":
    case "sending":
      return (
        <div role="status" aria-live="polite" className="flex min-h-11 items-center gap-2 text-sm text-muted-foreground">
          <span className="inline-block size-3 animate-pulse rounded-full bg-primary" aria-hidden />
          {phase.kind === "locating" ? t("locating") : t("sending")}
        </div>
      );

    case "geoFailed":
      return (
        <div className="space-y-2">
          <Alert tone="info">{t(`geo.${phase.failure.reason satisfies GeoFailureReason}`)}</Alert>
          <div className="flex flex-col gap-2 sm:flex-row">
            {phase.failure.reason === "timeout" || phase.failure.reason === "unavailable" ? (
              <Button type="button" onClick={() => void locate()}>
                {t("retryGps")}
              </Button>
            ) : null}
            <Button type="button" variant="outline" onClick={() => withoutLocation(phase.failure)}>
              {t("withoutLocation")}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setPhase({ kind: "idle" })}>
              {t("cancel")}
            </Button>
          </div>
        </div>
      );

    case "failed":
      return (
        <div className="space-y-2">
          <FieldError code={phase.code} messageKey={phase.messageKey} requestId={phase.requestId} />
          <div className="flex flex-col gap-2 sm:flex-row">
            {phase.retryable ? (
              <Button type="button" onClick={start}>
                {t("retry")}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                if (!phase.retryable) payloadRef.current = null; // the server refused it; build afresh next time
                setPhase({ kind: "idle" });
              }}
            >
              {t("close")}
            </Button>
          </div>
        </div>
      );

    case "done":
      return <CheckInVerdict result={phase.result} userId={userId} mayRequestException={mayRequestException} />;

    default:
      return (
        <Button type="button" size={size} onClick={start} className="w-full sm:w-auto" aria-label={t("buttonFor", { name: customerName })}>
          {t("button")}
        </Button>
      );
  }
}

/** The server's verdict: from the direct answer, or from the queue once a saved check-in synced. */
function CheckInVerdict({ result, userId, mayRequestException }: { result: CheckInResult; userId: string; mayRequestException: boolean }) {
  const t = useTranslations("field.checkIn");
  const format = useFormatter();
  const distance = toMetres(result.distance_m);
  return (
    <div className="space-y-3" role="status" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{t("verdictLabel")}</span>
        <VerdictBadge status={result.verification_status} />
        {distance !== null ? <span className="text-xs text-muted-foreground">{t("distance", { distance: format.number(distance, METRES) })}</span> : null}
      </div>
      <p className="text-sm text-muted-foreground">{t(`help.${result.verification_status}`)}</p>
      {result.replayed ? <p className="text-xs text-muted-foreground">{t("replayed")}</p> : null}
      <SavedCheckOut visitId={result.visit_id} userId={userId} />
      {needsException(result.verification_status) && mayRequestException ? <ExceptionForm visitId={result.visit_id} /> : null}
      <Link href={`/visits/${result.visit_id}`} className={buttonVariants({ variant: "outline", className: "w-full sm:w-auto" })}>
        {t("openVisit")}
      </Link>
    </div>
  );
}

/**
 * A check-in saved on the device. While it waits, the rep can also check out
 * here: the visit page needs the server, so this is the only offline check-out
 * path. The check-out is queued behind the check-in (same group).
 */
function SavedCheckIn({ item, userId, message }: { item: QueueItem; userId: string; message: string }) {
  const tOffline = useTranslations("field.offline");
  const visitId = typeof item.args.visit_id === "string" ? item.args.visit_id : null;
  const capturedAt = typeof item.args.captured_at === "string" ? item.args.captured_at : null;
  return (
    <div className="space-y-3">
      <QueuedNotice item={item} message={message} capturedAt={capturedAt} />
      {visitId && queuedView(item) === "waiting" ? (
        <details className="w-full">
          <summary
            className={cn(buttonVariants({ variant: "outline" }), "w-full cursor-pointer list-none select-none sm:w-auto [&::-webkit-details-marker]:hidden")}
          >
            {tOffline("checkOutNow")}
          </summary>
          <div className="mt-3">
            <CheckOutForm visitId={visitId} userId={userId} />
          </div>
        </details>
      ) : null}
    </div>
  );
}
