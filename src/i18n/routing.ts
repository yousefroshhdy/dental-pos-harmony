import { defineRouting } from "next-intl/routing";

export const locales = ["ar", "en"] as const;
export type Locale = (typeof locales)[number];

export const routing = defineRouting({
  locales,
  defaultLocale: "ar", // D-11: Arabic first
  localePrefix: "always",
});

export function directionOf(locale: string): "rtl" | "ltr" {
  return locale === "ar" ? "rtl" : "ltr";
}
