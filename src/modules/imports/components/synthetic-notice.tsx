import { getTranslations } from "next-intl/server";

/**
 * Owner decision A (2026-11-24): HONEST's real data may be loaded into staging; D-03 (PDPL
 * legal review) still gates production. Shown on every import screen; it is a reminder, not a
 * technical control.
 */
export async function SyntheticDataNotice({ compact = false }: { compact?: boolean }) {
  const t = await getTranslations("imports.synthetic");
  return (
    <div role="note" className="rounded-md border border-warning/60 bg-warning/15 px-3 py-2 text-sm">
      <p className="font-semibold">{t("title")}</p>
      {compact ? null : <p className="mt-1">{t("body")}</p>}
    </div>
  );
}
