import { getTranslations } from "next-intl/server";
import { PageSkeleton } from "@/modules/orders/kit/page-skeleton";

/** Shown while a finance page loads its data. */
export default async function FinanceLoading() {
  const t = await getTranslations("finance");
  return <PageSkeleton label={t("loading")} />;
}
