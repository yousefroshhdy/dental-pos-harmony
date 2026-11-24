import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { SirenIcon, UserCheckIcon, WorkflowIcon } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
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
    { href: "/workflow/delegations", key: "delegations", icon: UserCheckIcon, show: true },
    { href: "/workflow/escalations", key: "escalations", icon: SirenIcon, show: true },
    { href: "/workflow/rules", key: "rules", icon: WorkflowIcon, show: can(ctx, "admin.workflow.manage") || can(ctx, "wf.approval.read") },
  ] as const;

  return (
    <div className="space-y-6">
      <PageHeader title={t("hub.title")} />
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {links
          .filter((l) => l.show)
          .map((l) => {
            const Icon = l.icon;
            return (
              <li key={l.href}>
                <Link
                  href={l.href}
                  className="flex h-full min-h-11 items-start gap-3 rounded-lg border bg-card p-4 shadow-sm transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                >
                  <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-md bg-secondary text-secondary-foreground">
                    <Icon className="size-5" />
                  </span>
                  <span className="min-w-0 space-y-0.5">
                    <span className="block font-medium">{t(`nav.${l.key}`)}</span>
                    <span className="block text-sm text-muted-foreground">{t(`hub.${l.key}`)}</span>
                  </span>
                </Link>
              </li>
            );
          })}
      </ul>
    </div>
  );
}
