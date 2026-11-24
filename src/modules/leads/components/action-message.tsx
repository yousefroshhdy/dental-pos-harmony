"use client";

import { useTranslations } from "next-intl";
import { Alert } from "@/components/ui/alert";
import type { LeadsActionState } from "../types";

/** The outcome of a leads action, translated (own codes first, then the shared errors.*). */
export function LeadsActionMessage({ state }: { state: LeadsActionState }) {
  const t = useTranslations("leads");
  const tErrors = useTranslations("errors");
  if (!state) return null;
  if (state.ok) {
    if (!state.message) return null;
    return (
      <Alert tone="success" role="status">
        {t(`done.${state.message}`, { count: String(state.count ?? 0) })}
      </Alert>
    );
  }
  return <Alert role="alert">{state.leadsCode ? t(`errors.${state.leadsCode}`) : tErrors(state.messageKey, { requestId: state.requestId ?? "—" })}</Alert>;
}
