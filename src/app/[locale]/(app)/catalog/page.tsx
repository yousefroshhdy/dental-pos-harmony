import { PlusIcon } from "lucide-react";
import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { FilterChips } from "@/components/page-kit/filter-chips";
import { UrlSelectFilter } from "@/components/page-kit/url-select-filter";
import { buttonVariants } from "@/components/ui/button";
import { readTableParams } from "@/components/ui/data-table-params";
import { PageHeader } from "@/components/ui/page-header";
import { Link } from "@/i18n/navigation";
import { getUserContext } from "@/lib/authz/context";
import { firstParam, pickParam } from "@/lib/list-query";
import { CatalogErrorMessage } from "@/modules/catalog/components/action-form";
import { CatalogTabs } from "@/modules/catalog/components/catalog-tabs";
import { ProductsTable, type ProductListRow } from "@/modules/catalog/components/products-table";
import { canManageProducts, canReadPrices, canReadProducts, localizedName, productStatusTone, toNumber } from "@/modules/catalog/logic";
import { listBrands, listProductsPage, listVariantsFor } from "@/modules/catalog/queries";
import { priceRange, PRODUCT_STATUSES, PRODUCTS_TABLE, productSortColumn } from "@/modules/catalog/tables";
import type { VariantRow } from "@/modules/catalog/types";

type Params = Promise<{ locale: string }>;
type Search = Promise<Record<string, string | string[] | undefined>>;

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

  const sp = await searchParams;
  const table = readTableParams(sp, PRODUCTS_TABLE);
  const status = pickParam(sp, "status", [...PRODUCT_STATUSES, "all"] as const, "all");
  const rawBrand = firstParam(sp, "brand");
  const brand = rawBrand && /^[A-Za-z0-9_-]{1,40}$/.test(rawBrand) ? rawBrand : null;

  const t = await getTranslations("catalog.products");
  const tStatus = await getTranslations("catalog.product.status");
  const tl = await getTranslations("catalog.list");
  const format = await getFormatter();
  const showPrices = canReadPrices(ctx);
  const manage = canManageProducts(ctx);

  const [products, brands] = await Promise.all([
    listProductsPage({
      offset: table.offset,
      pageSize: table.pageSize,
      orderBy: productSortColumn(table.sorting[0]?.id, locale),
      desc: table.sorting[0]?.desc ?? false,
      search: table.search,
      brand,
      status: status === "all" ? null : status,
    }),
    listBrands(),
  ]);
  const pageRows = products.ok ? products.data.rows : [];
  const variants = await listVariantsFor(pageRows.map((p) => p.id));
  const byProduct = new Map<string, VariantRow[]>();
  for (const v of variants.ok ? variants.data : []) byProduct.set(v.product_id, [...(byProduct.get(v.product_id) ?? []), v]);

  const money = (n: number) => format.number(n, "egp");
  const rows: ProductListRow[] = pageRows.map((p) => {
    const range = priceRange((byProduct.get(p.id) ?? []).filter((v) => v.status === "active").map((v) => toNumber(v.default_price)));
    return {
      id: p.id,
      code: p.code,
      name: localizedName(locale, p.name_en, p.name_ar),
      brand: p.brand_name,
      category: localizedName(locale, p.category_name_en, p.category_name_ar),
      status: p.status,
      statusTone: productStatusTone(p.status),
      variants: Number(p.variant_count),
      activeVariants: Number(p.active_variant_count),
      price: !showPrices || !range ? null : range.min === range.max ? money(range.min) : `${money(range.min)} – ${money(range.max)}`,
    };
  });

  return (
    <div className="space-y-6">
      <CatalogTabs ctx={ctx} current="products" />
      <PageHeader
        title={t("title")}
        description={products.ok ? tl("count", { count: products.data.total }) : undefined}
        actions={
          manage ? (
            <Link href="/catalog/products/new" className={buttonVariants()}>
              <PlusIcon aria-hidden="true" />
              {t("new")}
            </Link>
          ) : null
        }
      />

      <ProductsTable
        rows={rows}
        rowCount={products.ok ? products.data.total : 0}
        canCreate={manage}
        showPrices={showPrices}
        filtered={Boolean(brand || status !== "all")}
        error={
          products.ok ? undefined : <CatalogErrorMessage messageKey={products.error.messageKey} requestId={products.error.requestId} />
        }
        filters={
          <>
            <FilterChips
              label={t("status")}
              pathname="/catalog"
              params={sp}
              param="status"
              current={status === "all" ? null : status}
              options={[{ value: null, label: t("allStatuses") }, ...PRODUCT_STATUSES.map((s) => ({ value: s, label: tStatus(s) }))]}
            />
            {brands.ok && brands.data.length > 0 ? (
              <UrlSelectFilter
                label={t("brand")}
                param="brand"
                options={[{ value: "", label: t("allBrands") }, ...brands.data.map((b) => ({ value: b.code, label: b.name }))]}
              />
            ) : null}
          </>
        }
      />
    </div>
  );
}
