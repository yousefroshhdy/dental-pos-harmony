import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { z } from "zod";
import { Forbidden } from "@/components/forbidden";
import { Alert } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { EditCustomerForm } from "@/modules/crm/components/customer-form";
import { formatEgyptPhone, lifecycleOptions, localizedName } from "@/modules/crm/logic";
import { getCustomer, listGovernorates, listSpecialties } from "@/modules/crm/queries";

type Props = { params: Promise<{ locale: string; id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "crm.form" });
  return { title: t("editTitle") };
}

export default async function EditCustomerPage({ params }: Props) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  if (!z.guid().safeParse(id).success) notFound();

  const ctx = await getUserContext();
  if (!can(ctx, "crm.customer.update")) return <Forbidden />;

  const t = await getTranslations("crm.form");
  const tStage = await getTranslations("crm.stage");
  const tErrors = await getTranslations("errors");
  const [customer, governorates, specialties] = await Promise.all([getCustomer(id), listGovernorates(), listSpecialties()]);
  if (!customer.ok) return <Alert>{tErrors(customer.error.messageKey, { requestId: customer.error.requestId ?? "—" })}</Alert>;
  if (!customer.data) notFound();
  if (!governorates.ok) return <Alert>{tErrors(governorates.error.messageKey, { requestId: governorates.error.requestId ?? "—" })}</Alert>;
  const c = customer.data;

  if (c.archived_at) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <Alert>{t("archivedReadOnly")}</Alert>
        <Link href={`/customers/${c.id}`} className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline">
          {t("backToCustomer")}
        </Link>
      </div>
    );
  }

  const initial: Record<string, string> = {
    doctor_name: c.doctor_name ?? "",
    clinic_name: c.clinic_name ?? "",
    display_name: c.display_name,
    kind: c.kind,
    specialty_code: c.specialty_code ?? "",
    phone_primary: formatEgyptPhone(c.phone_primary),
    phone_secondary: formatEgyptPhone(c.phone_secondary),
    email: c.email ?? "",
    address_line: c.address_line ?? "",
    city: c.city ?? "",
    governorate_code: c.governorate_code ?? "",
    tags: c.tags.join(", "),
    notes: c.notes ?? "",
    lifecycle_stage: c.lifecycle_stage,
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Link href={`/customers/${c.id}`} className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline">
        {t("backToCustomer")}
      </Link>
      <h1 className="text-2xl font-semibold">
        {t("editTitle")} <span className="text-base font-normal text-muted-foreground">{c.display_name}</span>
      </h1>
      <EditCustomerForm
        customerId={c.id}
        version={c.version}
        stageOptions={lifecycleOptions(c.lifecycle_stage).map((s) => ({ value: s, label: tStage(s) }))}
        locale={locale === "en" ? "en" : "ar"}
        governorates={governorates.data
          .map((g) => ({ value: g.code, label: localizedName(locale, g.name_en, g.name_ar) }))
          .sort((a, b) => a.label.localeCompare(b.label, locale))}
        specialties={specialties.ok ? specialties.data.map((s) => ({ value: s.code, label: localizedName(locale, s.name_en, s.name_ar) })) : []}
        initial={initial}
        cancelHref={`/customers/${c.id}`}
      />
    </div>
  );
}
