import { useTranslations } from "next-intl";
import { ListSkeleton } from "@/modules/field/components/layout-bits";

export default function Loading() {
  const t = useTranslations("common");
  return <ListSkeleton label={t("loading")} />;
}
