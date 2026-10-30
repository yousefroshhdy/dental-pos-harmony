import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import NextLink from "next/link";
import { Alert, Badge, Card, CardTitle } from "@/components/ui/primitives";
import { EnrolTotp } from "@/modules/security/components/enrol-totp";
import { RemoveFactorButton } from "@/modules/security/components/remove-factor-button";
import { VerifySessionButton } from "@/modules/security/components/verify-session";
import { CAIRO_DATE } from "@/modules/security/format";
import { mfaStanding, sortFactors, stepUpReturnPath } from "@/modules/security/logic";
import { getMfaStatus, listTotpFactors } from "@/modules/security/queries";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "security" });
  return { title: t("title") };
}

const STANDING_TONE = { protected: "success", verifyNow: "info", enrolNeeded: "danger", optional: "info" } as const;

/**
 * The signed-in user's own second factor (any active user; the app layout
 * already requires a session). Supabase Auth owns the factors; the database
 * decides which actions need aal2 (authz.require, security.mfa_enforced).
 * `?next=` (set by StepUpLink after an MFA_REQUIRED error) is where the user goes back to
 * once this session is verified; only a safe in-app path is honoured.
 */
export default async function AccountSecurityPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const { locale } = await params;
  const { next } = await searchParams;
  const returnTo = stepUpReturnPath(next, locale);
  setRequestLocale(locale);
  const t = await getTranslations("security");
  const format = await getFormatter();

  const [status, factors] = await Promise.all([getMfaStatus(), listTotpFactors()]);
  const rows = factors.ok ? sortFactors(factors.data) : [];
  const standing = status.ok && factors.ok ? mfaStanding(status.data, rows) : null;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("intro")}</p>
      </div>

      {returnTo && standing !== "protected" ? (
        <Alert tone="info" role="status">
          {t("stepUp.returnHint")}
        </Alert>
      ) : null}

      <Card className="space-y-3">
        <CardTitle>{t("status.title")}</CardTitle>
        {!status.ok ? (
          <Alert>{t("status.loadFailed")}</Alert>
        ) : (
          <>
            {standing ? (
              <Alert tone={STANDING_TONE[standing]} role="status">
                {t(`status.standing.${standing}`)}
              </Alert>
            ) : null}
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <div className="flex flex-wrap items-center gap-2">
                <dt className="text-muted-foreground">{t("status.enforcement")}</dt>
                <dd>
                  <Badge tone={status.data.enforced ? "warning" : "neutral"}>
                    {status.data.enforced ? t("status.enforcedOn") : t("status.enforcedOff")}
                  </Badge>
                </dd>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <dt className="text-muted-foreground">{t("status.session")}</dt>
                <dd>
                  <Badge tone={status.data.aal === "aal2" ? "success" : "neutral"}>
                    {status.data.aal === "aal2" ? t("status.sessionVerified") : t("status.sessionNotVerified")}
                  </Badge>
                </dd>
              </div>
            </dl>
            <div className="space-y-1">
              <h3 className="text-sm font-medium">{t("status.requiredTitle")}</h3>
              {status.data.required_permissions.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("status.requiredNone")}</p>
              ) : (
                <ul className="flex flex-wrap gap-1">
                  {status.data.required_permissions.map((code) => (
                    <li key={code}>
                      <code dir="ltr" className="rounded bg-muted px-2 py-0.5 text-xs">
                        {code}
                      </code>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {standing === "verifyNow" ? <VerifySessionButton returnTo={returnTo} /> : null}
            {standing === "protected" && returnTo ? (
              <NextLink href={returnTo} className="inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4">
                {t("stepUp.back")}
              </NextLink>
            ) : null}
          </>
        )}
      </Card>

      <Card className="space-y-3">
        <CardTitle>{t("factors.title")}</CardTitle>
        {!factors.ok ? (
          <Alert>{t("factors.loadFailed")}</Alert>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("factors.empty")}</p>
        ) : (
          <ul className="divide-y">
            {rows.map((factor) => (
              <li key={factor.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="space-y-1">
                  <p className="font-medium">{factor.friendly_name ?? t("factors.unnamed")}</p>
                  <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge tone={factor.status === "verified" ? "success" : "warning"}>
                      {factor.status === "verified" ? t("factors.verified") : t("factors.unverified")}
                    </Badge>
                    <time dateTime={factor.created_at}>
                      {t("factors.addedOn", { date: format.dateTime(new Date(factor.created_at), CAIRO_DATE) })}
                    </time>
                  </p>
                </div>
                <RemoveFactorButton factorId={factor.id} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="space-y-3">
        <CardTitle>{t("enrol.title")}</CardTitle>
        <EnrolTotp />
      </Card>
    </div>
  );
}
