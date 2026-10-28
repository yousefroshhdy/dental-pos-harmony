"use client";

import { useLocale, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { Link, usePathname } from "@/i18n/navigation";

export function LocaleSwitcher() {
  const locale = useLocale();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const t = useTranslations("common");
  const other = locale === "ar" ? "en" : "ar";
  // Keep the query string (e.g. ?next=… on the login page) when switching language.
  const query = Object.fromEntries(searchParams.entries());
  return (
    <Link href={{ pathname, query }} locale={other} className="text-sm text-primary underline-offset-4 hover:underline" hrefLang={other}>
      {t("language")}
    </Link>
  );
}
