import type { Metadata } from "next";
import { getFormatter, getLocale, getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { Badge, Card, CardTitle } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { AdjustmentForm } from "@/modules/commissions/components/adjustment-form";
import { CommissionError } from "@/modules/commissions/components/commission-error";
import { CAIRO_DATE_TIME, formatEgp, formatMonth } from "@/modules/commissions/format";
import { cairoToday, commissionErrorCode, recalculableMonths, requestTone } from "@/modules/commissions/logic";
import { listAdjustableEmployees, listAdjustmentRequests, listPeriods, REQUEST_LIMIT } from "@/modules/commissions/queries";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "commissions.adjust" });
  return { title: t("title") };
}

/**
 * Commission adjustments: request a bonus, clawback or correction (perf.commission.adjust)
 * and follow the requests. Each one goes through the 'perf.commission_adjustment'
 * approval; nobody adjusts their own commission or approves their own request.
 */
export default async function CommissionAdjustmentsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  const canAdjust = can(ctx, "perf.commission.adjust");
  if (!canAdjust && !can(ctx, "perf.commission.read")) return <Forbidden />;

  const t = await getTranslations("commissions");
  const format = await getFormatter();
  const lang = await getLocale();
  const today = cairoToday();
  const [requests, employees, periods] = await Promise.all([
    listAdjustmentRequests(),
    canAdjust ? listAdjustableEmployees(lang, ctx.employee?.id ?? null) : Promise.resolve(null),
    canAdjust ? listPeriods() : Promise.resolve(null),
  ]);
  // Open months only (the oldest open one up to the current month); the DB re-checks.
  const months = periods?.ok
    ? recalculableMonths(periods.data, today)
        .reverse()
        .map((m) => ({ value: m, label: formatMonth(format, m) }))
    : [];

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">{t("adjust.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("adjust.intro")}</p>
      </div>

      {canAdjust ? (
        <Card className="space-y-4">
          <CardTitle>{t("adjust.new")}</CardTitle>
          {employees && !employees.ok ? (
            <CommissionError code={commissionErrorCode(employees.error)} requestId={employees.error.requestId} />
          ) : periods && !periods.ok ? (
            <CommissionError code={commissionErrorCode(periods.error)} requestId={periods.error.requestId} />
          ) : (
            <AdjustmentForm employees={employees?.ok ? employees.data : []} months={months} />
          )}
        </Card>
      ) : null}

      <section className="space-y-3" aria-labelledby="adjustment-requests">
        <h2 id="adjustment-requests" className="text-lg font-semibold">
          {t("adjust.requests")}
        </h2>
        {!requests.ok ? (
          <CommissionError code={commissionErrorCode(requests.error)} requestId={requests.error.requestId} />
        ) : requests.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("adjust.requestsEmpty")}</p>
        ) : (
          <ul className="divide-y rounded-lg border bg-card">
            {requests.data.map((r) => (
              <li key={r.request_id} className="flex flex-col gap-1 px-3 py-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={requestTone(r.status)}>{t(`adjust.status.${r.status}`)}</Badge>
                    <span className="text-sm font-medium">
                      {(lang === "ar" ? r.employee_name_ar : null) ?? r.employee_name_en ?? r.employee_no ?? "—"}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {t(`kind.${r.kind}`)} · {formatMonth(format, r.period_start)}
                    </span>
                  </div>
                  <p className="text-sm break-words">{r.reason}</p>
                  <p className="text-xs text-muted-foreground">
                    {t("adjust.requestedOn", { at: format.dateTime(new Date(r.created_at), CAIRO_DATE_TIME) })}
                    {r.is_mine ? ` · ${t("adjust.mine")}` : null}
                    {r.status === "pending" ? (
                      <>
                        {" · "}
                        <Link href={`/approvals/${r.request_id}`} className="text-primary underline-offset-4 hover:underline">
                          {t("adjust.openApproval")}
                        </Link>
                      </>
                    ) : null}
                  </p>
                </div>
                <p className="shrink-0 text-base font-semibold tabular-nums sm:text-end">{formatEgp(format, r.amount)}</p>
              </li>
            ))}
          </ul>
        )}
        {requests.ok && requests.data.length >= REQUEST_LIMIT ? (
          <p className="text-xs text-muted-foreground">{t("adjust.limited", { count: REQUEST_LIMIT })}</p>
        ) : null}
      </section>
    </div>
  );
}
