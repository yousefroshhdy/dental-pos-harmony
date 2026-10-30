import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Badge } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { WorkflowErrorMessage } from "@/modules/workflow/components/action-message";
import { errorKeyFor, openEscalations, workflowLabelKey } from "@/modules/workflow/logic";
import { listEscalations } from "@/modules/workflow/queries";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "workflow.escalations" });
  return { title: t("title") };
}

/**
 * Requests whose current stage waited past escalate_after and escalated. Caller-
 * scoped (the view follows approval-request RLS), so it is not permission-gated:
 * an escalation target reaches it from the notification. Ones that reached me
 * are highlighted; each links to the request in /approvals, where it is decided.
 */
export default async function EscalationsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("workflow");
  const format = await getFormatter();
  const rows = await listEscalations();
  const open = rows.ok ? openEscalations(rows.data) : [];
  const now = new Date();

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">{t("escalations.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("escalations.subtitle")}</p>
      </div>
      {!rows.ok ? (
        <WorkflowErrorMessage messageKey={errorKeyFor(rows.error)} requestId={rows.error.requestId} />
      ) : open.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">{t("escalations.empty")}</p>
      ) : (
        <ul className="space-y-2">
          {open.map((r) => {
            const key = workflowLabelKey(r.workflow_code);
            return (
              <li key={`${r.request_id}:${r.stage_no}`}>
                <Link
                  href={`/approvals/${r.request_id}`}
                  className={cn(
                    "flex min-h-11 flex-col gap-2 rounded-lg border bg-card p-4 hover:bg-muted sm:flex-row sm:items-center sm:justify-between",
                    r.i_am_target && "border-warning bg-warning/10 ring-1 ring-warning",
                  )}
                >
                  <span className="min-w-0 space-y-1">
                    <span className="block font-medium">{key ? t(`workflows.${key}`) : r.workflow_name}</span>
                    <span className="block text-sm text-muted-foreground">
                      {t("escalations.stageLevel", { stage: r.stage_no, level: r.level })}
                    </span>
                    <span className="block text-sm text-muted-foreground">
                      {t("escalations.since", { when: format.relativeTime(new Date(r.first_escalated_at), now) })}
                    </span>
                  </span>
                  <span className="flex flex-wrap gap-1">
                    {r.i_am_target ? <Badge tone="warning">{t("escalations.toYou")}</Badge> : null}
                    {r.can_decide ? <Badge tone="success">{t("escalations.canDecide")}</Badge> : null}
                    <Badge tone="info">{t("escalations.open")}</Badge>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
