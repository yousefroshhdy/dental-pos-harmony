import type { Metadata, Viewport } from "next";
import { hasLocale, NextIntlClientProvider } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { directionOf, routing } from "@/i18n/routing";
import { ServiceWorkerRegistrar } from "@/components/sw-registrar";
import { CSP_META_REQUEST_HEADER, NONCE_REQUEST_HEADER, metaPolicyForNonce } from "@/lib/security-headers";
import "../globals.css";

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "app" });
  return {
    title: { default: t("name"), template: `%s · ${t("name")}` },
    description: t("tagline"),
    applicationName: t("name"),
    robots: { index: false, follow: false }, // internal system
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f8fb" },
    { media: "(prefers-color-scheme: dark)", color: "#1b1e2a" },
  ],
};

export default async function LocaleLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  // The page CSP again as <meta>, for the Android app: Capacitor fetches the HTML itself and
  // drops the response headers (src/lib/security-headers.ts). Same policy and nonce as the header.
  const requestHeaders = await headers();
  const metaCsp = metaPolicyForNonce(requestHeaders.get(CSP_META_REQUEST_HEADER), requestHeaders.get(NONCE_REQUEST_HEADER));

  return (
    <html lang={locale} dir={directionOf(locale)}>
      <head>{metaCsp ? <meta httpEquiv="Content-Security-Policy" content={metaCsp} /> : null}</head>
      <body className="min-h-dvh antialiased">
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}
