import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { PlusIcon } from "lucide-react";
import { Forbidden } from "@/components/forbidden";
import { buttonVariants } from "@/components/ui/button";
import { readTableParams } from "@/components/ui/data-table-params";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { CustomerTable } from "@/modules/crm/components/customer-table";
import { CUSTOMER_SORTS, localizedName, PAGE_SIZE } from "@/modules/crm/logic";
import { listAssignableEmployees, listCustomers, listGovernorates, listSpecialties, listTerritories } from "@/modules/crm/queries";
import { customerListParamsSchema, firstValues } from "@/modules/crm/schemas";
import { ExportCsvButton } from "@/modules/reports/components/export-csv-button";

type Props = { params: Promise<{ locale: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ params }: Pick<Props, "params">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "crm.list" });
  return { title: t("title") };
}

/**
 * Customers list (api.v_customer_list): server-side search, sort, filters and pages, all in
 * the URL. RLS decides which customers exist; the filters only narrow that set.
 */
export default async function CustomersPage({ params, searchParams }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!can(ctx, "crm.customer.read")) return <Forbidden />;

  const t = await getTranslations("crm.list");
  const tErrors = await getTranslations("errors");
  const sp = await searchParams;
  const filters = customerListParamsSchema.parse(firstValues(sp));
  const table = readTableParams(sp, { pageSize: PAGE_SIZE, sortable: CUSTOMER_SORTS, defaultSort: { id: "display_name", desc: false } });
  const sortParam = table.sorting[0] ? `${table.sorting[0].desc ? "-" : ""}${table.sorting[0].id}` : undefined;
  const mayCreate = can(ctx, "crm.customer.create");

  const [page, territories, specialties, governorates, employees] = await Promise.all([
    listCustomers(filters, table.sorting),
    listTerritories(),
    listSpecialties(),
    listGovernorates(),
    listAssignableEmployees(),
  ]);

  const territoryOptions = territories.ok
    ? territories.data.map((tr) => ({ value: tr.id, label: localizedName(locale, tr.name_en, tr.name_ar) }))
    : [];
  const specialtyOptions = specialties.ok ? specialties.data.map((s) => ({ value: s.code, label: localizedName(locale, s.name_en, s.name_ar) })) : [];
  const repOptions = employees.ok
    ? employees.data.map((e) => ({ value: e.id, label: localizedName(locale, e.full_name_en, e.full_name_ar) }))
    : [];
  const governorateNames = Object.fromEntries(governorates.ok ? governorates.data.map((g) => [g.code, localizedName(locale, g.name_en, g.name_ar)]) : []);

  const newButton = mayCreate ? (
    <Link href="/customers/new" className={buttonVariants({ className: "w-full sm:w-auto" })}>
      <PlusIcon aria-hidden="true" />
      {t("new")}
    </Link>
  ) : null;

  return (
    <div className="space-y-4 pb-20 md:pb-0">
      <PageHeader
        title={t("title")}
        description={t("intro")}
        actions={
          <>
            <ExportCsvButton
              ctx={ctx}
              kind="customers"
              filters={{ q: filters.q, stage: filters.stage, territory: filters.territory, specialty: filters.specialty }}
              label={t("export")}
            />
            {/* Bottom of the screen on phones (thumb reach), inline from `sm` up. */}
            {newButton ? (
              <div className="fixed inset-x-0 bottom-0 z-10 border-t bg-card/95 p-3 backdrop-blur sm:static sm:border-0 sm:bg-transparent sm:p-0">
                {newButton}
              </div>
            ) : null}
          </>
        }
      />

      <CustomerTable
        rows={page.ok ? page.data.rows : []}
        total={page.ok ? page.data.total : 0}
        params={{ ...filters, sort: sortParam }}
        locale={locale}
        territories={territoryOptions}
        specialties={specialtyOptions}
        reps={repOptions}
        governorates={governorateNames}
        error={
          page.ok ? undefined : (
            <EmptyState tone="danger" title={t("errorTitle")} description={tErrors(page.error.messageKey, { requestId: page.error.requestId ?? "—" })} />
          )
        }
      />
    </div>
  );
}
