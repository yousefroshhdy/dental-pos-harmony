import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { MapPinIcon } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Forbidden } from "@/components/forbidden";
import { Alert, Badge } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { seesSetupDetails } from "@/lib/maps/config";
import { placeUrl, toLatLng } from "@/lib/maps/geo";
import { localizedName, MAX_LOCATION_ACCURACY_M } from "@/modules/crm/logic";
import { chipClass, Item, ItemList, PageBody } from "@/modules/field/components/layout-bits";
import { DecideProposalForm } from "@/modules/maps/components/decide-proposal-form";
import { MapTabs } from "@/modules/maps/components/map-tabs";
import { ProposalsMap, type ProposalPin } from "@/modules/maps/components/proposals-map";
import { listLocationProposals, mapsBrowserKey } from "@/modules/maps/queries";

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Pick<Props, "params">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "maps.proposals" });
  return { title: t("title") };
}

const CAIRO_DATE_TIME = { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Cairo", numberingSystem: "latn" } as const;
const STATUS_TONE = { pending: "warning", approved: "success", rejected: "danger", superseded: "neutral" } as const;

/**
 * Pin proposals (pin on first visit): a rep's check-in at a clinic without a location proposes
 * the fix; a crm.customer_location.verify holder approves it as the clinic pin or rejects it.
 * RLS shows only the proposals of customers in the verifier's scope.
 */
export default async function LocationProposalsPage({ params, searchParams }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!can(ctx, "crm.customer_location.verify")) return <Forbidden />;

  const lang = locale === "en" ? "en" : "ar";
  const sp = await searchParams;
  const view = sp.view === "decided" ? "decided" : "pending";
  const t = await getTranslations("maps.proposals");
  const tErrors = await getTranslations("errors");
  const tFlags = await getTranslations("maps.visitFlags");
  const format = await getFormatter();
  const result = await listLocationProposals(view);

  const rows = result.ok ? result.data : [];
  const pins: ProposalPin[] = [];
  rows.forEach((r, i) => {
    const p = toLatLng(r.latitude, r.longitude);
    if (p && view === "pending") {
      pins.push({ id: r.id, ...p, n: i + 1, customerName: r.customer_name ?? r.customer_no ?? "—", repName: localizedName(locale, r.proposed_by_name_en, r.proposed_by_name_ar) });
    }
  });

  return (
    <PageBody>
      <PageHeader title={t("title")} description={t("explain")} />
      <MapTabs ctx={ctx} current="/map/proposals" />
      <nav aria-label={t("viewLabel")} className="flex gap-2">
        <Link href="/map/proposals" className={chipClass(view === "pending")}>
          {t("pending")}
        </Link>
        <Link href="/map/proposals?view=decided" className={chipClass(view === "decided")}>
          {t("decidedTab")}
        </Link>
      </nav>

      {!result.ok ? (
        <Alert>{tErrors(result.error.messageKey, { requestId: result.error.requestId ?? "—" })}</Alert>
      ) : rows.length === 0 ? (
        <EmptyState icon={<MapPinIcon aria-hidden="true" />} title={view === "pending" ? t("emptyPending") : t("emptyDecided")} />
      ) : (
        <>
          {view === "pending" && pins.length > 0 ? <ProposalsMap apiKey={mapsBrowserKey()} setupHint={seesSetupDetails(ctx)} locale={lang} pins={pins} /> : null}
          <ItemList>
            {rows.map((r, i) => {
              const accuracy = r.accuracy_m === null ? null : Math.round(Number(r.accuracy_m));
              const inaccurate = accuracy === null || accuracy > MAX_LOCATION_ACCURACY_M;
              const p = toLatLng(r.latitude, r.longitude);
              return (
                <Item key={r.id}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 space-y-1">
                      <p className="font-medium break-words">
                        {view === "pending" ? `${i + 1}. ` : ""}
                        <Link href={`/customers/${r.customer_id}`} className="tap-link text-primary underline-offset-4 hover:underline">
                          {r.customer_name ?? r.customer_no}
                        </Link>
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {t("proposedBy", {
                          name: localizedName(locale, r.proposed_by_name_en, r.proposed_by_name_ar) || "—",
                          time: format.dateTime(new Date(r.captured_at), CAIRO_DATE_TIME),
                        })}
                      </p>
                    </div>
                    <Badge tone={STATUS_TONE[r.status]}>{t(`status.${r.status}`)}</Badge>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    <Badge tone={inaccurate ? "warning" : "neutral"}>
                      {accuracy === null ? t("accuracyUnknown") : t("accuracy", { metres: String(accuracy) })}
                    </Badge>
                    {r.anomaly_flags.map((f) => (
                      <Badge key={f} tone="warning">
                        {tFlags.has(f) ? tFlags(f) : f}
                      </Badge>
                    ))}
                    {p ? (
                      <a href={placeUrl(p)} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center px-1 text-sm text-primary underline-offset-4 hover:underline">
                        {t("openInMaps")}
                      </a>
                    ) : null}
                  </div>
                  {r.status === "pending" ? (
                    <DecideProposalForm proposalId={r.id} inaccurate={inaccurate} />
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {r.decided_at
                        ? t("decidedBy", {
                            name: localizedName(locale, r.decided_by_name_en, r.decided_by_name_ar) || "—",
                            time: format.dateTime(new Date(r.decided_at), CAIRO_DATE_TIME),
                          })
                        : t("supersededNote")}
                      {r.decision_note ? ` · ${r.decision_note}` : ""}
                    </p>
                  )}
                </Item>
              );
            })}
          </ItemList>
        </>
      )}
    </PageBody>
  );
}
