"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { GiftIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { Badge, Input, Label } from "@/components/ui/primitives";
import { loadEligibleOffers } from "../actions";
import { localizedName, MAX_QUANTITY, toNumber, type OrderErrorCode } from "../logic";
import type { BuilderOffer, OfferOption } from "../types";
import { Section } from "./builder-section";
import { OrderError } from "./order-error";

/**
 * Offers and packages the owner defined (decision B: picking one needs no
 * approval). The list comes from api.eligible_offers for the chosen customer, so
 * validity window and targeting are the server's; the server checks them again
 * on every save and at submit. Offline, offers already on the draft stay; new
 * ones can be added once online.
 */
export function OfferPicker({
  customerId,
  online,
  locale,
  offers,
  onChange,
}: {
  customerId: string;
  online: boolean;
  locale: string;
  offers: readonly BuilderOffer[];
  onChange: (next: BuilderOffer[]) => void;
}) {
  const t = useTranslations("orders.offers");
  const format = useFormatter();
  const ids = useId();
  // The server's answer for one customer; whatever else is shown is derived from it.
  const [answer, setAnswer] = useState<{ customerId: string; options: OfferOption[] | null; error: { code: OrderErrorCode; requestId?: string } | null } | null>(
    null,
  );

  useEffect(() => {
    if (!customerId || !online) return;
    let alive = true;
    loadEligibleOffers(customerId)
      .catch(() => ({ ok: false as const, errorCode: "UNAVAILABLE" as const, requestId: undefined }))
      .then((res) => {
        if (!alive) return;
        setAnswer(res.ok ? { customerId, options: res.offers, error: null } : { customerId, options: null, error: { code: res.errorCode, requestId: res.requestId } });
      });
    return () => {
      alive = false;
    };
  }, [customerId, online]);

  const current = answer?.customerId === customerId ? answer : null;
  const loading = Boolean(customerId) && online && current === null;
  const options = current?.options ?? [];
  const optionOf = (id: string) => options.find((o) => o.offer_id === id);
  const money = (v: number | string | null | undefined) => format.number(toNumber(v), "egp");

  const add = (o: OfferOption) => {
    if (offers.some((x) => x.offer_id === o.offer_id)) return;
    onChange([...offers, { offer_id: o.offer_id, packages: 1, code: o.code, name: localizedName(locale, o.name_en, o.name_ar) }]);
  };
  const setPackages = (id: string, raw: string) => {
    const n = raw === "" ? 0 : Math.trunc(Number(raw));
    onChange(offers.map((o) => (o.offer_id === id ? { ...o, packages: Number.isFinite(n) ? n : 0 } : o)));
  };

  return (
    <Section step={2} title={t("title")}>
      <p className="text-xs text-muted-foreground">{t("intro")}</p>

      {offers.length > 0 ? (
        <ul className="space-y-2" aria-label={t("chosen")}>
          {offers.map((o) => {
            const option = optionOf(o.offer_id);
            const invalid = !(Number.isInteger(o.packages) && o.packages >= 1 && o.packages <= MAX_QUANTITY);
            const qtyId = `${ids}-pk-${o.offer_id}`;
            return (
              <li key={o.offer_id} className="space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-3">
                <div className="flex flex-wrap items-end gap-3">
                  <div className="min-w-0 flex-1 basis-48">
                    <p className="flex items-center gap-1.5 font-medium break-words">
                      <GiftIcon aria-hidden="true" className="size-4 shrink-0 text-primary" />
                      {option ? localizedName(locale, option.name_en, option.name_ar) : o.name || o.code}
                    </p>
                    <p dir="ltr" className="text-xs text-muted-foreground text-start">
                      {o.code}
                    </p>
                  </div>
                  <div className="w-28 space-y-1">
                    <Label htmlFor={qtyId}>{t("packages")}</Label>
                    <Input
                      id={qtyId}
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={MAX_QUANTITY}
                      step={1}
                      value={o.packages === 0 ? "" : o.packages}
                      onChange={(e) => setPackages(o.offer_id, e.target.value)}
                      aria-invalid={invalid || undefined}
                      className="text-center tabular-nums"
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => onChange(offers.filter((x) => x.offer_id !== o.offer_id))}
                    aria-label={t("removeOffer", { code: o.code })}
                    title={t("remove")}
                  >
                    <Trash2Icon aria-hidden="true" />
                  </Button>
                </div>
                {option ? <OfferItems option={option} packages={Math.max(o.packages, 1)} money={money} /> : <p className="text-xs text-muted-foreground">{t("itemsOnServer")}</p>}
              </li>
            );
          })}
        </ul>
      ) : null}

      {!customerId ? (
        <p className="text-sm text-muted-foreground">{t("chooseCustomer")}</p>
      ) : !online ? (
        <p className="text-sm text-muted-foreground">{t("offline")}</p>
      ) : loading ? (
        <p className="text-sm text-muted-foreground">{t("loading")}</p>
      ) : current?.error ? (
        <OrderError code={current.error.code} requestId={current.error.requestId} />
      ) : options.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("none")}</p>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2" aria-label={t("available")}>
          {options
            .filter((o) => !offers.some((x) => x.offer_id === o.offer_id))
            .map((o) => (
              <li key={o.offer_id} className="flex items-center gap-3 rounded-lg border bg-card p-3">
                <div className="min-w-0 flex-1 basis-48">
                  <p className="font-medium break-words">{localizedName(locale, o.name_en, o.name_ar)}</p>
                  <p className="text-xs text-muted-foreground break-words">
                    <span dir="ltr">{o.code}</span>
                    {" · "}
                    {o.pricing_mode === "package" ? t("packagePrice", { price: money(o.package_price) }) : t("perLine")}
                    {o.valid_to ? <> · {t("until", { date: o.valid_to })}</> : null}
                  </p>
                </div>
                <Button type="button" variant="outline" onClick={() => add(o)} aria-label={t("addOffer", { code: o.code })}>
                  <PlusIcon aria-hidden="true" />
                  {t("add")}
                </Button>
              </li>
            ))}
        </ul>
      )}
    </Section>
  );
}

function OfferItems({ option, packages, money }: { option: OfferOption; packages: number; money: (v: number | string | null | undefined) => string }) {
  const t = useTranslations("orders.offers");
  return (
    <ul className="space-y-1 rounded-md bg-card/70 p-2 text-xs">
      {option.items.map((i) => (
        <li key={i.line_no} className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{i.quantity * packages} ×</span>
          <span className="min-w-0 flex-1 break-words">
            {i.variant_name} <span dir="ltr" className="text-muted-foreground">{i.sku}</span>
          </span>
          {i.is_bonus ? <Badge tone="success">{t("bonus")}</Badge> : i.net_unit_price != null ? <span>{t("netEach", { price: money(i.net_unit_price) })}</span> : null}
        </li>
      ))}
      {option.pricing_mode === "package" ? <li className="font-medium">{t("packageTotal", { price: money(toNumber(option.package_price) * packages) })}</li> : null}
    </ul>
  );
}
