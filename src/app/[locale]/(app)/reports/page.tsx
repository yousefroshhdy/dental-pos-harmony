import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Card } from "@/components/ui/primitives";
import { getUserContext } from "@/lib/authz/context";
import { ExportForm } from "@/modules/reports/components/export-form";
import { dynamicSourcesFor, fieldSpecs, type DynamicOptions, type Option } from "@/modules/reports/forms";
import { availableExports, fullStock } from "@/modules/reports/kinds";
import { brandOptions, customerOptions, specialtyOptions, territoryOptions, warehouseOptions } from "@/modules/reports/queries";
import { exportRowCap } from "@/modules/reports/settings";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "reports.page" });
  return { title: t("title") };
}

/** The CSV exports this user may run, each with the filters of its list page. */
export default async function ReportsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  const t = await getTranslations("reports");
  const format = await getFormatter();

  const kinds = availableExports(ctx);
  const needed = dynamicSourcesFor(kinds, ctx);
  const load = async (source: DynamicOptions): Promise<Option[]> => {
    switch (source) {
      case "customers":
        return customerOptions();
      case "territories":
        return territoryOptions(locale);
      case "specialties":
        return specialtyOptions(locale);
      case "warehouses":
        return warehouseOptions(fullStock(ctx));
      case "brands":
        return brandOptions();
    }
  };
  const options = Object.fromEntries(await Promise.all([...needed].map(async (s) => [s, await load(s)] as const))) as Partial<Record<DynamicOptions, Option[]>>;

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">{t("page.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("page.help")}</p>
      </div>

      {kinds.length === 0 ? (
        <Card className="text-sm text-muted-foreground">{t("page.empty")}</Card>
      ) : (
        <>
          <ul className="space-y-1 text-sm text-muted-foreground">
            <li>{t("page.rowCap", { count: format.number(exportRowCap()) })}</li>
            <li>{t("page.notes")}</li>
          </ul>
          <div className="grid gap-4 lg:grid-cols-2">
            {kinds.map((kind) => (
              <ExportForm key={kind} kind={kind} fields={fieldSpecs(kind, ctx)} options={options} locale={locale} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
