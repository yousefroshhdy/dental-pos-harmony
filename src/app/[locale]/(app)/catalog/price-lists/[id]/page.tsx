import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { z } from "zod";
import { Forbidden } from "@/components/forbidden";
import { Badge, Card, CardTitle, Table, Td, Th } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { getUserContext } from "@/lib/authz/context";
import { endCustomerPriceList, removePriceItem } from "@/modules/catalog/actions";
import { CatalogErrorMessage } from "@/modules/catalog/components/action-form";
import { AssignCustomerForm } from "@/modules/catalog/components/assign-customer-form";
import { AddPriceItemForm, EditPriceItemForm } from "@/modules/catalog/components/price-item-forms";
import { PriceListForm } from "@/modules/catalog/components/price-list-form";
import { RowAction } from "@/modules/catalog/components/row-action";
import {
  assignmentStateTone,
  canManagePrices,
  canReadPrices,
  dateOnly,
  localizedName,
  priceListKindTone,
  todayInCairo,
  variantStatusTone,
} from "@/modules/catalog/logic";
import { getPriceList, listCustomerAssignments, listPriceListItems, listSellableSkus } from "@/modules/catalog/queries";

type Params = Promise<{ locale: string; id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "catalog.priceList" });
  return { title: t("editTitle") };
}

export default async function PriceListPage({ params }: { params: Params }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  if (!z.guid().safeParse(id).success) notFound();

  const ctx = await getUserContext();
  if (!canReadPrices(ctx)) return <Forbidden />;

  const t = await getTranslations("catalog.priceList");
  const tItems = await getTranslations("catalog.items");
  const tCustomers = await getTranslations("catalog.customers");
  const tStatus = await getTranslations("catalog.product.status");
  const format = await getFormatter();
  const manage = canManagePrices(ctx);
  const today = todayInCairo();
  const day = (d: string) => format.dateTime(dateOnly(d), { dateStyle: "medium", timeZone: "UTC", numberingSystem: "latn" });

  const list = await getPriceList(id);
  if (!list.ok) return <CatalogErrorMessage messageKey={list.error.messageKey} requestId={list.error.requestId} />;
  if (!list.data) notFound();
  const l = list.data;

  const [items, skus, assignments] = await Promise.all([
    listPriceListItems({ priceListId: id }),
    manage ? listSellableSkus() : Promise.resolve(null),
    l.kind === "customer" ? listCustomerAssignments(id) : Promise.resolve(null),
  ]);

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Link href="/catalog/price-lists" className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline">
          {t("back")}
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold">{l.name}</h1>
          <code dir="ltr" className="text-sm text-muted-foreground">
            {l.code}
          </code>
          <Badge tone={priceListKindTone(l.kind)}>{t(`kinds.${l.kind}`)}</Badge>
          {l.is_default ? <Badge tone="info">{t("default")}</Badge> : null}
          {l.is_current ? <Badge tone="success">{t("current")}</Badge> : <Badge>{l.is_active ? t("notInForce") : t("inactive")}</Badge>}
        </div>
        <p className="text-sm text-muted-foreground">
          {l.valid_to ? t("fromTo", { from: day(l.valid_from), to: day(l.valid_to) }) : t("fromOpen", { from: day(l.valid_from) })} ·{" "}
          {t("priorityValue", { priority: l.priority })}
        </p>
      </div>

      {manage ? (
        <Card className="space-y-4">
          <CardTitle>{t("details")}</CardTitle>
          <PriceListForm list={l} today={today} />
        </Card>
      ) : null}

      <Card className="space-y-4">
        <div className="space-y-1">
          <CardTitle>{tItems("title")}</CardTitle>
          <p className="text-sm text-muted-foreground">{tItems("intro")}</p>
        </div>
        {!items.ok ? (
          <CatalogErrorMessage messageKey={items.error.messageKey} requestId={items.error.requestId} />
        ) : items.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">{tItems("empty")}</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>{tItems("sku")}</Th>
                <Th>{tItems("product")}</Th>
                <Th className="text-end">{tItems("minQty")}</Th>
                <Th className="text-end">{tItems("unitPrice")}</Th>
                {manage ? <Th>{tItems("actions")}</Th> : null}
              </tr>
            </thead>
            <tbody>
              {items.data.map((row) => (
                <tr key={`${row.variant_id}:${row.min_qty}`}>
                  <Td>
                    <code dir="ltr" className="font-medium">
                      {row.sku}
                    </code>
                    <span className="block text-xs text-muted-foreground">{row.variant_name_en}</span>
                    {row.variant_status !== "active" || row.product_status !== "active" ? (
                      <Badge tone={variantStatusTone("discontinued")}>{tStatus(row.product_status === "active" ? row.variant_status : row.product_status)}</Badge>
                    ) : null}
                  </Td>
                  <Td className="min-w-40">
                    <Link href={`/catalog/products/${row.product_id}`} className="inline-flex min-h-11 items-center text-primary underline-offset-4 hover:underline">
                      {localizedName(locale, row.product_name_en, row.product_name_ar)}
                    </Link>
                  </Td>
                  <Td className="text-end tabular-nums">{row.min_qty}</Td>
                  <Td className="text-end tabular-nums whitespace-nowrap">{format.number(Number(row.unit_price), "egp")}</Td>
                  {manage ? (
                    <Td>
                      <div className="flex flex-wrap items-start gap-2">
                        <EditPriceItemForm
                          priceListId={l.id}
                          variantId={row.variant_id}
                          minQty={row.min_qty}
                          unitPrice={Number(row.unit_price).toFixed(2)}
                          sku={row.sku}
                        />
                        <RowAction
                          action={removePriceItem}
                          fields={{ price_list_id: l.id, variant_id: row.variant_id, min_qty: String(row.min_qty) }}
                          label={tItems("remove")}
                          variant="ghost"
                          confirmText={tItems("confirmRemove", { sku: row.sku, qty: row.min_qty })}
                        />
                      </div>
                    </Td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {manage ? (
          <div className="space-y-3 border-t pt-4">
            <h3 className="font-medium">{tItems("addTitle")}</h3>
            <AddPriceItemForm priceListId={l.id} skus={skus && skus.ok ? skus.data : []} />
          </div>
        ) : null}
      </Card>

      {l.kind === "customer" ? (
        <Card className="space-y-4">
          <div className="space-y-1">
            <CardTitle>{tCustomers("title")}</CardTitle>
            <p className="text-sm text-muted-foreground">{tCustomers("intro")}</p>
          </div>
          {assignments && !assignments.ok ? (
            <CatalogErrorMessage messageKey={assignments.error.messageKey} requestId={assignments.error.requestId} />
          ) : !assignments || assignments.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">{tCustomers("empty")}</p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>{tCustomers("customer")}</Th>
                  <Th>{tCustomers("period")}</Th>
                  <Th>{tCustomers("state")}</Th>
                  {manage ? <Th>{tItems("actions")}</Th> : null}
                </tr>
              </thead>
              <tbody>
                {assignments.data.map((a) => (
                  <tr key={`${a.customer_id}:${a.valid_from}`}>
                    <Td className="min-w-40">
                      {a.customer_name}
                      {a.customer_no ? (
                        <code dir="ltr" className="block text-xs text-muted-foreground">
                          {a.customer_no}
                        </code>
                      ) : null}
                    </Td>
                    <Td className="whitespace-nowrap">
                      {a.state === "cancelled"
                        ? t("fromOpen", { from: day(a.valid_from) })
                        : a.valid_to
                          ? t("fromTo", { from: day(a.valid_from), to: day(a.valid_to) })
                          : t("fromOpen", { from: day(a.valid_from) })}
                    </Td>
                    <Td>
                      <Badge tone={assignmentStateTone(a.state)}>{tCustomers(`states.${a.state}`)}</Badge>
                    </Td>
                    {manage ? (
                      <Td>
                        {a.state === "current" || a.state === "scheduled" ? (
                          <RowAction
                            action={endCustomerPriceList}
                            fields={{ price_list_id: l.id, customer_id: a.customer_id, valid_from: a.valid_from }}
                            label={a.state === "scheduled" ? tCustomers("cancel") : tCustomers("end")}
                            size="sm"
                            confirmText={tCustomers("confirmEnd", { customer: a.customer_name })}
                          />
                        ) : null}
                      </Td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {manage ? (
            <div className="space-y-3 border-t pt-4">
              <h3 className="font-medium">{tCustomers("assignTitle")}</h3>
              <AssignCustomerForm priceListId={l.id} today={today} />
            </div>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}
