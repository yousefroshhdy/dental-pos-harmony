import { getTranslations } from "next-intl/server";
import { PageSkeleton } from "@/modules/orders/kit/page-skeleton";

/** Shown while an orders page loads its data. */
export default async function OrdersLoading() {
  const t = await getTranslations("orders");
  return <PageSkeleton label={t("loading")} />;
}
