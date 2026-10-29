import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { Card } from "@/components/ui/primitives";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { ConsentStatus } from "@/modules/field/components/consent-status";
import { GpsConsentText } from "@/modules/field/components/gps-consent";
import { PageBody } from "@/modules/field/components/layout-bits";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "field.privacy" });
  return { title: t("title") };
}

/** Location & privacy: the consent text, and this device's acknowledgement (review or withdraw). */
export default async function PrivacyPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!can(ctx, "field.visit.create") || !ctx.user_id) return <Forbidden />;
  const t = await getTranslations("field.privacy");

  return (
    <PageBody className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <Card className="space-y-4">
        <GpsConsentText />
        <ConsentStatus userId={ctx.user_id} />
      </Card>
    </PageBody>
  );
}
