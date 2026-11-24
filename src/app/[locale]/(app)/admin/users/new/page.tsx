import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { BackLink } from "@/components/page-kit/back-link";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { getUserContext } from "@/lib/authz/context";
import { InviteForm } from "@/modules/admin/components/invite-form";
import { canInvite } from "@/modules/admin/logic";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "admin.invite" });
  return { title: t("title") };
}

export default async function InviteUserPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!canInvite(ctx)) return <Forbidden />;

  const t = await getTranslations("admin.invite");

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader eyebrow={<BackLink href="/admin/users">{t("back")}</BackLink>} title={t("title")} description={t("intro")} />
      <Card>
        <InviteForm uiLocale={locale} />
      </Card>
    </div>
  );
}
