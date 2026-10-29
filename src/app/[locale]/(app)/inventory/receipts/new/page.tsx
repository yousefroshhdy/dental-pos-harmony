import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { Card } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { InventoryError } from "@/modules/inventory/components/inventory-error";
import { ReceiptForm } from "@/modules/inventory/components/receipt-form";
import { cairoToday, localizedName, parseStockFilters, type SearchParams } from "@/modules/inventory/logic";
import { listVariants, listWarehouses } from "@/modules/inventory/queries";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "inventory.receiptForm" });
  return { title: t("title") };
}

export default async function NewReceiptPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<SearchParams> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!can(ctx, "inventory.receipt.post")) return <Forbidden />;

  const { warehouse } = parseStockFilters(await searchParams);
  const t = await getTranslations("inventory.receiptForm");
  const [warehouses, variants] = await Promise.all([listWarehouses(), listVariants()]);
  if (!warehouses.ok) return <InventoryError code={warehouses.error.code} messageKey={warehouses.error.messageKey} requestId={warehouses.error.requestId} />;
  if (!variants.ok) return <InventoryError code={variants.error.code} messageKey={variants.error.messageKey} requestId={variants.error.requestId} />;

  // Only active warehouses can receive (api.create_goods_receipt); the DB also checks the warehouse scope.
  const choices = warehouses.data
    .filter((w) => w.is_active)
    .map((w) => ({ id: w.id, label: `${w.code} · ${w.name}`, kind: w.kind, sellable: w.is_sellable }));
  const variantChoices = variants.data
    .filter((v) => v.variant_status === "active" && v.product_status !== "discontinued")
    .map((v) => ({
      id: v.variant_id,
      label: `${v.sku} · ${localizedName(locale, v.product_name, v.product_name_ar)} · ${v.variant_name}`,
      lotTracked: v.is_lot_tracked,
      expiryTracked: v.is_expiry_tracked,
    }));

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <Link href="/inventory/receipts" className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline">
        {t("back")}
      </Link>
      <div>
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("intro")}</p>
      </div>
      <Card>
        {choices.length === 0 || variantChoices.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("nothingToReceive")}</p>
        ) : (
          <ReceiptForm
            locale={locale}
            warehouses={choices}
            variants={variantChoices}
            today={cairoToday()}
            defaultWarehouseId={choices.some((c) => c.id === warehouse) ? warehouse : undefined}
          />
        )}
      </Card>
    </div>
  );
}
