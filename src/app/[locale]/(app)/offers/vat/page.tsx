import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { Card } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { getUserContext } from "@/lib/authz/context";
import { VatRateForm } from "@/modules/catalog/components/vat-rate-form";
import { OfferError } from "@/modules/offers/components/offer-error";
import { canSetVat, offerErrorCode } from "@/modules/offers/logic";
import { listVatProducts } from "@/modules/offers/queries";
import { PERCENT } from "@/modules/orders/format";
import { localizedName, toNumber } from "@/modules/orders/logic";

type Params = Promise<{ locale: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "orders.offerAdmin" });
  return { title: t("vatTitle") };
}

/**
 * VAT per product (decision C, pending the accountant): the owner sets each rate,
 * 14 % by default. Changes are audited; drafts take them at their next save,
 * submitted orders and issued invoices keep the rate they were priced with.
 */
export default async function VatPage({ params }: { params: Params }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!canSetVat(ctx)) return <Forbidden />;

  const t = await getTranslations("orders.offerAdmin");
  const format = await getFormatter();
  const products = await listVatProducts();

  return (
    <div className="space-y-6">
      <Link href="/offers" className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline">
        {t("back")}
      </Link>
      <div>
        <h1 className="text-2xl font-semibold">{t("vatTitle")}</h1>
        <p className="text-sm text-muted-foreground">{t("vatIntro")}</p>
      </div>
      {!products.ok ? (
        <OfferError code={offerErrorCode(products.error)} requestId={products.error.requestId} />
      ) : products.data.length === 0 ? (
        <Card>
          <p className="text-sm text-muted-foreground">{t("vatEmpty")}</p>
        </Card>
      ) : (
        <ul className="space-y-3">
          {products.data.map((p) => {
            const name = localizedName(locale, p.name_en, p.name_ar);
            return (
              <li key={p.id} className="space-y-2 rounded-lg border bg-card p-4">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-medium break-words">{name}</span>
                  <span dir="ltr" className="text-xs text-muted-foreground">
                    {p.code}
                  </span>
                  <span className="ms-auto text-sm font-semibold">{`${format.number(toNumber(p.tax_rate_pct), PERCENT)}%`}</span>
                </div>
                <p className="text-xs text-muted-foreground">{[p.brand_name, localizedName(locale, p.category_name_en, p.category_name_ar)].filter(Boolean).join(" · ")}</p>
                <VatRateForm productId={p.id} rate={toNumber(p.tax_rate_pct)} label={name} />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
