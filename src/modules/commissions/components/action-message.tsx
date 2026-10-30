"use client";

import { useTranslations } from "next-intl";
import { Alert } from "@/components/ui/primitives";
import type { CommissionActionState } from "../types";

/** Error or success line for a Server Action result; nothing before the first submit. */
export function CommissionActionMessage({ state, className }: { state: CommissionActionState; className?: string }) {
  const tErr = useTranslations("commissions.errors");
  const t = useTranslations("commissions.messages");
  if (!state) return null;
  if (!state.ok) return <Alert className={className}>{tErr(state.errorCode, { requestId: state.requestId ?? "—" })}</Alert>;
  return (
    <Alert tone="success" role="status" className={className}>
      {t(state.message)}
    </Alert>
  );
}
