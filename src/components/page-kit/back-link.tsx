import { ArrowLeftIcon, ArrowRightIcon } from "lucide-react";
import { getLocale } from "next-intl/server";
import type { ReactNode } from "react";
import { Link } from "@/i18n/navigation";

/** "← Back to …" above a page title (PageHeader `eyebrow`). The arrow follows the reading direction. */
export async function BackLink({ href, children }: { href: string; children: ReactNode }) {
  const Arrow = (await getLocale()) === "ar" ? ArrowRightIcon : ArrowLeftIcon;
  return (
    <Link href={href} className="inline-flex min-h-11 items-center gap-1.5 text-sm text-primary underline-offset-4 hover:underline">
      <Arrow aria-hidden="true" className="size-4" />
      {children}
    </Link>
  );
}
