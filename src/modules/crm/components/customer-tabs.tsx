import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import type { CustomerTab } from "../logic";

/**
 * Sections of the customer page as links (`?tab=visits`): each tab is a server render that
 * reads only its own data, the URL can be shared, and Back works. Styled like TabsList.
 */
export function CustomerTabs({ customerId, tabs, current }: { customerId: string; tabs: readonly CustomerTab[]; current: CustomerTab }) {
  const t = useTranslations("crm.detail");
  return (
    <nav aria-label={t("tabsLabel")} className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <ul className="inline-flex min-w-max items-center gap-1 rounded-lg bg-muted p-1 text-muted-foreground">
        {tabs.map((tab) => {
          const active = tab === current;
          return (
            <li key={tab}>
              <Link
                href={tab === "overview" ? `/customers/${customerId}` : `/customers/${customerId}?tab=${tab}`}
                aria-current={active ? "page" : undefined}
                scroll={false}
                className={cn(
                  "inline-flex min-h-11 items-center justify-center rounded-md px-4 text-sm font-medium whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                  active ? "bg-card text-foreground shadow-sm" : "hover:text-foreground",
                )}
              >
                {t(`tabs.${tab}`)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
