import { getFormatter, getTranslations } from "next-intl/server";
import { Badge, Card } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { formatDay, formatEgp, formatRate } from "../format";
import { kindTone, sortLines, toNumber } from "../logic";
import type { StatementLine, SummaryRow } from "../types";

/** Earned, clawed back, adjustments and total of one employee and month (api.v_commission_summary). */
export async function StatementTotals({ summary }: { summary: SummaryRow | null }) {
  const t = await getTranslations("commissions.statement.totals");
  const format = await getFormatter();
  const tiles = [
    { key: "earned", value: summary?.earned ?? 0 },
    { key: "clawedBack", value: summary?.clawed_back ?? 0 },
    { key: "adjustments", value: summary?.adjustments ?? 0 },
    { key: "total", value: summary?.total ?? 0 },
  ] as const;
  return (
    <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {tiles.map((tile) => (
        <Card key={tile.key} className={tile.key === "total" ? "border-primary/50" : undefined}>
          <dt className="text-xs text-muted-foreground">{t(tile.key)}</dt>
          <dd className="mt-1 text-lg font-semibold tabular-nums">{formatEgp(format, tile.value)}</dd>
        </Card>
      ))}
    </dl>
  );
}

/**
 * Statement lines with their source documents. A list (not a wide table) so it reads on
 * a 360 px phone: kind, invoice and customer, product, payment or credit note, day,
 * base × rate and the signed amount. Invoice links show only to invoice readers.
 */
export async function StatementLines({ lines, canOpenInvoices }: { lines: readonly StatementLine[]; canOpenInvoices: boolean }) {
  const t = await getTranslations("commissions.statement");
  const tk = await getTranslations("commissions.kind");
  const format = await getFormatter();
  const sorted = sortLines(lines);

  if (sorted.length === 0) return <p className="text-sm text-muted-foreground">{t("empty")}</p>;

  return (
    <ul className="divide-y rounded-lg border bg-card" aria-label={t("lines")}>
      {sorted.map((line) => {
        const amount = toNumber(line.amount) ?? 0;
        return (
          <li key={`${line.line_type}-${line.id}`} className="flex flex-col gap-1 px-3 py-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={kindTone(line.kind)}>{tk(line.kind)}</Badge>
                <span className="text-xs text-muted-foreground">{formatDay(format, line.event_date)}</span>
              </div>
              {line.line_type === "entry" ? (
                <>
                  <p className="text-sm font-medium break-words">
                    {line.invoice_id && line.invoice_no && canOpenInvoices ? (
                      <Link href={`/finance/invoices/${line.invoice_id}`} className="text-primary underline-offset-4 hover:underline">
                        {line.invoice_no}
                      </Link>
                    ) : (
                      <span dir="ltr">{line.invoice_no ?? "—"}</span>
                    )}
                    {line.customer_name ? <span className="text-muted-foreground"> · {line.customer_name}</span> : null}
                  </p>
                  <p className="text-xs text-muted-foreground break-words">
                    {line.description ?? "—"}
                    {line.sku ? (
                      <span dir="ltr" className="ms-1">
                        ({line.sku})
                      </span>
                    ) : null}
                    {line.document_no ? (
                      <span className="ms-1">
                        · {t(line.source_type === "credit_note" ? "creditNote" : "payment")}{" "}
                        <span dir="ltr">{line.document_no}</span>
                      </span>
                    ) : null}
                  </p>
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {t("baseTimesRate", { base: formatEgp(format, line.base_amount), rate: formatRate(format, line.rate_pct) })}
                  </p>
                </>
              ) : (
                <p className="text-sm break-words">{line.reason ?? "—"}</p>
              )}
            </div>
            <p className={`shrink-0 text-base font-semibold tabular-nums sm:text-end ${amount < 0 ? "text-destructive" : ""}`}>
              {formatEgp(format, line.amount)}
            </p>
          </li>
        );
      })}
    </ul>
  );
}
