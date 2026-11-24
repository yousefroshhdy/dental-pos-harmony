"use client";

import { FileTextIcon, ReceiptIcon, WalletIcon } from "lucide-react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import type { ComboboxOption } from "@/components/ui/combobox";
import type { DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Link } from "@/i18n/navigation";
import { ClearFilters, FilterCombobox, FilterTabs } from "@/modules/orders/kit/url-filters";
import { UrlDataTable } from "@/modules/orders/kit/url-table";
import { CAIRO_DATE, CAIRO_DATE_TIME, dateOnly } from "../format";
import { AGING_LIST, invoiceList, PAYMENT_LIST } from "../lists";
import { INVOICE_FILTERS, invoiceStatusTone, localizedName, PAYMENT_FILTERS, paymentStatusTone, toNumber, withQuery, type InvoiceFilter, type PaymentFilter } from "../logic";
import { AGING_BUCKETS, type AgingBucket, type AgingRow, type InvoiceRow, type PaymentRow } from "../types";

type Numeric = number | string;
const INVOICE_TABS = Object.keys(INVOICE_FILTERS) as InvoiceFilter[];
const PAYMENT_TABS = Object.keys(PAYMENT_FILTERS) as PaymentFilter[];

function useMoney() {
  const format = useFormatter();
  return (v: Numeric | null | undefined) => format.number(toNumber(v ?? 0), "egp");
}

function Amount({ children, strong = false }: { children: ReactNode; strong?: boolean }) {
  return <span className={strong ? "font-semibold whitespace-nowrap tabular-nums" : "whitespace-nowrap tabular-nums"}>{children}</span>;
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

export function InvoicesTable({
  rows,
  total,
  filter,
  bucket,
  customerId,
  customers,
  error,
}: {
  rows: InvoiceRow[];
  total: number;
  filter: InvoiceFilter;
  bucket: AgingBucket | null;
  customerId: string | null;
  customers: ComboboxOption[];
  error?: ReactNode;
}) {
  const t = useTranslations("finance");
  const format = useFormatter();
  const money = useMoney();
  const date = (d: string) => format.dateTime(dateOnly(d), CAIRO_DATE);
  const status = (inv: InvoiceRow) => (
    <Badge tone={invoiceStatusTone(inv.status, inv.is_overdue)}>{inv.is_overdue ? t("invoices.overdueDays", { count: inv.days_overdue }) : t(`invoiceStatus.${inv.status}`)}</Badge>
  );
  const number = (inv: InvoiceRow) => (
    <span dir="ltr" className="whitespace-nowrap">
      {inv.invoice_no}
    </span>
  );

  const columns: DataTableColumn<InvoiceRow>[] = [
    { id: "number", header: t("invoices.columns.number"), accessor: (r) => r.invoice_no, cell: number, sortable: true, primary: true },
    { id: "customer", header: t("invoices.columns.customer"), accessor: (r) => r.customer_name, sortable: true, className: "min-w-40" },
    { id: "status", header: t("invoices.columns.status"), cell: status },
    { id: "issued", header: t("invoices.columns.issued"), accessor: (r) => r.issue_date, cell: (r) => <span className="whitespace-nowrap">{date(r.issue_date)}</span>, sortable: true },
    { id: "due", header: t("invoices.columns.due"), accessor: (r) => r.due_date, cell: (r) => <span className="whitespace-nowrap">{date(r.due_date)}</span>, sortable: true },
    { id: "total", header: t("invoices.columns.total"), accessor: (r) => toNumber(r.total), cell: (r) => <Amount>{money(r.total)}</Amount>, sortable: true, align: "end" },
    {
      id: "open",
      header: t("invoices.columns.open"),
      accessor: (r) => toNumber(r.open_amount),
      cell: (r) => (toNumber(r.open_amount) > 0 ? <Amount strong>{money(r.open_amount)}</Amount> : <span className="text-muted-foreground">—</span>),
      sortable: true,
      align: "end",
    },
  ];

  return (
    <div className="space-y-3">
      <FilterTabs
        name="status"
        label={t("invoices.filterLabel")}
        current={bucket ? "__bucket" : filter === "open" ? null : filter}
        clears={["bucket"]}
        items={INVOICE_TABS.map((f) => ({ value: f === "open" ? null : f, text: t(`invoices.filters.${f}`) }))}
      />
      {bucket ? (
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <Badge tone="info">{t(`aging.buckets.${bucket}`)}</Badge>
          <Link href={withQuery("/finance/invoices", { customer: customerId })} className="inline-flex min-h-11 items-center text-primary underline-offset-4 hover:underline">
            {t("invoices.clearBucket")}
          </Link>
        </p>
      ) : null}
      <UrlDataTable
        spec={invoiceList(filter)}
        rowCount={total}
        columns={columns}
        data={rows}
        getRowId={(r) => r.id}
        rowHref={(r) => `/finance/invoices/${r.id}`}
        searchPlaceholder={t("invoices.searchPlaceholder")}
        caption={t("invoices.title")}
        error={error}
        filters={
          <>
            <FilterCombobox
              name="customer"
              label={t("invoices.customer")}
              value={customerId}
              options={customers}
              placeholder={t("invoices.allCustomers")}
              searchPlaceholder={t("invoices.customerSearch")}
              emptyText={t("invoices.noCustomer")}
            />
            <ClearFilters names={["customer", "bucket"]} label={t("invoices.clearFilters")} />
          </>
        }
        empty={<EmptyState icon={<FileTextIcon aria-hidden="true" />} title={t("invoices.empty")} description={t("invoices.emptyHint")} />}
        mobileCard={(inv) => (
          <div className="space-y-1">
            <div className="flex items-start justify-between gap-2">
              <span className="min-w-0 space-y-0.5">
                <span className="flex flex-wrap items-center gap-2 font-medium">
                  {number(inv)}
                  {status(inv)}
                </span>
                <span className="block truncate text-sm">{inv.customer_name ?? "—"}</span>
              </span>
              <span className="flex flex-col text-end text-sm">
                <Amount strong>{money(inv.total)}</Amount>
                {toNumber(inv.open_amount) > 0 ? <span className="text-xs text-muted-foreground">{t("invoices.openAmount", { amount: money(inv.open_amount) })}</span> : null}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">{t("invoices.due", { date: date(inv.due_date) })}</p>
          </div>
        )}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

export function PaymentsTable({
  rows,
  total,
  filter,
  defaultFilter,
  customerId,
  customers,
  error,
  emptyAction,
}: {
  rows: PaymentRow[];
  total: number;
  filter: PaymentFilter;
  /** The tab shown without ?status= (finance: the verification queue). */
  defaultFilter: PaymentFilter;
  customerId: string | null;
  customers: ComboboxOption[];
  error?: ReactNode;
  emptyAction?: ReactNode;
}) {
  const t = useTranslations("finance");
  const locale = useLocale();
  const format = useFormatter();
  const money = useMoney();
  const when = (p: PaymentRow) => format.dateTime(new Date(p.received_at), CAIRO_DATE_TIME);
  const number = (p: PaymentRow) => (
    <span dir="ltr" className="whitespace-nowrap">
      {p.payment_no}
    </span>
  );
  const badges = (p: PaymentRow) => (
    <span className="flex flex-wrap gap-1">
      <Badge tone={paymentStatusTone(p.status)}>{t(`paymentStatus.${p.status}`)}</Badge>
      <Badge>{t(`method.${p.method}`)}</Badge>
    </span>
  );

  const columns: DataTableColumn<PaymentRow>[] = [
    { id: "number", header: t("payments.columns.number"), accessor: (r) => r.payment_no, cell: number, sortable: true, primary: true },
    { id: "customer", header: t("payments.columns.customer"), accessor: (r) => r.customer_name, sortable: true, className: "min-w-40" },
    { id: "status", header: t("payments.columns.status"), cell: badges },
    { id: "collector", header: t("payments.columns.collector"), accessor: (r) => localizedName(locale, r.collected_by_name_en, r.collected_by_name_ar) },
    { id: "received", header: t("payments.columns.received"), accessor: (r) => r.received_at, cell: (r) => <span className="whitespace-nowrap">{when(r)}</span>, sortable: true },
    { id: "amount", header: t("payments.columns.amount"), accessor: (r) => toNumber(r.amount), cell: (r) => <Amount strong>{money(r.amount)}</Amount>, sortable: true, align: "end" },
    {
      id: "unallocated",
      header: t("payments.columns.unallocated"),
      accessor: (r) => toNumber(r.unallocated),
      cell: (r) => (toNumber(r.unallocated) > 0 ? <Amount>{money(r.unallocated)}</Amount> : <span className="text-muted-foreground">—</span>),
      sortable: true,
      align: "end",
    },
  ];

  return (
    <div className="space-y-3">
      <FilterTabs
        name="status"
        label={t("payments.filterLabel")}
        current={filter === defaultFilter ? null : filter}
        items={PAYMENT_TABS.map((f) => ({ value: f === defaultFilter ? null : f, text: t(`payments.filters.${f}`) }))}
      />
      <UrlDataTable
        spec={PAYMENT_LIST}
        rowCount={total}
        columns={columns}
        data={rows}
        getRowId={(r) => r.id}
        rowHref={(r) => `/finance/payments/${r.id}`}
        searchPlaceholder={t("payments.searchPlaceholder")}
        caption={t("payments.title")}
        error={error}
        filters={
          <>
            <FilterCombobox
              name="customer"
              label={t("invoices.customer")}
              value={customerId}
              options={customers}
              placeholder={t("invoices.allCustomers")}
              searchPlaceholder={t("invoices.customerSearch")}
              emptyText={t("invoices.noCustomer")}
            />
            <ClearFilters names={["customer"]} label={t("invoices.clearFilters")} />
          </>
        }
        empty={<EmptyState icon={<WalletIcon aria-hidden="true" />} title={t("payments.empty")} description={t("payments.emptyHint")} action={emptyAction} />}
        mobileCard={(p) => (
          <div className="space-y-1">
            <div className="flex items-start justify-between gap-2">
              <span className="min-w-0 space-y-1">
                <span className="block font-medium">{number(p)}</span>
                {badges(p)}
                <span className="block truncate text-sm">{p.customer_name ?? "—"}</span>
              </span>
              <span className="flex flex-col text-end text-sm">
                <Amount strong>{money(p.amount)}</Amount>
                {toNumber(p.unallocated) > 0 ? <span className="text-xs text-muted-foreground">{t("payments.unallocated", { amount: money(p.unallocated) })}</span> : null}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">{[localizedName(locale, p.collected_by_name_en, p.collected_by_name_ar), when(p)].filter(Boolean).join(" · ")}</p>
          </div>
        )}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Aging
// ---------------------------------------------------------------------------

const BUCKET_COLUMN: Record<AgingBucket, keyof AgingRow> = {
  current: "current_amount",
  d1_30: "d1_30",
  d31_60: "d31_60",
  d61_90: "d61_90",
  d90_plus: "d90_plus",
};

/** Receivables aging per customer; every bucket amount drills down to that bucket's invoices. */
export function AgingTable({ rows, total, ledger, error }: { rows: AgingRow[]; total: number; ledger: boolean; error?: ReactNode }) {
  const t = useTranslations("finance");
  const locale = useLocale();
  const money = useMoney();
  const bucketCell = (r: AgingRow, b: AgingBucket) => {
    const v = r[BUCKET_COLUMN[b]] as Numeric;
    return toNumber(v) > 0 ? (
      <Link href={withQuery("/finance/invoices", { customer: r.customer_id, bucket: b })} className="inline-flex min-h-11 items-center text-primary tabular-nums underline-offset-4 hover:underline">
        {money(v)}
      </Link>
    ) : (
      <span className="text-muted-foreground">—</span>
    );
  };
  const customer = (r: AgingRow) => (
    <span className="block min-w-0">
      {ledger ? (
        <Link href={`/finance/customers/${r.customer_id}/statement`} className="tap-link max-w-full truncate font-medium text-primary underline-offset-4 hover:underline">
          {r.customer_name ?? "—"}
        </Link>
      ) : (
        <span className="block truncate font-medium">{r.customer_name ?? "—"}</span>
      )}
      <span className="block text-xs text-muted-foreground">{[r.territory_code, localizedName(locale, r.rep_name_en, r.rep_name_ar)].filter(Boolean).join(" · ")}</span>
    </span>
  );

  const columns: DataTableColumn<AgingRow>[] = [
    { id: "customer", header: t("aging.customer"), accessor: (r) => r.customer_name, cell: customer, sortable: true, primary: true, className: "min-w-48" },
    ...AGING_BUCKETS.map(
      (b): DataTableColumn<AgingRow> => ({
        id: b,
        header: t(`aging.buckets.${b}`),
        accessor: (r) => toNumber(r[BUCKET_COLUMN[b]] as Numeric),
        cell: (r) => bucketCell(r, b),
        sortable: true,
        align: "end",
      }),
    ),
    { id: "total", header: t("aging.totalOpen"), accessor: (r) => toNumber(r.total_open), cell: (r) => <Amount strong>{money(r.total_open)}</Amount>, sortable: true, align: "end" },
    {
      id: "unapplied",
      header: t("aging.unapplied"),
      accessor: (r) => toNumber(r.unapplied_credit),
      cell: (r) => (toNumber(r.unapplied_credit) > 0 ? <Amount>{money(r.unapplied_credit)}</Amount> : <span className="text-muted-foreground">—</span>),
      align: "end",
    },
  ];

  return (
    <UrlDataTable
      spec={AGING_LIST}
      rowCount={total}
      columns={columns}
      data={rows}
      getRowId={(r) => r.customer_id}
      searchPlaceholder={t("aging.searchPlaceholder")}
      caption={t("aging.title")}
      error={error}
      empty={<EmptyState icon={<ReceiptIcon aria-hidden="true" />} title={t("aging.empty")} />}
      mobileCard={(r) => (
        <div className="space-y-2 text-sm">
          <div className="flex items-start justify-between gap-2">
            {customer(r)}
            <Amount strong>{money(r.total_open)}</Amount>
          </div>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
            {AGING_BUCKETS.filter((b) => toNumber(r[BUCKET_COLUMN[b]] as Numeric) > 0).map((b) => (
              <div key={b} className="contents">
                <dt className="text-muted-foreground">{t(`aging.buckets.${b}`)}</dt>
                <dd className="text-end">{bucketCell(r, b)}</dd>
              </div>
            ))}
          </dl>
          {ledger ? (
            <Link href={`/finance/customers/${r.customer_id}/statement`} className="inline-flex min-h-11 items-center text-primary underline-offset-4 hover:underline">
              {t("aging.statement")}
            </Link>
          ) : null}
        </div>
      )}
    />
  );
}
