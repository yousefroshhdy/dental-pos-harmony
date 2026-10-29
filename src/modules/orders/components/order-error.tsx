"use client";

import { useTranslations } from "next-intl";
import { Alert } from "@/components/ui/primitives";
import type { OrderErrorCode } from "../logic";
import type { OrderActionState } from "../types";

/** Translated error line (orders.errors.*). The request id is the only detail shown. */
export function OrderError({ code, requestId, className }: { code: OrderErrorCode; requestId?: string; className?: string }) {
  const t = useTranslations("orders.errors");
  return <Alert className={className}>{t(code, { requestId: requestId ?? "—" })}</Alert>;
}

/** Error or success line for a Server Action result; nothing before the first submit. */
export function OrderActionMessage({ state, success, className }: { state: OrderActionState; success?: string; className?: string }) {
  if (!state) return null;
  if (!state.ok) return <OrderError code={state.errorCode} requestId={state.requestId} className={className} />;
  return success ? (
    <Alert tone="success" role="status" className={className}>
      {success}
    </Alert>
  ) : null;
}
