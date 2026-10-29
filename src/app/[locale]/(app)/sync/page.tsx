import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getUserContext } from "@/lib/authz/context";
import { SyncQueueView } from "@/modules/offline/components/sync-queue-view";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "offline.page" });
  return { title: t("title") };
}

/**
 * Pending sync: the signed-in user's offline queue on this device. It needs no
 * permission of its own (it only shows the user's own saved commands, read from
 * IndexedDB); every command is authorized by Postgres when it is sent.
 */
export default async function SyncPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  // The app layout already redirects anonymous users to the login page.
  if (!ctx.user_id) return null;
  return <SyncQueueView userId={ctx.user_id} />;
}
