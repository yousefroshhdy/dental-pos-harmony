import { getTranslations } from "next-intl/server";

/** Shown while the dashboard computes its figures. */
export default async function DashboardLoading() {
  const t = await getTranslations("dashboards");
  return (
    <div role="status" aria-live="polite" className="space-y-3">
      <p className="text-sm text-muted-foreground">{t("loading")}</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-36 animate-pulse rounded-lg border bg-muted" aria-hidden="true" />
        ))}
      </div>
    </div>
  );
}
