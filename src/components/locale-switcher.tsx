"use client";

import { useLocale, useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/navigation";

export function LocaleSwitcher() {
  const locale = useLocale();
  const pathname = usePathname();
  const t = useTranslations("common");
  const other = locale === "ar" ? "en" : "ar";
  return (
    <Link href={pathname} locale={other} className="text-sm text-primary underline-offset-4 hover:underline" hrefLang={other}>
      {t("language")}
    </Link>
  );
}
