import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "workflow.hub" });
  return { title: t("title") };
}

/** Entry point to the workflow screens the user can use (each page re-checks access). */
export default async function WorkflowHubPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  const t = await getTranslations("workflow");

  const links = [
    { href: "/workflow/delegations", key: "delegations", show: true },
    { href: "/workflow/escalations", key: "escalations", show: true },
    { href: "/workflow/rules", key: "rules", show: can(ctx, "admin.workflow.manage") || can(ctx, "wf.approval.read") },
  ] as const;

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">{t("hub.title")}</h1>
      <ul className="divide-y rounded-lg border bg-card">
        {links
          .filter((l) => l.show)
          .map((l) => (
            <li key={l.href}>
              <Link href={l.href} className="flex min-h-11 flex-col gap-0.5 px-4 py-3 hover:bg-muted">
                <span className="font-medium">{t(`nav.${l.key}`)}</span>
                <span className="text-sm text-muted-foreground">{t(`hub.${l.key}`)}</span>
              </Link>
            </li>
          ))}
      </ul>
    </div>
  );
}
