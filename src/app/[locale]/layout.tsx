import type { Metadata, Viewport } from "next";
import { hasLocale, NextIntlClientProvider } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { directionOf, routing } from "@/i18n/routing";
import { ServiceWorkerRegistrar } from "@/components/sw-registrar";
import { ThemeProvider } from "@/components/theme-provider";
import { CSP_META_REQUEST_HEADER, NONCE_REQUEST_HEADER, metaPolicyForNonce } from "@/lib/security-headers";
// Self-hosted type (no font CDN; font-src 'self'): IBM Plex Sans Arabic for Arabic,
// IBM Plex Sans for Latin, Bebas Neue for Latin display headings only.
import "@fontsource/ibm-plex-sans-arabic/arabic-400.css";
import "@fontsource/ibm-plex-sans-arabic/arabic-500.css";
import "@fontsource/ibm-plex-sans-arabic/arabic-600.css";
import "@fontsource/ibm-plex-sans-arabic/arabic-700.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-sans/latin-700.css";
import "@fontsource/ibm-plex-sans/latin-ext-400.css";
import "@fontsource/ibm-plex-sans/latin-ext-500.css";
import "@fontsource/ibm-plex-sans/latin-ext-600.css";
import "@fontsource/ibm-plex-sans/latin-ext-700.css";
import "@fontsource/bebas-neue/latin-400.css";
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
    { media: "(prefers-color-scheme: light)", color: "#f6fafa" },
    { media: "(prefers-color-scheme: dark)", color: "#0f1a20" },
  ],
};

export default async function LocaleLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  // The page CSP again as <meta>, for the Android app: Capacitor fetches the HTML itself and
  // drops the response headers (src/lib/security-headers.ts). Same policy and nonce as the header.
  const requestHeaders = await headers();
  const nonce = requestHeaders.get(NONCE_REQUEST_HEADER);
  const metaCsp = metaPolicyForNonce(requestHeaders.get(CSP_META_REQUEST_HEADER), nonce);

  // suppressHydrationWarning: next-themes sets the theme class on <html> before hydration.
  return (
    <html lang={locale} dir={directionOf(locale)} suppressHydrationWarning>
      <head>{metaCsp ? <meta httpEquiv="Content-Security-Policy" content={metaCsp} /> : null}</head>
      <body className="min-h-dvh bg-background font-sans text-foreground antialiased">
        {/* The theme script must carry this request's nonce or the CSP blocks it. */}
        <ThemeProvider nonce={nonce ?? undefined}>
          <NextIntlClientProvider>{children}</NextIntlClientProvider>
        </ThemeProvider>
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}
