import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { z } from "zod";
import { Forbidden } from "@/components/forbidden";
import { Alert, Badge, Card, Table, Td, Th } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { postReceipt } from "@/modules/inventory/actions";
import { ExpiryBadge, WarehouseKindBadge } from "@/modules/inventory/components/badges";
import { ConfirmActionForm } from "@/modules/inventory/components/confirm-action-form";
import { InventoryError } from "@/modules/inventory/components/inventory-error";
import { CAIRO_DATE_TIME, QTY } from "@/modules/inventory/format";
import { cairoToday, canReadReceipts, daysBetween, receiptLineIssues, receiptStatusTone, toAmount, toQuery } from "@/modules/inventory/logic";
import { getReceipt } from "@/modules/inventory/queries";

type Params = Promise<{ locale: string; receiptId: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "inventory.receipt" });
  return { title: t("metaTitle") };
}

export default async function ReceiptPage({ params }: { params: Params }) {
  const { locale, receiptId } = await params;
  setRequestLocale(locale);
  if (!z.guid().safeParse(receiptId).success) notFound();
  const ctx = await getUserContext();
  if (!canReadReceipts(ctx)) return <Forbidden />;

  const t = await getTranslations("inventory.receipt");
  const tc = await getTranslations("inventory.common");
  const tStatus = await getTranslations("inventory.receiptStatus");
  const format = await getFormatter();

  const receipt = await getReceipt(receiptId);
  if (!receipt.ok) return <InventoryError code={receipt.error.code} messageKey={receipt.error.messageKey} requestId={receipt.error.requestId} />;
  if (!receipt.data) notFound();
  const r = receipt.data;
  const today = cairoToday();
  const expiredLines = r.items.filter((i) =>
    receiptLineIssues(i, { expiryTracked: false, warehouseKind: r.warehouse_kind, today }).includes("EXPIRED_NEEDS_QUARANTINE"),
  );
  const showCost = r.items.some((i) => i.unit_cost !== null);
  const mayPost = r.status === "draft" && can(ctx, "inventory.receipt.post");

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <Link href="/inventory/receipts" className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline">
        {t("back")}
      </Link>

      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold" dir="ltr">
            {r.receipt_no}
          </h1>
          <Badge tone={receiptStatusTone(r.status)}>{tStatus(r.status)}</Badge>
        </div>
        <p className="text-sm">{r.supplier}</p>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>
            {r.warehouse_code} · {r.warehouse_name}
          </span>
          <WarehouseKindBadge kind={r.warehouse_kind} />
          {r.shipment_ref ? (
            <span>
              {t("shipmentRef")}: <span dir="ltr">{r.shipment_ref}</span>
            </span>
          ) : null}
        </div>
      </div>

      <Alert tone={r.status === "posted" ? "success" : "info"} role="status">
        {r.status === "posted" && r.posted_at
          ? t("postedAt", { when: format.dateTime(new Date(r.posted_at), CAIRO_DATE_TIME) })
          : r.status === "draft"
            ? t("draftNotice")
            : t("cancelledNotice")}
      </Alert>

      {r.status === "draft" && expiredLines.length > 0 ? (
        <Alert>{t("expiredWarning", { lots: expiredLines.map((l) => l.lot_no).join(", ") })}</Alert>
      ) : null}

      <Table>
        <thead>
          <tr>
            <Th>{tc("sku")}</Th>
            <Th>{tc("lot")}</Th>
            <Th>{tc("expiry")}</Th>
            <Th className="text-end">{t("quantity")}</Th>
            {showCost ? <Th className="text-end">{t("unitCost")}</Th> : null}
          </tr>
        </thead>
        <tbody>
          {r.items.map((i) => {
            const cost = toAmount(i.unit_cost);
            return (
              <tr key={i.item_id}>
                <Td className="min-w-40">
                  <span dir="ltr" className="block">
                    {i.sku ?? "—"}
                  </span>
                  <span className="text-xs text-muted-foreground">{i.variant_name}</span>
                </Td>
                <Td>
                  <span dir="ltr">{i.lot_no}</span>
                </Td>
                <Td>
                  <ExpiryBadge date={i.expiry_date} days={i.expiry_date ? daysBetween(today, i.expiry_date) : null} />
                </Td>
                <Td className="text-end tabular-nums">{format.number(i.quantity, QTY)}</Td>
                {showCost ? <Td className="text-end tabular-nums">{cost === null ? "—" : format.number(cost, "egp")}</Td> : null}
              </tr>
            );
          })}
        </tbody>
      </Table>
      <p className="text-sm text-muted-foreground">{t("totals", { lines: r.line_count, units: format.number(r.total_quantity, QTY) })}</p>

      {mayPost ? (
        <Card className="space-y-2">
          <p className="text-sm">{t("postHint")}</p>
          <ConfirmActionForm
            action={postReceipt}
            fields={{ receipt_id: r.id }}
            trigger={t("post")}
            confirm={t("postConfirm")}
            hint={t("postConfirmHint", { units: r.total_quantity, warehouse: r.warehouse_code ?? "" })}
            success={t("posted")}
            primary
          />
        </Card>
      ) : null}

      {r.status === "posted" && can(ctx, "inventory.movement.read") ? (
        <Link
          href={`/inventory/movements${toQuery({ source_type: "receipt", source_id: r.id })}`}
          className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline"
        >
          {t("viewMovements")}
        </Link>
      ) : null}
    </div>
  );
}
