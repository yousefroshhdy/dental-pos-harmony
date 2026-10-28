"use client";

import { useTranslations } from "next-intl";
import { Alert } from "@/components/ui/primitives";
import type { TranslatedCode } from "@/lib/errors";

/** Translated error line (errors.*). The request id is the only detail shown. */
export function ErrorMessage({ messageKey, requestId, className }: { messageKey: TranslatedCode; requestId?: string; className?: string }) {
  const t = useTranslations("errors");
  return <Alert className={className}>{t(messageKey, { requestId: requestId ?? "—" })}</Alert>;
}

/** Error or success line for a Server Action result; nothing before the first submit. */
export function ActionMessage({
  state,
  success,
  className,
}: {
  state: { ok: true } | { ok: false; messageKey: TranslatedCode; requestId?: string } | null;
  /** Shown after a successful submit; omit when the page change is feedback enough. */
  success?: string;
  className?: string;
}) {
  if (!state) return null;
  if (!state.ok) return <ErrorMessage messageKey={state.messageKey} requestId={state.requestId} className={className} />;
  return success ? (
    <Alert tone="success" role="status" className={className}>
      {success}
    </Alert>
  ) : null;
}
