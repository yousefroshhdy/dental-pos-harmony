import { getTranslations } from "next-intl/server";
import { PageSkeleton } from "@/modules/orders/kit/page-skeleton";

/** Shown while an inventory page loads its data. */
export default async function InventoryLoading() {
  const t = await getTranslations("inventory.common");
  return <PageSkeleton label={t("loading")} />;
}
