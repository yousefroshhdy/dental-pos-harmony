import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { PageHeader } from "@/components/ui/page-header";
import { Alert } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { InventoryError } from "@/modules/inventory/components/inventory-error";
import { MovementsTable } from "@/modules/inventory/components/inventory-tables";
import { MOVEMENT_LIST } from "@/modules/inventory/lists";
import { parseMovementFilters, shortId, toQuery, type SearchParams } from "@/modules/inventory/logic";
import { listMovementsPage, listVariants, listWarehouses } from "@/modules/inventory/queries";
import { pageRequest } from "@/modules/orders/kit/paging";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "inventory.movements" });
  return { title: t("title") };
}

/** The stock ledger, read-only. It is append-only: corrections are new (reversal) movements, never edits. */
export default async function MovementsPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<SearchParams> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!can(ctx, "inventory.movement.read")) return <Forbidden />;

  const sp = await searchParams;
  const filters = parseMovementFilters(sp);
  const t = await getTranslations("inventory.movements");
  const tSources = await getTranslations("inventory.sources");

  const [movements, warehouses, variants] = await Promise.all([listMovementsPage(filters, pageRequest(sp, MOVEMENT_LIST)), listWarehouses(), listVariants()]);
  const baseQuery = { warehouse: filters.warehouse, variant: filters.variant, type: filters.type, from: filters.from, to: filters.to };

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("title")}
        description={t("intro")}
        actions={
          <Link href="/inventory/adjustments" className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline">
            {t("adjustmentsLink")}
          </Link>
        }
      />
      <Alert tone="info" role="note">
        {t("appendOnly")}
      </Alert>

      {filters.sourceType && filters.sourceId ? (
        <p className="flex flex-wrap items-center gap-2 text-sm">
          {t("sourceFilter", { source: tSources(filters.sourceType), ref: shortId(filters.sourceId) })}
          <Link href={`/inventory/movements${toQuery(baseQuery)}`} className="inline-flex min-h-11 items-center text-primary underline-offset-4 hover:underline">
            {t("clearSource")}
          </Link>
        </p>
      ) : null}

      <MovementsTable
        rows={movements.ok ? movements.data.rows : []}
        total={movements.ok ? movements.data.total : 0}
        warehouses={(warehouses.ok ? warehouses.data : []).map((w) => ({ value: w.id, label: `${w.code} · ${w.name}` }))}
        variants={(variants.ok ? variants.data : []).map((v) => ({ value: v.variant_id, label: v.sku, description: v.variant_name, keywords: [v.product_name] }))}
        values={baseQuery}
        lang={locale === "ar" ? "ar" : "en"}
        error={movements.ok ? undefined : <InventoryError code={movements.error.code} messageKey={movements.error.messageKey} requestId={movements.error.requestId} />}
      />
    </div>
  );
}
