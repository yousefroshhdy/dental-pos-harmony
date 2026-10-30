"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label } from "@/components/ui/primitives";
import { cancelTotpEnrolment, confirmTotpEnrolment, startTotpEnrolment } from "../actions";
import { formatSecret } from "../logic";
import type { SecurityErrorKey } from "../types";

type Phase = { step: "idle" } | { step: "scan"; factorId: string; qrCode: string; secret: string };

/**
 * TOTP enrolment: enroll → show the QR code (and the key for manual entry) →
 * challenge + verify the first code. The secret lives only in this component's
 * memory while the user scans it; it is never stored or logged by Honest OS.
 */
export function EnrolTotp() {
  const t = useTranslations("security.enrol");
  const te = useTranslations("security.errors");
  const router = useRouter();
  const nameId = useId();
  const codeId = useId();
  const errorId = useId();
  const [phase, setPhase] = useState<Phase>({ step: "idle" });
  const [error, setError] = useState<SecurityErrorKey | null>(null);
  const [done, setDone] = useState(false);
  const [pending, startTransition] = useTransition();

  function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setDone(false);
    startTransition(async () => {
      const result = await startTotpEnrolment(form);
      if (!result.ok) return setError(result.messageKey);
      setError(null);
      setPhase({ step: "scan", factorId: result.factorId, qrCode: result.qrCode, secret: result.secret });
    });
  }

  function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    startTransition(async () => {
      const result = await confirmTotpEnrolment(form);
      if (!result.ok) return setError(result.messageKey);
      setError(null);
      setPhase({ step: "idle" });
      setDone(true);
      router.refresh();
    });
  }

  function cancel(factorId: string) {
    const form = new FormData();
    form.set("factor_id", factorId);
    startTransition(async () => {
      await cancelTotpEnrolment(form);
      setError(null);
      setPhase({ step: "idle" });
      router.refresh();
    });
  }

  const errorLine = error ? <Alert id={errorId}>{te(error)}</Alert> : null;

  if (phase.step === "scan") {
    return (
      <div className="space-y-4">
        <p className="text-sm font-medium">{t("scan")}</p>
        {/* A data: URL from Supabase Auth (checked by isSafeQrDataUrl); next/image adds nothing for it. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={phase.qrCode} alt={t("qrAlt")} width={192} height={192} className="mx-auto size-48 rounded-md bg-white p-2 sm:mx-0" />
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">{t("secretLabel")}</p>
          <code dir="ltr" className="block rounded-md bg-muted p-2 text-center font-mono text-sm break-all select-all sm:text-start">
            {formatSecret(phase.secret)}
          </code>
        </div>
        <form onSubmit={confirm} className="flex flex-col gap-2">
          <input type="hidden" name="factor_id" value={phase.factorId} />
          <p className="text-sm font-medium">{t("codeStep")}</p>
          <Label htmlFor={codeId}>{t("codeLabel")}</Label>
          <Input
            id={codeId}
            name="code"
            required
            dir="ltr"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={9}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            className="text-center text-lg tracking-widest sm:max-w-48"
          />
          {errorLine}
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button type="button" variant="outline" disabled={pending} onClick={() => cancel(phase.factorId)}>
              {t("cancel")}
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? t("confirming") : t("confirm")}
            </Button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <form onSubmit={start} className="flex flex-col gap-2">
      <p className="text-sm text-muted-foreground">{t("intro")}</p>
      <Label htmlFor={nameId}>{t("nameLabel")}</Label>
      <Input id={nameId} name="friendly_name" maxLength={60} placeholder={t("namePlaceholder")} autoComplete="off" className="sm:max-w-sm" />
      {errorLine}
      {done ? (
        <Alert tone="success" role="status">
          {t("done")}
        </Alert>
      ) : null}
      <Button type="submit" disabled={pending} className="w-full sm:w-auto sm:self-start">
        {pending ? t("starting") : t("start")}
      </Button>
    </form>
  );
}
