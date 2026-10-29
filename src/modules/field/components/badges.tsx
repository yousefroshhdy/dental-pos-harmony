import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/primitives";
import { verificationTone, visitStatusTone } from "../logic";
import type { VerificationStatus, VisitStatus } from "../types";

/** Works in server and client components (no async, no client state). */
export function VerdictBadge({ status }: { status: VerificationStatus }) {
  const t = useTranslations("field.verdict");
  return <Badge tone={verificationTone(status)}>{t(status)}</Badge>;
}

export function VisitStatusBadge({ status }: { status: VisitStatus }) {
  const t = useTranslations("field.visitStatus");
  return <Badge tone={visitStatusTone(status)}>{t(status)}</Badge>;
}
