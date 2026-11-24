"use client";

import { useLocale, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import type { ComponentProps } from "react";
import { Link, usePathname } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

/**
 * Link to the same page in the other language. Extra props (className, role, event
 * handlers from a menu item's Slot) go to the link, so it also works as a
 * DropdownMenuItem child.
 */
export function LocaleSwitcher({ className, children, ...props }: Omit<ComponentProps<"a">, "href">) {
  const locale = useLocale();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const t = useTranslations("common");
  const other = locale === "ar" ? "en" : "ar";
  // Keep the query string (e.g. ?next=… on the login page) when switching language.
  const query = Object.fromEntries(searchParams.entries());
  return (
    <Link
      {...props}
      href={{ pathname, query }}
      locale={other}
      className={cn("text-sm text-primary underline-offset-4 hover:underline", className)}
      hrefLang={other}
    >
      {children ?? t("language")}
    </Link>
  );
}
