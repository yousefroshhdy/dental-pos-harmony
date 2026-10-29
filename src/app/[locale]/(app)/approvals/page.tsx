import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Badge } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { cn } from "@/lib/utils";
import { ApprovalErrorMessage } from "@/modules/approvals/components/action-message";
import { RequestCard, workflowLabel } from "@/modules/approvals/components/request-view";
import { errorKeyFor, groupByWorkflow } from "@/modules/approvals/logic";
import { countToDecide, INBOX_LIMIT, listInbox } from "@/modules/approvals/queries";
import { parseTab } from "@/modules/approvals/schemas";
import type { InboxTab } from "@/modules/approvals/types";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "approvals.inbox" });
  return { title: t("title") };
}

const TABS: InboxTab[] = ["decide", "mine", "decided"];

/**
 * Approvals inbox. Not permission-gated: every list is caller-scoped by the
 * view (requests I can decide now, my own requests, requests I decided), so a
 * requester without wf.approval.read still sees their own requests.
 */
export default async function ApprovalsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  const tab = parseTab((await searchParams).tab, can(ctx, "wf.approval.read") ? "decide" : "mine");

  const t = await getTranslations("approvals");
  const [rows, toDecide] = await Promise.all([listInbox(tab), countToDecide()]);
  const now = new Date();

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">{t("inbox.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("inbox.subtitle")}</p>
      </div>

      <nav aria-label={t("inbox.tabsLabel")} className="flex gap-1 overflow-x-auto border-b">
        {TABS.map((key) => (
          <Link
            key={key}
            href={`/approvals?tab=${key}`}
            aria-current={key === tab ? "page" : undefined}
            className={cn(
              "inline-flex min-h-11 items-center gap-2 border-b-2 px-3 text-sm whitespace-nowrap",
              key === tab ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t(`inbox.tabs.${key}`)}
            {key === "decide" && toDecide.ok && toDecide.data > 0 ? <Badge tone="warning">{toDecide.data}</Badge> : null}
          </Link>
        ))}
      </nav>

      {!rows.ok ? (
        <ApprovalErrorMessage messageKey={errorKeyFor(rows.error)} requestId={rows.error.requestId} />
      ) : rows.data.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">{t(`inbox.empty.${tab}`)}</p>
      ) : tab === "decide" ? (
        <div className="space-y-6">
          {groupByWorkflow(rows.data).map((group) => {
            const headingId = `group-${group.code.replace(/[^a-z0-9]/gi, "-")}`;
            return (
              <section key={group.code} aria-labelledby={headingId} className="space-y-2">
                <h2 id={headingId} className="flex items-center gap-2 text-lg font-semibold">
                  {workflowLabel(t, group.code, group.rows[0]?.workflow_name ?? group.code)}
                  <Badge>{group.rows.length}</Badge>
                </h2>
                <ul className="grid gap-3 md:grid-cols-2">
                  {group.rows.map((row) => (
                    <li key={row.request_id}>
                      <RequestCard row={row} locale={locale} now={now} />
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {rows.data.map((row) => (
            <li key={row.request_id} className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">{workflowLabel(t, row.workflow_code, row.workflow_name)}</p>
              <RequestCard row={row} locale={locale} now={now} />
            </li>
          ))}
        </ul>
      )}
      {rows.ok && rows.data.length >= INBOX_LIMIT ? <p className="text-xs text-muted-foreground">{t("inbox.truncated", { limit: INBOX_LIMIT })}</p> : null}
    </div>
  );
}
