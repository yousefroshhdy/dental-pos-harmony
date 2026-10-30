import { getTranslations } from "next-intl/server";
import { Alert } from "@/components/ui/primitives";
import type { CommissionErrorCode } from "../logic";

/** Translated error line (commissions.errors.*). The request id is the only detail shown. */
export async function CommissionError({ code, requestId }: { code: CommissionErrorCode; requestId?: string }) {
  const t = await getTranslations("commissions.errors");
  return <Alert>{t(code, { requestId: requestId ?? "—" })}</Alert>;
}
