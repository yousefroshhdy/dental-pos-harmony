import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Brand } from "@/components/app-shell/brand";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { Card } from "@/components/ui/card";
import { LoginForm } from "./login-form";
import { NativeTrackingStop } from "./native-stop";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "auth" });
  return { title: t("title") };
}

/**
 * Sign-in (visual redesign, Phase P step 2b). The brand panel shows from `lg` up;
 * on a phone the wordmark sits above the card. One h1 (auth.title), the labelled
 * email and password fields, the submit button and the language link stay as the
 * e2e specs expect; the auth logic lives in ./actions and ./login-form.
 */
export default async function LoginPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ next?: string }>;
}) {
  const { locale } = await params;
  const { next } = await searchParams;
  setRequestLocale(locale);
  const t = await getTranslations("auth");
  const app = await getTranslations("app");

  return (
    <main className="grid min-h-dvh lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <NativeTrackingStop />

      {/* Brand panel (wide screens). Decorative: the name is repeated for screen readers below. */}
      <div className="relative hidden overflow-hidden bg-sidebar text-sidebar-foreground lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div aria-hidden="true" className="pointer-events-none absolute -end-24 -top-24 size-96 rounded-full bg-sidebar-accent opacity-60" />
        <div aria-hidden="true" className="pointer-events-none absolute -start-16 bottom-10 size-64 rounded-full bg-sidebar-primary/10" />
        <Brand onSidebar className="relative [&>span:first-child]:text-6xl" />
        <div className="relative max-w-md space-y-3">
          <p className="text-2xl leading-snug font-semibold text-balance">{app("tagline")}</p>
          <p className="text-sm text-sidebar-muted">{t("subtitle")}</p>
        </div>
      </div>

      <div className="mx-auto flex w-full max-w-md flex-col justify-center gap-6 px-4 py-10 sm:px-6">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <Brand className="lg:hidden" />
            <p className="sr-only">{app("name")}</p>
            <p className="text-sm text-muted-foreground lg:hidden">{app("tagline")}</p>
          </div>
          <LocaleSwitcher className="inline-flex min-h-11 shrink-0 items-center rounded-md border px-3 font-medium no-underline hover:bg-accent" />
        </div>

        <Card className="space-y-5 shadow-md">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
            <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
          </div>
          <LoginForm locale={locale} next={typeof next === "string" ? next : undefined} />
        </Card>
      </div>
    </main>
  );
}
