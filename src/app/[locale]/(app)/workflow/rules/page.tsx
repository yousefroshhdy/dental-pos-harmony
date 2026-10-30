import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { Badge } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { WorkflowErrorMessage } from "@/modules/workflow/components/action-message";
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

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">{t("rules.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("rules.subtitle")}</p>
      </div>
      {!defs.ok ? (
        <WorkflowErrorMessage messageKey={errorKeyFor(defs.error)} requestId={defs.error.requestId} />
      ) : defs.data.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">{t("rules.empty")}</p>
      ) : (
        <ul className="divide-y rounded-lg border bg-card">
          {defs.data.map((d) => {
            const key = workflowLabelKey(d.code);
            return (
              <li key={d.id}>
                <Link
                  href={`/workflow/rules/${d.id}`}
                  className="flex min-h-11 flex-col gap-1 px-4 py-3 hover:bg-muted sm:flex-row sm:items-center sm:justify-between"
                >
                  <span className="min-w-0 space-y-0.5">
                    <span className="block font-medium">{key ? t(`workflows.${key}`) : d.name}</span>
                    <code dir="ltr" className="block text-xs break-all text-muted-foreground">
                      {d.code}
                    </code>
                  </span>
                  <span className="flex flex-wrap gap-1">
                    <Badge>{t("rules.ruleCount", { count: d.rule_count })}</Badge>
                    <Badge tone="info">{t("rules.version", { version: d.version })}</Badge>
                    {!d.is_active ? <Badge tone="warning">{t("rules.inactive")}</Badge> : null}
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
