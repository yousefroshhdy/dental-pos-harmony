"use client";

import { useTranslations } from "next-intl";
import { Alert } from "@/components/ui/primitives";
import type { ActionState, WorkflowErrorKey } from "../types";

/** Translated error line (workflow.errors.*). The request id is the only detail shown. */
export function WorkflowErrorMessage({ messageKey, requestId, className }: { messageKey: WorkflowErrorKey; requestId?: string; className?: string }) {
  const t = useTranslations("workflow.errors");
  return <Alert className={className}>{t(messageKey, { requestId: requestId ?? "—" })}</Alert>;
}

/** Error or success line for a Server Action result; nothing before the first submit. */
export function ActionMessage({ state, success, className }: { state: ActionState; success?: string; className?: string }) {
  if (!state) return null;
  if (!state.ok) return <WorkflowErrorMessage messageKey={state.messageKey} requestId={state.requestId} className={className} />;
  return success ? (
    <Alert tone="success" role="status" className={className}>
      {success}
    </Alert>
  ) : null;
}
