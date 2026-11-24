import { getTranslations } from "next-intl/server";
import { PageSkeleton } from "@/modules/orders/kit/page-skeleton";

/** Shown while an offers page loads its data. */
export default async function OffersLoading() {
  const t = await getTranslations("orders.offerAdmin");
  return <PageSkeleton label={t("loading")} />;
}
