import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { z } from "zod";
import { Forbidden } from "@/components/forbidden";
import { buttonVariants } from "@/components/ui/button";
import { Alert, Badge, Card, CardTitle } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { cn } from "@/lib/utils";
import { WorkflowErrorMessage } from "@/modules/workflow/components/action-message";
import { RuleForm } from "@/modules/workflow/components/rule-form";
import { RemoveStageForm, StageForm } from "@/modules/workflow/components/stage-form";
import { EMPTY_STAGE, type StageOptions } from "@/modules/workflow/components/stage-fields";
import {
  clausesToRows,
  editorRows,
  errorKeyFor,
  formatClauseValue,
  localizedName,
  minutesToHours,
  nextStageNo,
  parseCondition,
  workflowLabelKey,
} from "@/modules/workflow/logic";
import { getDefinition, listDecidePermissions, listPeople, listRoles, listRules, listStages } from "@/modules/workflow/queries";
import type { StageRow } from "@/modules/workflow/types";

type Params = Promise<{ locale: string; definitionId: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "workflow.rules" });
  return { title: t("title") };
}

const summaryClass = cn(buttonVariants({ variant: "outline" }), "cursor-pointer list-none select-none [&::-webkit-details-marker]:hidden");

/**
 * Rules of one workflow, by priority (the first matching rule decides the
 * stages). Editing is shown to admin.workflow.manage holders; every change is
 * validated, audited and reported to the owners by the database.
 */
export default async function WorkflowDefinitionPage({ params }: { params: Params }) {
  const { locale, definitionId } = await params;
  setRequestLocale(locale);
  if (!z.guid().safeParse(definitionId).success) notFound();

  const ctx = await getUserContext();
  const editable = can(ctx, "admin.workflow.manage");
  if (!editable && !can(ctx, "wf.approval.read")) return <Forbidden />;

  const t = await getTranslations("workflow");
  const format = await getFormatter();
  const [def, rules] = await Promise.all([getDefinition(definitionId), listRules(definitionId)]);
  if (!def.ok) return <WorkflowErrorMessage messageKey={errorKeyFor(def.error)} requestId={def.error.requestId} />;
  if (!def.data) notFound();
  if (!rules.ok) return <WorkflowErrorMessage messageKey={errorKeyFor(rules.error)} requestId={rules.error.requestId} />;

  const [stages, permissions, roles, people] = await Promise.all([
    listStages(rules.data.map((r) => r.rule_id)),
    editable ? listDecidePermissions() : Promise.resolve({ ok: true as const, data: [] }),
    editable ? listRoles() : Promise.resolve({ ok: true as const, data: [] }),
    editable ? listPeople() : Promise.resolve({ ok: true as const, data: [] }),
  ]);
  if (!stages.ok) return <WorkflowErrorMessage messageKey={errorKeyFor(stages.error)} requestId={stages.error.requestId} />;
  const options: StageOptions = {
    permissions: permissions.ok ? permissions.data : [],
    roles: roles.ok ? roles.data : [],
    people: people.ok ? people.data : [],
  };

  const definition = def.data;
  const labelKey = workflowLabelKey(definition.code);
  const stagesOf = (ruleId: string) => stages.data.filter((s) => s.rule_id === ruleId);
  const hours = (minutes: number | null) =>
    format.number(minutesToHours(minutes) ?? 0, { maximumFractionDigits: 2, numberingSystem: "latn" });

  const approver = (s: StageRow) => {
    switch (s.approver_type) {
      case "permission":
        return (
          <code dir="ltr" className="break-all">
            {s.approver_permission}
          </code>
        );
      case "role":
        return localizedName(locale, s.approver_role_name_en, s.approver_role_name_ar);
      case "user":
        return localizedName(locale, s.approver_user_name_en, s.approver_user_name_ar);
      default:
        return t("approverType.requester_manager");
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Link href="/workflow/rules" className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline">
          {t("rules.back")}
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold">{labelKey ? t(`workflows.${labelKey}`) : definition.name}</h1>
          <Badge tone="info">{t("rules.version", { version: definition.version })}</Badge>
        </div>
        <code dir="ltr" className="block text-sm break-all text-muted-foreground">
          {definition.code}
        </code>
        <p className="text-sm text-muted-foreground">{t("rules.howItWorks")}</p>
        {!editable ? <Alert tone="info">{t("rules.readOnly")}</Alert> : <p className="text-sm text-muted-foreground">{t("rules.limitsNote")}</p>}
      </div>

      {rules.data.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">{t("rules.noRules")}</p>
      ) : (
        rules.data.map((rule) => {
          const clauses = parseCondition(rule.condition);
          const rows = clauses ? clausesToRows(clauses) : null;
          const ruleStages = stagesOf(rule.rule_id);
          return (
            <Card key={rule.rule_id} className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle>{t("rule.title", { priority: rule.priority })}</CardTitle>
                {rule.is_catch_all ? <Badge>{t("rule.catchAll")}</Badge> : null}
                {rule.auto_approve ? <Badge tone="warning">{t("rule.autoApproveBadge")}</Badge> : null}
              </div>

              <section className="space-y-1">
                <h3 className="text-sm font-medium">{t("rule.when")}</h3>
                {clauses === null ? (
                  <code dir="ltr" className="block rounded bg-muted p-2 text-xs break-all">
                    {JSON.stringify(rule.condition)}
                  </code>
                ) : clauses.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("rule.always")}</p>
                ) : (
                  <ul className="space-y-1 text-sm">
                    {clauses.map((c, i) => (
                      <li key={i} dir="ltr" className="text-start">
                        <code className="break-all">
                          {c.field} {c.op} {formatClauseValue(c.value)}
                        </code>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="space-y-2">
                <h3 className="text-sm font-medium">{rule.auto_approve ? t("rule.autoApproveNote") : t("rule.stages")}</h3>
                {ruleStages.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("rule.noStages")}</p>
                ) : (
                  <ol className="divide-y rounded-md border">
                    {ruleStages.map((s) => (
                      <li key={s.stage_id} className="space-y-2 p-3">
                        <div className="flex flex-wrap items-center gap-2 text-sm">
                          <Badge tone="info">{t("stage.label", { no: s.stage_no })}</Badge>
                          <span className="font-medium">{t(`approverType.${s.approver_type}`)}</span>
                          <span className="min-w-0">{approver(s)}</span>
                        </div>
                        <div className="flex flex-wrap gap-1 text-xs">
                          <Badge>{t("stage.approvals", { count: s.required_approvals })}</Badge>
                          {s.escalate_after_minutes !== null ? (
                            <Badge tone="warning">
                              {t("stage.escalatesAfter", { hours: hours(s.escalate_after_minutes) })}
                              {s.escalate_to_user_id
                                ? ` → ${localizedName(locale, s.escalate_to_name_en, s.escalate_to_name_ar)}`
                                : ` → ${t("stage.toManager")}`}
                            </Badge>
                          ) : (
                            <Badge>{t("stage.noEscalationBadge")}</Badge>
                          )}
                        </div>
                        {editable ? (
                          <div className="flex flex-wrap gap-2">
                            <details className="w-full sm:w-auto">
                              <summary className={summaryClass}>{t("stage.edit")}</summary>
                              <div className="mt-3">
                                <StageForm
                                  definitionId={definition.id}
                                  ruleId={rule.rule_id}
                                  stageNo={s.stage_no}
                                  isNew={false}
                                  defaults={s}
                                  options={options}
                                  locale={locale}
                                />
                              </div>
                            </details>
                            <details className="w-full sm:w-auto">
                              <summary className={summaryClass}>{t("stage.remove")}</summary>
                              <div className="mt-3">
                                <RemoveStageForm definitionId={definition.id} ruleId={rule.rule_id} stageNo={s.stage_no} />
                              </div>
                            </details>
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                )}
              </section>

              {editable ? (
                <div className="flex flex-col gap-2">
                  <details>
                    <summary className={summaryClass}>{t("stage.add")}</summary>
                    <div className="mt-3">
                      <StageForm
                        definitionId={definition.id}
                        ruleId={rule.rule_id}
                        stageNo={nextStageNo(ruleStages)}
                        isNew
                        defaults={EMPTY_STAGE}
                        options={options}
                        locale={locale}
                      />
                    </div>
                  </details>
                  <details>
                    <summary className={summaryClass}>{t("rule.edit")}</summary>
                    <div className="mt-3 space-y-2">
                      {rows === null ? <Alert tone="info">{t("rule.notEditable")}</Alert> : null}
                      <RuleForm
                        definitionId={definition.id}
                        definitionCode={definition.code}
                        ruleId={rule.rule_id}
                        priority={rule.priority}
                        autoApprove={rule.auto_approve}
                        rows={editorRows(rows ?? [])}
                        isOwner={ctx.is_owner}
                        options={options}
                        locale={locale}
                      />
                    </div>
                  </details>
                </div>
              ) : null}
            </Card>
          );
        })
      )}

      {editable ? (
        <Card className="space-y-3">
          <CardTitle>{t("rule.new")}</CardTitle>
          <p className="text-sm text-muted-foreground">{t("rule.newHint")}</p>
          <RuleForm
            definitionId={definition.id}
            definitionCode={definition.code}
            rows={editorRows([])}
            isOwner={ctx.is_owner}
            options={options}
            locale={locale}
          />
        </Card>
      ) : null}
    </div>
  );
}
