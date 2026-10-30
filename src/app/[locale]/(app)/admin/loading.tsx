import { getTranslations } from "next-intl/server";

/** Shown while an admin page loads its views. */
export default async function AdminLoading() {
  const t = await getTranslations("admin.common");
  return (
    <div role="status" aria-live="polite" className="space-y-3">
      <span className="sr-only">{t("loading")}</span>
      <div className="h-8 w-48 animate-pulse rounded-md bg-muted" />
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-24 animate-pulse rounded-lg border bg-card" />
      ))}
    </div>
  );
}
