"use client";

import { useTranslations } from "next-intl";
import { Alert } from "@/components/ui/primitives";
import { StepUpLink } from "@/modules/security/components/step-up-link";
import type { ActionFailure } from "../types";

/**
 * Translated error line for a CRM action. A CRM-specific code (crm.errors.*)
 * wins over the generic errors.* message; the request id is the only detail shown.
 */
export function CrmErrorMessage({ failure, className }: { failure: ActionFailure; className?: string }) {
  const tCrm = useTranslations("crm.errors");
  const t = useTranslations("errors");
  const text = failure.crmCode
    ? tCrm(failure.crmCode, { customerNo: "—", ...failure.params })
    : t(failure.messageKey, { requestId: failure.requestId ?? "—" });
  return <Alert className={className}>{text} <StepUpLink code={failure.crmCode ? null : failure.messageKey} /></Alert>;
}

/** Error or success line for a Server Action result; nothing before the first submit. */
export function CrmActionMessage({
  state,
  success,
  className,
}: {
  state: { ok: true } | ActionFailure | null;
  /** Shown after a successful submit; omit when the page change is feedback enough. */
  success?: string;
  className?: string;
}) {
  if (!state) return null;
  if (!state.ok) return <CrmErrorMessage failure={state} className={className} />;
  return success ? (
    <Alert tone="success" role="status" className={className}>
      {success}
    </Alert>
  ) : null;
}
