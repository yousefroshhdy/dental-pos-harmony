import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { buttonVariants } from "@/components/ui/button";
import { Alert } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { PipelineBoard, type PipelineColumn } from "@/modules/crm/components/pipeline-board";
import { CAIRO_DATE, EGP } from "@/modules/crm/format";
import { groupByStage, localizedName, nextOpportunityStages, toNumber } from "@/modules/crm/logic";
import { listOpportunities } from "@/modules/crm/queries";

type Props = { params: Promise<{ locale: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const CLOSED_DAYS = 30;

export async function generateMetadata({ params }: Pick<Props, "params">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "crm.pipeline" });
  return { title: t("title") };
}

export default async function OpportunitiesPage({ params, searchParams }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!can(ctx, "crm.opportunity.read")) return <Forbidden />;

  const t = await getTranslations("crm.pipeline");
  const tErrors = await getTranslations("errors");
  const format = await getFormatter();
  const sp = await searchParams;
  const canManage = can(ctx, "crm.opportunity.manage");

  const opportunities = await listOpportunities({ closedDays: CLOSED_DAYS });

  // Formatting happens here (server: Cairo time zone, EGP) so the board only renders strings.
  const columns: PipelineColumn[] = opportunities.ok
    ? groupByStage(opportunities.data).map((col) => ({
        stage: col.stage,
        count: col.count,
        total: format.number(col.expectedTotal, EGP),
        cards: col.items.map((o) => {
          const value = toNumber(o.expected_value);
          return {
            id: o.id,
            title: o.title,
            stage: o.stage,
            customerId: o.customer_id,
            customerName: o.customer_name ?? o.customer_no ?? "—",
            customerNo: o.customer_no,
            value: value !== null ? format.number(value, EGP) : null,
            // A plain date: format at noon UTC so no time zone shifts the day.
            closeDate: o.expected_close_date ? format.dateTime(new Date(`${o.expected_close_date}T12:00:00Z`), CAIRO_DATE) : null,
            owner: localizedName(locale, o.owner_name_en, o.owner_name_ar) || "—",
            brand: o.brand_name,
            lostReason: o.lost_reason,
            nextStages: nextOpportunityStages(o.stage),
          };
        }),
      }))
    : [];

  return (
    <div className="space-y-4 pb-20 md:pb-0">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("intro", { days: CLOSED_DAYS })}</p>
        </div>
        {canManage ? (
          <div className="fixed inset-x-0 bottom-0 z-10 border-t bg-card/95 p-3 backdrop-blur sm:static sm:border-0 sm:bg-transparent sm:p-0">
            <Link href="/opportunities/new" className={buttonVariants({ className: "w-full sm:w-auto" })}>
              {t("new")}
            </Link>
          </div>
        ) : null}
      </div>

      {sp.created ? (
        <Alert tone="success" role="status">
          {t("created")}
        </Alert>
      ) : null}

      {!opportunities.ok ? (
        <Alert>{tErrors(opportunities.error.messageKey, { requestId: opportunities.error.requestId ?? "—" })}</Alert>
      ) : opportunities.data.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <PipelineBoard columns={columns} canManage={canManage} />
      )}
    </div>
  );
}
