import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { buttonVariants } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Badge, Card, CardTitle } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { cn } from "@/lib/utils";
import { InventoryError } from "@/modules/inventory/components/inventory-error";
import { AvailableTable, StockTable } from "@/modules/inventory/components/inventory-tables";
import { AVAILABLE_LIST, STOCK_LIST } from "@/modules/inventory/lists";
import { QTY } from "@/modules/inventory/format";
import {
  brandOptions,
  canReadReceipts,
  canReadTransfers,
  parseStockFilters,
  productOptions,
  stockRowFlags,
  summarizeStock,
  toQuery,
  variantIdsFor,
  type SearchParams,
} from "@/modules/inventory/logic";
import { listAvailablePage, listReorderAlerts, listStock, listStockPage, listVariants, listWarehouses } from "@/modules/inventory/queries";
import { pageRequest } from "@/modules/orders/kit/paging";
import { ExportCsvButton } from "@/modules/reports/components/export-csv-button";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "inventory.stock" });
  return { title: t("title") };
}

export default async function StockPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<SearchParams> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!can(ctx, "inventory.stock.read")) return <Forbidden />;

  const sp = await searchParams;
  const filters = parseStockFilters(sp);
  const t = await getTranslations("inventory.stock");
  const format = await getFormatter();
  // Inventory roles see lots, expiry and quarantine/transit stock; everyone else sellable availability only.
  const full = can(ctx, "inventory.module.access");

  const [warehouses, variants] = await Promise.all([listWarehouses(), listVariants()]);
  if (!warehouses.ok) return <InventoryError code={warehouses.error.code} messageKey={warehouses.error.messageKey} requestId={warehouses.error.requestId} />;
  const variantRows = variants.ok ? variants.data : [];

  const filterProps = {
    warehouses: warehouses.data.filter((w) => full || w.is_sellable).map((w) => ({ value: w.id, label: `${w.code} · ${w.name}` })),
    brands: brandOptions(variantRows),
    products: productOptions(variantRows, locale, filters.brand).map((o) => ({ value: o.value, label: o.label })),
    values: { warehouse: filters.warehouse, brand: filters.brand, product: filters.product },
  };

  const header = (
    <PageHeader
      title={t("title")}
      description={full ? t("introFull") : t("introSellable")}
      actions={
        <>
          {can(ctx, "inventory.receipt.post") ? (
            <Link href="/inventory/receipts/new" className={buttonVariants({ variant: "outline" })}>
              {t("newReceipt")}
            </Link>
          ) : null}
          {can(ctx, "inventory.transfer.create") ? (
            <Link href="/inventory/transfers/new" className={buttonVariants({ variant: "outline" })}>
              {t("newTransfer")}
            </Link>
          ) : null}
          {can(ctx, "inventory.adjustment.post") ? (
            <Link href="/inventory/adjustments/new" className={buttonVariants({ variant: "outline" })}>
              {t("newAdjustment")}
            </Link>
          ) : null}
          {!can(ctx, "inventory.receipt.post") && canReadReceipts(ctx) ? (
            <Link href="/inventory/receipts" className={buttonVariants({ variant: "ghost" })}>
              {t("receipts")}
            </Link>
          ) : null}
          {!can(ctx, "inventory.transfer.create") && canReadTransfers(ctx) ? (
            <Link href="/inventory/transfers" className={buttonVariants({ variant: "ghost" })}>
              {t("transfers")}
            </Link>
          ) : null}
          {/* The stock alert view is page-only; the file takes the warehouse, brand and product filters. */}
          <ExportCsvButton ctx={ctx} kind="stock" filters={{ warehouse: filters.warehouse, brand: filters.brand, product: filters.product }} label={t("export")} />
        </>
      }
    />
  );

  // -------------------------------------------------------------------------
  // Sellable availability only (sales roles)
  // -------------------------------------------------------------------------
  if (!full) {
    const variantIds = filters.brand || filters.product ? variantIdsFor(variantRows, filters) : undefined;
    const rows = await listAvailablePage({ warehouse: filters.warehouse, variantIds }, pageRequest(sp, AVAILABLE_LIST));
    return (
      <div className="space-y-4">
        {header}
        <AvailableTable
          rows={rows.ok ? rows.data.rows : []}
          total={rows.ok ? rows.data.total : 0}
          filters={filterProps}
          error={rows.ok ? undefined : <InventoryError code={rows.error.code} messageKey={rows.error.messageKey} requestId={rows.error.requestId} />}
        />
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Inventory roles: full picture with alerts
  // -------------------------------------------------------------------------
  // The alert tiles summarise the filtered stock (capped read, as before); the table pages in the database.
  const [summaryRows, alerts] = await Promise.all([listStock(filters), listReorderAlerts(filters)]);
  const alertRows = alerts.ok ? alerts.data : [];
  const below = new Set(alertRows.map((a) => a.variant_id));
  const page = await listStockPage(filters, [...below], pageRequest(sp, STOCK_LIST));
  const summary = summaryRows.ok ? summarizeStock(summaryRows.data, alertRows) : null;
  const alertLink = (alert: string) => `/inventory${toQuery({ warehouse: filters.warehouse, brand: filters.brand, product: filters.product, alert })}`;

  return (
    <div className="space-y-4">
      {header}

      {summary ? (
        <section aria-label={t("summaryLabel")} className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <SummaryTile href={alertLink("below_reorder")} label={t("alerts.below_reorder")} value={format.number(summary.belowReorder, QTY)} alert={summary.belowReorder > 0} active={filters.alert === "below_reorder"} />
          <SummaryTile href={alertLink("near_expiry")} label={t("summaryNearExpiry")} value={format.number(summary.nearExpiryLines, QTY)} alert={summary.nearExpiryLines > 0} active={filters.alert === "near_expiry"} />
          <SummaryTile href={alertLink("expired")} label={t("summaryExpired")} value={format.number(summary.expiredQty, QTY)} alert={summary.expiredQty > 0} active={filters.alert === "expired"} />
          <SummaryTile href={alertLink("not_sellable")} label={t("summaryNotSellable")} value={format.number(summary.notSellableQty, QTY)} active={filters.alert === "not_sellable"} />
        </section>
      ) : null}

      {!alerts.ok ? <p className="text-sm text-muted-foreground">{t("alertsUnavailable")}</p> : null}

      {alertRows.length > 0 && (filters.alert === "all" || filters.alert === "below_reorder") ? (
        <Card className="space-y-3 border-warning/60">
          <CardTitle className="text-base">{t("reorderTitle")}</CardTitle>
          <p className="text-sm text-muted-foreground">{t("reorderHint")}</p>
          <ul className="grid gap-2 sm:grid-cols-2">
            {alertRows.map((a) => (
              <li key={a.variant_id}>
                <Link href={`/inventory/stock/${a.variant_id}`} className="flex min-h-11 items-center justify-between gap-2 rounded-md border bg-card p-2 hover:bg-muted">
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{a.product_name}</span>
                    <span className="block truncate text-sm text-muted-foreground">
                      <span dir="ltr">{a.sku}</span> · {a.brand_name}
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1 text-sm">
                    <Badge tone={a.sellable_available === 0 ? "danger" : "warning"}>{t("reorderState", { available: a.sellable_available, point: a.reorder_point })}</Badge>
                    <Badge tone="neutral">{t("shortfall", { n: a.shortfall })}</Badge>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <StockTable
        rows={page.ok ? page.data.rows.map((row) => ({ row, flags: stockRowFlags(row, below) })) : []}
        total={page.ok ? page.data.total : 0}
        alert={filters.alert}
        filters={filterProps}
        error={page.ok ? undefined : <InventoryError code={page.error.code} messageKey={page.error.messageKey} requestId={page.error.requestId} />}
      />
    </div>
  );
}

function SummaryTile({ href, label, value, alert = false, active = false }: { href: string; label: string; value: string; alert?: boolean; active?: boolean }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn("flex min-h-11 flex-col rounded-lg border bg-card p-3 hover:bg-muted", alert && "border-destructive/50", active && "ring-2 ring-ring")}
    >
      <span className={cn("text-2xl font-semibold tabular-nums", alert && "text-destructive")}>{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </Link>
  );
}
