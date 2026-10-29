import { getFormatter, getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/primitives";
import { CALENDAR_DATE, calendarDate } from "../format";
import { expiryStatus, expiryTone, isSellableKind, warehouseKindTone } from "../logic";
import type { WarehouseKind } from "../types";

/**
 * Server-rendered badges shared by the inventory pages. Every warehouse kind
 * is labelled, and quarantine/transit warehouses always say "not sellable" so
 * that stock there is never mistaken for stock that can be promised to a customer.
 */
export async function WarehouseKindBadge({ kind, sellable }: { kind: WarehouseKind | null; sellable?: boolean }) {
  const t = await getTranslations("inventory");
  if (!kind) return null;
  const notSellable = sellable === undefined ? !isSellableKind(kind) : !sellable;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge tone={warehouseKindTone(kind)}>{t(`kinds.${kind}`)}</Badge>
      {notSellable ? <Badge tone="danger">{t("common.notSellable")}</Badge> : null}
    </span>
  );
}

/** Expiry date with its status: expired / under 30 days / under 90 days. */
export async function ExpiryBadge({ date, days }: { date: string | null; days: number | null }) {
  const t = await getTranslations("inventory.expiry");
  const format = await getFormatter();
  if (!date) return <span className="text-muted-foreground">{t("none")}</span>;
  const status = expiryStatus(days);
  return (
    <span className="inline-flex flex-wrap items-center gap-1 whitespace-nowrap">
      <span>{format.dateTime(calendarDate(date), CALENDAR_DATE)}</span>
      {status === "expired" || status === "critical" || status === "near" ? (
        <Badge tone={expiryTone(status)}>{status === "expired" ? t("expired") : t("inDays", { days: days ?? 0 })}</Badge>
      ) : null}
    </span>
  );
}
