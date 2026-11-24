import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { FormSheet } from "@/components/page-kit/form-sheet";
import { PageHeader } from "@/components/ui/page-header";
import { getUserContext } from "@/lib/authz/context";
import { CatalogErrorMessage } from "@/modules/catalog/components/action-form";
import { CatalogTabs } from "@/modules/catalog/components/catalog-tabs";
import { PriceListForm } from "@/modules/catalog/components/price-list-form";
import { PriceListsTable, type PriceListListRow } from "@/modules/catalog/components/price-lists-table";
import { canManagePrices, canReadPrices, dateOnly, priceListKindTone, todayInCairo } from "@/modules/catalog/logic";
import { listPriceLists } from "@/modules/catalog/queries";

type Params = Promise<{ locale: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "catalog.priceList" });
  return { title: t("listTitle") };
}

export default async function PriceListsPage({ params }: { params: Params }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!canReadPrices(ctx)) return <Forbidden />;

  const t = await getTranslations("catalog.priceList");
  const format = await getFormatter();
  const lists = await listPriceLists();
  const manage = canManagePrices(ctx);
  const day = (d: string) => format.dateTime(dateOnly(d), { dateStyle: "medium", timeZone: "UTC", numberingSystem: "latn" });

  const tl = await getTranslations("catalog.list");
  const rows: PriceListListRow[] = (lists.ok ? lists.data : []).map((l) => ({
    id: l.id,
    code: l.code,
    name: l.name,
    kind: l.kind,
    kindTone: priceListKindTone(l.kind),
    isDefault: l.is_default,
    state: l.is_current ? "current" : l.is_active ? "notInForce" : "inactive",
    priority: l.priority,
    validity: l.valid_to ? t("fromTo", { from: day(l.valid_from), to: day(l.valid_to) }) : t("fromOpen", { from: day(l.valid_from) }),
    items: Number(l.item_count),
    customers: l.kind === "customer" ? Number(l.customer_count) : null,
  }));

  return (
    <div className="space-y-6">
      <CatalogTabs ctx={ctx} current="priceLists" />
      <PageHeader
        title={t("listTitle")}
        description={t("listIntro")}
        actions={
          manage ? (
            <FormSheet trigger={t("newTitle")} title={t("newTitle")} closeLabel={tl("close")}>
              <PriceListForm newId={crypto.randomUUID()} today={todayInCairo()} />
            </FormSheet>
          ) : null
        }
      />

      <PriceListsTable
        rows={rows}
        error={lists.ok ? undefined : <CatalogErrorMessage messageKey={lists.error.messageKey} requestId={lists.error.requestId} />}
      />

      <p className="text-xs text-muted-foreground">{t("resolutionNote")}</p>

    </div>
  );
}
