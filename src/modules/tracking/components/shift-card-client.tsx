"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Badge, Card } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import type { TranslatedCode } from "@/lib/errors";
import { captureFix } from "@/modules/field/geo";
import { useQueuedItem, useQueueItems } from "@/modules/field/use-device-queue";
import { trackingStoreFor } from "../device-store";
import { CAIRO_DATE_TIME, CAIRO_TIME, formatDuration } from "../format";
import { elapsedSeconds, TRACKING_QUEUED_COMMANDS, trackingErrorCode, type TrackingSubmit } from "../logic";
import type { StartShiftResult, TrackingStatus } from "../types";
import { applyServerStatus, dismissStartFailed, endDay, forgetFailedStart, startDay, useClock, useNativeShell, useTrackingState } from "../use-tracking";
import { NativeProblemAlert, NativeTrackingHelp } from "./native-help";
import { NoticePanel, NoticeText } from "./notice";

type Phase =
  | { kind: "idle" }
  | { kind: "locating" }
  | { kind: "sending" }
  | { kind: "confirmEnd" }
  | { kind: "ending" }
  | { kind: "nativeDenied" }
  | { kind: "message"; tone: "info" | "success" | "danger"; text: string };

/**
 * The rep's working day: notice (first time) → Start my day → status while on
 * shift (time on shift, last point, points waiting) → End my day. The commands
 * go through the offline queue when there is no connection (use-tracking.ts).
 */
export function ShiftCardClient({ userId, employeeId, status }: { userId: string; employeeId: string; status: TrackingStatus }) {
  const t = useTranslations("tracking");
  const tErrors = useTranslations("errors");
  const format = useFormatter();
  const state = useTrackingState(userId);
  const [acknowledgedAt, setAcknowledgedAt] = useState<string | null>(status.acknowledged_at);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [showNotice, setShowNotice] = useState(false);
  const now = useClock();
  const native = useNativeShell();
  const shift = state.shift;

  // The server's view (read when the page rendered) → the device state.
  useEffect(() => applyServerStatus(userId, status, Date.now()), [userId, status]);

  // A start saved offline: follow it until the server answers.
  const startItem = useQueuedItem(userId, shift && !shift.confirmed ? shift.ref : null);
  useEffect(() => {
    if (!startItem || !shift || startItem.id !== shift.ref) return;
    if (startItem.status === "done") {
      const result = startItem.result as unknown as StartShiftResult | null;
      trackingStoreFor(userId).update((s) =>
        s.shift?.ref === startItem.id
          ? {
              ...s,
              shift: {
                ...s.shift,
                confirmed: true,
                confirmedAtMs: Date.now(),
                serverId: result?.shift_id ?? null,
                startedAt: result?.window_start ?? s.shift.startedAt,
                maxEndAt: result?.max_end_at ?? s.shift.maxEndAt,
              },
            }
          : s,
      );
    } else if (startItem.status === "failed") {
      forgetFailedStart(userId, startItem.id);
    }
  }, [startItem, shift, userId]);

  const items = useQueueItems(userId);
  const queuedPoints = (items ?? [])
    .filter((i) => i.command === TRACKING_QUEUED_COMMANDS.recordPings && i.status !== "done")
    .reduce((n, i) => n + (Array.isArray(i.args.pings) ? i.args.pings.length : 0), 0);
  const waiting = queuedPoints + state.buffer.length;

  const errorText = (outcome: { code: string; messageKey: TranslatedCode; requestId?: string }) => {
    const own = trackingErrorCode(outcome.code);
    return own ? t(`errors.${own}`) : tErrors(outcome.messageKey, { requestId: outcome.requestId ?? "—" });
  };

  async function onStart() {
    dismissStartFailed(userId);
    setPhase({ kind: "locating" });
    const geo = await captureFix();
    if (!geo.ok && (geo.reason === "denied" || geo.reason === "unsupported" || geo.reason === "insecure")) {
      // In the Android shell, a refusal is fixed in the app's settings, not the browser's.
      setPhase(native && geo.reason === "denied" ? { kind: "nativeDenied" } : { kind: "message", tone: "danger", text: t(`shift.geo.${geo.reason}`) });
      return;
    }
    setPhase({ kind: "sending" });
    const outcome: TrackingSubmit<StartShiftResult> = await startDay(userId, geo.ok ? geo : null, t("shift.summaryStart"));
    if (outcome.kind === "sent") {
      setPhase(geo.ok ? { kind: "idle" } : { kind: "message", tone: "info", text: t(`shift.geo.${geo.reason}`) });
    } else if (outcome.kind === "queued") {
      setPhase({ kind: "message", tone: "info", text: t("shift.queuedStart") });
    } else {
      if (outcome.code === "NOTICE_REQUIRED" || outcome.code === "NOTICE_OUTDATED") setAcknowledgedAt(null);
      setPhase({ kind: "message", tone: "danger", text: errorText(outcome) });
    }
  }

  async function onEnd() {
    setPhase({ kind: "ending" });
    const geo = await captureFix();
    const outcome = await endDay(userId, geo.ok ? geo : null, t("shift.summaryEnd"));
    if (outcome.kind === "sent") {
      setPhase({ kind: "message", tone: "success", text: t("shift.ended", { duration: formatDuration(t, outcome.data.shift_seconds) }) });
    } else if (outcome.kind === "queued") {
      setPhase({ kind: "message", tone: "info", text: t("shift.queuedEnd") });
    } else {
      setPhase({ kind: "message", tone: outcome.code === "NO_OPEN_SHIFT" ? "info" : "danger", text: errorText(outcome) });
    }
  }

  const busy = phase.kind === "locating" || phase.kind === "sending" || phase.kind === "ending";
  const busyText = phase.kind === "locating" || phase.kind === "sending" ? t("shift.starting") : phase.kind === "ending" ? t("shift.ending") : null;
  const badge = shift ? (shift.confirmed ? { tone: "success" as const, text: t("shift.on") } : { tone: "info" as const, text: t("shift.pending") }) : { tone: "neutral" as const, text: t("shift.off") };

  return (
    <Card className="space-y-4" aria-labelledby="shift-card-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="shift-card-title" className="text-lg font-semibold">
          {t("shift.title")}
        </h2>
        <Badge tone={badge.tone}>{badge.text}</Badge>
      </div>

      {!status.notice ? (
        <Alert tone="info">{t("notice.missing")}</Alert>
      ) : !acknowledgedAt && !shift ? (
        <NoticePanel notice={status.notice} onAccepted={setAcknowledgedAt} />
      ) : (
        <>
          {shift ? (
            <div className="space-y-2 text-sm" aria-live="polite">
              <p>
                {t("shift.since", { time: format.dateTime(new Date(shift.startedAt), CAIRO_TIME) })}
                {now !== null ? <> · {t("shift.elapsed", { duration: formatDuration(t, elapsedSeconds(shift, now)) })}</> : null}
              </p>
              <p className="text-muted-foreground">
                {state.lastSampleMs ? t("shift.lastPoint", { time: format.dateTime(new Date(state.lastSampleMs), CAIRO_TIME) }) : t("shift.noPoint")}
                {" · "}
                {t("shift.waiting", { count: waiting })}
              </p>
              {state.lastSentMs ? (
                <p className="text-muted-foreground">{t("shift.lastSent", { time: format.dateTime(new Date(state.lastSentMs), CAIRO_TIME) })}</p>
              ) : null}
              {state.problem ? (
                native ? (
                  <NativeProblemAlert problem={state.problem} />
                ) : (
                  <Alert>{t(`shift.geo.${state.problem === "services_off" ? "unavailable" : state.problem}`)}</Alert>
                )
              ) : null}
              {shift.overdue || (now !== null && now >= Date.parse(shift.maxEndAt)) ? (
                <Alert>{t("shift.overdue", { hours: String(state.maxShiftHours) })}</Alert>
              ) : null}
              {native ? null : <Alert tone="info">{t("shift.browserLimit")}</Alert>}
            </div>
          ) : (
            <div className="space-y-1 text-sm text-muted-foreground">
              <p>{t("shift.offHours")}</p>
              {status.today_shift_seconds > 0 ? <p>{t("shift.todayTotal", { duration: formatDuration(t, status.today_shift_seconds) })}</p> : null}
            </div>
          )}

          {native ? <NativeTrackingHelp onShift={shift !== null} /> : null}
          {state.startFailed && !shift ? <Alert>{t("shift.startFailed")}</Alert> : null}
          {phase.kind === "message" ? <Alert tone={phase.tone}>{phase.text}</Alert> : null}
          {phase.kind === "nativeDenied" ? <NativeProblemAlert problem="denied" /> : null}
          {busyText ? (
            <p role="status" aria-live="polite" className="flex min-h-11 items-center gap-2 text-sm text-muted-foreground">
              <span className="inline-block size-3 animate-pulse rounded-full bg-primary motion-reduce:animate-none" aria-hidden="true" />
              {busyText}
            </p>
          ) : null}

          {phase.kind === "confirmEnd" ? (
            <div className="space-y-2 rounded-md border p-3">
              <p className="text-sm font-medium">{t("shift.confirmEnd")}</p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button type="button" variant="destructive" onClick={() => void onEnd()}>
                  {t("shift.confirm")}
                </Button>
                <Button type="button" variant="outline" onClick={() => setPhase({ kind: "idle" })}>
                  {t("shift.cancel")}
                </Button>
              </div>
            </div>
          ) : shift ? (
            <Button type="button" variant="outline" size="lg" className="w-full sm:w-auto" disabled={busy} onClick={() => setPhase({ kind: "confirmEnd" })}>
              {t("shift.end")}
            </Button>
          ) : (
            <Button type="button" size="lg" className="w-full sm:w-auto" disabled={busy} onClick={() => void onStart()}>
              {t("shift.start")}
            </Button>
          )}

          <div className="flex flex-wrap gap-x-4 text-sm">
            <Link
              href={`/tracking/${employeeId}/${status.business_date}`}
              className="inline-flex min-h-11 items-center text-primary underline-offset-4 hover:underline"
            >
              {t("shift.myDay")}
            </Link>
            <button
              type="button"
              aria-expanded={showNotice}
              onClick={() => setShowNotice((v) => !v)}
              className="inline-flex min-h-11 items-center text-primary underline-offset-4 hover:underline"
            >
              {showNotice ? t("notice.hide") : t("notice.show")}
            </button>
          </div>
          {showNotice ? (
            <div className="space-y-2 rounded-md border bg-muted/40 p-3">
              <NoticeText notice={status.notice} />
              {acknowledgedAt ? (
                <p className="text-xs text-muted-foreground">
                  {t("notice.acknowledged", { date: format.dateTime(new Date(acknowledgedAt), CAIRO_DATE_TIME) })}
                </p>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </Card>
  );
}
