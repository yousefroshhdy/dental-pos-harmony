import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { Badge, Card, CardTitle, Table, Td, Th } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { getUserContext } from "@/lib/authz/context";
import { CatalogErrorMessage } from "@/modules/catalog/components/action-form";
import { CatalogTabs } from "@/modules/catalog/components/catalog-tabs";
import { PriceListForm } from "@/modules/catalog/components/price-list-form";
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

  return (
    <div className="space-y-6">
      <CatalogTabs ctx={ctx} current="priceLists" />
      <div>
        <h1 className="text-2xl font-semibold">{t("listTitle")}</h1>
        <p className="text-sm text-muted-foreground">{t("listIntro")}</p>
      </div>

      {!lists.ok ? (
        <CatalogErrorMessage messageKey={lists.error.messageKey} requestId={lists.error.requestId} />
      ) : lists.data.length === 0 ? (
        <Card>
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        </Card>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>{t("code")}</Th>
              <Th>{t("name")}</Th>
              <Th>{t("kind")}</Th>
              <Th className="text-end">{t("priority")}</Th>
              <Th>{t("validity")}</Th>
              <Th className="text-end">{t("items")}</Th>
              <Th className="text-end">{t("customersCount")}</Th>
            </tr>
          </thead>
          <tbody>
            {lists.data.map((l) => (
              <tr key={l.id}>
                <Td>
                  <Link href={`/catalog/price-lists/${l.id}`} className="inline-flex min-h-11 items-center font-medium text-primary underline-offset-4 hover:underline">
                    <code dir="ltr">{l.code}</code>
                  </Link>
                </Td>
                <Td className="min-w-40">{l.name}</Td>
                <Td>
                  <span className="flex flex-wrap gap-1">
                    <Badge tone={priceListKindTone(l.kind)}>{t(`kinds.${l.kind}`)}</Badge>
                    {l.is_default ? <Badge tone="info">{t("default")}</Badge> : null}
                    {l.is_current ? <Badge tone="success">{t("current")}</Badge> : <Badge>{l.is_active ? t("notInForce") : t("inactive")}</Badge>}
                  </span>
                </Td>
                <Td className="text-end tabular-nums">{l.priority}</Td>
                <Td className="whitespace-nowrap">
                  {l.valid_to ? t("fromTo", { from: day(l.valid_from), to: day(l.valid_to) }) : t("fromOpen", { from: day(l.valid_from) })}
                </Td>
                <Td className="text-end tabular-nums">{l.item_count}</Td>
                <Td className="text-end tabular-nums">{l.kind === "customer" ? l.customer_count : "—"}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <p className="text-xs text-muted-foreground">{t("resolutionNote")}</p>

      {manage ? (
        <Card className="space-y-4">
          <CardTitle>{t("newTitle")}</CardTitle>
          <PriceListForm newId={crypto.randomUUID()} today={todayInCairo()} />
        </Card>
      ) : null}
    </div>
  );
}
