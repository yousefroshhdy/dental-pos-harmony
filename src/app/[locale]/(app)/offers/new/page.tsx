import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { Link } from "@/i18n/navigation";
import { getUserContext } from "@/lib/authz/context";
import { OfferForm } from "@/modules/offers/components/offer-form";
import { cairoToday, canManageOffers } from "@/modules/offers/logic";

type Params = Promise<{ locale: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "orders.offerAdmin" });
  return { title: t("newTitle") };
}

/** A new offer. Its id is generated here once, so a retried save never creates a second offer. */
export default async function NewOfferPage({ params }: { params: Params }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!canManageOffers(ctx)) return <Forbidden />;
  const t = await getTranslations("orders.offerAdmin");
  return (
    <div className="space-y-4">
      <Link href="/offers" className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline">
        {t("back")}
      </Link>
      <h1 className="text-2xl font-semibold">{t("newTitle")}</h1>
      <OfferForm
        initial={{
          offerId: crypto.randomUUID(),
          version: null,
          code: "",
          nameEn: "",
          nameAr: "",
          description: "",
          mode: "package",
          packagePrice: "",
          validFrom: cairoToday(),
          validTo: "",
          items: [],
          customerNos: "",
          tags: "",
        }}
      />
    </div>
  );
}
