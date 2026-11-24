"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/primitives";

/** Unexpected failure while rendering an inventory page. Raw error text is never shown. */
export default function InventoryRouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const tErrors = useTranslations("errors");
  const t = useTranslations("inventory.common");
  return (
    <div className="space-y-3">
      <Alert>{tErrors("UNKNOWN", { requestId: error.digest ?? "—" })}</Alert>
      <Button variant="outline" onClick={reset}>
        {t("retry")}
      </Button>
    </div>
  );
}
