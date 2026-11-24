import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { can, type UserContext } from "@/lib/authz/can";
import { chipClass } from "@/modules/field/components/layout-bits";
import { mapsNav } from "../nav";

const TAB_KEYS: Record<string, string> = { "/map": "customers", "/map/team": "team", "/map/proposals": "proposals" };

/** Links between the three maps, each shown only with its permission (UX only). */
export async function MapTabs({ ctx, current }: { ctx: UserContext; current: "/map" | "/map/team" | "/map/proposals" }) {
  const t = await getTranslations("maps.tabs");
  const tabs = mapsNav.filter((item) => item.permission === null || can(ctx, item.permission));
  if (tabs.length < 2) return null;
  return (
    <nav aria-label={t("label")} className="flex gap-2 overflow-x-auto pb-1">
      {tabs.map((item) => (
        <Link key={item.href} href={item.href} className={chipClass(item.href === current)} aria-current={item.href === current ? "page" : undefined}>
          {t(TAB_KEYS[item.href] ?? "customers")}
        </Link>
      ))}
    </nav>
  );
}
