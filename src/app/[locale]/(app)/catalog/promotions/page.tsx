import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { Badge, Card, CardTitle } from "@/components/ui/primitives";
import { getUserContext } from "@/lib/authz/context";
import { endPromotion } from "@/modules/catalog/actions";
import { CatalogErrorMessage } from "@/modules/catalog/components/action-form";
import { CatalogTabs } from "@/modules/catalog/components/catalog-tabs";
import { PromotionForm } from "@/modules/catalog/components/promotion-form";
import { RowAction } from "@/modules/catalog/components/row-action";
import {
  canManagePrices,
  canReadPrices,
  dateOnly,
  promotionStateTone,
  promotionTargets,
  sortPromotions,
  todayInCairo,
} from "@/modules/catalog/logic";
import { listBrands, listCategories, listPromotions, listSellableSkus } from "@/modules/catalog/queries";

type Params = Promise<{ locale: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "catalog.promotions" });
  return { title: t("title") };
}

export default async function PromotionsPage({ params }: { params: Params }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!canReadPrices(ctx)) return <Forbidden />;

  const t = await getTranslations("catalog.promotions");
  const format = await getFormatter();
  const manage = canManagePrices(ctx);
  const day = (d: string) => format.dateTime(dateOnly(d), { dateStyle: "medium", timeZone: "UTC", numberingSystem: "latn" });

  const [promotions, brands, categories, skus] = await Promise.all([
    listPromotions(),
    manage ? listBrands() : Promise.resolve(null),
    manage ? listCategories() : Promise.resolve(null),
    manage ? listSellableSkus() : Promise.resolve(null),
  ]);

  return (
    <div className="space-y-6">
      <CatalogTabs ctx={ctx} current="promotions" />
      <div>
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("intro")}</p>
      </div>

      {!promotions.ok ? (
        <CatalogErrorMessage messageKey={promotions.error.messageKey} requestId={promotions.error.requestId} />
      ) : promotions.data.length === 0 ? (
        <Card>
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        </Card>
      ) : (
        <ul className="space-y-3" aria-label={t("listLabel")}>
          {sortPromotions(promotions.data).map((p) => {
            const targets = promotionTargets(p, locale);
            return (
              <li key={p.id}>
                <Card className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-semibold">{p.name}</h2>
                      <Badge tone={promotionStateTone(p.state)}>{t(`states.${p.state}`)}</Badge>
                    </div>
                    <p className="text-lg font-semibold tabular-nums">
                      {format.number(Number(p.discount_pct) / 100, { style: "percent", maximumFractionDigits: 2, numberingSystem: "latn" })}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {p.valid_to ? t("fromTo", { from: day(p.valid_from), to: day(p.valid_to) }) : t("fromOpen", { from: day(p.valid_from) })}
                      {p.min_qty > 1 ? ` · ${t("minQtyValue", { qty: p.min_qty })}` : null}
                    </p>
                    <p className="flex flex-wrap gap-1 text-sm">
                      {targets.length === 0 ? (
                        <Badge>{t("appliesToAll")}</Badge>
                      ) : (
                        targets.map((part) => (
                          <Badge key={part.kind} tone="info">
                            {t(`target.${part.kind}`, { name: part.label })}
                          </Badge>
                        ))
                      )}
                    </p>
                  </div>
                  {manage && p.state !== "ended" ? (
                    <RowAction
                      action={endPromotion}
                      fields={{ promotion_id: p.id }}
                      label={t("end")}
                      variant="destructive"
                      confirmText={t("confirmEnd", { name: p.name })}
                    />
                  ) : null}
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      <p className="text-xs text-muted-foreground">{t("pricingNote")}</p>

      {manage && brands?.ok && categories?.ok ? (
        <Card className="space-y-4">
          <CardTitle>{t("newTitle")}</CardTitle>
          <PromotionForm
            newId={crypto.randomUUID()}
            today={todayInCairo()}
            brands={brands.data}
            categories={categories.data}
            skus={skus && skus.ok ? skus.data : []}
          />
        </Card>
      ) : null}
    </div>
  );
}
