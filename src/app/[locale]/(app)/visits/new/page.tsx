import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { SearchIcon, UsersIcon } from "lucide-react";
import { z } from "zod";
import { Forbidden } from "@/components/forbidden";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { AddPhoneForm } from "@/modules/crm/components/add-phone-form";
import { GapBadges } from "@/modules/crm/components/gap-badges";
import { CheckInButton } from "@/modules/field/components/check-in-button";
import { FieldError } from "@/modules/field/components/field-error";
import { Item, ItemList, PageBody } from "@/modules/field/components/layout-bits";
import { getCustomer, searchCustomers } from "@/modules/field/queries";
import type { CustomerPick } from "@/modules/field/types";
import type { Result } from "@/lib/errors";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "field.newVisit" });
  return { title: t("title") };
}

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * Unplanned check-in: pick a customer in your scope, then check in. The visit
 * id is generated on the device at the first tap. `?customer=<id>` opens one
 * customer directly (for links from the customer page). A customer marked
 * "phone missing" offers a quick "add phone" so the rep completes it at the clinic.
 */
export default async function NewVisitPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: SearchParams }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  const userId = ctx.user_id;
  if (!can(ctx, "field.visit.create") || !userId) return <Forbidden />;

  const t = await getTranslations("field.newVisit");
  const sp = await searchParams;
  const q = (first(sp.q) ?? "").slice(0, 60);
  const customerParam = first(sp.customer);
  const customerId = customerParam && z.guid().safeParse(customerParam).success ? customerParam : null;

  let result: Result<CustomerPick[]>;
  if (customerId) {
    const one = await getCustomer(customerId);
    result = one.ok ? { ok: true, data: one.data ? [one.data] : [] } : one;
  } else {
    result = await searchCustomers(q);
  }
  const mayRequestException = can(ctx, "field.visit_exception.request");
  const mayAddPhone = can(ctx, "crm.customer.update");

  return (
    <PageBody className="mx-auto max-w-2xl">
      <PageHeader title={t("title")} description={t("intro")} />

      <form method="get" role="search" className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex-1 space-y-1">
          <Label htmlFor="visit-customer-q">{t("searchLabel")}</Label>
          <Input id="visit-customer-q" name="q" type="search" defaultValue={q} maxLength={60} placeholder={t("searchPlaceholder")} autoComplete="off" />
        </div>
        <Button type="submit" variant="outline">
          <SearchIcon aria-hidden="true" />
          {t("search")}
        </Button>
      </form>

      {!result.ok ? (
        <FieldError code={result.error.code} messageKey={result.error.messageKey} requestId={result.error.requestId} />
      ) : result.data.length === 0 ? (
        <EmptyState
          icon={q || customerId ? <SearchIcon aria-hidden="true" /> : <UsersIcon aria-hidden="true" />}
          title={q || customerId ? t("noMatch") : t("noCustomers")}
        />
      ) : (
        <ItemList>
          {result.data.map((c) => (
            <Item key={c.id}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium break-words">{c.display_name}</p>
                  <p className="text-sm text-muted-foreground">
                    <span dir="ltr">{c.customer_no ?? ""}</span>
                    {c.city ? ` · ${c.city}` : ""}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1">
                  {!c.location_verified ? <Badge tone="warning">{t("noClinicLocation")}</Badge> : null}
                  {!c.phone_primary ? <GapBadges gaps={["phone_missing"]} /> : null}
                </div>
              </div>
              <CheckInButton customerId={c.id} customerName={c.display_name} userId={userId} mayRequestException={mayRequestException} />
              {!c.phone_primary && mayAddPhone ? (
                <AddPhoneForm customerId={c.id} version={c.version} customerName={c.display_name} className="w-full sm:w-auto" />
              ) : null}
            </Item>
          ))}
        </ItemList>
      )}
    </PageBody>
  );
}
