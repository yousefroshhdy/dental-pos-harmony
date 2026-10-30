import { getTranslations } from "next-intl/server";
import { Alert, Card } from "@/components/ui/primitives";
import { getMyTrackingStatus } from "../queries";
import { trackingErrorCode } from "../logic";
import { ShiftCardClient } from "./shift-card-client";

/**
 * "Start my day / End my day" at the top of /today (D-14). Server part: reads the
 * caller's status (notice, open shift, settings); the client part runs the notice,
 * the commands and the live state. Render it only for users who may start a shift:
 *
 *   {canStartShift(ctx) && ctx.user_id ? <ShiftCard userId={ctx.user_id} employeeId={ctx.employee.id} /> : null}
 */
export async function ShiftCard({ userId, employeeId }: { userId: string; employeeId: string }) {
  const status = await getMyTrackingStatus();
  if (!status.ok || !status.data) {
    const t = await getTranslations("errors");
    const tOwn = await getTranslations("tracking");
    const own = status.ok ? null : trackingErrorCode(status.error.code);
    return (
      <Card className="space-y-2">
        <h2 className="text-lg font-semibold">{tOwn("shift.title")}</h2>
        <Alert>{own ? tOwn(`errors.${own}`) : t(status.ok ? "UNKNOWN" : status.error.messageKey, { requestId: status.ok ? "—" : (status.error.requestId ?? "—") })}</Alert>
      </Card>
    );
  }
  return <ShiftCardClient userId={userId} employeeId={employeeId} status={status.data} />;
}
