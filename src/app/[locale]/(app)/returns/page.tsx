import type { Metadata } from "next";
import { PlusIcon } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { buttonVariants } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { pageRequest } from "@/modules/orders/kit/paging";
import { ReturnsError } from "@/modules/returns/components/returns-error";
import { ReturnsTable } from "@/modules/returns/components/returns-table";
import { RETURN_LIST } from "@/modules/returns/lists";
import { canSeeReturns, parseStatusFilter, RETURN_PERMISSIONS, returnErrorCode } from "@/modules/returns/logic";
import { listReturnsPage } from "@/modules/returns/queries";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "returns.list" });
  return { title: t("title") };
}

type SearchParams = Record<string, string | string[] | undefined>;

export default async function ReturnsPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<SearchParams> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!canSeeReturns(ctx)) return <Forbidden />;

  const sp = await searchParams;
  const filter = parseStatusFilter(sp.status);
  const t = await getTranslations("returns");
  const returns = await listReturnsPage(filter, pageRequest(sp, RETURN_LIST));
  const newReturn = can(ctx, RETURN_PERMISSIONS.request) ? (
    <Link href="/returns/new" className={buttonVariants()}>
      <PlusIcon aria-hidden="true" />
      {t("list.new")}
    </Link>
  ) : null;

  return (
    <div className="space-y-4">
      <PageHeader title={t("list.title")} description={t("list.intro")} actions={newReturn} />
      <ReturnsTable
        rows={returns.ok ? returns.data.rows : []}
        total={returns.ok ? returns.data.total : 0}
        filter={filter}
        emptyAction={newReturn}
        error={returns.ok ? undefined : <ReturnsError code={returnErrorCode(returns.error)} requestId={returns.error.requestId} />}
      />
    </div>
  );
}
