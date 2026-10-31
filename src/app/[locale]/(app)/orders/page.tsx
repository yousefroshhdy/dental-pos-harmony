import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { buttonVariants } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { cn } from "@/lib/utils";
import { OrderError } from "@/modules/orders/components/order-error";
import { CAIRO_DATE_TIME } from "@/modules/orders/format";
import { orderErrorCode, parseStatusFilter, STATUS_FILTERS, statusTone, toNumber, type StatusFilter } from "@/modules/orders/logic";
import { listOrders, ORDER_LIST_LIMIT } from "@/modules/orders/queries";
import { ExportCsvButton } from "@/modules/reports/components/export-csv-button";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "orders.list" });
  return { title: t("title") };
}

const FILTERS = Object.keys(STATUS_FILTERS) as StatusFilter[];

export default async function OrdersPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ status?: string | string[] }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!can(ctx, "sales.order.read")) return <Forbidden />;

  const filter = parseStatusFilter((await searchParams).status);
  const t = await getTranslations("orders");
  const format = await getFormatter();
  const orders = await listOrders(STATUS_FILTERS[filter]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-semibold">{t("list.title")}</h1>
        <div className="flex flex-wrap gap-2">
          <ExportCsvButton ctx={ctx} kind="orders" filters={{ status: filter }} label={t("list.exportOrders")} />
          <ExportCsvButton ctx={ctx} kind="order_lines" filters={{ status: filter }} label={t("list.exportLines")} />
          {can(ctx, "sales.order.create") ? (
            <Link href="/orders/new" className={buttonVariants()}>
              {t("list.new")}
            </Link>
          ) : null}
        </div>
      </div>

      <nav aria-label={t("list.filterLabel")} className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Link
            key={f}
            href={f === "all" ? "/orders" : `/orders?status=${f}`}
            aria-current={f === filter ? "page" : undefined}
            className={cn(buttonVariants({ variant: f === filter ? "default" : "outline", size: "sm" }), "min-h-11")}
          >
            {t(`filters.${f}`)}
          </Link>
        ))}
      </nav>

      {!orders.ok ? (
        <OrderError code={orderErrorCode(orders.error)} requestId={orders.error.requestId} />
      ) : orders.data.length === 0 ? (
        <Card className="text-sm text-muted-foreground">{filter === "all" ? t("list.empty") : t("list.emptyFiltered")}</Card>
      ) : (
        <>
          <ul className="space-y-2">
            {orders.data.map((o) => (
              <li key={o.id}>
                <Link
                  href={`/orders/${o.id}`}
                  className="flex min-h-11 flex-col gap-1 rounded-lg border bg-card p-3 hover:bg-muted sm:flex-row sm:items-center sm:gap-4"
                >
                  <span className="flex flex-1 flex-col gap-0.5 min-w-0">
                    <span className="flex flex-wrap items-center gap-2">
                      <span dir="ltr" className="font-medium">
                        {o.order_no ?? t("draftNo")}
                      </span>
                      <Badge tone={statusTone(o.status)}>{t(`status.${o.status}`)}</Badge>
                    </span>
                    <span className="truncate text-sm">{o.customer_name ?? "—"}</span>
                    <span className="text-xs text-muted-foreground">
                      {[o.employee_name, format.dateTime(new Date(o.submitted_at ?? o.created_at), CAIRO_DATE_TIME)].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                  <span className="text-sm font-semibold whitespace-nowrap sm:text-end">
                    {format.number(toNumber(o.total), "egp")}
                    {o.status === "draft" ? <span className="block text-xs font-normal text-muted-foreground">{t("indicative")}</span> : null}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {orders.data.length >= ORDER_LIST_LIMIT ? (
            <p className="text-sm text-muted-foreground">{t("list.limited", { count: ORDER_LIST_LIMIT })}</p>
          ) : null}
        </>
      )}
    </div>
  );
}
