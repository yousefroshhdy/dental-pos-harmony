import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import type { UserContext } from "@/lib/authz/can";
import { cn } from "@/lib/utils";
import { canReadPrices, canReadProducts } from "../logic";

export type CatalogTab = "products" | "priceLists" | "promotions";

const TABS: { key: CatalogTab; href: string; visible: (ctx: UserContext) => boolean }[] = [
  { key: "products", href: "/catalog", visible: canReadProducts },
  { key: "priceLists", href: "/catalog/price-lists", visible: canReadPrices },
  { key: "promotions", href: "/catalog/promotions", visible: canReadPrices },
];

/** Section tabs; each is shown only with its read permission (RLS enforces the data). */
export async function CatalogTabs({ ctx, current }: { ctx: UserContext; current: CatalogTab }) {
  const t = await getTranslations("catalog.nav");
  const tabs = TABS.filter((tab) => tab.visible(ctx));
  if (tabs.length < 2) return null;
  return (
    <nav aria-label={t("section")} className="-mx-4 overflow-x-auto px-4">
      <ul className="flex gap-1 border-b">
        {tabs.map((tab) => (
          <li key={tab.key}>
            <Link
              href={tab.href}
              aria-current={tab.key === current ? "page" : undefined}
              className={cn(
                "-mb-px inline-flex min-h-11 items-center border-b-2 px-3 text-sm whitespace-nowrap",
                tab.key === current ? "border-primary font-medium text-primary" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t(tab.key)}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
