"use client";

import { useTranslations } from "next-intl";
import { Alert } from "@/components/ui/primitives";
import { StepUpLink } from "@/modules/security/components/step-up-link";
import type { TranslatedCode } from "@/lib/errors";
import type { AdminErrorCode } from "../types";

/**
 * Translated error line. Admin-specific business codes (admin.errors.*) win over the generic
 * errors.* text; the request id is the only detail shown.
 */
export function ErrorMessage({
  messageKey,
  requestId,
  adminCode,
  className,
}: {
  messageKey: TranslatedCode;
  requestId?: string;
  adminCode?: AdminErrorCode;
  className?: string;
}) {
  const t = useTranslations("errors");
  const tAdmin = useTranslations("admin.errors");
  return <Alert className={className}>{adminCode ? tAdmin(adminCode) : t(messageKey, { requestId: requestId ?? "—" })} <StepUpLink code={adminCode ? null : messageKey} /></Alert>;
}

/** Error or success line for a Server Action result; nothing before the first submit. */
export function ActionMessage({
  state,
  success,
  className,
}: {
  state: { ok: true } | { ok: false; messageKey: TranslatedCode; requestId?: string; adminCode?: AdminErrorCode } | null;
  /** Shown after a successful submit; omit when the page change is feedback enough. */
  success?: string;
  className?: string;
}) {
  if (!state) return null;
  if (!state.ok) return <ErrorMessage messageKey={state.messageKey} requestId={state.requestId} adminCode={state.adminCode} className={className} />;
  return success ? (
    <Alert tone="success" role="status" className={className}>
      {success}
    </Alert>
  ) : null;
}
