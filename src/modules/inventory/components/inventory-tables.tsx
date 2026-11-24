"use client";

import { ArrowRightIcon, BoxesIcon, HistoryIcon, PackageOpenIcon, TruckIcon } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import type { ComboboxOption } from "@/components/ui/combobox";
import type { DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { ClearFilters, FilterCombobox, FilterDate, FilterSelect, FilterTabs, type FilterOption } from "@/modules/orders/kit/url-filters";
import { UrlDataTable } from "@/modules/orders/kit/url-table";
import { receiveTransfer, shipTransfer } from "../actions";
import { CALENDAR_DATE, CAIRO_DATE_TIME, QTY, SIGNED_QTY, calendarDate } from "../format";
import { AVAILABLE_LIST, MOVEMENT_LIST, RECEIPT_LIST, STOCK_LIST, TRANSFER_LIST } from "../lists";
import {
  expiryStatus,
  expiryTone,
  isSellableKind,
  movementTone,
  parseReason,
  receiptStatusTone,
  shortId,
  STOCK_ALERTS,
  toAmount,
  toQuery,
  transferStatusTone,
  warehouseKindTone,
  type StockAlert,
  type StockFlags,
} from "../logic";
import { MOVEMENT_TYPES, RECEIPT_STATUSES, TRANSFER_STATUSES, type AvailableRow, type MovementRow, type ReceiptRow, type StockRow, type TransferLineRow, type TransferRow, type WarehouseKind } from "../types";
import { ConfirmActionForm } from "./confirm-action-form";

// ---------------------------------------------------------------------------
// Badges (client twins of badges.tsx, for the table cells)
// ---------------------------------------------------------------------------

export function KindBadge({ kind, sellable }: { kind: WarehouseKind | null | undefined; sellable?: boolean }) {
  const t = useTranslations("inventory");
  if (!kind) return null;
  const notSellable = sellable === undefined ? !isSellableKind(kind) : !sellable;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge tone={warehouseKindTone(kind)}>{t(`kinds.${kind}`)}</Badge>
      {notSellable ? <Badge tone="danger">{t("common.notSellable")}</Badge> : null}
    </span>
  );
}

export function Expiry({ date, days }: { date: string | null; days: number | null }) {
  const t = useTranslations("inventory.expiry");
  const format = useFormatter();
  if (!date) return <span className="text-muted-foreground">{t("none")}</span>;
  const status = expiryStatus(days);
  return (
    <span className="inline-flex flex-wrap items-center gap-1 whitespace-nowrap">
      <span>{format.dateTime(calendarDate(date), CALENDAR_DATE)}</span>
      {status === "expired" || status === "critical" || status === "near" ? (
        <Badge tone={expiryTone(status)}>{status === "expired" ? t("expired") : t("inDays", { days: days ?? 0 })}</Badge>
      ) : null}
    </span>
  );
}

function Flags({ flags }: { flags: Pick<StockFlags, "belowReorder" | "nearExpiry" | "expired"> }) {
  const t = useTranslations("inventory.stock.alerts");
  if (!flags.belowReorder && !flags.expired && !flags.nearExpiry) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {flags.belowReorder ? <Badge tone="danger">{t("below_reorder")}</Badge> : null}
      {flags.expired ? <Badge tone="danger">{t("expired")}</Badge> : null}
      {flags.nearExpiry ? <Badge tone="warning">{t("near_expiry")}</Badge> : null}
    </span>
  );
}

const product = (name: string, sku: string | null, extra?: string | null) => (
  <span className="block min-w-0">
    <span className="block truncate font-medium">{name}</span>
    <span className="block truncate text-xs text-muted-foreground">
      <span dir="ltr">{sku ?? "—"}</span>
      {extra ? <> · {extra}</> : null}
    </span>
  </span>
);

const qty = (n: number, format: ReturnType<typeof useFormatter>, className?: string) => <span className={cn("tabular-nums", className)}>{format.number(n, QTY)}</span>;

interface StockFilterProps {
  warehouses: FilterOption[];
  brands: FilterOption[];
  products: ComboboxOption[];
  values: { warehouse?: string; brand?: string; product?: string };
}

function StockFilters({ warehouses, brands, products, values }: StockFilterProps) {
  const tc = useTranslations("inventory.common");
  const t = useTranslations("inventory.stock");
  return (
    <>
      <FilterSelect name="warehouse" label={tc("warehouse")} value={values.warehouse} options={warehouses} allLabel={tc("allWarehouses")} />
      <FilterSelect name="brand" label={tc("brand")} value={values.brand} options={brands} allLabel={tc("allBrands")} />
      <FilterCombobox
        name="product"
        label={tc("product")}
        value={values.product}
        options={products}
        placeholder={tc("allProducts")}
        searchPlaceholder={t("productSearch")}
        emptyText={t("noProduct")}
      />
      <ClearFilters names={["warehouse", "brand", "product", "alert"]} label={tc("reset")} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Stock (inventory roles)
// ---------------------------------------------------------------------------

export interface StockViewRow {
  row: StockRow;
  flags: StockFlags;
}

export function StockTable({
  rows,
  total,
  alert,
  filters,
  error,
}: {
  rows: StockViewRow[];
  total: number;
  alert: StockAlert;
  filters: StockFilterProps;
  error?: ReactNode;
}) {
  const t = useTranslations("inventory.stock");
  const tc = useTranslations("inventory.common");
  const format = useFormatter();
  const href = ({ row }: StockViewRow) => `/inventory/stock/${row.variant_id}${toQuery({ warehouse: row.warehouse_id })}`;
  const warehouse = ({ row }: StockViewRow) => (
    <span className="block">
      <span className="block font-medium">{row.warehouse_code}</span>
      <KindBadge kind={row.warehouse_kind} sellable={row.is_sellable} />
    </span>
  );

  const columns: DataTableColumn<StockViewRow>[] = [
    { id: "product", header: tc("product"), accessor: ({ row }) => row.product_name, cell: ({ row }) => product(row.product_name, row.sku, row.brand_name), sortable: true, primary: true, className: "min-w-48" },
    { id: "warehouse", header: tc("warehouse"), accessor: ({ row }) => row.warehouse_code, cell: warehouse, sortable: true, className: "min-w-36" },
    { id: "onHand", header: tc("onHand"), accessor: ({ row }) => row.on_hand, cell: ({ row }) => qty(row.on_hand, format), sortable: true, align: "end" },
    { id: "reserved", header: tc("reserved"), accessor: ({ row }) => row.reserved, cell: ({ row }) => qty(row.reserved, format), sortable: true, align: "end" },
    { id: "available", header: tc("available"), accessor: ({ row }) => row.available, cell: ({ row }) => qty(row.available, format), sortable: true, align: "end" },
    { id: "sellable", header: tc("sellable"), accessor: ({ row }) => row.sellable_available, cell: ({ row }) => qty(row.sellable_available, format, "font-semibold"), sortable: true, align: "end" },
    { id: "expiry", header: t("earliestExpiry"), accessor: ({ row }) => row.earliest_expiry, cell: ({ row }) => <Expiry date={row.earliest_expiry} days={row.days_to_earliest_expiry} />, sortable: true },
    { id: "flags", header: t("flags"), cell: ({ flags }) => <Flags flags={flags} /> },
  ];

  return (
    <div className="space-y-3">
      <FilterTabs
        name="alert"
        label={t("alertFilter")}
        current={alert === "all" ? null : alert}
        items={STOCK_ALERTS.map((a) => ({ value: a === "all" ? null : a, text: t(`alerts.${a}`) }))}
      />
      <UrlDataTable
        spec={STOCK_LIST}
        rowCount={total}
        columns={columns}
        data={rows}
        getRowId={({ row }) => `${row.warehouse_id}:${row.variant_id}`}
        rowHref={href}
        searchPlaceholder={t("searchPlaceholder")}
        caption={t("title")}
        error={error}
        filters={<StockFilters {...filters} />}
        empty={<EmptyState icon={<BoxesIcon aria-hidden="true" />} title={alert === "all" ? t("empty") : t("emptyAlert")} />}
        mobileCard={({ row, flags }) => (
          <div
            className={cn(
              "-m-3 space-y-2 rounded-lg p-3",
              (flags.belowReorder || flags.expired) && "border-s-4 border-destructive/60",
              !flags.belowReorder && !flags.expired && flags.nearExpiry && "border-s-4 border-warning",
              flags.notSellable && "bg-muted/40",
            )}
          >
            <div className="flex items-start justify-between gap-2">
              {product(row.product_name, row.sku, row.brand_name)}
              <div className="text-end">
                <p className="text-xl font-semibold tabular-nums">{format.number(row.sellable_available, QTY)}</p>
                <p className="text-xs text-muted-foreground">{tc("sellable")}</p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-1 text-xs">
              <span className="font-medium">{row.warehouse_code}</span>
              <KindBadge kind={row.warehouse_kind} sellable={row.is_sellable} />
              <Flags flags={flags} />
            </div>
            <p className="text-xs text-muted-foreground tabular-nums">{t("cardTotals", { onHand: row.on_hand, reserved: row.reserved, available: row.available })}</p>
            {row.earliest_expiry ? (
              <p className="text-xs">
                {t("earliestExpiry")}: <Expiry date={row.earliest_expiry} days={row.days_to_earliest_expiry} />
              </p>
            ) : null}
          </div>
        )}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sellable availability (sales roles)
// ---------------------------------------------------------------------------

export function AvailableTable({ rows, total, filters, error }: { rows: AvailableRow[]; total: number; filters: StockFilterProps; error?: ReactNode }) {
  const t = useTranslations("inventory.stock");
  const tc = useTranslations("inventory.common");
  const format = useFormatter();
  const columns: DataTableColumn<AvailableRow>[] = [
    { id: "product", header: tc("product"), accessor: (r) => r.product_name, cell: (r) => product(r.product_name, r.sku, r.variant_name), sortable: true, primary: true, className: "min-w-48" },
    { id: "warehouse", header: tc("warehouse"), accessor: (r) => r.warehouse_code, sortable: true },
    {
      id: "available",
      header: tc("available"),
      accessor: (r) => r.available,
      cell: (r) => qty(r.available, format, cn("text-lg font-semibold", r.available === 0 && "text-destructive")),
      sortable: true,
      align: "end",
    },
  ];
  return (
    <UrlDataTable
      spec={AVAILABLE_LIST}
      rowCount={total}
      columns={columns}
      data={rows}
      getRowId={(r) => `${r.warehouse_id}:${r.variant_id}`}
      searchPlaceholder={t("searchPlaceholder")}
      caption={t("title")}
      error={error}
      filters={<StockFilters {...filters} />}
      empty={<EmptyState icon={<BoxesIcon aria-hidden="true" />} title={t("empty")} />}
      mobileCard={(r) => (
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            {product(r.product_name, r.sku, r.variant_name)}
            <p className="text-xs text-muted-foreground">{r.warehouse_code}</p>
          </div>
          <div className="text-end">
            <p className={cn("text-xl font-semibold tabular-nums", r.available === 0 && "text-destructive")}>{format.number(r.available, QTY)}</p>
            <p className="text-xs text-muted-foreground">{tc("available")}</p>
          </div>
        </div>
      )}
    />
  );
}

// ---------------------------------------------------------------------------
// Movements (read-only, append-only ledger)
// ---------------------------------------------------------------------------

export function MovementsTable({
  rows,
  total,
  warehouses,
  variants,
  values,
  lang,
  fixedSource,
  error,
}: {
  rows: MovementRow[];
  total: number;
  warehouses: FilterOption[];
  variants: ComboboxOption[];
  values: { warehouse?: string; variant?: string; type?: string; from?: string; to?: string };
  lang: "ar" | "en";
  /** The adjustments list: the source filter is the page itself, not a chip. */
  fixedSource?: boolean;
  error?: ReactNode;
}) {
  const t = useTranslations("inventory.movements");
  const tc = useTranslations("inventory.common");
  const tTypes = useTranslations("inventory.movementTypes");
  const tReasons = useTranslations("inventory.reasons");
  const tSources = useTranslations("inventory.sources");
  const format = useFormatter();
  const showCost = rows.some((r) => r.unit_cost !== null);
  const when = (m: MovementRow) => format.dateTime(new Date(m.created_at), CAIRO_DATE_TIME);
  const signed = (m: MovementRow) => (
    <span dir="ltr" className={cn("font-semibold tabular-nums", m.quantity < 0 ? "text-destructive" : "text-success")}>
      {format.number(m.quantity, SIGNED_QTY)}
    </span>
  );
  const reason = (m: MovementRow) => {
    const r = parseReason(m.reason_code);
    if (!r.code && !r.note) return <span className="text-muted-foreground">—</span>;
    return (
      <span className="block">
        {r.code ? tReasons(r.code) : null}
        {r.note ? <span className="block text-xs text-muted-foreground">{r.note}</span> : null}
      </span>
    );
  };
  const source = (m: MovementRow) => (
    <span className="block text-xs">
      {m.source_doc_type ? <span className="block">{tSources.has(m.source_doc_type) ? tSources(m.source_doc_type) : m.source_doc_type}</span> : null}
      {m.source_doc_type === "receipt" && m.source_doc_id ? (
        <Link href={`/inventory/receipts/${m.source_doc_id}`} className="inline-flex min-h-11 items-center text-primary underline-offset-4 hover:underline">
          {t("openReceipt")}
        </Link>
      ) : null}
      {m.reverses_movement_id ? <span className="block">{t("reverses", { ref: shortId(m.reverses_movement_id) })}</span> : null}
      {m.approval_request_id ? <span className="block">{t("approved", { ref: shortId(m.approval_request_id) })}</span> : null}
      {!m.source_doc_type && !m.reverses_movement_id && !m.approval_request_id ? <span className="text-muted-foreground">—</span> : null}
    </span>
  );

  const columns: DataTableColumn<MovementRow>[] = [
    { id: "when", header: t("when"), accessor: (m) => m.created_at, cell: (m) => <span className="whitespace-nowrap">{when(m)}</span>, sortable: true, primary: true },
    { id: "type", header: t("type"), accessor: (m) => m.movement_type, cell: (m) => <Badge tone={movementTone(m.movement_type)}>{tTypes(m.movement_type)}</Badge>, sortable: true },
    { id: "warehouse", header: tc("warehouse"), accessor: (m) => m.warehouse_code, sortable: true },
    { id: "sku", header: tc("sku"), accessor: (m) => m.sku, cell: (m) => <span dir="ltr" className="whitespace-nowrap">{m.sku ?? "—"}</span>, sortable: true },
    { id: "lot", header: tc("lot"), accessor: (m) => m.lot_no, cell: (m) => <span dir="ltr">{m.lot_no ?? "—"}</span> },
    { id: "quantity", header: t("quantity"), accessor: (m) => m.quantity, cell: signed, sortable: true, align: "end" },
    { id: "reason", header: t("reason"), cell: reason, className: "min-w-32" },
    { id: "source", header: t("source"), cell: source, className: "min-w-32" },
    ...(showCost
      ? [
          {
            id: "cost",
            header: t("unitCost"),
            cell: (m: MovementRow) => {
              const cost = toAmount(m.unit_cost);
              return <span className="tabular-nums">{cost === null ? "—" : format.number(cost, "egp")}</span>;
            },
            align: "end" as const,
          },
        ]
      : []),
  ];

  return (
    <UrlDataTable
      spec={MOVEMENT_LIST}
      rowCount={total}
      columns={columns}
      data={rows}
      getRowId={(m) => m.id}
      searchPlaceholder={t("searchPlaceholder")}
      caption={t("title")}
      error={error}
      filters={
        <>
          <FilterSelect name="warehouse" label={tc("warehouse")} value={values.warehouse} options={warehouses} allLabel={tc("allWarehouses")} />
          <FilterCombobox name="variant" label={tc("sku")} value={values.variant} options={variants} placeholder={tc("allSkus")} searchPlaceholder={t("skuSearch")} emptyText={t("noSku")} />
          <FilterSelect name="type" label={t("type")} value={values.type} options={MOVEMENT_TYPES.map((m) => ({ value: m, label: tTypes(m) }))} allLabel={t("allTypes")} />
          <FilterDate name="from" label={t("from")} value={values.from} lang={lang} placeholder={t("anyDate")} clearLabel={t("clearDate")} max={values.to} />
          <FilterDate name="to" label={t("to")} value={values.to} lang={lang} placeholder={t("anyDate")} clearLabel={t("clearDate")} min={values.from} />
          <ClearFilters names={fixedSource ? ["warehouse", "variant", "type", "from", "to"] : ["warehouse", "variant", "type", "from", "to", "source_type", "source_id"]} label={tc("reset")} />
        </>
      }
      empty={<EmptyState icon={<HistoryIcon aria-hidden="true" />} title={t("empty")} />}
      mobileCard={(m) => (
        <div className="space-y-1 text-sm">
          <div className="flex items-start justify-between gap-2">
            <span className="min-w-0 space-y-1">
              <Badge tone={movementTone(m.movement_type)}>{tTypes(m.movement_type)}</Badge>
              <span className="block truncate">
                <span dir="ltr">{m.sku ?? "—"}</span>
                {m.lot_no ? (
                  <>
                    {" · "}
                    <span dir="ltr">{m.lot_no}</span>
                  </>
                ) : null}
              </span>
            </span>
            <span className="text-lg">{signed(m)}</span>
          </div>
          <p className="text-xs text-muted-foreground">{[m.warehouse_code, when(m)].filter(Boolean).join(" · ")}</p>
          {reason(m)}
          {source(m)}
        </div>
      )}
    />
  );
}

// ---------------------------------------------------------------------------
// Goods receipts
// ---------------------------------------------------------------------------

export function ReceiptsTable({
  rows,
  total,
  warehouses,
  values,
  error,
  emptyAction,
}: {
  rows: ReceiptRow[];
  total: number;
  warehouses: FilterOption[];
  values: { status?: string; warehouse?: string };
  error?: ReactNode;
  emptyAction?: ReactNode;
}) {
  const t = useTranslations("inventory.receipts");
  const tc = useTranslations("inventory.common");
  const tStatus = useTranslations("inventory.receiptStatus");
  const format = useFormatter();
  const when = (r: ReceiptRow) => format.dateTime(new Date(r.posted_at ?? r.received_at), CAIRO_DATE_TIME);
  const columns: DataTableColumn<ReceiptRow>[] = [
    { id: "number", header: t("columns.number"), accessor: (r) => r.receipt_no, cell: (r) => <span dir="ltr">{r.receipt_no}</span>, sortable: true, primary: true },
    { id: "supplier", header: t("columns.supplier"), accessor: (r) => r.supplier, sortable: true, className: "min-w-40" },
    {
      id: "warehouse",
      header: tc("warehouse"),
      accessor: (r) => r.warehouse_code,
      cell: (r) => (
        <span className="block">
          <span className="block">{r.warehouse_code ?? "—"}</span>
          <KindBadge kind={r.warehouse_kind} />
        </span>
      ),
      sortable: true,
    },
    { id: "status", header: tc("status"), accessor: (r) => r.status, cell: (r) => <Badge tone={receiptStatusTone(r.status)}>{tStatus(r.status)}</Badge>, sortable: true },
    { id: "units", header: t("columns.units"), accessor: (r) => r.total_quantity, cell: (r) => <span className="tabular-nums">{t("lines", { lines: r.line_count, units: format.number(r.total_quantity, QTY) })}</span>, sortable: true, align: "end" },
    { id: "received", header: t("columns.date"), accessor: (r) => r.received_at, cell: (r) => <span className="whitespace-nowrap">{when(r)}</span>, sortable: true },
  ];
  return (
    <UrlDataTable
      spec={RECEIPT_LIST}
      rowCount={total}
      columns={columns}
      data={rows}
      getRowId={(r) => r.id}
      rowHref={(r) => `/inventory/receipts/${r.id}`}
      searchPlaceholder={t("searchPlaceholder")}
      caption={t("title")}
      error={error}
      filters={
        <>
          <FilterSelect name="status" label={tc("status")} value={values.status} options={RECEIPT_STATUSES.map((s) => ({ value: s, label: tStatus(s) }))} allLabel={tc("allStatuses")} />
          <FilterSelect name="warehouse" label={tc("warehouse")} value={values.warehouse} options={warehouses} allLabel={tc("allWarehouses")} />
          <ClearFilters names={["status", "warehouse"]} label={tc("reset")} />
        </>
      }
      empty={<EmptyState icon={<PackageOpenIcon aria-hidden="true" />} title={t("empty")} action={emptyAction} />}
      mobileCard={(r) => (
        <div className="space-y-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium" dir="ltr">
              {r.receipt_no}
            </span>
            <Badge tone={receiptStatusTone(r.status)}>{tStatus(r.status)}</Badge>
          </div>
          <p className="text-sm">{r.supplier}</p>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{r.warehouse_code}</span>
            <KindBadge kind={r.warehouse_kind} />
            <span>{t("lines", { lines: r.line_count, units: format.number(r.total_quantity, QTY) })}</span>
            <span>{when(r)}</span>
          </div>
        </div>
      )}
    />
  );
}

// ---------------------------------------------------------------------------
// Transfers (with their ship / receive steps)
// ---------------------------------------------------------------------------

export interface TransferViewRow {
  transfer: TransferRow;
  lines: TransferLineRow[];
  from: { kind: WarehouseKind | null; sellable?: boolean };
  to: { kind: WarehouseKind | null; sellable?: boolean };
  /** transferActions(ctx, …), decided on the server (UX only; the database re-checks). */
  actions: { ship: boolean; receive: boolean };
  /** D-13: receiving releases quarantine stock and the user lacks inventory.quarantine.release. */
  receiveNeedsRelease: boolean;
}

export function TransfersTable({
  rows,
  total,
  warehouses,
  values,
  highlight,
  linesUnavailable,
  error,
  emptyAction,
}: {
  rows: TransferViewRow[];
  total: number;
  warehouses: FilterOption[];
  values: { status?: string; warehouse?: string };
  highlight?: string;
  linesUnavailable: boolean;
  error?: ReactNode;
  emptyAction?: ReactNode;
}) {
  const t = useTranslations("inventory.transfers");
  const tc = useTranslations("inventory.common");
  const tStatus = useTranslations("inventory.transferStatus");
  const format = useFormatter();
  const unitsOf = (x: TransferRow) => x.items.reduce((n, i) => n + i.quantity, 0);

  const route = (v: TransferViewRow) => (
    <span className="flex flex-wrap items-center gap-2 text-sm">
      <span className="inline-flex flex-wrap items-center gap-1">
        {v.transfer.from_warehouse_code}
        <KindBadge kind={v.from.kind} sellable={v.from.sellable} />
      </span>
      <ArrowRightIcon aria-hidden="true" className="size-4 shrink-0 rtl:rotate-180" />
      <span className="sr-only">{t("to")}</span>
      <span className="inline-flex flex-wrap items-center gap-1">
        {v.transfer.to_warehouse_code}
        <KindBadge kind={v.to.kind} sellable={v.to.sellable} />
      </span>
    </span>
  );
  const items = (v: TransferViewRow) => (
    <ul className="space-y-1 text-sm">
      {v.lines.length === 0
        ? v.transfer.items.map((i) => (
            <li key={`${i.variant_id}:${i.lot_id}`} className="text-muted-foreground">
              {t("lineFallback", { ref: shortId(i.lot_id), qty: i.quantity })}
            </li>
          ))
        : v.lines.map((i) => (
            <li key={i.item_id} className="flex flex-wrap justify-between gap-2">
              <span>
                <span dir="ltr">{i.sku}</span> · <span dir="ltr">{i.lot_no}</span>
              </span>
              <span className="tabular-nums">{v.transfer.status === "received" ? t("receivedQty", { received: i.received_qty, qty: i.quantity }) : format.number(i.quantity, QTY)}</span>
            </li>
          ))}
    </ul>
  );
  const steps = (v: TransferViewRow) => {
    const x = v.transfer;
    const units = unitsOf(x);
    if (!v.actions.ship && !v.actions.receive && !v.receiveNeedsRelease) return null;
    return (
      <div className="flex flex-col gap-2">
        {v.receiveNeedsRelease ? <p className="text-sm text-muted-foreground">{t("releaseNeeded")}</p> : null}
        {v.actions.ship ? (
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
        {v.actions.receive ? (
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
    );
  };
  const dates = (x: TransferRow) => (
    <span className="flex flex-col gap-0.5 text-xs text-muted-foreground">
      <span>{t("created", { when: format.dateTime(new Date(x.created_at), CAIRO_DATE_TIME) })}</span>
      {x.shipped_at ? <span>{t("shipped", { when: format.dateTime(new Date(x.shipped_at), CAIRO_DATE_TIME) })}</span> : null}
      {x.received_at ? <span>{t("receivedAt", { when: format.dateTime(new Date(x.received_at), CAIRO_DATE_TIME) })}</span> : null}
    </span>
  );

  const columns: DataTableColumn<TransferViewRow>[] = [
    {
      id: "number",
      header: t("columns.number"),
      accessor: (v) => v.transfer.transfer_no,
      cell: (v) => (
        <span className={cn("flex flex-col gap-1", highlight === v.transfer.id && "rounded ring-2 ring-ring")}>
          <span className="font-medium" dir="ltr">
            {v.transfer.transfer_no}
          </span>
          <Badge tone={transferStatusTone(v.transfer.status)}>{tStatus(v.transfer.status)}</Badge>
        </span>
      ),
      sortable: true,
      primary: true,
    },
    { id: "from", header: t("columns.route"), accessor: (v) => v.transfer.from_warehouse_code, cell: route, sortable: true, className: "min-w-48" },
    { id: "items", header: t("columns.items"), cell: (v) => (
      <span className="block space-y-1">
        {items(v)}
        <span className="block text-xs text-muted-foreground">{t("units", { n: unitsOf(v.transfer) })}</span>
      </span>
    ), className: "min-w-48" },
    { id: "created", header: t("columns.dates"), accessor: (v) => v.transfer.created_at, cell: (v) => dates(v.transfer), sortable: true },
    { id: "steps", header: tc("actions"), cell: (v) => steps(v) ?? <span className="text-muted-foreground">—</span>, className: "min-w-44" },
  ];

  return (
    <div className="space-y-3">
      {linesUnavailable ? <p className="text-sm text-muted-foreground">{t("linesUnavailable")}</p> : null}
      <UrlDataTable
        spec={TRANSFER_LIST}
        rowCount={total}
        columns={columns}
        data={rows}
        getRowId={(v) => v.transfer.id}
        searchPlaceholder={t("searchPlaceholder")}
        caption={t("title")}
        error={error}
        filters={
          <>
            <FilterSelect name="status" label={tc("status")} value={values.status} options={TRANSFER_STATUSES.map((s) => ({ value: s, label: tStatus(s) }))} allLabel={tc("allStatuses")} />
            <FilterSelect name="warehouse" label={tc("warehouse")} value={values.warehouse} options={warehouses} allLabel={tc("allWarehouses")} />
            <ClearFilters names={["status", "warehouse"]} label={tc("reset")} />
          </>
        }
        empty={<EmptyState icon={<TruckIcon aria-hidden="true" />} title={t("empty")} action={emptyAction} />}
        mobileCard={(v) => (
          <div className={cn("space-y-3", v.transfer.status === "in_transit" && "-m-3 rounded-lg border-s-4 border-primary/60 p-3", highlight === v.transfer.id && "ring-2 ring-ring")}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium" dir="ltr">
                {v.transfer.transfer_no}
              </span>
              <Badge tone={transferStatusTone(v.transfer.status)}>{tStatus(v.transfer.status)}</Badge>
            </div>
            {route(v)}
            {v.transfer.status === "in_transit" ? <p className="text-sm text-primary">{t("inTransitNote")}</p> : null}
            {items(v)}
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>{t("units", { n: unitsOf(v.transfer) })}</span>
            </div>
            {dates(v.transfer)}
            {steps(v)}
          </div>
        )}
      />
    </div>
  );
}
