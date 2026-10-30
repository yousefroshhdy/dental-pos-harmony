"use client";

import { useLocale, useTranslations } from "next-intl";
import NextLink from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { isMfaRequired, stepUpHref } from "../logic";

/**
 * The way out of an MFA_REQUIRED error: a link to My security that comes back to
 * this page once the session is verified (`?next=`). Renders nothing for any other
 * code, so a module error display can include it unconditionally:
 *
 *   <Alert>{t(messageKey)} <StepUpLink code={code ?? messageKey} /></Alert>
 *
 * The database decides whether aal2 is needed (authz.require_mfa); this is UX only.
 */
export function StepUpLink({ code, className }: { code?: string | null; className?: string }) {
  const t = useTranslations("security.stepUp");
  const locale = useLocale();
  const pathname = usePathname();
  if (!isMfaRequired({ code })) return null;
  return (
    <NextLink href={stepUpHref(locale, pathname)} className={cn("font-medium text-primary underline underline-offset-4", className)}>
      {t("openAccountPage")}
    </NextLink>
  );
}
