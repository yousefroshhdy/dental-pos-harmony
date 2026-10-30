import { getTranslations } from "next-intl/server";

/** Shown while a commission page loads its statement or periods. */
export default async function CommissionsLoading() {
  const t = await getTranslations("commissions");
  return (
    <div role="status" aria-live="polite" className="space-y-3">
      <p className="text-sm text-muted-foreground">{t("loading")}</p>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-20 animate-pulse rounded-lg border bg-muted" aria-hidden="true" />
        ))}
      </div>
      <div className="h-48 animate-pulse rounded-lg border bg-muted" aria-hidden="true" />
    </div>
  );
}
