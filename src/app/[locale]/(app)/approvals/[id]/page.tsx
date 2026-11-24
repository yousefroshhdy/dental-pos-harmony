import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { z } from "zod";
import { HistoryIcon } from "lucide-react";
import { BackLink } from "@/components/page-kit/back-link";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Alert, Badge, Card, CardTitle } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { ApprovalErrorMessage } from "@/modules/approvals/components/action-message";
import { DecisionForm } from "@/modules/approvals/components/decision-form";
import { FactList, waitingText, workflowLabel } from "@/modules/approvals/components/request-view";
import { CAIRO_DATE_TIME } from "@/modules/approvals/format";
import { errorKeyFor, localizedName, requestFacts, requestTitle, statusTone, subjectLink, verdictKey } from "@/modules/approvals/logic";
import { getRequest, listSteps } from "@/modules/approvals/queries";

type Params = Promise<{ locale: string; id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "approvals.detail" });
  return { title: t("metaTitle") };
}

/**
 * Approval request detail and decision. Visibility is RLS (requester, subject,
 * wf.approval.read scope, current deciders, past deciders); the decision is
 * re-checked by api.decide_approval, so the verdict shown here is a courtesy.
 */
export default async function ApprovalDetailPage({ params }: { params: Params }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  if (!z.guid().safeParse(id).success) notFound();

  const t = await getTranslations("approvals");
  const format = await getFormatter();
  const [request, steps] = await Promise.all([getRequest(id), listSteps(id)]);
  const back = <BackLink href="/approvals">{t("detail.back")}</BackLink>;
  if (!request.ok)
    return (
      <div className="space-y-6">
        {back}
        <ApprovalErrorMessage messageKey={errorKeyFor(request.error)} requestId={request.error.requestId} />
      </div>
    );
  if (!request.data) notFound();

  const row = request.data;
  const now = new Date();
  const title = workflowLabel(t, row.workflow_code, row.workflow_name);
  const subtitle = requestTitle(row);
  const link = subjectLink(row);
  const requester = localizedName(locale, row.requester_name_en, row.requester_name_ar) || t("unknownPerson");
  const subject = localizedName(locale, row.subject_name_en, row.subject_name_ar);
  const blocked = row.status === "pending" && !row.can_decide ? verdictKey(row.my_verdict) : null;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        eyebrow={back}
        title={
          <span className="inline-flex flex-wrap items-center gap-2">
            {title}
            <Badge tone={statusTone(row.status)}>{t(`status.${row.status}`)}</Badge>
          </span>
        }
        description={subtitle}
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
      <div className="space-y-4">
      <Card className="space-y-4">
        <CardTitle>{t("detail.whatTitle")}</CardTitle>
        <FactList facts={requestFacts(row, locale)} />
        {link ? (
          <Link href={link.href} className={buttonVariants({ variant: "outline" })}>
            {t(`subject.${link.labelKey}`)}
          </Link>
        ) : null}
      </Card>

      <Card className="space-y-3">
        <CardTitle>{t("detail.trailTitle")}</CardTitle>
        {!steps.ok ? (
          <ApprovalErrorMessage messageKey={errorKeyFor(steps.error)} requestId={steps.error.requestId} />
        ) : steps.data.length === 0 ? (
          <EmptyState compact icon={<HistoryIcon aria-hidden="true" />} title={t("detail.noSteps")} />
        ) : (
          <ol className="space-y-3">
            {steps.data.map((step) => {
              const approver = localizedName(locale, step.approver_name_en, step.approver_name_ar) || t("unknownPerson");
              const principal = step.on_behalf_of ? localizedName(locale, step.on_behalf_of_name_en, step.on_behalf_of_name_ar) || t("unknownPerson") : null;
              return (
                <li key={step.id} className="space-y-1 border-s-2 ps-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={step.decision === "approved" ? "success" : "danger"}>{t(`decision.${step.decision}`)}</Badge>
                    <span className="text-sm font-medium">{approver}</span>
                    {principal ? <span className="text-sm text-muted-foreground">{t("detail.onBehalfOf", { name: principal })}</span> : null}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t("card.stage", { stage: step.stage_no })} · {format.dateTime(new Date(step.decided_at), CAIRO_DATE_TIME)}
                  </p>
                  {step.comment ? <p className="text-sm break-words whitespace-pre-line">{step.comment}</p> : null}
                </li>
              );
            })}
          </ol>
        )}
      </Card>

      </div>
      <aside className="space-y-4 lg:sticky lg:top-20">
      <Card className={cn("space-y-3", row.can_decide && "border-primary/50 ring-1 ring-primary/20")}>
        <CardTitle>{t("detail.decisionTitle")}</CardTitle>
        {row.decided_by_me && row.my_decision && row.my_decided_at ? (
          <p className="text-sm">
            {t(`detail.youDecided.${row.my_decision}`, { date: format.dateTime(new Date(row.my_decided_at), CAIRO_DATE_TIME) })}
          </p>
        ) : null}
        {row.can_decide ? (
          <DecisionForm requestId={row.request_id} />
        ) : row.status !== "pending" ? (
          <p className="text-sm text-muted-foreground">{t(`detail.closed.${row.status}`)}</p>
        ) : blocked ? (
          <Alert tone="info" role="status">
            {t(`verdict.${blocked}`)}
          </Alert>
        ) : null}
      </Card>
      <Card className="space-y-3">
        <CardTitle>{t("detail.contextTitle")}</CardTitle>
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-1">
          <div>
            <dt className="text-xs text-muted-foreground">{t("detail.requester")}</dt>
            <dd>
              {requester}
              {row.is_mine ? <Badge className="ms-2">{t("detail.you")}</Badge> : null}
            </dd>
          </div>
          {subject && row.subject_name_en !== row.requester_name_en ? (
            <div>
              <dt className="text-xs text-muted-foreground">{t("detail.subjectEmployee")}</dt>
              <dd>{subject}</dd>
            </div>
          ) : null}
          <div>
            <dt className="text-xs text-muted-foreground">{t("detail.requestedAt")}</dt>
            <dd>{format.dateTime(new Date(row.created_at), CAIRO_DATE_TIME)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t("detail.stage")}</dt>
            <dd>
              {row.stage_count
                ? t("card.stageOf", { stage: row.current_stage, count: row.stage_count })
                : t("card.stage", { stage: row.current_stage })}
              {row.status === "pending" && row.stage_required_approvals && row.stage_required_approvals > 1 ? (
                <span className="text-muted-foreground">
                  {" · "}
                  {t("detail.approvalsProgress", { done: row.stage_approvals, required: row.stage_required_approvals })}
                </span>
              ) : null}
            </dd>
          </div>
          {row.status === "pending" && row.stage_permission ? (
            <div>
              <dt className="text-xs text-muted-foreground">{t("detail.neededPermission")}</dt>
              <dd>
                <code dir="ltr" className="text-sm">
                  {row.stage_permission}
                </code>
              </dd>
            </div>
          ) : null}
          <div>
            <dt className="text-xs text-muted-foreground">{row.status === "pending" ? t("detail.waiting") : t("detail.decided")}</dt>
            <dd>{waitingText(row, now, t, format) ?? "—"}</dd>
          </div>
        </dl>
      </Card>

      </aside>
      </div>
    </div>
  );
}
