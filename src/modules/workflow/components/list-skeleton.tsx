"use client";

import { useTranslations } from "next-intl";

/** Loading placeholder for the workflow screens (route loading.tsx). */
export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  const t = useTranslations("workflow");
  return (
    <div role="status" aria-busy="true" className="space-y-3">
      <span className="sr-only">{t("loading")}</span>
      <div className="h-8 w-48 animate-pulse rounded-md bg-muted" />
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-24 animate-pulse rounded-lg border bg-muted/60" />
      ))}
    </div>
  );
}
