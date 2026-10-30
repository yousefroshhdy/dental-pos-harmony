import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { buttonVariants } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { cn } from "@/lib/utils";
import { ReturnsError } from "@/modules/returns/components/returns-error";
import { CAIRO_DATE_TIME, QUANTITY } from "@/modules/returns/format";
import {
  canSeeReturns,
  localizedName,
  parseStatusFilter,
  RETURN_PERMISSIONS,
  returnErrorCode,
  STATUS_FILTERS,
  statusTone,
  toNumber,
  type StatusFilter,
} from "@/modules/returns/logic";
import { LIST_LIMIT, listReturns } from "@/modules/returns/queries";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "returns.list" });
  return { title: t("title") };
}

const FILTERS = Object.keys(STATUS_FILTERS) as StatusFilter[];

export default async function ReturnsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ status?: string | string[] }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!canSeeReturns(ctx)) return <Forbidden />;

  const filter = parseStatusFilter((await searchParams).status);
  const t = await getTranslations("returns");
  const format = await getFormatter();
  const returns = await listReturns(filter);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-semibold">{t("list.title")}</h1>
        {can(ctx, RETURN_PERMISSIONS.request) ? (
          <Link href="/returns/new" className={buttonVariants()}>
            {t("list.new")}
          </Link>
        ) : null}
      </div>

      <nav aria-label={t("list.filterLabel")} className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Link
            key={f}
            href={f === "all" ? "/returns" : `/returns?status=${f}`}
            aria-current={f === filter ? "page" : undefined}
            className={cn(buttonVariants({ variant: f === filter ? "default" : "outline", size: "sm" }), "min-h-11")}
          >
            {t(`filters.${f}`)}
          </Link>
        ))}
      </nav>

      {!returns.ok ? (
        <ReturnsError code={returnErrorCode(returns.error)} requestId={returns.error.requestId} />
      ) : returns.data.length === 0 ? (
        <Card className="text-sm text-muted-foreground">{filter === "all" ? t("list.empty") : t("list.emptyFiltered")}</Card>
      ) : (
        <>
          <ul className="space-y-2">
            {returns.data.map((r) => (
              <li key={r.id}>
                <Link
                  href={`/returns/${r.id}`}
                  className="flex min-h-11 flex-col gap-1 rounded-lg border bg-card p-3 hover:bg-muted sm:flex-row sm:items-center sm:gap-4"
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-2">
                      <span dir="ltr" className="font-medium">
                        {r.return_no}
                      </span>
                      <Badge tone={statusTone(r.status)}>{t(`status.${r.status}`)}</Badge>
                    </span>
                    <span className="truncate text-sm">{r.customer_name ?? "—"}</span>
                    <span className="text-xs text-muted-foreground">
                      {[
                        r.order_no,
                        localizedName(locale, r.rep_name_en, r.rep_name_ar) || null,
                        format.dateTime(new Date(r.created_at), CAIRO_DATE_TIME),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  <span className="text-sm whitespace-nowrap sm:text-end">
                    <span className="block font-semibold">
                      {r.status === "credited" ? format.number(toNumber(r.credited_total), "egp") : format.number(toNumber(r.estimated_total), "egp")}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {t("list.units", { count: r.total_qty, formatted: format.number(r.total_qty, QUANTITY) })}
                      {r.status === "credited" ? null : ` · ${t("list.estimate")}`}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {returns.data.length >= LIST_LIMIT ? <p className="text-sm text-muted-foreground">{t("list.limited", { count: LIST_LIMIT })}</p> : null}
        </>
      )}
    </div>
  );
}
