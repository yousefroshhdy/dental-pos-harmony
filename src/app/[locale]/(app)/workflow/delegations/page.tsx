import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Badge, Card, CardTitle } from "@/components/ui/primitives";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { WorkflowErrorMessage } from "@/modules/workflow/components/action-message";
import { DelegationForm, EndDelegationForm, type WorkflowOption } from "@/modules/workflow/components/delegation-form";
import { canEndDelegation, errorKeyFor, groupDelegations, isoToCairoLocal, localizedName, workflowLabelKey } from "@/modules/workflow/logic";
import { listDefinitions, listDelegations, listPeople } from "@/modules/workflow/queries";
import type { DelegationRow, DelegationStatus } from "@/modules/workflow/types";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "workflow.delegations" });
  return { title: t("title") };
}

const STATUS_TONE: Record<DelegationStatus, "success" | "info" | "neutral" | "danger"> = {
  active: "success",
  scheduled: "info",
  ended: "neutral",
  revoked: "danger",
};

/**
 * Out-of-office delegations: mine, to me, and (for managers) my team's. Not
 * permission-gated: the view is caller-scoped, so a delegate without
 * wf.delegation.manage still sees what was delegated to them. Creating needs
 * wf.delegation.manage; the database checks scope and the window again.
 */
export default async function DelegationsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  const mayCreate = can(ctx, "wf.delegation.manage");
  const managesOthers = can(ctx, "wf.delegation.manage", "team") || can(ctx, "admin.workflow.manage");

  const t = await getTranslations("workflow");
  const format = await getFormatter();
  const [rows, people, defs] = await Promise.all([
    listDelegations(),
    mayCreate ? listPeople() : Promise.resolve({ ok: true as const, data: [] }),
    mayCreate ? listDefinitions() : Promise.resolve({ ok: true as const, data: [] }),
  ]);

  const me = ctx.employee?.id ?? null;
  const peopleList = people.ok ? people.data : [];
  const onBehalfOf = peopleList.filter((p) => p.in_delegation_scope && p.employee_id !== me);
  const workflows: WorkflowOption[] = (defs.ok ? defs.data : [])
    .filter((d) => d.is_active)
    .map((d) => {
      const key = workflowLabelKey(d.code);
      return { code: d.code, label: key ? t(`workflows.${key}`) : d.name };
    });
  const now = new Date();
  const clientRef = crypto.randomUUID();
  const when = (iso: string) => format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" });
  const workflowOf = (r: DelegationRow) => {
    if (!r.workflow_code) return t("delegations.allWorkflows");
    const key = workflowLabelKey(r.workflow_code);
    return key ? t(`workflows.${key}`) : (r.workflow_name ?? r.workflow_code);
  };

  const list = (items: DelegationRow[], empty: string) =>
    items.length === 0 ? (
      <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">{empty}</p>
    ) : (
      <ul className="divide-y rounded-lg border bg-card">
        {items.map((r) => (
          <li key={r.id} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 space-y-1 text-sm">
              <p className="font-medium">
                {t("delegations.fromTo", {
                  from: localizedName(locale, r.from_name_en, r.from_name_ar),
                  to: localizedName(locale, r.to_name_en, r.to_name_ar),
                })}
              </p>
              <p className="text-muted-foreground">{workflowOf(r)}</p>
              <p className="text-muted-foreground">{t("delegations.window", { from: when(r.valid_from), to: when(r.valid_to) })}</p>
              {r.reason ? <p className="text-muted-foreground">{r.reason}</p> : null}
              {r.revoked_at ? <p className="text-muted-foreground">{t("delegations.revokedAt", { at: when(r.revoked_at) })}</p> : null}
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Badge tone={STATUS_TONE[r.status]}>{t(`delegations.status.${r.status}`)}</Badge>
              {canEndDelegation(r, managesOthers) ? <EndDelegationForm delegationId={r.id} /> : null}
            </div>
          </li>
        ))}
      </ul>
    );

  const groups = rows.ok ? groupDelegations(rows.data) : null;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">{t("delegations.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("delegations.subtitle")}</p>
      </div>

      {mayCreate ? (
        <Card className="space-y-3">
          <CardTitle>{t("delegations.form.title")}</CardTitle>
          <p className="text-sm text-muted-foreground">{t("delegations.form.hint")}</p>
          {!people.ok ? <WorkflowErrorMessage messageKey={errorKeyFor(people.error)} requestId={people.error.requestId} /> : null}
          <DelegationForm
            // A fresh client_ref (and a fresh form) after every successful submit.
            key={clientRef}
            clientRef={clientRef}
            me={me}
            people={peopleList}
            onBehalfOf={onBehalfOf}
            workflows={workflows}
            defaultFrom={isoToCairoLocal(now)}
            defaultTo={isoToCairoLocal(new Date(now.getTime() + 7 * 24 * 3600 * 1000))}
            locale={locale}
          />
        </Card>
      ) : null}

      {!rows.ok || !groups ? (
        <WorkflowErrorMessage messageKey={rows.ok ? "UNKNOWN" : errorKeyFor(rows.error)} requestId={rows.ok ? undefined : rows.error.requestId} />
      ) : (
        <>
          <section aria-labelledby="delegations-from-me" className="space-y-2">
            <h2 id="delegations-from-me" className="text-lg font-semibold">
              {t("delegations.fromMe")}
            </h2>
            {list(groups.fromMe, t("delegations.emptyFromMe"))}
          </section>
          <section aria-labelledby="delegations-to-me" className="space-y-2">
            <h2 id="delegations-to-me" className="text-lg font-semibold">
              {t("delegations.toMe")}
            </h2>
            {list(groups.toMe, t("delegations.emptyToMe"))}
          </section>
          {groups.team.length > 0 || managesOthers ? (
            <section aria-labelledby="delegations-team" className="space-y-2">
              <h2 id="delegations-team" className="text-lg font-semibold">
                {t("delegations.team")}
              </h2>
              {list(groups.team, t("delegations.emptyTeam"))}
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
