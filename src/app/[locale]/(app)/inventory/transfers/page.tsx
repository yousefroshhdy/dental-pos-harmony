import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { cn } from "@/lib/utils";
import { receiveTransfer, shipTransfer } from "@/modules/inventory/actions";
import { WarehouseKindBadge } from "@/modules/inventory/components/badges";
import { ConfirmActionForm } from "@/modules/inventory/components/confirm-action-form";
import { FilterBar } from "@/modules/inventory/components/filter-bar";
import { InventoryError } from "@/modules/inventory/components/inventory-error";
import { CAIRO_DATE_TIME, QTY } from "@/modules/inventory/format";
import {
  canReadTransfers,
  isTransferStatus,
  parseStockFilters,
  releaseBlocked,
  shortId,
  toQuery,
  transferActions,
  transferStatusTone,
  type SearchParams,
} from "@/modules/inventory/logic";
import { listTransferLines, listTransfers, listWarehouses } from "@/modules/inventory/queries";
import { TRANSFER_STATUSES, type TransferLineRow } from "@/modules/inventory/types";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "inventory.transfers" });
  return { title: t("title") };
}

export default async function TransfersPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<SearchParams> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!canReadTransfers(ctx)) return <Forbidden />;

  const sp = await searchParams;
  const rawStatus = typeof sp.status === "string" ? sp.status : "";
  const status = isTransferStatus(rawStatus) ? rawStatus : undefined;
  const { warehouse } = parseStockFilters(sp);
  const highlight = typeof sp.highlight === "string" ? sp.highlight : undefined;
  const t = await getTranslations("inventory.transfers");
  const tc = await getTranslations("inventory.common");
  const tStatus = await getTranslations("inventory.transferStatus");
  const format = await getFormatter();

  const [transfers, warehouses] = await Promise.all([listTransfers({ status, warehouse }), listWarehouses()]);
  if (!transfers.ok) return <InventoryError code={transfers.error.code} messageKey={transfers.error.messageKey} requestId={transfers.error.requestId} />;
  const lines = await listTransferLines(transfers.data.map((x) => x.id));
  const linesByTransfer = new Map<string, TransferLineRow[]>();
  for (const l of lines.ok ? lines.data : []) linesByTransfer.set(l.transfer_id, [...(linesByTransfer.get(l.transfer_id) ?? []), l]);
  const whById = new Map((warehouses.ok ? warehouses.data : []).map((w) => [w.id, w]));
  const inTransit = transfers.data.filter((x) => x.status === "in_transit").length;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("intro")}</p>
        </div>
        {can(ctx, "inventory.transfer.create") ? (
          <Link href="/inventory/transfers/new" className={buttonVariants()}>
            {t("new")}
          </Link>
        ) : null}
      </div>

      {inTransit > 0 ? (
        <Link
          href={`/inventory/transfers${toQuery({ status: "in_transit", warehouse })}`}
          className="block min-h-11 rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-sm"
        >
          {t("inTransitBanner", { n: inTransit })}
        </Link>
      ) : null}

      <FilterBar
        fields={[
          {
            kind: "select",
            name: "status",
            label: tc("status"),
            value: status,
            allLabel: tc("allStatuses"),
            options: TRANSFER_STATUSES.map((s) => ({ value: s, label: tStatus(s) })),
          },
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
        resetHref="/inventory/transfers"
      />

      {!lines.ok ? <p className="text-sm text-muted-foreground">{t("linesUnavailable")}</p> : null}

      {transfers.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="space-y-3">
          {transfers.data.map((x) => {
            const from = whById.get(x.from_warehouse_id);
            const to = whById.get(x.to_warehouse_id);
            const actions = transferActions(ctx, x, { from: from?.kind, to: to?.kind });
            // D-13: receiving released quarantine stock needs inventory.quarantine.release.
            const receiveNeedsRelease =
              x.status === "in_transit" && can(ctx, "inventory.transfer.receive") && releaseBlocked(ctx, from?.kind, to?.kind);
            const items = linesByTransfer.get(x.id) ?? [];
            const units = x.items.reduce((n, i) => n + i.quantity, 0);
            return (
              <li
                key={x.id}
                className={cn(
                  "space-y-3 rounded-lg border bg-card p-3",
                  x.status === "in_transit" && "border-primary/50",
                  highlight === x.id && "ring-2 ring-ring",
                )}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium" dir="ltr">
                    {x.transfer_no}
                  </span>
                  <Badge tone={transferStatusTone(x.status)}>{tStatus(x.status)}</Badge>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="inline-flex flex-wrap items-center gap-1">
                    {x.from_warehouse_code}
                    <WarehouseKindBadge kind={from?.kind ?? null} sellable={from?.is_sellable} />
                  </span>
                  <span aria-hidden="true" className="inline-block rtl:rotate-180">
                    →
                  </span>
                  <span className="sr-only">{t("to")}</span>
                  <span className="inline-flex flex-wrap items-center gap-1">
                    {x.to_warehouse_code}
                    <WarehouseKindBadge kind={to?.kind ?? null} sellable={to?.is_sellable} />
                  </span>
                </div>
                {x.status === "in_transit" ? <p className="text-sm text-primary">{t("inTransitNote")}</p> : null}
                {receiveNeedsRelease ? <p className="text-sm text-muted-foreground">{t("releaseNeeded")}</p> : null}
                <ul className="space-y-1 text-sm">
                  {items.length === 0
                    ? x.items.map((i) => (
                        <li key={`${i.variant_id}:${i.lot_id}`} className="text-muted-foreground">
                          {t("lineFallback", { ref: shortId(i.lot_id), qty: i.quantity })}
                        </li>
                      ))
                    : items.map((i) => (
                        <li key={i.item_id} className="flex flex-wrap justify-between gap-2">
                          <span>
                            <span dir="ltr">{i.sku}</span> · <span dir="ltr">{i.lot_no}</span>
                          </span>
                          <span className="tabular-nums">
                            {x.status === "received"
                              ? t("receivedQty", { received: i.received_qty, qty: i.quantity })
                              : format.number(i.quantity, QTY)}
                          </span>
                        </li>
                      ))}
                </ul>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>{t("units", { n: units })}</span>
                  <span>{t("created", { when: format.dateTime(new Date(x.created_at), CAIRO_DATE_TIME) })}</span>
                  {x.shipped_at ? <span>{t("shipped", { when: format.dateTime(new Date(x.shipped_at), CAIRO_DATE_TIME) })}</span> : null}
                  {x.received_at ? <span>{t("receivedAt", { when: format.dateTime(new Date(x.received_at), CAIRO_DATE_TIME) })}</span> : null}
                </div>
                {actions.ship || actions.receive ? (
                  <div className="flex flex-col gap-2 sm:flex-row">
                    {actions.ship ? (
                      <ConfirmActionForm
                        action={shipTransfer}
                        fields={{ transfer_id: x.id }}
                        trigger={t("ship")}
                        confirm={t("shipConfirm")}
                        hint={t("shipHint", { units, from: x.from_warehouse_code ?? "" })}
                        success={t("shippedOk")}
                        primary
                      />
                    ) : null}
                    {actions.receive ? (
                      <ConfirmActionForm
                        action={receiveTransfer}
                        fields={{ transfer_id: x.id }}
                        trigger={t("receive")}
                        confirm={t("receiveConfirm")}
                        hint={t("receiveHint", { units, to: x.to_warehouse_code ?? "" })}
                        success={t("receivedOk")}
                        primary
                      />
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
