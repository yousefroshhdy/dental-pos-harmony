import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { Forbidden } from "@/components/forbidden";
import { Button } from "@/components/ui/button";
import { Card, Input, Label, Table, Td, Th } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { BackLink } from "@/modules/finance/components/bits";
import { FinanceError } from "@/modules/finance/components/finance-error";
import { PrintButton } from "@/modules/finance/components/print-button";
import { CAIRO_DATE, CAIRO_DATE_TIME, dateOnly } from "@/modules/finance/format";
import { cairoToday, documentHref, financeErrorCode, isUuid, parseIsoDate, statementPeriod, toNumber } from "@/modules/finance/logic";
import { getCustomer, listStatement, STATEMENT_LIMIT } from "@/modules/finance/queries";

type Params = Promise<{ locale: string; customerId: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "finance.statement" });
  return { title: t("title") };
}

/** Print rules for this page only: hide the app header and on-screen controls, use the full width. */
const PRINT_CSS = `@media print {
  body > div > header, nav, .print\\:hidden { display: none !important; }
  main { max-width: none !important; padding: 0 !important; }
  table { font-size: 11px; }
  a { color: inherit; text-decoration: none; }
}`;

export default async function StatementPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Promise<{ from?: string | string[]; to?: string | string[] }>;
}) {
  const { locale, customerId } = await params;
  setRequestLocale(locale);
  if (!isUuid(customerId)) notFound();
  const ctx = await getUserContext();
  if (!can(ctx, "finance.ledger.read")) return <Forbidden />;

  const sp = await searchParams;
  const from = parseIsoDate(sp.from);
  const to = parseIsoDate(sp.to);
  const [customer, entries] = await Promise.all([getCustomer(customerId), listStatement(customerId)]);
  if (!customer.ok) return <FinanceError code={financeErrorCode(customer.error)} requestId={customer.error.requestId} />;
  if (!entries.ok) return <FinanceError code={financeErrorCode(entries.error)} requestId={entries.error.requestId} />;
  if (!customer.data && entries.data.length === 0) notFound();

  const t = await getTranslations("finance");
  const format = await getFormatter();
  const money = (v: number | string) => format.number(toNumber(v), "egp");
  const period = statementPeriod(entries.data, from, to);
  const name = customer.data?.display_name ?? entries.data[0]?.customer_name ?? "—";
  const number = customer.data?.customer_no ?? entries.data[0]?.customer_no ?? "";

  return (
    <div className="space-y-4">
      <style>{PRINT_CSS}</style>
      <BackLink href="/finance/aging" label={t("statement.back")} />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{t("statement.title")}</h1>
          <p className="text-sm">
            {name} <span dir="ltr">({number})</span>
          </p>
          <p className="text-xs text-muted-foreground">
            {t("statement.period", {
              from: from ? format.dateTime(dateOnly(from), CAIRO_DATE) : t("statement.beginning"),
              to: format.dateTime(dateOnly(to ?? cairoToday()), CAIRO_DATE),
            })}
          </p>
        </div>
        <PrintButton label={t("statement.print")} />
      </div>

      <form method="get" className="flex flex-col gap-2 sm:flex-row sm:items-end print:hidden">
        <div className="flex flex-col gap-1">
          <Label htmlFor="statement-from">{t("statement.from")}</Label>
          <Input id="statement-from" name="from" type="date" defaultValue={from ?? ""} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="statement-to">{t("statement.to")}</Label>
          <Input id="statement-to" name="to" type="date" defaultValue={to ?? ""} />
        </div>
        <Button type="submit" variant="outline">
          {t("statement.apply")}
        </Button>
      </form>

      <Card className="grid gap-3 text-sm sm:grid-cols-4">
        <Total label={t("statement.opening")} value={money(period.opening)} />
        <Total label={t("statement.debits")} value={money(period.debit)} />
        <Total label={t("statement.credits")} value={money(period.credit)} />
        <Total label={t("statement.closing")} value={money(period.closing)} strong />
      </Card>

      {period.rows.length === 0 ? (
        <Card className="text-sm text-muted-foreground">{t("statement.empty")}</Card>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>{t("statement.date")}</Th>
              <Th>{t("statement.document")}</Th>
              <Th>{t("statement.type")}</Th>
              <Th className="text-end">{t("statement.debit")}</Th>
              <Th className="text-end">{t("statement.credit")}</Th>
              <Th className="text-end">{t("statement.balance")}</Th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <Td colSpan={5} className="text-muted-foreground">
                {t("statement.openingRow")}
              </Td>
              <Td className="text-end whitespace-nowrap">{money(period.opening)}</Td>
            </tr>
            {period.rows.map((r) => {
              const href = documentHref(r);
              return (
                <tr key={r.entry_id}>
                  <Td className="whitespace-nowrap">{format.dateTime(new Date(r.posted_at), CAIRO_DATE_TIME)}</Td>
                  <Td>
                    {href && r.document_no ? (
                      <Link href={href} className="text-primary underline-offset-4 hover:underline" dir="ltr">
                        {r.document_no}
                      </Link>
                    ) : (
                      <span dir="ltr">{r.document_no ?? "—"}</span>
                    )}
                    {r.due_date ? (
                      <span className="block text-xs text-muted-foreground">
                        {t("statement.due", { date: format.dateTime(dateOnly(r.due_date), CAIRO_DATE) })}
                      </span>
                    ) : null}
                  </Td>
                  <Td>{t(`ledgerType.${r.entry_type}`)}</Td>
                  <Td className="text-end whitespace-nowrap">{toNumber(r.debit) > 0 ? money(r.debit) : ""}</Td>
                  <Td className="text-end whitespace-nowrap">{toNumber(r.credit) > 0 ? money(r.credit) : ""}</Td>
                  <Td className="text-end font-medium whitespace-nowrap">{money(r.running_balance)}</Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
      {entries.data.length >= STATEMENT_LIMIT ? <p className="text-sm text-muted-foreground">{t("limited", { count: STATEMENT_LIMIT })}</p> : null}
      <p className="text-xs text-muted-foreground">{t("statement.signNote")}</p>
    </div>
  );
}

function Total({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={strong ? "text-lg font-semibold" : "font-medium"}>{value}</div>
    </div>
  );
}
