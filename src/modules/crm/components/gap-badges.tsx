import { MapPinOffIcon, PhoneOffIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { CustomerGap } from "../logic";

const ICON = { phone_missing: PhoneOffIcon, location_missing: MapPinOffIcon } as const;

/**
 * "Phone missing" / "Location missing" badges (customerGaps). Works in server and client
 * components. The text says the gap; the icon is decoration only.
 */
export function GapBadges({ gaps, className }: { gaps: readonly CustomerGap[]; className?: string }) {
  const t = useTranslations("crm.gap");
  if (gaps.length === 0) return null;
  return (
    <span className={cn("inline-flex flex-wrap gap-1", className)}>
      {gaps.map((gap) => {
        const Icon = ICON[gap];
        return (
          <Badge key={gap} variant="warning" data-gap={gap}>
            <Icon aria-hidden="true" />
            {t(gap)}
          </Badge>
        );
      })}
    </span>
  );
}
