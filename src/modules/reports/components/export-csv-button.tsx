import { Download } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { buttonVariants } from "@/components/ui/button";
import type { UserContext } from "@/lib/authz/can";
import { cn } from "@/lib/utils";
import { canExport, exportHref, type ExportFilters, type ExportKind } from "../kinds";

/**
 * "Export CSV" link for a list page. Pass the list's current filters (the
 * same query parameter names the page uses); empty values are dropped.
 * Renders nothing when the user may not run this export. The download is a
 * plain GET, so it works without JavaScript; the server checks permission
 * and RLS again.
 *
 * Usage (server or client component):
 *   <ExportCsvButton ctx={ctx} kind="orders" filters={{ status: filter }} />
 */
export function ExportCsvButton({
  ctx,
  kind,
  filters,
  label,
  className,
}: {
  ctx: UserContext;
  kind: ExportKind;
  filters?: ExportFilters;
  label?: string;
  className?: string;
}) {
  const t = useTranslations("reports");
  const locale = useLocale();
  if (!canExport(ctx, kind)) return null;
  return (
    <a href={exportHref(kind, filters, locale)} download className={cn(buttonVariants({ variant: "outline" }), "min-h-11 gap-2", className)}>
      <Download aria-hidden="true" className="size-4" />
      {label ?? t("button.export")}
    </a>
  );
}
