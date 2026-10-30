import { setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { Forbidden } from "@/components/forbidden";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";

/** /finance → the first finance screen the user may open. */
export default async function FinanceHome({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (can(ctx, "finance.invoice.read")) redirect(`/${locale}/finance/invoices`);
  if (can(ctx, "finance.payment.read")) redirect(`/${locale}/finance/payments`);
  if (can(ctx, "finance.payment.record")) redirect(`/${locale}/finance/payments/new`);
  return <Forbidden />;
}
