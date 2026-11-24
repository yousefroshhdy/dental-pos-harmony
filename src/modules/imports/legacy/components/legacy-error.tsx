"use client";

import { useTranslations } from "next-intl";
import { Alert } from "@/components/ui/primitives";
import type { TranslatedCode } from "@/lib/errors";
import { StepUpLink } from "@/modules/security/components/step-up-link";
import type { LegacyProblem } from "../schemas";
import { MAX_SHEET_ROWS, MAX_WORKBOOK_BYTES } from "../upload";

const SPECIFIC = ["LEGACY_ORDER", "LEGACY_DECISION", "INVALID_STATE", "ALREADY_COMMITTED", "CONFLICT", "CONFIRM_REQUIRED"] as const;
type Specific = (typeof SPECIFIC)[number];
const isSpecific = (code: string | undefined): code is Specific => (SPECIFIC as readonly string[]).includes(code ?? "");

/** An upload problem, a legacy-import business code, or the generic errors.<messageKey> (with the MFA way out). */
export function LegacyError({
  code,
  messageKey,
  requestId,
  problem,
  className,
}: {
  code?: string;
  messageKey: TranslatedCode;
  requestId?: string;
  problem?: LegacyProblem;
  className?: string;
}) {
  const t = useTranslations("legacyImport");
  const tErrors = useTranslations("errors");
  const text = problem
    ? t(`problems.${problem}`, { mb: MAX_WORKBOOK_BYTES / (1024 * 1024), rows: MAX_SHEET_ROWS })
    : isSpecific(code)
      ? t(`errors.${code}`)
      : tErrors(messageKey, { requestId: requestId ?? "—" });
  return (
    <Alert className={className}>
      {text} <StepUpLink code={problem || isSpecific(code) ? null : (code ?? messageKey)} />
    </Alert>
  );
}
