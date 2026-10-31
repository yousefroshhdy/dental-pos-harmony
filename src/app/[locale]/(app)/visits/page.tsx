import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { VerdictBadge, VisitStatusBadge } from "@/modules/field/components/badges";
import { FieldError } from "@/modules/field/components/field-error";
import { BottomActions, chipClass, Empty, Item, ItemList, PageBody } from "@/modules/field/components/layout-bits";
import { CAIRO_DATE, CAIRO_DATE_TIME, METRES, dateOnly } from "@/modules/field/format";
import { localizedName, toMetres } from "@/modules/field/logic";
import { LIST_LIMIT, listVisits } from "@/modules/field/queries";
import { VISIT_STATUSES, type VisitStatus } from "@/modules/field/types";
import { ExportCsvButton } from "@/modules/reports/components/export-csv-button";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "field.visits" });
  return { title: t("title") };
}

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function VisitsPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: SearchParams }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!can(ctx, "field.visit.read")) return <Forbidden />;

  const sp = await searchParams;
  const statusParam = first(sp.status);
  const status = (VISIT_STATUSES as readonly string[]).includes(statusParam ?? "") ? (statusParam as VisitStatus) : undefined;
  // Wider read scopes may look at the team's visits; "own" sees only their own anyway (RLS).
  const mayBrowseOthers = can(ctx, "field.visit.read", "team");
  const who = mayBrowseOthers && first(sp.who) === "all" ? "all" : "mine";

  const t = await getTranslations("field.visits");
  const tStatus = await getTranslations("field.visitStatus");
  const tOutcome = await getTranslations("field.outcome");
  const format = await getFormatter();

  const visits = await listVisits({ employeeId: who === "mine" ? (ctx.employee?.id ?? undefined) : undefined, status });

  const href = (change: { who?: string; status?: string | null }) => {
    const qs = new URLSearchParams();
    const nextWho = change.who ?? who;
    const nextStatus = change.status === null ? undefined : (change.status ?? status);
    if (nextWho === "all") qs.set("who", "all");
    if (nextStatus) qs.set("status", nextStatus);
    const s = qs.toString();
    return s ? `/visits?${s}` : "/visits";
  };

  return (
    <PageBody>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <ExportCsvButton ctx={ctx} kind="visits" filters={{ status, who }} label={t("export")} />
          {can(ctx, "field.visit.create") && ctx.employee ? (
            <BottomActions label={t("actions")}>
              <Link href="/visits/new" className={buttonVariants()}>
                {t("checkInUnplanned")}
              </Link>
            </BottomActions>
          ) : null}
        </div>
      </div>

      <nav aria-label={t("filters")} className="space-y-2">
        {mayBrowseOthers ? (
          <div className="flex gap-2 overflow-x-auto pb-1">
            <Link href={href({ who: "mine" })} className={chipClass(who === "mine")} aria-current={who === "mine" ? "page" : undefined}>
              {t("mine")}
            </Link>
            <Link href={href({ who: "all" })} className={chipClass(who === "all")} aria-current={who === "all" ? "page" : undefined}>
              {t("team")}
            </Link>
          </div>
        ) : null}
        <div className="flex gap-2 overflow-x-auto pb-1">
          <Link href={href({ status: null })} className={chipClass(!status)} aria-current={!status ? "page" : undefined}>
            {t("allStatuses")}
          </Link>
          {VISIT_STATUSES.map((s) => (
            <Link key={s} href={href({ status: s })} className={chipClass(status === s)} aria-current={status === s ? "page" : undefined}>
              {tStatus(s)}
            </Link>
          ))}
        </div>
      </nav>

      {!visits.ok ? (
        <FieldError code={visits.error.code} messageKey={visits.error.messageKey} requestId={visits.error.requestId} />
      ) : visits.data.length === 0 ? (
        <Empty>{t("empty")}</Empty>
      ) : (
        <>
          <ItemList>
            {visits.data.map((v) => {
              const distance = toMetres(v.check_in_distance_m);
              const employee = localizedName(locale, v.employee_name_en, v.employee_name_ar);
              return (
                <Item key={v.id} className="p-0">
                  <Link href={`/visits/${v.id}`} className="block space-y-2 rounded-lg p-4 hover:bg-muted/50">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <p className="min-w-0 font-medium break-words">{v.customer_name ?? "—"}</p>
                      <div className="flex flex-wrap gap-1">
                        <VisitStatusBadge status={v.status} />
                        {v.status !== "planned" ? <VerdictBadge status={v.verification_status} /> : null}
                      </div>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {v.check_in_at
                        ? format.dateTime(new Date(v.check_in_at), CAIRO_DATE_TIME)
                        : v.planned_for
                          ? t("plannedFor", { date: format.dateTime(dateOnly(v.planned_for), CAIRO_DATE) })
                          : "—"}
                      {distance !== null ? ` · ${t("distance", { distance: format.number(distance, METRES) })}` : ""}
                    </p>
                    <div className="flex flex-wrap gap-1 text-sm">
                      {v.outcome ? <Badge>{tOutcome(v.outcome)}</Badge> : null}
                      {v.anomaly_flags.length > 0 ? <Badge tone="warning">{t("flagged", { count: v.anomaly_flags.length })}</Badge> : null}
                      {who === "all" && employee ? <span className="text-muted-foreground">{employee}</span> : null}
                    </div>
                  </Link>
                </Item>
              );
            })}
          </ItemList>
          {visits.data.length >= LIST_LIMIT ? <p className="text-sm text-muted-foreground">{t("limited", { limit: LIST_LIMIT })}</p> : null}
        </>
      )}
    </PageBody>
  );
}
