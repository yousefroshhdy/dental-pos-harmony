"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/primitives";

/** Error boundary body for the tracking routes (error.tsx). The raw error is never shown. */
export function TrackingRouteError({ retry }: { retry: () => void }) {
  const t = useTranslations("tracking.routeError");
  return (
    <Card role="alert" className="mx-auto max-w-md space-y-3 text-center">
      <h1 className="text-xl font-semibold">{t("title")}</h1>
      <p className="text-sm text-muted-foreground">{t("body")}</p>
      <Button type="button" onClick={retry}>
        {t("retry")}
      </Button>
    </Card>
  );
}
