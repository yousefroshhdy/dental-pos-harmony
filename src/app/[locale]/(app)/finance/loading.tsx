import { getTranslations } from "next-intl/server";

/** Shown while a finance page loads its data. */
export default async function FinanceLoading() {
  const t = await getTranslations("finance");
  return (
    <div role="status" aria-live="polite" className="space-y-3">
      <p className="text-sm text-muted-foreground">{t("loading")}</p>
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-16 animate-pulse rounded-lg border bg-muted" aria-hidden="true" />
      ))}
    </div>
  );
}
