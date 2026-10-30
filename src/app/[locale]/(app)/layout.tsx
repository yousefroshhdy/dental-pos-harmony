import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import type { NavItem } from "@/lib/nav";
import { NotificationBadge } from "@/modules/approvals/components/notification-badge";
import { importsNav } from "@/modules/imports/nav";
import { returnsNav } from "@/modules/returns/nav";
import { commissionsNav } from "@/modules/commissions/nav";
import { planningNav } from "@/modules/planning/nav";
import { workflowNav } from "@/modules/workflow/nav";
import { auditNav } from "@/modules/audit/nav";
import { reportsNav } from "@/modules/reports/nav";
import { securityNav } from "@/modules/security/nav";
import { approvalsNav } from "@/modules/approvals/nav";
import { catalogNav } from "@/modules/catalog/nav";
import { crmNav } from "@/modules/crm/nav";
import { dashboardsNav } from "@/modules/dashboards/nav";
import { fieldNav } from "@/modules/field/nav";
import { financeNav } from "@/modules/finance/nav";
import { inventoryNav } from "@/modules/inventory/nav";
import { OfflineSignOutForm } from "@/modules/offline/components/sign-out-form";
import { SyncIndicator } from "@/modules/offline/components/sync-indicator";
import { ordersNav } from "@/modules/orders/nav";
import { TrackingIndicator } from "@/modules/tracking/components/tracking-indicator";
import { trackingNav } from "@/modules/tracking/nav";
import { signOut } from "../login/actions";

/** Navigation entries; each is shown only if the user holds its permission. */
const NAV: NavItem[] = [
  { href: "/", labelKey: "nav.home", permission: null },
  ...dashboardsNav,
  ...fieldNav,
  ...trackingNav,
  ...crmNav,
  ...ordersNav,
  ...financeNav,
  ...approvalsNav,
  ...inventoryNav,
  ...catalogNav,
  ...planningNav,
  ...returnsNav,
  ...commissionsNav,
  ...reportsNav,
  ...importsNav,
  ...workflowNav,
  ...auditNav,
  ...securityNav,
  { href: "/admin/users", labelKey: "nav.users", permission: "admin.user.read" },
  { href: "/admin/roles", labelKey: "nav.roles", permission: "admin.role.read" },
  { href: "/admin/security", labelKey: "nav.security", permission: "audit.security.read" },
];

export default async function AppLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!ctx.user_id) redirect(`/${locale}/login`);

  const t = await getTranslations("nav");
  const tAll = await getTranslations();
  const tAuth = await getTranslations("auth");
  const app = await getTranslations("app");
  const signOutAction = signOut.bind(null, locale);

  if (!ctx.active) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-4">
        <Card className="space-y-3">
          <h1 className="text-xl font-semibold">{tAuth("inactiveTitle")}</h1>
          <p className="text-sm text-muted-foreground">{tAuth("inactiveBody")}</p>
          <form action={signOutAction}>
            <Button variant="outline">{t("signOut")}</Button>
          </form>
        </Card>
      </main>
    );
  }

  const items = NAV.filter((item) => item.permission === null || can(ctx, item.permission));

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-10 border-b bg-card/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-2">
          <Link href="/" className="font-bold">
            {app("name")}
          </Link>
          <nav className="flex flex-1 gap-1 overflow-x-auto" aria-label="Main">
            {items.map((item) => (
              <Link key={item.href} href={item.href} className="rounded-md px-3 py-2 text-sm whitespace-nowrap hover:bg-muted">
                {tAll(item.labelKey)}
              </Link>
            ))}
          </nav>
          <TrackingIndicator userId={ctx.user_id} enabled={can(ctx, "field.shift.start") && ctx.employee !== null} />
          <SyncIndicator userId={ctx.user_id} />
          <NotificationBadge />
          <LocaleSwitcher />
          <OfflineSignOutForm userId={ctx.user_id} action={signOutAction}>
            <Button variant="ghost" size="sm">
              {t("signOut")}
            </Button>
          </OfflineSignOutForm>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">{children}</main>
    </div>
  );
}
