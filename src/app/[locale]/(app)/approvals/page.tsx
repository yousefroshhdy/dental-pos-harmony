import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { FilterChips } from "@/components/page-kit/filter-chips";
import { UrlSelectFilter } from "@/components/page-kit/url-select-filter";
import { readTableParams } from "@/components/ui/data-table-params";
import { PageHeader } from "@/components/ui/page-header";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { firstParam } from "@/lib/list-query";
import { ApprovalErrorMessage } from "@/modules/approvals/components/action-message";
import { InboxTable, type InboxRow } from "@/modules/approvals/components/inbox-table";
import { factText, waitingText, workflowLabel } from "@/modules/approvals/components/request-view";
import { errorKeyFor, headlineFact, isOverdue, localizedName, requestFacts, requestTitle, statusTone, WORKFLOW_LABEL_KEYS } from "@/modules/approvals/logic";
import { countToDecide, listInboxPage } from "@/modules/approvals/queries";
import { parseTab } from "@/modules/approvals/schemas";
import { INBOX_TABLE } from "@/modules/approvals/tables";
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
  const sp = await searchParams;
  const defaultTab: InboxTab = can(ctx, "wf.approval.read") ? "decide" : "mine";
  const tab = parseTab(sp.tab, defaultTab);
  const table = readTableParams(sp, INBOX_TABLE);
  const rawWorkflow = firstParam(sp, "workflow");
  const workflow = rawWorkflow && /^[a-z0-9_.]{1,80}$/.test(rawWorkflow) ? rawWorkflow : null;

  const t = await getTranslations("approvals");
  const format = await getFormatter();
  const [page, toDecide] = await Promise.all([
    listInboxPage(tab, { offset: table.offset, pageSize: table.pageSize, sort: table.sorting[0], search: table.search, workflow }),
    countToDecide(),
  ]);
  const now = new Date();

  const rows: InboxRow[] = (page.ok ? page.data.rows : []).map((row) => {
    const headline = headlineFact(requestFacts(row, locale));
    return {
      id: row.request_id,
      title: requestTitle(row) ?? workflowLabel(t, row.workflow_code, row.workflow_name),
      workflow: workflowLabel(t, row.workflow_code, row.workflow_name),
      requester: localizedName(locale, row.requester_name_en, row.requester_name_ar) || t("unknownPerson"),
      stage:
        row.status === "pending"
          ? row.stage_count
            ? t("card.stageOf", { stage: row.current_stage, count: row.stage_count })
            : t("card.stage", { stage: row.current_stage })
          : null,
      headline: headline ? { label: t(`facts.${headline.key}`), value: factText(headline, t, format) } : null,
      status: row.status,
      statusTone: statusTone(row.status),
      waiting: waitingText(row, now, t, format),
      waitingSince: row.stage_started_at,
      overdue: row.status === "pending" && isOverdue(row.stage_started_at, now),
      myDecision:
        row.decided_by_me && row.my_decision
          ? { label: t(`card.myDecision.${row.my_decision}`), tone: row.my_decision === "approved" ? "success" : "danger" }
          : null,
    };
  });

  return (
    <div className="space-y-6">
      <PageHeader title={t("inbox.title")} description={t("inbox.subtitle")} />

      <FilterChips
        label={t("inbox.tabsLabel")}
        pathname="/approvals"
        params={sp}
        param="tab"
        current={tab}
        options={TABS.map((key) => ({
          value: key,
          label: t(`inbox.tabs.${key}`),
          count: key === "decide" && toDecide.ok ? toDecide.data : undefined,
        }))}
      />

      <InboxTable
        key={tab}
        tab={tab}
        rows={rows}
        rowCount={page.ok ? page.data.total : 0}
        error={page.ok ? undefined : <ApprovalErrorMessage messageKey={errorKeyFor(page.error)} requestId={page.error.requestId} />}
        filters={
          <UrlSelectFilter
            label={t("inboxTable.workflow")}
            param="workflow"
            options={[
              { value: "", label: t("inboxTable.allWorkflows") },
              ...Object.keys(WORKFLOW_LABEL_KEYS).map((code) => ({ value: code, label: workflowLabel(t, code, code) })),
            ]}
          />
        }
      />
    </div>
  );
}
