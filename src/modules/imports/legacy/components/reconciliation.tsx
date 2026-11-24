import { useFormatter, useTranslations } from "next-intl";
import { Alert, Badge } from "@/components/ui/primitives";
import { reconciliationTally, type ReconRow, type ReconVerdict } from "../flow";

const TONE: Record<ReconVerdict, "success" | "danger" | "neutral"> = { match: "success", mismatch: "danger", info: "neutral" };

/**
 * The workbook's Checks sheet against what the import loads: one card per check (no table, so
 * nothing scrolls sideways at 390 px). Check names and notes come from the converter in English.
 * Used on the server page and in the client upload flow.
 */
export function Reconciliation({ rows }: { rows: readonly ReconRow[] }) {
  const t = useTranslations("legacyImport.recon");
  const format = useFormatter();
  const n = (v: number | null) => (v === null ? "—" : format.number(v, { maximumFractionDigits: 2 }));
  const tally = reconciliationTally(rows);
  return (
    <section aria-labelledby="legacy-recon" className="space-y-3">
      <div className="space-y-1">
        <h2 id="legacy-recon" className="text-lg font-semibold">
          {t("title")}
        </h2>
        <p className="text-sm text-muted-foreground">{t("intro")}</p>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <>
          <Alert tone={tally.mismatch > 0 ? "warning" : "success"} role="status">
            <p className="font-medium">{tally.mismatch > 0 ? t("someMismatch") : t("allMatch")}</p>
            <p className="text-sm tabular-nums">{t("tally", tally)}</p>
          </Alert>
          <ul className="grid gap-2 lg:grid-cols-2">
            {rows.map((r) => (
              <li key={r.check} className="space-y-2 rounded-md border bg-card p-3 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p dir="ltr" className="min-w-0 font-medium break-words">
                    {r.check}
                  </p>
                  <Badge tone={TONE[r.verdict]}>{t(`verdicts.${r.verdict}`)}</Badge>
                </div>
                <dl className="grid grid-cols-3 gap-2 text-center">
                  <div>
                    <dt className="text-xs text-muted-foreground">{t("source")}</dt>
                    <dd className="tabular-nums">{n(r.source)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">{t("converted")}</dt>
                    <dd className="tabular-nums">{n(r.converted)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">{t("difference")}</dt>
                    <dd className={r.verdict === "mismatch" ? "font-semibold text-destructive tabular-nums" : "tabular-nums"}>{n(r.difference)}</dd>
                  </div>
                </dl>
                {r.note ? (
                  <p dir="ltr" className="text-xs break-words text-muted-foreground">
                    {r.note}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
