import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { Forbidden } from "@/components/forbidden";
import { Alert, Badge, Card, CardTitle, Table, Td, Th } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { getUserContext } from "@/lib/authz/context";
import { BackLink, Field } from "@/modules/returns/components/bits";
import { CreditReturnForm, ReceiveReturnForm } from "@/modules/returns/components/return-forms";
import { ReturnsError } from "@/modules/returns/components/returns-error";
import { CAIRO_DATE, CAIRO_DATE_TIME, dateOnly, QUANTITY } from "@/modules/returns/format";
import {
  canCredit,
  canReceive,
  canSeeReturns,
  isUuid,
  localizedName,
  nextStepKey,
  returnErrorCode,
  statusTone,
  toNumber,
} from "@/modules/returns/logic";
import { getReturn, listQuarantineWarehouses, listReturnCreditNotes, listReturnLines } from "@/modules/returns/queries";

type Params = Promise<{ locale: string; returnId: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "returns.detail" });
  return { title: t("metaTitle") };
}

export default async function ReturnDetailPage({ params, searchParams }: { params: Params; searchParams: Promise<{ requested?: string }> }) {
  const { locale, returnId } = await params;
  setRequestLocale(locale);
  if (!isUuid(returnId)) notFound();
  const ctx = await getUserContext();
  if (!canSeeReturns(ctx)) return <Forbidden />;

  const [ret, lines, credits] = await Promise.all([getReturn(returnId), listReturnLines(returnId), listReturnCreditNotes(returnId)]);
  if (!ret.ok) return <ReturnsError code={returnErrorCode(ret.error)} requestId={ret.error.requestId} />;
  if (!ret.data) notFound();
  if (!lines.ok) return <ReturnsError code={returnErrorCode(lines.error)} requestId={lines.error.requestId} />;

  const r = ret.data;
  const t = await getTranslations("returns");
  const format = await getFormatter();
  const money = (v: number | string | null) => format.number(toNumber(v), "egp");
  const at = (v: string | null) => (v ? format.dateTime(new Date(v), CAIRO_DATE_TIME) : "—");
  const requested = Boolean((await searchParams).requested);
  const showReceive = canReceive(ctx, r);
  const showCredit = canCredit(ctx, r);
  const warehouses = showReceive ? await listQuarantineWarehouses() : null;
  const next = nextStepKey(r.status);

  return (
    <div className="space-y-6 pb-6">
      <div className="space-y-2">
        <BackLink href="/returns" label={t("detail.back")} />
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold">
            <span dir="ltr">{r.return_no}</span>
          </h1>
          <Badge tone={statusTone(r.status)}>{t(`status.${r.status}`)}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">{r.customer_name ?? "—"}</p>
      </div>

      {requested ? (
        <Alert tone="success" role="status">
          {t("detail.requestedOk")}
        </Alert>
      ) : null}
      <Alert tone="info" role="status">
        {t(`next.${next}`)}
      </Alert>

      <Card className="grid gap-3 text-sm sm:grid-cols-3">
        <Field
          label={t("detail.order")}
          value={
            <Link href={`/orders/${r.order_id}`} className="text-primary underline-offset-4 hover:underline" dir="ltr">
              {r.order_no ?? t("detail.openOrder")}
            </Link>
          }
        />
        <Field label={t("detail.rep")} value={localizedName(locale, r.rep_name_en, r.rep_name_ar) || "—"} />
        <Field label={t("detail.requestedBy")} value={localizedName(locale, r.requested_by_name_en, r.requested_by_name_ar) || "—"} />
        <Field label={t("detail.requestedAt")} value={at(r.created_at)} />
        <Field label={t("detail.decidedAt")} value={at(r.decided_at)} />
        <Field
          label={t("detail.approval")}
          value={
            r.approval_request_id ? (
              <Link href={`/approvals/${r.approval_request_id}`} className="text-primary underline-offset-4 hover:underline">
                {r.approval_status ? t(`approvalStatus.${r.approval_status}`) : t("detail.openApproval")}
              </Link>
            ) : (
              "—"
            )
          }
        />
        <Field label={t("detail.warehouse")} value={r.warehouse_code ? `${r.warehouse_code} — ${r.warehouse_name ?? ""}` : "—"} />
        <Field label={t("detail.receivedAt")} value={at(r.received_at)} />
        <Field label={t("detail.creditedAt")} value={at(r.credited_at)} />
        {r.notes ? (
          <div className="sm:col-span-3">
            <Field label={t("detail.notes")} value={r.notes} />
          </div>
        ) : null}
      </Card>

      <section className="space-y-3" aria-labelledby="return-lines">
        <CardTitle id="return-lines">{t("detail.lines")}</CardTitle>
        {lines.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("detail.noLines")}</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>{t("lines.sku")}</Th>
                <Th>{t("lines.lot")}</Th>
                <Th className="text-end">{t("lines.qty")}</Th>
                <Th>{t("lines.reason")}</Th>
                <Th className="text-end">{t("lines.estimate")}</Th>
              </tr>
            </thead>
            <tbody>
              {lines.data.map((l) => (
                <tr key={l.return_item_id}>
                  <Td>
                    <span dir="ltr" className="font-medium">
                      {l.sku ?? "—"}
                    </span>
                    <span className="block text-xs text-muted-foreground">{l.variant_name}</span>
                  </Td>
                  <Td>
                    <span dir="ltr">{l.lot_no ?? "—"}</span>
                    {l.expiry_date ? (
                      <span className="block text-xs text-muted-foreground">{format.dateTime(dateOnly(l.expiry_date), CAIRO_DATE)}</span>
                    ) : null}
                  </Td>
                  <Td className="text-end">
                    {format.number(l.quantity, QUANTITY)}
                    {l.credited_qty > 0 ? (
                      <span className="block text-xs text-muted-foreground">{t("lines.credited", { count: l.credited_qty })}</span>
                    ) : null}
                  </Td>
                  <Td>
                    {l.reason_code ? t(`reasons.${l.reason_code}`) : "—"}
                    <span className="block text-xs text-muted-foreground">{t(`conditions.${l.condition}`)}</span>
                  </Td>
                  <Td className="text-end whitespace-nowrap">{money(l.estimated_total)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <p className="text-xs text-muted-foreground">{t("detail.estimateHelp")}</p>
      </section>

      <section className="space-y-3" aria-labelledby="return-credits">
        <CardTitle id="return-credits">{t("detail.creditNotes")}</CardTitle>
        {!credits.ok ? (
          <ReturnsError code={returnErrorCode(credits.error)} requestId={credits.error.requestId} />
        ) : credits.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("detail.noCredits")}</p>
        ) : (
          <ul className="space-y-2">
            {credits.data.map((c) => (
              <li key={c.id} className="flex flex-col gap-1 rounded-lg border bg-card p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                <span dir="ltr" className="font-medium">
                  {c.credit_no}
                </span>
                <Link href={`/finance/invoices/${c.invoice_id}`} className="inline-flex min-h-11 items-center text-primary underline-offset-4 hover:underline" dir="ltr">
                  {c.invoice_no ?? t("detail.openInvoice")}
                </Link>
                <span className="text-muted-foreground">{t("detail.creditSplit", { amount: money(c.amount), vat: money(c.tax_amount) })}</span>
                <span className="font-medium">{money(c.total)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {showReceive ? (
        <Card className="space-y-3">
          <CardTitle>{t("receive.title")}</CardTitle>
          <p className="text-sm text-muted-foreground">{t("receive.intro")}</p>
          {warehouses && !warehouses.ok ? (
            <ReturnsError code={returnErrorCode(warehouses.error)} requestId={warehouses.error.requestId} />
          ) : (
            <ReceiveReturnForm returnId={r.id} warehouses={warehouses?.ok ? warehouses.data : []} />
          )}
        </Card>
      ) : null}

      {showCredit ? (
        <Card className="space-y-3">
          <CardTitle>{t("credit.title")}</CardTitle>
          <p className="text-sm text-muted-foreground">{t("credit.intro", { amount: money(r.estimated_total) })}</p>
          <CreditReturnForm returnId={r.id} />
        </Card>
      ) : null}
    </div>
  );
}
