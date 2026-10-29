"use client";

import { useTranslations } from "next-intl";
import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label, Select } from "@/components/ui/primitives";
import { useRouter } from "@/i18n/navigation";
import { hasCurrentConsent } from "../consent";
import { sendVisitCheckOut } from "../device";
import { captureFix, type GeoOutcome } from "../geo";
import { zonedLocalToInstant } from "../logic";
import { buildCheckOutPayload } from "../payloads";
import type { CheckOutPayload } from "../schemas";
import { VISIT_OUTCOMES, type DeviceResult, type CheckOutResult, type VisitOutcome } from "../types";
import { FieldError } from "./field-error";

/**
 * Check-out: outcome, notes, optional next follow-up (creates a task), and one
 * GPS fix when the rep has given consent on this device. Without consent or a
 * fix the check-out is still recorded; the check-in verdict is what counts.
 */
export function CheckOutForm({ visitId, userId }: { visitId: string; userId: string }) {
  const t = useTranslations("field.checkOut");
  const tOutcome = useTranslations("field.outcome");
  const router = useRouter();
  const ids = { outcome: useId(), notes: useId(), next: useId() };
  const [outcome, setOutcome] = useState<VisitOutcome | "">("");
  const [notes, setNotes] = useState("");
  const [nextLocal, setNextLocal] = useState("");
  const [busy, setBusy] = useState<"locating" | "sending" | null>(null);
  const [result, setResult] = useState<DeviceResult<CheckOutResult> | null>(null);
  const [inputError, setInputError] = useState(false);
  // The payload of a failed, retryable send: a retry must send exactly what was already sent.
  const [pendingPayload, setPendingPayload] = useState<CheckOutPayload | null>(null);

  async function send(payload: CheckOutPayload) {
    setBusy("sending");
    const r = await sendVisitCheckOut(payload);
    setBusy(null);
    setResult(r);
    setPendingPayload(!r.ok && r.retryable ? payload : null);
    // The re-rendered page no longer shows this form, so it carries the confirmation.
    if (r.ok) router.replace(`/visits/${visitId}?checkedOut=${r.data.follow_up_task_id ? "followUp" : "1"}`);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setInputError(false);
    if (pendingPayload) return send(pendingPayload);
    if (!outcome) return setInputError(true);
    const nextFollowUpAt = nextLocal ? (zonedLocalToInstant(nextLocal)?.toISOString() ?? null) : null;
    if (nextLocal && !nextFollowUpAt) return setInputError(true);

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

  if (result?.ok) {
    return (
      <Alert tone="success" role="status">
        {result.data.follow_up_task_id ? t("doneWithFollowUp") : t("done")}
      </Alert>
    );
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
      {result && !result.ok ? <FieldError code={result.code} messageKey={result.messageKey} requestId={result.requestId} /> : null}
      <Button type="submit" size="lg" disabled={busy !== null} className="w-full sm:w-auto">
        {busy === "locating" ? t("locating") : busy === "sending" ? t("sending") : locked ? t("retry") : t("submit")}
      </Button>
    </form>
  );
}
