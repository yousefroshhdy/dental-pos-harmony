import type { Metadata } from "next";
import { PlusIcon } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { buttonVariants } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { OrderError } from "@/modules/orders/components/order-error";
import { OrdersTable } from "@/modules/orders/components/orders-table";
import { pageRequest } from "@/modules/orders/kit/paging";
import { ORDER_LIST } from "@/modules/orders/lists";
import { orderErrorCode, parseStatusFilter, STATUS_FILTERS } from "@/modules/orders/logic";
import { listOrdersPage } from "@/modules/orders/queries";
import { ExportCsvButton } from "@/modules/reports/components/export-csv-button";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "orders.list" });
  return { title: t("title") };
}

type SearchParams = Record<string, string | string[] | undefined>;

export default async function OrdersPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<SearchParams> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!can(ctx, "sales.order.read")) return <Forbidden />;

  const sp = await searchParams;
  const filter = parseStatusFilter(sp.status);
  const t = await getTranslations("orders");
  const orders = await listOrdersPage(STATUS_FILTERS[filter], pageRequest(sp, ORDER_LIST));
  const newOrder = can(ctx, "sales.order.create") ? (
    <Link href="/orders/new" className={buttonVariants()}>
      <PlusIcon aria-hidden="true" />
      {t("list.new")}
    </Link>
  ) : null;

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("list.title")}
        description={t("list.intro")}
        actions={
          <>
            <ExportCsvButton ctx={ctx} kind="orders" filters={{ status: filter }} label={t("list.exportOrders")} />
            <ExportCsvButton ctx={ctx} kind="order_lines" filters={{ status: filter }} label={t("list.exportLines")} />
            {newOrder}
          </>
        }
      />
      <OrdersTable
        rows={orders.ok ? orders.data.rows : []}
        total={orders.ok ? orders.data.total : 0}
        filter={filter}
        error={orders.ok ? undefined : <OrderError code={orderErrorCode(orders.error)} requestId={orders.error.requestId} />}
        emptyAction={newOrder}
      />
    </div>
  );
}
