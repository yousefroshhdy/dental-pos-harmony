import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { buttonVariants } from "@/components/ui/button";
import { Badge, Card, Input, Label, Select } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { getUserContext } from "@/lib/authz/context";
import { CatalogErrorMessage } from "@/modules/catalog/components/action-form";
import { CatalogTabs } from "@/modules/catalog/components/catalog-tabs";
import {
  attributeSummary,
  canManageProducts,
  canReadPrices,
  canReadProducts,
  filterProducts,
  groupVariantsByProduct,
  localizedName,
  productStatusTone,
  toNumber,
  variantStatusTone,
} from "@/modules/catalog/logic";
import { listBrands, listProducts, listVariants } from "@/modules/catalog/queries";

type Params = Promise<{ locale: string }>;
type Search = Promise<{ q?: string | string[]; brand?: string | string[]; status?: string | string[] }>;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "catalog.products" });
  return { title: t("title") };
}

export default async function CatalogPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!canReadProducts(ctx)) return <Forbidden />;

  const search = await searchParams;
  const filter = { q: one(search.q), brand: one(search.brand), status: one(search.status) };
  const t = await getTranslations("catalog.products");
  const tStatus = await getTranslations("catalog.product.status");
  const format = await getFormatter();

  const [products, variants, brands] = await Promise.all([listProducts(), listVariants(), listBrands()]);
  const failure = [products, variants, brands].find((r) => !r.ok);
  if (failure && !failure.ok) return <CatalogErrorMessage messageKey={failure.error.messageKey} requestId={failure.error.requestId} />;
  if (!products.ok || !variants.ok || !brands.ok) return null;

  const all = groupVariantsByProduct(products.data, variants.data);
  const shown = filterProducts(all, filter);
  const manage = canManageProducts(ctx);
  const showPrices = canReadPrices(ctx);
  const filtered = Boolean(filter.q || filter.brand || filter.status);

  return (
    <div className="space-y-6">
      <CatalogTabs ctx={ctx} current="products" />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("summary", { products: all.length, variants: variants.data.length })}</p>
        </div>
        {manage ? (
          <Link href="/catalog/products/new" className={buttonVariants()}>
            {t("new")}
          </Link>
        ) : null}
      </div>

      <form method="get" role="search" aria-label={t("filters")} className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-end">
        <div className="space-y-1">
          <Label htmlFor="catalog-q">{t("search")}</Label>
          <Input id="catalog-q" name="q" type="search" defaultValue={filter.q ?? ""} placeholder={t("searchPlaceholder")} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="catalog-brand">{t("brand")}</Label>
          <Select id="catalog-brand" name="brand" defaultValue={filter.brand ?? ""} className="w-full">
            <option value="">{t("allBrands")}</option>
            {brands.data.map((b) => (
              <option key={b.id} value={b.code}>
                {b.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="catalog-status">{t("status")}</Label>
          <Select id="catalog-status" name="status" defaultValue={filter.status ?? ""} className="w-full">
            <option value="">{t("allStatuses")}</option>
            <option value="active">{tStatus("active")}</option>
            <option value="draft">{tStatus("draft")}</option>
            <option value="discontinued">{tStatus("discontinued")}</option>
          </Select>
        </div>
        <div className="flex gap-2">
          <button type="submit" className={buttonVariants({ variant: "outline" })}>
            {t("apply")}
          </button>
          {filtered ? (
            <Link href="/catalog" className={buttonVariants({ variant: "ghost" })}>
              {t("clear")}
            </Link>
          ) : null}
        </div>
      </form>

      {shown.length === 0 ? (
        <Card className="space-y-3 text-center">
          <p className="text-sm text-muted-foreground">{filtered ? t("noMatch") : t("empty")}</p>
          {manage && !filtered ? (
            <Link href="/catalog/products/new" className={buttonVariants({ variant: "outline" })}>
              {t("new")}
            </Link>
          ) : null}
        </Card>
      ) : (
        <ul className="space-y-3" aria-label={t("listLabel")}>
          {shown.map((p) => (
            <li key={p.id}>
              <Card className="space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 space-y-1">
                    <Link
                      href={`/catalog/products/${p.id}`}
                      className="inline-flex min-h-11 items-center gap-2 font-semibold text-primary underline-offset-4 hover:underline"
                    >
                      <span>{localizedName(locale, p.name_en, p.name_ar)}</span>
                    </Link>
                    <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                      <code dir="ltr">{p.code}</code>
                      <span aria-hidden>·</span>
                      <span>{p.brand_name}</span>
                      <span aria-hidden>·</span>
                      <span>{localizedName(locale, p.category_name_en, p.category_name_ar)}</span>
                    </p>
                  </div>
                  <Badge tone={productStatusTone(p.status)}>{tStatus(p.status)}</Badge>
                </div>
                {p.variants.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("noVariants")}</p>
                ) : (
                  <ul className="divide-y rounded-md border" aria-label={t("variantsOf", { name: p.code })}>
                    {p.variants.map((v) => {
                      const price = toNumber(v.default_price);
                      return (
                        <li key={v.id} className="flex flex-col gap-1 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                          <div className="min-w-0">
                            <code dir="ltr" className="text-sm font-medium break-all">
                              {v.sku}
                            </code>
                            <span className="ms-2 text-sm">{v.name_en}</span>
                            {attributeSummary(v.attributes) ? (
                              <span className="block text-xs text-muted-foreground" dir="ltr">
                                {attributeSummary(v.attributes)}
                              </span>
                            ) : null}
                          </div>
                          <div className="flex flex-wrap items-center gap-2 text-sm">
                            {showPrices ? (
                              <span className="tabular-nums">{price === null ? t("noPrice") : format.number(price, "egp")}</span>
                            ) : null}
                            {v.status !== "active" ? <Badge tone={variantStatusTone(v.status)}>{tStatus(v.status)}</Badge> : null}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
