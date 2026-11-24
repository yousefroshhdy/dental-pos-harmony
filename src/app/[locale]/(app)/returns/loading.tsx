import { getTranslations } from "next-intl/server";
import { PageSkeleton } from "@/modules/orders/kit/page-skeleton";

/** Shown while a returns page loads its data. */
export default async function ReturnsLoading() {
  const t = await getTranslations("returns");
  return <PageSkeleton label={t("loading")} />;
}
