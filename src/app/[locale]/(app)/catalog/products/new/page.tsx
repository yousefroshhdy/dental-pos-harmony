import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { Card } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { getUserContext } from "@/lib/authz/context";
import { CatalogErrorMessage } from "@/modules/catalog/components/action-form";
import { ProductForm } from "@/modules/catalog/components/product-form";
import { canManageProducts } from "@/modules/catalog/logic";
import { listBrands, listCategories } from "@/modules/catalog/queries";

type Params = Promise<{ locale: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "catalog.product" });
  return { title: t("newTitle") };
}

export default async function NewProductPage({ params }: { params: Params }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!canManageProducts(ctx)) return <Forbidden />;

  const t = await getTranslations("catalog.product");
  const [brands, categories] = await Promise.all([listBrands(), listCategories()]);
  if (!brands.ok) return <CatalogErrorMessage messageKey={brands.error.messageKey} requestId={brands.error.requestId} />;
  if (!categories.ok) return <CatalogErrorMessage messageKey={categories.error.messageKey} requestId={categories.error.requestId} />;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Link href="/catalog" className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline">
        {t("back")}
      </Link>
      <div>
        <h1 className="text-2xl font-semibold">{t("newTitle")}</h1>
        <p className="text-sm text-muted-foreground">{t("newIntro")}</p>
      </div>
      <Card>
        {/* The id is generated here so a double submit creates one product, not two. */}
        <ProductForm newId={crypto.randomUUID()} brands={brands.data} categories={categories.data} />
      </Card>
    </div>
  );
}
