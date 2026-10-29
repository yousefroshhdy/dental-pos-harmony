"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/primitives";

/** Unexpected failure while rendering an orders page. Raw error text is never shown. */
export default function OrdersError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useTranslations("orders");
  return (
    <div className="space-y-3">
      <Alert>{t("errors.UNKNOWN", { requestId: error.digest ?? "—" })}</Alert>
      <Button variant="outline" onClick={reset}>
        {t("retry")}
      </Button>
    </div>
  );
}
