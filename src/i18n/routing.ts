import { defineRouting } from "next-intl/routing";

export const locales = ["ar", "en"] as const;
export type Locale = (typeof locales)[number];

export const routing = defineRouting({
  locales,
  defaultLocale: "ar", // D-11: Arabic first
  localePrefix: "always",
  // "/" always opens Arabic regardless of browser language (D-11). Users switch
  // explicitly; next-intl then remembers the choice in its locale cookie.
  localeDetection: false,
});

export function directionOf(locale: string): "rtl" | "ltr" {
  return locale === "ar" ? "rtl" : "ltr";
}
