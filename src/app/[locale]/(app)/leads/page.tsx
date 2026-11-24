import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { PageHeader } from "@/components/ui/page-header";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { toLatLng } from "@/lib/maps/geo";
import { localizedName } from "@/modules/crm/logic";
import { chipClass, Empty, PageBody } from "@/modules/field/components/layout-bits";
import { GoogleAttribution } from "@/modules/leads/components/google-attribution";
import { LeadPlanButton } from "@/modules/leads/components/lead-forms";
import { LeadsMap, type LeadPin } from "@/modules/leads/components/leads-map";
import {
  collectAttributions,
  distanceParts,
  isOpen,
  LEADS_PAGE_SIZE,
  leadListHref,
  leadTitle,
  placeIdsNeedingDetails,
  statusTone,
  type DetailsState,
} from "@/modules/leads/logic";
import { listBaseLocations, listLeads, loadLeadDetails, placesConfigured } from "@/modules/leads/queries";
import { parseLeadListParams } from "@/modules/leads/schemas";
import { LEAD_FILTERS, type LeadRow } from "@/modules/leads/types";
import { mapsBrowserKey } from "@/modules/maps/queries";
import { cairoToday } from "@/modules/tracking/logic";

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Pick<Props, "params">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "leads.list" });
  return { title: t("title") };
}

/**
 * "Leads near me": dental clinics Google Places found around the rep's base, nearest first, as a
 * list or on the map. HONEST stores only the place id, its own status and notes and the distance;
 * names and addresses are loaded live from Google for the rows on screen (never stored), within
 * the owner's monthly budget.
 */
export default async function LeadsPage({ params, searchParams }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!can(ctx, "crm.lead.read")) return <Forbidden />;

  const lang = locale === "en" ? "en" : "ar";
  const t = await getTranslations("leads");
  const tErrors = await getTranslations("errors");
  const state = parseLeadListParams(await searchParams);
  const today = cairoToday();
  const manager = can(ctx, "crm.lead.read", "team");
  const mayWork = can(ctx, "crm.lead.work") && can(ctx, "field.visit.plan");

  const [page, bases] = await Promise.all([listLeads(state, today), listBaseLocations()]);
  const configured = placesConfigured();
  const details: DetailsState = page.ok ? await loadLeadDetails(placeIdsNeedingDetails(page.data.rows), lang) : { status: "error" };
  const detailMap = details.status === "ok" || details.status === "budget_reached" ? details.details : new Map();
  const myBase = bases.ok ? bases.data.find((b) => b.employee_id === ctx.employee?.id) : undefined;
  const baseMissing = !manager && bases.ok && (!myBase || myBase.base_lat === null);

  const distanceText = (row: LeadRow) => {
    const d = distanceParts(row.distance_m);
    return d ? t(`distance.${d.unit}`, { value: String(d.value) }) : null;
  };

  return (
    <PageBody>
      <PageHeader
        title={t("list.title")}
        description={t("list.intro")}
        actions={
          can(ctx, "crm.lead.assign") ? (
            <Link href="/leads/team" className={buttonVariants({ variant: "outline" })}>
              {t("nav.team")}
            </Link>
          ) : null
        }
      />

      {!configured ? <Alert tone="warning">{t("list.notConfigured")}</Alert> : null}
      {details.status === "budget_reached" ? <Alert tone="info">{t("list.budgetReached")}</Alert> : null}
      {baseMissing ? <Alert tone="info">{t("list.noBase")}</Alert> : null}

      <nav aria-label={t("list.filterLabel")} className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
        {LEAD_FILTERS.map((f) => (
          <Link key={f} href={leadListHref({ ...state, filter: f, page: 1 })} className={chipClass(state.filter === f)} aria-current={state.filter === f ? "page" : undefined}>
            {t(`filter.${f}`)}
          </Link>
        ))}
      </nav>

      <div className="flex flex-wrap items-end gap-2">
        <div className="flex gap-2" role="group" aria-label={t("list.viewLabel")}>
          {(["list", "map"] as const).map((v) => (
            <Link key={v} href={leadListHref({ ...state, view: v })} className={chipClass(state.view === v)} aria-current={state.view === v ? "page" : undefined}>
              {t(`view.${v}`)}
            </Link>
          ))}
        </div>
        {manager && bases.ok ? (
          <form method="get" className="flex items-end gap-2">
            {state.filter !== "open" ? <input type="hidden" name="filter" value={state.filter} /> : null}
            {state.view !== "list" ? <input type="hidden" name="view" value={state.view} /> : null}
            <div className="space-y-1">
              <Label htmlFor="f-rep">{t("list.rep")}</Label>
              <NativeSelect id="f-rep" name="rep" defaultValue={state.rep ?? ""}>
                <option value="">{t("list.allReps")}</option>
                {bases.data.map((b) => (
                  <option key={b.employee_id} value={b.employee_id}>
                    {localizedName(locale, b.full_name_en, b.full_name_ar)}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <button type="submit" className={buttonVariants({ variant: "outline" })}>
              {t("list.apply")}
            </button>
          </form>
        ) : null}
      </div>

      {!page.ok ? (
        <Alert>{tErrors(page.error.messageKey, { requestId: page.error.requestId ?? "—" })}</Alert>
      ) : page.data.rows.length === 0 ? (
        <Empty>{state.filter === "open" ? t("list.empty") : t("list.emptyFiltered")}</Empty>
      ) : (
        <>
          <p className="text-sm text-muted-foreground" role="status">
            {t("list.summary", { total: String(page.data.total), page: String(page.data.page), pages: String(page.data.pages) })}
          </p>

          {state.view === "map" ? (
            <LeadsMap
              apiKey={mapsBrowserKey()}
              locale={lang}
              base={myBase ? toLatLng(myBase.base_lat, myBase.base_lng) : null}
              pins={page.data.rows.flatMap((row): LeadPin[] => {
                const d = detailMap.get(row.place_id);
                if (!d || d.lat === null || d.lng === null) return [];
                return [
                  {
                    id: row.id,
                    lat: d.lat,
                    lng: d.lng,
                    title: leadTitle(row, d) ?? t("list.unnamed"),
                    address: d.address,
                    distance: distanceText(row),
                    status: t(`status.${row.status}`),
                    mapsUri: d.mapsUri,
                    planned: row.planned_for === today,
                  },
                ];
              })}
            />
          ) : null}

          <ol className="space-y-3">
            {page.data.rows.map((row, i) => {
              const d = detailMap.get(row.place_id);
              const title = leadTitle(row, d);
              const distance = distanceText(row);
              const plannedToday = row.planned_for === today;
              return (
                <li key={row.id} className="space-y-3 rounded-lg border bg-card p-4 shadow-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <p className="font-medium">
                        <span className="text-muted-foreground">{(page.data.page - 1) * LEADS_PAGE_SIZE + i + 1}. </span>
                        <Link href={`/leads/${row.id}`} className="text-primary underline-offset-4 hover:underline">
                          {title ?? t("list.unnamed")}
                        </Link>
                      </p>
                      {d?.address ? <p className="text-sm text-muted-foreground">{d.address}</p> : null}
                      {manager ? <p className="text-xs text-muted-foreground">{localizedName(locale, row.employee_name_en, row.employee_name_ar)}</p> : null}
                    </div>
                    {distance ? <Badge variant="outline">{distance}</Badge> : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={statusTone(row.status)}>{t(`status.${row.status}`)}</Badge>
                    {plannedToday ? <Badge tone="success">{t("plan.today")}</Badge> : row.planned_for ? <Badge>{t("plan.on", { date: row.planned_for })}</Badge> : null}
                    {!row.in_latest_run && isOpen(row.status) ? <Badge>{t("list.notSeenLately")}</Badge> : null}
                  </div>
                  <div className="flex flex-wrap items-start gap-2">
                    {mayWork && (row.status === "new" || row.status === "visited") ? (
                      <LeadPlanButton leadId={row.id} plannedToday={plannedToday} today={today} />
                    ) : null}
                    <Link href={`/leads/${row.id}`} className={buttonVariants({ variant: "outline", size: "sm", className: "min-h-11" })}>
                      {isOpen(row.status) && can(ctx, "crm.lead.work") ? t("list.openFirstVisit") : t("list.open")}
                    </Link>
                    {d?.mapsUri ? (
                      <a href={d.mapsUri} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: "ghost", size: "sm", className: "min-h-11" })}>
                        {t("list.directions")}
                      </a>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>

          {page.data.pages > 1 ? (
            <nav aria-label={t("list.pagination")} className="flex items-center justify-between gap-2">
              {page.data.page > 1 ? (
                <Link href={leadListHref({ ...state, page: page.data.page - 1 })} className={buttonVariants({ variant: "outline" })}>
                  {t("list.previous")}
                </Link>
              ) : (
                <span />
              )}
              {page.data.page < page.data.pages ? (
                <Link href={leadListHref({ ...state, page: page.data.page + 1 })} className={buttonVariants({ variant: "outline" })}>
                  {t("list.next")}
                </Link>
              ) : null}
            </nav>
          ) : null}

          {details.status === "error" ? <Alert tone="info">{t("list.detailsError")}</Alert> : null}
          <GoogleAttribution providers={collectAttributions(detailMap.values())} />
        </>
      )}
    </PageBody>
  );
}
