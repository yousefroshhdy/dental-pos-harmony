import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { buttonVariants } from "@/components/ui/button";
import { Alert } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { CustomerFilters, CustomerList, Pagination } from "@/modules/crm/components/customer-list";
import { localizedName, totalPages } from "@/modules/crm/logic";
import { listCustomers, listGovernorates, listSpecialties, listTerritories } from "@/modules/crm/queries";
import { customerListParamsSchema, firstValues } from "@/modules/crm/schemas";
import { ExportCsvButton } from "@/modules/reports/components/export-csv-button";

type Props = { params: Promise<{ locale: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ params }: Pick<Props, "params">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "crm.list" });
  return { title: t("title") };
}

export default async function CustomersPage({ params, searchParams }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!can(ctx, "crm.customer.read")) return <Forbidden />;

  const t = await getTranslations("crm.list");
  const tErrors = await getTranslations("errors");
  const filters = customerListParamsSchema.parse(firstValues(await searchParams));

  const [page, territories, specialties, governorates] = await Promise.all([
    listCustomers(filters),
    listTerritories(),
    listSpecialties(),
    listGovernorates(),
  ]);

  const territoryOptions = territories.ok
    ? territories.data.map((tr) => ({ value: tr.id, label: localizedName(locale, tr.name_en, tr.name_ar) }))
    : [];
  const specialtyOptions = specialties.ok ? specialties.data.map((s) => ({ value: s.code, label: localizedName(locale, s.name_en, s.name_ar) })) : [];
  const governorateNames = new Map(governorates.ok ? governorates.data.map((g) => [g.code, localizedName(locale, g.name_en, g.name_ar)]) : []);
  const specialtyNames = new Map(specialtyOptions.map((o) => [o.value, o.label]));
  const filtered = Boolean(filters.q || filters.stage || filters.territory || filters.specialty);

  return (
    <div className="space-y-4 pb-20 md:pb-0">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <ExportCsvButton
            ctx={ctx}
            kind="customers"
            filters={{ q: filters.q, stage: filters.stage, territory: filters.territory, specialty: filters.specialty }}
            label={t("export")}
          />
          {can(ctx, "crm.customer.create") ? (
            // Bottom of the screen on phones (thumb reach), inline from `sm` up.
            <div className="fixed inset-x-0 bottom-0 z-10 border-t bg-card/95 p-3 backdrop-blur sm:static sm:border-0 sm:bg-transparent sm:p-0">
              <Link href="/customers/new" className={buttonVariants({ className: "w-full sm:w-auto" })}>
                {t("new")}
              </Link>
            </div>
          ) : null}
        </div>
      </div>

      <CustomerFilters params={filters} territories={territoryOptions} specialties={specialtyOptions} />

      {!page.ok ? (
        <Alert>{tErrors(page.error.messageKey, { requestId: page.error.requestId ?? "—" })}</Alert>
      ) : page.data.rows.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          {filtered ? t("emptyFiltered") : t("empty")}
        </p>
      ) : (
        <>
          <CustomerList rows={page.data.rows} locale={locale} governorates={governorateNames} specialties={specialtyNames} />
          <Pagination params={filters} total={page.data.total} totalPages={totalPages(page.data.total)} />
        </>
      )}
    </div>
  );
}
