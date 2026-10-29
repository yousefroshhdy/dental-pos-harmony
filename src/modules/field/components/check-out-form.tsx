"use client";

import { useTranslations } from "next-intl";
import { useEffect, useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label, Select } from "@/components/ui/primitives";
import { useRouter } from "@/i18n/navigation";
import type { JsonObject } from "@/lib/offline/types";
import { hasCurrentConsent } from "../consent";
import { sendVisitCheckOut } from "../device";
import { captureFix, type GeoOutcome } from "../geo";
import { checkedOutParam, deviceQueueId, FIELD_QUEUED_COMMANDS, queuedView, zonedLocalToInstant } from "../logic";
import { buildCheckOutPayload } from "../payloads";
import type { CheckOutPayload } from "../schemas";
import { VISIT_OUTCOMES, type CheckOutResult, type VisitOutcome } from "../types";
import { useDeviceSubmit, useQueuedItem } from "../use-device-queue";
import { FieldError } from "./field-error";
import { QueuedNotice } from "./queued-notice";

type SendError = { code: string; messageKey: Parameters<typeof FieldError>[0]["messageKey"]; requestId?: string };

const checkOutQueueId = (visitId: string) => deviceQueueId(FIELD_QUEUED_COMMANDS.checkOut, visitId);

/**
 * Check-out: outcome, notes, optional next follow-up (creates a task), and one
 * GPS fix when the rep has given consent on this device. Without consent or a
 * fix the check-out is still recorded; the check-in verdict is what counts.
 * Offline (or when the request is lost) the payload, fix and device time
 * included, is saved on the device and sent later by the offline queue, after
 * the visit's check-in if that is still waiting too.
 */
export function CheckOutForm({ visitId, userId }: { visitId: string; userId: string }) {
  const t = useTranslations("field.checkOut");
  const tOutcome = useTranslations("field.outcome");
  const tOffline = useTranslations("field.offline");
  const router = useRouter();
  const ids = { outcome: useId(), notes: useId(), next: useId() };
  const [outcome, setOutcome] = useState<VisitOutcome | "">("");
  const [notes, setNotes] = useState("");
  const [nextLocal, setNextLocal] = useState("");
  const [busy, setBusy] = useState<"locating" | "sending" | null>(null);
  const [done, setDone] = useState<CheckOutResult | null>(null);
  const [error, setError] = useState<SendError | null>(null);
  const [inputError, setInputError] = useState(false);
  // The payload of a failed, retryable send: a retry must send exactly what was already sent.
  const [pendingPayload, setPendingPayload] = useState<CheckOutPayload | null>(null);
  const submit = useDeviceSubmit(userId);
  const saved = useQueuedItem(userId, checkOutQueueId(visitId));
  const savedSynced = saved?.status === "done";
  const syncedParam = savedSynced ? checkedOutParam(saved?.result) : null;

  // A saved check-out reached the server: show the visit as the server now has it.
  useEffect(() => {
    if (syncedParam) router.replace(`/visits/${visitId}?checkedOut=${syncedParam}`);
    // Runs once when the saved check-out syncs; the router's identity is not a trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncedParam, visitId]);

  async function send(payload: CheckOutPayload) {
    setBusy("sending");
    setError(null);
    const r = await submit<CheckOutResult>(
      {
        command: FIELD_QUEUED_COMMANDS.checkOut,
        id: checkOutQueueId(visitId),
        args: payload as unknown as JsonObject,
        groupKey: visitId,
      },
      () => sendVisitCheckOut(payload),
    );
    setBusy(null);
    if (r.kind === "sent") {
      setPendingPayload(null);
      setDone(r.data);
      // The re-rendered page no longer shows this form, so it carries the confirmation.
      router.replace(`/visits/${visitId}?checkedOut=${r.data.follow_up_task_id ? "followUp" : "1"}`);
    } else if (r.kind === "queued") {
      setPendingPayload(null); // the queue owns it now; the notice below replaces the form
    } else {
      setError({ code: r.code, messageKey: r.messageKey, requestId: r.requestId });
      setPendingPayload(r.retryable ? payload : null);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setInputError(false);
    if (pendingPayload) return send(pendingPayload);
    if (!outcome) return setInputError(true);
    const nextFollowUpAt = nextLocal ? (zonedLocalToInstant(nextLocal)?.toISOString() ?? null) : null;
    if (nextLocal && !nextFollowUpAt) return setInputError(true);

    // The fix and the device time are taken now, at the tap, and stored with a queued check-out.
    let geo: GeoOutcome | null = null;
    if (hasCurrentConsent(userId)) {
      setBusy("locating");
      geo = await captureFix();
    }
    const payload = buildCheckOutPayload({ visitId, outcome, notes, nextFollowUpAt, geo });
    if (payload.next_follow_up_at && Date.parse(payload.next_follow_up_at) <= Date.parse(payload.captured_at)) {
      setBusy(null);
      return setInputError(true);
    }
    return send(payload);
  }

  if (done || savedSynced) {
    const followUp = done ? Boolean(done.follow_up_task_id) : checkedOutParam(saved?.result) === "followUp";
    return (
      <Alert tone="success" role="status">
        {followUp ? t("doneWithFollowUp") : t("done")}
      </Alert>
    );
  }

  if (saved) {
    const capturedAt = typeof saved.args.captured_at === "string" ? saved.args.captured_at : null;
    return <QueuedNotice item={saved} message={tOffline("checkOut")} capturedAt={capturedAt} />;
  }

  const locked = pendingPayload !== null;
  return (
    <form onSubmit={onSubmit} className="space-y-3" noValidate>
      <div className="space-y-1">
        <Label htmlFor={ids.outcome}>{t("outcome")}</Label>
        <Select
          id={ids.outcome}
          name="outcome"
          required
          value={outcome}
          disabled={locked}
          onChange={(e) => setOutcome(e.target.value as VisitOutcome)}
          className="w-full"
          aria-invalid={inputError && !outcome ? true : undefined}
        >
          <option value="" disabled>
            {t("chooseOutcome")}
          </option>
          {VISIT_OUTCOMES.map((o) => (
            <option key={o} value={o}>
              {tOutcome(o)}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor={ids.notes}>{t("notes")}</Label>
        <textarea
          id={ids.notes}
          name="notes"
          value={notes}
          disabled={locked}
          onChange={(e) => setNotes(e.target.value)}
          maxLength={2000}
          rows={3}
          placeholder={t("notesPlaceholder")}
          className="w-full rounded-md border bg-card px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={ids.next}>{t("nextFollowUp")}</Label>
        <Input
          id={ids.next}
          name="next_follow_up"
          type="datetime-local"
          value={nextLocal}
          disabled={locked}
          onChange={(e) => setNextLocal(e.target.value)}
          aria-describedby={`${ids.next}-hint`}
        />
        <p id={`${ids.next}-hint`} className="text-xs text-muted-foreground">
          {t("nextFollowUpHint")}
        </p>
      </div>
      {inputError ? <Alert>{t("invalid")}</Alert> : null}
      {error ? <FieldError code={error.code} messageKey={error.messageKey} requestId={error.requestId} /> : null}
      <Button type="submit" size="lg" disabled={busy !== null} className="w-full sm:w-auto">
        {busy === "locating" ? t("locating") : busy === "sending" ? t("sending") : locked ? t("retry") : t("submit")}
      </Button>
    </form>
  );
}

/**
 * Under a check-in verdict: the visit's check-out if one is saved on this
 * device (e.g. done offline from the check-in card). Renders nothing otherwise.
 */
export function SavedCheckOut({ visitId, userId }: { visitId: string; userId: string }) {
  const t = useTranslations("field.checkOut");
  const tOffline = useTranslations("field.offline");
  const saved = useQueuedItem(userId, checkOutQueueId(visitId));
  if (!saved) return null;
  if (queuedView(saved) === "synced") {
    return (
      <Alert tone="success" role="status">
        {checkedOutParam(saved.result) === "followUp" ? t("doneWithFollowUp") : t("done")}
      </Alert>
    );
  }
  const capturedAt = typeof saved.args.captured_at === "string" ? saved.args.captured_at : null;
  return <QueuedNotice item={saved} message={tOffline("checkOut")} capturedAt={capturedAt} />;
}
