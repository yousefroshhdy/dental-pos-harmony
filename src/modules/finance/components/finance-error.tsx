"use client";

import { useTranslations } from "next-intl";
import { Alert } from "@/components/ui/primitives";
import type { FinanceErrorCode } from "../logic";
import type { FinanceActionState } from "../types";

/** Translated error line (finance.errors.*). The request id is the only detail shown. */
export function FinanceError({ code, requestId, className }: { code: FinanceErrorCode; requestId?: string; className?: string }) {
  const t = useTranslations("finance.errors");
  return <Alert className={className}>{t(code, { requestId: requestId ?? "—" })}</Alert>;
}

/** Error or success line for a Server Action result; nothing before the first submit. */
export function FinanceActionMessage({ state, success, className }: { state: FinanceActionState; success?: string; className?: string }) {
  const t = useTranslations("finance.messages");
  if (!state) return null;
  if (!state.ok) return <FinanceError code={state.errorCode} requestId={state.requestId} className={className} />;
  const text = success ?? (state.message ? t(state.message) : null);
  return text ? (
    <Alert tone="success" role="status" className={className}>
      {text}
    </Alert>
  ) : null;
}
