import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { Forbidden } from "@/components/forbidden";
import { PrinterIcon, WalletIcon } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Alert, Badge, Card, CardTitle, Table, Td, Th } from "@/components/ui/primitives";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Link } from "@/i18n/navigation";
import { directionOf } from "@/i18n/routing";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { BackLink, Field } from "@/modules/finance/components/bits";
import { FinanceError } from "@/modules/finance/components/finance-error";
import { CreditNoteForm } from "@/modules/finance/components/invoice-forms";
import { CAIRO_DATE, CAIRO_DATE_TIME, dateOnly, PERCENT, QUANTITY } from "@/modules/finance/format";
import { WriteOffForm } from "@/modules/finance/components/write-off-form";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { isBonusLine, vatBasisKey, vatSummary } from "@/modules/finance/print";
import {
  canCreditInvoice,
  canWriteOffInvoice,
  financeErrorCode,
  invoiceStatusTone,
  isUuid,
  localizedName,
  toCents,
  toNumber,
} from "@/modules/finance/logic";
import {
  getInvoice,
  listAllocationsForInvoice,
  listCreditNotes,
  listInvoiceLines,
  listInvoiceWriteOffs,
  listPendingCreditRequests,
  listPendingWriteOffRequests,
} from "@/modules/finance/queries";

type Params = Promise<{ locale: string; invoiceId: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "finance.invoice" });
  return { title: t("metaTitle") };
}

export default async function InvoiceDetailPage({ params, searchParams }: { params: Params; searchParams: Promise<{ issued?: string }> }) {
  const { locale, invoiceId } = await params;
  setRequestLocale(locale);
  if (!isUuid(invoiceId)) notFound();
  const ctx = await getUserContext();
  if (!can(ctx, "finance.invoice.read")) return <Forbidden />;

  const [invoice, lines, allocations, credits, pending, writeOffs, pendingWriteOffs] = await Promise.all([
    getInvoice(invoiceId),
    listInvoiceLines(invoiceId),
    listAllocationsForInvoice(invoiceId),
    listCreditNotes(invoiceId),
    listPendingCreditRequests(invoiceId),
    listInvoiceWriteOffs(invoiceId),
    listPendingWriteOffRequests(invoiceId),
  ]);
  if (!invoice.ok) return <FinanceError code={financeErrorCode(invoice.error)} requestId={invoice.error.requestId} />;
  if (!invoice.data) notFound();
  if (!lines.ok) return <FinanceError code={financeErrorCode(lines.error)} requestId={lines.error.requestId} />;

  const inv = invoice.data;
  const t = await getTranslations("finance");
  const format = await getFormatter();
  const money = (v: number | string | null) => format.number(toNumber(v), "egp");
  const issued = Boolean((await searchParams).issued);
  const pendingRequests = pending.ok ? pending.data : [];
  const showCredit = canCreditInvoice(ctx, inv);
  const pendingWriteOffRequests = pendingWriteOffs.ok ? pendingWriteOffs.data : [];
  const postedWriteOffs = writeOffs.ok ? writeOffs.data : [];
  // Without the pending list we cannot tell whether a request is already waiting; the server refuses a second one anyway.
  const showWriteOff = pendingWriteOffs.ok && canWriteOffInvoice(ctx, inv, pendingWriteOffRequests.length);
  const showWriteOffSection =
    showWriteOff || postedWriteOffs.length > 0 || pendingWriteOffRequests.length > 0 || toCents(inv.written_off) > 0 || !writeOffs.ok;
  // Display only: the same cents grouping the printed invoice uses, over the stored line amounts.
  const vatGroups = vatSummary(lines.data);
  const canCollect = can(ctx, "finance.payment.record") && toCents(inv.open_amount) > 0;
  const creditCount = (credits.ok ? credits.data.length : 0) + pendingRequests.length;

  return (
    <div className="space-y-6 pb-6">
      <PageHeader
        eyebrow={<BackLink href="/finance/invoices" label={t("invoice.back")} />}
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span dir="ltr">{inv.invoice_no}</span>
            <Badge tone={invoiceStatusTone(inv.status, inv.is_overdue)} className="text-sm">
              {t(`invoiceStatus.${inv.status}`)}
            </Badge>
            {inv.is_overdue ? (
              <Badge tone="danger" className="text-sm">
                {t("invoices.overdueDays", { count: inv.days_overdue })}
              </Badge>
            ) : null}
          </span>
        }
        description={inv.customer_name ?? "—"}
        actions={
          <>
            <Link href={`/finance/invoices/${inv.id}/print`} className={buttonVariants({ variant: "outline" })}>
              <PrinterIcon aria-hidden="true" />
              {t("print.printInvoice")}
            </Link>
            {canCollect ? (
              <Link href={`/finance/payments/new?customer=${inv.customer_id}`} className={buttonVariants()}>
                <WalletIcon aria-hidden="true" />
                {t("invoice.collect")}
              </Link>
            ) : null}
          </>
        }
      />

      {issued ? (
        <Alert tone="success" role="status">
          {t("invoice.issuedOk")}
        </Alert>
      ) : null}

      <section aria-label={t("invoice.summaryLabel")} className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile label={t("invoice.total")} value={money(inv.total)} />
        <Tile label={t("invoice.paid")} value={money(inv.allocated)} />
        <Tile label={t("invoice.open")} value={money(inv.open_amount)} strong={toCents(inv.open_amount) > 0} danger={inv.is_overdue} />
        <Tile label={t("invoice.dueDate")} value={format.dateTime(dateOnly(inv.due_date), CAIRO_DATE)} danger={inv.is_overdue} />
      </section>

      <Card className="grid gap-3 text-sm sm:grid-cols-3">
        <Field label={t("invoice.issueDate")} value={format.dateTime(dateOnly(inv.issue_date), CAIRO_DATE)} />
        <Field label={t("invoice.dueDate")} value={format.dateTime(dateOnly(inv.due_date), CAIRO_DATE)} />
        <Field
          label={t("invoice.order")}
          value={
            inv.order_id ? (
              <Link href={`/orders/${inv.order_id}`} className="tap-link text-primary underline-offset-4 hover:underline" dir="ltr">
                {inv.order_no ?? t("invoice.openOrder")}
              </Link>
            ) : (
              "—"
            )
          }
        />
        <Field label={t("invoice.rep")} value={localizedName(locale, inv.rep_name_en, inv.rep_name_ar) || "—"} />
        <Field label={t("invoice.eta")} value={inv.eta_status ? t(`etaStatus.${inv.eta_status}`) : t("invoice.etaNone")} />
        {can(ctx, "finance.ledger.read") ? (
          <Field
            label={t("invoice.customer")}
            value={
              <Link href={`/finance/customers/${inv.customer_id}/statement`} className="tap-link text-primary underline-offset-4 hover:underline">
                {t("invoice.statement")}
              </Link>
            }
          />
        ) : null}
      </Card>

      <Tabs defaultValue="lines" dir={directionOf(locale)}>
        <TabsList aria-label={t("invoice.tabsLabel")}>
          <TabsTrigger value="lines">{t("invoice.tabs.lines", { count: lines.data.length })}</TabsTrigger>
          <TabsTrigger value="payments">{t("invoice.tabs.payments", { count: allocations.ok ? allocations.data.length : 0 })}</TabsTrigger>
          <TabsTrigger value="credits">{t("invoice.tabs.credits", { count: creditCount })}</TabsTrigger>
          {showWriteOffSection ? <TabsTrigger value="writeoffs">{t("writeOff.section")}</TabsTrigger> : null}
        </TabsList>
        <TabsContent value="lines" className="space-y-4">
          <section className="space-y-3" aria-labelledby="invoice-lines">
            <h2 id="invoice-lines" className="sr-only">
              {t("invoice.lines")}
            </h2>
            <ul className="space-y-2 md:hidden">
              {lines.data.map((l) => (
                <li key={l.invoice_item_id} className={cn("rounded-lg border bg-card p-3 text-sm", isBonusLine(l) && "border-success/40 bg-success/5")}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-0.5">
                      <p dir="ltr" className="text-start font-medium">
                        {l.sku ?? "—"}
                      </p>
                      <p className="text-xs break-words text-muted-foreground">{l.description}</p>
                      {isBonusLine(l) ? <Badge tone="success">{t("lines.bonus")}</Badge> : null}
                      {l.credited_qty > 0 ? <p className="text-xs text-muted-foreground">{t("lines.credited", { count: l.credited_qty })}</p> : null}
                    </div>
                    <p className="font-semibold whitespace-nowrap tabular-nums">{money(l.line_total)}</p>
                  </div>
                  <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                    <dt className="text-muted-foreground">{t("lines.qty")}</dt>
                    <dd className="text-end tabular-nums">{format.number(l.quantity, QUANTITY)}</dd>
                    <dt className="text-muted-foreground">{t("lines.unitPrice")}</dt>
                    <dd className="text-end tabular-nums">{isBonusLine(l) ? t("lines.free") : money(l.unit_price)}</dd>
                    <dt className="text-muted-foreground">{t("lines.discount")}</dt>
                    <dd className="text-end tabular-nums">{money(l.discount)}</dd>
                    <dt className="text-muted-foreground">{t("lines.vat")}</dt>
                    <dd className="text-end tabular-nums">
                      {money(l.tax_amount)} <span className="text-muted-foreground">({format.number(toNumber(l.tax_rate_pct), PERCENT)}%)</span>
                    </dd>
                  </dl>
                </li>
              ))}
            </ul>
            <Table containerClassName="hidden md:block">
              <thead>
                <tr>
                  <Th>{t("lines.sku")}</Th>
                  <Th className="text-end">{t("lines.qty")}</Th>
                  <Th className="text-end">{t("lines.unitPrice")}</Th>
                  <Th className="text-end">{t("lines.discount")}</Th>
                  <Th className="text-end">{t("lines.vat")}</Th>
                  <Th className="text-end">{t("lines.total")}</Th>
                </tr>
              </thead>
              <tbody>
                {lines.data.map((l) => (
                  <tr key={l.invoice_item_id}>
                    <Td>
                      <span dir="ltr" className="font-medium">
                        {l.sku ?? "—"}
                      </span>
                      <span className="block text-xs text-muted-foreground">{l.description}</span>
                      {isBonusLine(l) ? <Badge tone="success">{t("lines.bonus")}</Badge> : null}
                      {l.credited_qty > 0 ? (
                        <span className="block text-xs text-muted-foreground">{t("lines.credited", { count: l.credited_qty })}</span>
                      ) : null}
                    </Td>
                    <Td className="text-end">{format.number(l.quantity, QUANTITY)}</Td>
                    <Td className="text-end whitespace-nowrap tabular-nums">{isBonusLine(l) ? t("lines.free") : money(l.unit_price)}</Td>
                    <Td className="text-end whitespace-nowrap">{money(l.discount)}</Td>
                    <Td className="text-end whitespace-nowrap">
                      {money(l.tax_amount)}
                      <span className="block text-xs text-muted-foreground">{format.number(toNumber(l.tax_rate_pct), PERCENT)}%</span>
                    </Td>
                    <Td className="text-end font-medium whitespace-nowrap">{money(l.line_total)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </section>

          <div className="grid gap-3 sm:grid-cols-2 sm:items-start">
            <Card className="space-y-1.5 text-sm">
              <CardTitle className="text-base">{t("print.vatSummary")}</CardTitle>
              <p className="rounded-md bg-muted px-2 py-1 text-xs font-medium">{t(`print.${vatBasisKey()}`)}</p>
              {vatGroups.length === 0 ? (
                <p className="text-muted-foreground">—</p>
              ) : (
                vatGroups.map((g) => (
                  <div key={g.rate} className="flex justify-between gap-4 text-xs">
                    <span className="text-muted-foreground">{t("invoice.vatAtRate", { rate: format.number(g.rate, PERCENT), taxable: money(g.taxable) })}</span>
                    <span className="whitespace-nowrap tabular-nums">{money(g.vat)}</span>
                  </div>
                ))
              )}
            </Card>
            <Card className="grid gap-2 text-sm">
              <Row label={t("invoice.subtotal")} value={money(inv.subtotal)} />
              <Row label={t("invoice.discount")} value={`− ${money(inv.discount_total)}`} />
              <Row label={t("invoice.vat")} value={money(inv.tax_total)} />
              <Row label={t("invoice.total")} value={money(inv.total)} strong />
              <Row label={t("invoice.paid")} value={`− ${money(inv.allocated)}`} />
              <Row label={t("invoice.credited")} value={`− ${money(inv.credited)}`} />
              {toCents(inv.written_off) > 0 ? <Row label={t("invoice.writtenOff")} value={`− ${money(inv.written_off)}`} /> : null}
              <Row label={t("invoice.open")} value={money(inv.open_amount)} strong />
            </Card>
          </div>
        </TabsContent>
        <TabsContent value="payments">
          <section className="space-y-3" aria-labelledby="invoice-payments">
            <h2 id="invoice-payments" className="sr-only">
              {t("invoice.payments")}
            </h2>
            {!allocations.ok ? (
              <FinanceError code={financeErrorCode(allocations.error)} requestId={allocations.error.requestId} />
            ) : allocations.data.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("invoice.noPayments")}</p>
            ) : (
              <ul className="space-y-2">
                {allocations.data.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card p-3 text-sm">
                    <Link href={`/finance/payments/${a.payment_id}`} className="min-h-11 content-center text-primary underline-offset-4 hover:underline" dir="ltr">
                      {a.payment_no ?? t("invoice.payment")}
                    </Link>
                    <span className="text-muted-foreground">{format.dateTime(new Date(a.allocated_at), CAIRO_DATE_TIME)}</span>
                    <span className={toNumber(a.amount) < 0 ? "font-medium text-destructive" : "font-medium"}>
                      {money(a.amount)}
                      {toNumber(a.amount) < 0 ? <span className="ms-1 text-xs">({t("invoice.reversal")})</span> : null}
                      {a.is_reversed ? <span className="ms-1 text-xs text-muted-foreground">({t("invoice.reversed")})</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </TabsContent>
        <TabsContent value="credits">
          <section className="space-y-3" aria-labelledby="invoice-credits">
            <h2 id="invoice-credits" className="sr-only">
              {t("invoice.creditNotes")}
            </h2>
            {credits.ok && credits.data.length > 0 ? (
              <ul className="space-y-2">
                {credits.data.map((c) => (
                  <li key={c.id} className="flex flex-col gap-1 rounded-lg border bg-card p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                    <span dir="ltr" className="font-medium">
                      {c.credit_no}
                    </span>
                    <span className="text-muted-foreground">{c.reason}</span>
                    <span className="font-medium">{money(c.total)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">{t("invoice.noCredits")}</p>
            )}
            {pendingRequests.map((r) => (
              <Alert key={r.request_id} tone="info" role="status" className="flex flex-wrap items-center justify-between gap-2">
                <span>{t("invoice.creditPending", { amount: money(toNumber(r.payload?.total as number | string | undefined)) })}</span>
                <Link href={`/approvals/${r.request_id}`} className="inline-flex min-h-11 items-center text-primary underline-offset-4 hover:underline">
                  {t("invoice.openApproval")}
                </Link>
              </Alert>
            ))}
            {showCredit ? (
              <Card className="space-y-3">
                <CardTitle>{t("credit.title")}</CardTitle>
                <p className="text-sm text-muted-foreground">{t("credit.help")}</p>
                <CreditNoteForm
                  invoiceId={inv.id}
                  locale={locale}
                  lines={lines.data.map((l) => ({
                    invoice_item_id: l.invoice_item_id,
                    quantity: l.quantity,
                    credited_qty: l.credited_qty,
                    label: `${l.sku ?? ""} ${l.description}`.trim(),
                  }))}
                />
              </Card>
            ) : null}
          </section>
        </TabsContent>
        <TabsContent value="writeoffs">
          {showWriteOffSection ? (
            <section className="space-y-3" aria-labelledby="invoice-write-offs">
              <h2 id="invoice-write-offs" className="sr-only">
                {t("writeOff.section")}
              </h2>
              {!writeOffs.ok ? (
                <FinanceError code={financeErrorCode(writeOffs.error)} requestId={writeOffs.error.requestId} />
              ) : postedWriteOffs.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("writeOff.none")}</p>
              ) : (
                <ul className="space-y-2">
                  {postedWriteOffs.map((w) => (
                    <li key={w.id} className="flex flex-col gap-1 rounded-lg border bg-card p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                      <span dir="ltr" className="font-medium">
                        {w.write_off_no}
                      </span>
                      <span className="text-muted-foreground">{w.reason}</span>
                      <span className="text-muted-foreground">
                        {t("writeOff.approvedBy", { name: localizedName(locale, w.posted_by_name_en, w.posted_by_name_ar) || "—" })}
                      </span>
                      <span className="font-medium">{money(w.amount)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {pendingWriteOffRequests.map((r) => (
                <Alert key={r.request_id} tone="info" role="status" className="flex flex-wrap items-center justify-between gap-2">
                  <span>{t("writeOff.pending", { amount: money(toNumber(r.payload?.amount as number | string | undefined)) })}</span>
                  <Link href={`/approvals/${r.request_id}`} className="inline-flex min-h-11 items-center text-primary underline-offset-4 hover:underline">
                    {t("invoice.openApproval")}
                  </Link>
                </Alert>
              ))}
              {showWriteOff ? (
                <Card className="space-y-3">
                  <CardTitle>{t("writeOff.title")}</CardTitle>
                  <p className="text-sm text-muted-foreground">{t("writeOff.help")}</p>
                  <WriteOffForm invoiceId={inv.id} locale={locale} openAmount={toNumber(inv.open_amount)} openLabel={money(inv.open_amount)} />
                </Card>
              ) : null}
            </section>
          ) : null}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={strong ? "flex justify-between gap-4 border-t pt-2 font-semibold" : "flex justify-between gap-4"}>
      <span>{label}</span>
      <span className="whitespace-nowrap tabular-nums">{value}</span>
    </div>
  );
}

function Tile({ label, value, strong = false, danger = false }: { label: string; value: string; strong?: boolean; danger?: boolean }) {
  return (
    <div className={cn("rounded-lg border bg-card p-3", danger && "border-destructive/40 bg-destructive/5")}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("tabular-nums", strong ? "text-lg font-semibold" : "font-medium", danger && "text-destructive")}>{value}</div>
    </div>
  );
}
