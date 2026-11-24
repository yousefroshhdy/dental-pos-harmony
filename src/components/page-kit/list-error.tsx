import { CircleAlertIcon } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { EmptyState } from "@/components/ui/empty-state";
import type { TranslatedCode } from "@/lib/errors";
import { StepUpLink } from "@/modules/security/components/step-up-link";
import { isMfaRequired } from "@/modules/security/logic";

/**
 * A list or panel whose read failed: the translated `errors.*` text with the
 * request id, and the step-up link when the read needs MFA. Shown in place of
 * the rows, never as an empty list or a zero.
 */
export async function ListError({
  error,
  title,
  compact = false,
}: {
  error: { messageKey: TranslatedCode; requestId?: string };
  /** Optional heading (e.g. "Couldn't load the users"); the error text becomes the description. */
  title?: string;
  compact?: boolean;
}) {
  const t = await getTranslations("errors");
  const text = t(error.messageKey, { requestId: error.requestId ?? "—" });
  return (
    <EmptyState
      role="alert"
      tone="danger"
      compact={compact}
      icon={<CircleAlertIcon aria-hidden="true" />}
      title={title ?? text}
      description={title ? text : undefined}
      action={isMfaRequired({ code: error.messageKey }) ? <StepUpLink code={error.messageKey} /> : undefined}
    />
  );
}
