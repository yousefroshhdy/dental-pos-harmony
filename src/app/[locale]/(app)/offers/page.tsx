import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { buttonVariants } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/primitives";
import { PageHeader } from "@/components/ui/page-header";
import { Link } from "@/i18n/navigation";
import { getUserContext } from "@/lib/authz/context";
import { OfferError } from "@/modules/offers/components/offer-error";
import { cairoToday, canManageOffers, canReadOffers, canSetVat, offerErrorCode, offerState, offerStateTone } from "@/modules/offers/logic";
import { listOffers } from "@/modules/offers/queries";
import { localizedName, toNumber } from "@/modules/orders/logic";

type Params = Promise<{ locale: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "orders.offerAdmin" });
  return { title: t("title") };
}

/** Offers and packages (decision B). Everyone who sells sees them; the owner defines them. */
export default async function OffersPage({ params }: { params: Params }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!canReadOffers(ctx)) return <Forbidden />;

  const t = await getTranslations("orders.offerAdmin");
  const format = await getFormatter();
  const offers = await listOffers();
  const today = cairoToday();
  const money = (v: number | string | null) => format.number(toNumber(v), "egp");

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("title")}
        description={t("intro")}
        actions={
          <>
            {canSetVat(ctx) ? (
              <Link href="/offers/vat" className={buttonVariants({ variant: "outline" })}>
                {t("vatLink")}
              </Link>
            ) : null}
            {canManageOffers(ctx) ? (
              <Link href="/offers/new" className={buttonVariants()}>
                {t("new")}
              </Link>
            ) : null}
          </>
        }
      />

      {!offers.ok ? (
        <OfferError code={offerErrorCode(offers.error)} requestId={offers.error.requestId} />
      ) : offers.data.length === 0 ? (
        <Card>
          <p className="text-sm text-muted-foreground">{canManageOffers(ctx) ? t("emptyOwner") : t("empty")}</p>
        </Card>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {offers.data.map((o) => {
            const state = offerState(o, today);
            return (
              <li key={o.id}>
                <Link href={`/offers/${o.id}`} className="block h-full min-h-11 rounded-lg border bg-card p-4 shadow-xs transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium break-words">{localizedName(locale, o.name_en, o.name_ar)}</span>
                    <Badge tone={offerStateTone(state)}>{t(`state.${state}`)}</Badge>
                    {o.is_targeted ? <Badge tone="info">{t("targeted")}</Badge> : null}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground break-words">
                    <span dir="ltr">{o.code}</span>
                    {" · "}
                    {o.pricing_mode === "package" ? t("packageOf", { price: money(o.package_price) }) : t("perLine")}
                    {" · "}
                    {t("itemsCount", { paid: o.paid_items, bonus: o.bonus_items })}
                    {" · "}
                    {o.valid_to ? t("window", { from: o.valid_from, to: o.valid_to }) : t("windowOpen", { from: o.valid_from })}
                  </p>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
