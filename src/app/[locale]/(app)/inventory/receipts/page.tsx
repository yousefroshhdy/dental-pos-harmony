import type { Metadata } from "next";
import { PlusIcon } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { buttonVariants } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { InventoryError } from "@/modules/inventory/components/inventory-error";
import { ReceiptsTable } from "@/modules/inventory/components/inventory-tables";
import { RECEIPT_LIST } from "@/modules/inventory/lists";
import { canReadReceipts, isReceiptStatus, parseStockFilters, type SearchParams } from "@/modules/inventory/logic";
import { listReceiptsPage, listWarehouses } from "@/modules/inventory/queries";
import { pageRequest } from "@/modules/orders/kit/paging";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "inventory.receipts" });
  return { title: t("title") };
}

export default async function ReceiptsPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<SearchParams> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!canReadReceipts(ctx)) return <Forbidden />;

  const sp = await searchParams;
  const rawStatus = typeof sp.status === "string" ? sp.status : "";
  const status = isReceiptStatus(rawStatus) ? rawStatus : undefined;
  const { warehouse } = parseStockFilters(sp);
  const t = await getTranslations("inventory.receipts");

  const [receipts, warehouses] = await Promise.all([listReceiptsPage({ status, warehouse }, pageRequest(sp, RECEIPT_LIST)), listWarehouses()]);
  const newReceipt = can(ctx, "inventory.receipt.post") ? (
    <Link href="/inventory/receipts/new" className={buttonVariants()}>
      <PlusIcon aria-hidden="true" />
      {t("new")}
    </Link>
  ) : null;

  return (
    <div className="space-y-4">
      <PageHeader title={t("title")} description={t("intro")} actions={newReceipt} />
      <ReceiptsTable
        rows={receipts.ok ? receipts.data.rows : []}
        total={receipts.ok ? receipts.data.total : 0}
        warehouses={(warehouses.ok ? warehouses.data : []).map((w) => ({ value: w.id, label: `${w.code} · ${w.name}` }))}
        values={{ status, warehouse }}
        emptyAction={newReceipt}
        error={receipts.ok ? undefined : <InventoryError code={receipts.error.code} messageKey={receipts.error.messageKey} requestId={receipts.error.requestId} />}
      />
    </div>
  );
}
