import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { Card } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
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
    <div className="mx-auto max-w-3xl space-y-4">
      <Link href="/admin/users" className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline">
        {t("back")}
      </Link>
      <div>
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("intro")}</p>
      </div>
      <Card>
        <InviteForm uiLocale={locale} />
      </Card>
    </div>
  );
}
