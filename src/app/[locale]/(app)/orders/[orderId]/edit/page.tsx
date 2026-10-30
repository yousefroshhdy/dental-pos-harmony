import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { z } from "zod";
import { Forbidden } from "@/components/forbidden";
import { Card } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { OrderBuilder } from "@/modules/orders/components/order-builder";
import { OrderError } from "@/modules/orders/components/order-error";
import { linesToBuilder, orderErrorCode } from "@/modules/orders/logic";
import { getOrder, listOrderLines, listSellableCustomers } from "@/modules/orders/queries";

type Params = Promise<{ locale: string; orderId: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "orders.builder" });
  return { title: t("editTitle") };
}

/** Edit a draft: the same builder, saved with the draft's version (CONFLICT if someone else changed it). */
export default async function EditOrderPage({ params }: { params: Params }) {
  const { locale, orderId } = await params;
  setRequestLocale(locale);
  if (!z.guid().safeParse(orderId).success) notFound();

  const ctx = await getUserContext();
  if (!can(ctx, "sales.order.create")) return <Forbidden />;

  const t = await getTranslations("orders.builder");
  const [order, lines, customers] = await Promise.all([getOrder(orderId), listOrderLines(orderId), listSellableCustomers()]);
  if (!order.ok) return <OrderError code={orderErrorCode(order.error)} requestId={order.error.requestId} />;
  if (!order.data) notFound();
  if (!lines.ok) return <OrderError code={orderErrorCode(lines.error)} requestId={lines.error.requestId} />;
  if (!customers.ok) return <OrderError code={orderErrorCode(customers.error)} requestId={customers.error.requestId} />;

  const o = order.data;
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Link href={`/orders/${o.id}`} className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline">
          {t("backToOrder")}
        </Link>
        <h1 className="text-2xl font-semibold">{t("editTitle")}</h1>
      </div>
      {!ctx.user_id ? null : o.status !== "draft" ? (
        <Card className="text-sm text-muted-foreground">{t("notDraft")}</Card>
      ) : (
        <OrderBuilder
          locale={locale}
          userId={ctx.user_id}
          customers={customers.data}
          initial={{
            orderId: o.id,
            version: o.version,
            customerId: o.customer_id,
            visitId: o.visit_id ?? undefined,
            notes: o.notes ?? undefined,
            lines: linesToBuilder(lines.data),
          }}
        />
      )}
    </div>
  );
}
