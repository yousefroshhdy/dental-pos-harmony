"use client";

import { useTranslations } from "next-intl";
import { useActionState, useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardTitle, Input, Label, Select } from "@/components/ui/primitives";
import { saveDraft, searchVariants } from "../actions";
import { addLine, localizedName, MAX_LINES, MAX_QUANTITY, sanitizeSearch, type OrderErrorCode } from "../logic";
import type { BuilderLine, CustomerOption, SellableVariant } from "../types";
import { OrderActionMessage, OrderError } from "./order-error";

export interface BuilderInitial {
  /** Set when editing an existing draft. */
  orderId?: string;
  version?: number;
  customerId?: string;
  visitId?: string;
  notes?: string;
  lines?: BuilderLine[];
}

const SEARCH_DELAY_MS = 300;

/**
 * Order builder. The browser holds only variant ids and quantities; it never
 * sees or sends a price. Saving creates/replaces the draft through
 * api.save_order_draft and opens the order, where the server's prices show.
 */
export function OrderBuilder({ customers, initial, locale }: { customers: CustomerOption[]; initial: BuilderInitial; locale: string }) {
  const t = useTranslations("orders.builder");
  const [state, dispatch, pending] = useActionState(saveDraft, null);
  const ids = { customer: useId(), filter: useId(), search: useId(), notes: useId(), results: useId() };

  // Only a customer the user may still sell to can be preselected.
  const [customerId, setCustomerId] = useState(() =>
    initial.customerId && customers.some((c) => c.id === initial.customerId) ? initial.customerId : "",
  );
  const [customerFilter, setCustomerFilter] = useState("");
  const [lines, setLines] = useState<BuilderLine[]>(initial.lines ?? []);
  const [notes, setNotes] = useState(initial.notes ?? "");

  // A new draft's id is generated on the device at the first save and reused on retries,
  // so a retried save is a replay of the same draft (api.save_order_draft), never a second order.
  const orderIdRef = useRef<string | null>(initial.orderId ?? null);

  const visibleCustomers = useMemo(() => {
    const f = customerFilter.trim().toLowerCase();
    const list = f
      ? customers.filter((c) => c.display_name.toLowerCase().includes(f) || (c.customer_no ?? "").toLowerCase().includes(f))
      : customers;
    // Keep the selected customer selectable while filtering.
    const selected = customers.find((c) => c.id === customerId);
    return selected && !list.includes(selected) ? [selected, ...list] : list;
  }, [customers, customerFilter, customerId]);

  const quantitiesValid = lines.every((l) => Number.isInteger(l.quantity) && l.quantity >= 1 && l.quantity <= MAX_QUANTITY);
  const canSave = customerId !== "" && lines.length > 0 && quantitiesValid && !pending;

  function submit(form: FormData) {
    orderIdRef.current ??= crypto.randomUUID();
    form.set("order_id", orderIdRef.current);
    form.set("customer_id", customerId);
    form.set("lines", JSON.stringify(lines.map((l) => ({ variant_id: l.variant_id, quantity: l.quantity }))));
    dispatch(form);
  }

  const setQuantity = (variantId: string, raw: string) => {
    const n = raw === "" ? 0 : Math.trunc(Number(raw));
    setLines((prev) => prev.map((l) => (l.variant_id === variantId ? { ...l, quantity: Number.isFinite(n) ? n : 0 } : l)));
  };

  return (
    <form action={submit} className="space-y-6 pb-24 sm:pb-0">
      <input type="hidden" name="locale" value={locale} />
      {initial.version !== undefined ? <input type="hidden" name="version" value={initial.version} /> : null}
      {initial.visitId ? <input type="hidden" name="visit_id" value={initial.visitId} /> : null}

      <Card className="space-y-3">
        <CardTitle>{t("customerTitle")}</CardTitle>
        {customers.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noCustomers")}</p>
        ) : (
          <>
            <div className="space-y-2">
              <Label htmlFor={ids.filter}>{t("customerFilter")}</Label>
              <Input
                id={ids.filter}
                type="search"
                value={customerFilter}
                onChange={(e) => setCustomerFilter(e.target.value)}
                placeholder={t("customerFilterPlaceholder")}
                autoComplete="off"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={ids.customer}>{t("customer")}</Label>
              <Select
                id={ids.customer}
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
                required
                className="w-full"
              >
                <option value="" disabled>
                  {t("selectCustomer")}
                </option>
                {visibleCustomers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.customer_no ? `${c.display_name} (${c.customer_no})` : c.display_name}
                  </option>
                ))}
              </Select>
            </div>
          </>
        )}
      </Card>

      <ProductSearch
        locale={locale}
        searchId={ids.search}
        resultsId={ids.results}
        full={lines.length >= MAX_LINES}
        onAdd={(v) => setLines((prev) => addLine(prev, { variant_id: v.variant_id, quantity: 1, sku: v.sku, name: v.variant_name }))}
      />

      <Card className="space-y-3">
        <CardTitle>{t("linesTitle", { count: lines.length })}</CardTitle>
        {lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noLines")}</p>
        ) : (
          <ul className="divide-y">
            {lines.map((line) => {
              const qtyId = `qty-${line.variant_id}`;
              const invalid = !(Number.isInteger(line.quantity) && line.quantity >= 1 && line.quantity <= MAX_QUANTITY);
              return (
                <li key={line.variant_id} className="flex flex-wrap items-end gap-3 py-3">
                  <div className="min-w-0 flex-1 basis-48">
                    <p className="font-medium break-words">{line.name}</p>
                    <p dir="ltr" className="text-xs text-muted-foreground text-start">
                      {line.sku}
                    </p>
                  </div>
                  <div className="w-28 space-y-1">
                    <Label htmlFor={qtyId}>{t("quantity")}</Label>
                    <Input
                      id={qtyId}
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={MAX_QUANTITY}
                      step={1}
                      value={line.quantity === 0 ? "" : line.quantity}
                      onChange={(e) => setQuantity(line.variant_id, e.target.value)}
                      aria-invalid={invalid || undefined}
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setLines((prev) => prev.filter((l) => l.variant_id !== line.variant_id))}
                    aria-label={t("removeLine", { name: line.name })}
                  >
                    {t("remove")}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        {!quantitiesValid ? <p className="text-sm text-destructive">{t("quantityInvalid", { max: MAX_QUANTITY })}</p> : null}
        <p className="text-xs text-muted-foreground">{t("pricesHint")}</p>
      </Card>

      <Card className="space-y-2">
        <Label htmlFor={ids.notes}>{t("notes")}</Label>
        <Input id={ids.notes} name="notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} autoComplete="off" />
      </Card>

      <OrderActionMessage state={state} />

      {/* Primary action stays reachable at the bottom on phones. */}
      <div className="fixed inset-x-0 bottom-0 z-10 border-t bg-card/95 p-3 backdrop-blur sm:static sm:border-0 sm:bg-transparent sm:p-0">
        <div className="mx-auto flex max-w-6xl items-center gap-3">
          <p className="flex-1 text-sm text-muted-foreground">{t("summary", { count: lines.length })}</p>
          <Button type="submit" size="lg" disabled={!canSave}>
            {pending ? t("saving") : t("save")}
          </Button>
        </div>
      </div>
    </form>
  );
}

function ProductSearch({
  locale,
  searchId,
  resultsId,
  full,
  onAdd,
}: {
  locale: string;
  searchId: string;
  resultsId: string;
  full: boolean;
  onAdd: (v: SellableVariant) => void;
}) {
  const t = useTranslations("orders.builder");
  const [query, setQuery] = useState("");
  // The answer for one (sanitised) query; anything else on screen is derived from it.
  const [answer, setAnswer] = useState<{
    q: string;
    items: SellableVariant[] | null;
    error: { code: OrderErrorCode; requestId?: string } | null;
  } | null>(null);

  const q = sanitizeSearch(query);
  const active = q.length >= 2;
  const current = active && answer?.q === q ? answer : null;
  const loading = active && current === null;
  const results = current?.items ?? null;
  const error = current?.error ?? null;

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const res = await searchVariants(q).catch(() => ({ ok: false as const, errorCode: "UNAVAILABLE" as const, requestId: undefined }));
      if (cancelled) return;
      setAnswer(
        res.ok
          ? { q, items: res.items, error: null }
          : { q, items: null, error: { code: res.errorCode, requestId: res.requestId } },
      );
    }, SEARCH_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active, q]);

  return (
    <Card className="space-y-3">
      <CardTitle>{t("productsTitle")}</CardTitle>
      <div className="space-y-2">
        <Label htmlFor={searchId}>{t("search")}</Label>
        <Input
          id={searchId}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("searchPlaceholder")}
          autoComplete="off"
          aria-controls={resultsId}
        />
      </div>
      <div id={resultsId} aria-live="polite" aria-busy={loading}>
        {error ? <OrderError code={error.code} requestId={error.requestId} /> : null}
        {loading ? <p className="text-sm text-muted-foreground">{t("searching")}</p> : null}
        {!loading && results !== null && results.length === 0 ? <p className="text-sm text-muted-foreground">{t("noResults")}</p> : null}
        {results !== null && results.length > 0 ? (
          <ul className="divide-y">
            {results.map((v) => (
              <li key={v.variant_id} className="flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="font-medium break-words">{v.variant_name}</p>
                  <p className="text-xs text-muted-foreground break-words">
                    {[localizedName(locale, v.product_name_en, v.product_name_ar), v.brand_name].filter(Boolean).join(" · ")}
                    {" · "}
                    <span dir="ltr">{v.sku}</span>
                  </p>
                </div>
                <Button type="button" variant="outline" disabled={full} onClick={() => onAdd(v)} aria-label={t("addLine", { name: v.variant_name })}>
                  {t("add")}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        {full ? <p className="text-sm text-muted-foreground">{t("maxLines", { max: MAX_LINES })}</p> : null}
      </div>
    </Card>
  );
}
