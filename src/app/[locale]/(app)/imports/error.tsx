"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/primitives";

/** Unexpected failure while rendering an import page. No error details are shown. */
export default function ImportsError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useTranslations("imports");
  return (
    <Card role="alert" className="mx-auto max-w-md space-y-3 text-center">
      <h1 className="text-xl font-semibold">{t("errorTitle")}</h1>
      <p className="text-sm text-muted-foreground">{t("errorBody")}</p>
      <Button variant="outline" onClick={reset}>
        {t("retry")}
      </Button>
    </Card>
  );
}
