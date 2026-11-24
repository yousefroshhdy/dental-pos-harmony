import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { z } from "zod";
import {
  ArrowLeftIcon,
  CircleAlertIcon,
  ClipboardListIcon,
  FileTextIcon,
  MapPinIcon,
  MessageCircleIcon,
  PencilIcon,
  PhoneIcon,
  ShoppingCartIcon,
} from "lucide-react";
import { Forbidden } from "@/components/forbidden";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardAction, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { AddPhoneForm } from "@/modules/crm/components/add-phone-form";
import { CustomerTabs } from "@/modules/crm/components/customer-tabs";
import { GapBadges } from "@/modules/crm/components/gap-badges";
import { LocationForm } from "@/modules/crm/components/location-form";
import { LogActivityForm } from "@/modules/crm/components/log-activity-form";
import { ReassignForm } from "@/modules/crm/components/reassign-form";
import { CustomerMapPanel } from "@/modules/maps/components/customer-map-panel";
import { Timeline } from "@/modules/crm/components/timeline";
import { CAIRO_DATE, CAIRO_DATE_TIME, EGP } from "@/modules/crm/format";
import {
  cairoNowLocal,
  customerGaps,
  customerTabs,
  formatEgyptPhone,
  lifecycleTone,
  localizedName,
  locationStatus,
  opportunityTone,
  parseCustomerTab,
  telHref,
  toNumber,
  whatsappHref,
} from "@/modules/crm/logic";
import {
  CUSTOMER_TAB_LIMIT,
  getCustomer,
  getCustomerOverdue,
  listAssignableEmployees,
  listCustomerInvoices,
  listCustomerOrders,
  listCustomerVisits,
  listGovernorates,
  listOpportunities,
  listSpecialties,
  listTimeline,
} from "@/modules/crm/queries";
import type { CustomerRow } from "@/modules/crm/types";
import { VerdictBadge, VisitStatusBadge } from "@/modules/field/components/badges";
import { dateOnly } from "@/modules/field/format";
import type { UserContext } from "@/lib/authz/can";

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
const linkClass = "inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline";

/**
 * Customer page: header (stage, gaps, balance, contact actions), then sections as tabs
 * (overview, visits, orders, invoices, activity). Each tab reads only its own data, through
 * the user's session, so RLS decides what appears; the buttons follow the permissions only
 * for UX (every command checks again).
 */
export default async function CustomerPage({ params, searchParams }: Props) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  if (!z.guid().safeParse(id).success) notFound();

  const ctx = await getUserContext();
  if (!can(ctx, "crm.customer.read")) return <Forbidden />;

  const t = await getTranslations("crm.detail");
  const tStage = await getTranslations("crm.stage");
  const tKind = await getTranslations("crm.kind");
  const tErrors = await getTranslations("errors");
  const format = await getFormatter();
  const sp = await searchParams;

  const [customer, overdue] = await Promise.all([getCustomer(id), getCustomerOverdue(id)]);
  if (!customer.ok) return <Alert>{tErrors(customer.error.messageKey, { requestId: customer.error.requestId ?? "—" })}</Alert>;
  // RLS hides customers outside the user's scope: same answer as "does not exist".
  if (!customer.data) notFound();
  const c = customer.data;

  const tabs = customerTabs((permission) => can(ctx, permission));
  const tab = parseCustomerTab(sp.tab, tabs);

  const archived = c.archived_at !== null;
  const open = !archived;
  const territory = localizedName(locale, c.territory_name_en, c.territory_name_ar);
  const balance = toNumber(c.balance);
  const isOverdue = overdue.ok && overdue.data?.is_overdue === true;
  const gaps = customerGaps(c);
  const tel = telHref(c.phone_primary);
  const whatsapp = whatsappHref(c.phone_primary);

  const canEdit = open && can(ctx, "crm.customer.update");
  const canOrder = open && c.lifecycle_stage !== "blocked" && can(ctx, "sales.order.create");
  const canCheckIn = open && can(ctx, "field.visit.create") && ctx.employee !== null;
  const canOpportunity = open && c.lifecycle_stage !== "blocked" && can(ctx, "crm.opportunity.manage");
  const canStatement = can(ctx, "finance.ledger.read");
  const canCollect = open && can(ctx, "finance.payment.record");

  const secondary: { href: string; label: string }[] = [
    ...(canOpportunity ? [{ href: `/opportunities/new?customer=${c.id}`, label: t("newOpportunity") }] : []),
    ...(canStatement ? [{ href: `/finance/customers/${c.id}/statement`, label: t("statement") }] : []),
    ...(canCollect ? [{ href: `/finance/payments/new?customer=${c.id}`, label: t("recordPayment") }] : []),
  ];

  return (
    <div className="space-y-5 pb-4">
      <div className="space-y-2">
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
        {sp.warn === "phone_missing" && !c.phone_primary ? (
          <Alert tone="warning" role="status" className="flex flex-wrap items-center justify-between gap-2">
            <span>{t("phoneMissingCreated")}</span>
            {canEdit ? <AddPhoneForm customerId={c.id} version={c.version} customerName={c.display_name} variant="default" /> : null}
          </Alert>
        ) : null}
      </div>

      <PageHeader
        eyebrow={
          <Link href="/customers" className={linkClass}>
            <ArrowLeftIcon aria-hidden="true" className="me-1 size-4 rtl:rotate-180" />
            {t("back")}
          </Link>
        }
        title={<span className="break-words">{c.display_name}</span>}
        description={
          <>
            <span dir="ltr">{c.customer_no}</span> · {tKind(c.kind)}
            {territory ? ` · ${territory}` : ""}
          </>
        }
        actions={
          canEdit || canOrder || canCheckIn ? (
            <>
              {canOrder ? (
                <Link href={`/orders/new?customer=${c.id}`} className={buttonVariants({ className: "flex-1 sm:flex-none" })}>
                  <ShoppingCartIcon aria-hidden="true" />
                  {t("newOrder")}
                </Link>
              ) : null}
              {canCheckIn ? (
                <Link href={`/visits/new?customer=${c.id}`} className={buttonVariants({ variant: "outline", className: "flex-1 sm:flex-none" })}>
                  <MapPinIcon aria-hidden="true" />
                  {t("checkIn")}
                </Link>
              ) : null}
              {canEdit ? (
                <Link href={`/customers/${c.id}/edit`} className={buttonVariants({ variant: "outline", className: "flex-1 sm:flex-none" })}>
                  <PencilIcon aria-hidden="true" />
                  {t("edit")}
                </Link>
              ) : null}
            </>
          ) : null
        }
      />

      {/* Status strip: stage, gaps, overdue, balance. */}
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={lifecycleTone(c.lifecycle_stage)}>{tStage(c.lifecycle_stage)}</Badge>
        {archived ? <Badge tone="danger">{t("archived")}</Badge> : null}
        <GapBadges gaps={gaps} />
        {isOverdue ? (
          <Badge variant="danger">
            <CircleAlertIcon aria-hidden="true" />
            {t("overdue")}
          </Badge>
        ) : null}
        {/* NULL = masked: the user has no crm.customer_balance.read for this customer. */}
        {balance !== null ? (
          <span className="ms-auto text-sm">
            <span className="text-muted-foreground">{t("balance")}: </span>
            <span className="font-semibold tabular-nums">{format.number(balance, EGP)}</span>
          </span>
        ) : null}
      </div>

      {/* Contact: call / WhatsApp when a phone exists, otherwise "add phone". */}
      <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-4">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{t("contact")}</p>
          {c.phone_primary ? (
            <p dir="ltr" className="text-start text-base font-medium tabular-nums">
              {formatEgyptPhone(c.phone_primary)}
            </p>
          ) : (
            <GapBadges gaps={["phone_missing"]} />
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {tel ? (
            <a href={tel} className={buttonVariants({ variant: "outline", className: "flex-1 sm:flex-none" })}>
              <PhoneIcon aria-hidden="true" />
              {t("call")}
            </a>
          ) : null}
          {whatsapp ? (
            <a href={whatsapp} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: "outline", className: "flex-1 sm:flex-none" })}>
              <MessageCircleIcon aria-hidden="true" />
              {t("whatsapp")}
            </a>
          ) : null}
          {!c.phone_primary && canEdit ? <AddPhoneForm customerId={c.id} version={c.version} customerName={c.display_name} className="flex-1 sm:flex-none" /> : null}
        </div>
      </Card>

      {secondary.length > 0 ? (
        <div className="flex flex-wrap gap-x-4">
          {secondary.map((s) => (
            <Link key={s.href} href={s.href} className={linkClass}>
              {s.label}
            </Link>
          ))}
        </div>
      ) : null}

      <CustomerTabs customerId={c.id} tabs={tabs} current={tab} />

      {tab === "overview" ? <OverviewTab c={c} ctx={ctx} locale={locale} open={open} /> : null}
      {tab === "visits" ? <VisitsTab customerId={c.id} locale={locale} canCheckIn={canCheckIn} /> : null}
      {tab === "orders" ? <OrdersTab customerId={c.id} canOrder={canOrder} /> : null}
      {tab === "invoices" ? <InvoicesTab customerId={c.id} /> : null}
      {tab === "activity" ? <ActivityTab customerId={c.id} locale={locale} canLog={open && can(ctx, "crm.activity.create")} /> : null}
    </div>
  );
}

async function OverviewTab({ c, ctx, locale, open }: { c: CustomerRow; ctx: UserContext; locale: string; open: boolean }) {
  const t = await getTranslations("crm.detail");
  const tSource = await getTranslations("crm.source");
  const tLoc = await getTranslations("crm.locationStatus");
  const tOppStage = await getTranslations("crm.opportunityStage");
  const tErrors = await getTranslations("errors");
  const format = await getFormatter();

  const showOpportunities = can(ctx, "crm.opportunity.read");
  const [governorates, specialties, opportunities, employees] = await Promise.all([
    listGovernorates(),
    listSpecialties(),
    showOpportunities ? listOpportunities({ customerId: c.id, closedDays: 365 }) : Promise.resolve(null),
    listAssignableEmployees(),
  ]);
  const governorate = governorates.ok ? governorates.data.find((g) => g.code === c.governorate_code) : undefined;
  const specialty = specialties.ok ? specialties.data.find((s) => s.code === c.specialty_code) : undefined;
  const rep = localizedName(locale, c.primary_rep_name_en, c.primary_rep_name_ar);
  const loc = locationStatus(c);
  const lat = toNumber(c.latitude);
  const lng = toNumber(c.longitude);
  const balance = toNumber(c.balance);
  const creditLimit = toNumber(c.credit_limit);
  const canLocate = open && can(ctx, "crm.customer_location.verify");
  const targets = employees.ok ? employees.data.filter((e) => e.id !== c.primary_rep_employee_id) : [];
  const canReassign = open && targets.length > 0;

  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <div className="space-y-5 lg:col-span-2">
        <Card className="space-y-4">
          <CardTitle>{t("profile")}</CardTitle>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <Field label={t("doctor")}>{c.doctor_name}</Field>
            <Field label={t("clinic")}>{c.clinic_name}</Field>
            <Field label={t("phone")}>
              {c.phone_primary ? (
                <a href={`tel:${c.phone_primary}`} dir="ltr" className={linkClass}>
                  {formatEgyptPhone(c.phone_primary)}
                </a>
              ) : null}
            </Field>
            <Field label={t("phoneSecondary")}>
              {c.phone_secondary ? (
                <a href={`tel:${c.phone_secondary}`} dir="ltr" className={linkClass}>
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

        {showOpportunities ? (
          <Card className="space-y-3">
            <CardHeader>
              <CardTitle>{t("opportunities")}</CardTitle>
              <CardAction>
                <Link href="/opportunities" className={linkClass}>
                  {t("pipeline")}
                </Link>
              </CardAction>
            </CardHeader>
            {opportunities && !opportunities.ok ? (
              <Alert>{tErrors(opportunities.error.messageKey, { requestId: opportunities.error.requestId ?? "—" })}</Alert>
            ) : opportunities && opportunities.data.length > 0 ? (
              <ul className="divide-y">
                {opportunities.data.map((o) => (
                  <li key={o.id} className="flex min-h-11 items-center justify-between gap-2 py-2 text-sm">
                    <span className="min-w-0 break-words">{o.title}</span>
                    <Badge tone={opportunityTone(o.stage)}>{tOppStage(o.stage)}</Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState compact title={t("noOpportunities")} />
            )}
          </Card>
        ) : null}
      </div>

      <div className="space-y-5">
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
                className={linkClass}
              >
                {t("openMap")}
              </a>
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">{t("noLocation")}</p>
          )}
          {canLocate ? <LocationForm customerId={c.id} hasLocation={lat !== null} /> : null}
        </Card>
        <CustomerMapPanel customer={c} locale={locale} />

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
  );
}

async function VisitsTab({ customerId, locale, canCheckIn }: { customerId: string; locale: string; canCheckIn: boolean }) {
  const t = await getTranslations("crm.detail");
  const tOutcome = await getTranslations("field.outcome");
  const tErrors = await getTranslations("errors");
  const format = await getFormatter();
  const visits = await listCustomerVisits(customerId);

  return (
    <Card className="space-y-3">
      <CardHeader>
        <CardTitle>{t("tabs.visits")}</CardTitle>
        {canCheckIn ? (
          <CardAction>
            <Link href={`/visits/new?customer=${customerId}`} className={buttonVariants({ variant: "outline" })}>
              <MapPinIcon aria-hidden="true" />
              {t("checkIn")}
            </Link>
          </CardAction>
        ) : null}
      </CardHeader>
      {!visits.ok ? (
        <EmptyState compact tone="danger" title={tErrors(visits.error.messageKey, { requestId: visits.error.requestId ?? "—" })} />
      ) : visits.data.length === 0 ? (
        <EmptyState compact icon={<MapPinIcon aria-hidden="true" />} title={t("noVisits")} />
      ) : (
        <>
          <ul className="divide-y">
            {visits.data.map((v) => (
              <li key={v.id}>
                <Link href={`/visits/${v.id}`} className="flex min-h-11 flex-wrap items-center justify-between gap-2 py-3 hover:bg-muted/40">
                  <span className="min-w-0 space-y-0.5">
                    <span className="block text-sm font-medium">
                      {v.check_in_at
                        ? format.dateTime(new Date(v.check_in_at), CAIRO_DATE_TIME)
                        : v.planned_for
                          ? t("plannedFor", { date: format.dateTime(dateOnly(v.planned_for), CAIRO_DATE) })
                          : "—"}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {localizedName(locale, v.employee_name_en, v.employee_name_ar)}
                      {v.outcome ? ` · ${tOutcome(v.outcome)}` : ""}
                    </span>
                  </span>
                  <span className="flex flex-wrap gap-1">
                    <VisitStatusBadge status={v.status} />
                    {v.status !== "planned" ? <VerdictBadge status={v.verification_status} /> : null}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          <TabFooter count={visits.data.length} href="/visits" label={t("allVisits")} />
        </>
      )}
    </Card>
  );
}

async function OrdersTab({ customerId, canOrder }: { customerId: string; canOrder: boolean }) {
  const t = await getTranslations("crm.detail");
  const tStatus = await getTranslations("orders.status");
  const tErrors = await getTranslations("errors");
  const format = await getFormatter();
  const orders = await listCustomerOrders(customerId);

  return (
    <Card className="space-y-3">
      <CardHeader>
        <CardTitle>{t("tabs.orders")}</CardTitle>
        {canOrder ? (
          <CardAction>
            <Link href={`/orders/new?customer=${customerId}`} className={buttonVariants({ variant: "outline" })}>
              <ShoppingCartIcon aria-hidden="true" />
              {t("newOrder")}
            </Link>
          </CardAction>
        ) : null}
      </CardHeader>
      {!orders.ok ? (
        <EmptyState compact tone="danger" title={tErrors(orders.error.messageKey, { requestId: orders.error.requestId ?? "—" })} />
      ) : orders.data.length === 0 ? (
        <EmptyState compact icon={<ClipboardListIcon aria-hidden="true" />} title={t("noOrders")} />
      ) : (
        <>
          <ul className="divide-y">
            {orders.data.map((o) => {
              const total = toNumber(o.total);
              return (
                <li key={o.id}>
                  <Link href={`/orders/${o.id}`} className="flex min-h-11 flex-wrap items-center justify-between gap-2 py-3 hover:bg-muted/40">
                    <span className="min-w-0 space-y-0.5">
                      <span dir="ltr" className="block text-start text-sm font-medium">
                        {o.order_no ?? "—"}
                      </span>
                      <span className="block text-xs text-muted-foreground">{format.dateTime(new Date(o.created_at), CAIRO_DATE)}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      {total !== null ? <span className="text-sm tabular-nums">{format.number(total, EGP)}</span> : null}
                      <Badge>{tStatus.has(o.status) ? tStatus(o.status) : o.status}</Badge>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
          <TabFooter count={orders.data.length} href="/orders" label={t("allOrders")} />
        </>
      )}
    </Card>
  );
}

async function InvoicesTab({ customerId }: { customerId: string }) {
  const t = await getTranslations("crm.detail");
  const tStatus = await getTranslations("finance.invoiceStatus");
  const tErrors = await getTranslations("errors");
  const format = await getFormatter();
  const invoices = await listCustomerInvoices(customerId);

  return (
    <Card className="space-y-3">
      <CardTitle>{t("tabs.invoices")}</CardTitle>
      {!invoices.ok ? (
        <EmptyState compact tone="danger" title={tErrors(invoices.error.messageKey, { requestId: invoices.error.requestId ?? "—" })} />
      ) : invoices.data.length === 0 ? (
        <EmptyState compact icon={<FileTextIcon aria-hidden="true" />} title={t("noInvoices")} />
      ) : (
        <>
          <ul className="divide-y">
            {invoices.data.map((inv) => {
              const openAmount = toNumber(inv.open_amount) ?? 0;
              return (
                <li key={inv.id}>
                  <Link href={`/finance/invoices/${inv.id}`} className="flex min-h-11 flex-wrap items-center justify-between gap-2 py-3 hover:bg-muted/40">
                    <span className="min-w-0 space-y-0.5">
                      <span dir="ltr" className="block text-start text-sm font-medium">
                        {inv.invoice_no}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {format.dateTime(dateOnly(inv.issue_date), CAIRO_DATE)} · {t("dueDate")} {format.dateTime(dateOnly(inv.due_date), CAIRO_DATE)}
                      </span>
                    </span>
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-sm tabular-nums">{format.number(toNumber(inv.total) ?? 0, EGP)}</span>
                      {openAmount > 0 ? (
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {t("open")}: {format.number(openAmount, EGP)}
                        </span>
                      ) : null}
                      {inv.is_overdue && openAmount > 0 ? <Badge variant="danger">{t("overdue")}</Badge> : null}
                      <Badge>{tStatus.has(inv.status) ? tStatus(inv.status) : inv.status}</Badge>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
          <TabFooter count={invoices.data.length} href={`/finance/invoices?customer=${customerId}&status=all`} label={t("allInvoices")} />
        </>
      )}
    </Card>
  );
}

async function ActivityTab({ customerId, locale, canLog }: { customerId: string; locale: string; canLog: boolean }) {
  const t = await getTranslations("crm.detail");
  const tErrors = await getTranslations("errors");
  const timeline = await listTimeline(customerId);
  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <Card className="space-y-3 lg:col-span-2">
        <CardTitle>{t("timeline")}</CardTitle>
        {timeline.ok ? (
          <Timeline rows={timeline.data} locale={locale} />
        ) : (
          <EmptyState compact tone="danger" title={tErrors(timeline.error.messageKey, { requestId: timeline.error.requestId ?? "—" })} />
        )}
      </Card>
      {canLog ? (
        <Card className="space-y-3">
          <CardTitle>{t("logActivity")}</CardTitle>
          <LogActivityForm customerId={customerId} maxLocal={cairoNowLocal()} />
        </Card>
      ) : null}
    </div>
  );
}

async function TabFooter({ count, href, label }: { count: number; href: string; label: string }) {
  const t = await getTranslations("crm.detail");
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
      {count >= CUSTOMER_TAB_LIMIT ? <span className="text-muted-foreground">{t("latest", { limit: CUSTOMER_TAB_LIMIT })}</span> : <span />}
      <Link href={href} className={linkClass}>
        {label}
      </Link>
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
