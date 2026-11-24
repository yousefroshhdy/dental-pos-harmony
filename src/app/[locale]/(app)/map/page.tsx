import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { PageHeader } from "@/components/ui/page-header";
import { Forbidden } from "@/components/forbidden";
import { Button, buttonVariants } from "@/components/ui/button";
import { Alert, Badge, Card, Label, Select } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { seesSetupDetails } from "@/lib/maps/config";
import { listAssignableEmployees, listTerritories } from "@/modules/crm/queries";
import { localizedName } from "@/modules/crm/logic";
import { LIFECYCLE_STAGES } from "@/modules/crm/types";
import { Empty, PageBody } from "@/modules/field/components/layout-bits";
import { CustomersMap } from "@/modules/maps/components/customers-map";
import { MapTabs } from "@/modules/maps/components/map-tabs";
import { activeFilterCount, pinnedCustomers } from "@/modules/maps/logic";
import { CUSTOMER_MAP_LIMIT, listCustomerMap, mapsBrowserKey } from "@/modules/maps/queries";
import { parseCustomerMapFilters } from "@/modules/maps/schemas";
import { LAST_VISIT_FILTERS } from "@/modules/maps/types";

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Pick<Props, "params">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "maps.customers" });
  return { title: t("title") };
}

/**
 * The customers map (api.v_customer_map, RLS-scoped like the customer list): filters for rep,
 * territory, stage, overdue AR and last visit, as a GET form so a filtered map is a link.
 * The pins are also listed as text below the map (accessible, and usable without a key).
 */
export default async function CustomersMapPage({ params, searchParams }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!can(ctx, "crm.customer.read")) return <Forbidden />;

  const lang = locale === "en" ? "en" : "ar";
  const t = await getTranslations("maps.customers");
  const tStage = await getTranslations("crm.stage");
  const tErrors = await getTranslations("errors");
  const filters = parseCustomerMapFilters(await searchParams);
  const [data, territories, reps] = await Promise.all([listCustomerMap(filters), listTerritories(), listAssignableEmployees()]);
  const apiKey = mapsBrowserKey();
  const filtered = activeFilterCount(filters) > 0;

  return (
    <PageBody>
      <PageHeader title={t("title")} />
      <MapTabs ctx={ctx} current="/map" />

      <Card className="p-3 sm:p-4">
        <form method="get" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6 lg:items-end">
          <div className="space-y-1">
            <Label htmlFor="f-rep">{t("filters.rep")}</Label>
            <Select id="f-rep" name="rep" defaultValue={filters.rep ?? ""}>
              <option value="">{t("filters.all")}</option>
              {(reps.ok ? reps.data : []).map((e) => (
                <option key={e.id} value={e.id}>
                  {localizedName(locale, e.full_name_en, e.full_name_ar)}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="f-territory">{t("filters.territory")}</Label>
            <Select id="f-territory" name="territory" defaultValue={filters.territory ?? ""}>
              <option value="">{t("filters.all")}</option>
              {(territories.ok ? territories.data : []).map((tr) => (
                <option key={tr.id} value={tr.id}>
                  {localizedName(locale, tr.name_en, tr.name_ar)}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="f-stage">{t("filters.stage")}</Label>
            <Select id="f-stage" name="stage" defaultValue={filters.stage ?? ""}>
              <option value="">{t("filters.all")}</option>
              {LIFECYCLE_STAGES.map((s) => (
                <option key={s} value={s}>
                  {tStage(s)}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="f-visit">{t("filters.lastVisit")}</Label>
            <Select id="f-visit" name="lastVisit" defaultValue={filters.lastVisit ?? ""}>
              <option value="">{t("filters.anyVisit")}</option>
              {LAST_VISIT_FILTERS.map((v) => (
                <option key={v} value={v}>
                  {t(`filters.visit.${v}`)}
                </option>
              ))}
            </Select>
          </div>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input type="checkbox" name="overdue" value="1" defaultChecked={filters.overdue === "1"} className="size-5" />
            {t("filters.overdue")}
          </label>
          <div className="flex gap-2">
            <Button type="submit" className="flex-1">
              {t("filters.apply")}
            </Button>
            {filtered ? (
              <Link href="/map" className={buttonVariants({ variant: "outline" })}>
                {t("filters.clear")}
              </Link>
            ) : null}
          </div>
        </form>
      </Card>

      {!data.ok ? (
        <Alert>{tErrors(data.error.messageKey, { requestId: data.error.requestId ?? "—" })}</Alert>
      ) : (
        <CustomersSection
          locale={lang}
          apiKey={apiKey}
          setupHint={seesSetupDetails(ctx)}
          rows={data.data.pinned}
          unpinned={data.data.unpinned}
          truncated={data.data.truncated}
          filtered={filtered}
        />
      )}
    </PageBody>
  );
}

async function CustomersSection({
  locale,
  apiKey,
  setupHint,
  rows,
  unpinned,
  truncated,
  filtered,
}: {
  locale: "ar" | "en";
  apiKey: string | null;
  setupHint: boolean;
  rows: Parameters<typeof pinnedCustomers>[0];
  unpinned: number;
  truncated: boolean;
  filtered: boolean;
}) {
  const t = await getTranslations("maps.customers");
  const tStage = await getTranslations("crm.stage");
  const pins = pinnedCustomers(rows);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground" role="status">
        {t("summary", { pinned: String(pins.length), unpinned: String(unpinned) })}
      </p>
      {truncated ? <Alert tone="info">{t("truncated", { limit: String(CUSTOMER_MAP_LIMIT) })}</Alert> : null}
      {pins.length === 0 && unpinned === 0 ? (
        <Empty>{filtered ? t("emptyFiltered") : t("empty")}</Empty>
      ) : (
        <>
          <CustomersMap apiKey={apiKey} setupHint={setupHint} locale={locale} rows={pins} />
          <Legend />
        </>
      )}
      {unpinned > 0 ? (
        <Alert tone="info">
          {t("unpinnedHint", { count: String(unpinned) })}{" "}
          <Link href="/customers" className="font-medium underline-offset-4 hover:underline">
            {t("toCustomers")}
          </Link>
        </Alert>
      ) : null}
      {pins.length > 0 ? (
        <details className="rounded-lg border bg-card">
          <summary className="flex min-h-11 cursor-pointer items-center px-4 text-sm font-medium">{t("listTitle", { count: String(pins.length) })}</summary>
          <ul className="divide-y">
            {pins.slice(0, 500).map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
                <Link href={`/customers/${r.id}`} className="inline-flex min-h-11 items-center font-medium text-primary underline-offset-4 hover:underline">
                  {r.display_name}
                </Link>
                <span className="flex flex-wrap gap-1">
                  <Badge>{tStage(r.lifecycle_stage)}</Badge>
                  {r.is_overdue ? <Badge tone="danger">{t("overdueBadge")}</Badge> : null}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

async function Legend() {
  const t = await getTranslations("maps.customers.legend");
  const items: [string, string][] = [
    ["bg-[#dc2626]", t("overdue")],
    ["bg-[#16a34a]", t("active")],
    ["bg-[#2563eb]", t("prospect")],
    ["bg-[#d97706]", t("lead")],
    ["bg-[#6b7280]", t("inactive")],
  ];
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label={t("label")}>
      {items.map(([color, text]) => (
        <li key={text} className="flex items-center gap-1">
          <span aria-hidden className={`inline-block size-3 rounded-full ${color}`} />
          {text}
        </li>
      ))}
    </ul>
  );
}
