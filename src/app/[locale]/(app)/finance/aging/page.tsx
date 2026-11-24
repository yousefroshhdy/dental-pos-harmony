import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { PageHeader } from "@/components/ui/page-header";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { FinanceError } from "@/modules/finance/components/finance-error";
import { AgingTable } from "@/modules/finance/components/finance-tables";
import { AGING_LIST } from "@/modules/finance/lists";
import { financeErrorCode, toNumber, withQuery } from "@/modules/finance/logic";
import { getAgingTotals, listAgingPage } from "@/modules/finance/queries";
import { AGING_BUCKETS, type AgingBucket, type AgingTotalsRow } from "@/modules/finance/types";
import { pageRequest } from "@/modules/orders/kit/paging";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { ExportCsvButton } from "@/modules/reports/components/export-csv-button";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "finance.aging" });
  return { title: t("title") };
}

const TOTAL_COLUMN: Record<AgingBucket, keyof AgingTotalsRow> = {
  current: "current_amount",
  d1_30: "d1_30",
  d31_60: "d31_60",
  d61_90: "d61_90",
  d90_plus: "d90_plus",
};

/** Receivables aging on the Cairo business day, per customer, with drill-down to the invoices of a bucket. */
export default async function AgingPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!can(ctx, "finance.page.aging") && !can(ctx, "finance.ledger.read")) return <Forbidden />;

  const t = await getTranslations("finance");
  const format = await getFormatter();
  const money = (v: unknown) => format.number(toNumber(v as number | string), "egp");
  const [rows, totals] = await Promise.all([listAgingPage(pageRequest(await searchParams, AGING_LIST)), getAgingTotals()]);
  const ledger = can(ctx, "finance.ledger.read");

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("aging.title")}
        description={t("aging.help")}
        // The aging has no list filters: the file covers what the page shows.
        actions={<ExportCsvButton ctx={ctx} kind="aging" label={t("aging.export")} />}
      />

      {totals.ok && totals.data ? (
        <section aria-label={t("aging.totalsLabel")} className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
          {AGING_BUCKETS.map((b) => (
            <Tile key={b} label={t(`aging.buckets.${b}`)} value={money(totals.data?.[TOTAL_COLUMN[b]])} tone={b === "d90_plus" || b === "d61_90" ? "danger" : b === "current" ? "neutral" : "warning"} />
          ))}
          <Tile label={t("aging.totalOpen")} value={money(totals.data.total_open)} strong />
          <Tile label={t("aging.unapplied")} value={money(totals.data.unapplied_credit)} />
        </section>
      ) : null}

      <AgingTable
        rows={rows.ok ? rows.data.rows : []}
        total={rows.ok ? rows.data.total : 0}
        ledger={ledger}
        error={rows.ok ? undefined : <FinanceError code={financeErrorCode(rows.error)} requestId={rows.error.requestId} />}
      />
      <p className="text-xs text-muted-foreground">
        <Link href={withQuery("/finance/invoices", { status: "overdue" })} className="inline-flex min-h-11 items-center text-primary underline-offset-4 hover:underline">
          {t("aging.allOverdue")}
        </Link>
      </p>
    </div>
  );
}

function Tile({ label, value, strong = false, tone }: { label: string; value: string; strong?: boolean; tone?: "neutral" | "warning" | "danger" }) {
  return (
    <div className={cn("rounded-lg border bg-card p-3", strong && "border-primary/40 bg-primary/5", tone === "danger" && "border-destructive/30", tone === "warning" && "border-warning/50")}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("tabular-nums", strong ? "text-lg font-semibold" : "font-medium")}>{value}</div>
    </div>
  );
}
