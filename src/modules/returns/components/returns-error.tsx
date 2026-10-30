"use client";

import { useTranslations } from "next-intl";
import { Alert } from "@/components/ui/primitives";
import type { ReturnErrorCode } from "../logic";
import type { ReturnActionState } from "../types";

/** Translated error line (returns.errors.*). The request id is the only detail shown. */
export function ReturnsError({ code, requestId, className }: { code: ReturnErrorCode; requestId?: string; className?: string }) {
  const t = useTranslations("returns.errors");
  return <Alert className={className}>{t(code, { requestId: requestId ?? "—" })}</Alert>;
}

/** Error or success line for a Server Action result; nothing before the first submit. */
export function ReturnsActionMessage({ state, className }: { state: ReturnActionState; className?: string }) {
  const t = useTranslations("returns.messages");
  if (!state) return null;
  if (!state.ok) return <ReturnsError code={state.errorCode} requestId={state.requestId} className={className} />;
  return state.message ? (
    <Alert tone="success" role="status" className={className}>
      {t(state.message)}
    </Alert>
  ) : null;
}
