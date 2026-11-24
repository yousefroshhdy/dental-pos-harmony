import { getTranslations } from "next-intl/server";
import { Alert } from "@/components/ui/alert";

/**
 * "Clinic names are not available yet" (no Google Maps server key). Everyone reads the plain
 * sentence; the owner/admin (`seesSetupDetails`) also reads which env var to set. A display
 * choice only (docs/DECISIONS.md Part C).
 */
export async function NotConfiguredNotice({ setupHint }: { setupHint: boolean }) {
  const t = await getTranslations("leads.list");
  return (
    <Alert tone="warning" className="space-y-1">
      <p>{t("notConfigured")}</p>
      {setupHint ? <p className="text-xs text-muted-foreground">{t("notConfiguredSetupHint")}</p> : null}
    </Alert>
  );
}
