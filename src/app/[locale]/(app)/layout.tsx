import { getTranslations, setRequestLocale } from "next-intl/server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AppSidebar } from "@/components/app-shell/app-sidebar";
import { BottomBar } from "@/components/app-shell/bottom-bar";
import { Brand } from "@/components/app-shell/brand";
import { MobileNav } from "@/components/app-shell/mobile-nav";
import { RetryButton } from "@/components/app-shell/retry-button";
import { SIDEBAR_COOKIE, type ShellNavGroup, type ShellNavItem } from "@/components/app-shell/types";
import { UserMenu } from "@/components/app-shell/user-menu";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { directionOf } from "@/i18n/routing";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { bottomBarItems, navIcon, navLabelKey, navVisible, USER_MENU_NAV, visibleNavGroups, type NavItem } from "@/lib/nav";
import { cn } from "@/lib/utils";
import { NotificationBadge } from "@/modules/approvals/components/notification-badge";
import { displayName } from "@/modules/home/logic";
import { OfflineSignOutForm } from "@/modules/offline/components/sign-out-form";
import { SyncIndicator } from "@/modules/offline/components/sync-indicator";
import { TrackingIndicator } from "@/modules/tracking/components/tracking-indicator";
import { signOut } from "../login/actions";
import { NativeTrackingStop } from "../login/native-stop";

/**
 * The app shell (Phase P step 2): a collapsible department sidebar on desktop, a
 * top bar with a menu drawer on phones, and a bottom bar for field users. Every nav
 * entry is filtered by permission here (src/lib/nav.ts); that is UX only, RLS and
 * the api.* commands enforce access. The header keeps the tracking and sync
 * indicators (each mounted once: they run the collectors), the notification bell,
 * the language switch and the account menu with sign-out.
 */
export default async function AppLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!ctx.user_id) redirect(`/${locale}/login`);

  const tAll = await getTranslations();
  const t = await getTranslations("nav");
  const tShell = await getTranslations("shell");
  const tAuth = await getTranslations("auth");
  const app = await getTranslations("app");
  const signOutAction = signOut.bind(null, locale);
  const dir = directionOf(locale);

  if (!ctx.active) {
    // Signed in, but my_context() failed: say so and offer a retry. The account may
    // well be active, so this screen neither claims otherwise nor stops tracking.
    if (ctx.error) {
      return (
        <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-4">
          <Card role="alert" className="space-y-3">
            <h1 className="text-xl font-semibold">{tAuth("contextErrorTitle")}</h1>
            <p className="text-sm text-muted-foreground">{tAuth("contextErrorBody")}</p>
            <div className="flex flex-wrap items-center gap-2">
              <RetryButton label={tAuth("contextErrorRetry")} />
              <form action={signOutAction}>
                <Button variant="outline">{t("signOut")}</Button>
              </form>
            </div>
          </Card>
        </main>
      );
    }
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-4">
        {/* An inactive user collects nothing: remove a native watcher left by an earlier page (audit 4 F4). */}
        <NativeTrackingStop />
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

  const toShellItem = (item: NavItem): ShellNavItem => ({ href: item.href, label: tAll(navLabelKey(ctx, item)), icon: navIcon(item.href) });
  const groups: ShellNavGroup[] = visibleNavGroups(ctx).map((g) => ({ id: g.id, label: tAll(g.labelKey), items: g.items.map(toShellItem) }));
  const bottom = bottomBarItems(ctx).map(toShellItem);
  const userLinks = USER_MENU_NAV.filter((item) => navVisible(ctx, item)).map(toShellItem);
  const collapsed = (await cookies()).get(SIDEBAR_COOKIE)?.value === "collapsed";
  const name = displayName(ctx, locale) || app("name");

  return (
    <TooltipProvider>
      <div className="flex min-h-dvh" data-bottom-bar={bottom.length > 0 ? "" : undefined}>
        <AppSidebar
          groups={groups}
          initialCollapsed={collapsed}
          dir={dir}
          labels={{ nav: tShell("mainNav"), home: tShell("homeLink"), collapse: tShell("collapse"), expand: tShell("expand") }}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 border-b bg-card/95 backdrop-blur print:hidden">
            <div className="flex min-h-14 items-center gap-1 px-2 sm:gap-2 sm:px-4">
              <MobileNav
                groups={groups}
                labels={{
                  open: tShell("openMenu"),
                  title: tShell("menuTitle"),
                  description: tShell("menuDescription"),
                  close: tShell("close"),
                  nav: tShell("mainNav"),
                }}
              />
              {/* On phones the wordmark takes the free space and is clipped first, so the
                  indicators (tracking chip during a shift) never push the page sideways at 360 px.
                  Below `sm` it is the compact "HONEST" only: with the tracking chip the full mark
                  did not fit at 390 px, and in RTL the clip cut the leading "H". */}
              <Link href="/" aria-label={tShell("homeLink")} className="inline-flex min-h-11 min-w-0 flex-1 items-center overflow-hidden rounded-md px-1 md:hidden">
                <Brand compact className="sm:hidden" />
                <Brand className="hidden sm:inline-flex" />
              </Link>
              <div className="hidden flex-1 md:block" />
              <TrackingIndicator userId={ctx.user_id} enabled={can(ctx, "field.shift.start") && ctx.employee !== null} />
              <SyncIndicator userId={ctx.user_id} />
              <NotificationBadge />
              <LocaleSwitcher className="hidden min-h-11 items-center rounded-md px-2 sm:inline-flex" />
              <UserMenu
                name={name}
                subtitle={ctx.employee?.job_title ?? null}
                links={userLinks}
                userId={ctx.user_id}
                signOutAction={signOutAction}
                dir={dir}
                labels={{
                  open: tShell("userMenu"),
                  theme: tShell("theme"),
                  light: tShell("themeLight"),
                  dark: tShell("themeDark"),
                  system: tShell("themeSystem"),
                  language: tAll("common.language"),
                  signOut: t("signOut"),
                }}
              />
              {/* A visible sign-out on wide screens as well, for shared office PCs. */}
              <OfflineSignOutForm userId={ctx.user_id} action={signOutAction}>
                <Button variant="ghost" size="sm" className="hidden lg:inline-flex">
                  {t("signOut")}
                </Button>
              </OfflineSignOutForm>
            </div>
          </header>
          <main className={cn("mx-auto w-full max-w-6xl flex-1 px-4 py-6", bottom.length > 0 && "pb-[calc(5.5rem+env(safe-area-inset-bottom))] md:pb-6")}>
            {children}
          </main>
          <BottomBar items={bottom} label={tShell("bottomNav")} />
        </div>
      </div>
      <Toaster dir={dir} />
    </TooltipProvider>
  );
}
