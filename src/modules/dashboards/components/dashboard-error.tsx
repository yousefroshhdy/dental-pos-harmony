import { getTranslations } from "next-intl/server";
import { Alert } from "@/components/ui/primitives";
import type { DashboardErrorCode } from "../logic";

/** Translated error line (dashboards.errors.*). The request id is the only detail shown. */
export async function DashboardError({ code, requestId }: { code: DashboardErrorCode; requestId?: string }) {
  const t = await getTranslations("dashboards.errors");
  return <Alert>{t(code, { requestId: requestId ?? "—" })}</Alert>;
}
