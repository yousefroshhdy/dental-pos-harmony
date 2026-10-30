"use client";

import { useTranslations } from "next-intl";
import { Alert } from "@/components/ui/primitives";
import { StepUpLink } from "@/modules/security/components/step-up-link";
import type { TranslatedCode } from "@/lib/errors";
import type { ActionState, UploadProblem } from "../types";

/** Business codes with a specific message under imports.errors.* */
const SPECIFIC = ["ALREADY_COMMITTED", "CONFLICT", "INVALID_STATE", "PERMISSION_DENIED", "CONFIRM_REQUIRED", "VALIDATION"] as const;
type Specific = (typeof SPECIFIC)[number];
const isSpecific = (code: string | undefined): code is Specific => (SPECIFIC as readonly string[]).includes(code ?? "");

function ProblemText({ problem }: { problem: UploadProblem }) {
  const t = useTranslations("imports.upload.problems");
  switch (problem.code) {
    case "csv":
      return <>{t(problem.reason, { line: problem.line })}</>;
    case "too_many_rows":
      return <>{t("too_many_rows", { count: problem.count })}</>;
    case "duplicate_header":
      return <>{t("duplicate_header", { column: problem.column })}</>;
    case "unknown_columns":
    case "missing_columns":
      return <>{t(problem.code, { columns: problem.columns })}</>;
    case "extra_cells":
      return <>{t("extra_cells", { line: problem.line })}</>;
    default:
      return <>{t(problem.code)}</>;
  }
}

/** Translated error: an upload problem, imports.errors.<code>, or the generic errors.<messageKey>. */
export function ImportErrorMessage({
  code,
  messageKey,
  requestId,
  problem,
  className,
}: {
  code?: string;
  messageKey: TranslatedCode;
  requestId?: string;
  problem?: UploadProblem;
  className?: string;
}) {
  const tErrors = useTranslations("errors");
  const tImports = useTranslations("imports.errors");
  return (
    <Alert className={className}>
      {problem ? <ProblemText problem={problem} /> : isSpecific(code) ? tImports(code) : tErrors(messageKey, { requestId: requestId ?? "—" })}{" "}
      <StepUpLink code={problem || isSpecific(code) ? null : messageKey} />
    </Alert>
  );
}

export function ActionMessage({ state, success, className }: { state: ActionState; success?: string; className?: string }) {
  if (!state) return null;
  if (!state.ok) {
    return (
      <ImportErrorMessage code={state.code} messageKey={state.messageKey} requestId={state.requestId} problem={state.problem} className={className} />
    );
  }
  return success ? (
    <Alert tone="success" role="status" className={className}>
      {success}
    </Alert>
  ) : null;
}
