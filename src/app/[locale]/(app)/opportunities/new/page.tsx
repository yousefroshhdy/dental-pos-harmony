import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { z } from "zod";
import { Forbidden } from "@/components/forbidden";
import { buttonVariants } from "@/components/ui/button";
import { Alert, Badge, Card, Input, Label } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { OpportunityForm } from "@/modules/crm/components/opportunity-form";
import { cairoNowLocal, formatEgyptPhone, lifecycleTone } from "@/modules/crm/logic";
import { getCustomer, searchCustomers } from "@/modules/crm/queries";
import { firstValues } from "@/modules/crm/schemas";

type Props = { params: Promise<{ locale: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ params }: Pick<Props, "params">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "crm.opportunityForm" });
  return { title: t("pageTitle") };
}

/**
 * Step 1: pick the customer (GET search, works without JavaScript).
 * Step 2: describe the opportunity. Arriving from a customer page skips step 1.
 */
export default async function NewOpportunityPage({ params, searchParams }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!can(ctx, "crm.opportunity.manage")) return <Forbidden />;

  const t = await getTranslations("crm.opportunityForm");
  const tStage = await getTranslations("crm.stage");
  const tErrors = await getTranslations("errors");
  const sp = firstValues(await searchParams);
  const customerId = z.guid().safeParse(sp.customer).success ? sp.customer : null;

  if (customerId) {
    const customer = await getCustomer(customerId);
    if (!customer.ok) return <Alert>{tErrors(customer.error.messageKey, { requestId: customer.error.requestId ?? "—" })}</Alert>;
    if (!customer.data) return <Alert>{tErrors("NOT_FOUND")}</Alert>;
    const c = customer.data;
    const closed = c.archived_at !== null || c.lifecycle_stage === "blocked";
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <Link href="/opportunities/new" className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline">
          {t("changeCustomer")}
        </Link>
        <h1 className="text-2xl font-semibold">{t("pageTitle")}</h1>
        <Card className="flex flex-wrap items-center gap-2 p-3">
          <span className="font-medium">{c.display_name}</span>
          <span dir="ltr" className="text-xs text-muted-foreground">
            {c.customer_no}
          </span>
          <Badge tone={lifecycleTone(c.lifecycle_stage)}>{tStage(c.lifecycle_stage)}</Badge>
        </Card>
        {closed ? (
          <Alert>{t("customerClosed")}</Alert>
        ) : (
          <OpportunityForm customerId={c.id} locale={locale === "en" ? "en" : "ar"} minDate={cairoNowLocal().slice(0, 10)} />
        )}
      </div>
    );
  }

  const q = (sp.q ?? "").slice(0, 80);
  const results = q ? await searchCustomers(q) : null;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Link href="/opportunities" className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline">
        {t("backToPipeline")}
      </Link>
      <h1 className="text-2xl font-semibold">{t("pageTitle")}</h1>
      <form method="get" role="search" className="space-y-2">
        <Label htmlFor="opp-q">{t("findCustomer")}</Label>
        <div className="flex gap-2">
          <Input id="opp-q" name="q" type="search" defaultValue={q} maxLength={80} placeholder={t("findPlaceholder")} />
          <button type="submit" className={buttonVariants()}>
            {t("find")}
          </button>
        </div>
      </form>

      {results === null ? (
        <p className="text-sm text-muted-foreground">{t("findHint")}</p>
      ) : !results.ok ? (
        <Alert>{tErrors(results.error.messageKey, { requestId: results.error.requestId ?? "—" })}</Alert>
      ) : results.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("noMatches")}</p>
      ) : (
        <ul className="space-y-2">
          {results.data.map((r) => (
            <li key={r.id}>
              <Link
                href={`/opportunities/new?customer=${r.id}`}
                className="flex min-h-11 flex-wrap items-center gap-2 rounded-lg border bg-card p-3 hover:bg-muted"
              >
                <span className="font-medium">{r.display_name}</span>
                <span dir="ltr" className="text-xs text-muted-foreground">
                  {r.customer_no}
                  {r.phone_primary ? ` · ${formatEgyptPhone(r.phone_primary)}` : ""}
                </span>
                <Badge tone={lifecycleTone(r.lifecycle_stage)} className="ms-auto">
                  {tStage(r.lifecycle_stage)}
                </Badge>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
