import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { z } from "zod";
import { Forbidden } from "@/components/forbidden";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { localizedName } from "@/modules/crm/logic";
import { listGovernorates, listSpecialties } from "@/modules/crm/queries";
import { PageBody } from "@/modules/field/components/layout-bits";
import { GoogleAttribution } from "@/modules/leads/components/google-attribution";
import { ConvertLeadForm, LeadNotesForm, LeadPlanButton, LeadStatusButtons, ReassignLeadForm } from "@/modules/leads/components/lead-forms";
import { collectAttributions, distanceParts, isOpen, leadTitle, nextManualStatuses, statusTone } from "@/modules/leads/logic";
import { getLead, listBaseLocations, loadLeadDetails } from "@/modules/leads/queries";
import { cairoToday } from "@/modules/tracking/logic";

type Props = { params: Promise<{ locale: string; id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "leads.detail" });
  return { title: t("title") };
}

/** One lead: live Google details, HONEST's status and notes, the plan, the first visit, reassignment. */
export default async function LeadPage({ params }: Props) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  if (!z.guid().safeParse(id).success) notFound();
  const ctx = await getUserContext();
  if (!can(ctx, "crm.lead.read")) return <Forbidden />;

  const lang = locale === "en" ? "en" : "ar";
  const t = await getTranslations("leads");
  const tErrors = await getTranslations("errors");
  const lead = await getLead(id);
  if (!lead.ok) return <Alert>{tErrors(lead.error.messageKey, { requestId: lead.error.requestId ?? "—" })}</Alert>;
  if (!lead.data) notFound();
  const row = lead.data;

  const today = cairoToday();
  const mayWork = can(ctx, "crm.lead.work");
  const mayPlan = mayWork && can(ctx, "field.visit.plan");
  const mayConvert = mayWork && can(ctx, "crm.customer.create") && isOpen(row.status);
  const mayAssign = can(ctx, "crm.lead.assign") && isOpen(row.status);

  const [details, governorates, specialties, bases] = await Promise.all([
    row.customer_name ? Promise.resolve(null) : loadLeadDetails([row.place_id], lang),
    mayConvert ? listGovernorates() : Promise.resolve(null),
    mayConvert ? listSpecialties() : Promise.resolve(null),
    mayAssign ? listBaseLocations() : Promise.resolve(null),
  ]);
  const d = details && (details.status === "ok" || details.status === "budget_reached") ? (details.details.get(row.place_id) ?? null) : null;
  const title = leadTitle(row, d) ?? t("list.unnamed");
  const dist = distanceParts(row.distance_m);

  return (
    <PageBody className="mx-auto max-w-2xl">
      <PageHeader
        eyebrow={
          <Link href="/leads" className="inline-flex min-h-11 items-center underline-offset-4 hover:underline">
            {t("detail.back")}
          </Link>
        }
        title={title}
        description={d?.address ?? undefined}
      />

      {details?.status === "not_configured" ? <Alert tone="warning">{t("list.notConfigured")}</Alert> : null}
      {details?.status === "budget_reached" ? <Alert tone="info">{t("list.budgetReached")}</Alert> : null}

      <Card>
        <CardContent className="space-y-3 pt-6">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={statusTone(row.status)}>{t(`status.${row.status}`)}</Badge>
            {dist ? <Badge variant="outline">{t(`distance.${dist.unit}`, { value: String(dist.value) })}</Badge> : null}
            {row.planned_for === today ? <Badge tone="success">{t("plan.today")}</Badge> : row.planned_for ? <Badge>{t("plan.on", { date: row.planned_for })}</Badge> : null}
          </div>
          <p className="text-sm text-muted-foreground">
            {t("detail.rep", { name: localizedName(locale, row.employee_name_en, row.employee_name_ar) })}
          </p>
          <div className="flex flex-wrap gap-2">
            {d?.mapsUri ? (
              <a href={d.mapsUri} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: "outline", className: "min-h-11" })}>
                {t("list.directions")}
              </a>
            ) : null}
            {row.customer_id ? (
              <Link href={`/customers/${row.customer_id}`} className={buttonVariants({ variant: "outline", className: "min-h-11" })}>
                {t("detail.openCustomer", { no: row.customer_no ?? "" })}
              </Link>
            ) : null}
          </div>
          {mayPlan && (row.status === "new" || row.status === "visited") ? (
            <LeadPlanButton leadId={row.id} plannedToday={row.planned_for === today} today={today} />
          ) : null}
          {mayWork ? <LeadStatusButtons leadId={row.id} next={nextManualStatuses(row.status)} /> : null}
        </CardContent>
      </Card>

      {mayConvert ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("convert.title")}</CardTitle>
          </CardHeader>
          <CardContent>
            <ConvertLeadForm
              leadId={row.id}
              defaultGovernorate={null}
              governorates={(governorates?.ok ? governorates.data : []).map((g) => ({ value: g.code, label: localizedName(locale, g.name_en, g.name_ar) }))}
              specialties={(specialties?.ok ? specialties.data : []).map((s) => ({ value: s.code, label: localizedName(locale, s.name_en, s.name_ar) }))}
            />
          </CardContent>
        </Card>
      ) : null}

      {mayWork ? (
        <Card>
          <CardContent className="pt-6">
            <LeadNotesForm leadId={row.id} notes={row.notes} />
          </CardContent>
        </Card>
      ) : row.notes ? (
        <Card>
          <CardContent className="pt-6 text-sm whitespace-pre-wrap">{row.notes}</CardContent>
        </Card>
      ) : null}

      {mayAssign && bases?.ok ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("reassign.title")}</CardTitle>
          </CardHeader>
          <CardContent>
            <ReassignLeadForm
              leadId={row.id}
              currentEmployeeId={row.employee_id}
              employees={bases.data.map((b) => ({ value: b.employee_id, label: localizedName(locale, b.full_name_en, b.full_name_ar) }))}
            />
          </CardContent>
        </Card>
      ) : null}

      {d ? <GoogleAttribution providers={collectAttributions([d])} /> : null}
    </PageBody>
  );
}
