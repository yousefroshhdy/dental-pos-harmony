import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { Alert, Card } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { WarehouseKindBadge } from "@/modules/inventory/components/badges";
import { AdjustmentForm } from "@/modules/inventory/components/adjustment-form";
import { FilterBar } from "@/modules/inventory/components/filter-bar";
import { InventoryError } from "@/modules/inventory/components/inventory-error";
import { CALENDAR_DATE, calendarDate } from "@/modules/inventory/format";
import { adjustmentLimit, lotsFefo, parseStockFilters, stockLineValue, type SearchParams } from "@/modules/inventory/logic";
import { listStockDetail, listWarehouses } from "@/modules/inventory/queries";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "inventory.adjustmentForm" });
  return { title: t("title") };
}

/**
 * Stock adjustment request. Outcome: posted at once within the user's
 * cumulative daily limit, otherwise pending approval (audit finding #3).
 */
export default async function NewAdjustmentPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<SearchParams> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!can(ctx, "inventory.adjustment.post")) return <Forbidden />;

  const sp = await searchParams;
  const { warehouse: warehouseParam } = parseStockFilters(sp);
  const lineParam = typeof sp.line === "string" ? sp.line : undefined;
  const t = await getTranslations("inventory.adjustmentForm");
  const tc = await getTranslations("inventory.common");
  const tExpiry = await getTranslations("inventory.expiry");
  const format = await getFormatter();
  const limit = adjustmentLimit(ctx);

  const warehouses = await listWarehouses();
  if (!warehouses.ok) return <InventoryError code={warehouses.error.code} messageKey={warehouses.error.messageKey} requestId={warehouses.error.requestId} />;
  const warehouse = warehouses.data.find((w) => w.id === warehouseParam);
  const stock = warehouse ? await listStockDetail({ warehouse: warehouse.id }) : null;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Link href="/inventory" className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline">
        {t("back")}
      </Link>
      <div>
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("intro")}</p>
      </div>
      <Alert tone="info" role="note">
        {limit === null ? t("limitNone") : t("limit", { n: limit ?? 0 })}
      </Alert>

      <FilterBar
        fields={[
          {
            kind: "select",
            name: "warehouse",
            label: tc("warehouse"),
            value: warehouse?.id,
            allLabel: t("selectWarehouse"),
            options: warehouses.data.map((w) => ({ value: w.id, label: `${w.code} · ${w.name}` })),
          },
        ]}
        applyLabel={t("chooseWarehouse")}
        resetLabel={tc("reset")}
        resetHref="/inventory/adjustments/new"
      />

      {!warehouse ? (
        <p className="text-sm text-muted-foreground">{t("pickWarehouseFirst")}</p>
      ) : stock && !stock.ok ? (
        <InventoryError code={stock.error.code} messageKey={stock.error.messageKey} requestId={stock.error.requestId} />
      ) : (
        <Card className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">
              {warehouse.code} · {warehouse.name}
            </span>
            <WarehouseKindBadge kind={warehouse.kind} sellable={warehouse.is_sellable} />
          </div>
          {stock?.ok && stock.data.length === 0 ? <p className="text-sm text-muted-foreground">{t("noLots")}</p> : null}
          <AdjustmentForm
            key={warehouse.id}
            locale={locale}
            warehouseId={warehouse.id}
            initialKey={randomUUID()}
            defaultLine={lineParam}
            // Empty lots stay listed: a count correction may add stock back to a lot at zero.
            lines={lotsFefo(stock?.ok ? stock.data : [], { keepEmpty: true }).map((r) => ({
              value: stockLineValue(r.variant_id, r.lot_id),
              label: [r.sku, r.lot_no, r.expiry_date ? format.dateTime(calendarDate(r.expiry_date), CALENDAR_DATE) : tExpiry("none")].join(" · "),
              available: r.available,
              onHand: r.on_hand,
            }))}
          />
        </Card>
      )}
    </div>
  );
}
