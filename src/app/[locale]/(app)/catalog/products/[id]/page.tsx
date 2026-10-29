import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { z } from "zod";
import { Forbidden } from "@/components/forbidden";
import { Alert, Badge, Card, CardTitle, Table, Td, Th } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { getUserContext } from "@/lib/authz/context";
import { setProductStatus, setVariantStatus } from "@/modules/catalog/actions";
import { CatalogErrorMessage } from "@/modules/catalog/components/action-form";
import { ProductForm } from "@/modules/catalog/components/product-form";
import { RowAction } from "@/modules/catalog/components/row-action";
import { VariantForm } from "@/modules/catalog/components/variant-form";
import {
  attributeSummary,
  canManageProducts,
  canReadPrices,
  canReadProducts,
  localizedName,
  productStatusActions,
  productStatusTone,
  toNumber,
  variantStatusAction,
  variantStatusTone,
} from "@/modules/catalog/logic";
import { getProduct, listBrands, listCategories, listPriceListItems, listVariants } from "@/modules/catalog/queries";
import type { PriceListItemRow } from "@/modules/catalog/types";

type Params = Promise<{ locale: string; id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "catalog.product" });
  return { title: t("editTitle") };
}

export default async function ProductPage({ params }: { params: Params }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  if (!z.guid().safeParse(id).success) notFound();

  const ctx = await getUserContext();
  if (!canReadProducts(ctx)) return <Forbidden />;

  const t = await getTranslations("catalog.product");
  const tStatus = await getTranslations("catalog.product.status");
  const tVariant = await getTranslations("catalog.variant");
  const format = await getFormatter();
  const manage = canManageProducts(ctx);
  const showPrices = canReadPrices(ctx);

  const [product, variants, brands, categories, prices] = await Promise.all([
    getProduct(id),
    listVariants(id),
    manage ? listBrands() : Promise.resolve(null),
    manage ? listCategories() : Promise.resolve(null),
    showPrices ? listPriceListItems({ productId: id }) : Promise.resolve(null),
  ]);
  if (!product.ok) return <CatalogErrorMessage messageKey={product.error.messageKey} requestId={product.error.requestId} />;
  if (!product.data) notFound();
  if (!variants.ok) return <CatalogErrorMessage messageKey={variants.error.messageKey} requestId={variants.error.requestId} />;

  const p = product.data;
  const priceRows: PriceListItemRow[] = prices && prices.ok ? prices.data : [];

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Link href="/catalog" className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline">
          {t("back")}
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold">{localizedName(locale, p.name_en, p.name_ar)}</h1>
          <code dir="ltr" className="text-sm text-muted-foreground">
            {p.code}
          </code>
          <Badge tone={productStatusTone(p.status)}>{tStatus(p.status)}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {p.brand_name} · {localizedName(locale, p.category_name_en, p.category_name_ar)}
        </p>
      </div>

      {p.status === "discontinued" ? <Alert tone="info">{t("discontinuedNote")}</Alert> : null}

      {manage ? (
        <Card className="space-y-3">
          <CardTitle>{t("statusTitle")}</CardTitle>
          <p className="text-sm text-muted-foreground">{t("statusHint")}</p>
          <div className="flex flex-wrap gap-2">
            {productStatusActions(p.status).map((next) => (
              <RowAction
                key={next}
                action={setProductStatus}
                fields={{ product_id: p.id, status: next }}
                label={t(`statusAction.${next}`)}
                variant={next === "discontinued" ? "destructive" : "outline"}
                confirmText={next === "discontinued" ? t("confirmDiscontinue") : undefined}
              />
            ))}
          </div>
        </Card>
      ) : null}

      <Card className="space-y-4">
        <CardTitle>{t("details")}</CardTitle>
        {manage && brands?.ok && categories?.ok ? (
          <ProductForm product={p} brands={brands.data} categories={categories.data} />
        ) : (
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">{t("nameEn")}</dt>
              <dd dir="ltr">{p.name_en}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("nameAr")}</dt>
              <dd>{p.name_ar ?? "—"}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-muted-foreground">{t("description")}</dt>
              <dd>{p.description ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("tracking")}</dt>
              <dd className="flex flex-wrap gap-1">
                {p.is_lot_tracked ? <Badge>{t("lotTracked")}</Badge> : null}
                {p.is_expiry_tracked ? <Badge>{t("expiryTracked")}</Badge> : null}
                {p.is_serial_tracked ? <Badge>{t("serialTracked")}</Badge> : null}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("vat")}</dt>
              <dd className="tabular-nums">{format.number(Number(p.tax_rate_pct) / 100, { style: "percent", maximumFractionDigits: 2, numberingSystem: "latn" })}</dd>
            </div>
          </dl>
        )}
      </Card>

      <Card className="space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <CardTitle>{tVariant("title")}</CardTitle>
          <span className="text-sm text-muted-foreground">{tVariant("count", { active: p.active_variant_count, total: p.variant_count })}</span>
        </div>
        {variants.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">{tVariant("empty")}</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {variants.data.map((v) => {
              const nextStatus = variantStatusAction(v);
              return (
                <li key={v.id} className="space-y-2 px-3 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <code dir="ltr" className="font-medium break-all">
                        {v.sku}
                      </code>
                      <span className="ms-2">{v.name_en}</span>
                      <span className="block text-xs text-muted-foreground" dir="ltr">
                        {[attributeSummary(v.attributes), v.barcode, v.uom].filter(Boolean).join(" · ")}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {showPrices ? (
                        <span className="text-sm tabular-nums">
                          {toNumber(v.default_price) === null ? t("noDefaultPrice") : format.number(Number(v.default_price), "egp")}
                        </span>
                      ) : null}
                      <Badge tone={variantStatusTone(v.status)}>{tStatus(v.status)}</Badge>
                      {manage && nextStatus ? (
                        <RowAction
                          action={setVariantStatus}
                          fields={{ variant_id: v.id, status: nextStatus }}
                          label={tVariant(`statusAction.${nextStatus}`)}
                          size="sm"
                          confirmText={nextStatus === "discontinued" ? tVariant("confirmDiscontinue", { sku: v.sku }) : undefined}
                        />
                      ) : null}
                    </div>
                  </div>
                  {manage ? (
                    <details>
                      <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm text-primary">{tVariant("edit")}</summary>
                      <div className="pt-2">
                        <VariantForm productId={p.id} variant={v} />
                      </div>
                    </details>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {manage && p.status !== "discontinued" ? (
          <div className="space-y-3 border-t pt-4">
            <h3 className="font-medium">{tVariant("addTitle")}</h3>
            <VariantForm productId={p.id} newId={crypto.randomUUID()} />
          </div>
        ) : null}
      </Card>

      {showPrices ? (
        <Card className="space-y-3">
          <CardTitle>{t("pricesTitle")}</CardTitle>
          {prices && !prices.ok ? (
            <CatalogErrorMessage messageKey={prices.error.messageKey} requestId={prices.error.requestId} />
          ) : priceRows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("noPrices")}</p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>{t("priceList")}</Th>
                  <Th>{tVariant("sku")}</Th>
                  <Th className="text-end">{t("minQty")}</Th>
                  <Th className="text-end">{t("unitPrice")}</Th>
                </tr>
              </thead>
              <tbody>
                {priceRows.map((row) => (
                  <tr key={`${row.price_list_id}:${row.variant_id}:${row.min_qty}`}>
                    <Td>
                      <Link href={`/catalog/price-lists/${row.price_list_id}`} className="inline-flex min-h-11 items-center text-primary underline-offset-4 hover:underline">
                        <code dir="ltr">{row.price_list_code}</code>
                      </Link>
                    </Td>
                    <Td>
                      <code dir="ltr">{row.sku}</code>
                    </Td>
                    <Td className="text-end tabular-nums">{row.min_qty}</Td>
                    <Td className="text-end tabular-nums">{format.number(Number(row.unit_price), "egp")}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      ) : null}
    </div>
  );
}
