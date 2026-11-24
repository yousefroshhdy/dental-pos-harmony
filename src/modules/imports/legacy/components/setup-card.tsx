import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";

/** The one entry on /admin/setup to the old-system workbook import (its own page and components). */
export function LegacyImportCard() {
  const t = useTranslations("legacyImport.setupCard");
  return (
    <Card className="space-y-2 border-primary/40">
      <h3 className="font-medium">{t("title")}</h3>
      <p className="text-sm text-muted-foreground">{t("description")}</p>
      <Link
        href="/admin/setup/legacy-import"
        className="inline-flex min-h-11 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
      >
        {t("open")}
      </Link>
    </Card>
  );
}
