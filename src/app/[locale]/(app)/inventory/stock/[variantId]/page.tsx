import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { z } from "zod";
import { Forbidden } from "@/components/forbidden";
import { buttonVariants } from "@/components/ui/button";
import { Badge, Card, Table, Td, Th } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { cn } from "@/lib/utils";
import { ExpiryBadge, WarehouseKindBadge } from "@/modules/inventory/components/badges";
import { FilterBar } from "@/modules/inventory/components/filter-bar";
import { InventoryError } from "@/modules/inventory/components/inventory-error";
import { QTY } from "@/modules/inventory/format";
import { expiryStatus, localizedName, lotsFefo, parseStockFilters, stockLineValue, toQuery, type SearchParams } from "@/modules/inventory/logic";
import { getVariant, listStockDetail, listWarehouses } from "@/modules/inventory/queries";

type Params = Promise<{ locale: string; variantId: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "inventory.detail" });
  return { title: t("metaTitle") };
}

/** Lot-level drill-down for one SKU: lots and expiry per warehouse, FEFO order. */
export default async function StockDetailPage({ params, searchParams }: { params: Params; searchParams: Promise<SearchParams> }) {
  const { locale, variantId } = await params;
  setRequestLocale(locale);
  if (!z.guid().safeParse(variantId).success) notFound();

  const ctx = await getUserContext();
  if (!can(ctx, "inventory.module.access") || !can(ctx, "inventory.stock.read")) return <Forbidden />;

  const { warehouse } = parseStockFilters(await searchParams);
  const t = await getTranslations("inventory.detail");
  const tc = await getTranslations("inventory.common");
  const format = await getFormatter();

  const [variant, lots, warehouses] = await Promise.all([getVariant(variantId), listStockDetail({ variant: variantId, warehouse }), listWarehouses()]);
  if (!variant.ok) return <InventoryError code={variant.error.code} messageKey={variant.error.messageKey} requestId={variant.error.requestId} />;
  if (!variant.data) notFound();
  if (!lots.ok) return <InventoryError code={lots.error.code} messageKey={lots.error.messageKey} requestId={lots.error.requestId} />;

  const v = variant.data;
  const whById = new Map((warehouses.ok ? warehouses.data : []).map((w) => [w.id, w]));
  const rows = lotsFefo(lots.data);
  const totals = rows.reduce(
    (acc, r) => {
      const sellable = whById.get(r.warehouse_id)?.is_sellable ?? false;
      acc.onHand += r.on_hand;
      if (sellable && expiryStatus(r.days_to_expiry) !== "expired") acc.sellable += Math.max(r.available, 0);
      return acc;
    },
    { onHand: 0, sellable: 0 },
  );
  const mayAdjust = can(ctx, "inventory.adjustment.post");
  const mayTransfer = can(ctx, "inventory.transfer.create");

  return (
    <div className="space-y-4">
      <Link href="/inventory" className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline">
        {t("back")}
      </Link>
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">{localizedName(locale, v.product_name, v.product_name_ar)}</h1>
        <p className="text-sm text-muted-foreground">
          <span dir="ltr">{v.sku}</span> · {v.variant_name} · {v.brand_name}
        </p>
        <div className="flex flex-wrap gap-1">
          {v.is_lot_tracked ? <Badge>{t("lotTracked")}</Badge> : null}
          {v.is_expiry_tracked ? <Badge>{t("expiryTracked")}</Badge> : null}
          {v.reorder_point > 0 ? <Badge tone={totals.sellable <= v.reorder_point ? "danger" : "neutral"}>{t("reorderPoint", { n: v.reorder_point })}</Badge> : null}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Card className="p-3 sm:p-3">
          <p className="text-2xl font-semibold">{format.number(totals.onHand, QTY)}</p>
          <p className="text-xs text-muted-foreground">{tc("onHand")}</p>
        </Card>
        <Card className="p-3 sm:p-3">
          <p className="text-2xl font-semibold">{format.number(totals.sellable, QTY)}</p>
          <p className="text-xs text-muted-foreground">{tc("sellable")}</p>
        </Card>
      </div>

      <FilterBar
        fields={[
          {
            kind: "select",
            name: "warehouse",
            label: tc("warehouse"),
            value: warehouse,
            allLabel: tc("allWarehouses"),
            options: [...whById.values()].map((w) => ({ value: w.id, label: `${w.code} · ${w.name}` })),
          },
        ]}
        applyLabel={tc("apply")}
        resetLabel={tc("reset")}
        resetHref={`/inventory/stock/${variantId}`}
      />

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>{tc("warehouse")}</Th>
              <Th>{tc("lot")}</Th>
              <Th>{tc("expiry")}</Th>
              <Th className="text-end">{tc("onHand")}</Th>
              <Th className="text-end">{tc("reserved")}</Th>
              <Th className="text-end">{tc("available")}</Th>
              {mayAdjust || mayTransfer ? <Th>{tc("actions")}</Th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const wh = whById.get(r.warehouse_id);
              const status = expiryStatus(r.days_to_expiry);
              return (
                <tr
                  key={`${r.warehouse_id}:${r.lot_id}`}
                  className={cn(
                    (status === "expired" || status === "critical") && "bg-destructive/5",
                    status === "near" && "bg-warning/10",
                    wh && !wh.is_sellable && "text-muted-foreground",
                  )}
                >
                  <Td className="min-w-36">
                    <span className="block">{r.warehouse_code}</span>
                    <WarehouseKindBadge kind={wh?.kind ?? null} sellable={wh?.is_sellable} />
                  </Td>
                  <Td>
                    <span dir="ltr">{r.lot_no}</span>
                  </Td>
                  <Td>
                    <ExpiryBadge date={r.expiry_date} days={r.days_to_expiry} />
                  </Td>
                  <Td className="text-end tabular-nums">{format.number(r.on_hand, QTY)}</Td>
                  <Td className="text-end tabular-nums">{format.number(r.reserved, QTY)}</Td>
                  <Td className="text-end tabular-nums">{format.number(r.available, QTY)}</Td>
                  {mayAdjust || mayTransfer ? (
                    <Td>
                      <div className="flex flex-col items-start gap-1 sm:flex-row">
                        {mayAdjust ? (
                          <Link
                            href={`/inventory/adjustments/new${toQuery({ warehouse: r.warehouse_id, line: stockLineValue(r.variant_id, r.lot_id) })}`}
                            className={buttonVariants({ variant: "outline", size: "sm", className: "min-h-11" })}
                          >
                            {t("adjust")}
                          </Link>
                        ) : null}
                        {mayTransfer && r.available > 0 ? (
                          <Link
                            href={`/inventory/transfers/new${toQuery({ from: r.warehouse_id })}`}
                            className={buttonVariants({ variant: "outline", size: "sm", className: "min-h-11" })}
                          >
                            {t("transfer")}
                          </Link>
                        ) : null}
                      </div>
                    </Td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}

      {can(ctx, "inventory.movement.read") ? (
        <Link
          href={`/inventory/movements${toQuery({ variant: variantId, warehouse })}`}
          className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline"
        >
          {t("viewMovements")}
        </Link>
      ) : null}
    </div>
  );
}
