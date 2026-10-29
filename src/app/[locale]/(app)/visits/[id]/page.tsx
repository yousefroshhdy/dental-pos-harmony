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
import { VerdictBadge, VisitStatusBadge } from "@/modules/field/components/badges";
import { CheckOutForm } from "@/modules/field/components/check-out-form";
import { ExceptionForm } from "@/modules/field/components/exception-form";
import { FieldError } from "@/modules/field/components/field-error";
import { PageBody } from "@/modules/field/components/layout-bits";
import { CAIRO_DATE, CAIRO_DATE_TIME, METRES, dateOnly } from "@/modules/field/format";
import { canCheckOut, canRequestException, localizedName, needsException, toMetres } from "@/modules/field/logic";
import { getVisit } from "@/modules/field/queries";
import { ANOMALY_FLAGS } from "@/modules/field/types";

type Params = Promise<{ locale: string; id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "field.visit" });
  return { title: t("metaTitle") };
}

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function VisitPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const { locale, id } = await params;
  const { checkedOut: checkedOutParam } = await searchParams;
  // Set by CheckOutForm after a successful check-out; only selects a confirmation text.
  const checkedOut = checkedOutParam === "followUp" ? "followUp" : checkedOutParam === "1" ? "done" : null;
  setRequestLocale(locale);
  if (!z.guid().safeParse(id).success) notFound();

  const ctx = await getUserContext();
  if (!can(ctx, "field.visit.read")) return <Forbidden />;

  const t = await getTranslations("field.visit");
  const tHelp = await getTranslations("field.checkIn.help");
  const tOutcome = await getTranslations("field.outcome");
  const tFlag = await getTranslations("field.anomaly");
  const tOut = await getTranslations("field.checkOut");
  const format = await getFormatter();

  const visit = await getVisit(id);
  if (!visit.ok) return <FieldError code={visit.error.code} messageKey={visit.error.messageKey} requestId={visit.error.requestId} />;
  if (!visit.data) notFound(); // missing, or outside the caller's scope (RLS)
  const v = visit.data;

  const distance = toMetres(v.check_in_distance_m);
  const accuracy = toMetres(v.check_in_accuracy_m);
  const mine = v.employee_id === ctx.employee?.id;
  const dt = (iso: string | null) => (iso ? format.dateTime(new Date(iso), CAIRO_DATE_TIME) : "—");

  const rows: [string, ReactNode][] = [
    [t("status"), <VisitStatusBadge key="s" status={v.status} />],
    [t("verdict"), v.status === "planned" ? "—" : <VerdictBadge key="v" status={v.verification_status} />],
    [t("plannedFor"), v.planned_for ? format.dateTime(dateOnly(v.planned_for), CAIRO_DATE) : "—"],
    [t("checkIn"), dt(v.check_in_at)],
    [t("checkOut"), dt(v.check_out_at)],
    [t("distance"), distance !== null ? format.number(distance, METRES) : "—"],
    [t("accuracy"), accuracy !== null ? format.number(accuracy, METRES) : "—"],
    [t("outcome"), v.outcome ? tOutcome(v.outcome) : "—"],
  ];
  if (!mine) rows.splice(1, 0, [t("employee"), localizedName(locale, v.employee_name_en, v.employee_name_ar) || "—"]);

  const knownFlags = v.anomaly_flags.filter((f) => (ANOMALY_FLAGS as readonly string[]).includes(f));

  return (
    <PageBody className="mx-auto max-w-2xl">
      <div className="space-y-1">
        <Link href="/visits" className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline">
          {t("back")}
        </Link>
        <h1 className="text-2xl font-semibold break-words">{v.customer_name ?? t("metaTitle")}</h1>
        {v.customer_no ? (
          <p dir="ltr" className="text-sm text-muted-foreground">
            {v.customer_no}
          </p>
        ) : null}
      </div>

      {checkedOut && v.status === "completed" ? (
        <Alert tone="success" role="status">
          {checkedOut === "followUp" ? tOut("doneWithFollowUp") : tOut("done")}
        </Alert>
      ) : null}

      <Card className="space-y-3">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        {v.status !== "planned" && v.verification_status !== "pending" ? (
          <p className="text-sm text-muted-foreground">{tHelp(v.verification_status)}</p>
        ) : null}
        {knownFlags.length > 0 ? (
          <div className="space-y-1">
            <p className="text-sm font-medium">{t("flags")}</p>
            <ul className="flex flex-wrap gap-1">
              {knownFlags.map((f) => (
                <li key={f}>
                  <Badge tone="warning">{tFlag(f)}</Badge>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">{t("flagsHint")}</p>
          </div>
        ) : null}
        {v.notes ? (
          <div className="space-y-1">
            <p className="text-sm font-medium">{t("notes")}</p>
            <p className="text-sm whitespace-pre-wrap break-words">{v.notes}</p>
          </div>
        ) : null}
      </Card>

      {canRequestException(ctx, v) ? (
        <Card className="space-y-3">
          <CardTitle>{t("exceptionTitle")}</CardTitle>
          <ExceptionForm visitId={v.id} refreshOnSuccess />
        </Card>
      ) : needsException(v.verification_status) && mine ? (
        <p className="text-sm text-muted-foreground">{t("exceptionUnavailable")}</p>
      ) : null}

      {canCheckOut(ctx, v) && ctx.user_id ? (
        <Card className="space-y-3">
          <CardTitle>{t("checkOutTitle")}</CardTitle>
          <CheckOutForm visitId={v.id} userId={ctx.user_id} />
        </Card>
      ) : null}

      {can(ctx, "work.task.manage") ? (
        <Link href={`/tasks?customer=${v.customer_id}#new-task`} className={buttonVariants({ variant: "outline", className: "w-full sm:w-auto" })}>
          {t("newTask")}
        </Link>
      ) : null}
    </PageBody>
  );
}
