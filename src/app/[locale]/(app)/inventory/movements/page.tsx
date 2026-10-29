import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { buttonVariants } from "@/components/ui/button";
import { Alert, Badge, Table, Td, Th } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { cn } from "@/lib/utils";
import { FilterBar } from "@/modules/inventory/components/filter-bar";
import { InventoryError } from "@/modules/inventory/components/inventory-error";
import { CAIRO_DATE_TIME, SIGNED_QTY } from "@/modules/inventory/format";
import { movementTone, parseMovementFilters, parseReason, shortId, toAmount, toQuery, type SearchParams } from "@/modules/inventory/logic";
import { listMovements, listVariants, listWarehouses, MOVEMENT_PAGE } from "@/modules/inventory/queries";
import { MOVEMENT_TYPES } from "@/modules/inventory/types";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "inventory.movements" });
  return { title: t("title") };
}

/** The stock ledger, read-only. It is append-only: corrections are new (reversal) movements, never edits. */
export default async function MovementsPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<SearchParams> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!can(ctx, "inventory.movement.read")) return <Forbidden />;

  const filters = parseMovementFilters(await searchParams);
  const t = await getTranslations("inventory.movements");
  const tc = await getTranslations("inventory.common");
  const tTypes = await getTranslations("inventory.movementTypes");
  const tReasons = await getTranslations("inventory.reasons");
  const tSources = await getTranslations("inventory.sources");
  const format = await getFormatter();

  const [movements, warehouses, variants] = await Promise.all([listMovements(filters), listWarehouses(), listVariants()]);
  if (!movements.ok) return <InventoryError code={movements.error.code} messageKey={movements.error.messageKey} requestId={movements.error.requestId} />;
  const rows = movements.data;
  const showCost = rows.some((r) => r.unit_cost !== null);
  const last = rows.at(-1);
  const baseQuery = {
    warehouse: filters.warehouse,
    variant: filters.variant,
    type: filters.type,
    source_type: filters.sourceType,
    source_id: filters.sourceId,
    from: filters.from,
    to: filters.to,
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("intro")}</p>
      </div>
      <Alert tone="info" role="note">
        {t("appendOnly")}
      </Alert>

      <FilterBar
        hidden={{ source_type: filters.sourceType, source_id: filters.sourceId }}
        fields={[
          {
            kind: "select",
            name: "warehouse",
            label: tc("warehouse"),
            value: filters.warehouse,
            allLabel: tc("allWarehouses"),
            options: (warehouses.ok ? warehouses.data : []).map((w) => ({ value: w.id, label: `${w.code} · ${w.name}` })),
          },
          {
            kind: "select",
            name: "variant",
            label: tc("sku"),
            value: filters.variant,
            allLabel: tc("allSkus"),
            options: (variants.ok ? variants.data : []).map((v) => ({ value: v.variant_id, label: `${v.sku} · ${v.variant_name}` })),
          },
          {
            kind: "select",
            name: "type",
            label: t("type"),
            value: filters.type,
            allLabel: t("allTypes"),
            options: MOVEMENT_TYPES.map((m) => ({ value: m, label: tTypes(m) })),
          },
          { kind: "date", name: "from", label: t("from"), value: filters.from },
          { kind: "date", name: "to", label: t("to"), value: filters.to },
        ]}
        applyLabel={tc("apply")}
        resetLabel={tc("reset")}
        resetHref="/inventory/movements"
      />

      {filters.sourceType && filters.sourceId ? (
        <p className="text-sm">
          {t("sourceFilter", { source: tSources(filters.sourceType), ref: shortId(filters.sourceId) })}{" "}
          <Link href={`/inventory/movements${toQuery({ ...baseQuery, source_type: undefined, source_id: undefined })}`} className="text-primary underline-offset-4 hover:underline">
            {t("clearSource")}
          </Link>
        </p>
      ) : null}

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{filters.before ? t("noMore") : t("empty")}</p>
      ) : (
        <Table>
          <caption className="sr-only">{t("title")}</caption>
          <thead>
            <tr>
              <Th>{t("when")}</Th>
              <Th>{t("type")}</Th>
              <Th>{tc("warehouse")}</Th>
              <Th>{tc("sku")}</Th>
              <Th>{tc("lot")}</Th>
              <Th className="text-end">{t("quantity")}</Th>
              <Th>{t("reason")}</Th>
              <Th>{t("source")}</Th>
              {showCost ? <Th className="text-end">{t("unitCost")}</Th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => {
              const reason = parseReason(m.reason_code);
              const cost = toAmount(m.unit_cost);
              return (
                <tr key={m.id}>
                  <Td className="whitespace-nowrap">{format.dateTime(new Date(m.created_at), CAIRO_DATE_TIME)}</Td>
                  <Td>
                    <Badge tone={movementTone(m.movement_type)}>{tTypes(m.movement_type)}</Badge>
                  </Td>
                  <Td>{m.warehouse_code ?? "—"}</Td>
                  <Td>
                    <span dir="ltr" className="whitespace-nowrap">
                      {m.sku ?? "—"}
                    </span>
                  </Td>
                  <Td>
                    <span dir="ltr">{m.lot_no ?? "—"}</span>
                  </Td>
                  <Td className={cn("text-end font-medium tabular-nums", m.quantity < 0 ? "text-destructive" : "text-success")}>
                    <span dir="ltr">{format.number(m.quantity, SIGNED_QTY)}</span>
                  </Td>
                  <Td className="min-w-32">
                    {reason.code ? tReasons(reason.code) : null}
                    {reason.note ? <span className="block text-xs text-muted-foreground">{reason.note}</span> : null}
                    {!reason.code && !reason.note ? "—" : null}
                  </Td>
                  <Td className="min-w-32 text-xs">
                    {m.source_doc_type ? <span className="block">{tSources.has(m.source_doc_type) ? tSources(m.source_doc_type) : m.source_doc_type}</span> : null}
                    {m.source_doc_type === "receipt" && m.source_doc_id ? (
                      <Link href={`/inventory/receipts/${m.source_doc_id}`} className="text-primary underline-offset-4 hover:underline">
                        {t("openReceipt")}
                      </Link>
                    ) : null}
                    {m.reverses_movement_id ? <span className="block">{t("reverses", { ref: shortId(m.reverses_movement_id) })}</span> : null}
                    {m.approval_request_id ? <span className="block">{t("approved", { ref: shortId(m.approval_request_id) })}</span> : null}
                  </Td>
                  {showCost ? <Td className="text-end tabular-nums">{cost === null ? "—" : format.number(cost, "egp")}</Td> : null}
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}

      <div className="flex flex-wrap gap-2">
        {filters.before ? (
          <Link href={`/inventory/movements${toQuery(baseQuery)}`} className={buttonVariants({ variant: "ghost" })}>
            {t("newest")}
          </Link>
        ) : null}
        {rows.length === MOVEMENT_PAGE && last ? (
          <Link href={`/inventory/movements${toQuery({ ...baseQuery, before: last.created_at, before_id: last.id })}`} className={buttonVariants({ variant: "outline" })}>
            {t("older")}
          </Link>
        ) : null}
      </div>
    </div>
  );
}
