import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getUserContext } from "@/lib/authz/context";
import { RoleHome } from "@/modules/home/components/role-homes";
import { displayName, selectHome } from "@/modules/home/logic";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "home" });
  return { title: t("pageTitle") };
}

/**
 * Role home (Phase P step 2): owner > finance > manager > rep, by permissions
 * (src/modules/home/logic.ts). Replaces the earlier redirects to /today and
 * /dashboard; both stay one tap away (header action, sidebar, bottom bar).
 */
export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  return <RoleHome role={selectHome(ctx)} ctx={ctx} name={displayName(ctx, locale)} />;
}
