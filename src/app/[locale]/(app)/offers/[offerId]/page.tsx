import type { Metadata } from "next";
import type { ReactNode } from "react";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { z } from "zod";
import { Forbidden } from "@/components/forbidden";
import { Alert, Badge, Card, CardTitle, Table, Td, Th } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { getUserContext } from "@/lib/authz/context";
import { OfferActiveForm } from "@/modules/offers/components/offer-active-form";
import { OfferError } from "@/modules/offers/components/offer-error";
import { OfferForm } from "@/modules/offers/components/offer-form";
import { cairoToday, canManageOffers, canReadOffers, offerErrorCode, offerState, offerStateTone } from "@/modules/offers/logic";
import { getOffer, listOfferCustomers, listOfferItems } from "@/modules/offers/queries";
import { QUANTITY } from "@/modules/orders/format";
import { localizedName, toNumber } from "@/modules/orders/logic";

type Params = Promise<{ locale: string; offerId: string }>;
type SearchParams = Promise<{ saved?: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "orders.offerAdmin" });
  return { title: t("detailTitle") };
}

export default async function OfferPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const { locale, offerId } = await params;
  setRequestLocale(locale);
  if (!z.guid().safeParse(offerId).success) notFound();
  const ctx = await getUserContext();
  if (!canReadOffers(ctx)) return <Forbidden />;

  const [offer, items, customers] = await Promise.all([getOffer(offerId), listOfferItems(offerId), listOfferCustomers(offerId)]);
  if (!offer.ok) return <OfferError code={offerErrorCode(offer.error)} requestId={offer.error.requestId} />;
  if (!offer.data) notFound();
  if (!items.ok) return <OfferError code={offerErrorCode(items.error)} requestId={items.error.requestId} />;

  const o = offer.data;
  const t = await getTranslations("orders.offerAdmin");
  const format = await getFormatter();
  const sp = await searchParams;
  const state = offerState(o, cairoToday());
  const manage = canManageOffers(ctx);
  const money = (v: number | string | null) => format.number(toNumber(v), "egp");
  const targets = customers.ok ? customers.data : [];

  return (
    <div className="space-y-6">
      <Link href="/offers" className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline">
        {t("back")}
      </Link>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-semibold break-words">{localizedName(locale, o.name_en, o.name_ar)}</h1>
        <Badge tone={offerStateTone(state)}>{t(`state.${state}`)}</Badge>
      </div>
      {sp.saved ? (
        <Alert tone="success" role="status">
          {t("saved")}
        </Alert>
      ) : null}

      <Card className="grid gap-3 text-sm sm:grid-cols-2">
        <Info label={t("code")} value={<span dir="ltr">{o.code}</span>} />
        <Info label={t("mode")} value={o.pricing_mode === "package" ? t("packageOf", { price: money(o.package_price) }) : t("perLine")} />
        <Info label={t("validFrom")} value={o.valid_from} />
        <Info label={t("validTo")} value={o.valid_to ?? t("noEnd")} />
        <Info label={t("tags")} value={o.target_tags.length > 0 ? o.target_tags.join(", ") : "—"} />
        <Info label={t("customerNos")} value={o.target_customer_count > 0 ? t("customersCount", { count: o.target_customer_count }) : "—"} />
        {o.description ? <Info label={t("description")} value={o.description} /> : null}
      </Card>

      <section className="space-y-3" aria-labelledby="offer-items">
        <CardTitle id="offer-items">{t("itemsTitle")}</CardTitle>
        {items.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noItems")}</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>{t("product")}</Th>
                <Th className="text-end">{t("quantity")}</Th>
                <Th className="text-end">{t("netUnitPrice")}</Th>
              </tr>
            </thead>
            <tbody>
              {items.data.map((i) => (
                <tr key={i.id}>
                  <Td className="min-w-40">
                    {i.variant_name}
                    <span dir="ltr" className="block text-xs text-muted-foreground">
                      {i.sku}
                    </span>
                  </Td>
                  <Td className="text-end">{format.number(i.quantity, QUANTITY)}</Td>
                  <Td className="text-end whitespace-nowrap">
                    {i.is_bonus ? <Badge tone="success">{t("bonus")}</Badge> : i.net_unit_price != null ? money(i.net_unit_price) : t("fromPackage")}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <p className="text-xs text-muted-foreground">{t("pricesBeforeVat")}</p>
      </section>

      {targets.length > 0 ? (
        <section className="space-y-2" aria-labelledby="offer-targets">
          <CardTitle id="offer-targets">{t("targetTitle")}</CardTitle>
          <ul className="flex flex-wrap gap-2 text-sm">
            {targets.map((c) => (
              <li key={c.customer_id} className="rounded-md border px-2 py-1">
                {c.customer_name} <span dir="ltr" className="text-muted-foreground">{c.customer_no}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {manage ? (
        <>
          <Card className="space-y-2">
            <CardTitle>{t("statusTitle")}</CardTitle>
            <OfferActiveForm offerId={o.id} active={o.is_active} />
          </Card>
          <section className="space-y-3" aria-labelledby="offer-edit">
            <CardTitle id="offer-edit">{t("editTitle")}</CardTitle>
            <p className="text-xs text-muted-foreground">{t("editHint")}</p>
            <OfferForm
              initial={{
                offerId: o.id,
                version: o.version,
                code: o.code,
                nameEn: o.name_en,
                nameAr: o.name_ar ?? "",
                description: o.description ?? "",
                mode: o.pricing_mode,
                packagePrice: o.package_price != null ? String(toNumber(o.package_price)) : "",
                validFrom: o.valid_from,
                validTo: o.valid_to ?? "",
                items: items.data.map((i) => ({
                  variant_id: i.variant_id,
                  sku: i.sku,
                  name: i.variant_name,
                  quantity: String(i.quantity),
                  is_bonus: i.is_bonus,
                  net_unit_price: i.net_unit_price != null ? String(toNumber(i.net_unit_price)) : "",
                })),
                customerNos: targets.map((c) => c.customer_no ?? "").filter(Boolean).join(", "),
                tags: o.target_tags.join(", "),
              }}
            />
            {!customers.ok || targets.length < o.target_customer_count ? <Alert>{t("targetsHidden")}</Alert> : null}
          </section>
        </>
      ) : null}
    </div>
  );
}

function Info({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="break-words">{value}</p>
    </div>
  );
}
