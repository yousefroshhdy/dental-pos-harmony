import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { signOut } from "../login/actions";

/** Navigation entries; each is shown only if the user holds its permission. */
const NAV = [
  { href: "/", key: "home", permission: null },
  { href: "/admin/users", key: "users", permission: "admin.user.read" },
  { href: "/admin/roles", key: "roles", permission: "admin.role.read" },
  { href: "/admin/security", key: "security", permission: "audit.security.read" },
] as const;

export default async function AppLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!ctx.user_id) redirect(`/${locale}/login`);

  const t = await getTranslations("nav");
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
              <Link key={item.key} href={item.href} className="rounded-md px-3 py-2 text-sm whitespace-nowrap hover:bg-muted">
                {t(item.key)}
              </Link>
            ))}
          </nav>
          <LocaleSwitcher />
          <form action={signOutAction}>
            <Button variant="ghost" size="sm">
              {t("signOut")}
            </Button>
          </form>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">{children}</main>
    </div>
  );
}
