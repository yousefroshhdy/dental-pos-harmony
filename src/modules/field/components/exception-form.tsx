"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label } from "@/components/ui/primitives";
import { sendVisitException } from "../device";
import type { DeviceResult, ExceptionResult } from "../types";
import { FieldError } from "./field-error";

/**
 * Ask a manager to accept a visit whose GPS verdict is not "verified"
 * (api.request_visit_exception → approvals inbox). The DB checks the
 * permission, the visit's owner and that the verdict is eligible.
 */
export function ExceptionForm({ visitId, refreshOnSuccess = false }: { visitId: string; refreshOnSuccess?: boolean }) {
  const t = useTranslations("field.exception");
  const router = useRouter();
  const inputId = useId();
  const [reason, setReason] = useState("");
  const [result, setResult] = useState<DeviceResult<ExceptionResult> | null>(null);
  const [pending, startTransition] = useTransition();

  if (result?.ok) {
    return (
      <Alert tone="success" role="status">
        {t("requested")}
      </Alert>
    );
  }

  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          const r = await sendVisitException({ visit_id: visitId, reason: reason.trim() });
          setResult(r);
          if (r.ok && refreshOnSuccess) router.refresh(); // show the new verdict on the page
        });
      }}
    >
      <Label htmlFor={inputId}>{t("reasonLabel")}</Label>
      <Input
        id={inputId}
        name="reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        required
        minLength={3}
        maxLength={500}
        placeholder={t("reasonPlaceholder")}
        autoComplete="off"
      />
      <p className="text-xs text-muted-foreground">{t("hint")}</p>
      <Button type="submit" variant="outline" disabled={pending} className="w-full sm:w-auto">
        {pending ? t("sending") : t("submit")}
      </Button>
      {result && !result.ok ? <FieldError code={result.code} messageKey={result.messageKey} requestId={result.requestId} /> : null}
    </form>
  );
}
