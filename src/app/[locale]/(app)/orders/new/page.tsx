import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { z } from "zod";
import { Forbidden } from "@/components/forbidden";
import { PageHeader } from "@/components/ui/page-header";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { OrderBuilder } from "@/modules/orders/components/order-builder";
import { OrderError } from "@/modules/orders/components/order-error";
import { hasBottomNav } from "@/modules/orders/kit/bottom-nav";
import { orderErrorCode } from "@/modules/orders/logic";
import { listSellableCustomers } from "@/modules/orders/queries";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "orders.builder" });
  return { title: t("newTitle") };
}

const optionalId = (v: string | string[] | undefined) => {
  const s = Array.isArray(v) ? v[0] : v;
  return s !== undefined && z.guid().safeParse(s).success ? s : undefined;
};

/** New order. `?customer=<id>` preselects a customer; `?visit=<id>` links the draft to that visit (the DB checks both). */
export default async function NewOrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ customer?: string | string[]; visit?: string | string[] }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!can(ctx, "sales.order.create")) return <Forbidden />;

  const t = await getTranslations("orders.builder");
  const sp = await searchParams;
  const customers = await listSellableCustomers();

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow={
          <Link href="/orders" className="inline-flex min-h-11 items-center text-primary underline-offset-4 hover:underline">
            {t("back")}
          </Link>
        }
        title={t("newTitle")}
        description={t("intro")}
      />
      {!ctx.user_id ? null : !customers.ok ? (
        <OrderError code={orderErrorCode(customers.error)} requestId={customers.error.requestId} />
      ) : (
        <OrderBuilder
          locale={locale}
          userId={ctx.user_id}
          aboveBottomNav={hasBottomNav(ctx)}
          customers={customers.data}
          initial={{ customerId: optionalId(sp.customer), visitId: optionalId(sp.visit) }}
        />
      )}
    </div>
  );
}
