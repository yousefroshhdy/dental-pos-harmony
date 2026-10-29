import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { Alert } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { CreateCustomerForm } from "@/modules/crm/components/customer-form";
import { localizedName } from "@/modules/crm/logic";
import { listGovernorates, listSpecialties } from "@/modules/crm/queries";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "crm.form" });
  return { title: t("newTitle") };
}

export default async function NewCustomerPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!can(ctx, "crm.customer.create")) return <Forbidden />;

  const t = await getTranslations("crm.form");
  const tErrors = await getTranslations("errors");
  const [governorates, specialties] = await Promise.all([listGovernorates(), listSpecialties()]);
  if (!governorates.ok) return <Alert>{tErrors(governorates.error.messageKey, { requestId: governorates.error.requestId ?? "—" })}</Alert>;

  const sortedGovernorates = governorates.data
    .map((g) => ({ value: g.code, label: localizedName(locale, g.name_en, g.name_ar) }))
    .sort((a, b) => a.label.localeCompare(b.label, locale));
  const specialtyOptions = specialties.ok
    ? specialties.data.map((s) => ({ value: s.code, label: localizedName(locale, s.name_en, s.name_ar) }))
    : [];

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Link href="/customers" className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline">
        {t("backToList")}
      </Link>
      <h1 className="text-2xl font-semibold">{t("newTitle")}</h1>
      <p className="text-sm text-muted-foreground">{t("newIntro")}</p>
      <CreateCustomerForm
        // A fresh idempotency key per page load: a double tap or a retry after a lost response replays, not duplicates.
        clientRef={crypto.randomUUID()}
        locale={locale === "en" ? "en" : "ar"}
        governorates={sortedGovernorates}
        specialties={specialtyOptions}
        initial={{ kind: "clinic", source: "field" }}
        cancelHref="/customers"
      />
    </div>
  );
}
