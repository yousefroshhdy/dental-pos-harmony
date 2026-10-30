import { getTranslations } from "next-intl/server";
import { Alert } from "@/components/ui/primitives";
import { StepUpLink } from "@/modules/security/components/step-up-link";
import type { AppError } from "@/lib/errors";
import { auditErrorCode } from "../logic";

/** Translated error line (audit.errors.*). The request id is the only detail shown. */
export async function AuditError({ error }: { error: AppError }) {
  const t = await getTranslations("audit.errors");
  return <Alert>{t(auditErrorCode(error), { requestId: error.requestId ?? "—" })} <StepUpLink code={auditErrorCode(error)} /></Alert>;
}
