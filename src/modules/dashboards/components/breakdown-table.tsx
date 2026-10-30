import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { Card, CardTitle, Table, Td, Th } from "@/components/ui/primitives";
import { formatKpi } from "../format";
import { barPercent, maxOf, type BreakdownEntry } from "../logic";
import type { KpiCode, KpiUnit } from "../types";

/**
 * Totals by territory or brand as a table (the accessible "table view"), with one
 * single-series CSS bar in the column the panel is about. Bars grow from the start
 * edge, so RTL flips them with the text; the value is always printed beside the bar.
 */
export async function BreakdownTable({
  title,
  dimensionLabel,
  entries,
  columns,
  barCode,
  emptyText,
}: {
  title: string;
  dimensionLabel: string;
  entries: readonly BreakdownEntry[];
  columns: readonly { code: KpiCode; unit: KpiUnit }[];
  barCode: KpiCode;
  emptyText: string;
}) {
  const t = await getTranslations("dashboards");
  const format = await getFormatter();
  const locale = await getLocale();
  const max = maxOf(entries, barCode);

  return (
    <Card className="space-y-3">
      <CardTitle>{title}</CardTitle>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyText}</p>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th scope="col">{dimensionLabel}</Th>
              {columns.map((c) => (
                <Th key={c.code} scope="col" className="text-end">
                  {t(`kpi.${c.code}.short`)}
                </Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <Th scope="row" className="bg-transparent font-normal">
                  {(locale === "ar" ? e.name_ar : null) ?? e.name_en}
                </Th>
                {columns.map((c) => (
                  <Td key={c.code} className="text-end tabular-nums whitespace-nowrap">
                    {formatKpi(format, c.unit, e.values[c.code] ?? 0)}
                    {c.code === barCode ? (
                      <span aria-hidden="true" className="mt-1 block h-2 min-w-24 bg-primary/10">
                        <span className="block h-full rounded-e-sm bg-primary" style={{ inlineSize: `${barPercent(e.values[c.code] ?? 0, max)}%` }} />
                      </span>
                    ) : null}
                  </Td>
                ))}
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
