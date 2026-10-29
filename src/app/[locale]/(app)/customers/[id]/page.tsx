import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { z } from "zod";
import { Forbidden } from "@/components/forbidden";
import { buttonVariants } from "@/components/ui/button";
import { Alert, Badge, Card, CardTitle } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { LocationForm } from "@/modules/crm/components/location-form";
import { LogActivityForm } from "@/modules/crm/components/log-activity-form";
import { ReassignForm } from "@/modules/crm/components/reassign-form";
import { Timeline } from "@/modules/crm/components/timeline";
import { CAIRO_DATE, EGP } from "@/modules/crm/format";
import {
  cairoNowLocal,
  formatEgyptPhone,
  lifecycleTone,
  localizedName,
  locationStatus,
  opportunityTone,
  toNumber,
} from "@/modules/crm/logic";
import {
  getCustomer,
  listAssignableEmployees,
  listGovernorates,
  listOpportunities,
  listSpecialties,
  listTimeline,
} from "@/modules/crm/queries";

type Props = {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Pick<Props, "params">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "crm.detail" });
  return { title: t("metaTitle") };
}

const LOCATION_TONE = { verified: "success", unverified: "warning", missing: "neutral" } as const;

export default async function CustomerPage({ params, searchParams }: Props) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  if (!z.guid().safeParse(id).success) notFound();

  const ctx = await getUserContext();
  if (!can(ctx, "crm.customer.read")) return <Forbidden />;

  const t = await getTranslations("crm.detail");
  const tStage = await getTranslations("crm.stage");
  const tKind = await getTranslations("crm.kind");
  const tSource = await getTranslations("crm.source");
  const tLoc = await getTranslations("crm.locationStatus");
  const tOppStage = await getTranslations("crm.opportunityStage");
  const tErrors = await getTranslations("errors");
  const format = await getFormatter();
  const sp = await searchParams;

  const showOpportunities = can(ctx, "crm.opportunity.read");
  const [customer, timeline, governorates, specialties, opportunities, employees] = await Promise.all([
    getCustomer(id),
    listTimeline(id),
    listGovernorates(),
    listSpecialties(),
    showOpportunities ? listOpportunities({ customerId: id, closedDays: 365 }) : Promise.resolve(null),
    listAssignableEmployees(),
  ]);
  if (!customer.ok) return <Alert>{tErrors(customer.error.messageKey, { requestId: customer.error.requestId ?? "—" })}</Alert>;
  // RLS hides customers outside the user's scope: same answer as "does not exist".
  if (!customer.data) notFound();
  const c = customer.data;

  const archived = c.archived_at !== null;
  const open = !archived;
  const governorate = governorates.ok ? governorates.data.find((g) => g.code === c.governorate_code) : undefined;
  const specialty = specialties.ok ? specialties.data.find((s) => s.code === c.specialty_code) : undefined;
  const rep = localizedName(locale, c.primary_rep_name_en, c.primary_rep_name_ar);
  const territory = localizedName(locale, c.territory_name_en, c.territory_name_ar);
  const loc = locationStatus(c);
  const lat = toNumber(c.latitude);
  const lng = toNumber(c.longitude);
  const balance = toNumber(c.balance);
  const creditLimit = toNumber(c.credit_limit);

  const canEdit = open && can(ctx, "crm.customer.update");
  const canOpportunity = open && c.lifecycle_stage !== "blocked" && can(ctx, "crm.opportunity.manage");
  const canLog = open && can(ctx, "crm.activity.create");
  const canLocate = open && can(ctx, "crm.customer_location.verify");
  const targets = employees.ok ? employees.data.filter((e) => e.id !== c.primary_rep_employee_id) : [];
  const canReassign = open && targets.length > 0;

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Link href="/customers" className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline">
          {t("back")}
        </Link>
        {sp.created ? (
          <Alert tone="success" role="status">
            {t("created", { customerNo: c.customer_no })}
          </Alert>
        ) : null}
        {sp.saved ? (
          <Alert tone="success" role="status">
            {t("saved")}
          </Alert>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="min-w-0 text-2xl font-semibold break-words">{c.display_name}</h1>
          <Badge tone={lifecycleTone(c.lifecycle_stage)}>{tStage(c.lifecycle_stage)}</Badge>
          {archived ? <Badge tone="danger">{t("archived")}</Badge> : null}
        </div>
        <p className="text-sm text-muted-foreground">
          <span dir="ltr">{c.customer_no}</span> · {tKind(c.kind)}
          {territory ? ` · ${territory}` : ""}
        </p>
        {canEdit || canOpportunity ? (
          <div className="flex flex-wrap gap-2 pt-1">
            {canEdit ? (
              <Link href={`/customers/${c.id}/edit`} className={buttonVariants({ variant: "outline" })}>
                {t("edit")}
              </Link>
            ) : null}
            {canOpportunity ? (
              <Link href={`/opportunities/new?customer=${c.id}`} className={buttonVariants({ variant: "outline" })}>
                {t("newOpportunity")}
              </Link>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card className="space-y-4">
            <CardTitle>{t("profile")}</CardTitle>
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <Field label={t("doctor")}>{c.doctor_name}</Field>
              <Field label={t("clinic")}>{c.clinic_name}</Field>
              <Field label={t("phone")}>
                {c.phone_primary ? (
                  <a href={`tel:${c.phone_primary}`} dir="ltr" className="inline-flex min-h-11 items-center text-primary underline-offset-4 hover:underline">
                    {formatEgyptPhone(c.phone_primary)}
                  </a>
                ) : null}
              </Field>
              <Field label={t("phoneSecondary")}>
                {c.phone_secondary ? (
                  <a href={`tel:${c.phone_secondary}`} dir="ltr" className="inline-flex min-h-11 items-center text-primary underline-offset-4 hover:underline">
                    {formatEgyptPhone(c.phone_secondary)}
                  </a>
                ) : null}
              </Field>
              <Field label={t("email")}>{c.email ? <span dir="ltr" className="break-all">{c.email}</span> : null}</Field>
              <Field label={t("specialty")}>{specialty ? localizedName(locale, specialty.name_en, specialty.name_ar) : c.specialty_code}</Field>
              <Field label={t("address")}>{c.address_line}</Field>
              <Field label={t("place")}>
                {[c.city, governorate ? localizedName(locale, governorate.name_en, governorate.name_ar) : c.governorate_code]
                  .filter(Boolean)
                  .join(locale === "ar" ? "، " : ", ")}
              </Field>
              <Field label={t("rep")}>{rep}</Field>
              <Field label={t("source")}>{c.source ? tSource(c.source) : null}</Field>
              <Field label={t("tags")}>
                {c.tags.length > 0 ? (
                  <span className="flex flex-wrap gap-1">
                    {c.tags.map((tag) => (
                      <Badge key={tag}>{tag}</Badge>
                    ))}
                  </span>
                ) : null}
              </Field>
              <Field label={t("since")}>{format.dateTime(new Date(c.created_at), CAIRO_DATE)}</Field>
              {/* NULL = masked: the user has no crm.customer_balance.read for this customer. */}
              {balance !== null ? <Field label={t("balance")}>{format.number(balance, EGP)}</Field> : null}
              {balance !== null ? (
                <Field label={t("creditTerms")}>
                  {creditLimit !== null ? format.number(creditLimit, EGP) : t("noCreditLimit")}
                  {" · "}
                  {t("paymentTerms", { days: c.payment_terms_days ?? 0 })}
                </Field>
              ) : null}
            </dl>
            {c.notes ? (
              <div className="space-y-1">
                <h3 className="text-sm font-medium">{t("notes")}</h3>
                <p className="text-sm whitespace-pre-line">{c.notes}</p>
              </div>
            ) : null}
          </Card>

          {canLog ? (
            <Card className="space-y-3">
              <CardTitle>{t("logActivity")}</CardTitle>
              <LogActivityForm customerId={c.id} maxLocal={cairoNowLocal()} />
            </Card>
          ) : null}

          <Card className="space-y-3">
            <CardTitle>{t("timeline")}</CardTitle>
            {timeline.ok ? (
              <Timeline rows={timeline.data} locale={locale} />
            ) : (
              <Alert>{tErrors(timeline.error.messageKey, { requestId: timeline.error.requestId ?? "—" })}</Alert>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <CardTitle>{t("location")}</CardTitle>
              <Badge tone={LOCATION_TONE[loc]}>{tLoc(loc)}</Badge>
            </div>
            {lat !== null && lng !== null ? (
              <p className="text-sm">
                <span dir="ltr" className="font-mono">
                  {lat.toFixed(6)}, {lng.toFixed(6)}
                </span>{" "}
                <a
                  href={`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=18/${lat}/${lng}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-11 items-center text-primary underline-offset-4 hover:underline"
                >
                  {t("openMap")}
                </a>
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">{t("noLocation")}</p>
            )}
            {canLocate ? <LocationForm customerId={c.id} hasLocation={lat !== null} /> : null}
          </Card>

          {showOpportunities ? (
            <Card className="space-y-3">
              <CardTitle>{t("opportunities")}</CardTitle>
              {opportunities && !opportunities.ok ? (
                <Alert>{tErrors(opportunities.error.messageKey, { requestId: opportunities.error.requestId ?? "—" })}</Alert>
              ) : opportunities && opportunities.data.length > 0 ? (
                <ul className="space-y-2">
                  {opportunities.data.map((o) => (
                    <li key={o.id} className="flex items-start justify-between gap-2 text-sm">
                      <span className="min-w-0 break-words">{o.title}</span>
                      <Badge tone={opportunityTone(o.stage)}>{tOppStage(o.stage)}</Badge>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">{t("noOpportunities")}</p>
              )}
              <Link href="/opportunities" className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline">
                {t("pipeline")}
              </Link>
            </Card>
          ) : null}

          {canReassign ? (
            <Card className="space-y-3">
              <CardTitle>{t("reassign")}</CardTitle>
              <ReassignForm
                customerId={c.id}
                employees={targets.map((e) => ({
                  value: e.id,
                  label: `${localizedName(locale, e.full_name_en, e.full_name_ar)} · ${e.job_title}`,
                }))}
              />
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  const empty = children === null || children === undefined || children === "";
  return (
    <div className="min-w-0 space-y-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words">{empty ? "—" : children}</dd>
    </div>
  );
}
