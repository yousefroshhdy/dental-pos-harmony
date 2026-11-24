"use client";

import { useLocale, useTranslations } from "next-intl";
import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Badge, Card, CardTitle, Input, Label, Select } from "@/components/ui/primitives";
import { useRouter } from "@/i18n/navigation";
import { searchVariants } from "@/modules/orders/actions";
import { localizedName, parseAmount, sanitizeSearch } from "@/modules/orders/logic";
import type { SellableVariant } from "@/modules/orders/types";
import { saveOffer } from "../actions";
import { itemsPayload, parseCustomerNos, parseTags } from "../logic";
import type { OfferErrorCode, OfferItemDraft, PricingMode } from "../types";
import { OfferError } from "./offer-error";

export interface OfferFormInitial {
  offerId: string;
  version: number | null;
  code: string;
  nameEn: string;
  nameAr: string;
  description: string;
  mode: PricingMode;
  packagePrice: string;
  validFrom: string;
  validTo: string;
  items: OfferItemDraft[];
  customerNos: string;
  tags: string;
}

/**
 * Create or edit an offer: items and quantities (per package), bonus (free) items,
 * a package price OR a net unit price per paid line, a validity window and
 * optional targeting (customer numbers and/or customer tags as tiers). Everything
 * is checked again by api.upsert_offer.
 */
export function OfferForm({ initial }: { initial: OfferFormInitial }) {
  const t = useTranslations("orders.offerAdmin");
  const locale = useLocale();
  const router = useRouter();
  const ids = useId();
  const [v, setV] = useState(initial);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; code?: OfferErrorCode; requestId?: string; detail?: string } | null>(null);

  const set = <K extends keyof OfferFormInitial>(key: K, value: OfferFormInitial[K]) => {
    setV((s) => ({ ...s, [key]: value }));
    setResult(null);
  };
  const setItem = (index: number, patch: Partial<OfferItemDraft>) => set("items", v.items.map((it, i) => (i === index ? { ...it, ...patch } : it)));

  const items = itemsPayload(v.items, v.mode);
  const tags = parseTags(v.tags);
  const customerNos = parseCustomerNos(v.customerNos);
  const packagePrice = v.mode === "package" ? parseAmount(v.packagePrice) : null;
  const windowOk = /^\d{4}-\d{2}-\d{2}$/.test(v.validFrom) && (v.validTo === "" || v.validTo >= v.validFrom);
  const valid =
    v.code.trim().length >= 2 && v.nameEn.trim().length >= 2 && items !== null && tags !== null && customerNos !== null && windowOk && (v.mode === "per_line" || packagePrice !== null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!valid || !items || !tags || !customerNos) return;
    setPending(true);
    const res = await saveOffer({
      offer_id: v.offerId,
      code: v.code.trim(),
      name_en: v.nameEn.trim(),
      name_ar: v.nameAr.trim() || null,
      description: v.description.trim() || null,
      pricing_mode: v.mode,
      package_price: packagePrice,
      valid_from: v.validFrom,
      valid_to: v.validTo || null,
      items,
      customer_nos: customerNos,
      target_tags: tags,
      expected_version: v.version,
    }).catch(() => ({ ok: false as const, errorCode: "UNAVAILABLE" as const, requestId: undefined, detail: undefined }));
    setPending(false);
    if (res.ok) {
      setResult({ ok: true });
      if (res.version) setV((s) => ({ ...s, version: res.version ?? s.version }));
      router.push(`/offers/${v.offerId}?saved=1`);
      router.refresh();
      return;
    }
    setResult({ ok: false, code: res.errorCode, requestId: res.requestId, detail: res.detail });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6" noValidate aria-label={initial.version ? t("editTitle") : t("newTitle")}>
      <Card className="grid gap-4 sm:grid-cols-2">
        <Field id={`${ids}-code`} label={t("code")} hint={t("codeHint")}>
          <Input id={`${ids}-code`} value={v.code} onChange={(e) => set("code", e.target.value)} dir="ltr" maxLength={40} required className="uppercase" autoComplete="off" />
        </Field>
        <Field id={`${ids}-mode`} label={t("mode")}>
          <Select id={`${ids}-mode`} value={v.mode} onChange={(e) => set("mode", e.target.value === "per_line" ? "per_line" : "package")} className="w-full">
            <option value="package">{t("modePackage")}</option>
            <option value="per_line">{t("modePerLine")}</option>
          </Select>
        </Field>
        <Field id={`${ids}-en`} label={t("nameEn")}>
          <Input id={`${ids}-en`} value={v.nameEn} onChange={(e) => set("nameEn", e.target.value)} dir="ltr" maxLength={160} required />
        </Field>
        <Field id={`${ids}-ar`} label={t("nameAr")}>
          <Input id={`${ids}-ar`} value={v.nameAr} onChange={(e) => set("nameAr", e.target.value)} dir="rtl" maxLength={160} />
        </Field>
        {v.mode === "package" ? (
          <Field id={`${ids}-pp`} label={t("packagePrice")} hint={t("packagePriceHint")}>
            <Input
              id={`${ids}-pp`}
              value={v.packagePrice}
              onChange={(e) => set("packagePrice", e.target.value.slice(0, 20))}
              inputMode="decimal"
              dir="ltr"
              aria-invalid={(v.packagePrice !== "" && parseAmount(v.packagePrice) === null) || undefined}
            />
          </Field>
        ) : (
          <p className="text-xs text-muted-foreground sm:col-span-2">{t("perLineHint")}</p>
        )}
        <Field id={`${ids}-from`} label={t("validFrom")}>
          <Input id={`${ids}-from`} type="date" value={v.validFrom} onChange={(e) => set("validFrom", e.target.value)} required />
        </Field>
        <Field id={`${ids}-to`} label={t("validTo")} hint={t("validToHint")}>
          <Input id={`${ids}-to`} type="date" value={v.validTo} onChange={(e) => set("validTo", e.target.value)} aria-invalid={!windowOk || undefined} />
        </Field>
        <Field id={`${ids}-desc`} label={t("description")} className="sm:col-span-2">
          <Input id={`${ids}-desc`} value={v.description} onChange={(e) => set("description", e.target.value)} maxLength={2000} />
        </Field>
      </Card>

      <Card className="space-y-3">
        <CardTitle>{t("itemsTitle")}</CardTitle>
        <p className="text-xs text-muted-foreground">{t("itemsHint")}</p>
        {v.items.length === 0 ? <p className="text-sm text-muted-foreground">{t("noItems")}</p> : null}
        <ul className="divide-y">
          {v.items.map((it, i) => (
            <li key={`${it.variant_id}:${it.is_bonus}:${i}`} className="flex flex-wrap items-end gap-3 py-3">
              <div className="min-w-0 flex-1 basis-48">
                <p className="font-medium break-words">{it.name}</p>
                <p dir="ltr" className="text-xs text-muted-foreground text-start">
                  {it.sku}
                </p>
                {it.is_bonus ? <Badge tone="success">{t("bonus")}</Badge> : null}
              </div>
              <div className="w-24 space-y-1">
                <Label htmlFor={`${ids}-q-${i}`}>{t("quantity")}</Label>
                <Input id={`${ids}-q-${i}`} type="number" inputMode="numeric" min={1} step={1} value={it.quantity} onChange={(e) => setItem(i, { quantity: e.target.value })} />
              </div>
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input type="checkbox" checked={it.is_bonus} onChange={(e) => setItem(i, { is_bonus: e.target.checked, net_unit_price: "" })} className="size-5" />
                {t("isBonus")}
              </label>
              {v.mode === "per_line" && !it.is_bonus ? (
                <div className="w-32 space-y-1">
                  <Label htmlFor={`${ids}-n-${i}`}>{t("netUnitPrice")}</Label>
                  <Input
                    id={`${ids}-n-${i}`}
                    value={it.net_unit_price}
                    onChange={(e) => setItem(i, { net_unit_price: e.target.value.slice(0, 20) })}
                    inputMode="decimal"
                    dir="ltr"
                    aria-invalid={(it.net_unit_price !== "" && parseAmount(it.net_unit_price) === null) || undefined}
                  />
                </div>
              ) : null}
              <Button type="button" variant="ghost" onClick={() => set("items", v.items.filter((_, j) => j !== i))} aria-label={t("removeItem", { name: it.name })}>
                {t("remove")}
              </Button>
            </li>
          ))}
        </ul>
        <VariantPicker
          locale={locale}
          onAdd={(variant) =>
            set("items", [...v.items, { variant_id: variant.variant_id, sku: variant.sku, name: variant.variant_name, quantity: "1", is_bonus: false, net_unit_price: "" }])
          }
          disabled={v.items.length >= 50}
        />
        {v.items.length > 0 && items === null ? <p className="text-sm text-destructive">{t("itemsInvalid")}</p> : null}
      </Card>

      <Card className="grid gap-4 sm:grid-cols-2">
        <CardTitle className="sm:col-span-2">{t("targetTitle")}</CardTitle>
        <p className="text-xs text-muted-foreground sm:col-span-2">{t("targetHint")}</p>
        <Field id={`${ids}-cust`} label={t("customerNos")} hint={t("customerNosHint")}>
          <Input id={`${ids}-cust`} value={v.customerNos} onChange={(e) => set("customerNos", e.target.value)} dir="ltr" autoComplete="off" />
        </Field>
        <Field id={`${ids}-tags`} label={t("tags")} hint={t("tagsHint")}>
          <Input id={`${ids}-tags`} value={v.tags} onChange={(e) => set("tags", e.target.value)} dir="ltr" autoComplete="off" />
        </Field>
      </Card>

      {result && !result.ok && result.code ? <OfferError code={result.code} requestId={result.requestId} detail={result.detail} /> : null}
      {result?.ok ? (
        <Alert tone="success" role="status">
          {t("saved")}
        </Alert>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" size="lg" disabled={!valid || pending}>
          {pending ? t("saving") : t("save")}
        </Button>
      </div>
    </form>
  );
}

function Field({ id, label, hint, className, children }: { id: string; label: string; hint?: string; className?: string; children: ReactNode }) {
  return (
    <div className={`space-y-1 ${className ?? ""}`}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** Find a sellable variant by SKU or name and add it as an offer item. */
function VariantPicker({ locale, onAdd, disabled }: { locale: string; onAdd: (v: SellableVariant) => void; disabled: boolean }) {
  const t = useTranslations("orders.offerAdmin");
  const id = useId();
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState<{ q: string; items: SellableVariant[] | null } | null>(null);
  const q = sanitizeSearch(query);
  const active = q.length >= 2;
  const current = active && answer?.q === q ? answer : null;

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const res = await searchVariants(q).catch(() => null);
      if (!cancelled) setAnswer({ q, items: res && res.ok ? res.items : null });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active, q]);

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{t("addItem")}</Label>
      <Input id={id} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("addItemPlaceholder")} autoComplete="off" />
      <div aria-live="polite">
        {active && current === null ? <p className="text-sm text-muted-foreground">{t("searching")}</p> : null}
        {current && current.items === null ? <p className="text-sm text-destructive">{t("searchFailed")}</p> : null}
        {current?.items && current.items.length === 0 ? <p className="text-sm text-muted-foreground">{t("noResults")}</p> : null}
        {current?.items && current.items.length > 0 ? (
          <ul className="divide-y">
            {current.items.map((variant) => (
              <li key={variant.variant_id} className="flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="font-medium break-words">{variant.variant_name}</p>
                  <p className="text-xs text-muted-foreground break-words">
                    {localizedName(locale, variant.product_name_en, variant.product_name_ar)} · <span dir="ltr">{variant.sku}</span>
                  </p>
                </div>
                <Button type="button" variant="outline" disabled={disabled} onClick={() => onAdd(variant)}>
                  {t("add")}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
