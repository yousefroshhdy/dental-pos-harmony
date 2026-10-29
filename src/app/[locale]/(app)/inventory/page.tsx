import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { buttonVariants } from "@/components/ui/button";
import { Badge, Card, CardTitle, Table, Td, Th } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { cn } from "@/lib/utils";
import { ExpiryBadge, WarehouseKindBadge } from "@/modules/inventory/components/badges";
import { FilterBar } from "@/modules/inventory/components/filter-bar";
import { InventoryError } from "@/modules/inventory/components/inventory-error";
import { QTY } from "@/modules/inventory/format";
import {
  brandOptions,
  canReadReceipts,
  canReadTransfers,
  parseStockFilters,
  productOptions,
  STOCK_ALERTS,
  stockOverview,
  summarizeStock,
  toQuery,
  variantIdsFor,
  type SearchParams,
} from "@/modules/inventory/logic";
import { listAvailable, listReorderAlerts, listStock, listVariants, listWarehouses, STOCK_LIMIT } from "@/modules/inventory/queries";

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

  const filters = parseStockFilters(await searchParams);
  const t = await getTranslations("inventory.stock");
  const tc = await getTranslations("inventory.common");
  const format = await getFormatter();
  // Inventory roles see lots, expiry and quarantine/transit stock; everyone else sellable availability only.
  const full = can(ctx, "inventory.module.access");

  const [warehouses, variants] = await Promise.all([listWarehouses(), listVariants()]);
  if (!warehouses.ok) return <InventoryError code={warehouses.error.code} messageKey={warehouses.error.messageKey} requestId={warehouses.error.requestId} />;
  const variantRows = variants.ok ? variants.data : [];

  const filterFields = [
    {
      kind: "select" as const,
      name: "warehouse",
      label: tc("warehouse"),
      value: filters.warehouse,
      allLabel: tc("allWarehouses"),
      options: warehouses.data
        .filter((w) => full || w.is_sellable)
        .map((w) => ({ value: w.id, label: `${w.code} · ${w.name}` })),
    },
    { kind: "select" as const, name: "brand", label: tc("brand"), value: filters.brand, allLabel: tc("allBrands"), options: brandOptions(variantRows) },
    {
      kind: "select" as const,
      name: "product",
      label: tc("product"),
      value: filters.product,
      allLabel: tc("allProducts"),
      options: productOptions(variantRows, locale, filters.brand),
    },
    ...(full
      ? [
          {
            kind: "select" as const,
            name: "alert",
            label: t("alertFilter"),
            value: filters.alert === "all" ? undefined : filters.alert,
            allLabel: t("alerts.all"),
            options: STOCK_ALERTS.filter((a) => a !== "all").map((a) => ({ value: a, label: t(`alerts.${a}`) })),
          },
        ]
      : []),
  ];

  const header = (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{full ? t("introFull") : t("introSellable")}</p>
      </div>
      <div className="flex flex-wrap gap-2">
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
      </div>
    </div>
  );

  const filterBar = (
    <FilterBar fields={filterFields} applyLabel={tc("apply")} resetLabel={tc("reset")} resetHref="/inventory" />
  );

  // -------------------------------------------------------------------------
  // Sellable availability only (sales roles)
  // -------------------------------------------------------------------------
  if (!full) {
    const variantIds = filters.brand || filters.product ? variantIdsFor(variantRows, filters) : undefined;
    const rows = variantIds && variantIds.length === 0 ? { ok: true as const, data: [] } : await listAvailable({ warehouse: filters.warehouse, variantIds });
    return (
      <div className="space-y-4">
        {header}
        {filterBar}
        {!rows.ok ? (
          <InventoryError code={rows.error.code} messageKey={rows.error.messageKey} requestId={rows.error.requestId} />
        ) : rows.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {rows.data.map((r) => (
              <li key={`${r.warehouse_id}:${r.variant_id}`} className="flex items-center justify-between gap-3 rounded-lg border bg-card p-3">
                <div className="min-w-0">
                  <p className="truncate font-medium">{r.product_name}</p>
                  <p className="truncate text-sm text-muted-foreground">
                    <span dir="ltr">{r.sku}</span> · {r.variant_name}
                  </p>
                  <p className="text-xs text-muted-foreground">{r.warehouse_code}</p>
                </div>
                <div className="text-end">
                  <p className={cn("text-xl font-semibold", r.available === 0 && "text-destructive")}>{format.number(r.available, QTY)}</p>
                  <p className="text-xs text-muted-foreground">{tc("available")}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Inventory roles: full picture with alerts
  // -------------------------------------------------------------------------
  const [stock, alerts] = await Promise.all([listStock(filters), listReorderAlerts(filters)]);
  if (!stock.ok) return <InventoryError code={stock.error.code} messageKey={stock.error.messageKey} requestId={stock.error.requestId} />;
  const alertRows = alerts.ok ? alerts.data : [];
  const summary = summarizeStock(stock.data, alertRows);
  const rows = stockOverview(stock.data, alertRows, filters.alert);
  const alertLink = (alert: string) =>
    `/inventory${toQuery({ warehouse: filters.warehouse, brand: filters.brand, product: filters.product, alert })}`;

  return (
    <div className="space-y-4">
      {header}

      <section aria-label={t("summaryLabel")} className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <SummaryTile href={alertLink("below_reorder")} label={t("alerts.below_reorder")} value={format.number(summary.belowReorder, QTY)} alert={summary.belowReorder > 0} />
        <SummaryTile href={alertLink("near_expiry")} label={t("summaryNearExpiry")} value={format.number(summary.nearExpiryLines, QTY)} alert={summary.nearExpiryLines > 0} />
        <SummaryTile href={alertLink("expired")} label={t("summaryExpired")} value={format.number(summary.expiredQty, QTY)} alert={summary.expiredQty > 0} />
        <SummaryTile href={alertLink("not_sellable")} label={t("summaryNotSellable")} value={format.number(summary.notSellableQty, QTY)} />
      </section>

      {filterBar}

      {!alerts.ok ? <p className="text-sm text-muted-foreground">{t("alertsUnavailable")}</p> : null}

      {alertRows.length > 0 && (filters.alert === "all" || filters.alert === "below_reorder") ? (
        <Card className="space-y-3 border-warning/60">
          <CardTitle>{t("reorderTitle")}</CardTitle>
          <p className="text-sm text-muted-foreground">{t("reorderHint")}</p>
          <ul className="divide-y">
            {alertRows.map((a) => (
              <li key={a.variant_id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <Link href={`/inventory/stock/${a.variant_id}`} className="min-h-11 min-w-0 flex-1 py-1 hover:underline">
                  <span className="block truncate font-medium">{a.product_name}</span>
                  <span className="block truncate text-sm text-muted-foreground">
                    <span dir="ltr">{a.sku}</span> · {a.brand_name}
                  </span>
                </Link>
                <span className="flex flex-wrap items-center gap-1 text-sm">
                  <Badge tone={a.sellable_available === 0 ? "danger" : "warning"}>
                    {t("reorderState", { available: a.sellable_available, point: a.reorder_point })}
                  </Badge>
                  <Badge tone="neutral">{t("shortfall", { n: a.shortfall })}</Badge>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{filters.alert === "all" ? t("empty") : t("emptyAlert")}</p>
      ) : (
        <>
          {/* Phones: one card per warehouse × SKU */}
          <ul className="space-y-2 md:hidden">
            {rows.map(({ row, flags }) => (
              <li
                key={`${row.warehouse_id}:${row.variant_id}`}
                className={cn(
                  "rounded-lg border bg-card p-3",
                  (flags.belowReorder || flags.expired) && "border-destructive/50",
                  !flags.belowReorder && !flags.expired && flags.nearExpiry && "border-warning/60",
                  flags.notSellable && "bg-muted/40",
                )}
              >
                <Link href={`/inventory/stock/${row.variant_id}${toQuery({ warehouse: row.warehouse_id })}`} className="block min-h-11 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{row.product_name}</p>
                      <p className="truncate text-sm text-muted-foreground">
                        <span dir="ltr">{row.sku}</span> · {row.brand_name}
                      </p>
                    </div>
                    <div className="text-end">
                      <p className="text-xl font-semibold">{format.number(row.sellable_available, QTY)}</p>
                      <p className="text-xs text-muted-foreground">{tc("sellable")}</p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1 text-xs">
                    <span className="font-medium">{row.warehouse_code}</span>
                    <WarehouseKindBadge kind={row.warehouse_kind} sellable={row.is_sellable} />
                    <RowFlags flags={flags} />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t("cardTotals", { onHand: row.on_hand, reserved: row.reserved, available: row.available })}
                  </p>
                  {row.earliest_expiry ? (
                    <p className="text-xs">
                      {t("earliestExpiry")}: <ExpiryBadge date={row.earliest_expiry} days={row.days_to_earliest_expiry} />
                    </p>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>

          {/* Wider screens: table */}
          <div className="hidden md:block">
            <Table>
              <thead>
                <tr>
                  <Th>{tc("product")}</Th>
                  <Th>{tc("warehouse")}</Th>
                  <Th className="text-end">{tc("onHand")}</Th>
                  <Th className="text-end">{tc("reserved")}</Th>
                  <Th className="text-end">{tc("available")}</Th>
                  <Th className="text-end">{tc("sellable")}</Th>
                  <Th>{t("earliestExpiry")}</Th>
                  <Th>{t("flags")}</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ row, flags }) => (
                  <tr
                    key={`${row.warehouse_id}:${row.variant_id}`}
                    className={cn(
                      (flags.belowReorder || flags.expired) && "bg-destructive/5",
                      !flags.belowReorder && !flags.expired && flags.nearExpiry && "bg-warning/10",
                      flags.notSellable && "text-muted-foreground",
                    )}
                  >
                    <Td className="min-w-48">
                      <Link
                        href={`/inventory/stock/${row.variant_id}${toQuery({ warehouse: row.warehouse_id })}`}
                        className="inline-flex min-h-11 flex-col justify-center text-primary underline-offset-4 hover:underline"
                      >
                        <span>{row.product_name}</span>
                        <span className="text-xs text-muted-foreground">
                          <span dir="ltr">{row.sku}</span> · {row.brand_name}
                        </span>
                      </Link>
                    </Td>
                    <Td className="min-w-40">
                      <span className="block">{row.warehouse_code}</span>
                      <WarehouseKindBadge kind={row.warehouse_kind} sellable={row.is_sellable} />
                    </Td>
                    <Td className="text-end tabular-nums">{format.number(row.on_hand, QTY)}</Td>
                    <Td className="text-end tabular-nums">{format.number(row.reserved, QTY)}</Td>
                    <Td className="text-end tabular-nums">{format.number(row.available, QTY)}</Td>
                    <Td className="text-end font-semibold tabular-nums">{format.number(row.sellable_available, QTY)}</Td>
                    <Td>
                      <ExpiryBadge date={row.earliest_expiry} days={row.days_to_earliest_expiry} />
                    </Td>
                    <Td>
                      <RowFlags flags={flags} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
          {stock.data.length >= STOCK_LIMIT ? <p className="text-sm text-muted-foreground">{t("truncated", { n: STOCK_LIMIT })}</p> : null}
        </>
      )}
    </div>
  );
}

function SummaryTile({ href, label, value, alert = false }: { href: string; label: string; value: string; alert?: boolean }) {
  return (
    <Link href={href} className={cn("flex min-h-11 flex-col rounded-lg border bg-card p-3 hover:bg-muted", alert && "border-destructive/50")}>
      <span className={cn("text-2xl font-semibold", alert && "text-destructive")}>{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </Link>
  );
}

async function RowFlags({ flags }: { flags: { belowReorder: boolean; nearExpiry: boolean; expired: boolean } }) {
  const t = await getTranslations("inventory.stock.alerts");
  return (
    <span className="inline-flex flex-wrap gap-1">
      {flags.belowReorder ? <Badge tone="danger">{t("below_reorder")}</Badge> : null}
      {flags.expired ? <Badge tone="danger">{t("expired")}</Badge> : null}
      {flags.nearExpiry ? <Badge tone="warning">{t("near_expiry")}</Badge> : null}
    </span>
  );
}
