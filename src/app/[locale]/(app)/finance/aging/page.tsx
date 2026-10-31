import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { Card, Table, Td, Th } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { FinanceError } from "@/modules/finance/components/finance-error";
import { financeErrorCode, localizedName, toNumber, withQuery } from "@/modules/finance/logic";
import { getAgingTotals, listAging } from "@/modules/finance/queries";
import { ExportCsvButton } from "@/modules/reports/components/export-csv-button";
import { AGING_BUCKETS, type AgingBucket, type AgingRow } from "@/modules/finance/types";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "finance.aging" });
  return { title: t("title") };
}

const COLUMN: Record<AgingBucket, keyof AgingRow> = {
  current: "current_amount",
  d1_30: "d1_30",
  d31_60: "d31_60",
  d61_90: "d61_90",
  d90_plus: "d90_plus",
};

/** Receivables aging on the Cairo business day, per customer, with drill-down to the invoices of a bucket. */
export default async function AgingPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!can(ctx, "finance.page.aging") && !can(ctx, "finance.ledger.read")) return <Forbidden />;

  const t = await getTranslations("finance");
  const format = await getFormatter();
  const money = (v: unknown) => format.number(toNumber(v as number | string), "egp");
  const [rows, totals] = await Promise.all([listAging(), getAgingTotals()]);
  const ledger = can(ctx, "finance.ledger.read");

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-semibold">{t("aging.title")}</h1>
        {/* The aging has no list filters: the file covers what the page shows. */}
        <ExportCsvButton ctx={ctx} kind="aging" label={t("aging.export")} />
      </div>
      <p className="text-sm text-muted-foreground">{t("aging.help")}</p>

      {totals.ok && totals.data ? (
        <Card className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4 lg:grid-cols-7">
          {AGING_BUCKETS.map((b) => (
            <Total key={b} label={t(`aging.buckets.${b}`)} value={money(totals.data?.[COLUMN[b] as keyof typeof totals.data])} />
          ))}
          <Total label={t("aging.totalOpen")} value={money(totals.data.total_open)} strong />
          <Total label={t("aging.unapplied")} value={money(totals.data.unapplied_credit)} />
        </Card>
      ) : null}

      {!rows.ok ? (
        <FinanceError code={financeErrorCode(rows.error)} requestId={rows.error.requestId} />
      ) : rows.data.length === 0 ? (
        <Card className="text-sm text-muted-foreground">{t("aging.empty")}</Card>
      ) : (
        <>
          {/* Phones: one card per customer */}
          <ul className="space-y-2 sm:hidden">
            {rows.data.map((r) => (
              <li key={r.customer_id} className="space-y-2 rounded-lg border bg-card p-3 text-sm">
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{r.customer_name ?? "—"}</span>
                    <span className="block text-xs text-muted-foreground">{localizedName(locale, r.rep_name_en, r.rep_name_ar)}</span>
                  </span>
                  <span className="font-semibold whitespace-nowrap">{money(r.total_open)}</span>
                </div>
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
                  {AGING_BUCKETS.filter((b) => toNumber(r[COLUMN[b]] as number | string) > 0).map((b) => (
                    <div key={b} className="contents">
                      <dt className="text-muted-foreground">{t(`aging.buckets.${b}`)}</dt>
                      <dd className="text-end">
                        <Link href={withQuery("/finance/invoices", { customer: r.customer_id, bucket: b })} className="text-primary underline-offset-4 hover:underline">
                          {money(r[COLUMN[b]])}
                        </Link>
                      </dd>
                    </div>
                  ))}
                </dl>
                {ledger ? (
                  <Link href={`/finance/customers/${r.customer_id}/statement`} className="inline-flex min-h-11 items-center text-primary underline-offset-4 hover:underline">
                    {t("aging.statement")}
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>

          {/* Wider screens: the classic aging table */}
          <div className="hidden sm:block">
            <Table>
              <thead>
                <tr>
                  <Th>{t("aging.customer")}</Th>
                  {AGING_BUCKETS.map((b) => (
                    <Th key={b} className="text-end">
                      {t(`aging.buckets.${b}`)}
                    </Th>
                  ))}
                  <Th className="text-end">{t("aging.totalOpen")}</Th>
                  <Th className="text-end">{t("aging.unapplied")}</Th>
                </tr>
              </thead>
              <tbody>
                {rows.data.map((r) => (
                  <tr key={r.customer_id}>
                    <Td>
                      {ledger ? (
                        <Link href={`/finance/customers/${r.customer_id}/statement`} className="font-medium text-primary underline-offset-4 hover:underline">
                          {r.customer_name ?? "—"}
                        </Link>
                      ) : (
                        <span className="font-medium">{r.customer_name ?? "—"}</span>
                      )}
                      <span className="block text-xs text-muted-foreground">
                        {[r.territory_code, localizedName(locale, r.rep_name_en, r.rep_name_ar)].filter(Boolean).join(" · ")}
                      </span>
                    </Td>
                    {AGING_BUCKETS.map((b) => (
                      <Td key={b} className="text-end whitespace-nowrap">
                        {toNumber(r[COLUMN[b]] as number | string) > 0 ? (
                          <Link href={withQuery("/finance/invoices", { customer: r.customer_id, bucket: b })} className="text-primary underline-offset-4 hover:underline">
                            {money(r[COLUMN[b]])}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </Td>
                    ))}
                    <Td className="text-end font-semibold whitespace-nowrap">{money(r.total_open)}</Td>
                    <Td className="text-end whitespace-nowrap">{toNumber(r.unapplied_credit) > 0 ? money(r.unapplied_credit) : "—"}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        </>
      )}
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
