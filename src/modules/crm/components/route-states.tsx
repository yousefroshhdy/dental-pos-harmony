"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/primitives";

/** Skeleton shown while a CRM page loads (route-level loading.tsx). */
export function CrmLoading() {
  const t = useTranslations("crm.state");
  return (
    <div role="status" aria-live="polite" className="space-y-3">
      <span className="sr-only">{t("loading")}</span>
      <div className="h-8 w-48 animate-pulse rounded-md bg-muted" />
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-20 animate-pulse rounded-lg bg-muted" />
      ))}
    </div>
  );
}

/** Route-level error boundary body: no technical detail, only a retry. */
export function CrmRouteError({ reset }: { reset: () => void }) {
  const t = useTranslations("crm.state");
  return (
    <Card role="alert" className="mx-auto max-w-md space-y-3 text-center">
      <h1 className="text-xl font-semibold">{t("errorTitle")}</h1>
      <p className="text-sm text-muted-foreground">{t("errorBody")}</p>
      <Button onClick={reset}>{t("retry")}</Button>
    </Card>
  );
}
