import type { Metadata } from "next";
import { PlusIcon } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { buttonVariants } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Alert } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { InventoryError } from "@/modules/inventory/components/inventory-error";
import { MovementsTable } from "@/modules/inventory/components/inventory-tables";
import { MOVEMENT_LIST } from "@/modules/inventory/lists";
import { parseMovementFilters, type SearchParams } from "@/modules/inventory/logic";
import { listMovementsPage, listVariants, listWarehouses } from "@/modules/inventory/queries";
import { pageRequest } from "@/modules/orders/kit/paging";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "inventory.adjustments" });
  return { title: t("title") };
}

/**
 * Stock adjustments: the ledger's movements whose source is an adjustment (count
 * corrections, damage, expiry write-offs, found stock). Read-only like the ledger;
 * a new adjustment is a new movement, posted through api.adjust_stock.
 */
export default async function AdjustmentsPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<SearchParams> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!can(ctx, "inventory.movement.read")) return <Forbidden />;

  const sp = await searchParams;
  const filters = { ...parseMovementFilters(sp), sourceType: "adjustment", sourceId: undefined };
  const t = await getTranslations("inventory.adjustments");

  const [movements, warehouses, variants] = await Promise.all([listMovementsPage(filters, pageRequest(sp, MOVEMENT_LIST)), listWarehouses(), listVariants()]);

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("title")}
        description={t("intro")}
        actions={
          can(ctx, "inventory.adjustment.post") ? (
            <Link href="/inventory/adjustments/new" className={buttonVariants()}>
              <PlusIcon aria-hidden="true" />
              {t("new")}
            </Link>
          ) : null
        }
      />
      <Alert tone="info" role="note">
        {t("appendOnly")}
      </Alert>
      <MovementsTable
        rows={movements.ok ? movements.data.rows : []}
        total={movements.ok ? movements.data.total : 0}
        warehouses={(warehouses.ok ? warehouses.data : []).map((w) => ({ value: w.id, label: `${w.code} · ${w.name}` }))}
        variants={(variants.ok ? variants.data : []).map((v) => ({ value: v.variant_id, label: v.sku, description: v.variant_name, keywords: [v.product_name] }))}
        values={{ warehouse: filters.warehouse, variant: filters.variant, type: filters.type, from: filters.from, to: filters.to }}
        lang={locale === "ar" ? "ar" : "en"}
        fixedSource
        error={movements.ok ? undefined : <InventoryError code={movements.error.code} messageKey={movements.error.messageKey} requestId={movements.error.requestId} />}
      />
    </div>
  );
}
