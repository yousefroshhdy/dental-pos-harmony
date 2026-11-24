import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Table, Td, Th } from "@/components/ui/table";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { localizedName } from "@/modules/crm/logic";
import { Empty, PageBody } from "@/modules/field/components/layout-bits";
import { BulkReassignForm, RadiusForm, RunNowForm } from "@/modules/leads/components/team-forms";
import { percent } from "@/modules/leads/logic";
import { getLeadUsage, listBaseLocations, listLeadStats, listRuns, placesConfigured } from "@/modules/leads/queries";

/** "Run now" calls Google from the server action: give it the full serverless budget. */
export const maxDuration = 60;

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "leads.team" });
  return { title: t("title") };
}

const CAIRO = { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Cairo", numberingSystem: "latn" } as const;

/**
 * Manager view: leads per rep, visited % and converted %, the discovery runs. The owner also sees
 * the cost guard, runs discovery now and changes a rep's radius. Reassignment: crm.lead.assign.
 */
export default async function LeadsTeamPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!can(ctx, "crm.lead.assign") && !ctx.is_owner) return <Forbidden />;

  const t = await getTranslations("leads");
  const tErrors = await getTranslations("errors");
  const format = await getFormatter();
  const owner = ctx.is_owner;
  const [stats, runs, bases, usage] = await Promise.all([
    listLeadStats(),
    listRuns(20),
    listBaseLocations(),
    owner ? getLeadUsage() : Promise.resolve(null),
  ]);
  const configured = placesConfigured();
  const when = (iso: string | null) => (iso ? format.dateTime(new Date(iso), CAIRO) : "—");
  const name = (en: string | null, ar: string | null) => localizedName(locale, en, ar);

  return (
    <PageBody>
      <PageHeader
        title={t("team.title")}
        description={t("team.intro")}
        actions={
          <Link href="/leads" className={buttonVariants({ variant: "outline" })}>
            {t("nav.leads")}
          </Link>
        }
      />

      {!configured ? <Alert tone="warning">{t("list.notConfigured")}</Alert> : null}

      {owner && usage ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("team.budget.title")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {usage.ok ? (
              <>
                <p>{t("team.budget.today", { used: String(usage.data.today_requests), cap: String(usage.data.daily_request_cap) })}</p>
                <p>
                  {t("team.budget.month", {
                    spent: (usage.data.month_run_cost_usd + usage.data.month_detail_cost_usd).toFixed(2),
                    budget: usage.data.monthly_budget_usd.toFixed(2),
                    details: String(usage.data.month_detail_requests),
                  })}
                </p>
                <p className="text-muted-foreground">{t("team.budget.note")}</p>
                <Link href="/admin/settings#group-field" className="inline-flex min-h-11 items-center text-primary underline-offset-4 hover:underline">
                  {t("team.budget.settings")}
                </Link>
              </>
            ) : (
              <Alert>{tErrors(usage.error.messageKey, { requestId: usage.error.requestId ?? "—" })}</Alert>
            )}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t("team.stats.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          {!stats.ok ? (
            <Alert>{tErrors(stats.error.messageKey, { requestId: stats.error.requestId ?? "—" })}</Alert>
          ) : stats.data.length === 0 ? (
            <Empty>{t("team.stats.empty")}</Empty>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <thead>
                  <tr>
                    <Th>{t("team.stats.rep")}</Th>
                    <Th>{t("team.stats.total")}</Th>
                    <Th>{t("team.stats.new")}</Th>
                    <Th>{t("team.stats.visitedPct")}</Th>
                    <Th>{t("team.stats.convertedPct")}</Th>
                    <Th>{t("team.stats.plannedToday")}</Th>
                    <Th>{t("team.stats.lastRun")}</Th>
                  </tr>
                </thead>
                <tbody>
                  {stats.data.map((s) => (
                    <tr key={s.employee_id}>
                      <Td>
                        <Link href={`/leads?rep=${s.employee_id}&filter=all`} className="text-primary underline-offset-4 hover:underline">
                          {name(s.employee_name_en, s.employee_name_ar)}
                        </Link>
                      </Td>
                      <Td>{s.total}</Td>
                      <Td>{s.new_count}</Td>
                      <Td>{percent(s.visited_pct)}</Td>
                      <Td>{percent(s.converted_pct)}</Td>
                      <Td>{s.planned_today}</Td>
                      <Td>{s.last_run_status ? t(`runStatus.${s.last_run_status}`) : "—"}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
          <p className="mt-2 text-xs text-muted-foreground">{t("team.stats.definitions")}</p>
        </CardContent>
      </Card>

      {owner ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("team.reps.title")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {!bases.ok ? (
              <Alert>{tErrors(bases.error.messageKey, { requestId: bases.error.requestId ?? "—" })}</Alert>
            ) : bases.data.filter((b) => b.base_lat !== null).length === 0 ? (
              <Empty>
                {t("team.reps.empty")}{" "}
                <Link href="/admin/setup" className="text-primary underline-offset-4 hover:underline">
                  {t("team.reps.toSetup")}
                </Link>
              </Empty>
            ) : (
              <ul className="divide-y">
                {bases.data
                  .filter((b) => b.base_lat !== null)
                  .map((b) => (
                    <li key={b.employee_id} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-end sm:justify-between">
                      <div className="space-y-1">
                        <p className="font-medium">{name(b.full_name_en, b.full_name_ar)}</p>
                        <p className="text-xs text-muted-foreground">{t("team.reps.radius", { km: String(Number(b.lead_radius_km)) })}</p>
                      </div>
                      <div className="flex flex-wrap items-end gap-3">
                        <RadiusForm employeeId={b.employee_id} radiusKm={Number(b.lead_radius_km)} />
                        <RunNowForm employeeId={b.employee_id} />
                      </div>
                    </li>
                  ))}
              </ul>
            )}
          </CardContent>
        </Card>
      ) : null}

      {can(ctx, "crm.lead.assign") && bases.ok ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("team.bulk.title")}</CardTitle>
          </CardHeader>
          <CardContent>
            <BulkReassignForm employees={bases.data.map((b) => ({ value: b.employee_id, label: name(b.full_name_en, b.full_name_ar) }))} />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t("team.runs.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          {!runs.ok ? (
            <Alert>{tErrors(runs.error.messageKey, { requestId: runs.error.requestId ?? "—" })}</Alert>
          ) : runs.data.length === 0 ? (
            <Empty>{t("team.runs.empty")}</Empty>
          ) : (
            <ul className="divide-y text-sm">
              {runs.data.map((r) => (
                <li key={r.id} className="space-y-1 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{name(r.employee_name_en, r.employee_name_ar)}</span>
                    <Badge tone={r.status === "done" ? "success" : r.status === "failed" ? "danger" : r.status === "not_configured" ? "warning" : "neutral"}>
                      {t(`runStatus.${r.status}`)}
                    </Badge>
                    {r.truncated ? <Badge tone="warning">{t("team.runs.truncated")}</Badge> : null}
                    {r.refusal ? <Badge tone="warning">{t(`team.runs.refusal.${r.refusal}`)}</Badge> : null}
                  </div>
                  <p className="text-muted-foreground">
                    {t("team.runs.line", {
                      when: when(r.finished_at ?? r.requested_at),
                      trigger: t(`team.runs.trigger.${r.trigger}`),
                      radius: String(Number(r.radius_km)),
                      requests: String(r.request_count),
                      cost: Number(r.estimated_cost_usd).toFixed(2),
                      found: String(r.places_found),
                      added: String(r.leads_new),
                      excluded: String(r.excluded_customers),
                    })}
                  </p>
                  {r.error_code ? <p className="text-xs text-destructive">{t("team.runs.error", { code: r.error_code })}</p> : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </PageBody>
  );
}
