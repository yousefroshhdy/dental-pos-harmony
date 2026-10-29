"use client";

import { useTranslations } from "next-intl";
import { Alert } from "@/components/ui/primitives";
import type { TranslatedCode } from "@/lib/errors";
import { fieldErrorCode } from "../logic";

/** Translated command error. Field-specific codes first, then the shared errors.*; only the request id is shown as detail. */
export function FieldError({
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
  const tField = useTranslations("field.errors");
  const own = fieldErrorCode(code);
  return <Alert className={className}>{own ? tField(own) : t(messageKey, { requestId: requestId ?? "—" })}</Alert>;
}
