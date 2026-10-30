import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { Card, CardTitle } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { formatDay } from "../format";
import { toNumber } from "../logic";
import type { OverdueCustomerRow, PendingApprovalRow } from "../types";

/** Overdue customers attributed to the scope (api.kpi_overdue_customers). */
export async function OverdueCustomers({ rows, title }: { rows: readonly OverdueCustomerRow[]; title: string }) {
  const t = await getTranslations("dashboards.overdue");
  const format = await getFormatter();
  return (
    <Card className="space-y-3">
      <CardTitle>{title}</CardTitle>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="divide-y">
          {rows.map((r) => (
            <li key={r.customer_id}>
              <Link href={`/customers/${r.customer_id}`} className="flex min-h-11 items-center justify-between gap-3 py-2 hover:bg-muted">
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-medium">{r.display_name}</span>
                  <span className="text-xs text-muted-foreground">
                    {t("meta", { days: r.days_overdue, count: r.invoice_count, since: formatDay(format, r.oldest_due_date) })}
                  </span>
                </span>
                <span className="font-semibold whitespace-nowrap tabular-nums">{format.number(toNumber(r.overdue_amount) ?? 0, "egp")}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Link href="/finance/aging" className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline">
        {t("openAging")}
      </Link>
    </Card>
  );
}

/** Requests the caller can decide now (api.v_approval_requests, caller-scoped). */
export async function PendingApprovals({ rows }: { rows: readonly PendingApprovalRow[] }) {
  const t = await getTranslations("dashboards.pending");
  const format = await getFormatter();
  const locale = await getLocale();
  return (
    <Card className="space-y-3">
      <CardTitle>{t("title")}</CardTitle>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="divide-y">
          {rows.map((r) => {
            const subject = (locale === "ar" ? r.subject_name_ar : null) ?? r.subject_name_en;
            return (
              <li key={r.request_id}>
                <Link href={`/approvals/${r.request_id}`} className="flex min-h-11 flex-col justify-center gap-0.5 py-2 hover:bg-muted">
                  <span className="font-medium">{r.workflow_name}</span>
                  <span className="text-xs text-muted-foreground">
                    {[subject, r.customer_name, format.dateTime(new Date(r.created_at), { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Cairo", numberingSystem: "latn" })]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      <Link href="/approvals" className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline">
        {t("openInbox")}
      </Link>
    </Card>
  );
}
