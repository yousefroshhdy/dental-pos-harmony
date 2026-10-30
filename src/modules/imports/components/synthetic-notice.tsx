import { getTranslations } from "next-intl/server";

/**
 * D-03: until the PDPL legal review clears real personal data, only synthetic data may
 * be imported. Shown on every import screen; it is a reminder, not a technical control.
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
