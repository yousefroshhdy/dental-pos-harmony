import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { z } from "zod";
import { Forbidden } from "@/components/forbidden";
import { Card } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { FilterBar } from "@/modules/inventory/components/filter-bar";
import { InventoryError } from "@/modules/inventory/components/inventory-error";
import { TransferForm } from "@/modules/inventory/components/transfer-form";
import { CALENDAR_DATE, calendarDate } from "@/modules/inventory/format";
import { lotsFefo, stockLineValue, type SearchParams } from "@/modules/inventory/logic";
import { listStockDetail, listWarehouses } from "@/modules/inventory/queries";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "inventory.transferForm" });
  return { title: t("title") };
}

/** Step 1: choose the source warehouse (GET). Step 2: destination and lots with available stock there. */
export default async function NewTransferPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<SearchParams> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!can(ctx, "inventory.transfer.create")) return <Forbidden />;

  const sp = await searchParams;
  const fromParam = typeof sp.from === "string" && z.guid().safeParse(sp.from).success ? sp.from : undefined;
  const t = await getTranslations("inventory.transferForm");
  const tc = await getTranslations("inventory.common");
  const tExpiry = await getTranslations("inventory.expiry");
  const format = await getFormatter();

  const warehouses = await listWarehouses();
  if (!warehouses.ok) return <InventoryError code={warehouses.error.code} messageKey={warehouses.error.messageKey} requestId={warehouses.error.requestId} />;
  const active = warehouses.data.filter((w) => w.is_active);
  const from = active.find((w) => w.id === fromParam);

  const stock = from ? await listStockDetail({ warehouse: from.id, onlyAvailable: true }) : null;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Link href="/inventory/transfers" className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline">
        {t("back")}
      </Link>
      <div>
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("intro")}</p>
      </div>

      <FilterBar
        fields={[
          {
            kind: "select",
            name: "from",
            label: t("from"),
            value: from?.id,
            allLabel: t("selectSource"),
            options: active.map((w) => ({ value: w.id, label: `${w.code} · ${w.name}` })),
          },
        ]}
        applyLabel={t("chooseSource")}
        resetLabel={tc("reset")}
        resetHref="/inventory/transfers/new"
      />

      {!from ? (
        <p className="text-sm text-muted-foreground">{t("pickSourceFirst")}</p>
      ) : stock && !stock.ok ? (
        <InventoryError code={stock.error.code} messageKey={stock.error.messageKey} requestId={stock.error.requestId} />
      ) : (
        <Card>
          <TransferForm
            // A new source resets the lines.
            key={from.id}
            locale={locale}
            fromWarehouseId={from.id}
            destinations={active
              .filter((w) => w.id !== from.id)
              .map((w) => ({ id: w.id, label: `${w.code} · ${w.name}`, kind: w.kind, sellable: w.is_sellable }))}
            stockLines={lotsFefo(stock?.ok ? stock.data : []).map((r) => ({
              value: stockLineValue(r.variant_id, r.lot_id),
              label: [
                r.sku,
                r.lot_no,
                r.expiry_date ? format.dateTime(calendarDate(r.expiry_date), CALENDAR_DATE) : tExpiry("none"),
                t("availableN", { n: r.available }),
              ].join(" · "),
              available: r.available,
            }))}
          />
        </Card>
      )}
    </div>
  );
}
