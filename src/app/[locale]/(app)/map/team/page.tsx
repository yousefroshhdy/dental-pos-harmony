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
import { localizedName } from "@/modules/crm/logic";
import { Item, ItemList, PageBody } from "@/modules/field/components/layout-bits";
import { MapTabs } from "@/modules/maps/components/map-tabs";
import { TeamMap } from "@/modules/maps/components/team-map";
import { freshness, minutesSince, teamPoints } from "@/modules/maps/logic";
import { listTeamLocations, mapsBrowserKey } from "@/modules/maps/queries";
import { cairoToday } from "@/modules/tracking/logic";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "maps.team" });
  return { title: t("title") };
}

const TONE = { fresh: "success", stale: "warning", old: "danger" } as const;
const CAIRO_TIME = { timeStyle: "short", timeZone: "Africa/Cairo", numberingSystem: "latn" } as const;

/**
 * Team map for managers (api.v_team_last_location): the last usable point of each rep in the
 * manager's field.tracking.read scope, during an open shift only (D-14). A rep who has ended
 * the day, or never started it, is not on the map.
 */
export default async function TeamMapPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!can(ctx, "field.tracking.read")) return <Forbidden />;

  const lang = locale === "en" ? "en" : "ar";
  const t = await getTranslations("maps.team");
  const tErrors = await getTranslations("errors");
  const format = await getFormatter();
  const result = await listTeamLocations();
  const day = cairoToday();
  const now = new Date();

  return (
    <PageBody>
      <PageHeader title={t("title")} description={t("explain")} />
      <MapTabs ctx={ctx} current="/map/team" />
      {!result.ok ? (
        <Alert>{tErrors(result.error.messageKey, { requestId: result.error.requestId ?? "—" })}</Alert>
      ) : result.data.length === 0 ? (
        <EmptyState icon={<MapPinIcon aria-hidden="true" />} title={t("empty")} />
      ) : (
        <>
          <TeamMap apiKey={mapsBrowserKey()} locale={lang} points={teamPoints(result.data)} day={day} />
          <ItemList>
            {result.data.map((r) => {
              const minutes = minutesSince(r.captured_at, now);
              return (
                <Item key={r.employee_id} className="flex flex-wrap items-center justify-between gap-2">
                  <div className="space-y-1">
                    <p className="font-medium">{localizedName(locale, r.full_name_en, r.full_name_ar) || t("unnamed")}</p>
                    <p className="text-sm text-muted-foreground">
                      {r.point_source === "ping" ? t("lastPoint", { time: format.dateTime(new Date(r.captured_at), CAIRO_TIME) }) : t("startPoint")}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone={TONE[freshness(minutes)]}>{t("minutesAgo", { minutes: String(minutes) })}</Badge>
                    <Link href={`/tracking/${r.employee_id}/${day}`} className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline">
                      {t("openDay")}
                    </Link>
                  </div>
                </Item>
              );
            })}
          </ItemList>
        </>
      )}
    </PageBody>
  );
}
