"use client";

import { useTranslations } from "next-intl";
import { Alert } from "@/components/ui/primitives";
import type { TranslatedCode } from "@/lib/errors";
import { planningErrorCode } from "../logic";

/** Translated command error: planning-specific codes first, then the shared errors.*. Only the request id is shown as detail. */
export function PlanningError({
  code,
  messageKey,
  requestId,
  className,
}: {
  code?: string;
  messageKey: TranslatedCode;
  requestId?: string;
  className?: string;
}) {
  const t = useTranslations("errors");
  const tPlanning = useTranslations("planning.errors");
  const own = planningErrorCode(code);
  return <Alert className={className}>{own ? tPlanning(own) : t(messageKey, { requestId: requestId ?? "—" })}</Alert>;
}
