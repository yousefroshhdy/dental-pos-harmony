import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { BackLink } from "@/components/page-kit/back-link";
import { PageHeader } from "@/components/ui/page-header";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { WorkflowErrorMessage } from "@/modules/workflow/components/action-message";
import { RulesTable, type DefinitionListRow } from "@/modules/workflow/components/rules-table";
import { errorKeyFor, workflowLabelKey } from "@/modules/workflow/logic";
import { listDefinitions } from "@/modules/workflow/queries";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "workflow.rules" });
  return { title: t("title") };
}

/** Every approval workflow with its rule count. Editing needs admin.workflow.manage; approval readers may look. */
export default async function WorkflowRulesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!can(ctx, "admin.workflow.manage") && !can(ctx, "wf.approval.read")) return <Forbidden />;

  const t = await getTranslations("workflow");
  const defs = await listDefinitions();

  const rows: DefinitionListRow[] = (defs.ok ? defs.data : []).map((d) => {
    const key = workflowLabelKey(d.code);
    return { id: d.id, code: d.code, name: key ? t(`workflows.${key}`) : d.name, rules: Number(d.rule_count), version: d.version, active: d.is_active };
  });

  return (
    <div className="space-y-6">
      <PageHeader eyebrow={<BackLink href="/workflow">{t("hub.title")}</BackLink>} title={t("rules.title")} description={t("rules.subtitle")} />
      <RulesTable rows={rows} error={defs.ok ? undefined : <WorkflowErrorMessage messageKey={errorKeyFor(defs.error)} requestId={defs.error.requestId} />} />
    </div>
  );
}
