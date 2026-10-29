import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { WarehouseKindBadge } from "@/modules/inventory/components/badges";
import { FilterBar } from "@/modules/inventory/components/filter-bar";
import { InventoryError } from "@/modules/inventory/components/inventory-error";
import { CAIRO_DATE_TIME, QTY } from "@/modules/inventory/format";
import { canReadReceipts, isReceiptStatus, parseStockFilters, receiptStatusTone, type SearchParams } from "@/modules/inventory/logic";
import { listReceipts, listWarehouses } from "@/modules/inventory/queries";
import { RECEIPT_STATUSES } from "@/modules/inventory/types";

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
  const tc = await getTranslations("inventory.common");
  const tStatus = await getTranslations("inventory.receiptStatus");
  const format = await getFormatter();

  const [receipts, warehouses] = await Promise.all([listReceipts({ status, warehouse }), listWarehouses()]);
  if (!receipts.ok) return <InventoryError code={receipts.error.code} messageKey={receipts.error.messageKey} requestId={receipts.error.requestId} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("intro")}</p>
        </div>
        {can(ctx, "inventory.receipt.post") ? (
          <Link href="/inventory/receipts/new" className={buttonVariants()}>
            {t("new")}
          </Link>
        ) : null}
      </div>

      <FilterBar
        fields={[
          {
            kind: "select",
            name: "status",
            label: tc("status"),
            value: status,
            allLabel: tc("allStatuses"),
            options: RECEIPT_STATUSES.map((s) => ({ value: s, label: tStatus(s) })),
          },
          {
            kind: "select",
            name: "warehouse",
            label: tc("warehouse"),
            value: warehouse,
            allLabel: tc("allWarehouses"),
            options: (warehouses.ok ? warehouses.data : []).map((w) => ({ value: w.id, label: `${w.code} · ${w.name}` })),
          },
        ]}
        applyLabel={tc("apply")}
        resetLabel={tc("reset")}
        resetHref="/inventory/receipts"
      />

      {receipts.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="space-y-2">
          {receipts.data.map((r) => (
            <li key={r.id}>
              <Link href={`/inventory/receipts/${r.id}`} className="block min-h-11 rounded-lg border bg-card p-3 hover:bg-muted">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium" dir="ltr">
                    {r.receipt_no}
                  </span>
                  <Badge tone={receiptStatusTone(r.status)}>{tStatus(r.status)}</Badge>
                </div>
                <p className="text-sm">{r.supplier}</p>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>{r.warehouse_code}</span>
                  <WarehouseKindBadge kind={r.warehouse_kind} />
                  <span>{t("lines", { lines: r.line_count, units: format.number(r.total_quantity, QTY) })}</span>
                  <span>{format.dateTime(new Date(r.posted_at ?? r.received_at), CAIRO_DATE_TIME)}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
