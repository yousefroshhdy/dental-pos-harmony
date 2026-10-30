import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { Card } from "@/components/ui/primitives";
import { LoginForm } from "./login-form";
import { NativeTrackingStop } from "./native-stop";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "auth" });
  return { title: t("title") };
}

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
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 px-4 py-10">
      <NativeTrackingStop />
      <div className="flex items-center justify-between">
        <div>
          <p className="text-2xl font-bold">{app("name")}</p>
          <p className="text-sm text-muted-foreground">{app("tagline")}</p>
        </div>
        <LocaleSwitcher />
      </div>
      <Card className="space-y-4">
        <div>
          <h1 className="text-xl font-semibold">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
        <LoginForm locale={locale} next={typeof next === "string" ? next : undefined} />
      </Card>
    </main>
  );
}
